/**
 * Active-workspace streaming: markdown/text/thinking/tool-call previews and finalize
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import {
  formatAgentToolCallBlock,
  getAgentMessageBodyText,
  getAgentMessagePreviewText,
  summarizeAgentToolCall,
} from "./replies.ts";
import {
  truncateTelegramWorkspaceStreamMarkdown,
} from "./workspace-manager-constants.ts";
import {
  agentMessageHasToolCall,
  formatTelegramWorkspaceCompactToolStatusMarkdown,
  formatTelegramWorkspaceThinkingMarkdown,
  getAgentMessageContent,
  getRecord,
  pushTelegramWorkspacePostRunMessage,
  removeTelegramWorkspacePostRunMessage,
} from "./workspace-manager-events.ts";
import type {
  TelegramWorkspaceManagerDeps,
  TelegramWorkspaceStreamDeliveryResult,
  TelegramWorkspaceStreamState,
  TelegramWorkspaceToolStatusKind,
  WorkspaceRuntime,
} from "./workspace-manager-types.ts";
import type {
  TelegramWorkspacesState,
} from "./workspaces.ts";

export function installStreamActive<TContext>(
  self: WsRuntimeContext<TContext>,
  deps: TelegramWorkspaceManagerDeps<TContext>,
): void {
  self.streamActiveWorkspaceMarkdown = (
    workspaceState: TelegramWorkspacesState,
    workspaceName: string,
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
    markdown: string,
    force = false,
    truncate = true,
  ): void => {
    if (!self.isRuntimeDeliveryActive(workspaceState, workspaceName, runtime)) return;
    self.bindWorkspaceStreamDeliveryTarget(runtime, stream);
    if (self.isWorkspaceStreamStale(runtime, stream) && !force) return;
    stream.markdown = truncate
      ? truncateTelegramWorkspaceStreamMarkdown(markdown)
      : markdown.trim();
    self.scheduleWorkspaceStreamMarkdownFlush(runtime, stream, force);
  };
  self.streamActiveWorkspaceText = (
    workspaceState: TelegramWorkspacesState,
    workspaceName: string,
    runtime: WorkspaceRuntime,
    text: string,
    force = false,
  ): boolean => {
    const trimmed = text.trim();
    if (!trimmed || !self.isRuntimeDeliveryActive(workspaceState, workspaceName, runtime)) return false;
    self.streamActiveWorkspaceMarkdown(
      workspaceState,
      workspaceName,
      runtime,
      self.getTextStreamState(runtime),
      trimmed,
      force,
      !force,
    );
    return true;
  };
  self.streamActiveWorkspaceThinking = (
    workspaceState: TelegramWorkspacesState,
    workspaceName: string,
    runtime: WorkspaceRuntime,
    index: number,
    text: string,
    force = false,
  ): void => {
    const trimmed = text.trim();
    if (!trimmed || runtime.sentThinkingTexts.has(trimmed)) return;
    const markdown = formatTelegramWorkspaceThinkingMarkdown(trimmed);
    if (!markdown) return;
    let stream: TelegramWorkspaceStreamState | undefined;
    if (self.thinkingStreamPreviewsEnabled) {
      stream = self.getStreamState(runtime.thinkingStreams, index);
      self.streamActiveWorkspaceMarkdown(
        workspaceState,
        workspaceName,
        runtime,
        stream,
        markdown,
        force,
      );
    }
    if (force) {
      runtime.sentThinkingTexts.add(trimmed);
      pushTelegramWorkspacePostRunMessage(runtime, "thinking", markdown, stream);
      runtime.thinkingStreams.delete(index);
    }
  };
  self.flushActiveWorkspaceThinkingBuffer = (
    workspaceState: TelegramWorkspacesState,
    workspaceName: string,
    runtime: WorkspaceRuntime,
    index: number,
  ): void => {
    const text = runtime.thinkingBuffers.get(index) ?? "";
    runtime.thinkingBuffers.delete(index);
    self.streamActiveWorkspaceThinking(workspaceState, workspaceName, runtime, index, text, true);
  };
  self.streamActiveWorkspaceToolCall = (
    workspaceState: TelegramWorkspacesState,
    workspaceName: string,
    runtime: WorkspaceRuntime,
    index: number,
    markdown: string,
    final: boolean,
  ): void => {
    if (!markdown || !self.toolCallStreamPreviewsEnabled) return;
    const stream = self.getStreamState(runtime.toolCallStreams, index);
    self.streamActiveWorkspaceMarkdown(workspaceState, workspaceName, runtime, stream, markdown, final);
    if (final) {
      runtime.sentToolCallMessages.add(markdown);
      pushTelegramWorkspacePostRunMessage(runtime, "tool", markdown, stream);
      runtime.toolCallStreams.delete(index);
    }
  };
  self.streamActiveWorkspaceCompactToolStatus = (
    workspaceState: TelegramWorkspacesState,
    workspaceName: string,
    runtime: WorkspaceRuntime,
    preview: {
      key: string;
      markdown: string;
      name?: string;
      summary?: string;
      status: TelegramWorkspaceToolStatusKind;
    },
  ): void => {
    if (!self.toolCallCompactPreviewsEnabled) return;
    if (!preview.markdown && !runtime.toolCallStatuses.has(preview.key)) return;
    const current = runtime.toolCallStatuses.get(preview.key);
    const incoming = preview.markdown.trim();
    const keptMarkdown = current?.markdown ?? "";
    // Execution events often arrive without args (info-poor, single line);
    // don't let them overwrite a richer markdown/summary captured at toolcall_end.
    const incomingIsRicher = incoming.includes("\n") || !keptMarkdown;
    runtime.toolCallStatuses.set(preview.key, {
      key: preview.key,
      markdown: incomingIsRicher ? incoming : keptMarkdown || "\u{1F527} `tool`",
      name: preview.name ?? current?.name,
      summary: preview.summary ?? current?.summary,
      status: preview.status,
      updatedAt: self.now(),
    });
    const entries = [...runtime.toolCallStatuses.values()].sort(
      (left, right) => left.updatedAt - right.updatedAt,
    );
    const markdown = formatTelegramWorkspaceCompactToolStatusMarkdown(
      entries,
      runtime.toolCallStatuses.size,
    );
    self.streamActiveWorkspaceMarkdown(
      workspaceState,
      workspaceName,
      runtime,
      self.getToolCallStatusStreamState(runtime),
      markdown,
    );
  };
  self.getWorkspaceTurnDetails = (workspaceName: string, runtime: WorkspaceRuntime): Record<string, unknown> => ({
    workspace: workspaceName,
    turnId: runtime.activeTurnId,
    chatId: runtime.activeChatId,
    messageThreadId: runtime.activeMessageThreadId,
    replyToMessageId: runtime.activeReplyToMessageId,
  });
  self.isFinalWorkspaceStreamDeliveryConfirmed = (
    result: TelegramWorkspaceStreamDeliveryResult,
    expectedMarkdown: string,
    latestSentMarkdown?: string,
  ): boolean => {
    if (result.status === "delivered") return result.sentMarkdown === expectedMarkdown;
    return (
      result.status === "skipped" &&
      result.reason === "unchanged" &&
      latestSentMarkdown === expectedMarkdown
    );
  };
  self.finalizeActiveWorkspaceTextStream = async (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState | undefined,
    finalMarkdown: string,
  ): Promise<TelegramWorkspaceStreamDeliveryResult> => {
    const trimmed = finalMarkdown.trim();
    if (!stream) {
      return {
        status: "skipped",
        reason: "missing-stream",
        stale: false,
      };
    }
    if (!trimmed) {
      return {
        status: "skipped",
        reason: "empty-final",
        stale: self.isWorkspaceStreamStale(runtime, stream),
      };
    }
    self.bindWorkspaceStreamDeliveryTarget(runtime, stream);
    stream.markdown = trimmed;
    if (stream.flushTimer) {
      clearTimeout(stream.flushTimer);
      stream.flushTimer = undefined;
    }
    return self.flushWorkspaceStreamMarkdown(runtime, stream, {
      force: true,
      allowStaleDelivery: true,
      retryOnFailure: false,
    });
  };
  self.deleteWorkspaceStreamPreviewMessage = async (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState | undefined,
    deletedMessageIds?: Set<number>,
  ): Promise<void> => {
    if (!stream || stream.messageId === undefined || !deps.deleteMessage) return;
    if (deletedMessageIds?.has(stream.messageId)) return;
    const target = self.getWorkspaceStreamDeliveryTarget(runtime, stream);
    if (target.chatId === undefined) return;
    try {
      await deps.deleteMessage(target.chatId, stream.messageId);
      deletedMessageIds?.add(stream.messageId);
    } catch (error) {
      deps.recordRuntimeEvent?.("workspaces", error, {
        workspace: runtime.record.name,
        action: "stream_preview_delete",
        turnId: stream.turnId,
        chatId: target.chatId,
        messageThreadId: target.messageThreadId,
        streamMessageId: stream.messageId,
      });
    }
  };
  self.deleteRuntimePostRunPreviewMessages = async (
    runtime: WorkspaceRuntime,
    textStream: TelegramWorkspaceStreamState | undefined,
  ): Promise<void> => {
    const deletedMessageIds = new Set<number>();
    await self.deleteWorkspaceStreamPreviewMessage(runtime, textStream, deletedMessageIds);
    for (const message of runtime.postRunMessages) {
      await self.deleteWorkspaceStreamPreviewMessage(runtime, message.stream, deletedMessageIds);
    }
    if (runtime.postRunMessages.some((message) => message.kind === "tool")) {
      await self.deleteWorkspaceStreamPreviewMessage(
        runtime,
        runtime.toolCallStatusStream,
        deletedMessageIds,
      );
    }
  };
  self.markActiveWorkspaceTextStreamAborted = async (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState | undefined = runtime.textStream,
  ): Promise<TelegramWorkspaceStreamDeliveryResult | undefined> => {
    if (!stream) return undefined;
    const current = (stream.sentMarkdown || stream.markdown).trim();
    if (!current) return undefined;
    const abortedMarkdown = current.includes("[aborted]")
      ? current
      : `${current}\n\n[aborted]`;
    self.bindWorkspaceStreamDeliveryTarget(runtime, stream);
    stream.markdown = abortedMarkdown;
    if (stream.flushTimer) {
      clearTimeout(stream.flushTimer);
      stream.flushTimer = undefined;
    }
    return self.flushWorkspaceStreamMarkdown(runtime, stream, {
      force: true,
      allowStaleDelivery: true,
      retryOnFailure: false,
    });
  };
  self.logWorkspaceFirstOutput = (
    workspaceName: string,
    runtime: WorkspaceRuntime,
    outputKind: string,
  ): void => {
    if (runtime.firstOutputLogged) return;
    const firstOutputAt = self.now();
    runtime.firstOutputAt = firstOutputAt;
    runtime.firstOutputLogged = true;
    deps.debugLogger?.log("telegram.workspace.first_output", {
      ...self.getWorkspaceTurnDetails(workspaceName, runtime),
      outputKind,
      promptSentToFirstOutputMs:
        runtime.promptSentAt === undefined ? undefined : firstOutputAt - runtime.promptSentAt,
      agentStartToFirstOutputMs:
        runtime.agentStartedAt === undefined ? undefined : firstOutputAt - runtime.agentStartedAt,
    });
  };
  self.logWorkspaceTurnSummary = (
    workspaceName: string,
    runtime: WorkspaceRuntime,
    stopReason?: string,
    error?: string,
  ): void => {
    const endedAt = self.now();
    deps.debugLogger?.log("telegram.workspace.turn.summary", {
      ...self.getWorkspaceTurnDetails(workspaceName, runtime),
      stopReason,
      error,
      totalMs:
        runtime.promptStartedAt === undefined ? undefined : endedAt - runtime.promptStartedAt,
      promptStartToSentMs:
        runtime.promptStartedAt === undefined || runtime.promptSentAt === undefined
          ? undefined
          : runtime.promptSentAt - runtime.promptStartedAt,
      promptSentToAgentStartMs:
        runtime.promptSentAt === undefined || runtime.agentStartedAt === undefined
          ? undefined
          : runtime.agentStartedAt - runtime.promptSentAt,
      agentStartToFirstOutputMs:
        runtime.agentStartedAt === undefined || runtime.firstOutputAt === undefined
          ? undefined
          : runtime.firstOutputAt - runtime.agentStartedAt,
      firstOutputToAgentEndMs:
        runtime.firstOutputAt === undefined ? undefined : endedAt - runtime.firstOutputAt,
      agentStartToAgentEndMs:
        runtime.agentStartedAt === undefined ? undefined : endedAt - runtime.agentStartedAt,
    });
  };
  self.sendActiveWorkspaceToolCallMessage = (
    workspaceState: TelegramWorkspacesState,
    workspaceName: string,
    runtime: WorkspaceRuntime,
    message: unknown,
  ): boolean => {
    if (!agentMessageHasToolCall(message)) return false;
    if (self.toolCallCompactPreviewsEnabled) {
      getAgentMessageContent(message).forEach((block, index) => {
        const raw = getRecord(block);
        if (raw?.type !== "toolCall") return;
        const key =
          typeof raw.id === "string" && raw.id ? raw.id : `message-tool:${index}`;
        const markdown = formatAgentToolCallBlock({
          name: raw.name,
          arguments: raw.arguments,
        });
        const toolName = typeof raw.name === "string" && raw.name ? raw.name : undefined;
        const summary = toolName
          ? summarizeAgentToolCall(toolName, raw.arguments)
          : "";
        self.streamActiveWorkspaceCompactToolStatus(workspaceState, workspaceName, runtime, {
          key,
          markdown,
          ...(toolName ? { name: toolName } : {}),
          ...(summary ? { summary } : {}),
          status: "queued",
        });
        pushTelegramWorkspacePostRunMessage(runtime, "tool", markdown);
      });
      return getAgentMessageBodyText(message).length === 0;
    }
    if (!self.toolCallStreamPreviewsEnabled) return false;
    if (
      runtime.toolCallStreams.size > 0 ||
      runtime.sentToolCallMessages.size > 0
    ) {
      return true;
    }
    const markdown = getAgentMessagePreviewText(message);
    if (!markdown || runtime.sentToolCallMessages.has(markdown)) return true;
    pushTelegramWorkspacePostRunMessage(runtime, "tool", markdown);
    if (!self.isRuntimeDeliveryActive(workspaceState, workspaceName, runtime)) return false;
    runtime.sentToolCallMessages.add(markdown);
    void self.runInWorkspaceThreadContext(runtime, async () => {
      const messageId = await self.sendWorkspaceMarkdownReply(
        runtime.activeChatId,
        runtime.activeReplyToMessageId,
        markdown,
      );
      if (messageId !== undefined) {
        removeTelegramWorkspacePostRunMessage(runtime, markdown);
      }
    });
    return true;
  };
}
