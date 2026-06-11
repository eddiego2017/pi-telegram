/**
 * Workspace manager Ralph controller: parent-side autonomous loop per forum topic
 * Zones: telegram controls, pi agent, orchestration
 * Installs the /ralph command handler and the agent_end marker hook. Children
 * run with --no-extensions, so the loop protocol is text markers (see
 * ralph-workspace.ts); the parent performs every fresh-session handoff over
 * the child's existing RPC backend (newSession + rename + prompt). The parent
 * never resets itself: /ralph is rejected outside a bound topic runtime.
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import {
  buildRalphArmDialoguePrompt,
  buildRalphIterationPrompt,
  buildRalphWorkspaceState,
  createRalphStateStore,
  decideRalphNext,
  formatRalphStatus,
  getTelegramRalphStatePath,
  parseRalphCommand,
  parseRalphMarker,
  ralphSessionName,
} from "./ralph-workspace.ts";
import type {
  RalphStateStore,
  RalphWorkspaceState,
} from "./ralph-workspace.ts";
import {
  resetRuntimeTurnBuffers,
} from "./workspace-manager-events.ts";
import {
  applyRpcStateToRecord,
  getErrorMessage,
} from "./workspace-manager-state.ts";
import type {
  TelegramWorkspaceManager,
  TelegramWorkspaceManagerDeps,
  WorkspaceRuntime,
} from "./workspace-manager-types.ts";

export const RALPH_TICK_DELAY_MS = 250;

export const RALPH_TOPIC_ONLY_MESSAGE =
  "Ralph loops can only run inside a bound forum topic (the parent session never resets itself). Run /ralph in the target topic.";

export interface RalphInstallOptions {
  store?: RalphStateStore;
  tickDelayMs?: number;
}

export function installRalph<TContext>(
  self: WsRuntimeContext<TContext>,
  deps: TelegramWorkspaceManagerDeps<TContext>,
  options: RalphInstallOptions = {},
): Pick<TelegramWorkspaceManager<TContext>, "handleRalphCommand"> {
  const store =
    options.store ?? createRalphStateStore(getTelegramRalphStatePath(self.agentDir));
  const tickDelayMs = options.tickDelayMs ?? RALPH_TICK_DELAY_MS;

  const notify = (
    runtime: WorkspaceRuntime,
    state: RalphWorkspaceState | undefined,
    text: string,
  ): void => {
    const chatId = state?.chatId ?? runtime.activeChatId;
    const replyToMessageId = state?.replyToMessageId ?? runtime.activeReplyToMessageId;
    void self.runInWorkspaceThreadContext(runtime, () =>
      self.sendWorkspaceReply(chatId, replyToMessageId, text),
    ).catch?.(() => undefined);
  };

  const stopLoop = (
    workspaceName: string,
    runtime: WorkspaceRuntime,
    state: RalphWorkspaceState,
    message: string,
  ): void => {
    store.write(workspaceName, { ...state, active: false });
    notify(runtime, state, message);
  };

  const runTick = async (
    workspaceName: string,
    runtime: WorkspaceRuntime,
  ): Promise<void> => {
    const state = store.read(workspaceName);
    if (!state?.active) return;
    const backend = runtime.backend;
    if (!backend) {
      stopLoop(
        workspaceName,
        runtime,
        state,
        "Ralph loop stopped: the topic worker is no longer running.",
      );
      return;
    }
    const nextName = ralphSessionName(state.baseName, state.loop);
    try {
      const result = await backend.newSession();
      if (result.cancelled) {
        stopLoop(
          workspaceName,
          runtime,
          state,
          "Ralph loop stopped: fresh session handoff was cancelled.",
        );
        return;
      }
      await backend.setSessionName(nextName);
      const childState = await backend.getState();
      applyRpcStateToRecord(runtime.record, childState);
      runtime.record.sessionName = nextName;
      runtime.record.lastAssistantText = undefined;
      runtime.record.lastMessageText = undefined;
      runtime.record.lastMessageAt = undefined;
      runtime.record.lastAgentStartAt = undefined;
      runtime.record.lastAgentEndAt = undefined;
      runtime.record.lastError = undefined;
      resetRuntimeTurnBuffers(runtime);
      runtime.activeChatId = state.chatId ?? runtime.activeChatId;
      runtime.activeMessageThreadId = state.messageThreadId;
      runtime.activeReplyToMessageId = state.replyToMessageId ?? runtime.activeReplyToMessageId;
      runtime.activeTopicDelivery =
        self.isTopicBindingEnabled() &&
        (state.messageThreadId !== undefined ||
          runtime.record.source?.kind === "telegram-topic");
      const turnId = `ralph:${workspaceName}:loop${state.loop}:${self.now()}`;
      runtime.activeTurnId = turnId;
      store.write(workspaceName, { ...state, expectedTurnId: turnId });
      const prompt = buildRalphIterationPrompt(state);
      runtime.record.status = "running";
      runtime.record.lastUsedAt = self.now();
      runtime.record.lastMessageText = prompt;
      runtime.record.lastMessageAt = self.now();
      await self.persist();
      self.startWorkspaceTyping(workspaceName, runtime);
      deps.debugLogger?.log("telegram.ralph.tick", {
        workspace: workspaceName,
        loop: state.loop,
        sessionName: nextName,
        turnId,
      });
      await backend.prompt(prompt);
    } catch (error) {
      deps.recordRuntimeEvent?.("ralph", error, {
        workspace: workspaceName,
        action: "tick",
        loop: state.loop,
      });
      runtime.record.status = "error";
      runtime.record.lastError = getErrorMessage(error);
      self.stopWorkspaceTyping(runtime);
      await self.persist();
      stopLoop(
        workspaceName,
        runtime,
        state,
        `Ralph loop stopped: handoff failed (${getErrorMessage(error)}).`,
      );
    }
  };

  const scheduleTick = (workspaceName: string, runtime: WorkspaceRuntime): void => {
    setTimeout(() => {
      void runTick(workspaceName, runtime);
    }, tickDelayMs);
  };

  self.handleRalphAgentEnd = (
    workspaceName: string,
    runtime: WorkspaceRuntime,
    finalText: string,
    stopReason: "ok" | "error" | "aborted",
  ): void => {
    const state = store.read(workspaceName);
    const isExpectedRalphTurn =
      state?.active === true &&
      state.expectedTurnId !== undefined &&
      runtime.activeTurnId === state.expectedTurnId;
    if (stopReason !== "ok") {
      if (isExpectedRalphTurn && state) {
        stopLoop(
          workspaceName,
          runtime,
          state,
          `Ralph loop stopped after ${state.loop + 1} iteration(s): the iteration ${stopReason === "aborted" ? "was aborted" : "ended with an error"}. Use /ralph in this topic to start again.`,
        );
      }
      return;
    }
    const marker = parseRalphMarker(finalText);
    if (marker?.kind === "arm" || marker?.kind === "arm-invalid") {
      if (state?.active) {
        notify(
          runtime,
          state,
          "A Ralph loop is already active in this topic; ignoring RALPH-ARM. Use /ralph stop first.",
        );
        return;
      }
      if (marker.kind === "arm-invalid") {
        notify(runtime, state, `Ralph arm rejected: ${marker.error}`);
        return;
      }
      const armed = buildRalphWorkspaceState({
        spec: marker.spec,
        baseName: runtime.record.sessionName,
        now: self.now(),
        chatId: runtime.activeChatId,
        messageThreadId: runtime.activeMessageThreadId,
        replyToMessageId: runtime.activeReplyToMessageId,
      });
      store.write(workspaceName, armed);
      deps.debugLogger?.log("telegram.ralph.armed", {
        workspace: workspaceName,
        baseName: armed.baseName,
        exitCondition: armed.exitCondition,
      });
      notify(
        runtime,
        armed,
        [
          "Ralph loop armed.",
          `Exit condition: ${armed.exitCondition}`,
          `Iteration #1 starts now in a fresh session (${ralphSessionName(armed.baseName, 0)}); ceiling ${armed.maxIterations} iterations. /ralph stop to stop.`,
        ].join("\n"),
      );
      scheduleTick(workspaceName, runtime);
      return;
    }
    if (!isExpectedRalphTurn || !state) return;
    if (!marker) {
      stopLoop(
        workspaceName,
        runtime,
        state,
        `Ralph loop stopped after ${state.loop + 1} iteration(s): the iteration ended without a RALPH marker (stalled).`,
      );
      return;
    }
    const decision = decideRalphNext(state, { done: marker.done, note: marker.note });
    if (decision.kind === "done") {
      const reason =
        decision.reason === "max_iterations"
          ? `safety ceiling of ${state.maxIterations} iterations reached`
          : "exit condition met";
      store.write(workspaceName, {
        ...state,
        active: false,
        lastNote: marker.note ?? state.lastNote,
      });
      deps.debugLogger?.log("telegram.ralph.done", {
        workspace: workspaceName,
        iterations: decision.iterations,
        reason: decision.reason,
      });
      notify(
        runtime,
        state,
        `Ralph loop finished after ${decision.iterations} iteration(s): ${reason}.`,
      );
      return;
    }
    store.write(workspaceName, decision.state);
    deps.debugLogger?.log("telegram.ralph.continue", {
      workspace: workspaceName,
      nextLoop: decision.state.loop,
      nextName: decision.nextName,
    });
    scheduleTick(workspaceName, runtime);
  };

  return {
    handleRalphCommand: async (args, chatId, replyToMessageId, ctx) => {
      if (!self.isEnabled()) {
        await self.replyDisabled(chatId, replyToMessageId);
        return true;
      }
      const workspaceState = await self.ensureState(deps.getCwd(ctx));
      const scoped = await self.resolveScopedTopicRuntime(workspaceState, ctx);
      if (!scoped.scoped || !scoped.runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, RALPH_TOPIC_ONLY_MESSAGE);
        return true;
      }
      const runtime = scoped.runtime;
      const workspaceName = runtime.record.name;
      const request = parseRalphCommand(args);
      if (request.kind === "status") {
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          formatRalphStatus(store.read(workspaceName)),
        );
        return true;
      }
      if (request.kind === "stop") {
        const state = store.read(workspaceName);
        if (!state?.active) {
          await deps.sendTextReply(chatId, replyToMessageId, "No active Ralph loop in this topic.");
          return true;
        }
        store.write(workspaceName, { ...state, active: false });
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Ralph loop stopped after ${state.loop + 1} iteration(s). A running iteration may still finish; it will not hand off.`,
        );
        return true;
      }
      const existing = store.read(workspaceName);
      if (existing?.active) {
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          "A Ralph loop is already active in this topic. Use /ralph status or /ralph stop.",
        );
        return true;
      }
      try {
        await self.refreshRuntimeState(runtime);
      } catch (error) {
        await deps.sendTextReply(chatId, replyToMessageId, getErrorMessage(error));
        return true;
      }
      const wasRunning = runtime.record.status === "running";
      await self.deliverPromptTurn(
        runtime,
        {
          chatId,
          messageThreadId:
            runtime.record.source?.kind === "telegram-topic"
              ? runtime.record.source.messageThreadId
              : undefined,
          replyToMessageId,
          content: [
            { type: "text", text: buildRalphArmDialoguePrompt(request.initialTask) },
          ],
        },
        ctx,
        { wasRunning, replyOnSuccess: false },
      );
      return true;
    },
  };
}
