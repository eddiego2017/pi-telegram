/**
 * Workspace command handlers: list/query/new/switch/rename/close/status
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import {
  createWorkspaceRuntime,
} from "./workspace-manager-events.ts";
import {
  applyRpcStateToRecord,
  getErrorMessage,
  getTelegramWorkspaceSessionReference,
} from "./workspace-manager-state.ts";
import type {
  TelegramWorkspaceManagerDeps,
  WorkspaceRuntime,
} from "./workspace-manager-types.ts";
import {
  TELEGRAM_DEFAULT_WORKSPACE_NAME,
  findTelegramWorkspaceNameCaseConflict,
  formatTelegramWorkspaceDisplayName,
  formatTelegramWorkspaceStatus,
  normalizeTelegramWorkspaceName,
  truncateTelegramWorkspaceText,
  validateTelegramWorkspaceName,
} from "./workspaces.ts";
import type {
  TelegramWorkspaceRecord,
  TelegramWorkspacesState,
} from "./workspaces.ts";

type WsCommandHandlers<TContext> = WsRuntimeContext<TContext>["commandHandlers"];

export function buildCommandsCore<TContext>(
  self: WsRuntimeContext<TContext>,
  deps: TelegramWorkspaceManagerDeps<TContext>,
): Pick<WsCommandHandlers<TContext>, "list" | "query" | "new" | "switch" | "rename" | "close" | "status"> {
  return {
    list: async (
      workspaceState: TelegramWorkspacesState,
      chatId: number,
      replyToMessageId: number,
    ) => {
      await self.sendWorkspaceDashboard(workspaceState, chatId, replyToMessageId);
    },
    query: async (
      workspaceState: TelegramWorkspacesState,
      query: string,
      filters: readonly string[],
      chatId: number,
      replyToMessageId: number,
    ) => {
      const name = normalizeTelegramWorkspaceName(query);
      if (!self.isForumNativeMode() && self.getWorkspaceRuntime(workspaceState, name)) {
        await self.commandHandlers.switch(workspaceState, name, chatId, replyToMessageId);
        return;
      }
      await self.sendWorkspaceDashboard(workspaceState, chatId, replyToMessageId, filters);
    },
    new: async (
      workspaceState: TelegramWorkspacesState,
      name: string,
      chatId: number,
      replyToMessageId: number,
      ctx: TContext,
    ) => {
      name = normalizeTelegramWorkspaceName(name);
      const validationError = validateTelegramWorkspaceName(name);
      if (validationError) {
        await deps.sendTextReply(chatId, replyToMessageId, validationError);
        return;
      }
      if (workspaceState.workspaces[name]) {
        await deps.sendTextReply(chatId, replyToMessageId, `Workspace ${formatTelegramWorkspaceDisplayName(name)} already exists.`);
        return;
      }
      const conflict = findTelegramWorkspaceNameCaseConflict(workspaceState.workspaces, name);
      if (conflict) {
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Workspace ${conflict} already exists with different case.`,
        );
        return;
      }
      if (Object.keys(workspaceState.workspaces).length >= deps.getConfig().maxWorkspaces) {
        await deps.sendTextReply(chatId, replyToMessageId, "Maximum workspace count reached.");
        return;
      }
      const createdAt = self.now();
      const record: TelegramWorkspaceRecord = {
        name,
        cwd: deps.getCwd(ctx),
        createdAt,
        lastUsedAt: createdAt,
        status: "idle",
      };
      const previousRuntime = self.getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
      if (previousRuntime) self.stopWorkspaceTyping(previousRuntime);
      workspaceState.workspaces[name] = record;
      workspaceState.activeWorkspace = name;
      const runtime: WorkspaceRuntime = createWorkspaceRuntime(record);
      self.workspaceRuntimes.set(name, runtime);
      await self.persist();
      try {
        await self.ensureBackend(runtime, ctx);
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Created and switched to workspace ${formatTelegramWorkspaceDisplayName(name)}.`,
        );
      } catch (error) {
        deps.recordRuntimeEvent?.("workspaces", error, { workspace: name, action: "new" });
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Created workspace ${formatTelegramWorkspaceDisplayName(name)}, but worker failed: ${getErrorMessage(error)}`,
        );
      }
    },
    switch: async (
      workspaceState: TelegramWorkspacesState,
      name: string,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const runtime = self.getWorkspaceRuntime(workspaceState, name);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown workspace: ${formatTelegramWorkspaceDisplayName(name)}`);
        return;
      }
      const previousRuntime = self.getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
      if (previousRuntime && previousRuntime !== runtime) self.stopWorkspaceTyping(previousRuntime);
      workspaceState.activeWorkspace = name;
      runtime.record.lastUsedAt = self.now();
      const shouldReplayUnread = runtime.unreadEvents > 0 && Boolean(deps.sendLastTurnsOnSwitch);
      runtime.unreadEvents = 0;
      if (runtime.record.status === "running") self.startWorkspaceTyping(name, runtime);
      await self.persist();
      const lastAssistantText = !shouldReplayUnread
        ? runtime.record.lastAssistantText
        : undefined;
      const replayNote = shouldReplayUnread ? " Replaying unread latest messages." : "";
      if (lastAssistantText && deps.sendMarkdownReply) {
        await deps.sendMarkdownReply(
          chatId,
          replyToMessageId,
          `Switched to workspace ${formatTelegramWorkspaceDisplayName(name)}.\n\nLast reply:\n${lastAssistantText}`,
        );
      } else {
        const latest = lastAssistantText
          ? `\n\nLast reply:\n${truncateTelegramWorkspaceText(lastAssistantText)}`
          : "";
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Switched to workspace ${formatTelegramWorkspaceDisplayName(name)}.${replayNote}${latest}`,
        );
      }
      if (shouldReplayUnread && deps.sendLastTurnsOnSwitch) {
        await deps.sendLastTurnsOnSwitch(
          getTelegramWorkspaceSessionReference(runtime.record),
          chatId,
          replyToMessageId,
        ).catch((error) => {
          deps.recordRuntimeEvent?.("workspaces", error, {
            workspace: runtime.record.name,
            action: "switch_replay",
          });
        });
      }
    },
    rename: async (
      workspaceState: TelegramWorkspacesState,
      oldName: string | undefined,
      newName: string,
      chatId: number,
      replyToMessageId: number,
    ) => {
      newName = normalizeTelegramWorkspaceName(newName);
      const sourceName = oldName ? normalizeTelegramWorkspaceName(oldName) : workspaceState.activeWorkspace;
      if (sourceName === TELEGRAM_DEFAULT_WORKSPACE_NAME) {
        await deps.sendTextReply(chatId, replyToMessageId, "Cannot rename General.");
        return;
      }
      const runtime = self.getWorkspaceRuntime(workspaceState, sourceName);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown workspace: ${formatTelegramWorkspaceDisplayName(sourceName)}`);
        return;
      }
      const validationError = validateTelegramWorkspaceName(newName);
      if (validationError) {
        await deps.sendTextReply(chatId, replyToMessageId, validationError);
        return;
      }
      if (newName === sourceName) {
        await deps.sendTextReply(chatId, replyToMessageId, `Workspace ${formatTelegramWorkspaceDisplayName(sourceName)} is already named ${formatTelegramWorkspaceDisplayName(newName)}.`);
        return;
      }
      if (workspaceState.workspaces[newName]) {
        await deps.sendTextReply(chatId, replyToMessageId, `Workspace ${formatTelegramWorkspaceDisplayName(newName)} already exists.`);
        return;
      }
      const conflict = Object.keys(workspaceState.workspaces).find(
        (existing) =>
          existing !== sourceName && existing.toLowerCase() === newName.toLowerCase(),
      );
      if (conflict) {
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Workspace ${conflict} already exists with different case.`,
        );
        return;
      }
      delete workspaceState.workspaces[sourceName];
      runtime.record.name = newName;
      runtime.record.lastUsedAt = self.now();
      workspaceState.workspaces[newName] = runtime.record;
      if (workspaceState.activeWorkspace === sourceName) workspaceState.activeWorkspace = newName;
      self.workspaceRuntimes.delete(sourceName);
      self.workspaceRuntimes.set(newName, runtime);
      await self.persist();
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        `Renamed workspace ${formatTelegramWorkspaceDisplayName(sourceName)} to ${formatTelegramWorkspaceDisplayName(newName)}.`,
      );
    },
    close: async (
      workspaceState: TelegramWorkspacesState,
      name: string | undefined,
      force: boolean,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const targetName = name ?? workspaceState.activeWorkspace;
      const result = await self.closeWorkspaceRuntime(workspaceState, targetName, force);
      if (result.closed) await self.persist();
      await deps.sendTextReply(chatId, replyToMessageId, result.message);
    },
    status: async (
      workspaceState: TelegramWorkspacesState,
      name: string | undefined,
      chatId: number,
      replyToMessageId: number,
    ) => {
      if (!name) {
        await self.commandHandlers.list(workspaceState, chatId, replyToMessageId);
        return;
      }
      const runtime = self.getWorkspaceRuntime(workspaceState, name);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown workspace: ${formatTelegramWorkspaceDisplayName(name)}`);
        return;
      }
      if (runtime.backend) {
        await runtime.backend
          .getState()
          .then((childState) => applyRpcStateToRecord(runtime.record, childState))
          .catch((error) => {
            runtime.record.status = "error";
            runtime.record.lastError = getErrorMessage(error);
          });
        await self.persist();
      }
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        formatTelegramWorkspaceStatus(runtime.record, runtime.unreadEvents, self.now()),
      );
    },
  };
}
