/**
 * Child RPC event handling for workspace runtimes
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import {
  extractLatestAssistantMessageText,
  getAgentMessageBodyText,
  isAssistantAgentMessage,
} from "./replies.ts";
import {
  extractRpcTextDelta,
} from "./rpc-child.ts";
import type {
  RpcChildBackendEvent,
} from "./rpc-child.ts";
import {
  runWithTelegramThreadContext,
} from "./thread-context.ts";
import {
  clearRuntimePostRunPreviewStreams,
  extractAgentThinkingBlocks,
  extractRpcAssistantError,
  extractRpcAssistantText,
  getLatestAssistantMessage,
  getRpcAssistantThinkingDelta,
  getRpcAssistantThinkingEnd,
  getRpcAssistantToolCallPreview,
  getRpcToolExecutionPreview,
  isTelegramWorkspacePostRunTextMessage,
  resetRuntimeTurnBuffers,
} from "./workspace-manager-events.ts";
import {
  getErrorMessage,
} from "./workspace-manager-state.ts";
import type {
  TelegramWorkspaceManagerDeps,
  TelegramWorkspaceStreamDeliveryResult,
  WorkspaceRuntime,
} from "./workspace-manager-types.ts";

export function installChildEvent<TContext>(
  self: WsRuntimeContext<TContext>,
  deps: TelegramWorkspaceManagerDeps<TContext>,
): void {
  self.handleChildEvent = (
    workspaceName: string,
    runtime: WorkspaceRuntime,
    event: RpcChildBackendEvent,
  ): void => {
    const workspaceState = self.state;
    if (!workspaceState || runtime.closing || !workspaceState.workspaces[workspaceName]) return;
    const record = runtime.record;
    const eventNow = self.now();
    deps.debugLogger?.log(
      "telegram.workspace.worker.event",
      {
        ...self.getWorkspaceTurnDetails(workspaceName, runtime),
        type: event.type,
        status: record.status,
        bodyOmitted: event.type === "message_update" || event.type === "message_end" || event.type === "agent_end" ? true : undefined,
      },
      event.type === "message_update" || event.type === "message_end" || event.type === "agent_end" ? undefined : event,
    );
    if (event.type === "agent_start") {
      resetRuntimeTurnBuffers(runtime);
      runtime.agentStartedAt = eventNow;
      deps.debugLogger?.log("telegram.workspace.agent.start", self.getWorkspaceTurnDetails(workspaceName, runtime));
      record.status = "running";
      record.lastError = undefined;
      record.lastAgentStartAt = eventNow;
      if (self.isRuntimeDeliveryActive(workspaceState, workspaceName, runtime)) {
        self.startWorkspaceTyping(workspaceName, runtime);
      }
      void self.persist();
      return;
    }
    if (event.type === "message_start") {
      deps.debugLogger?.log("telegram.workspace.message.start", self.getWorkspaceTurnDetails(workspaceName, runtime));
      runtime.activeBuffer = "";
      runtime.textStream = undefined;
      return;
    }
    const delta = extractRpcTextDelta(event);
    if (delta) {
      self.logWorkspaceFirstOutput(workspaceName, runtime, "text_delta");
      runtime.activeBuffer += delta;
      self.streamActiveWorkspaceText(workspaceState, workspaceName, runtime, runtime.activeBuffer);
    }
    const thinkingDelta = getRpcAssistantThinkingDelta(event);
    if (thinkingDelta) {
      self.logWorkspaceFirstOutput(workspaceName, runtime, "thinking_delta");
      const nextThinkingText = `${runtime.thinkingBuffers.get(thinkingDelta.index) ?? ""}${
        thinkingDelta.delta
      }`;
      runtime.thinkingBuffers.set(
        thinkingDelta.index,
        nextThinkingText,
      );
      self.streamActiveWorkspaceThinking(
        workspaceState,
        workspaceName,
        runtime,
        thinkingDelta.index,
        nextThinkingText,
      );
    }
    const thinkingEnd = getRpcAssistantThinkingEnd(event);
    if (thinkingEnd) {
      if (thinkingEnd.content !== undefined) {
        runtime.thinkingBuffers.set(thinkingEnd.index, thinkingEnd.content);
      }
      self.flushActiveWorkspaceThinkingBuffer(workspaceState, workspaceName, runtime, thinkingEnd.index);
    }
    const toolCallPreview = getRpcAssistantToolCallPreview(event);
    if (toolCallPreview) {
      self.logWorkspaceFirstOutput(workspaceName, runtime, "tool_call");
      deps.debugLogger?.log("telegram.workspace.tool.preview", {
        ...self.getWorkspaceTurnDetails(workspaceName, runtime),
        index: toolCallPreview.index,
        final: toolCallPreview.final,
      }, toolCallPreview.markdown);
      self.streamActiveWorkspaceCompactToolStatus(workspaceState, workspaceName, runtime, {
        key: toolCallPreview.key,
        markdown: toolCallPreview.markdown,
        status: "queued",
      });
      self.streamActiveWorkspaceToolCall(
        workspaceState,
        workspaceName,
        runtime,
        toolCallPreview.index,
        toolCallPreview.markdown,
        toolCallPreview.final,
      );
    }
    const toolExecutionPreview = getRpcToolExecutionPreview(event);
    if (toolExecutionPreview) {
      self.streamActiveWorkspaceCompactToolStatus(
        workspaceState,
        workspaceName,
        runtime,
        toolExecutionPreview,
      );
    }
    const assistantText = extractRpcAssistantText(event);
    if (assistantText) {
      self.logWorkspaceFirstOutput(workspaceName, runtime, "assistant_text");
      runtime.activeAssistantText = assistantText;
      record.lastAssistantText = assistantText;
      record.lastMessageText = assistantText;
      record.lastMessageAt = eventNow;
    }
    if (event.type === "message_end" && isAssistantAgentMessage(event.message)) {
      deps.debugLogger?.log("telegram.workspace.message.end", {
        ...self.getWorkspaceTurnDetails(workspaceName, runtime),
        hasAssistantMessage: true,
      });
      const finalBodyText = getAgentMessageBodyText(event.message);
      if (runtime.textStream && finalBodyText) {
        runtime.activeBuffer = finalBodyText;
        self.streamActiveWorkspaceText(workspaceState, workspaceName, runtime, finalBodyText, true);
      }
      for (const thinking of extractAgentThinkingBlocks(event.message)) {
        self.streamActiveWorkspaceThinking(
          workspaceState,
          workspaceName,
          runtime,
          thinking.index,
          thinking.text,
          true,
        );
      }
      self.sendActiveWorkspaceToolCallMessage(workspaceState, workspaceName, runtime, event.message);
    }
    if (event.type === "agent_end") {
      deps.debugLogger?.log("telegram.workspace.agent.end", {
        ...self.getWorkspaceTurnDetails(workspaceName, runtime),
        messageCount: Array.isArray(event.messages) ? event.messages.length : undefined,
      });
      self.stopWorkspaceTyping(runtime);
      for (const index of [...runtime.thinkingBuffers.keys()]) {
        self.flushActiveWorkspaceThinkingBuffer(workspaceState, workspaceName, runtime, index);
      }
      const latestAssistant = getLatestAssistantMessage(event.messages);
      if (latestAssistant) {
        for (const thinking of extractAgentThinkingBlocks(latestAssistant)) {
          self.streamActiveWorkspaceThinking(
            workspaceState,
            workspaceName,
            runtime,
            thinking.index,
            thinking.text,
            true,
          );
        }
      }
      if (latestAssistant) {
        self.sendActiveWorkspaceToolCallMessage(
          workspaceState,
          workspaceName,
          runtime,
          latestAssistant,
        );
      }
      record.lastAgentEndAt = eventNow;
      const assistantError = extractRpcAssistantError(event);
      if (assistantError) {
        self.logWorkspaceTurnSummary(workspaceName, runtime, "error", assistantError);
        record.status = "error";
        record.lastError = assistantError;
        const isActive = self.isRuntimeDeliveryActive(workspaceState, workspaceName, runtime);
        if (!runtime.activeErrorDelivered) {
          runtime.activeErrorDelivered = true;
          if (isActive) {
            void self.runInWorkspaceThreadContext(runtime, () =>
              self.sendWorkspaceReply(
                runtime.activeChatId,
                runtime.activeReplyToMessageId,
                self.formatRuntimeFailureMessage(runtime, assistantError),
              ),
            );
          } else {
            runtime.unreadEvents += 1;
            if (deps.getConfig().inactiveNotify) {
              void self.runInWorkspaceThreadContext(runtime, () =>
                self.sendWorkspaceReply(
                  runtime.activeChatId,
                  runtime.activeReplyToMessageId,
                  self.formatRuntimeFailureMessage(runtime, assistantError),
                ),
              );
            }
          }
        }
        void self.persist();
        return;
      }
      const latestAssistantSummary = Array.isArray(event.messages)
        ? extractLatestAssistantMessageText(event.messages)
        : {};
      record.status = "idle";
      record.lastError = undefined;
      if (!runtime.activeAssistantText && runtime.activeBuffer) {
        runtime.activeAssistantText = runtime.activeBuffer;
        record.lastAssistantText = runtime.activeBuffer;
      }
      const isActive = self.isRuntimeDeliveryActive(workspaceState, workspaceName, runtime);
      const finalBodyText = latestAssistant
        ? getAgentMessageBodyText(latestAssistant)
        : runtime.activeBuffer;
      if (latestAssistantSummary.stopReason === "aborted") {
        void (async () => {
          const result = await self.markActiveWorkspaceTextStreamAborted(runtime).catch(
            (error) => {
              deps.recordRuntimeEvent?.("workspaces", error, {
                workspace: workspaceName,
                action: "stream_abort_mark",
                turnId: runtime.activeTurnId,
              });
              return undefined;
            },
          );
          if (result) {
            deps.debugLogger?.log("telegram.workspace.stream.abort.result", {
              ...self.getWorkspaceTurnDetails(workspaceName, runtime),
              streamMessageId: runtime.textStream?.messageId,
              status: result.status,
              delivered: result.status === "delivered",
              error: "error" in result ? result.error : undefined,
              stale: result.stale,
            });
          }
        })();
        self.logWorkspaceTurnSummary(workspaceName, runtime, "aborted");
        void self.persist();
        return;
      }
      const finalReplyMarkdown = finalBodyText || runtime.activeAssistantText || "";
      const finalPostRunMarkdown = finalReplyMarkdown.trim()
        ? [
            ...runtime.postRunMessages.filter(
              (message) => !isTelegramWorkspacePostRunTextMessage(message),
            ),
            { kind: "text" as const, markdown: finalReplyMarkdown },
          ]
            .map((message) => message.markdown.trim())
            .filter(Boolean)
            .join("\n\n")
        : runtime.postRunMessages
            .map((message) => message.markdown.trim())
            .filter(Boolean)
            .join("\n\n");
      if (isActive && finalPostRunMarkdown) {
        const deliveryTarget = {
          chatId: runtime.activeChatId,
          messageThreadId: runtime.activeMessageThreadId,
          replyToMessageId: runtime.activeReplyToMessageId,
          turnId: runtime.activeTurnId,
        };
        const stream = runtime.textStream;
        const finalStreamMarkdown = finalBodyText.trim();
        void (async () => {
          // Force-flush the compact tool-status stream before finalizing the text
          // stream so its Telegram message_id stays smaller than the final answer
          // (otherwise a throttled first-send can land the Tools message last).
          const toolStatusStream = runtime.toolCallStatusStream;
          if (
            toolStatusStream &&
            toolStatusStream.markdown &&
            toolStatusStream.markdown !== toolStatusStream.sentMarkdown
          ) {
            try {
              await self.flushWorkspaceStreamMarkdown(runtime, toolStatusStream, {
                force: true,
                allowStaleDelivery: true,
                retryOnFailure: false,
              });
            } catch (error) {
              deps.recordRuntimeEvent?.("workspaces", error, {
                workspace: workspaceName,
                action: "tool_status_finalize_flush",
                turnId: deliveryTarget.turnId,
                chatId: deliveryTarget.chatId,
                messageThreadId: deliveryTarget.messageThreadId,
              });
            }
          }
          let streamResult: TelegramWorkspaceStreamDeliveryResult | undefined;
          let streamDelivered = false;
          let fallbackSent = false;
          let fallbackError: string | undefined;
          if (stream && finalStreamMarkdown) {
            deps.debugLogger?.log("telegram.workspace.stream.finalize.start", {
              workspace: workspaceName,
              turnId: deliveryTarget.turnId,
              chatId: deliveryTarget.chatId,
              messageThreadId: deliveryTarget.messageThreadId,
              replyToMessageId: deliveryTarget.replyToMessageId,
              streamMessageId: stream.messageId,
              finalTextLength: finalStreamMarkdown.length,
              sentMarkdownLength: stream.sentMarkdown.length,
            });
            try {
              streamResult = await self.finalizeActiveWorkspaceTextStream(
                runtime,
                stream,
                finalStreamMarkdown,
              );
              streamDelivered = self.isFinalWorkspaceStreamDeliveryConfirmed(
                streamResult,
                finalStreamMarkdown,
                stream.sentMarkdown,
              );
            } catch (error) {
              fallbackError = getErrorMessage(error);
              streamResult = {
                status: "failed",
                error: fallbackError,
                stale: stream ? self.isWorkspaceStreamStale(runtime, stream) : false,
              };
              deps.recordRuntimeEvent?.("workspaces", error, {
                workspace: workspaceName,
                action: "stream_finalize",
                turnId: deliveryTarget.turnId,
                chatId: deliveryTarget.chatId,
                messageThreadId: deliveryTarget.messageThreadId,
                replyToMessageId: deliveryTarget.replyToMessageId,
                streamMessageId: stream.messageId,
              });
            }
          }
          if (!streamDelivered) {
            try {
              const messageId = await runWithTelegramThreadContext(
                deliveryTarget.chatId === undefined
                  ? undefined
                  : {
                      chatId: deliveryTarget.chatId,
                      messageThreadId: deliveryTarget.messageThreadId,
                    },
                () =>
                  self.sendWorkspaceMarkdownReply(
                    deliveryTarget.chatId,
                    deliveryTarget.replyToMessageId,
                    finalPostRunMarkdown,
                  ),
              );
              fallbackSent = messageId !== undefined;
            } catch (error) {
              fallbackError = getErrorMessage(error);
              deps.recordRuntimeEvent?.("workspaces", error, {
                workspace: workspaceName,
                action: "stream_final_fallback",
                turnId: deliveryTarget.turnId,
                chatId: deliveryTarget.chatId,
                messageThreadId: deliveryTarget.messageThreadId,
                replyToMessageId: deliveryTarget.replyToMessageId,
              });
            }
          }
          if (streamDelivered) {
            runtime.postRunMessages = runtime.postRunMessages.filter(
              (message) => !isTelegramWorkspacePostRunTextMessage(message),
            );
          }
          if (fallbackSent) {
            await self.deleteRuntimePostRunPreviewMessages(runtime, stream);
            runtime.postRunMessages = [];
            clearRuntimePostRunPreviewStreams(runtime);
          }
          if (stream || streamResult) {
            deps.debugLogger?.log("telegram.workspace.stream.finalize.result", {
              workspace: workspaceName,
              turnId: deliveryTarget.turnId,
              chatId: deliveryTarget.chatId,
              messageThreadId: deliveryTarget.messageThreadId,
              replyToMessageId: deliveryTarget.replyToMessageId,
              streamMessageId:
                streamResult?.status === "delivered"
                  ? streamResult.messageId
                  : stream?.messageId,
              finalTextLength: finalStreamMarkdown.length,
              sentMarkdownLength:
                streamResult?.status === "delivered"
                  ? streamResult.sentMarkdown.length
                  : stream?.sentMarkdown.length,
              status: streamResult?.status ?? "skipped",
              reason: streamResult && "reason" in streamResult
                ? streamResult.reason
                : undefined,
              delivered: streamDelivered,
              fallbackSent,
              error: fallbackError ?? (streamResult && "error" in streamResult
                ? streamResult.error
                : undefined),
              stale: streamResult?.stale,
            });
          }
        })();
      } else if (!isActive) {
        runtime.unreadEvents += 1;
        if (deps.getConfig().inactiveNotify) {
          const chatId = runtime.activeChatId;
          const replyToMessageId = runtime.activeReplyToMessageId;
          void self.runInWorkspaceThreadContext(runtime, () =>
            self.sendWorkspaceReply(
              chatId,
              replyToMessageId,
              self.formatRuntimeFinishedNotice(runtime, workspaceName),
            ),
          );
        }
      }
      self.logWorkspaceTurnSummary(workspaceName, runtime, latestAssistantSummary.stopReason ?? "stop");
      void self.persist();
      return;
    }
    if (event.type === "exit") {
      deps.debugLogger?.log("telegram.workspace.worker.exit", self.getWorkspaceTurnDetails(workspaceName, runtime), event);
      self.stopWorkspaceTyping(runtime);
      if (record.status === "running" || record.status === "starting") {
        record.status = "exited";
      }
      runtime.backend = undefined;
      runtime.unsubscribe?.();
      runtime.unsubscribe = undefined;
      void self.persist();
      return;
    }
    if (event.type === "error") {
      const errorMessage = typeof event.error === "string" ? event.error : "RPC child error";
      deps.debugLogger?.log("telegram.workspace.worker.error", {
        ...self.getWorkspaceTurnDetails(workspaceName, runtime),
        error: errorMessage,
      }, event);
      self.logWorkspaceTurnSummary(workspaceName, runtime, "error", errorMessage);
      self.stopWorkspaceTyping(runtime);
      record.status = "error";
      record.lastError = errorMessage;
      void self.persist();
    }
  };
}
