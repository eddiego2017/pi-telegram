/**
 * Workspace stream state lifecycle: delivery targets, retries, markdown flush
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import {
  runWithTelegramThreadContext,
} from "./thread-context.ts";
import {
  removeTelegramWorkspacePostRunMessage,
} from "./workspace-manager-events.ts";
import {
  getErrorMessage,
} from "./workspace-manager-state.ts";
import type {
  TelegramWorkspaceManagerDeps,
  TelegramWorkspaceStreamDeliveryResult,
  TelegramWorkspaceStreamState,
  WorkspaceRuntime,
} from "./workspace-manager-types.ts";

export function installStream<TContext>(
  self: WsRuntimeContext<TContext>,
  deps: TelegramWorkspaceManagerDeps<TContext>,
): void {
  self.createStreamState = (): TelegramWorkspaceStreamState => ({
    markdown: "",
    sentMarkdown: "",
    lastFlushAt: 0,
  });
  self.getStreamState = (
    streams: Map<number, TelegramWorkspaceStreamState>,
    index: number,
  ): TelegramWorkspaceStreamState => {
    let stream = streams.get(index);
    if (!stream) {
      stream = self.createStreamState();
      streams.set(index, stream);
    }
    return stream;
  };
  self.getTextStreamState = (runtime: WorkspaceRuntime): TelegramWorkspaceStreamState => {
    runtime.textStream ??= self.createStreamState();
    return runtime.textStream;
  };
  self.getToolCallStatusStreamState = (
    runtime: WorkspaceRuntime,
  ): TelegramWorkspaceStreamState => {
    runtime.toolCallStatusStream ??= self.createStreamState();
    return runtime.toolCallStatusStream;
  };
  self.getStreamFailureRetryMs = (failureCount: number): number =>
    Math.min(
      self.streamFailureMaxRetryMs,
      self.streamFailureBaseRetryMs *
        2 ** Math.min(Math.max(0, failureCount - 1), 6),
    );
  self.isWorkspaceStreamStale = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): boolean =>
    stream.turnId !== undefined && runtime.activeTurnId !== stream.turnId;
  self.getWorkspaceStreamDeliveryTarget = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): {
    chatId?: number;
    messageThreadId?: number;
    replyToMessageId?: number;
  } => {
    if (stream.chatId !== undefined) {
      return {
        chatId: stream.chatId,
        messageThreadId: stream.messageThreadId,
        replyToMessageId: stream.replyToMessageId,
      };
    }
    return {
      chatId: runtime.activeChatId,
      messageThreadId: runtime.activeMessageThreadId,
      replyToMessageId: runtime.activeReplyToMessageId,
    };
  };
  self.bindWorkspaceStreamDeliveryTarget = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): void => {
    if (stream.turnId !== undefined) return;
    stream.turnId = runtime.activeTurnId;
    stream.chatId = runtime.activeChatId;
    stream.messageThreadId = runtime.activeMessageThreadId;
    stream.replyToMessageId = runtime.activeReplyToMessageId;
  };
  self.schedulePendingWorkspaceStreamRetry = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): void => {
    if (self.isWorkspaceStreamStale(runtime, stream)) return;
    const nextFlushAt = Math.max(
      stream.nextFlushAt ?? 0,
      runtime.streamDeliveryBlockedUntil ?? 0,
    );
    if (nextFlushAt <= 0 || stream.flushTimer) return;
    if (stream.markdown === stream.sentMarkdown) return;
    const wait = Math.max(0, nextFlushAt - self.now());
    stream.flushTimer = setTimeout(() => {
      stream.flushTimer = undefined;
      void self.flushWorkspaceStreamMarkdown(runtime, stream);
    }, wait);
  };
  self.blockWorkspaceStreamDelivery = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): void => {
    if (self.isWorkspaceStreamStale(runtime, stream)) return;
    const failedFlushCount =
      Math.max(
        stream.failedFlushCount ?? 0,
        runtime.streamDeliveryFailureCount ?? 0,
      ) + 1;
    const retryAt = self.now() + self.getStreamFailureRetryMs(failedFlushCount);
    stream.failedFlushCount = failedFlushCount;
    stream.lastFlushAt = self.now();
    stream.nextFlushAt = retryAt;
    runtime.streamDeliveryFailureCount = failedFlushCount;
    runtime.streamDeliveryBlockedUntil = retryAt;
  };
  self.unblockWorkspaceStreamDelivery = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): void => {
    stream.failedFlushCount = undefined;
    stream.nextFlushAt = undefined;
    if (self.isWorkspaceStreamStale(runtime, stream)) return;
    runtime.streamDeliveryFailureCount = undefined;
    runtime.streamDeliveryBlockedUntil = undefined;
  };
  self.getWorkspaceStreamDeliveryBlockedUntil = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): number | undefined => {
    const nextFlushAt = Math.max(
      stream.nextFlushAt ?? 0,
      runtime.streamDeliveryBlockedUntil ?? 0,
    );
    return nextFlushAt > 0 ? nextFlushAt : undefined;
  };
  self.scheduleAllPendingWorkspaceStreamRetries = (
    runtime: WorkspaceRuntime,
    except?: TelegramWorkspaceStreamState,
  ): void => {
    const streams = [
      runtime.textStream,
      ...runtime.thinkingStreams.values(),
      ...runtime.toolCallStreams.values(),
      runtime.toolCallStatusStream,
    ];
    for (const stream of streams) {
      if (!stream || stream === except) continue;
      if (stream.markdown === stream.sentMarkdown) continue;
      self.schedulePendingWorkspaceStreamRetry(runtime, stream);
    }
  };
  self.flushWorkspaceStreamMarkdown = async (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
    options: {
      force?: boolean;
      allowStaleDelivery?: boolean;
      retryOnFailure?: boolean;
    } = {},
  ): Promise<TelegramWorkspaceStreamDeliveryResult> => {
    if (options.retryOnFailure === false) {
      stream.suppressRetryOnFailure = true;
    }
    const shouldRetryOnFailure = (): boolean =>
      options.retryOnFailure !== false && stream.suppressRetryOnFailure !== true;
    const makeSkipped = (reason: string): TelegramWorkspaceStreamDeliveryResult => ({
      status: "skipped",
      reason,
      stale: self.isWorkspaceStreamStale(runtime, stream),
    });
    if (!stream.markdown) return makeSkipped("empty");
    if (stream.markdown === stream.sentMarkdown) return makeSkipped("unchanged");
    if (self.isWorkspaceStreamStale(runtime, stream) && !options.allowStaleDelivery) {
      return makeSkipped("stale-turn");
    }
    const blockedUntil = self.getWorkspaceStreamDeliveryBlockedUntil(runtime, stream);
    if (!options.force && blockedUntil !== undefined && self.now() < blockedUntil) {
      self.schedulePendingWorkspaceStreamRetry(runtime, stream);
      return {
        status: "scheduled",
        reason: "blocked",
        retryAt: blockedUntil,
        stale: self.isWorkspaceStreamStale(runtime, stream),
      };
    }
    if (stream.flushPromise) {
      stream.flushRequested = true;
      return stream.flushPromise;
    }
    stream.flushPromise = (async () => {
      let lastResult: TelegramWorkspaceStreamDeliveryResult = makeSkipped("empty");
      do {
        stream.flushRequested = false;
        const markdown = stream.markdown;
        if (!markdown) return makeSkipped("empty");
        if (markdown === stream.sentMarkdown) return makeSkipped("unchanged");
        if (self.isWorkspaceStreamStale(runtime, stream) && !options.allowStaleDelivery) {
          return makeSkipped("stale-turn");
        }
        const target = self.getWorkspaceStreamDeliveryTarget(runtime, stream);
        if (target.chatId === undefined) {
          return makeSkipped("missing-chat");
        }
        let delivered = false;
        let deliveredMessageId = stream.messageId;
        try {
          const currentMessageId = stream.messageId;
          if (currentMessageId === undefined) {
            const messageId = await runWithTelegramThreadContext(
              {
                chatId: target.chatId,
                messageThreadId: target.messageThreadId,
              },
              () =>
                self.sendWorkspaceStreamMarkdownReply(
                  target.chatId,
                  target.replyToMessageId,
                  markdown,
                ),
            );
            if (messageId !== undefined) {
              deliveredMessageId = messageId;
              delivered = true;
            }
          } else if (deps.editStreamMarkdownMessage) {
            const messageId = await runWithTelegramThreadContext(
              {
                chatId: target.chatId,
                messageThreadId: target.messageThreadId,
              },
              () =>
                self.editWorkspaceStreamMarkdownMessage(
                  target.chatId,
                  currentMessageId,
                  markdown,
                ),
            );
            deliveredMessageId = messageId ?? currentMessageId;
            delivered = true;
          }
        } catch (error) {
          deps.recordRuntimeEvent?.("workspaces", error, {
            workspace: runtime.record.name,
            action: "stream_markdown",
            turnId: stream.turnId,
            chatId: target.chatId,
            messageThreadId: target.messageThreadId,
            replyToMessageId: target.replyToMessageId,
            streamMessageId: stream.messageId,
          });
          lastResult = {
            status: "failed",
            error: getErrorMessage(error),
            stale: self.isWorkspaceStreamStale(runtime, stream),
          };
        }
        if (!delivered) {
          if (lastResult.status !== "failed") {
            lastResult = {
              status: "failed",
              stale: self.isWorkspaceStreamStale(runtime, stream),
            };
          }
          if (shouldRetryOnFailure()) {
            self.blockWorkspaceStreamDelivery(runtime, stream);
            self.scheduleAllPendingWorkspaceStreamRetries(runtime, stream);
          }
          return lastResult;
        }
        const staleAfterDelivery = self.isWorkspaceStreamStale(runtime, stream);
        if (!staleAfterDelivery) {
          if (deliveredMessageId !== undefined) stream.messageId = deliveredMessageId;
          self.unblockWorkspaceStreamDelivery(runtime, stream);
          stream.sentMarkdown = markdown;
          removeTelegramWorkspacePostRunMessage(runtime, markdown);
          stream.lastFlushAt = self.now();
          runtime.lastStreamFlushAt = stream.lastFlushAt;
        }
        lastResult = {
          status: "delivered",
          sentMarkdown: markdown,
          messageId: deliveredMessageId,
          stale: staleAfterDelivery,
        };
      } while (stream.flushRequested);
      return lastResult;
    })();
    try {
      return await stream.flushPromise;
    } finally {
      stream.flushPromise = undefined;
      if (
        shouldRetryOnFailure() &&
        !self.isWorkspaceStreamStale(runtime, stream) &&
        stream.markdown !== stream.sentMarkdown
      ) {
        self.schedulePendingWorkspaceStreamRetry(runtime, stream);
      }
    }
  };
  self.scheduleWorkspaceStreamMarkdownFlush = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
    force: boolean,
  ): void => {
    if (stream.flushTimer) {
      if (!force) return;
      clearTimeout(stream.flushTimer);
      stream.flushTimer = undefined;
    }
    const blockedUntil = self.getWorkspaceStreamDeliveryBlockedUntil(runtime, stream);
    const retryWait =
      !force && blockedUntil !== undefined ? Math.max(0, blockedUntil - self.now()) : 0;
    const globalThrottleWait = Math.max(
      0,
      self.streamEditThrottleMs - (self.now() - (runtime.lastStreamFlushAt ?? 0)),
    );
    const wait =
      retryWait > 0
        ? retryWait
        : force
          ? 0
          : Math.max(
              globalThrottleWait,
              self.streamEditThrottleMs - (self.now() - stream.lastFlushAt),
            );
    if (wait === 0) {
      void self.flushWorkspaceStreamMarkdown(runtime, stream, { force });
      return;
    }
    stream.flushTimer = setTimeout(() => {
      stream.flushTimer = undefined;
      void self.flushWorkspaceStreamMarkdown(runtime, stream);
    }, wait);
  };
}
