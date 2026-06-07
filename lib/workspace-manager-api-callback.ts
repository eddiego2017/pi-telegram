/**
 * Workspace manager public API: callback queries and topic service messages
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import {
  isTelegramForumTopicPermissionError,
} from "./api.ts";
import {
  getTelegramForumTopicMessageThreadId,
  normalizeTelegramForumThread,
  runWithTelegramThreadContext,
} from "./thread-context.ts";
import {
  TELEGRAM_FORUM_NATIVE_WORKSPACE_LIFECYCLE_DISABLED_MESSAGE,
} from "./workspace-manager-constants.ts";
import {
  buildTelegramWorkspaceConfirmReplyMarkup,
  buildTelegramWorkspaceMultiCloseConfirmationReplyMarkup,
  buildTelegramWorkspaceMultiCloseConfirmationText,
  decodeTelegramWorkspaceCallbackName,
  getTelegramWorkspaceCloseableNames,
  normalizeTelegramWorkspaceCloseSelection,
} from "./workspace-manager-dashboard.ts";
import {
  getErrorMessage,
  getTelegramWorkspaceSessionReference,
} from "./workspace-manager-state.ts";
import type {
  TelegramWorkspaceManager,
  TelegramWorkspaceManagerDeps,
} from "./workspace-manager-types.ts";
import {
  TELEGRAM_DEFAULT_WORKSPACE_NAME,
  findTelegramWorkspaceByTopic,
  formatTelegramWorkspaceDisplayName,
  formatTelegramWorkspaceStatusLabel,
} from "./workspaces.ts";

export function buildApiCallback<TContext>(
  self: WsRuntimeContext<TContext>,
  deps: TelegramWorkspaceManagerDeps<TContext>,
): Pick<TelegramWorkspaceManager<TContext>, "handleCallbackQuery" | "handleTopicServiceMessage"> {
  return {
    handleCallbackQuery: async (query, ctx) => {
      const data = query.data;
      if (!data?.startsWith("workspace:")) return false;
      if (!self.isEnabled()) {
        await self.answerWorkspaceCallback(query.id, "Concurrent workspaces are disabled.");
        return true;
      }
      const chatId = query.message?.chat?.id;
      const messageId = query.message?.message_id;
      if (typeof chatId !== "number" || typeof messageId !== "number") {
        await self.answerWorkspaceCallback(query.id);
        return true;
      }
      const workspaceState = await self.ensureState(deps.getCwd(ctx));
      const [, action, rawMode, rawName] = data.split(":");
      if (
        self.isForumNativeMode() &&
        (action === "switch" || action === "close" || action?.startsWith("close-"))
      ) {
        await self.answerWorkspaceCallback(
          query.id,
          TELEGRAM_FORUM_NATIVE_WORKSPACE_LIFECYCLE_DISABLED_MESSAGE,
        );
        await self.editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "open",
          selectedCloseWorkspaces: [],
        });
        return true;
      }
      if (action === "noop") {
        const activeRuntime = self.getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
        await self.answerWorkspaceCallback(
          query.id,
          `Active workspace: ${formatTelegramWorkspaceDisplayName(
            activeRuntime?.record.name ?? workspaceState.activeWorkspace,
          )}`,
        );
        return true;
      }
      if (action === "refresh") {
        await self.editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "open",
          selectedCloseWorkspaces: [],
        });
        await self.answerWorkspaceCallback(query.id, "Refreshed.");
        return true;
      }
      if (action === "close-manage") {
        await self.editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "close",
          selectedCloseWorkspaces: [],
        });
        await self.answerWorkspaceCallback(query.id);
        return true;
      }
      if (action === "close-done") {
        await self.editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "open",
          selectedCloseWorkspaces: [],
        });
        await self.answerWorkspaceCallback(query.id, "Done.");
        return true;
      }
      if (action === "close-toggle") {
        const name = decodeTelegramWorkspaceCallbackName(rawMode);
        if (!name || !workspaceState.workspaces[name] || name === TELEGRAM_DEFAULT_WORKSPACE_NAME) {
          await self.answerWorkspaceCallback(query.id, "Workspace cannot be closed.");
          await self.editWorkspaceDashboard(workspaceState, chatId, messageId, { mode: "close" });
          return true;
        }
        const dashboardState = self.getDashboardState(messageId);
        const selected = new Set(
          normalizeTelegramWorkspaceCloseSelection(
            workspaceState,
            dashboardState?.selectedCloseWorkspaces ?? [],
          ),
        );
        if (selected.has(name)) selected.delete(name);
        else selected.add(name);
        await self.editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "close",
          selectedCloseWorkspaces: [...selected],
        });
        await self.answerWorkspaceCallback(
          query.id,
          selected.has(name) ? "Selected." : "Unselected.",
        );
        return true;
      }
      if (action === "close-select-all") {
        const selectedCloseWorkspaces = getTelegramWorkspaceCloseableNames(workspaceState);
        await self.editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "close",
          selectedCloseWorkspaces,
        });
        await self.answerWorkspaceCallback(
          query.id,
          selectedCloseWorkspaces.length > 0 ? "All closeable workspaces selected." : "No closeable workspaces.",
        );
        return true;
      }
      if (action === "close-clear") {
        await self.editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "close",
          selectedCloseWorkspaces: [],
        });
        await self.answerWorkspaceCallback(query.id, "Selection cleared.");
        return true;
      }
      if (action === "close-selected") {
        const dashboardState = self.getDashboardState(messageId);
        const selectedCloseWorkspaces = normalizeTelegramWorkspaceCloseSelection(
          workspaceState,
          dashboardState?.selectedCloseWorkspaces ?? [],
        );
        if (selectedCloseWorkspaces.length === 0) {
          await self.answerWorkspaceCallback(query.id, "No workspaces selected.");
          return true;
        }
        await deps.editInteractiveMessage?.(
          chatId,
          messageId,
          buildTelegramWorkspaceMultiCloseConfirmationText(workspaceState, selectedCloseWorkspaces),
          "plain",
          buildTelegramWorkspaceMultiCloseConfirmationReplyMarkup(),
        );
        self.setDashboardState({
          chatId,
          messageId,
          mode: "close",
          selectedCloseWorkspaces,
          updatedAt: self.now(),
        });
        await self.answerWorkspaceCallback(query.id);
        return true;
      }
      if (action === "close-cancel") {
        const selectedCloseWorkspaces = normalizeTelegramWorkspaceCloseSelection(
          workspaceState,
          self.getDashboardState(messageId)?.selectedCloseWorkspaces ?? [],
        );
        await self.editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "close",
          selectedCloseWorkspaces,
        });
        await self.answerWorkspaceCallback(query.id, "Cancelled.");
        return true;
      }
      if (action === "close-confirm") {
        const selectedCloseWorkspaces = normalizeTelegramWorkspaceCloseSelection(
          workspaceState,
          self.getDashboardState(messageId)?.selectedCloseWorkspaces ?? [],
        );
        if (selectedCloseWorkspaces.length === 0) {
          await self.answerWorkspaceCallback(query.id, "No workspaces selected.");
          return true;
        }
        const closedNames: string[] = [];
        const skippedMessages: string[] = [];
        try {
          for (const name of selectedCloseWorkspaces) {
            const result = await self.closeWorkspaceRuntime(workspaceState, name, true);
            if (result.closed) closedNames.push(name);
            else skippedMessages.push(result.message);
          }
          if (closedNames.length > 0) await self.persist();
        } catch (error) {
          await self.answerWorkspaceCallback(
            query.id,
            `Close failed: ${getErrorMessage(error)}`,
          );
          return true;
        }
        await self.editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "open",
          selectedCloseWorkspaces: [],
        });
        const skippedSuffix = skippedMessages.length > 0
          ? ` ${skippedMessages.length} skipped.`
          : "";
        await self.answerWorkspaceCallback(
          query.id,
          `${closedNames.length} workspace${closedNames.length === 1 ? "" : "s"} closed.${skippedSuffix}`,
        );
        return true;
      }
      if (action === "switch") {
        const name = decodeTelegramWorkspaceCallbackName(rawMode);
        if (!name || !workspaceState.workspaces[name]) {
          await self.answerWorkspaceCallback(query.id, "Workspace no longer exists.");
          await self.editWorkspaceDashboard(workspaceState, chatId, messageId, {
            mode: "open",
            selectedCloseWorkspaces: [],
          });
          return true;
        }
        await self.answerWorkspaceCallback(query.id, `Switching to ${name}.`);
        await self.commandHandlers.switch(workspaceState, name, chatId, messageId);
        await self.editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "open",
          selectedCloseWorkspaces: [],
        });
        return true;
      }
      if (action === "last5") {
        const runtime = self.getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
        if (!runtime || !deps.sendLastTurnsOnSwitch) {
          await self.answerWorkspaceCallback(query.id, "No replay available.");
          return true;
        }
        await self.answerWorkspaceCallback(query.id, "Replaying latest turn.");
        await deps.sendLastTurnsOnSwitch(
          getTelegramWorkspaceSessionReference(runtime.record),
          chatId,
          messageId,
        );
        return true;
      }
      if (action === "status") {
        await self.answerWorkspaceCallback(query.id, "Sending status.");
        await self.commandHandlers.status(workspaceState, workspaceState.activeWorkspace, chatId, messageId);
        return true;
      }
      if (action === "help") {
        const text = self.isForumNativeMode()
          ? TELEGRAM_FORUM_NATIVE_WORKSPACE_LIFECYCLE_DISABLED_MESSAGE
          : rawMode === "rename"
            ? "Use /workspace rename [old-name] <new-name>."
            : "Use /workspace new <name>.";
        await self.answerWorkspaceCallback(query.id, text);
        return true;
      }
      if (action === "abort" || action === "close") {
        const mode = rawMode;
        const name = decodeTelegramWorkspaceCallbackName(
          mode === "do" ? rawName : rawMode,
        );
        if (!name || !workspaceState.workspaces[name]) {
          await self.answerWorkspaceCallback(query.id, "Workspace no longer exists.");
          await self.editWorkspaceDashboard(workspaceState, chatId, messageId, {
            mode: "open",
            selectedCloseWorkspaces: [],
          });
          return true;
        }
        if (mode === "do") {
          await self.answerWorkspaceCallback(
            query.id,
            action === "abort" ? `Aborting ${name}.` : `Closing ${name}.`,
          );
          if (action === "abort") {
            await self.commandHandlers.abort(workspaceState, name, chatId, messageId);
          } else {
            await self.commandHandlers.close(workspaceState, name, true, chatId, messageId);
          }
          await self.editWorkspaceDashboard(workspaceState, chatId, messageId, {
            mode: "open",
            selectedCloseWorkspaces: [],
          });
          return true;
        }
        const runtime = self.getWorkspaceRuntime(workspaceState, name);
        const detail =
          action === "abort"
            ? `Abort workspace ${name}?`
            : `Close workspace ${name}? Session file will be kept.`;
        const status = runtime?.record.status
          ? `\nStatus: ${formatTelegramWorkspaceStatusLabel(runtime.record.status)}`
          : "";
        await deps.editInteractiveMessage?.(
          chatId,
          messageId,
          `${detail}${status}`,
          "plain",
          buildTelegramWorkspaceConfirmReplyMarkup(action, name),
        );
        await self.answerWorkspaceCallback(query.id);
        return true;
      }
      await self.answerWorkspaceCallback(query.id);
      return true;
    },
    handleTopicServiceMessage: async (message, ctx) => {
      const serviceKind = self.getTelegramTopicServiceKind(message);
      if (!serviceKind) return false;
      const chatId = message.chat.id;
      const normalizedThread = normalizeTelegramForumThread(message);
      const messageThreadId = getTelegramForumTopicMessageThreadId(
        normalizedThread,
      );
      deps.debugLogger?.log("telegram.workspace.topic.service", {
        kind: serviceKind,
        chatId,
        messageThreadId,
        title:
          message.forum_topic_created?.name ?? message.forum_topic_edited?.name,
      });
      if (!self.isTopicBindingEnabled()) return true;
      if (typeof chatId !== "number" || typeof messageThreadId !== "number") {
        return true;
      }
      if (!self.isTrustedTopicBindingChat(chatId)) {
        deps.debugLogger?.log("telegram.workspace.topic.service.untrusted_chat", {
          kind: serviceKind,
          chatId,
          messageThreadId,
          hasFrom: "from" in message,
        });
        return true;
      }
      const workspaceState = await self.ensureState(deps.getCwd(ctx));
      if (serviceKind === "created") {
        await self.upsertTelegramTopicWorkspaceRecord(
          workspaceState,
          {
            chatId,
            messageThreadId,
            topicTitle: message.forum_topic_created?.name,
          },
          ctx,
          { enforceCapacity: false },
        );
        return true;
      }
      if (serviceKind === "edited") {
        const record = findTelegramWorkspaceByTopic(
          workspaceState.workspaces,
          chatId,
          messageThreadId,
        );
        if (record && self.updateTelegramTopicRecordTitle(record, message.forum_topic_edited?.name)) {
          const runtime = self.getWorkspaceRuntime(workspaceState, record.name);
          if (runtime) {
            await self.syncTopicSessionNameToWorker(runtime, { forceWorker: true });
          }
          await self.persist();
        }
        return true;
      }
      if (serviceKind === "closed") {
        const topicBinding = self.getTopicBindingConfig();
        if (!topicBinding?.closeOnTopicClose) return true;
        const record = findTelegramWorkspaceByTopic(
          workspaceState.workspaces,
          chatId,
          messageThreadId,
        );
        if (!record || record.name === TELEGRAM_DEFAULT_WORKSPACE_NAME) return true;
        const result = await self.closeWorkspaceRuntime(workspaceState, record.name, true);
        if (result.closed) await self.persist();
        if (topicBinding.deleteTopicOnClose && deps.deleteForumTopic) {
          try {
            await deps.deleteForumTopic(chatId, messageThreadId);
            deps.debugLogger?.log("telegram.workspace.topic.delete", {
              chatId,
              messageThreadId,
              workspace: record.name,
              result: "deleted",
            });
          } catch (error) {
            deps.debugLogger?.log("telegram.workspace.topic.delete_error", {
              chatId,
              messageThreadId,
              workspace: record.name,
              error: getErrorMessage(error),
            });
            deps.recordRuntimeEvent?.("workspaces", error, {
              action: "deleteForumTopic",
              workspace: record.name,
              chatId,
              messageThreadId,
            });
            if (isTelegramForumTopicPermissionError(error)) {
              await runWithTelegramThreadContext(
                { chatId, messageThreadId: undefined },
                () =>
                  deps.sendTextReply(
                    chatId,
                    undefined,
                    "已關閉 pi workspace，但無法刪除 Telegram topic。請把 bot 設為 admin，並開啟 Manage Topics 權限。",
                  ),
              );
            }
          }
        }
        return true;
      }
      if (serviceKind === "reopened") {
        if (!self.getTopicBindingConfig()?.autoCreate) return true;
        await self.upsertTelegramTopicWorkspaceRecord(
          workspaceState,
          { chatId, messageThreadId },
          ctx,
          { enforceCapacity: true },
        );
        return true;
      }
      return true;
    },
  };
}
