/**
 * Workspace dashboard send/edit, worker-state summaries, runtime close
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import {
  TELEGRAM_FORUM_NATIVE_WORKSPACE_LIFECYCLE_DISABLED_MESSAGE,
} from "./workspace-manager-constants.ts";
import {
  buildTelegramWorkspaceDashboardReplyMarkup,
  formatTelegramWorkspaceDashboardSummary,
  normalizeTelegramWorkspaceCloseSelection,
} from "./workspace-manager-dashboard.ts";
import {
  getSortedTelegramWorkspaceRecords,
} from "./workspace-manager-state.ts";
import type {
  TelegramWorkspaceDashboardMode,
  TelegramWorkspaceDashboardWorkerState,
  TelegramWorkspaceManagerDeps,
  WorkspaceRuntime,
} from "./workspace-manager-types.ts";
import {
  TELEGRAM_DEFAULT_WORKSPACE_NAME,
  filterTelegramWorkspaceRecords,
  formatTelegramWorkspaceDisplayName,
  formatTelegramWorkspaceList,
} from "./workspaces.ts";
import type {
  TelegramWorkspacesState,
} from "./workspaces.ts";

export function installDashboardRuntime<TContext>(
  self: WsRuntimeContext<TContext>,
  deps: TelegramWorkspaceManagerDeps<TContext>,
): void {
  self.replyDisabled = (
    chatId: number,
    replyToMessageId: number,
  ): Promise<number | undefined> =>
    deps.sendTextReply(
      chatId,
      replyToMessageId,
      "Concurrent workspaces are disabled. Set concurrentWorkspaces.enabled to true in telegram.json to use /workspace.",
    );
  self.getUnreadByWorkspace = (): Record<string, number> =>
    Object.fromEntries(
      [...self.workspaceRuntimes.entries()].map(([name, runtime]) => [
        name,
        runtime.unreadEvents,
      ]),
    );
  self.getDashboardWorkerState = (
    runtime: WorkspaceRuntime | undefined,
  ): TelegramWorkspaceDashboardWorkerState => {
    if (!self.hasLiveWorker(runtime)) return "not-started";
    return runtime?.record.status === "running" || runtime?.record.status === "starting"
      ? "running"
      : "idle";
  };
  self.getDashboardWorkerStateByWorkspace = (
    workspaceState: TelegramWorkspacesState,
  ): Record<string, TelegramWorkspaceDashboardWorkerState> =>
    Object.fromEntries(
      Object.keys(workspaceState.workspaces).map((name) => [
        name,
        self.getDashboardWorkerState(self.workspaceRuntimes.get(name)),
      ]),
    );
  self.sendForumNativeLifecycleDisabledReply = (
    chatId: number,
    replyToMessageId: number,
  ): Promise<number | undefined> =>
    deps.sendTextReply(
      chatId,
      replyToMessageId,
      TELEGRAM_FORUM_NATIVE_WORKSPACE_LIFECYCLE_DISABLED_MESSAGE,
    );
  self.sendWorkspaceDashboard = async (
    workspaceState: TelegramWorkspacesState,
    chatId: number,
    replyToMessageId: number,
    filters: readonly string[] = [],
  ): Promise<void> => {
    await self.refreshDashboardWorkspaceRecords(workspaceState);
    const unreadByWorkspace = self.getUnreadByWorkspace();
    const workerStateByWorkspace = self.getDashboardWorkerStateByWorkspace(workspaceState);
    const forumNativeMode = self.isForumNativeMode();
    const filterResult = filterTelegramWorkspaceRecords(
      getSortedTelegramWorkspaceRecords(workspaceState),
      filters,
    );
    const visibleWorkspaces = filterResult.trace.length > 0
      ? filterResult.workspaces
      : undefined;
    if (!deps.sendInteractiveMessage) {
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        formatTelegramWorkspaceList(workspaceState, unreadByWorkspace, self.now(), {
          workspaces: visibleWorkspaces,
          title: "Workspaces",
          emptyText: "No workspaces match filters.",
          filterTrace: filterResult.trace,
        }),
      );
      return;
    }
    const messageId = await deps.sendInteractiveMessage(
      chatId,
      formatTelegramWorkspaceDashboardSummary(
        workspaceState,
        unreadByWorkspace,
        deps.getConfig().maxWorkspaces,
        self.now(),
        "open",
        [],
        visibleWorkspaces,
        filterResult.trace,
        forumNativeMode,
        { live: self.getLiveWorkerCount(), max: self.getConfiguredMaxWorkers() },
        workerStateByWorkspace,
      ),
      "plain",
      buildTelegramWorkspaceDashboardReplyMarkup(
        workspaceState,
        unreadByWorkspace,
        "open",
        [],
        visibleWorkspaces,
        forumNativeMode,
      ),
    );
    if (messageId !== undefined) {
      self.setDashboardState({
        chatId,
        messageId,
        mode: "open",
        selectedCloseWorkspaces: [],
        updatedAt: self.now(),
      });
    }
  };
  self.editWorkspaceDashboard = async (
    workspaceState: TelegramWorkspacesState,
    chatId: number,
    messageId: number,
    options: {
      mode?: TelegramWorkspaceDashboardMode;
      selectedCloseWorkspaces?: readonly string[];
    } = {},
  ): Promise<void> => {
    await self.refreshDashboardWorkspaceRecords(workspaceState);
    const unreadByWorkspace = self.getUnreadByWorkspace();
    const workerStateByWorkspace = self.getDashboardWorkerStateByWorkspace(workspaceState);
    const existingState = self.getDashboardState(messageId);
    const forumNativeMode = self.isForumNativeMode();
    const mode = forumNativeMode ? "open" : options.mode ?? existingState?.mode ?? "open";
    const selectedCloseWorkspaces = normalizeTelegramWorkspaceCloseSelection(
      workspaceState,
      options.selectedCloseWorkspaces ?? existingState?.selectedCloseWorkspaces ?? [],
    );
    if (!deps.editInteractiveMessage) return;
    await deps.editInteractiveMessage(
      chatId,
      messageId,
      formatTelegramWorkspaceDashboardSummary(
        workspaceState,
        unreadByWorkspace,
        deps.getConfig().maxWorkspaces,
        self.now(),
        mode,
        selectedCloseWorkspaces,
        undefined,
        [],
        forumNativeMode,
        { live: self.getLiveWorkerCount(), max: self.getConfiguredMaxWorkers() },
        workerStateByWorkspace,
      ),
      "plain",
      buildTelegramWorkspaceDashboardReplyMarkup(
        workspaceState,
        unreadByWorkspace,
        mode,
        selectedCloseWorkspaces,
        undefined,
        forumNativeMode,
      ),
    );
    self.setDashboardState({
      chatId,
      messageId,
      mode,
      selectedCloseWorkspaces,
      updatedAt: self.now(),
    });
  };
  self.answerWorkspaceCallback = (
    callbackQueryId: string,
    text?: string,
  ): Promise<void> =>
    deps.answerCallbackQuery
      ? deps.answerCallbackQuery(callbackQueryId, text)
      : Promise.resolve();
  self.closeWorkspaceRuntime = async (
    workspaceState: TelegramWorkspacesState,
    name: string,
    force: boolean,
  ): Promise<{ closed: boolean; message: string }> => {
    if (name === TELEGRAM_DEFAULT_WORKSPACE_NAME) {
      return { closed: false, message: "Cannot close General." };
    }
    const runtime = self.getWorkspaceRuntime(workspaceState, name);
    if (!runtime) {
      return { closed: false, message: `Unknown workspace: ${formatTelegramWorkspaceDisplayName(name)}` };
    }
    if (runtime.record.status === "running" && !force) {
      return {
        closed: false,
        message: `Workspace ${formatTelegramWorkspaceDisplayName(name)} is running. Use /workspace close ${formatTelegramWorkspaceDisplayName(name)} --force to close it.`,
      };
    }
    await self.disposeClosingRuntimeBackend(runtime);
    self.workspaceRuntimes.delete(name);
    delete workspaceState.workspaces[name];
    if (workspaceState.activeWorkspace === name) workspaceState.activeWorkspace = TELEGRAM_DEFAULT_WORKSPACE_NAME;
    return { closed: true, message: `Closed workspace ${formatTelegramWorkspaceDisplayName(name)}.` };
  };
}
