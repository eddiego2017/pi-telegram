/**
 * Prompt-turn delivery and pending compaction-turn queue
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import {
  buildTelegramWorkspacePromptText,
  getErrorMessage,
} from "./workspace-manager-state.ts";
import type {
  TelegramWorkspaceManagerDeps,
  TelegramWorkspacePromptTurn,
  WorkspaceRuntime,
} from "./workspace-manager-types.ts";
import {
  TELEGRAM_DEFAULT_WORKSPACE_NAME,
} from "./workspaces.ts";

export function installPrompt<TContext>(
  self: WsRuntimeContext<TContext>,
  deps: TelegramWorkspaceManagerDeps<TContext>,
): void {
  self.deliverPromptTurn = async (
    runtime: WorkspaceRuntime,
    turn: TelegramWorkspacePromptTurn,
    ctx: TContext,
    options: { wasRunning: boolean; replyOnSuccess?: boolean },
  ): Promise<void> => {
    const { wasRunning } = options;
    const replyOnSuccess = options.replyOnSuccess ?? true;
    const promptText = buildTelegramWorkspacePromptText(turn);
    if (!promptText) return;
    const promptNow = self.now();
    runtime.activeChatId = turn.chatId;
    runtime.activeMessageThreadId = turn.messageThreadId;
    runtime.activeReplyToMessageId = turn.replyToMessageId;
    runtime.activeTopicDelivery = self.isTopicBindingEnabled() &&
      (turn.messageThreadId !== undefined ||
        runtime.record.name === TELEGRAM_DEFAULT_WORKSPACE_NAME ||
        runtime.record.source?.kind === "telegram-topic");
    runtime.activeTurnId = `workspace:${runtime.record.name}:${turn.chatId}:${turn.messageThreadId ?? "general"}:${turn.replyToMessageId}:${promptNow}`;
    runtime.promptStartedAt = promptNow;
    runtime.promptSentAt = undefined;
    runtime.agentStartedAt = undefined;
    runtime.firstOutputAt = undefined;
    runtime.firstOutputLogged = false;
    runtime.record.lastUsedAt = promptNow;
    runtime.record.lastMessageText = promptText;
    runtime.record.lastMessageAt = promptNow;
    await self.persist();
    self.startWorkspaceTyping(runtime.record.name, runtime);
    try {
      deps.debugLogger?.log(
        "telegram.workspace.prompt.start",
        {
          ...self.getWorkspaceTurnDetails(runtime.record.name, runtime),
          wasRunning,
        },
        promptText,
      );
      const promptStartedAt = Date.now();
      const backend = await self.ensureBackend(runtime, ctx);
      if (wasRunning) {
        await backend.followUp(promptText);
      } else {
        await backend.prompt(promptText);
      }
      runtime.promptSentAt = self.now();
      deps.debugLogger?.log("telegram.workspace.prompt.sent", {
        ...self.getWorkspaceTurnDetails(runtime.record.name, runtime),
        elapsedMs: Date.now() - promptStartedAt,
        wasRunning,
      });
      runtime.record.status = "running";
      await self.persist();
      if (replyOnSuccess) {
        await self.sendTurnTextReply(
          turn,
          wasRunning
            ? `Queued follow-up in ${self.formatRuntimeUserScopeTarget(runtime, turn)}.`
            : self.formatRuntimeStartedMessage(runtime, turn),
        );
      }
    } catch (error) {
      deps.debugLogger?.log("telegram.workspace.prompt.error", {
        ...self.getWorkspaceTurnDetails(runtime.record.name, runtime),
        error: error instanceof Error ? error.message : String(error),
      });
      self.logWorkspaceTurnSummary(
        runtime.record.name,
        runtime,
        "error",
        error instanceof Error ? error.message : String(error),
      );
      self.stopWorkspaceTyping(runtime);
      runtime.record.status = "error";
      runtime.record.lastError = getErrorMessage(error);
      deps.recordRuntimeEvent?.("workspaces", error, {
        workspace: runtime.record.name,
        action: "prompt",
      });
      await self.persist();
      await self.sendTurnTextReply(
        turn,
        self.formatRuntimeFailureMessage(runtime, getErrorMessage(error), turn),
      );
    }
  };
  self.flushPendingCompactionTurns = async (
    runtime: WorkspaceRuntime,
    ctx: TContext,
  ): Promise<void> => {
    const pending = runtime.pendingCompactionTurns;
    if (!pending || pending.length === 0) return;
    runtime.pendingCompactionTurns = undefined;
    for (let index = 0; index < pending.length; index += 1) {
      const wasRunning = runtime.record.status === "running";
      await self.deliverPromptTurn(runtime, pending[index], ctx, { wasRunning });
    }
  };
  self.clearPendingCompactionTurns = (runtime: WorkspaceRuntime): number => {
    const count = runtime.pendingCompactionTurns?.length ?? 0;
    runtime.pendingCompactionTurns = undefined;
    return count;
  };
}
