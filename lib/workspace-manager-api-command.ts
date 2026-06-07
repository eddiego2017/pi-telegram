/**
 * Workspace manager public API: command dispatch, prompt dispatch, dispose
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import type {
  RpcChildSessionState,
} from "./rpc-child.ts";
import {
  formatTelegramTopicRepairUsage,
} from "./workspace-manager-dashboard.ts";
import {
  buildTelegramWorkspacePromptText,
  getErrorMessage,
} from "./workspace-manager-state.ts";
import type {
  TelegramWorkspaceManager,
  TelegramWorkspaceManagerDeps,
} from "./workspace-manager-types.ts";
import {
  formatTelegramWorkspaceUsage,
  parseTelegramWorkspaceCommand,
} from "./workspaces.ts";

export function buildApiCommand<TContext>(
  self: WsRuntimeContext<TContext>,
  deps: TelegramWorkspaceManagerDeps<TContext>,
): Pick<TelegramWorkspaceManager<TContext>, "handleCommand" | "handleTopicCommand" | "dispatchPrompt" | "dispose"> {
  return {
    handleCommand: async (args, chatId, replyToMessageId, ctx) => {
      if (!self.isEnabled()) {
        await self.replyDisabled(chatId, replyToMessageId);
        return true;
      }
      const workspaceState = await self.ensureState(deps.getCwd(ctx));
      const command = parseTelegramWorkspaceCommand(args);
      switch (command.kind) {
        case "list":
          await self.commandHandlers.list(workspaceState, chatId, replyToMessageId);
          return true;
        case "new":
          if (self.isForumNativeMode()) {
            await self.sendForumNativeLifecycleDisabledReply(chatId, replyToMessageId);
            return true;
          }
          await self.commandHandlers.new(workspaceState, command.name, chatId, replyToMessageId, ctx);
          return true;
        case "query":
          await self.commandHandlers.query(workspaceState, command.query, command.filters, chatId, replyToMessageId);
          return true;
        case "switch":
          if (self.isForumNativeMode()) {
            await self.sendForumNativeLifecycleDisabledReply(chatId, replyToMessageId);
            return true;
          }
          await self.commandHandlers.switch(workspaceState, command.name, chatId, replyToMessageId);
          return true;
        case "rename":
          if (self.isForumNativeMode()) {
            await self.sendForumNativeLifecycleDisabledReply(chatId, replyToMessageId);
            return true;
          }
          await self.commandHandlers.rename(workspaceState, command.oldName, command.newName, chatId, replyToMessageId);
          return true;
        case "syncNames":
          await self.commandHandlers.syncNames(workspaceState, chatId, replyToMessageId);
          return true;
        case "close":
          if (self.isForumNativeMode()) {
            await self.sendForumNativeLifecycleDisabledReply(chatId, replyToMessageId);
            return true;
          }
          await self.commandHandlers.close(workspaceState, command.name, command.force, chatId, replyToMessageId);
          return true;
        case "status":
          await self.commandHandlers.status(workspaceState, command.name, chatId, replyToMessageId);
          return true;
        case "abort":
          await self.commandHandlers.abort(workspaceState, command.name, chatId, replyToMessageId);
          return true;
        case "restart":
          await self.commandHandlers.restart(workspaceState, command.name, chatId, replyToMessageId, ctx);
          return true;
        case "invalid":
          await deps.sendTextReply(chatId, replyToMessageId, command.message);
          return true;
        case "usage":
          await deps.sendTextReply(chatId, replyToMessageId, formatTelegramWorkspaceUsage());
          return true;
      }
    },
    handleTopicCommand: async (args, chatId, replyToMessageId, ctx) => {
      if (!self.isEnabled()) {
        await self.replyDisabled(chatId, replyToMessageId);
        return true;
      }
      const workspaceState = await self.ensureState(deps.getCwd(ctx));
      const cleanedArgs = args.trim().toLowerCase();
      if (!cleanedArgs || cleanedArgs === "orphans") {
        await self.commandHandlers.topicOrphans(workspaceState, chatId, replyToMessageId);
        return true;
      }
      if (cleanedArgs === "cleanup") {
        await self.commandHandlers.topicCleanup(workspaceState, chatId, replyToMessageId);
        return true;
      }
      await deps.sendTextReply(chatId, replyToMessageId, formatTelegramTopicRepairUsage());
      return true;
    },
    dispatchPrompt: async (turn, ctx) => {
      if (!self.isEnabled()) return false;
      const workspaceState = await self.ensureState(deps.getCwd(ctx));
      const runtime = await self.getWorkspaceRuntimeForPromptTurn(workspaceState, turn, ctx);
      if (!runtime) return true;
      let childState: RpcChildSessionState | undefined;
      try {
        childState = await self.refreshRuntimeState(runtime);
        await self.assertNoOpenSessionConflict(workspaceState, runtime, runtime.record);
      } catch (error) {
        await self.sendTurnTextReply(turn, getErrorMessage(error));
        return true;
      }
      const promptText = buildTelegramWorkspacePromptText(turn);
      if (!promptText) {
        await self.sendTurnTextReply(
          turn,
          self.isForumNativeMode() ? "Topic prompt is empty." : "Workspace prompt is empty.",
        );
        return true;
      }
      const isCompacting = childState?.isCompacting === true;
      const isStarting = runtime.record.status === "starting";
      const wasRunning = runtime.record.status === "running";
      if (isCompacting) {
        const queued = runtime.pendingCompactionTurns ?? [];
        queued.push(turn);
        runtime.pendingCompactionTurns = queued;
        await self.sendTurnTextReply(
          turn,
          `Queued in ${self.formatRuntimeUserScopeTarget(runtime, turn)} (compaction in progress, ${queued.length} waiting).`,
        );
        return true;
      }
      if (isStarting) {
        await self.sendTurnTextReply(turn, self.formatRuntimeBusyMessage(runtime, turn));
        return true;
      }
      await self.deliverPromptTurn(runtime, turn, ctx, { wasRunning });
      return true;
    },
    dispose: async () => {
      await Promise.all(
        [...self.workspaceRuntimes.values()].map(async (runtime) => {
          await self.disposeClosingRuntimeBackend(runtime);
          if (runtime.record.status === "running" || runtime.record.status === "starting") {
            runtime.record.status = "exited";
          }
        }),
      );
      await self.persist();
    },
  };
}
