/**
 * Workspace runtime shared-context type: the self object that all installers populate
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type {
  RpcChildBackendEvent,
  RpcChildSessionState,
} from "./rpc-child.ts";
import type {
  TelegramWorkspaceAbortResult,
  TelegramWorkspaceBackend,
  TelegramWorkspaceDashboardMode,
  TelegramWorkspaceDashboardState,
  TelegramWorkspaceDashboardWorkerState,
  TelegramWorkspaceForumTopicServiceMessage,
  TelegramWorkspacePromptTurn,
  TelegramWorkspaceSessionIdentity,
  TelegramWorkspaceStreamDeliveryResult,
  TelegramWorkspaceStreamState,
  TelegramWorkspaceToolStatusKind,
  WorkspaceRuntime,
} from "./workspace-manager-types.ts";
import type {
  TelegramWorkspaceRecord,
  TelegramWorkspacesState,
} from "./workspaces.ts";

export interface WsRuntimeContext<TContext> {
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
  streamActiveWorkspaceCompactToolStatus: (workspaceState: TelegramWorkspacesState, workspaceName: string, runtime: WorkspaceRuntime, preview: { key: string; markdown: string; name?: string; summary?: string; status: TelegramWorkspaceToolStatusKind; }) => void;
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
  handleRalphAgentEnd?: (workspaceName: string, runtime: WorkspaceRuntime, finalText: string, stopReason: "ok" | "error" | "aborted") => void;
  flushPendingCompactionTurns: (runtime: WorkspaceRuntime, ctx: TContext) => Promise<void>;
  clearPendingCompactionTurns: (runtime: WorkspaceRuntime) => number;
}
