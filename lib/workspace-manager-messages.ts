/**
 * Workspace runtime messages: scope formatters, worker capacity, replies and typing
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import {
  runWithTelegramThreadContext,
} from "./thread-context.ts";
import {
  canSwitchTelegramWorkspaceModel,
} from "./workspace-manager-state.ts";
import type {
  TelegramWorkspaceManagerDeps,
  TelegramWorkspacePromptTurn,
  WorkspaceRuntime,
} from "./workspace-manager-types.ts";
import {
  formatTelegramWorkspaceDisplayName,
  formatTelegramWorkspaceRecordDisplayName,
} from "./workspaces.ts";

export function installMessages<TContext>(
  self: WsRuntimeContext<TContext>,
  deps: TelegramWorkspaceManagerDeps<TContext>,
): void {
  self.formatRuntimeUserScopeTarget = (
    runtime: WorkspaceRuntime,
    turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">,
  ): string => {
    const forumNativeScope = self.getForumNativeRuntimeScope(runtime, turn);
    if (forumNativeScope) return `current ${forumNativeScope}`;
    return `workspace ${formatTelegramWorkspaceRecordDisplayName(runtime.record)}`;
  };
  self.formatRuntimeUserScopeTitle = (
    runtime: WorkspaceRuntime,
    turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">,
  ): string => {
    const target = self.formatRuntimeUserScopeTarget(runtime, turn);
    return `${target.charAt(0).toUpperCase()}${target.slice(1)}`;
  };
  self.formatRuntimeStartedMessage = (
    runtime: WorkspaceRuntime,
    turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">,
  ): string => {
    const forumNativeScope = self.getForumNativeRuntimeScope(runtime, turn);
    if (forumNativeScope) {
      return `Started run in ${self.formatRuntimeUserScopeTarget(runtime, turn)}.`;
    }
    return `Started ${self.formatRuntimeUserScopeTarget(runtime, turn)}.`;
  };
  self.formatRuntimeFailureMessage = (
    runtime: WorkspaceRuntime,
    errorMessage: string,
    turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">,
  ): string => `${self.formatRuntimeUserScopeTitle(runtime, turn)} failed: ${errorMessage}`;
  self.formatRuntimeFinishedNotice = (runtime: WorkspaceRuntime, workspaceName: string): string => {
    const forumNativeScope = self.getForumNativeRuntimeScope(runtime);
    if (forumNativeScope) {
      const title = forumNativeScope.charAt(0).toUpperCase() + forumNativeScope.slice(1);
      return `${title} finished. Open this ${forumNativeScope} to view the latest reply.`;
    }
    const displayName = formatTelegramWorkspaceDisplayName(workspaceName);
    return `Workspace ${displayName} finished. Use /workspace ${displayName} to view latest reply.`;
  };
  self.formatRuntimeBusyMessage = (
    runtime: WorkspaceRuntime,
    turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">,
  ): string => {
    const forumNativeScope = self.getForumNativeRuntimeScope(runtime, turn);
    if (forumNativeScope) {
      return `${self.formatRuntimeUserScopeTitle(runtime, turn)} is busy. Wait for it to go idle or send /stop first.`;
    }
    return `Workspace ${runtime.record.name} is busy. Wait for it to go idle or send /stop first.`;
  };
  self.formatRuntimeStopFirstMessage = (runtime: WorkspaceRuntime): string => {
    const forumNativeScope = self.getForumNativeRuntimeScope(runtime);
    if (forumNativeScope) {
      return `${self.formatRuntimeUserScopeTitle(runtime)} is busy. Send /stop first.`;
    }
    return `Workspace ${runtime.record.name} is busy. Send /stop first.`;
  };
  self.formatRuntimeAbortFirstMessage = (runtime: WorkspaceRuntime): string => {
    const forumNativeScope = self.getForumNativeRuntimeScope(runtime);
    if (forumNativeScope) {
      return `${self.formatRuntimeUserScopeTitle(runtime)} is busy. Send /abort first.`;
    }
    return `Workspace ${runtime.record.name} is busy. Send /workspace abort ${runtime.record.name} first.`;
  };
  self.formatScopedWorkspaceBusyMessage = (workspaceName: string): string => {
    if (self.isForumNativeMode()) {
      return "Current workspace is busy. Send /abort first.";
    }
    return `Workspace ${workspaceName} is busy. Send /workspace abort ${workspaceName} first.`;
  };
  self.formatRuntimeTreeBranchUnavailableMessage = (): string =>
    self.isForumNativeMode()
      ? "Current workspace tree branching is not configured."
      : "Active workspace tree branching is not configured.";
  self.formatRuntimeSessionBindFailureMessage = (
    workspaceName: string,
    sessionPath: string,
  ): string =>
    self.isForumNativeMode()
      ? `Current workspace did not bind to resumed session ${sessionPath}.`
      : `Workspace ${workspaceName} did not bind to resumed session ${sessionPath}.`;
  self.hasLiveWorker = (runtime: WorkspaceRuntime | undefined): boolean =>
    Boolean(runtime?.backend);
  self.getLiveWorkerCount = (): number =>
    [...self.workspaceRuntimes.values()].filter((runtime) => self.hasLiveWorker(runtime)).length;
  self.getConfiguredMaxWorkers = (): number =>
    self.isForumNativeMode()
      ? deps.getConfig().maxWorkspaces
      : deps.getConfig().maxWorkers ?? deps.getConfig().maxWorkspaces;
  self.formatWorkerCapacityReachedMessage = (maxWorkers: number): string =>
    self.isForumNativeMode()
      ? `Worker capacity reached (${maxWorkers}). Close another workspace before starting this one.`
      : `Worker capacity reached (${maxWorkers}). Wait for another workspace to finish or close one before starting this one.`;
  self.getIdleLiveWorkerStopCandidates = (
    targetWorkspaceRuntime: WorkspaceRuntime,
  ): WorkspaceRuntime[] =>
    [...self.workspaceRuntimes.values()]
      .filter(
        (runtime) =>
          runtime !== targetWorkspaceRuntime &&
          self.hasLiveWorker(runtime) &&
          runtime.closing !== true,
      )
      .sort((a, b) => a.record.lastUsedAt - b.record.lastUsedAt);
  self.stopIdleLiveWorkerForCapacity = async (
    targetWorkspaceRuntime: WorkspaceRuntime,
    maxWorkers: number,
  ): Promise<boolean> => {
    const skipped = new Set<WorkspaceRuntime>();
    while (self.getLiveWorkerCount() >= maxWorkers) {
      const candidate = self.getIdleLiveWorkerStopCandidates(targetWorkspaceRuntime).find(
        (runtime) => !skipped.has(runtime),
      );
      if (!candidate) return false;
      await self.refreshRuntimeState(candidate);
      if (!self.hasLiveWorker(candidate)) continue;
      if (!canSwitchTelegramWorkspaceModel(candidate.record)) {
        skipped.add(candidate);
        continue;
      }
      deps.debugLogger?.log("telegram.workspace.worker.capacity.stop", {
        workspace: candidate.record.name,
        reason: "worker_capacity",
        maxWorkers,
      });
      await self.disposeRuntimeBackend(candidate);
      await self.persist();
    }
    return true;
  };
  self.ensureWorkerCapacity = async (runtime: WorkspaceRuntime): Promise<void> => {
    if (self.hasLiveWorker(runtime)) return;
    const maxWorkers = self.getConfiguredMaxWorkers();
    if (self.getLiveWorkerCount() < maxWorkers) return;
    if (!self.isForumNativeMode() && await self.stopIdleLiveWorkerForCapacity(runtime, maxWorkers)) {
      return;
    }
    throw new Error(self.formatWorkerCapacityReachedMessage(maxWorkers));
  };
  self.runInWorkspaceThreadContext = <T>(runtime: WorkspaceRuntime, fn: () => T): T => {
    if (runtime.activeChatId === undefined) return fn();
    return runWithTelegramThreadContext(
      {
        chatId: runtime.activeChatId,
        messageThreadId: runtime.activeMessageThreadId,
      },
      fn,
    );
  };
  self.sendTurnTextReply = (
    turn: TelegramWorkspacePromptTurn,
    text: string,
  ): Promise<number | undefined> =>
    runWithTelegramThreadContext(
      { chatId: turn.chatId, messageThreadId: turn.messageThreadId },
      () => deps.sendTextReply(turn.chatId, turn.replyToMessageId, text),
    );
  self.sendWorkspaceReply = (
    chatId: number | undefined,
    replyToMessageId: number | undefined,
    text: string,
  ): Promise<number | undefined> => {
    if (chatId === undefined || replyToMessageId === undefined) {
      return Promise.resolve(undefined);
    }
    return deps.sendTextReply(chatId, replyToMessageId, text);
  };
  self.sendWorkspaceMarkdownReply = (
    chatId: number | undefined,
    replyToMessageId: number | undefined,
    markdown: string,
  ): Promise<number | undefined> => {
    if (chatId === undefined) return Promise.resolve(undefined);
    return deps.sendMarkdownReply
      ? deps.sendMarkdownReply(chatId, replyToMessageId, markdown)
      : deps.sendTextReply(chatId, replyToMessageId, markdown);
  };
  self.sendWorkspaceStreamMarkdownReply = (
    chatId: number | undefined,
    replyToMessageId: number | undefined,
    markdown: string,
  ): Promise<number | undefined> => {
    if (chatId === undefined) return Promise.resolve(undefined);
    return deps.sendStreamMarkdownReply
      ? deps.sendStreamMarkdownReply(chatId, replyToMessageId, markdown)
      : self.sendWorkspaceMarkdownReply(chatId, replyToMessageId, markdown);
  };
  self.editWorkspaceStreamMarkdownMessage = (
    chatId: number | undefined,
    messageId: number | undefined,
    markdown: string,
  ): Promise<number | undefined> => {
    if (
      chatId === undefined ||
      messageId === undefined ||
      !deps.editStreamMarkdownMessage
    ) {
      return Promise.resolve(undefined);
    }
    return deps.editStreamMarkdownMessage(chatId, messageId, markdown);
  };
  self.stopWorkspaceTyping = (runtime: WorkspaceRuntime): void => {
    if (runtime.typingInterval) {
      clearInterval(runtime.typingInterval);
      runtime.typingInterval = undefined;
    }
    runtime.typingChatId = undefined;
    runtime.typingMessageThreadId = undefined;
  };
  self.stopOtherWorkspaceTyping = (workspaceName: string): void => {
    for (const [name, runtime] of self.workspaceRuntimes.entries()) {
      if (name !== workspaceName) self.stopWorkspaceTyping(runtime);
    }
  };
  self.startWorkspaceTyping = (workspaceName: string, runtime: WorkspaceRuntime): void => {
    const chatId = runtime.activeChatId;
    if (!deps.sendTypingAction || chatId === undefined || chatId === 0) return;
    if (!self.isTopicDeliveryActive(runtime)) self.stopOtherWorkspaceTyping(workspaceName);
    if (
      runtime.typingInterval &&
      runtime.typingChatId === chatId &&
      runtime.typingMessageThreadId === runtime.activeMessageThreadId
    ) {
      return;
    }
    self.stopWorkspaceTyping(runtime);
    const sendTyping = (): void => {
      void Promise.resolve(
        self.runInWorkspaceThreadContext(runtime, () => deps.sendTypingAction!(chatId)),
      ).catch((error) => {
        deps.recordRuntimeEvent?.("typing", error, {
          workspace: runtime.record.name,
          chatId,
          messageThreadId: runtime.activeMessageThreadId,
        });
      });
    };
    runtime.typingChatId = chatId;
    runtime.typingMessageThreadId = runtime.activeMessageThreadId;
    sendTyping();
    runtime.typingInterval = setInterval(sendTyping, self.typingIntervalMs);
  };
}
