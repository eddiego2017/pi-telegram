/**
 * Workspace runtime core: shared state, config flags, runtime lookup, persistence
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import {
  getTelegramAgentDir,
  isTelegramTrustedChat,
} from "./config.ts";
import {
  getAmbientTelegramThreadContext,
} from "./thread-context.ts";
import {
  TELEGRAM_WORKSPACE_DASHBOARD_STATE_TTL_MS,
  TELEGRAM_WORKSPACE_STREAM_EDIT_THROTTLE_MS,
  TELEGRAM_WORKSPACE_STREAM_FAILURE_BASE_RETRY_MS,
  TELEGRAM_WORKSPACE_STREAM_FAILURE_MAX_RETRY_MS,
  TELEGRAM_WORKSPACE_TYPING_ACTION_INTERVAL_MS,
  getTelegramWorkspaceBooleanEnv,
  getTelegramWorkspaceToolPreviewMode,
} from "./workspace-manager-constants.ts";
import {
  createWorkspaceRuntime,
} from "./workspace-manager-events.ts";
import {
  getTelegramTopicSessionName,
  getTelegramWorkspacesStatePath,
  readTelegramWorkspacesState,
  readTelegramWorkspacesStateSync,
  writeTelegramWorkspacesState,
} from "./workspace-manager-state.ts";
import type {
  TelegramWorkspaceDashboardState,
  TelegramWorkspaceManagerDeps,
  TelegramWorkspacePromptTurn,
  WorkspaceRuntime,
} from "./workspace-manager-types.ts";
import type {
  TelegramWorkspacesState,
} from "./workspaces.ts";

export function installRuntimeCore<TContext>(
  self: WsRuntimeContext<TContext>,
  deps: TelegramWorkspaceManagerDeps<TContext>,
): void {
  self.agentDir = deps.agentDir ?? getTelegramAgentDir();
  self.statePath = deps.statePath ?? getTelegramWorkspacesStatePath(self.agentDir);
  self.configuredSessionDir = deps.sessionDir;
  self.workspaceRuntimes = new Map<string, WorkspaceRuntime>();
  self.dashboardStates = new Map<number, TelegramWorkspaceDashboardState>();
  self.state = undefined;
  self.persistChain = Promise.resolve();

  self.now = (): number => deps.now?.() ?? Date.now();
  self.isEnabled = (): boolean => deps.getConfig().enabled;
  self.streamEditThrottleMs =
    deps.streamEditThrottleMs ?? TELEGRAM_WORKSPACE_STREAM_EDIT_THROTTLE_MS;
  self.streamFailureBaseRetryMs =
    deps.streamFailureBaseRetryMs ?? TELEGRAM_WORKSPACE_STREAM_FAILURE_BASE_RETRY_MS;
  self.streamFailureMaxRetryMs =
    deps.streamFailureMaxRetryMs ?? TELEGRAM_WORKSPACE_STREAM_FAILURE_MAX_RETRY_MS;
  self.typingIntervalMs =
    deps.typingIntervalMs ?? TELEGRAM_WORKSPACE_TYPING_ACTION_INTERVAL_MS;
  self.thinkingStreamPreviewsEnabled = getTelegramWorkspaceBooleanEnv(
    "PI_TELEGRAM_THINKING_PREVIEWS",
    true,
  );
  self.toolCallPreviewMode = getTelegramWorkspaceToolPreviewMode();
  self.toolCallCompactPreviewsEnabled = self.toolCallPreviewMode === "compact";
  self.toolCallStreamPreviewsEnabled = self.toolCallPreviewMode === "stream";
  self.pruneDashboardStates = (): void => {
    const cutoff = self.now() - TELEGRAM_WORKSPACE_DASHBOARD_STATE_TTL_MS;
    for (const [messageId, dashboardState] of self.dashboardStates.entries()) {
      if (dashboardState.updatedAt < cutoff) self.dashboardStates.delete(messageId);
    }
  };
  self.getDashboardState = (
    messageId: number,
  ): TelegramWorkspaceDashboardState | undefined => {
    self.pruneDashboardStates();
    return self.dashboardStates.get(messageId);
  };
  self.setDashboardState = (dashboardState: TelegramWorkspaceDashboardState): void => {
    self.pruneDashboardStates();
    self.dashboardStates.set(dashboardState.messageId, dashboardState);
  };
  self.persist = (): Promise<void> => {
    if (!self.state) return Promise.resolve();
    const snapshot = self.state;
    self.persistChain = self.persistChain.then(() =>
      writeTelegramWorkspacesState(self.statePath, snapshot),
    );
    return self.persistChain;
  };
  self.hydrateWorkspaceRuntimes = (workspaceState: TelegramWorkspacesState): void => {
    for (const record of Object.values(workspaceState.workspaces)) {
      const topicSessionName = getTelegramTopicSessionName(record);
      if (topicSessionName && !record.sessionName) {
        record.sessionName = topicSessionName;
      }
      if (!self.workspaceRuntimes.has(record.name)) {
        self.workspaceRuntimes.set(record.name, createWorkspaceRuntime(record));
      }
    }
  };
  self.ensureState = async (cwd: string): Promise<TelegramWorkspacesState> => {
    if (!self.state) {
      self.state = await readTelegramWorkspacesState(self.statePath, cwd, self.now());
      self.hydrateWorkspaceRuntimes(self.state);
      await self.persist();
    }
    return self.state;
  };
  self.ensureStateSync = (cwd: string): TelegramWorkspacesState => {
    if (!self.state) {
      self.state = readTelegramWorkspacesStateSync(self.statePath, cwd, self.now());
      self.hydrateWorkspaceRuntimes(self.state);
      void self.persist();
    }
    return self.state;
  };
  self.getWorkspaceRuntime = (
    workspaceState: TelegramWorkspacesState,
    name: string,
  ): WorkspaceRuntime | undefined => {
    const record = workspaceState.workspaces[name];
    if (!record) return undefined;
    let runtime = self.workspaceRuntimes.get(name);
    if (!runtime) {
      runtime = createWorkspaceRuntime(record);
      self.workspaceRuntimes.set(name, runtime);
    }
    runtime.record = record;
    return runtime;
  };
  self.getTopicBindingConfig = () => deps.getConfig().topicBinding;
  self.isTopicBindingEnabled = (): boolean =>
    self.isEnabled() && self.getTopicBindingConfig()?.enabled === true;
  self.isForumNativeMode = (): boolean => self.isTopicBindingEnabled() &&
    self.getTopicBindingConfig()?.native === true;
  self.isTrustedTopicBindingChat = (chatId: unknown): boolean =>
    isTelegramTrustedChat(self.getTopicBindingConfig()?.trustedChatIds, chatId);
  self.isTopicDeliveryActive = (runtime: WorkspaceRuntime): boolean =>
    runtime.activeTopicDelivery === true;
  self.isRuntimeDeliveryActive = (
    workspaceState: TelegramWorkspacesState,
    workspaceName: string,
    runtime: WorkspaceRuntime,
  ): boolean => self.isTopicDeliveryActive(runtime) || workspaceState.activeWorkspace === workspaceName;
  self.isTelegramForumChatId = (chatId: number | undefined): boolean =>
    typeof chatId === "number" && chatId < 0;
  self.getForumNativeRuntimeScope = (
    runtime: WorkspaceRuntime,
    turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">,
  ): "topic" | "workspace" | undefined => {
    if (!self.isForumNativeMode()) return undefined;
    const ambientThread = getAmbientTelegramThreadContext();
    const chatId = runtime.activeChatId ?? turn?.chatId ?? ambientThread?.chatId;
    const messageThreadId = runtime.activeMessageThreadId ??
      turn?.messageThreadId ??
      ambientThread?.messageThreadId;
    if (
      messageThreadId !== undefined ||
      runtime.record.source?.kind === "telegram-topic" ||
      self.isTelegramForumChatId(chatId)
    ) {
      return "topic";
    }
    return "workspace";
  };
}
