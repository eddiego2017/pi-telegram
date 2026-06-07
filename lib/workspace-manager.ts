/**
 * Telegram workspace runtime
 * Zones: telegram controls, pi agent, process lifecycle
 * Owns durable workspace registry loading, per-workspace RPC backend orchestration, and text-first Telegram delivery
 *
 * This module is the runtime entry point (createTelegramWorkspaceManager). Pure
 * helpers, types, formatters, and port factories live in sibling
 * workspace-manager-*.ts modules and are re-exported here for compatibility.
 */

import { unlink } from "node:fs/promises";

import {
  extractRpcTextDelta,
  RpcChildBackend,
  type RpcChildBackendEvent,
  type RpcChildSessionState,
} from "./rpc-child.ts";
import {
  extractLatestAssistantMessageText,
  formatAgentToolCallBlock,
  getAgentMessageBodyText,
  getAgentMessagePreviewText,
  isAssistantAgentMessage,
} from "./replies.ts";
import {
  filterTelegramWorkspaceRecords,
  findTelegramWorkspaceByTopic,
  findTelegramWorkspaceNameCaseConflict,
  formatTelegramWorkspaceDisplayName,
  formatTelegramWorkspaceList,
  formatTelegramWorkspaceRecordDisplayName,
  formatTelegramWorkspaceStatus,
  formatTelegramWorkspaceStatusLabel,
  formatTelegramWorkspaceUsage,
  normalizeTelegramWorkspaceName,
  normalizeTelegramTopicWorkspaceName,
  parseTelegramWorkspaceCommand,
  TELEGRAM_DEFAULT_WORKSPACE_NAME,
  truncateTelegramWorkspaceText,
  validateTelegramWorkspaceName,
  type TelegramWorkspaceRecord,
  type TelegramWorkspaceSourceTelegramTopic,
  type TelegramWorkspacesState,
} from "./workspaces.ts";
import { isTelegramForumTopicPermissionError } from "./api.ts";
import { isThinkingLevel, type ThinkingLevel } from "./model.ts";
import { getTelegramAgentDir, isTelegramTrustedChat } from "./config.ts";
import {
  isSameTelegramTopicOrphanTarget,
  type TelegramTopicOrphanProof,
} from "./topic-orphans.ts";
import {
  getAmbientTelegramThreadContext,
  getTelegramForumTopicMessageThreadId,
  normalizeTelegramForumThread,
  runWithTelegramThreadContext,
} from "./thread-context.ts";

import {
  getTelegramWorkspaceBooleanEnv,
  getTelegramWorkspaceToolPreviewMode,
  truncateTelegramWorkspaceStreamMarkdown,
  TELEGRAM_FORUM_NATIVE_WORKSPACE_LIFECYCLE_DISABLED_MESSAGE,
  TELEGRAM_WORKSPACE_DASHBOARD_STATE_TTL_MS,
  TELEGRAM_WORKSPACE_STREAM_EDIT_THROTTLE_MS,
  TELEGRAM_WORKSPACE_STREAM_FAILURE_BASE_RETRY_MS,
  TELEGRAM_WORKSPACE_STREAM_FAILURE_MAX_RETRY_MS,
  TELEGRAM_WORKSPACE_TYPING_ACTION_INTERVAL_MS,
} from "./workspace-manager-constants.ts";
import type {
  TelegramWorkspaceAbortResult,
  TelegramWorkspaceBackend,
  TelegramWorkspaceCallbackQuery,
  TelegramWorkspaceDashboardMode,
  TelegramWorkspaceDashboardState,
  TelegramWorkspaceDashboardWorkerState,
  TelegramWorkspaceForumTopicServiceMessage,
  TelegramWorkspaceManager,
  TelegramWorkspaceManagerDeps,
  TelegramWorkspacePromptTurn,
  TelegramWorkspaceSessionIdentity,
  TelegramWorkspaceStreamDeliveryResult,
  TelegramWorkspaceStreamState,
  TelegramWorkspaceToolStatusKind,
  WorkspaceRuntime,
} from "./workspace-manager-types.ts";
import {
  applyRpcStateToRecord,
  buildTelegramWorkspacePromptText,
  buildTelegramWorkspaceWorkerExtensionArgs,
  canSwitchTelegramWorkspaceModel,
  getErrorMessage,
  getSortedTelegramWorkspaceRecords,
  getTelegramTopicSessionName,
  getTelegramWorkspaceSessionIdentity,
  getTelegramWorkspaceSessionReference,
  getTelegramWorkspacesStatePath,
  isSameTelegramWorkspaceSessionFile,
  isSameTelegramWorkspaceSessionIdentity,
  normalizeTelegramWorkspaceSessionName,
  readTelegramWorkspacesState,
  readTelegramWorkspacesStateSync,
  formatTelegramWorkspaceSessionOwner,
  writeTelegramWorkspacesState,
} from "./workspace-manager-state.ts";
import {
  agentMessageHasToolCall,
  clearRuntimePostRunPreviewStreams,
  createWorkspaceRuntime,
  extractAgentThinkingBlocks,
  extractRpcAssistantError,
  extractRpcAssistantText,
  formatTelegramWorkspaceCompactToolStatusMarkdown,
  formatTelegramWorkspaceThinkingMarkdown,
  getAgentMessageContent,
  getLatestAssistantMessage,
  getRecord,
  getRpcAssistantThinkingDelta,
  getRpcAssistantThinkingEnd,
  getRpcAssistantToolCallPreview,
  getRpcToolExecutionPreview,
  isTelegramWorkspacePostRunTextMessage,
  pushTelegramWorkspacePostRunMessage,
  removeTelegramWorkspacePostRunMessage,
  resetRuntimeTurnBuffers,
} from "./workspace-manager-events.ts";
import {
  buildTelegramWorkspaceConfirmReplyMarkup,
  buildTelegramWorkspaceDashboardReplyMarkup,
  buildTelegramWorkspaceMultiCloseConfirmationReplyMarkup,
  buildTelegramWorkspaceMultiCloseConfirmationText,
  decodeTelegramWorkspaceCallbackName,
  formatTelegramTopicRepairUsage,
  formatTelegramWorkspaceDashboardSummary,
  formatTelegramWorkspaceOrphanDetail,
  getTelegramWorkspaceCloseableNames,
  normalizeTelegramWorkspaceCloseSelection,
} from "./workspace-manager-dashboard.ts";

export * from "./workspace-manager-constants.ts";
export * from "./workspace-manager-types.ts";
export * from "./workspace-manager-state.ts";
export * from "./workspace-manager-events.ts";
export * from "./workspace-manager-dashboard.ts";
export * from "./workspace-manager-ports.ts";

export function createTelegramWorkspaceManager<TContext>(
  deps: TelegramWorkspaceManagerDeps<TContext>,
): TelegramWorkspaceManager<TContext> {
  interface WsRuntimeContext<TContext> {
  agentDir: string;
  statePath: string;
  configuredSessionDir: string | undefined;
  workspaceRuntimes: Map<string, WorkspaceRuntime>;
  dashboardStates: Map<number, TelegramWorkspaceDashboardState>;
  state: TelegramWorkspacesState | undefined;
  persistChain: Promise<void>;
  now: () => number;
  isEnabled: () => boolean;
  streamEditThrottleMs: number;
  streamFailureBaseRetryMs: number;
  streamFailureMaxRetryMs: number;
  typingIntervalMs: number;
  thinkingStreamPreviewsEnabled: boolean;
  toolCallPreviewMode: import("./workspace-manager-constants.ts").TelegramWorkspaceToolPreviewMode;
  toolCallCompactPreviewsEnabled: boolean;
  toolCallStreamPreviewsEnabled: boolean;
  pruneDashboardStates: () => void;
  getDashboardState: (messageId: number) => TelegramWorkspaceDashboardState | undefined;
  setDashboardState: (dashboardState: TelegramWorkspaceDashboardState) => void;
  persist: () => Promise<void>;
  hydrateWorkspaceRuntimes: (workspaceState: TelegramWorkspacesState) => void;
  ensureState: (cwd: string) => Promise<TelegramWorkspacesState>;
  ensureStateSync: (cwd: string) => TelegramWorkspacesState;
  getWorkspaceRuntime: (workspaceState: TelegramWorkspacesState, name: string) => WorkspaceRuntime | undefined;
  getTopicBindingConfig: () => import("./config.ts").TelegramNormalizedConcurrentWorkspaceTopicBindingConfig | undefined;
  isTopicBindingEnabled: () => boolean;
  isForumNativeMode: () => boolean;
  isTrustedTopicBindingChat: (chatId: unknown) => boolean;
  isTopicDeliveryActive: (runtime: WorkspaceRuntime) => boolean;
  isRuntimeDeliveryActive: (workspaceState: TelegramWorkspacesState, workspaceName: string, runtime: WorkspaceRuntime) => boolean;
  isTelegramForumChatId: (chatId: number | undefined) => boolean;
  getForumNativeRuntimeScope: (runtime: WorkspaceRuntime, turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">) => "topic" | "workspace" | undefined;
  formatRuntimeUserScopeTarget: (runtime: WorkspaceRuntime, turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">) => string;
  formatRuntimeUserScopeTitle: (runtime: WorkspaceRuntime, turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">) => string;
  formatRuntimeStartedMessage: (runtime: WorkspaceRuntime, turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">) => string;
  formatRuntimeFailureMessage: (runtime: WorkspaceRuntime, errorMessage: string, turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">) => string;
  formatRuntimeFinishedNotice: (runtime: WorkspaceRuntime, workspaceName: string) => string;
  formatRuntimeBusyMessage: (runtime: WorkspaceRuntime, turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">) => string;
  formatRuntimeStopFirstMessage: (runtime: WorkspaceRuntime) => string;
  formatRuntimeAbortFirstMessage: (runtime: WorkspaceRuntime) => string;
  formatScopedWorkspaceBusyMessage: (workspaceName: string) => string;
  formatRuntimeTreeBranchUnavailableMessage: () => string;
  formatRuntimeSessionBindFailureMessage: (workspaceName: string, sessionPath: string) => string;
  hasLiveWorker: (runtime: WorkspaceRuntime | undefined) => boolean;
  getLiveWorkerCount: () => number;
  getConfiguredMaxWorkers: () => number;
  formatWorkerCapacityReachedMessage: (maxWorkers: number) => string;
  getIdleLiveWorkerStopCandidates: (targetWorkspaceRuntime: WorkspaceRuntime) => WorkspaceRuntime[];
  stopIdleLiveWorkerForCapacity: (targetWorkspaceRuntime: WorkspaceRuntime, maxWorkers: number) => Promise<boolean>;
  ensureWorkerCapacity: (runtime: WorkspaceRuntime) => Promise<void>;
  runInWorkspaceThreadContext: <T>(runtime: WorkspaceRuntime, fn: () => T) => T;
  sendTurnTextReply: (turn: TelegramWorkspacePromptTurn, text: string) => Promise<number | undefined>;
  sendWorkspaceReply: (chatId: number | undefined, replyToMessageId: number | undefined, text: string) => Promise<number | undefined>;
  sendWorkspaceMarkdownReply: (chatId: number | undefined, replyToMessageId: number | undefined, markdown: string) => Promise<number | undefined>;
  sendWorkspaceStreamMarkdownReply: (chatId: number | undefined, replyToMessageId: number | undefined, markdown: string) => Promise<number | undefined>;
  editWorkspaceStreamMarkdownMessage: (chatId: number | undefined, messageId: number | undefined, markdown: string) => Promise<number | undefined>;
  stopWorkspaceTyping: (runtime: WorkspaceRuntime) => void;
  stopOtherWorkspaceTyping: (workspaceName: string) => void;
  startWorkspaceTyping: (workspaceName: string, runtime: WorkspaceRuntime) => void;
  createStreamState: () => TelegramWorkspaceStreamState;
  getStreamState: (streams: Map<number, TelegramWorkspaceStreamState>, index: number) => TelegramWorkspaceStreamState;
  getTextStreamState: (runtime: WorkspaceRuntime) => TelegramWorkspaceStreamState;
  getToolCallStatusStreamState: (runtime: WorkspaceRuntime) => TelegramWorkspaceStreamState;
  getStreamFailureRetryMs: (failureCount: number) => number;
  isWorkspaceStreamStale: (runtime: WorkspaceRuntime, stream: TelegramWorkspaceStreamState) => boolean;
  getWorkspaceStreamDeliveryTarget: (runtime: WorkspaceRuntime, stream: TelegramWorkspaceStreamState) => { chatId?: number; messageThreadId?: number; replyToMessageId?: number; };
  bindWorkspaceStreamDeliveryTarget: (runtime: WorkspaceRuntime, stream: TelegramWorkspaceStreamState) => void;
  schedulePendingWorkspaceStreamRetry: (runtime: WorkspaceRuntime, stream: TelegramWorkspaceStreamState) => void;
  blockWorkspaceStreamDelivery: (runtime: WorkspaceRuntime, stream: TelegramWorkspaceStreamState) => void;
  unblockWorkspaceStreamDelivery: (runtime: WorkspaceRuntime, stream: TelegramWorkspaceStreamState) => void;
  getWorkspaceStreamDeliveryBlockedUntil: (runtime: WorkspaceRuntime, stream: TelegramWorkspaceStreamState) => number | undefined;
  scheduleAllPendingWorkspaceStreamRetries: (runtime: WorkspaceRuntime, except?: TelegramWorkspaceStreamState) => void;
  flushWorkspaceStreamMarkdown: (runtime: WorkspaceRuntime, stream: TelegramWorkspaceStreamState, options?: { force?: boolean; allowStaleDelivery?: boolean; retryOnFailure?: boolean; }) => Promise<TelegramWorkspaceStreamDeliveryResult>;
  scheduleWorkspaceStreamMarkdownFlush: (runtime: WorkspaceRuntime, stream: TelegramWorkspaceStreamState, force: boolean) => void;
  streamActiveWorkspaceMarkdown: (workspaceState: TelegramWorkspacesState, workspaceName: string, runtime: WorkspaceRuntime, stream: TelegramWorkspaceStreamState, markdown: string, force?: boolean, truncate?: boolean) => void;
  streamActiveWorkspaceText: (workspaceState: TelegramWorkspacesState, workspaceName: string, runtime: WorkspaceRuntime, text: string, force?: boolean) => boolean;
  streamActiveWorkspaceThinking: (workspaceState: TelegramWorkspacesState, workspaceName: string, runtime: WorkspaceRuntime, index: number, text: string, force?: boolean) => void;
  flushActiveWorkspaceThinkingBuffer: (workspaceState: TelegramWorkspacesState, workspaceName: string, runtime: WorkspaceRuntime, index: number) => void;
  streamActiveWorkspaceToolCall: (workspaceState: TelegramWorkspacesState, workspaceName: string, runtime: WorkspaceRuntime, index: number, markdown: string, final: boolean) => void;
  streamActiveWorkspaceCompactToolStatus: (workspaceState: TelegramWorkspacesState, workspaceName: string, runtime: WorkspaceRuntime, preview: { key: string; markdown: string; status: TelegramWorkspaceToolStatusKind; }) => void;
  getWorkspaceTurnDetails: (workspaceName: string, runtime: WorkspaceRuntime) => Record<string, unknown>;
  isFinalWorkspaceStreamDeliveryConfirmed: (result: TelegramWorkspaceStreamDeliveryResult, expectedMarkdown: string, latestSentMarkdown?: string) => boolean;
  finalizeActiveWorkspaceTextStream: (runtime: WorkspaceRuntime, stream: TelegramWorkspaceStreamState | undefined, finalMarkdown: string) => Promise<TelegramWorkspaceStreamDeliveryResult>;
  deleteWorkspaceStreamPreviewMessage: (runtime: WorkspaceRuntime, stream: TelegramWorkspaceStreamState | undefined, deletedMessageIds?: Set<number>) => Promise<void>;
  deleteRuntimePostRunPreviewMessages: (runtime: WorkspaceRuntime, textStream: TelegramWorkspaceStreamState | undefined) => Promise<void>;
  markActiveWorkspaceTextStreamAborted: (runtime: WorkspaceRuntime, stream?: TelegramWorkspaceStreamState | undefined) => Promise<TelegramWorkspaceStreamDeliveryResult | undefined>;
  logWorkspaceFirstOutput: (workspaceName: string, runtime: WorkspaceRuntime, outputKind: string) => void;
  logWorkspaceTurnSummary: (workspaceName: string, runtime: WorkspaceRuntime, stopReason?: string, error?: string) => void;
  sendActiveWorkspaceToolCallMessage: (workspaceState: TelegramWorkspacesState, workspaceName: string, runtime: WorkspaceRuntime, message: unknown) => boolean;
  handleChildEvent: (workspaceName: string, runtime: WorkspaceRuntime, event: RpcChildBackendEvent) => void;
  ensureBackend: (runtime: WorkspaceRuntime, ctx: TContext) => Promise<TelegramWorkspaceBackend>;
  disposeRuntimeBackend: (runtime: WorkspaceRuntime) => Promise<void>;
  disposeClosingRuntimeBackend: (runtime: WorkspaceRuntime) => Promise<void>;
  syncTopicSessionNameToWorker: (runtime: WorkspaceRuntime, options?: { workerSessionName?: string; forceWorker?: boolean; }) => Promise<boolean>;
  refreshRuntimeState: (runtime: WorkspaceRuntime) => Promise<RpcChildSessionState | undefined>;
  refreshDashboardWorkspaceRecords: (workspaceState: TelegramWorkspacesState) => Promise<void>;
  getOpenSessionConflict: (workspaceState: TelegramWorkspacesState, targetWorkspaceRuntime: WorkspaceRuntime, target: Pick<TelegramWorkspaceSessionIdentity, "sessionFile" | "sessionId">) => Promise<TelegramWorkspaceRecord | undefined>;
  assertNoOpenSessionConflict: (workspaceState: TelegramWorkspacesState, targetWorkspaceRuntime: WorkspaceRuntime, target: Pick<TelegramWorkspaceSessionIdentity, "sessionFile" | "sessionId">) => Promise<void>;
  getTelegramTopicServiceKind: (message: TelegramWorkspaceForumTopicServiceMessage) => "created" | "edited" | "closed" | "reopened" | "general-hidden" | "general-unhidden" | undefined;
  updateTelegramTopicRecordTitle: (record: TelegramWorkspaceRecord, topicTitle: string | undefined) => boolean;
  createTelegramTopicWorkspaceRecord: (workspaceState: TelegramWorkspacesState, scope: { chatId: number; messageThreadId: number; topicTitle?: string; }, ctx: TContext) => TelegramWorkspaceRecord;
  getOrCreateTopicRuntimeForTurn: (workspaceState: TelegramWorkspacesState, turn: TelegramWorkspacePromptTurn, ctx: TContext) => Promise<WorkspaceRuntime | undefined>;
  getWorkspaceRuntimeForPromptTurn: (workspaceState: TelegramWorkspacesState, turn: TelegramWorkspacePromptTurn, ctx: TContext) => Promise<WorkspaceRuntime | undefined>;
  upsertTelegramTopicWorkspaceRecord: (workspaceState: TelegramWorkspacesState, scope: { chatId: number; messageThreadId: number; topicTitle?: string; }, ctx: TContext, options: { enforceCapacity: boolean; }) => Promise<TelegramWorkspaceRecord | undefined>;
  resolveScopedTopicRuntime: (workspaceState: TelegramWorkspacesState, ctx: TContext) => Promise<{ scoped: boolean; runtime?: WorkspaceRuntime; }>;
  resolveScopedTopicRuntimeSync: (workspaceState: TelegramWorkspacesState, ctx: TContext) => { scoped: boolean; runtime?: WorkspaceRuntime; };
  getActiveRuntime: (ctx: TContext) => Promise<WorkspaceRuntime | undefined>;
  getActiveRuntimeSync: (ctx: TContext) => WorkspaceRuntime | undefined;
  replyDisabled: (chatId: number, replyToMessageId: number) => Promise<number | undefined>;
  getUnreadByWorkspace: () => Record<string, number>;
  getDashboardWorkerState: (runtime: WorkspaceRuntime | undefined) => TelegramWorkspaceDashboardWorkerState;
  getDashboardWorkerStateByWorkspace: (workspaceState: TelegramWorkspacesState) => Record<string, TelegramWorkspaceDashboardWorkerState>;
  sendForumNativeLifecycleDisabledReply: (chatId: number, replyToMessageId: number) => Promise<number | undefined>;
  sendWorkspaceDashboard: (workspaceState: TelegramWorkspacesState, chatId: number, replyToMessageId: number, filters?: readonly string[]) => Promise<void>;
  editWorkspaceDashboard: (workspaceState: TelegramWorkspacesState, chatId: number, messageId: number, options?: { mode?: TelegramWorkspaceDashboardMode; selectedCloseWorkspaces?: readonly string[]; }) => Promise<void>;
  answerWorkspaceCallback: (callbackQueryId: string, text?: string) => Promise<void>;
  closeWorkspaceRuntime: (workspaceState: TelegramWorkspacesState, name: string, force: boolean) => Promise<{ closed: boolean; message: string; }>;
  commandHandlers: { list: (workspaceState: TelegramWorkspacesState, chatId: number, replyToMessageId: number) => Promise<void>; query: (workspaceState: TelegramWorkspacesState, query: string, filters: readonly string[], chatId: number, replyToMessageId: number) => Promise<void>; new: (workspaceState: TelegramWorkspacesState, name: string, chatId: number, replyToMessageId: number, ctx: TContext) => Promise<void>; switch: (workspaceState: TelegramWorkspacesState, name: string, chatId: number, replyToMessageId: number) => Promise<void>; rename: (workspaceState: TelegramWorkspacesState, oldName: string | undefined, newName: string, chatId: number, replyToMessageId: number) => Promise<void>; close: (workspaceState: TelegramWorkspacesState, name: string | undefined, force: boolean, chatId: number, replyToMessageId: number) => Promise<void>; status: (workspaceState: TelegramWorkspacesState, name: string | undefined, chatId: number, replyToMessageId: number) => Promise<void>; abortRuntime: (workspaceState: TelegramWorkspacesState, name: string | undefined) => Promise<TelegramWorkspaceAbortResult>; abort: (workspaceState: TelegramWorkspacesState, name: string | undefined, chatId: number, replyToMessageId: number) => Promise<void>; syncNames: (workspaceState: TelegramWorkspacesState, chatId: number, replyToMessageId: number) => Promise<void>; restart: (workspaceState: TelegramWorkspacesState, name: string, chatId: number, replyToMessageId: number, ctx: TContext) => Promise<void>; topicOrphans: (workspaceState: TelegramWorkspacesState, chatId: number, replyToMessageId: number) => Promise<void>; topicCleanup: (workspaceState: TelegramWorkspacesState, chatId: number, replyToMessageId: number) => Promise<void>; };
  deliverPromptTurn: (runtime: WorkspaceRuntime, turn: TelegramWorkspacePromptTurn, ctx: TContext, options: { wasRunning: boolean; replyOnSuccess?: boolean; }) => Promise<void>;
  flushPendingCompactionTurns: (runtime: WorkspaceRuntime, ctx: TContext) => Promise<void>;
  clearPendingCompactionTurns: (runtime: WorkspaceRuntime) => number;
  }
  const self = {} as WsRuntimeContext<TContext>;
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
  self.createStreamState = (): TelegramWorkspaceStreamState => ({
    markdown: "",
    sentMarkdown: "",
    lastFlushAt: 0,
  });
  self.getStreamState = (
    streams: Map<number, TelegramWorkspaceStreamState>,
    index: number,
  ): TelegramWorkspaceStreamState => {
    let stream = streams.get(index);
    if (!stream) {
      stream = self.createStreamState();
      streams.set(index, stream);
    }
    return stream;
  };
  self.getTextStreamState = (runtime: WorkspaceRuntime): TelegramWorkspaceStreamState => {
    runtime.textStream ??= self.createStreamState();
    return runtime.textStream;
  };
  self.getToolCallStatusStreamState = (
    runtime: WorkspaceRuntime,
  ): TelegramWorkspaceStreamState => {
    runtime.toolCallStatusStream ??= self.createStreamState();
    return runtime.toolCallStatusStream;
  };
  self.getStreamFailureRetryMs = (failureCount: number): number =>
    Math.min(
      self.streamFailureMaxRetryMs,
      self.streamFailureBaseRetryMs *
        2 ** Math.min(Math.max(0, failureCount - 1), 6),
    );
  self.isWorkspaceStreamStale = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): boolean =>
    stream.turnId !== undefined && runtime.activeTurnId !== stream.turnId;
  self.getWorkspaceStreamDeliveryTarget = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): {
    chatId?: number;
    messageThreadId?: number;
    replyToMessageId?: number;
  } => {
    if (stream.chatId !== undefined) {
      return {
        chatId: stream.chatId,
        messageThreadId: stream.messageThreadId,
        replyToMessageId: stream.replyToMessageId,
      };
    }
    return {
      chatId: runtime.activeChatId,
      messageThreadId: runtime.activeMessageThreadId,
      replyToMessageId: runtime.activeReplyToMessageId,
    };
  };
  self.bindWorkspaceStreamDeliveryTarget = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): void => {
    if (stream.turnId !== undefined) return;
    stream.turnId = runtime.activeTurnId;
    stream.chatId = runtime.activeChatId;
    stream.messageThreadId = runtime.activeMessageThreadId;
    stream.replyToMessageId = runtime.activeReplyToMessageId;
  };
  self.schedulePendingWorkspaceStreamRetry = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): void => {
    if (self.isWorkspaceStreamStale(runtime, stream)) return;
    const nextFlushAt = Math.max(
      stream.nextFlushAt ?? 0,
      runtime.streamDeliveryBlockedUntil ?? 0,
    );
    if (nextFlushAt <= 0 || stream.flushTimer) return;
    if (stream.markdown === stream.sentMarkdown) return;
    const wait = Math.max(0, nextFlushAt - self.now());
    stream.flushTimer = setTimeout(() => {
      stream.flushTimer = undefined;
      void self.flushWorkspaceStreamMarkdown(runtime, stream);
    }, wait);
  };
  self.blockWorkspaceStreamDelivery = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): void => {
    if (self.isWorkspaceStreamStale(runtime, stream)) return;
    const failedFlushCount =
      Math.max(
        stream.failedFlushCount ?? 0,
        runtime.streamDeliveryFailureCount ?? 0,
      ) + 1;
    const retryAt = self.now() + self.getStreamFailureRetryMs(failedFlushCount);
    stream.failedFlushCount = failedFlushCount;
    stream.lastFlushAt = self.now();
    stream.nextFlushAt = retryAt;
    runtime.streamDeliveryFailureCount = failedFlushCount;
    runtime.streamDeliveryBlockedUntil = retryAt;
  };
  self.unblockWorkspaceStreamDelivery = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): void => {
    stream.failedFlushCount = undefined;
    stream.nextFlushAt = undefined;
    if (self.isWorkspaceStreamStale(runtime, stream)) return;
    runtime.streamDeliveryFailureCount = undefined;
    runtime.streamDeliveryBlockedUntil = undefined;
  };
  self.getWorkspaceStreamDeliveryBlockedUntil = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): number | undefined => {
    const nextFlushAt = Math.max(
      stream.nextFlushAt ?? 0,
      runtime.streamDeliveryBlockedUntil ?? 0,
    );
    return nextFlushAt > 0 ? nextFlushAt : undefined;
  };
  self.scheduleAllPendingWorkspaceStreamRetries = (
    runtime: WorkspaceRuntime,
    except?: TelegramWorkspaceStreamState,
  ): void => {
    const streams = [
      runtime.textStream,
      ...runtime.thinkingStreams.values(),
      ...runtime.toolCallStreams.values(),
      runtime.toolCallStatusStream,
    ];
    for (const stream of streams) {
      if (!stream || stream === except) continue;
      if (stream.markdown === stream.sentMarkdown) continue;
      self.schedulePendingWorkspaceStreamRetry(runtime, stream);
    }
  };
  self.flushWorkspaceStreamMarkdown = async (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
    options: {
      force?: boolean;
      allowStaleDelivery?: boolean;
      retryOnFailure?: boolean;
    } = {},
  ): Promise<TelegramWorkspaceStreamDeliveryResult> => {
    if (options.retryOnFailure === false) {
      stream.suppressRetryOnFailure = true;
    }
    const shouldRetryOnFailure = (): boolean =>
      options.retryOnFailure !== false && stream.suppressRetryOnFailure !== true;
    const makeSkipped = (reason: string): TelegramWorkspaceStreamDeliveryResult => ({
      status: "skipped",
      reason,
      stale: self.isWorkspaceStreamStale(runtime, stream),
    });
    if (!stream.markdown) return makeSkipped("empty");
    if (stream.markdown === stream.sentMarkdown) return makeSkipped("unchanged");
    if (self.isWorkspaceStreamStale(runtime, stream) && !options.allowStaleDelivery) {
      return makeSkipped("stale-turn");
    }
    const blockedUntil = self.getWorkspaceStreamDeliveryBlockedUntil(runtime, stream);
    if (!options.force && blockedUntil !== undefined && self.now() < blockedUntil) {
      self.schedulePendingWorkspaceStreamRetry(runtime, stream);
      return {
        status: "scheduled",
        reason: "blocked",
        retryAt: blockedUntil,
        stale: self.isWorkspaceStreamStale(runtime, stream),
      };
    }
    if (stream.flushPromise) {
      stream.flushRequested = true;
      return stream.flushPromise;
    }
    stream.flushPromise = (async () => {
      let lastResult: TelegramWorkspaceStreamDeliveryResult = makeSkipped("empty");
      do {
        stream.flushRequested = false;
        const markdown = stream.markdown;
        if (!markdown) return makeSkipped("empty");
        if (markdown === stream.sentMarkdown) return makeSkipped("unchanged");
        if (self.isWorkspaceStreamStale(runtime, stream) && !options.allowStaleDelivery) {
          return makeSkipped("stale-turn");
        }
        const target = self.getWorkspaceStreamDeliveryTarget(runtime, stream);
        if (target.chatId === undefined) {
          return makeSkipped("missing-chat");
        }
        let delivered = false;
        let deliveredMessageId = stream.messageId;
        try {
          const currentMessageId = stream.messageId;
          if (currentMessageId === undefined) {
            const messageId = await runWithTelegramThreadContext(
              {
                chatId: target.chatId,
                messageThreadId: target.messageThreadId,
              },
              () =>
                self.sendWorkspaceStreamMarkdownReply(
                  target.chatId,
                  target.replyToMessageId,
                  markdown,
                ),
            );
            if (messageId !== undefined) {
              deliveredMessageId = messageId;
              delivered = true;
            }
          } else if (deps.editStreamMarkdownMessage) {
            const messageId = await runWithTelegramThreadContext(
              {
                chatId: target.chatId,
                messageThreadId: target.messageThreadId,
              },
              () =>
                self.editWorkspaceStreamMarkdownMessage(
                  target.chatId,
                  currentMessageId,
                  markdown,
                ),
            );
            deliveredMessageId = messageId ?? currentMessageId;
            delivered = true;
          }
        } catch (error) {
          deps.recordRuntimeEvent?.("workspaces", error, {
            workspace: runtime.record.name,
            action: "stream_markdown",
            turnId: stream.turnId,
            chatId: target.chatId,
            messageThreadId: target.messageThreadId,
            replyToMessageId: target.replyToMessageId,
            streamMessageId: stream.messageId,
          });
          lastResult = {
            status: "failed",
            error: getErrorMessage(error),
            stale: self.isWorkspaceStreamStale(runtime, stream),
          };
        }
        if (!delivered) {
          if (lastResult.status !== "failed") {
            lastResult = {
              status: "failed",
              stale: self.isWorkspaceStreamStale(runtime, stream),
            };
          }
          if (shouldRetryOnFailure()) {
            self.blockWorkspaceStreamDelivery(runtime, stream);
            self.scheduleAllPendingWorkspaceStreamRetries(runtime, stream);
          }
          return lastResult;
        }
        const staleAfterDelivery = self.isWorkspaceStreamStale(runtime, stream);
        if (!staleAfterDelivery) {
          if (deliveredMessageId !== undefined) stream.messageId = deliveredMessageId;
          self.unblockWorkspaceStreamDelivery(runtime, stream);
          stream.sentMarkdown = markdown;
          removeTelegramWorkspacePostRunMessage(runtime, markdown);
          stream.lastFlushAt = self.now();
          runtime.lastStreamFlushAt = stream.lastFlushAt;
        }
        lastResult = {
          status: "delivered",
          sentMarkdown: markdown,
          messageId: deliveredMessageId,
          stale: staleAfterDelivery,
        };
      } while (stream.flushRequested);
      return lastResult;
    })();
    try {
      return await stream.flushPromise;
    } finally {
      stream.flushPromise = undefined;
      if (
        shouldRetryOnFailure() &&
        !self.isWorkspaceStreamStale(runtime, stream) &&
        stream.markdown !== stream.sentMarkdown
      ) {
        self.schedulePendingWorkspaceStreamRetry(runtime, stream);
      }
    }
  };
  self.scheduleWorkspaceStreamMarkdownFlush = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
    force: boolean,
  ): void => {
    if (stream.flushTimer) {
      if (!force) return;
      clearTimeout(stream.flushTimer);
      stream.flushTimer = undefined;
    }
    const blockedUntil = self.getWorkspaceStreamDeliveryBlockedUntil(runtime, stream);
    const retryWait =
      !force && blockedUntil !== undefined ? Math.max(0, blockedUntil - self.now()) : 0;
    const globalThrottleWait = Math.max(
      0,
      self.streamEditThrottleMs - (self.now() - (runtime.lastStreamFlushAt ?? 0)),
    );
    const wait =
      retryWait > 0
        ? retryWait
        : force
          ? 0
          : Math.max(
              globalThrottleWait,
              self.streamEditThrottleMs - (self.now() - stream.lastFlushAt),
            );
    if (wait === 0) {
      void self.flushWorkspaceStreamMarkdown(runtime, stream, { force });
      return;
    }
    stream.flushTimer = setTimeout(() => {
      stream.flushTimer = undefined;
      void self.flushWorkspaceStreamMarkdown(runtime, stream);
    }, wait);
  };
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
      status: TelegramWorkspaceToolStatusKind;
    },
  ): void => {
    if (!self.toolCallCompactPreviewsEnabled) return;
    if (!preview.markdown && !runtime.toolCallStatuses.has(preview.key)) return;
    const current = runtime.toolCallStatuses.get(preview.key);
    runtime.toolCallStatuses.set(preview.key, {
      key: preview.key,
      markdown: preview.markdown || current?.markdown || "\u{1F527} `tool`",
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
        self.streamActiveWorkspaceCompactToolStatus(workspaceState, workspaceName, runtime, {
          key,
          markdown,
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
  self.ensureBackend = async (
    runtime: WorkspaceRuntime,
    ctx: TContext,
  ): Promise<TelegramWorkspaceBackend> => {
    if (runtime.backend) return runtime.backend;
    await self.ensureWorkerCapacity(runtime);
    runtime.record.status = "starting";
    runtime.record.lastError = undefined;
    const cwd = runtime.record.cwd || deps.getCwd(ctx);
    const sessionDir = deps.getSessionDir?.(ctx) ?? self.configuredSessionDir;
    const config = deps.getConfig();
    const workerArgs = buildTelegramWorkspaceWorkerExtensionArgs(
      config.workerExtensions,
    );
    const defaultModel = config.topicBinding?.defaultModel;
    if (defaultModel) {
      workerArgs.push("--model", defaultModel);
    }
    deps.debugLogger?.log(
      "telegram.workspace.worker.start",
      {
        workspace: runtime.record.name,
        cwd,
        sessionDir,
        sessionFile: runtime.record.sessionFile,
        workerExtensionCount: deps.getConfig().workerExtensions.length,
      },
      workerArgs,
    );
    runtime.closing = false;
    const workerStartedAt = Date.now();
    const backend = deps.createBackend?.({
      workspaceName: runtime.record.name,
      cwd,
      sessionDir,
      sessionFile: runtime.record.sessionFile,
      args: workerArgs,
    }) ?? new RpcChildBackend({
      workspaceName: runtime.record.name,
      cwd,
      sessionDir,
      sessionFile: runtime.record.sessionFile,
      args: workerArgs,
    });
    runtime.backend = backend;
    runtime.unsubscribe = backend.onEvent((event) => {
      self.handleChildEvent(runtime.record.name, runtime, event);
    });
    try {
      const childState = await backend.start();
      deps.debugLogger?.log(
        "telegram.workspace.worker.ready",
        { workspace: runtime.record.name, elapsedMs: Date.now() - workerStartedAt },
        childState,
      );
      applyRpcStateToRecord(runtime.record, childState);
      await self.syncTopicSessionNameToWorker(runtime, {
        workerSessionName: childState.sessionName,
      });
      await self.persist();
      return backend;
    } catch (error) {
      deps.debugLogger?.log("telegram.workspace.worker.start_error", {
        workspace: runtime.record.name,
        elapsedMs: Date.now() - workerStartedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      runtime.record.status = "error";
      runtime.record.lastError = getErrorMessage(error);
      runtime.backend = undefined;
      runtime.unsubscribe?.();
      runtime.unsubscribe = undefined;
      await self.persist();
      throw error;
    }
  };
  self.disposeRuntimeBackend = async (runtime: WorkspaceRuntime): Promise<void> => {
    self.stopWorkspaceTyping(runtime);
    const backend = runtime.backend;
    runtime.backend = undefined;
    runtime.unsubscribe?.();
    runtime.unsubscribe = undefined;
    await backend?.dispose();
  };
  self.disposeClosingRuntimeBackend = async (
    runtime: WorkspaceRuntime,
  ): Promise<void> => {
    runtime.closing = true;
    self.stopWorkspaceTyping(runtime);
    resetRuntimeTurnBuffers(runtime);
    const backend = runtime.backend;
    runtime.backend = undefined;
    runtime.unsubscribe?.();
    runtime.unsubscribe = undefined;
    await backend?.dispose();
  };
  self.syncTopicSessionNameToWorker = async (
    runtime: WorkspaceRuntime,
    options: { workerSessionName?: string; forceWorker?: boolean } = {},
  ): Promise<boolean> => {
    const topicSessionName = getTelegramTopicSessionName(runtime.record);
    if (!topicSessionName) return false;
    let changed = false;
    if (runtime.record.sessionName !== topicSessionName) {
      runtime.record.sessionName = topicSessionName;
      changed = true;
    }
    const workerSessionName = normalizeTelegramWorkspaceSessionName(
      options.workerSessionName ?? "",
    );
    const hasWorkerSessionName = Object.hasOwn(options, "workerSessionName");
    const shouldSyncWorker = Boolean(
      runtime.backend &&
        (options.forceWorker ||
          (hasWorkerSessionName && workerSessionName !== topicSessionName)),
    );
    if (shouldSyncWorker && runtime.backend) {
      try {
        await runtime.backend.setSessionName(topicSessionName);
        changed = true;
      } catch (error) {
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "sync_topic_session_name",
        });
      }
    }
    return changed;
  };
  self.refreshRuntimeState = async (
    runtime: WorkspaceRuntime,
  ): Promise<RpcChildSessionState | undefined> => {
    if (!runtime.backend) return undefined;
    let childState: RpcChildSessionState | undefined;
    try {
      childState = await runtime.backend.getState();
      applyRpcStateToRecord(runtime.record, childState);
    } catch (error) {
      runtime.record.status = "error";
      runtime.record.lastError = getErrorMessage(error);
    }
    await self.persist();
    return childState;
  };
  self.refreshDashboardWorkspaceRecords = async (
    workspaceState: TelegramWorkspacesState,
  ): Promise<void> => {
    await Promise.all(
      Object.keys(workspaceState.workspaces).map(async (name) => {
        const runtime = self.getWorkspaceRuntime(workspaceState, name);
        if (runtime?.backend) await self.refreshRuntimeState(runtime);
      }),
    );
  };
  self.getOpenSessionConflict = async (
    workspaceState: TelegramWorkspacesState,
    targetWorkspaceRuntime: WorkspaceRuntime,
    target: Pick<TelegramWorkspaceSessionIdentity, "sessionFile" | "sessionId">,
  ): Promise<TelegramWorkspaceRecord | undefined> => {
    const targetIdentity = getTelegramWorkspaceSessionIdentity(target);
    if (!targetIdentity.canonicalSessionFile && !targetIdentity.sessionId) {
      return undefined;
    }
    await Promise.all(
      Object.values(workspaceState.workspaces).map(async (record) => {
        if (record.name === targetWorkspaceRuntime.record.name) return;
        const runtime = self.getWorkspaceRuntime(workspaceState, record.name);
        if (runtime?.backend) await self.refreshRuntimeState(runtime);
      }),
    );
    return Object.values(workspaceState.workspaces).find((record) => {
      if (record.name === targetWorkspaceRuntime.record.name) return false;
      return isSameTelegramWorkspaceSessionIdentity(
        getTelegramWorkspaceSessionIdentity(record),
        targetIdentity,
      );
    });
  };
  self.assertNoOpenSessionConflict = async (
    workspaceState: TelegramWorkspacesState,
    targetWorkspaceRuntime: WorkspaceRuntime,
    target: Pick<TelegramWorkspaceSessionIdentity, "sessionFile" | "sessionId">,
  ): Promise<void> => {
    const conflict = await self.getOpenSessionConflict(workspaceState, targetWorkspaceRuntime, target);
    if (!conflict) return;
    throw new Error(
      `Session is already open in workspace ${formatTelegramWorkspaceSessionOwner(conflict)}. Close that workspace first or branch/clone the session.`,
    );
  };
  self.getTelegramTopicServiceKind = (
    message: TelegramWorkspaceForumTopicServiceMessage,
  ):
    | "created"
    | "edited"
    | "closed"
    | "reopened"
    | "general-hidden"
    | "general-unhidden"
    | undefined => {
    if (message.forum_topic_created) return "created";
    if (message.forum_topic_edited) return "edited";
    if (message.forum_topic_closed) return "closed";
    if (message.forum_topic_reopened) return "reopened";
    if (message.general_forum_topic_hidden) return "general-hidden";
    if (message.general_forum_topic_unhidden) return "general-unhidden";
    return undefined;
  };
  self.updateTelegramTopicRecordTitle = (
    record: TelegramWorkspaceRecord,
    topicTitle: string | undefined,
  ): boolean => {
    const sessionName = normalizeTelegramWorkspaceSessionName(topicTitle ?? "");
    if (!sessionName || record.source?.kind !== "telegram-topic") return false;
    let changed = false;
    if (record.source.topicTitle !== sessionName) {
      record.source = { ...record.source, topicTitle: sessionName };
      changed = true;
    }
    if (record.sessionName !== sessionName) {
      record.sessionName = sessionName;
      changed = true;
    }
    return changed;
  };
  self.createTelegramTopicWorkspaceRecord = (
    workspaceState: TelegramWorkspacesState,
    scope: { chatId: number; messageThreadId: number; topicTitle?: string },
    ctx: TContext,
  ): TelegramWorkspaceRecord => {
    const createdAt = self.now();
    let name = normalizeTelegramTopicWorkspaceName(scope.chatId, scope.messageThreadId);
    if (workspaceState.workspaces[name]) {
      let suffix = 2;
      const base = name.slice(0, Math.max(1, 29));
      while (workspaceState.workspaces[name]) {
        name = `${base}-${suffix}`.slice(0, 32);
        suffix += 1;
      }
    }
    const topicSessionName = normalizeTelegramWorkspaceSessionName(
      scope.topicTitle ?? "",
    );
    const source: TelegramWorkspaceSourceTelegramTopic = {
      kind: "telegram-topic",
      chatId: scope.chatId,
      messageThreadId: scope.messageThreadId,
      ...(topicSessionName ? { topicTitle: topicSessionName } : {}),
    };
    return {
      name,
      cwd: deps.getCwd(ctx),
      ...(topicSessionName ? { sessionName: topicSessionName } : {}),
      createdAt,
      lastUsedAt: createdAt,
      status: "idle",
      source,
    };
  };
  self.getOrCreateTopicRuntimeForTurn = async (
    workspaceState: TelegramWorkspacesState,
    turn: TelegramWorkspacePromptTurn,
    ctx: TContext,
  ): Promise<WorkspaceRuntime | undefined> => {
    const topicBinding = self.getTopicBindingConfig();
    if (!topicBinding?.enabled) return undefined;
    if (!self.isTrustedTopicBindingChat(turn.chatId)) {
      await self.sendTurnTextReply(
        turn,
        "This Telegram forum is not authorized for topic workspaces.",
      );
      return undefined;
    }
    if (turn.messageThreadId === undefined && topicBinding.generalIsDefault) {
      return self.getWorkspaceRuntime(workspaceState, TELEGRAM_DEFAULT_WORKSPACE_NAME);
    }
    if (turn.messageThreadId === undefined) return undefined;
    const existing = findTelegramWorkspaceByTopic(
      workspaceState.workspaces,
      turn.chatId,
      turn.messageThreadId,
    );
    if (existing) return self.getWorkspaceRuntime(workspaceState, existing.name);
    if (!topicBinding.autoCreate) return undefined;
    if (Object.keys(workspaceState.workspaces).length >= deps.getConfig().maxWorkspaces) {
      await self.sendTurnTextReply(
        turn,
        "Maximum workspace count reached. Close another topic/workspace first.",
      );
      return undefined;
    }
    const record = self.createTelegramTopicWorkspaceRecord(
      workspaceState,
      { chatId: turn.chatId, messageThreadId: turn.messageThreadId },
      ctx,
    );
    workspaceState.workspaces[record.name] = record;
    const runtime = createWorkspaceRuntime(record);
    self.workspaceRuntimes.set(record.name, runtime);
    await self.persist();
    return runtime;
  };
  self.getWorkspaceRuntimeForPromptTurn = async (
    workspaceState: TelegramWorkspacesState,
    turn: TelegramWorkspacePromptTurn,
    ctx: TContext,
  ): Promise<WorkspaceRuntime | undefined> => {
    if (!self.isTopicBindingEnabled()) return self.getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
    if (turn.messageThreadId !== undefined && !self.isTrustedTopicBindingChat(turn.chatId)) {
      await self.sendTurnTextReply(
        turn,
        "This Telegram forum is not authorized for topic workspaces.",
      );
      return undefined;
    }
    if (turn.messageThreadId === undefined) {
      return self.getTopicBindingConfig()?.generalIsDefault
        ? self.getWorkspaceRuntime(workspaceState, TELEGRAM_DEFAULT_WORKSPACE_NAME)
        : self.getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
    }
    const runtime = await self.getOrCreateTopicRuntimeForTurn(workspaceState, turn, ctx);
    if (runtime) return runtime;
    if (!self.getTopicBindingConfig()?.autoCreate) {
      await self.sendTurnTextReply(
        turn,
        self.isForumNativeMode()
          ? "No workspace is bound to this Telegram topic."
          : "No workspace is bound to this Telegram topic.",
      );
    }
    return undefined;
  };
  self.upsertTelegramTopicWorkspaceRecord = async (
    workspaceState: TelegramWorkspacesState,
    scope: { chatId: number; messageThreadId: number; topicTitle?: string },
    ctx: TContext,
    options: { enforceCapacity: boolean },
  ): Promise<TelegramWorkspaceRecord | undefined> => {
    const existing = findTelegramWorkspaceByTopic(
      workspaceState.workspaces,
      scope.chatId,
      scope.messageThreadId,
    );
    if (existing) {
      if (self.updateTelegramTopicRecordTitle(existing, scope.topicTitle)) {
        await self.persist();
      }
      return existing;
    }
    if (
      options.enforceCapacity &&
      Object.keys(workspaceState.workspaces).length >= deps.getConfig().maxWorkspaces
    ) {
      return undefined;
    }
    const record = self.createTelegramTopicWorkspaceRecord(workspaceState, scope, ctx);
    workspaceState.workspaces[record.name] = record;
    self.workspaceRuntimes.set(record.name, createWorkspaceRuntime(record));
    await self.persist();
    return record;
  };
  self.resolveScopedTopicRuntime = async (
    workspaceState: TelegramWorkspacesState,
    ctx: TContext,
  ): Promise<{ scoped: boolean; runtime?: WorkspaceRuntime }> => {
    if (!self.isTopicBindingEnabled()) return { scoped: false };
    const scope = getAmbientTelegramThreadContext();
    if (!scope) return { scoped: false };
    if (!self.isTrustedTopicBindingChat(scope.chatId)) {
      return scope.messageThreadId === undefined ? { scoped: false } : { scoped: true };
    }
    const topicBinding = self.getTopicBindingConfig();
    if (scope.messageThreadId === undefined) {
      return {
        scoped: true,
        runtime: topicBinding?.generalIsDefault
          ? self.getWorkspaceRuntime(workspaceState, TELEGRAM_DEFAULT_WORKSPACE_NAME)
          : undefined,
      };
    }
    const existing = findTelegramWorkspaceByTopic(
      workspaceState.workspaces,
      scope.chatId,
      scope.messageThreadId,
    );
    if (existing) return { scoped: true, runtime: self.getWorkspaceRuntime(workspaceState, existing.name) };
    if (!topicBinding?.autoCreate) return { scoped: true };
    const record = await self.upsertTelegramTopicWorkspaceRecord(
      workspaceState,
      { chatId: scope.chatId, messageThreadId: scope.messageThreadId },
      ctx,
      { enforceCapacity: true },
    );
    return {
      scoped: true,
      runtime: record ? self.getWorkspaceRuntime(workspaceState, record.name) : undefined,
    };
  };
  self.resolveScopedTopicRuntimeSync = (
    workspaceState: TelegramWorkspacesState,
    ctx: TContext,
  ): { scoped: boolean; runtime?: WorkspaceRuntime } => {
    if (!self.isTopicBindingEnabled()) return { scoped: false };
    const scope = getAmbientTelegramThreadContext();
    if (!scope) return { scoped: false };
    if (!self.isTrustedTopicBindingChat(scope.chatId)) {
      return scope.messageThreadId === undefined ? { scoped: false } : { scoped: true };
    }
    const topicBinding = self.getTopicBindingConfig();
    if (scope.messageThreadId === undefined) {
      return {
        scoped: true,
        runtime: topicBinding?.generalIsDefault
          ? self.getWorkspaceRuntime(workspaceState, TELEGRAM_DEFAULT_WORKSPACE_NAME)
          : undefined,
      };
    }
    const existing = findTelegramWorkspaceByTopic(
      workspaceState.workspaces,
      scope.chatId,
      scope.messageThreadId,
    );
    if (existing) return { scoped: true, runtime: self.getWorkspaceRuntime(workspaceState, existing.name) };
    if (!topicBinding?.autoCreate) return { scoped: true };
    if (Object.keys(workspaceState.workspaces).length >= deps.getConfig().maxWorkspaces) {
      return { scoped: true };
    }
    const record = self.createTelegramTopicWorkspaceRecord(
      workspaceState,
      { chatId: scope.chatId, messageThreadId: scope.messageThreadId },
      ctx,
    );
    workspaceState.workspaces[record.name] = record;
    const runtime = createWorkspaceRuntime(record);
    self.workspaceRuntimes.set(record.name, runtime);
    void self.persist();
    return { scoped: true, runtime };
  };
  self.getActiveRuntime = async (ctx: TContext): Promise<WorkspaceRuntime | undefined> => {
    const workspaceState = await self.ensureState(deps.getCwd(ctx));
    const scoped = await self.resolveScopedTopicRuntime(workspaceState, ctx);
    return scoped.scoped ? scoped.runtime : self.getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
  };
  self.getActiveRuntimeSync = (ctx: TContext): WorkspaceRuntime | undefined => {
    const workspaceState = self.ensureStateSync(deps.getCwd(ctx));
    const scoped = self.resolveScopedTopicRuntimeSync(workspaceState, ctx);
    return scoped.scoped ? scoped.runtime : self.getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
  };
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
  self.commandHandlers = {
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
    abortRuntime: async (
      workspaceState: TelegramWorkspacesState,
      name: string | undefined,
    ): Promise<TelegramWorkspaceAbortResult> => {
      const targetName = name ?? workspaceState.activeWorkspace;
      const runtime = self.getWorkspaceRuntime(workspaceState, targetName);
      if (runtime) {
        const droppedTurns = runtime.pendingCompactionTurns ?? [];
        runtime.pendingCompactionTurns = undefined;
        for (const droppedTurn of droppedTurns) {
          await self.sendTurnTextReply(
            droppedTurn,
            "Aborted; this queued prompt was dropped.",
          ).catch(() => undefined);
        }
      }
      if (!runtime?.backend) {
        return {
          workspaceName: targetName,
          aborted: false,
          message: runtime
            ? `No active worker for ${self.formatRuntimeUserScopeTarget(runtime)}.`
            : `No active worker for workspace ${formatTelegramWorkspaceDisplayName(targetName)}.`,
        };
      }
      let abortError: unknown;
      try {
        await runtime.backend.abort();
      } catch (error) {
        abortError = error;
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: targetName,
          action: "abort",
        });
        await self.disposeRuntimeBackend(runtime).catch((disposeError) => {
          deps.recordRuntimeEvent?.("workspaces", disposeError, {
            workspace: targetName,
            action: "abort_dispose",
          });
        });
      }
      self.stopWorkspaceTyping(runtime);
      await self.markActiveWorkspaceTextStreamAborted(runtime).catch((error) => {
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: targetName,
          action: "stream_abort_mark",
          turnId: runtime.activeTurnId,
        });
      });
      runtime.record.status = "idle";
      runtime.record.lastError = undefined;
      await self.persist();
      return {
        workspaceName: targetName,
        aborted: true,
        message: abortError
          ? `Aborted ${self.formatRuntimeUserScopeTarget(runtime)} after worker stopped responding.`
          : `Aborted ${self.formatRuntimeUserScopeTarget(runtime)}.`,
      };
    },
    abort: async (
      workspaceState: TelegramWorkspacesState,
      name: string | undefined,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const result = await self.commandHandlers.abortRuntime(workspaceState, name);
      await deps.sendTextReply(chatId, replyToMessageId, result.message);
    },
    syncNames: async (
      workspaceState: TelegramWorkspacesState,
      chatId: number,
      replyToMessageId: number,
    ) => {
      let changed = 0;
      for (const record of Object.values(workspaceState.workspaces)) {
        if (record.source?.kind !== "telegram-topic") continue;
        const runtime = self.getWorkspaceRuntime(workspaceState, record.name);
        if (!runtime) continue;
        const didSync = await self.syncTopicSessionNameToWorker(runtime, {
          forceWorker: true,
        });
        if (didSync) changed += 1;
      }
      if (changed > 0) await self.persist();
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        `Synced ${changed} topic session name${changed === 1 ? "" : "s"}.`,
      );
    },
    restart: async (
      workspaceState: TelegramWorkspacesState,
      name: string,
      chatId: number,
      replyToMessageId: number,
      ctx: TContext,
    ) => {
      const runtime = self.getWorkspaceRuntime(workspaceState, name);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown workspace: ${formatTelegramWorkspaceDisplayName(name)}`);
        return;
      }
      await self.disposeRuntimeBackend(runtime);
      try {
        await self.ensureBackend(runtime, ctx);
        await deps.sendTextReply(chatId, replyToMessageId, `Restarted workspace ${formatTelegramWorkspaceDisplayName(name)}.`);
      } catch (error) {
        deps.recordRuntimeEvent?.("workspaces", error, { workspace: name, action: "restart" });
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Workspace ${formatTelegramWorkspaceDisplayName(name)} restart failed: ${getErrorMessage(error)}`,
        );
      }
    },
    topicOrphans: async (
      workspaceState: TelegramWorkspacesState,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const proofs = deps.topicOrphanProofStore?.getProofs() ?? [];
      const provenOrphans: Array<{
        record: TelegramWorkspaceRecord;
        proof: TelegramTopicOrphanProof;
      }> = [];
      const errored: TelegramWorkspaceRecord[] = [];
      const suspected: TelegramWorkspaceRecord[] = [];
      for (const record of getSortedTelegramWorkspaceRecords(workspaceState)) {
        if (record.source?.kind !== "telegram-topic") continue;
        const runtime = self.getWorkspaceRuntime(workspaceState, record.name);
        const proof = proofs.find((item) =>
          isSameTelegramTopicOrphanTarget(item, record.source!)
        );
        if (proof) {
          provenOrphans.push({ record, proof });
        } else if (record.status === "error" && record.lastError) {
          errored.push(record);
        } else if (!self.hasLiveWorker(runtime)) {
          suspected.push(record);
        }
      }
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        [
          "Topic orphan diagnostics:",
          `Proven orphans: ${provenOrphans.length}`,
          ...(provenOrphans.length > 0
            ? provenOrphans.map(({ record, proof }) =>
                formatTelegramWorkspaceOrphanDetail(record, proof)
              )
            : ["- none"]),
          "",
          `Errored topic records: ${errored.length}`,
          ...(errored.length > 0
            ? errored.slice(0, 10).map((record) =>
                formatTelegramWorkspaceOrphanDetail(record)
              )
            : ["- none"]),
          ...(errored.length > 10
            ? [`- ...and ${errored.length - 10} more`]
            : []),
          "",
          `Suspected topic records without workers: ${suspected.length}`,
          ...(suspected.length > 0
            ? suspected.slice(0, 10).map((record) =>
                formatTelegramWorkspaceOrphanDetail(record)
              )
            : ["- none"]),
          ...(suspected.length > 10
            ? [`- ...and ${suspected.length - 10} more`]
            : []),
        ].join("\n"),
      );
    },
    topicCleanup: async (
      workspaceState: TelegramWorkspacesState,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const proofs = deps.topicOrphanProofStore?.getProofs() ?? [];
      const provenOrphans = getSortedTelegramWorkspaceRecords(workspaceState).filter(
        (record) =>
          record.source?.kind === "telegram-topic" &&
          proofs.some((proof) =>
            isSameTelegramTopicOrphanTarget(proof, record.source!)
          ),
      );
      if (provenOrphans.length === 0) {
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          "No proven topic orphans to clean.",
        );
        return;
      }
      for (const record of provenOrphans) {
        const runtime = self.getWorkspaceRuntime(workspaceState, record.name);
        if (runtime) await self.disposeClosingRuntimeBackend(runtime);
        self.workspaceRuntimes.delete(record.name);
        delete workspaceState.workspaces[record.name];
        if (record.source?.kind === "telegram-topic") {
          deps.topicOrphanProofStore?.clearProofsFor(
            record.source.chatId,
            record.source.messageThreadId!,
          );
        }
      }
      if (!workspaceState.workspaces[workspaceState.activeWorkspace]) {
        workspaceState.activeWorkspace = TELEGRAM_DEFAULT_WORKSPACE_NAME;
      }
      deps.debugLogger?.log("telegram.topic.orphan.cleanup", {
        count: provenOrphans.length,
        records: provenOrphans.map((record) => ({
          workspace: record.name,
          chatId: record.source?.chatId,
          messageThreadId: record.source?.messageThreadId,
        })),
      });
      deps.recordRuntimeEvent?.("workspaces", "topic orphan cleanup", {
        action: "topic_cleanup",
        count: provenOrphans.length,
      });
      await self.persist();
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        `Cleaned ${provenOrphans.length} proven topic orphan${provenOrphans.length === 1 ? "" : "s"}. Session files are kept.`,
      );
    },
  };
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
  return {
    isEnabled: self.isEnabled,
    getActiveModel: async (ctx) => {
      if (!self.isEnabled()) return undefined;
      const runtime = await self.getActiveRuntime(ctx);
      if (!runtime) return undefined;
      await self.refreshRuntimeState(runtime);
      return runtime.record.currentModel;
    },
    getActiveThinkingLevel: async (ctx) => {
      if (!self.isEnabled()) return undefined;
      const runtime = await self.getActiveRuntime(ctx);
      if (!runtime) return undefined;
      await self.refreshRuntimeState(runtime);
      const currentThinkingLevel = runtime.record.currentThinkingLevel;
      if (!isThinkingLevel(currentThinkingLevel ?? "")) return undefined;
      return currentThinkingLevel as ThinkingLevel;
    },
    getActiveSessionReference: (ctx) => {
      if (!self.isEnabled()) return undefined;
      const runtime = self.getActiveRuntimeSync(ctx);
      if (!runtime) return undefined;
      return getTelegramWorkspaceSessionReference(runtime.record, deps.getCwd(ctx));
    },
    getActiveResumeSessionScope: (ctx) => {
      if (!self.isEnabled()) return undefined;
      const runtime = self.getActiveRuntimeSync(ctx);
      if (!runtime) return undefined;
      const cwd = runtime.record.cwd || deps.getCwd(ctx);
      return {
        kind: "workspace",
        workspaceName: runtime.record.name,
        cwd,
        sessionDir: deps.getSessionDir?.(ctx) ?? self.configuredSessionDir,
        currentSessionFile: runtime.record.sessionFile,
      };
    },
    getActiveSessionName: (ctx) => {
      if (!self.isEnabled()) return undefined;
      const runtime = self.getActiveRuntimeSync(ctx);
      return runtime?.record.sessionName;
    },
    canSwitchActiveModel: async (ctx) => {
      if (!self.isEnabled()) return false;
      const runtime = await self.getActiveRuntime(ctx);
      if (!runtime) return false;
      await self.refreshRuntimeState(runtime);
      return canSwitchTelegramWorkspaceModel(runtime.record);
    },
    selectActiveModel: async (model, ctx) => {
      if (!self.isEnabled()) return false;
      const runtime = await self.getActiveRuntime(ctx);
      if (!runtime) return false;
      await self.refreshRuntimeState(runtime);
      if (!canSwitchTelegramWorkspaceModel(runtime.record)) return false;
      try {
        const backend = await self.ensureBackend(runtime, ctx);
        await backend.setModel(model.provider, model.id);
        runtime.record.currentModel = {
          provider: model.provider,
          id: model.id,
        };
        await self.refreshRuntimeState(runtime);
        return true;
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "set_model",
        });
        await self.persist();
        return false;
      }
    },
    setActiveThinkingLevel: async (level, ctx) => {
      if (!self.isEnabled()) return undefined;
      const runtime = await self.getActiveRuntime(ctx);
      if (!runtime) return undefined;
      await self.refreshRuntimeState(runtime);
      if (!canSwitchTelegramWorkspaceModel(runtime.record)) return undefined;
      try {
        const backend = await self.ensureBackend(runtime, ctx);
        await backend.setThinkingLevel(level);
        const childState = await backend.getState();
        applyRpcStateToRecord(runtime.record, childState);
        if (!runtime.record.currentThinkingLevel) {
          runtime.record.currentThinkingLevel = level;
        }
        await self.persist();
        return isThinkingLevel(runtime.record.currentThinkingLevel)
          ? runtime.record.currentThinkingLevel
          : undefined;
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "set_thinking_level",
        });
        await self.persist();
        return undefined;
      }
    },
    setActiveSessionName: async (name, ctx) => {
      if (!self.isEnabled()) return false;
      const runtime = await self.getActiveRuntime(ctx);
      if (!runtime) return false;
      const normalizedName = normalizeTelegramWorkspaceSessionName(name);
      if (normalizedName === undefined) {
        delete runtime.record.sessionName;
      } else {
        runtime.record.sessionName = normalizedName;
      }
      await self.persist();
      try {
        const backend = await self.ensureBackend(runtime, ctx);
        await backend.setSessionName(name);
        const childState = await backend.getState();
        applyRpcStateToRecord(runtime.record, childState);
        if (
          normalizedName === undefined &&
          childState.sessionName === undefined
        ) {
          delete runtime.record.sessionName;
        }
        await self.persist();
      } catch (error) {
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "set_session_name",
        });
      }
      return true;
    },
    compactActive: (ctx, callbacks) => {
      if (!self.isEnabled()) return false;
      const runtime = self.getActiveRuntimeSync(ctx);
      if (!runtime) return false;
      if (
        runtime.record.status === "running" ||
        runtime.record.status === "starting"
      ) {
        throw new Error(self.formatRuntimeBusyMessage(runtime));
      }
      void (async () => {
        try {
          runtime.record.status = "starting";
          runtime.record.lastError = undefined;
          runtime.record.lastUsedAt = self.now();
          await self.persist();
          const backend = await self.ensureBackend(runtime, ctx);
          await backend.compact();
          const childState = await backend.getState();
          applyRpcStateToRecord(runtime.record, childState);
          runtime.record.status =
            childState.isStreaming === true || childState.isCompacting === true
              ? "running"
              : "idle";
          runtime.record.lastUsedAt = self.now();
          await self.persist();
          callbacks.onComplete();
          await self.flushPendingCompactionTurns(runtime, ctx);
        } catch (error) {
          runtime.record.status = "error";
          runtime.record.lastError = getErrorMessage(error);
          deps.recordRuntimeEvent?.("workspaces", error, {
            workspace: runtime.record.name,
            action: "compact",
          });
          await self.persist();
          callbacks.onError(error);
          const droppedTurns = runtime.pendingCompactionTurns ?? [];
          self.clearPendingCompactionTurns(runtime);
          for (const droppedTurn of droppedTurns) {
            await self.sendTurnTextReply(
              droppedTurn,
              "Compaction failed; this queued prompt was dropped. Resend after the worker recovers.",
            ).catch(() => undefined);
          }
        }
      })();
      return true;
    },
    newActiveSession: async (ctx) => {
      if (!self.isEnabled()) return undefined;
      const runtime = await self.getActiveRuntime(ctx);
      if (!runtime) return undefined;
      await self.refreshRuntimeState(runtime);
      if (
        runtime.record.status === "running" ||
        runtime.record.status === "starting"
      ) {
        throw new Error(self.formatRuntimeBusyMessage(runtime));
      }
      try {
        const backend = await self.ensureBackend(runtime, ctx);
        const result = await backend.newSession();
        if (result.cancelled) return { cancelled: true };
        const topicSessionName = getTelegramTopicSessionName(runtime.record);
        if (topicSessionName) {
          await self.syncTopicSessionNameToWorker(runtime, { forceWorker: true });
        }
        const childState = await backend.getState();
        applyRpcStateToRecord(runtime.record, childState);
        if (topicSessionName) {
          runtime.record.sessionName = topicSessionName;
        } else {
          const sessionName =
            typeof childState.sessionName === "string"
              ? childState.sessionName.trim()
              : undefined;
          if (sessionName) {
            runtime.record.sessionName = sessionName;
          } else {
            delete runtime.record.sessionName;
          }
        }
        runtime.record.lastAssistantText = undefined;
        runtime.record.lastMessageText = undefined;
        runtime.record.lastMessageAt = undefined;
        runtime.record.lastAgentStartAt = undefined;
        runtime.record.lastAgentEndAt = undefined;
        runtime.record.lastError = undefined;
        runtime.record.status = childState.isStreaming === true ? "running" : "idle";
        runtime.record.lastUsedAt = self.now();
        resetRuntimeTurnBuffers(runtime);
        await self.persist();
        return { cancelled: false };
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "new_session",
        });
        await self.persist();
        throw error;
      }
    },
    deleteActiveSession: async (expectedSessionPath, ctx) => {
      if (!self.isEnabled()) return undefined;
      const workspaceState = await self.ensureState(deps.getCwd(ctx));
      const scoped = await self.resolveScopedTopicRuntime(workspaceState, ctx);
      const runtime = scoped.scoped
        ? scoped.runtime
        : self.getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
      if (!runtime) return undefined;
      await self.refreshRuntimeState(runtime);
      if (!canSwitchTelegramWorkspaceModel(runtime.record)) {
        throw new Error(self.formatRuntimeStopFirstMessage(runtime));
      }
      const sessionPath = runtime.record.sessionFile;
      if (!sessionPath) {
        throw new Error("current session is not persisted");
      }
      if (
        expectedSessionPath &&
        !isSameTelegramWorkspaceSessionFile(expectedSessionPath, sessionPath)
      ) {
        throw new Error("current session changed before deletion");
      }
      await self.assertNoOpenSessionConflict(workspaceState, runtime, runtime.record);
      try {
        const backend = await self.ensureBackend(runtime, ctx);
        const result = await backend.newSession(sessionPath);
        if (result.cancelled) {
          throw new Error("newSession cancelled");
        }
        const childState = await backend.getState();
        applyRpcStateToRecord(runtime.record, childState);
        if (
          !runtime.record.sessionFile ||
          isSameTelegramWorkspaceSessionFile(runtime.record.sessionFile, sessionPath)
        ) {
          throw new Error("new session did not replace current session");
        }
        runtime.record.lastAssistantText = undefined;
        runtime.record.lastMessageText = undefined;
        runtime.record.lastMessageAt = undefined;
        runtime.record.lastAgentStartAt = undefined;
        runtime.record.lastAgentEndAt = undefined;
        runtime.record.lastError = undefined;
        runtime.record.status = childState.isStreaming === true ? "running" : "idle";
        runtime.record.lastUsedAt = self.now();
        resetRuntimeTurnBuffers(runtime);
        await self.persist();
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "delete_session",
        });
        await self.persist();
        throw error;
      }
      try {
        await (deps.deleteSessionFile ?? unlink)(sessionPath);
      } catch (error) {
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "delete_session_file",
        });
        throw error;
      }
      return true;
    },
    abortActive: async (ctx) => {
      if (!self.isEnabled()) return undefined;
      const workspaceState = await self.ensureState(deps.getCwd(ctx));
      const scoped = await self.resolveScopedTopicRuntime(workspaceState, ctx);
      return self.commandHandlers.abortRuntime(workspaceState, scoped.runtime?.record.name);
    },
    switchSession: async (sessionPath, ctx, scope) => {
      if (!self.isEnabled() || scope?.kind !== "workspace" || !scope.workspaceName) {
        return false;
      }
      const workspaceState = await self.ensureState(deps.getCwd(ctx));
      const runtime = self.getWorkspaceRuntime(workspaceState, scope.workspaceName);
      if (!runtime) {
        throw new Error(`Unknown workspace: ${formatTelegramWorkspaceDisplayName(scope.workspaceName)}`);
      }
      await self.refreshRuntimeState(runtime);
      if (!canSwitchTelegramWorkspaceModel(runtime.record)) {
        throw new Error(self.formatScopedWorkspaceBusyMessage(scope.workspaceName));
      }
      await self.assertNoOpenSessionConflict(workspaceState, runtime, {
        sessionFile: sessionPath,
      });
      try {
        const backend = await self.ensureBackend(runtime, ctx);
        const result = await backend.switchSession(sessionPath);
        if (result.cancelled) {
          throw new Error("switchSession cancelled");
        }
        const topicSessionName = getTelegramTopicSessionName(runtime.record);
        if (topicSessionName) {
          await self.syncTopicSessionNameToWorker(runtime, { forceWorker: true });
        }
        self.stopWorkspaceTyping(runtime);
        resetRuntimeTurnBuffers(runtime);
        delete runtime.record.lastAssistantText;
        delete runtime.record.lastMessageText;
        delete runtime.record.lastMessageAt;
        runtime.record.sessionFile = sessionPath;
        runtime.record.lastError = undefined;
        const childState = await self.refreshRuntimeState(runtime);
        if (!isSameTelegramWorkspaceSessionFile(childState?.sessionFile, sessionPath)) {
          const reported = childState?.sessionFile ?? "(none)";
          deps.recordRuntimeEvent?.(
            "workspaces",
            new Error(
              `RPC worker reported ${reported} after switch_session ${sessionPath}; restarting worker on target session.`,
            ),
            {
              workspace: runtime.record.name,
              action: "switch_session_rebind",
            },
          );
          await self.disposeRuntimeBackend(runtime);
          runtime.record.sessionFile = sessionPath;
          runtime.record.status = "starting";
          runtime.record.lastError = undefined;
          delete runtime.record.sessionId;
          delete runtime.record.sessionName;
          await self.persist();
          await self.ensureBackend(runtime, ctx);
          if (!isSameTelegramWorkspaceSessionFile(runtime.record.sessionFile, sessionPath)) {
            throw new Error(
              self.formatRuntimeSessionBindFailureMessage(scope.workspaceName, sessionPath),
            );
          }
          const topicSessionNameAfterRestart = getTelegramTopicSessionName(
            runtime.record,
          );
          if (topicSessionNameAfterRestart && runtime.backend) {
            await self.syncTopicSessionNameToWorker(runtime, { forceWorker: true });
          }
        }
        const topicSessionNameAfterSwitch = getTelegramTopicSessionName(
          runtime.record,
        );
        if (topicSessionNameAfterSwitch) {
          runtime.record.sessionName = topicSessionNameAfterSwitch;
        }
        runtime.record.lastUsedAt = self.now();
        await self.persist();
        return true;
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "switch_session",
        });
        await self.persist();
        throw error;
      }
    },
    createActiveTreeBranch: async (entryId, ctx) => {
      if (!self.isEnabled()) return undefined;
      const runtime = await self.getActiveRuntime(ctx);
      if (!runtime) return undefined;
      await self.refreshRuntimeState(runtime);
      if (!canSwitchTelegramWorkspaceModel(runtime.record)) {
        throw new Error(self.formatRuntimeAbortFirstMessage(runtime));
      }
      try {
        if (!deps.createTreeBranch) {
          throw new Error(self.formatRuntimeTreeBranchUnavailableMessage());
        }
        const result = await deps.createTreeBranch(
          getTelegramWorkspaceSessionReference(runtime.record, deps.getCwd(ctx)),
          entryId,
        );
        if (result.cancelled) return result;
        await self.disposeRuntimeBackend(runtime);
        resetRuntimeTurnBuffers(runtime);
        delete runtime.record.lastAssistantText;
        delete runtime.record.lastMessageText;
        delete runtime.record.lastMessageAt;
        delete runtime.record.lastAgentStartAt;
        delete runtime.record.lastAgentEndAt;
        runtime.record.lastError = undefined;
        runtime.record.status = "idle";
        runtime.record.lastUsedAt = self.now();
        await self.persist();
        return result;
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "create_tree_branch",
        });
        await self.persist();
        throw error;
      }
    },
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
