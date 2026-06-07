/**
 * Telegram workspace runtime
 * Zones: telegram controls, pi agent, process lifecycle
 * Owns durable workspace registry loading, per-workspace RPC backend orchestration, and text-first Telegram delivery
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  extractRpcTextDelta,
  RpcChildBackend,
  type RpcChildBackendEvent,
  type RpcChildBackendOptions,
  type RpcChildSessionState,
} from "./rpc-child.ts";
import {
  extractLatestAssistantMessageText,
  formatAgentThinkingBlock,
  formatAgentToolCallBlock,
  getAgentMessageBodyText,
  getAgentMessagePreviewText,
  isAssistantAgentMessage,
  type TelegramRenderedChunk,
  type TelegramRenderMode,
} from "./replies.ts";
import {
  createDefaultTelegramWorkspacesState,
  filterTelegramWorkspaceRecords,
  findTelegramWorkspaceByTopic,
  findTelegramWorkspaceNameCaseConflict,
  formatTelegramWorkspaceDisplayName,
  formatTelegramWorkspaceFilterSummary,
  formatTelegramWorkspaceList,
  formatTelegramWorkspaceRecordDisplayName,
  formatTelegramWorkspaceStatus,
  formatTelegramWorkspaceStatusLabel,
  formatTelegramWorkspaceUsage,
  normalizeTelegramWorkspaceName,
  normalizeTelegramWorkspacesState,
  normalizeTelegramTopicWorkspaceName,
  parseTelegramWorkspaceCommand,
  TELEGRAM_DEFAULT_WORKSPACE_NAME,
  truncateTelegramWorkspaceText,
  validateTelegramWorkspaceName,
  type TelegramWorkspaceFilterTraceItem,
  type TelegramWorkspaceRecord,
  type TelegramWorkspaceSourceTelegramTopic,
  type TelegramWorkspacesState,
} from "./workspaces.ts";
import type { TelegramNormalizedConcurrentWorkspacesConfig } from "./config.ts";
import { isTelegramForumTopicPermissionError } from "./api.ts";
import { isThinkingLevel, type ThinkingLevel } from "./model.ts";
import { getTelegramAgentDir, isTelegramTrustedChat } from "./config.ts";
import type { TelegramDebugLogger } from "./debug.ts";
import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import {
  isSameTelegramTopicOrphanTarget,
  type TelegramTopicOrphanProof,
  type TelegramTopicOrphanProofStore,
} from "./topic-orphans.ts";
import {
  getAmbientTelegramThreadContext,
  getTelegramForumThreadMessageThreadId,
  getTelegramForumTopicMessageThreadId,
  normalizeTelegramForumThread,
  runWithTelegramThreadContext,
} from "./thread-context.ts";

const TELEGRAM_WORKSPACE_STREAM_EDIT_THROTTLE_MS = 10_000;
const TELEGRAM_WORKSPACE_STREAM_FAILURE_BASE_RETRY_MS = 30_000;
const TELEGRAM_WORKSPACE_STREAM_FAILURE_MAX_RETRY_MS = 10 * 60 * 1000;
const TELEGRAM_WORKSPACE_STREAM_MARKDOWN_LIMIT = 3600;
const TELEGRAM_WORKSPACE_TYPING_ACTION_INTERVAL_MS = 8_000;
const TELEGRAM_WORKSPACE_DASHBOARD_STATE_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_WORKSPACE_TOOL_STATUS_MAX_ENTRIES = 6;
const TELEGRAM_FORUM_NATIVE_WORKSPACE_LIFECYCLE_DISABLED_MESSAGE =
  "Forum-native mode is enabled. Use Telegram topics to create, switch, and close workspaces.";

function getTelegramWorkspaceBooleanEnv(
  name: string,
  defaultValue: boolean,
): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return defaultValue;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return defaultValue;
}

type TelegramWorkspaceToolPreviewMode = "off" | "stream" | "compact";

function getTelegramWorkspaceToolPreviewMode(): TelegramWorkspaceToolPreviewMode {
  const value = process.env.PI_TELEGRAM_TOOL_PREVIEW_MODE?.trim().toLowerCase();
  if (value === "compact" || value === "summary") return "compact";
  if (value === "stream" || value === "full" || value === "on") return "stream";
  if (value === "off" || value === "0" || value === "false") return "off";
  return getTelegramWorkspaceBooleanEnv("PI_TELEGRAM_TOOL_PREVIEWS", true)
    ? "stream"
    : "off";
}

export interface TelegramWorkspacePromptContent {
  type: string;
  text?: string;
}

export interface TelegramWorkspacePromptTurn {
  chatId: number;
  messageThreadId?: number;
  replyToMessageId: number;
  content: readonly TelegramWorkspacePromptContent[];
  statusSummary?: string;
}

export interface TelegramWorkspaceForumTopicServiceMessage {
  chat: { id?: number };
  message_id?: number;
  message_thread_id?: number;
  forum_topic_created?: { name: string };
  forum_topic_edited?: { name?: string };
  forum_topic_closed?: Record<string, never>;
  forum_topic_reopened?: Record<string, never>;
  general_forum_topic_hidden?: Record<string, never>;
  general_forum_topic_unhidden?: Record<string, never>;
}

export interface TelegramWorkspaceBackend {
  start: () => Promise<RpcChildSessionState>;
  dispose: () => Promise<void>;
  onEvent: (listener: (event: RpcChildBackendEvent) => void) => () => void;
  prompt: (message: string) => Promise<void>;
  followUp: (message: string) => Promise<void>;
  abort: () => Promise<void>;
  compact: () => Promise<void>;
  newSession: (parentSession?: string) => Promise<{ cancelled: boolean }>;
  switchSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
  getState: () => Promise<RpcChildSessionState>;
  setModel: (provider: string, modelId: string) => Promise<void>;
  setThinkingLevel: (level: string) => Promise<void>;
  setSessionName: (name: string) => Promise<void>;
}

export interface TelegramWorkspaceModelSelection {
  provider: string;
  id: string;
}

export interface TelegramWorkspaceSessionReference {
  workspaceName: string;
  cwd: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  currentModel?: TelegramWorkspaceModelSelection;
}

export interface TelegramWorkspaceResumeSessionScope {
  kind: "workspace";
  workspaceName: string;
  cwd: string;
  sessionDir?: string;
  currentSessionFile?: string;
}

export interface TelegramWorkspaceAbortResult {
  workspaceName: string;
  aborted: boolean;
  message: string;
}

export interface TelegramWorkspaceTreeBranchResult {
  text?: string;
  cancelled: boolean;
  markerId?: string;
}

export interface TelegramWorkspaceManagerDeps<TContext> {
  getConfig: () => TelegramNormalizedConcurrentWorkspacesConfig;
  getCwd: (ctx: TContext) => string;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
  ) => Promise<number | undefined>;
  sendMarkdownReply?: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
  ) => Promise<number | undefined>;
  sendStreamMarkdownReply?: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
  ) => Promise<number | undefined>;
  editStreamMarkdownMessage?: (
    chatId: number,
    messageId: number,
    markdown: string,
  ) => Promise<number | undefined>;
  deleteMessage?: (chatId: number, messageId: number) => Promise<unknown>;
  sendInteractiveMessage?: (
    chatId: number,
    text: string,
    mode: "html" | "plain",
    replyMarkup: TelegramInlineKeyboardMarkup,
  ) => Promise<number | undefined>;
  editInteractiveMessage?: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "html" | "plain",
    replyMarkup: TelegramInlineKeyboardMarkup,
  ) => Promise<void>;
  answerCallbackQuery?: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  sendLastTurnsOnSwitch?: (
    reference: TelegramWorkspaceSessionReference,
    chatId: number,
    replyToMessageId: number,
  ) => Promise<void>;
  streamEditThrottleMs?: number;
  streamFailureBaseRetryMs?: number;
  streamFailureMaxRetryMs?: number;
  sendTypingAction?: (chatId: number) => Promise<unknown>;
  typingIntervalMs?: number;
  now?: () => number;
  agentDir?: string;
  statePath?: string;
  sessionDir?: string;
  getSessionDir?: (ctx: TContext) => string | undefined;
  createBackend?: (options: RpcChildBackendOptions) => TelegramWorkspaceBackend;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  debugLogger?: TelegramDebugLogger;
  createTreeBranch?: (
    reference: TelegramWorkspaceSessionReference,
    entryId: string,
  ) => Promise<TelegramWorkspaceTreeBranchResult> | TelegramWorkspaceTreeBranchResult;
  deleteSessionFile?: (sessionPath: string) => Promise<void>;
  deleteForumTopic?: (
    chatId: number,
    messageThreadId: number,
  ) => Promise<boolean>;
  topicOrphanProofStore?: TelegramTopicOrphanProofStore;
}

interface WorkspaceRuntime {
  record: TelegramWorkspaceRecord;
  backend?: TelegramWorkspaceBackend;
  closing?: boolean;
  unreadEvents: number;
  activeBuffer: string;
  activeAssistantText?: string;
  activeErrorDelivered?: boolean;
  streamDeliveryFailureCount?: number;
  streamDeliveryBlockedUntil?: number;
  lastStreamFlushAt?: number;
  textStream?: TelegramWorkspaceStreamState;
  thinkingBuffers: Map<number, string>;
  thinkingStreams: Map<number, TelegramWorkspaceStreamState>;
  toolCallStreams: Map<number, TelegramWorkspaceStreamState>;
  toolCallStatusStream?: TelegramWorkspaceStreamState;
  toolCallStatuses: Map<string, TelegramWorkspaceToolStatusEntry>;
  sentThinkingTexts: Set<string>;
  sentToolCallMessages: Set<string>;
  postRunMessages: TelegramWorkspacePostRunMessage[];
  typingChatId?: number;
  typingMessageThreadId?: number;
  typingInterval?: ReturnType<typeof setInterval>;
  activeChatId?: number;
  activeMessageThreadId?: number;
  activeReplyToMessageId?: number;
  activeTopicDelivery?: boolean;
  activeTurnId?: string;
  promptStartedAt?: number;
  promptSentAt?: number;
  agentStartedAt?: number;
  firstOutputAt?: number;
  firstOutputLogged?: boolean;
  pendingCompactionTurns?: TelegramWorkspacePromptTurn[];
  unsubscribe?: () => void;
}

type TelegramWorkspaceToolStatusKind = "queued" | "running" | "done" | "failed";

type TelegramWorkspacePostRunMessageKind = "thinking" | "tool" | "text";

interface TelegramWorkspacePostRunMessage {
  kind: TelegramWorkspacePostRunMessageKind;
  markdown: string;
  stream?: TelegramWorkspaceStreamState;
}

interface TelegramWorkspaceToolStatusEntry {
  key: string;
  markdown: string;
  status: TelegramWorkspaceToolStatusKind;
  updatedAt: number;
}

type TelegramWorkspaceDashboardMode = "open" | "close";

interface TelegramWorkspaceDashboardState {
  chatId: number;
  messageId: number;
  mode: TelegramWorkspaceDashboardMode;
  selectedCloseWorkspaces: string[];
  updatedAt: number;
}

interface TelegramWorkspaceStreamState {
  markdown: string;
  sentMarkdown: string;
  lastFlushAt: number;
  failedFlushCount?: number;
  nextFlushAt?: number;
  messageId?: number;
  turnId?: string;
  chatId?: number;
  messageThreadId?: number;
  replyToMessageId?: number;
  flushTimer?: ReturnType<typeof setTimeout>;
  flushPromise?: Promise<TelegramWorkspaceStreamDeliveryResult>;
  flushRequested?: boolean;
  suppressRetryOnFailure?: boolean;
}

type TelegramWorkspaceStreamDeliveryResult =
  | {
      status: "delivered";
      sentMarkdown: string;
      messageId?: number;
      stale: boolean;
    }
  | { status: "scheduled"; reason: string; retryAt?: number; stale: boolean }
  | { status: "skipped"; reason: string; stale: boolean }
  | { status: "failed"; error?: string; stale: boolean };

export interface TelegramWorkspaceMarkdownMessageEditorDeps {
  renderTelegramMessage: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
  editRenderedMessage: (
    chatId: number,
    messageId: number,
    chunks: TelegramRenderedChunk[],
    options?: { disableLinkPreview?: boolean },
  ) => Promise<number | undefined>;
}

export function createTelegramWorkspaceMarkdownMessageEditor(
  deps: TelegramWorkspaceMarkdownMessageEditorDeps,
): (chatId: number, messageId: number, markdown: string) => Promise<number | undefined> {
  return (chatId, messageId, markdown) =>
    deps.editRenderedMessage(
      chatId,
      messageId,
      deps.renderTelegramMessage(markdown, { mode: "markdown" }),
      { disableLinkPreview: true },
    );
}

export interface TelegramWorkspaceManager<TContext> {
  isEnabled: () => boolean;
  getActiveModel: (
    ctx: TContext,
  ) => Promise<TelegramWorkspaceModelSelection | undefined>;
  getActiveThinkingLevel: (ctx: TContext) => Promise<ThinkingLevel | undefined>;
  getActiveSessionReference: (
    ctx: TContext,
  ) => TelegramWorkspaceSessionReference | undefined;
  getActiveResumeSessionScope: (
    ctx: TContext,
  ) => TelegramWorkspaceResumeSessionScope | undefined;
  getActiveSessionName: (ctx: TContext) => string | undefined;
  canSwitchActiveModel: (ctx: TContext) => Promise<boolean>;
  selectActiveModel: (
    model: TelegramWorkspaceModelSelection,
    ctx: TContext,
  ) => Promise<boolean>;
  setActiveThinkingLevel: (
    level: ThinkingLevel,
    ctx: TContext,
  ) => Promise<ThinkingLevel | undefined>;
  setActiveSessionName: (name: string, ctx: TContext) => Promise<boolean>;
  compactActive: (
    ctx: TContext,
    callbacks: { onComplete: () => void; onError: (error: unknown) => void },
  ) => boolean;
  newActiveSession: (
    ctx: TContext,
  ) => Promise<{ cancelled: boolean } | undefined>;
  deleteActiveSession: (
    expectedSessionPath: string,
    ctx: TContext,
  ) => Promise<boolean | undefined>;
  abortActive: (ctx: TContext) => Promise<TelegramWorkspaceAbortResult | undefined>;
  switchSession: (
    sessionPath: string,
    ctx: TContext,
    scope?: { kind?: string; workspaceName?: string },
  ) => Promise<boolean>;
  createActiveTreeBranch: (
    entryId: string,
    ctx: TContext,
  ) => Promise<TelegramWorkspaceTreeBranchResult | undefined>;
  handleCommand: (
    args: string,
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<boolean>;
  handleTopicCommand?: (
    args: string,
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<boolean>;
  handleCallbackQuery: (
    query: TelegramWorkspaceCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
  handleTopicServiceMessage: (
    message: TelegramWorkspaceForumTopicServiceMessage,
    ctx: TContext,
  ) => Promise<boolean>;
  dispatchPrompt: (turn: TelegramWorkspacePromptTurn, ctx: TContext) => Promise<boolean>;
  dispose: () => Promise<void>;
}

export interface TelegramWorkspaceCallbackQuery {
  id: string;
  data?: string;
  message?: { chat?: { id?: number }; message_id?: number };
}

export interface TelegramWorkspaceAwareModelMenuPorts<
  TContext,
  TModel extends TelegramWorkspaceModelSelection,
> {
  getActiveModel: (ctx: TContext) => Promise<TModel | undefined>;
  canSwitchModel: (ctx: TContext) => Promise<boolean> | boolean;
  canOfferInFlightModelSwitch: (ctx: TContext) => boolean;
}

export interface TelegramWorkspaceAwareModelMenuPortDeps<
  TContext,
  TModel extends TelegramWorkspaceModelSelection,
> {
  workspaceManager: TelegramWorkspaceManager<TContext>;
  getParentModel: (ctx: TContext) => TModel | undefined;
  findModel: (
    identity: TelegramWorkspaceModelSelection,
    ctx: TContext,
  ) => TModel | undefined;
  isParentIdle: (ctx: TContext) => boolean;
  canOfferParentInFlightModelSwitch: (ctx: TContext) => boolean;
}

export interface TelegramWorkspaceAwareSessionSnapshotPorts<TContext, TSnapshot> {
  getSnapshot: (ctx: TContext) => TSnapshot;
  canDeleteCurrent: (snapshot: unknown, ctx: TContext) => boolean;
  isReadOnly: (snapshot: unknown, ctx: TContext) => boolean;
}

export interface TelegramWorkspaceAwareSessionSnapshotPortDeps<TContext, TSnapshot> {
  workspaceManager: TelegramWorkspaceManager<TContext>;
  getParentSnapshot: (ctx: TContext) => TSnapshot;
  getWorkspaceSnapshot: (
    reference: TelegramWorkspaceSessionReference,
    ctx: TContext,
  ) => TSnapshot;
}

export function createTelegramWorkspaceAwareSessionSnapshotPorts<TContext, TSnapshot>(
  deps: TelegramWorkspaceAwareSessionSnapshotPortDeps<TContext, TSnapshot>,
): TelegramWorkspaceAwareSessionSnapshotPorts<TContext, TSnapshot> {
  const isActiveWorkspaceSession = (ctx: TContext): boolean =>
    deps.workspaceManager.getActiveSessionReference(ctx) !== undefined;
  const hasSessionFile = (snapshot: unknown): boolean =>
    typeof (snapshot as { sessionFile?: unknown }).sessionFile === "string" &&
    ((snapshot as { sessionFile?: string }).sessionFile?.length ?? 0) > 0;
  return {
    getSnapshot: (ctx) => {
      const reference = deps.workspaceManager.getActiveSessionReference(ctx);
      return reference
        ? deps.getWorkspaceSnapshot(reference, ctx)
        : deps.getParentSnapshot(ctx);
    },
    canDeleteCurrent: (snapshot, _ctx) => hasSessionFile(snapshot),
    isReadOnly: (_snapshot, ctx) => isActiveWorkspaceSession(ctx),
  };
}

export interface TelegramWorkspaceAwareSessionNamePorts<TContext> {
  getSessionName: (ctx: TContext) => string | undefined;
  setSessionName: (name: string, ctx: TContext) => void | Promise<void>;
}

export interface TelegramWorkspaceAwareSessionNamePortDeps<TContext> {
  workspaceManager: TelegramWorkspaceManager<TContext>;
  getParentSessionName: (ctx: TContext) => string | undefined;
  setParentSessionName: (
    name: string,
    ctx: TContext,
  ) => void | Promise<void>;
}

export function createTelegramWorkspaceAwareSessionNamePorts<TContext>(
  deps: TelegramWorkspaceAwareSessionNamePortDeps<TContext>,
): TelegramWorkspaceAwareSessionNamePorts<TContext> {
  return {
    getSessionName: (ctx) => {
      const reference = deps.workspaceManager.getActiveSessionReference(ctx);
      return reference
        ? reference.sessionName
        : deps.getParentSessionName(ctx);
    },
    setSessionName: async (name, ctx) => {
      const reference = deps.workspaceManager.getActiveSessionReference(ctx);
      if (reference) {
        const handled = await deps.workspaceManager.setActiveSessionName(name, ctx);
        if (handled) return;
      }
      await deps.setParentSessionName(name, ctx);
    },
  };
}

export interface TelegramWorkspaceAwareCompactPorts<TContext> {
  compact: (
    ctx: TContext,
    callbacks: { onComplete: () => void; onError: (error: unknown) => void },
  ) => void;
}

export interface TelegramWorkspaceAwareCompactPortDeps<TContext> {
  workspaceManager: TelegramWorkspaceManager<TContext>;
  compactParent: (
    ctx: TContext,
    callbacks: { onComplete: () => void; onError: (error: unknown) => void },
  ) => void;
}

export function createTelegramWorkspaceAwareCompactPorts<TContext>(
  deps: TelegramWorkspaceAwareCompactPortDeps<TContext>,
): TelegramWorkspaceAwareCompactPorts<TContext> {
  return {
    compact: (ctx, callbacks) => {
      const handled = deps.workspaceManager.compactActive(ctx, callbacks);
      if (!handled) deps.compactParent(ctx, callbacks);
    },
  };
}

export interface TelegramWorkspaceAwareNewSessionPorts<TContext> {
  injectNewSession: (ctx: TContext) => Promise<boolean>;
}

export interface TelegramWorkspaceAwareNewSessionPortDeps<TContext> {
  workspaceManager: TelegramWorkspaceManager<TContext>;
  injectParentNewSession: () => Promise<void>;
}

export function createTelegramWorkspaceAwareNewSessionPorts<TContext>(
  deps: TelegramWorkspaceAwareNewSessionPortDeps<TContext>,
): TelegramWorkspaceAwareNewSessionPorts<TContext> {
  return {
    injectNewSession: async (ctx) => {
      const result = await deps.workspaceManager.newActiveSession(ctx);
      if (result !== undefined) return !result.cancelled;
      await deps.injectParentNewSession();
      return true;
    },
  };
}

export interface TelegramWorkspaceAwareSessionDeletePorts<TContext> {
  injectDeleteCurrentSession: (
    expectedSessionPath: string,
    ctx: TContext,
  ) => Promise<void>;
}

export interface TelegramWorkspaceAwareSessionDeletePortDeps<TContext> {
  workspaceManager: TelegramWorkspaceManager<TContext>;
  injectParentDeleteCurrentSession: (expectedSessionPath: string) => Promise<void>;
}

export function createTelegramWorkspaceAwareSessionDeletePorts<TContext>(
  deps: TelegramWorkspaceAwareSessionDeletePortDeps<TContext>,
): TelegramWorkspaceAwareSessionDeletePorts<TContext> {
  return {
    injectDeleteCurrentSession: async (expectedSessionPath, ctx) => {
      const handled = await deps.workspaceManager.deleteActiveSession(
        expectedSessionPath,
        ctx,
      );
      if (handled) return;
      await deps.injectParentDeleteCurrentSession(expectedSessionPath);
    },
  };
}

export interface TelegramWorkspaceAwareResumeMenuPorts<TContext> {
  getSessionScope: (
    ctx: TContext,
  ) => TelegramWorkspaceResumeSessionScope | undefined;
  injectResumeExec: (
    sessionPath: string,
    ctx: TContext,
    sessionScope?: { kind?: string; workspaceName?: string },
  ) => Promise<void>;
}

export interface TelegramWorkspaceAwareResumeMenuPortDeps<TContext> {
  workspaceManager: TelegramWorkspaceManager<TContext>;
  injectParentResumeExec: (sessionPath: string) => Promise<void>;
}

export function createTelegramWorkspaceAwareResumeMenuPorts<TContext>(
  deps: TelegramWorkspaceAwareResumeMenuPortDeps<TContext>,
): TelegramWorkspaceAwareResumeMenuPorts<TContext> {
  return {
    getSessionScope: (ctx) =>
      deps.workspaceManager.isEnabled()
        ? deps.workspaceManager.getActiveResumeSessionScope(ctx)
        : undefined,
    injectResumeExec: async (sessionPath, ctx, sessionScope) => {
      if (!deps.workspaceManager.isEnabled()) {
        await deps.injectParentResumeExec(sessionPath);
        return;
      }
      const activeScope =
        sessionScope?.kind === "workspace" && sessionScope.workspaceName
          ? sessionScope
          : deps.workspaceManager.getActiveResumeSessionScope(ctx);
      if (!activeScope) {
        throw new Error("No active workspace session scope for /resume.");
      }
      const handled = await deps.workspaceManager.switchSession(
        sessionPath,
        ctx,
        activeScope,
      );
      if (!handled) {
        throw new Error("Active workspace did not handle /resume.");
      }
    },
  };
}

export interface TelegramWorkspaceAwareTreeMenuPorts<TContext> {
  isReadOnly: (snapshot: unknown, ctx: TContext) => boolean;
  canForkTree: (snapshot: unknown, ctx: TContext) => boolean;
  injectTreeExec: (
    entryId: string,
    summarize: boolean,
    ctx: TContext,
  ) => Promise<void>;
  forkTreeEntry: (
    entryId: string,
    ctx: TContext,
  ) => Promise<TelegramWorkspaceTreeBranchResult>;
}

export interface TelegramWorkspaceAwareTreeMenuPortDeps<TContext> {
  workspaceManager: TelegramWorkspaceManager<TContext>;
  injectParentTreeExec: (entryId: string, summarize: boolean) => Promise<void>;
}

export function createTelegramWorkspaceAwareTreeMenuPorts<TContext>(
  deps: TelegramWorkspaceAwareTreeMenuPortDeps<TContext>,
): TelegramWorkspaceAwareTreeMenuPorts<TContext> {
  const isActiveWorkspaceSession = (ctx: TContext): boolean =>
    deps.workspaceManager.getActiveSessionReference(ctx) !== undefined;
  return {
    isReadOnly: (_snapshot, ctx) => isActiveWorkspaceSession(ctx),
    canForkTree: (_snapshot, ctx) => isActiveWorkspaceSession(ctx),
    injectTreeExec: async (entryId, summarize, ctx) => {
      if (isActiveWorkspaceSession(ctx)) {
        throw new Error("Active workspace tree navigation uses Create branch.");
      }
      await deps.injectParentTreeExec(entryId, summarize);
    },
    forkTreeEntry: async (entryId, ctx) => {
      const result = await deps.workspaceManager.createActiveTreeBranch(entryId, ctx);
      if (!result) throw new Error("No active workspace session for tree branch.");
      return result;
    },
  };
}

export interface TelegramWorkspaceAwareTreeBranchMutators<TContext> {
  setBranchName: (
    entryId: string,
    name: string | undefined,
    ctx: TContext,
  ) => Promise<void> | void;
  deleteBranch: (entryId: string, ctx: TContext) => Promise<void> | void;
}

export interface TelegramWorkspaceAwareTreeBranchMutatorDeps<TContext> {
  workspaceManager: Pick<TelegramWorkspaceManager<TContext>, "getActiveSessionReference">;
  setParentBranchName: (
    entryId: string,
    name: string | undefined,
    ctx: TContext,
  ) => Promise<void> | void;
  deleteParentBranch: (entryId: string, ctx: TContext) => Promise<void> | void;
  setWorkspaceBranchName: (
    reference: TelegramWorkspaceSessionReference,
    entryId: string,
    name: string | undefined,
  ) => Promise<void> | void;
  deleteWorkspaceBranch: (
    reference: TelegramWorkspaceSessionReference,
    entryId: string,
    customType: string,
  ) => Promise<void> | void;
  branchMetadataCustomType: string;
}

export function createTelegramWorkspaceAwareTreeBranchMutators<TContext>(
  deps: TelegramWorkspaceAwareTreeBranchMutatorDeps<TContext>,
): TelegramWorkspaceAwareTreeBranchMutators<TContext> {
  return {
    setBranchName: function setBranchName(entryId, name, ctx) {
      const reference = deps.workspaceManager.getActiveSessionReference(ctx);
      if (reference) {
        return deps.setWorkspaceBranchName(reference, entryId, name);
      }
      return deps.setParentBranchName(entryId, name, ctx);
    },
    deleteBranch: function deleteBranch(entryId, ctx) {
      const reference = deps.workspaceManager.getActiveSessionReference(ctx);
      if (reference) {
        return deps.deleteWorkspaceBranch(
          reference,
          entryId,
          deps.branchMetadataCustomType,
        );
      }
      return deps.deleteParentBranch(entryId, ctx);
    },
  };
}

export function createTelegramWorkspaceAwareModelMenuPorts<
  TContext,
  TModel extends TelegramWorkspaceModelSelection,
>(
  deps: TelegramWorkspaceAwareModelMenuPortDeps<TContext, TModel>,
): TelegramWorkspaceAwareModelMenuPorts<TContext, TModel> {
  return {
    getActiveModel: async (ctx) => {
      if (!deps.workspaceManager.isEnabled()) return deps.getParentModel(ctx);
      const workspaceModel = await deps.workspaceManager.getActiveModel(ctx);
      if (!workspaceModel) return undefined;
      return deps.findModel(workspaceModel, ctx) ?? ({ ...workspaceModel } as TModel);
    },
    canSwitchModel: (ctx) =>
      deps.workspaceManager.isEnabled()
        ? deps.workspaceManager.canSwitchActiveModel(ctx)
        : deps.isParentIdle(ctx),
    canOfferInFlightModelSwitch: (ctx) =>
      deps.workspaceManager.isEnabled()
        ? false
        : deps.canOfferParentInFlightModelSwitch(ctx),
  };
}

export function createTelegramWorkspaceAwareThinkingLevelGetter<TContext>(deps: {
  workspaceManager: Pick<
    TelegramWorkspaceManager<TContext>,
    "isEnabled" | "getActiveThinkingLevel"
  >;
  getParentThinkingLevel: () => ThinkingLevel;
}): (ctx: TContext) => Promise<ThinkingLevel> | ThinkingLevel {
  return async (ctx) => {
    if (!deps.workspaceManager.isEnabled()) return deps.getParentThinkingLevel();
    return (
      (await deps.workspaceManager.getActiveThinkingLevel(ctx)) ??
      deps.getParentThinkingLevel()
    );
  };
}

export function createTelegramWorkspaceReferenceContextWindowGetter<
  TContext,
  TModel extends { contextWindow?: number },
>(deps: {
  getParentModel: (ctx: TContext) => TModel | undefined;
  findModel: (
    identity: TelegramWorkspaceModelSelection,
    ctx: TContext,
  ) => TModel | undefined;
}): (
  reference: TelegramWorkspaceSessionReference,
  ctx: TContext,
) => number | undefined {
  return (reference, ctx) =>
    reference.currentModel
      ? deps.findModel(reference.currentModel, ctx)?.contextWindow
      : deps.getParentModel(ctx)?.contextWindow;
}

export function createTelegramWorkspaceManagerShutdownHook<TContext>(
  manager: TelegramWorkspaceManager<TContext>,
): () => Promise<void> {
  return manager.dispose;
}

function getTelegramWorkspacesStatePath(agentDir: string): string {
  return join(agentDir, "telegram-workspaces.json");
}

async function readTelegramWorkspacesState(
  statePath: string,
  cwd: string,
  now: number,
): Promise<TelegramWorkspacesState> {
  if (!existsSync(statePath)) return createDefaultTelegramWorkspacesState(cwd, now);
  const raw = JSON.parse(await readFile(statePath, "utf8")) as unknown;
  return normalizeTelegramWorkspacesState(raw, cwd, now);
}

function readTelegramWorkspacesStateSync(
  statePath: string,
  cwd: string,
  now: number,
): TelegramWorkspacesState {
  if (!existsSync(statePath)) return createDefaultTelegramWorkspacesState(cwd, now);
  const raw = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
  return normalizeTelegramWorkspacesState(raw, cwd, now);
}

function serializeTelegramWorkspacesState(state: TelegramWorkspacesState): {
  version: 1;
  activeWorkspace: string;
  workspaces: Record<string, TelegramWorkspaceRecord>;
} {
  return {
    version: 1,
    activeWorkspace: state.activeWorkspace,
    workspaces: Object.fromEntries(
      Object.entries(state.workspaces).map(([name, record]) => [name, { ...record }]),
    ),
  };
}

async function writeTelegramWorkspacesState(
  statePath: string,
  state: TelegramWorkspacesState,
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, JSON.stringify(serializeTelegramWorkspacesState(state), null, "\t") + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(tempPath, 0o600);
  await rename(tempPath, statePath);
  await chmod(statePath, 0o600);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildTelegramWorkspacePromptText(turn: TelegramWorkspacePromptTurn): string {
  return turn.content
    .map((content) =>
      content.type === "text" && typeof content.text === "string"
        ? content.text
        : "",
    )
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function applyRpcStateToRecord(
  record: TelegramWorkspaceRecord,
  state: RpcChildSessionState,
): void {
  const model = parseTelegramWorkspaceModelSelection(state.model);
  if (model) record.currentModel = model;
  if (typeof state.thinkingLevel === "string") {
    record.currentThinkingLevel = state.thinkingLevel;
  }
  if (state.sessionFile) record.sessionFile = state.sessionFile;
  if (state.sessionId) record.sessionId = state.sessionId;
  if (typeof state.messageCount === "number") {
    record.messageCount = Math.max(0, state.messageCount);
  }
  const sessionName =
    typeof state.sessionName === "string"
      ? state.sessionName.trim()
      : undefined;
  if (sessionName) {
    record.sessionName = sessionName;
  } else {
    delete record.sessionName;
  }
  if (state.isStreaming === true || state.isCompacting === true) {
    record.status = "running";
  } else if (record.status === "starting" || record.status === "running") {
    record.status = "idle";
  }
}

interface TelegramWorkspaceSessionIdentity {
  sessionFile?: string;
  canonicalSessionFile?: string;
  sessionId?: string;
}

function canonicalizeTelegramWorkspaceSessionFile(
  sessionFile: string | undefined,
): string | undefined {
  if (!sessionFile) return undefined;
  const resolved = resolve(sessionFile);
  if (!existsSync(resolved)) return resolved;
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function getTelegramWorkspaceSessionIdentity(
  value: Pick<TelegramWorkspaceSessionIdentity, "sessionFile" | "sessionId">,
): TelegramWorkspaceSessionIdentity {
  const sessionFile =
    typeof value.sessionFile === "string" && value.sessionFile
      ? value.sessionFile
      : undefined;
  const sessionId =
    typeof value.sessionId === "string" && value.sessionId
      ? value.sessionId
      : undefined;
  return {
    ...(sessionFile
      ? {
          sessionFile,
          canonicalSessionFile: canonicalizeTelegramWorkspaceSessionFile(sessionFile),
        }
      : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function isSameTelegramWorkspaceSessionIdentity(
  left: TelegramWorkspaceSessionIdentity,
  right: TelegramWorkspaceSessionIdentity,
): boolean {
  if (left.canonicalSessionFile && right.canonicalSessionFile) {
    return left.canonicalSessionFile === right.canonicalSessionFile;
  }
  if (left.sessionId && right.sessionId) {
    return left.sessionId === right.sessionId;
  }
  return false;
}

function isSameTelegramWorkspaceSessionFile(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left || !right) return false;
  return isSameTelegramWorkspaceSessionIdentity(
    getTelegramWorkspaceSessionIdentity({ sessionFile: left }),
    getTelegramWorkspaceSessionIdentity({ sessionFile: right }),
  );
}

function formatTelegramWorkspaceSessionOwner(record: TelegramWorkspaceRecord): string {
  const displayName = formatTelegramWorkspaceRecordDisplayName(record);
  const topicTitle = record.source?.kind === "telegram-topic"
    ? normalizeTelegramWorkspaceSessionName(record.source.topicTitle ?? "")
    : undefined;
  if (topicTitle && topicTitle !== displayName) return `${topicTitle} (${displayName})`;
  return displayName;
}

function normalizeTelegramWorkspaceSessionName(name: string): string | undefined {
  const trimmed = name.trim();
  return trimmed ? trimmed : undefined;
}

function getTelegramTopicSessionName(
  record: TelegramWorkspaceRecord,
): string | undefined {
  if (record.source?.kind !== "telegram-topic") return undefined;
  return normalizeTelegramWorkspaceSessionName(record.source.topicTitle ?? "");
}

function canSwitchTelegramWorkspaceModel(record: TelegramWorkspaceRecord): boolean {
  return record.status !== "running" && record.status !== "starting";
}

function getTelegramWorkspaceSessionReference(
  record: TelegramWorkspaceRecord,
  fallbackCwd?: string,
): TelegramWorkspaceSessionReference {
  const reference: TelegramWorkspaceSessionReference = {
    workspaceName: record.name,
    cwd: record.cwd || fallbackCwd || "",
    sessionFile: record.sessionFile,
    sessionId: record.sessionId,
    sessionName: record.sessionName,
  };
  if (record.currentModel) reference.currentModel = record.currentModel;
  return reference;
}

function parseTelegramWorkspaceModelSelection(
  value: unknown,
): TelegramWorkspaceModelSelection | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  return typeof raw.provider === "string" && typeof raw.id === "string"
    ? { provider: raw.provider, id: raw.id }
    : undefined;
}

function buildTelegramWorkspaceWorkerExtensionArgs(
  extensions: readonly string[],
): string[] {
  return extensions.flatMap((extensionPath) => ["--extension", extensionPath]);
}

function createWorkspaceRuntime(record: TelegramWorkspaceRecord): WorkspaceRuntime {
  return {
    record,
    unreadEvents: 0,
    activeBuffer: "",
    thinkingBuffers: new Map(),
    thinkingStreams: new Map(),
    toolCallStreams: new Map(),
    toolCallStatuses: new Map(),
    sentThinkingTexts: new Set(),
    sentToolCallMessages: new Set(),
    postRunMessages: [],
  };
}

function clearTelegramWorkspaceStreamState(stream: TelegramWorkspaceStreamState): void {
  if (stream.flushTimer) {
    clearTimeout(stream.flushTimer);
    stream.flushTimer = undefined;
  }
}

function clearRuntimePostRunPreviewStreams(runtime: WorkspaceRuntime): void {
  for (const stream of runtime.thinkingStreams.values()) {
    clearTelegramWorkspaceStreamState(stream);
  }
  for (const stream of runtime.toolCallStreams.values()) {
    clearTelegramWorkspaceStreamState(stream);
  }
  if (runtime.toolCallStatusStream) {
    clearTelegramWorkspaceStreamState(runtime.toolCallStatusStream);
    runtime.toolCallStatusStream = undefined;
  }
  runtime.thinkingStreams.clear();
  runtime.toolCallStreams.clear();
  runtime.toolCallStatuses.clear();
}

function resetRuntimeTurnBuffers(runtime: WorkspaceRuntime): void {
  runtime.activeBuffer = "";
  runtime.activeAssistantText = undefined;
  runtime.activeErrorDelivered = false;
  runtime.streamDeliveryFailureCount = undefined;
  runtime.streamDeliveryBlockedUntil = undefined;
  runtime.lastStreamFlushAt = undefined;
  if (runtime.textStream) {
    clearTelegramWorkspaceStreamState(runtime.textStream);
    runtime.textStream = undefined;
  }
  runtime.thinkingBuffers.clear();
  clearRuntimePostRunPreviewStreams(runtime);
  runtime.sentThinkingTexts.clear();
  runtime.sentToolCallMessages.clear();
  runtime.postRunMessages = [];
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function getRpcAssistantMessageEvent(
  event: RpcChildBackendEvent,
): Record<string, unknown> | undefined {
  return getRecord(event.assistantMessageEvent);
}

function getRpcAssistantEventContentIndex(
  assistantEvent: Record<string, unknown>,
): number {
  const index = assistantEvent.contentIndex;
  return typeof index === "number" && Number.isInteger(index) && index >= 0
    ? index
    : 0;
}

function getRpcAssistantThinkingDelta(
  event: RpcChildBackendEvent,
): { index: number; delta: string } | undefined {
  if (event.type !== "message_update") return undefined;
  const assistantEvent = getRpcAssistantMessageEvent(event);
  if (!assistantEvent || assistantEvent.type !== "thinking_delta") {
    return undefined;
  }
  return typeof assistantEvent.delta === "string"
    ? {
        index: getRpcAssistantEventContentIndex(assistantEvent),
        delta: assistantEvent.delta,
      }
    : undefined;
}

function getRpcAssistantThinkingEnd(
  event: RpcChildBackendEvent,
): { index: number; content?: string } | undefined {
  if (event.type !== "message_update") return undefined;
  const assistantEvent = getRpcAssistantMessageEvent(event);
  if (!assistantEvent || assistantEvent.type !== "thinking_end") {
    return undefined;
  }
  const content = assistantEvent.content;
  return {
    index: getRpcAssistantEventContentIndex(assistantEvent),
    ...(typeof content === "string" ? { content } : {}),
  };
}

function getAgentMessageContent(message: unknown): unknown[] {
  const raw = getRecord(message)?.content;
  return Array.isArray(raw) ? raw : [];
}

function extractAgentThinkingBlocks(
  message: unknown,
): Array<{ index: number; text: string }> {
  return getAgentMessageContent(message)
    .map((block, index) => {
      const raw = getRecord(block);
      if (!raw || raw.type !== "thinking") return undefined;
      const text = typeof raw.thinking === "string" ? raw.thinking.trim() : "";
      return text ? { index, text } : undefined;
    })
    .filter((block): block is { index: number; text: string } => !!block);
}

function agentMessageHasToolCall(message: unknown): boolean {
  return getAgentMessageContent(message).some(
    (block) => getRecord(block)?.type === "toolCall",
  );
}

function getAgentMessageContentBlock(
  message: unknown,
  index: number,
): unknown | undefined {
  return getAgentMessageContent(message)[index];
}

function pushTelegramWorkspacePostRunMessage(
  runtime: WorkspaceRuntime,
  kind: TelegramWorkspacePostRunMessageKind,
  markdown: string,
  stream?: TelegramWorkspaceStreamState,
): void {
  const trimmed = markdown.trim();
  if (!trimmed) return;
  const existing = runtime.postRunMessages.find(
    (message) => message.markdown === trimmed,
  );
  if (existing) {
    existing.stream ??= stream;
    return;
  }
  runtime.postRunMessages.push({ kind, markdown: trimmed, stream });
}

function removeTelegramWorkspacePostRunMessage(
  runtime: WorkspaceRuntime,
  markdown: string,
): void {
  const trimmed = markdown.trim();
  if (!trimmed) return;
  runtime.postRunMessages = runtime.postRunMessages.filter(
    (message) => message.markdown !== trimmed,
  );
}

function isTelegramWorkspacePostRunTextMessage(
  message: TelegramWorkspacePostRunMessage,
): boolean {
  return message.kind === "text";
}

function formatTelegramWorkspaceToolCallPreview(block: unknown): string {
  const raw = getRecord(block);
  if (!raw) return "";
  const partialJson = raw.partialJson;
  return formatAgentToolCallBlock({
    name: raw.name,
    arguments:
      typeof partialJson === "string" && partialJson.trim()
        ? partialJson
        : raw.arguments,
  });
}

function getRpcAssistantToolCallPreview(
  event: RpcChildBackendEvent,
): { index: number; key: string; markdown: string; final: boolean } | undefined {
  if (event.type !== "message_update") return undefined;
  const assistantEvent = getRpcAssistantMessageEvent(event);
  if (!assistantEvent) return undefined;
  const eventType = assistantEvent.type;
  if (eventType !== "toolcall_end") return undefined;
  const index = getRpcAssistantEventContentIndex(assistantEvent);
  const block = assistantEvent.toolCall;
  const rawBlock = getRecord(block);
  const markdown = formatTelegramWorkspaceToolCallPreview(block);
  return markdown
    ? {
        index,
        key:
          typeof rawBlock?.id === "string" && rawBlock.id
            ? rawBlock.id
            : `tool:${index}`,
        markdown,
        final: eventType === "toolcall_end",
      }
    : undefined;
}

function getRpcToolExecutionPreview(
  event: RpcChildBackendEvent,
): { key: string; markdown: string; status: TelegramWorkspaceToolStatusKind } | undefined {
  if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") {
    return undefined;
  }
  const toolCallId =
    typeof event.toolCallId === "string" && event.toolCallId
      ? event.toolCallId
      : undefined;
  const toolName =
    typeof event.toolName === "string" && event.toolName ? event.toolName : "tool";
  const result = getRecord(event.result);
  const isError =
    event.type === "tool_execution_end" &&
    (event.isError === true || result?.isError === true);
  return {
    key: toolCallId ?? `${toolName}:${event.type}`,
    markdown: formatAgentToolCallBlock({
      name: toolName,
      arguments: event.args,
    }),
    status:
      event.type === "tool_execution_start"
        ? "running"
        : isError
          ? "failed"
          : "done",
  };
}

function formatTelegramWorkspaceToolStatusKind(
  status: TelegramWorkspaceToolStatusKind,
): string {
  if (status === "running") return "running";
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  return "queued";
}

function formatTelegramWorkspaceCompactToolStatusMarkdown(
  entries: TelegramWorkspaceToolStatusEntry[],
  totalCount: number,
): string {
  const visibleEntries = entries.slice(-TELEGRAM_WORKSPACE_TOOL_STATUS_MAX_ENTRIES);
  const lines = ["\u{1F527} Tools"];
  if (totalCount > visibleEntries.length) {
    lines.push(`Showing latest ${visibleEntries.length} of ${totalCount}.`);
  }
  for (const entry of visibleEntries) {
    const blockLines = entry.markdown.trim().split("\n");
    const title = blockLines.shift()?.replace(/^\u{1F527}\s*/u, "") || "`tool`";
    lines.push("", `${formatTelegramWorkspaceToolStatusKind(entry.status)} ${title}`);
    lines.push(...blockLines);
  }
  return truncateTelegramWorkspaceStreamMarkdown(lines.join("\n"));
}

function getLatestAssistantMessage(messages: unknown): unknown | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages.slice().reverse()) {
    if (isAssistantAgentMessage(message)) return message;
  }
  return undefined;
}

function extractRpcAssistantText(event: RpcChildBackendEvent): string {
  if (event.type === "message_end") {
    return getAgentMessagePreviewText(event.message);
  }
  if (event.type !== "agent_end") return "";
  const latestAssistant = getLatestAssistantMessage(event.messages);
  return latestAssistant ? getAgentMessagePreviewText(latestAssistant) : "";
}

function extractRpcAssistantError(event: RpcChildBackendEvent): string | undefined {
  if (event.type !== "agent_end") return undefined;
  const assistant = extractLatestAssistantMessageText(
    Array.isArray(event.messages) ? event.messages : [],
  );
  if (assistant.stopReason !== "error" && !assistant.errorMessage) {
    return undefined;
  }
  return (
    assistant.errorMessage ||
    "Telegram workspace failed while processing the request."
  );
}

function formatTelegramWorkspaceThinkingMarkdown(text: string): string {
  return formatAgentThinkingBlock({ thinking: text });
}

function getSortedTelegramWorkspaceRecords(state: TelegramWorkspacesState): TelegramWorkspaceRecord[] {
  return Object.values(state.workspaces).sort((a, b) => a.createdAt - b.createdAt);
}

function formatTelegramWorkspaceDashboardAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

function formatTelegramWorkspaceDashboardName(record: TelegramWorkspaceRecord): string {
  const name = record.sessionName?.trim();
  return name ? truncateTelegramWorkspaceText(name.replace(/\s+/g, " "), 36) : "unset";
}

function formatTelegramWorkspaceDashboardLastMessage(record: TelegramWorkspaceRecord): string {
  const text = (record.lastMessageText ?? record.lastAssistantText)?.replace(/\s+/g, " ").trim();
  return text ? truncateTelegramWorkspaceText(text, 96) : "No messages yet.";
}

function formatTelegramWorkspaceOrphanDetail(
  record: TelegramWorkspaceRecord,
  proof?: TelegramTopicOrphanProof,
): string {
  const details = [
    formatTelegramWorkspaceRecordDisplayName(record),
    record.source?.kind === "telegram-topic"
      ? `chat ${record.source.chatId}`
      : undefined,
    record.source?.kind === "telegram-topic" &&
      record.source.messageThreadId !== undefined
      ? `topic ${record.source.messageThreadId}`
      : undefined,
    record.source?.kind === "telegram-topic" && record.source.topicTitle
      ? `title ${record.source.topicTitle}`
      : undefined,
    record.sessionName ? `session ${record.sessionName}` : undefined,
    proof ? `proof ${proof.method}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return `- ${details.join(" · ")}`;
}

function formatTelegramTopicRepairUsage(): string {
  return [
    "Usage:",
    "/topic orphans",
    "/topic cleanup",
    "",
    "Level 1 cleanup records only proven topic orphans from Bot API failures.",
  ].join("\n");
}

type TelegramWorkspaceDashboardWorkerState = "running" | "idle" | "not-started";

function formatTelegramWorkspaceDashboardWorkerLabel(
  workerState: TelegramWorkspaceDashboardWorkerState | undefined,
): string | undefined {
  if (!workerState) return undefined;
  if (workerState === "running") return "worker running";
  if (workerState === "idle") return "worker idle";
  return "worker not started";
}

function formatTelegramWorkspaceDashboardMeta(
  record: TelegramWorkspaceRecord,
  nowMs: number,
  workerState?: TelegramWorkspaceDashboardWorkerState,
): string {
  const age = formatTelegramWorkspaceDashboardAge(nowMs - record.createdAt);
  const messageCount = Math.max(0, record.messageCount ?? 0);
  return [
    formatTelegramWorkspaceRecordDisplayName(record),
    formatTelegramWorkspaceStatusLabel(record.status),
    formatTelegramWorkspaceDashboardWorkerLabel(workerState),
    age,
    `${messageCount}msg`,
    formatTelegramWorkspaceDashboardName(record),
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

function getTelegramWorkspaceCloseableNames(state: TelegramWorkspacesState): string[] {
  return getSortedTelegramWorkspaceRecords(state)
    .filter((workspace) => workspace.name !== TELEGRAM_DEFAULT_WORKSPACE_NAME)
    .map((workspace) => workspace.name);
}

function normalizeTelegramWorkspaceCloseSelection(
  state: TelegramWorkspacesState,
  selectedCloseWorkspaces: readonly string[],
): string[] {
  const closeable = new Set(getTelegramWorkspaceCloseableNames(state));
  const selected = new Set<string>();
  for (const name of selectedCloseWorkspaces) {
    if (closeable.has(name)) selected.add(name);
  }
  return [...selected];
}

function formatTelegramWorkspaceDashboardSummary(
  state: TelegramWorkspacesState,
  unreadByWorkspace: Record<string, number>,
  maxWorkspaces: number,
  nowMs: number,
  mode: TelegramWorkspaceDashboardMode = "open",
  selectedCloseWorkspaces: readonly string[] = [],
  visibleWorkspaces?: readonly TelegramWorkspaceRecord[],
  filterTrace: readonly TelegramWorkspaceFilterTraceItem[] = [],
  forumNativeMode = false,
  workerCapacity?: { live: number; max: number },
  workerStateByWorkspace: Readonly<Record<string, TelegramWorkspaceDashboardWorkerState>> = {},
): string {
  const allWorkspaces = getSortedTelegramWorkspaceRecords(state);
  const workspaces = mode === "open" && visibleWorkspaces ? [...visibleWorkspaces] : allWorkspaces;
  const active = state.workspaces[state.activeWorkspace];
  const safeSelectedCloseWorkspaces = normalizeTelegramWorkspaceCloseSelection(
    state,
    selectedCloseWorkspaces,
  );
  const selectedSet = new Set(safeSelectedCloseWorkspaces);
  const unreadWorkspaces = allWorkspaces
    .filter((workspace) => (unreadByWorkspace[workspace.name] ?? 0) > 0)
    .map((workspace) =>
      `${formatTelegramWorkspaceRecordDisplayName(workspace)} ${unreadByWorkspace[workspace.name]}`
    );
  const filterSummary = mode === "open"
    ? formatTelegramWorkspaceFilterSummary(filterTrace)
    : undefined;
  const title = forumNativeMode ? "Forum topics" : "Workspaces";
  const currentLabel = forumNativeMode ? "Current" : "Active";
  const lines = [
    filterSummary
      ? `${title} ${workspaces.length}/${allWorkspaces.length} filtered (${allWorkspaces.length}/${maxWorkspaces} total)`
      : `${title} ${allWorkspaces.length}/${maxWorkspaces}`,
  ];
  if (workerCapacity) {
    lines.push(`Workers: ${workerCapacity.live}/${workerCapacity.max}`);
  }
  lines.push(
    active
      ? [
          `${currentLabel}: ${formatTelegramWorkspaceRecordDisplayName(active)}`,
          formatTelegramWorkspaceStatusLabel(active.status),
          `${Math.max(0, active.messageCount ?? 0)}msg`,
          formatTelegramWorkspaceDashboardName(active),
        ].join(" · ")
      : `${currentLabel}: ${formatTelegramWorkspaceDisplayName(state.activeWorkspace)}`,
  );
  if (active?.currentThinkingLevel) {
    lines.push(`Thinking: ${active.currentThinkingLevel}`);
  }
  if (filterSummary) lines.push(filterSummary);
  lines.push(`Unread: ${unreadWorkspaces.length > 0 ? unreadWorkspaces.join(", ") : "none"}`);
  if (mode === "close") {
    const runningSelected = workspaces
      .filter((workspace) =>
        selectedSet.has(workspace.name) &&
        (workspace.status === "running" || workspace.status === "starting")
      )
      .map((workspace) => formatTelegramWorkspaceRecordDisplayName(workspace));
    lines.push("Close mode: select workspaces to close.");
    lines.push(`Selected: ${safeSelectedCloseWorkspaces.length}`);
    lines.push("General is protected. Session files are kept.");
    if (runningSelected.length > 0) {
      lines.push(`Running selected: ${runningSelected.join(", ")} will be stopped.`);
    }
  }
  lines.push("");
  if (workspaces.length === 0) {
    lines.push("No workspaces match filters.");
  }
  for (const workspace of workspaces) {
    const marker = workspace.name === state.activeWorkspace ? "●" : "○";
    const unread = unreadByWorkspace[workspace.name] ? ` · unread ${unreadByWorkspace[workspace.name]}` : "";
    const closePrefix =
      mode === "close" && workspace.name !== TELEGRAM_DEFAULT_WORKSPACE_NAME
        ? `${selectedSet.has(workspace.name) ? "☑" : "☐"} `
        : "";
    const protectedLabel =
      mode === "close" && workspace.name === TELEGRAM_DEFAULT_WORKSPACE_NAME
        ? " · protected"
        : "";
    lines.push(
      `${closePrefix}${marker} ${formatTelegramWorkspaceDashboardMeta(workspace, nowMs, workerStateByWorkspace[workspace.name])}${unread}${protectedLabel}`,
      `  ↳ ${formatTelegramWorkspaceDashboardLastMessage(workspace)}`,
    );
  }
  return lines.join("\n");
}

function formatTelegramWorkspaceButtonLabel(
  record: TelegramWorkspaceRecord,
  activeWorkspace: string,
  unreadCount: number,
): string {
  const active = record.name === activeWorkspace ? "● " : "";
  const unread = unreadCount > 0 ? ` ${unreadCount}` : "";
  const running = record.status === "running" || record.status === "starting"
    ? " ▶"
    : record.status === "error"
      ? " !"
      : "";
  return `${active}${formatTelegramWorkspaceRecordDisplayName(record)}${unread}${running}`;
}

function encodeTelegramWorkspaceCallbackName(name: string): string {
  return encodeURIComponent(name).replace(/%20/g, "+");
}

function decodeTelegramWorkspaceCallbackName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  try {
    return decodeURIComponent(name.replace(/\+/g, "%20"));
  } catch {
    return undefined;
  }
}

function buildTelegramWorkspaceDashboardReplyMarkup(
  state: TelegramWorkspacesState,
  unreadByWorkspace: Record<string, number>,
  mode: TelegramWorkspaceDashboardMode = "open",
  selectedCloseWorkspaces: readonly string[] = [],
  visibleWorkspaces?: readonly TelegramWorkspaceRecord[],
  forumNativeMode = false,
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];
  const workspaces = mode === "open" && visibleWorkspaces
    ? [...visibleWorkspaces]
    : getSortedTelegramWorkspaceRecords(state);
  if (mode === "close") {
    const safeSelectedCloseWorkspaces = normalizeTelegramWorkspaceCloseSelection(
      state,
      selectedCloseWorkspaces,
    );
    const selectedSet = new Set(safeSelectedCloseWorkspaces);
    if (safeSelectedCloseWorkspaces.length > 0) {
      rows.push([
        {
          text: `Close ${safeSelectedCloseWorkspaces.length} selected`,
          callback_data: "workspace:close-selected",
        },
      ]);
    }
    const closeableNames = getTelegramWorkspaceCloseableNames(state);
    if (closeableNames.length > 0) {
      const controls = [
        { text: "Select all", callback_data: "workspace:close-select-all" },
      ];
      if (safeSelectedCloseWorkspaces.length > 0) {
        controls.push({ text: "Clear selection", callback_data: "workspace:close-clear" });
      }
      rows.push(controls);
    }
    for (let index = 0; index < workspaces.length; index += 2) {
      const row = workspaces.slice(index, index + 2).map((workspace) => {
        if (workspace.name === TELEGRAM_DEFAULT_WORKSPACE_NAME) {
          return {
            text: `${formatTelegramWorkspaceRecordDisplayName(workspace)} protected`,
            callback_data: "workspace:noop",
          };
        }
        const selected = selectedSet.has(workspace.name);
        return {
          text: `${selected ? "☑" : "☐"} ${formatTelegramWorkspaceRecordDisplayName(workspace)}`,
          callback_data: `workspace:close-toggle:${encodeTelegramWorkspaceCallbackName(workspace.name)}`,
        };
      });
      rows.push(row);
    }
    rows.push([{ text: "Done", callback_data: "workspace:close-done" }]);
    return { inline_keyboard: rows };
  }
  for (let index = 0; index < workspaces.length; index += 2) {
    const row = workspaces.slice(index, index + 2).map((workspace) => ({
      text: formatTelegramWorkspaceButtonLabel(
        workspace,
        state.activeWorkspace,
        unreadByWorkspace[workspace.name] ?? 0,
      ),
      callback_data:
        forumNativeMode || workspace.name === state.activeWorkspace
          ? "workspace:noop"
          : `workspace:switch:${encodeTelegramWorkspaceCallbackName(workspace.name)}`,
    }));
    rows.push(row);
  }
  if (visibleWorkspaces) {
    rows.push([{ text: "All workspaces", callback_data: "workspace:refresh" }]);
  }
  if (!forumNativeMode && getTelegramWorkspaceCloseableNames(state).length > 0) {
    rows.push([{ text: "Manage 🗑", callback_data: "workspace:close-manage" }]);
  }
  if (!forumNativeMode) {
    rows.push([
      {
        text: "Close",
        callback_data: `workspace:close:${encodeTelegramWorkspaceCallbackName(state.activeWorkspace)}`,
      },
    ]);
  }
  return { inline_keyboard: rows };
}

function buildTelegramWorkspaceMultiCloseConfirmationText(
  state: TelegramWorkspacesState,
  selectedCloseWorkspaces: readonly string[],
): string {
  const selected = normalizeTelegramWorkspaceCloseSelection(state, selectedCloseWorkspaces);
  const workspaces = selected
    .map((name) => state.workspaces[name])
    .filter((workspace): workspace is TelegramWorkspaceRecord => workspace !== undefined);
  const shown = workspaces.slice(0, 5).map((workspace) =>
    `- ${formatTelegramWorkspaceRecordDisplayName(workspace)} · ${formatTelegramWorkspaceStatusLabel(workspace.status)}`
  );
  const more = workspaces.length > shown.length
    ? [`- ...and ${workspaces.length - shown.length} more`]
    : [];
  const hasRunning = workspaces.some((workspace) =>
    workspace.status === "running" || workspace.status === "starting"
  );
  return [
    `Close ${workspaces.length} selected workspace${workspaces.length === 1 ? "" : "s"}?`,
    "",
    ...shown,
    ...more,
    "",
    "Session files are kept.",
    ...(hasRunning ? ["Running workspaces will be stopped."] : []),
  ].join("\n");
}

function buildTelegramWorkspaceMultiCloseConfirmationReplyMarkup(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "No", callback_data: "workspace:close-cancel" },
        { text: "Close selected", callback_data: "workspace:close-confirm" },
      ],
    ],
  };
}

function buildTelegramWorkspaceConfirmReplyMarkup(
  action: "abort" | "close",
  workspaceName: string,
): TelegramInlineKeyboardMarkup {
  const encoded = encodeTelegramWorkspaceCallbackName(workspaceName);
  return {
    inline_keyboard: [
      [
        { text: action === "abort" ? "Confirm Abort" : "Confirm Close", callback_data: `workspace:${action}:do:${encoded}` },
      ],
      [{ text: "Cancel", callback_data: "workspace:refresh" }],
    ],
  };
}

function truncateTelegramWorkspaceStreamMarkdown(markdown: string): string {
  const trimmed = markdown.trim();
  if (trimmed.length <= TELEGRAM_WORKSPACE_STREAM_MARKDOWN_LIMIT) return trimmed;
  return trimmed.slice(trimmed.length - TELEGRAM_WORKSPACE_STREAM_MARKDOWN_LIMIT);
}

export function createTelegramWorkspaceManager<TContext>(
  deps: TelegramWorkspaceManagerDeps<TContext>,
): TelegramWorkspaceManager<TContext> {
  const agentDir = deps.agentDir ?? getTelegramAgentDir();
  const statePath = deps.statePath ?? getTelegramWorkspacesStatePath(agentDir);
  const configuredSessionDir = deps.sessionDir;
  const workspaceRuntimes = new Map<string, WorkspaceRuntime>();
  const dashboardStates = new Map<number, TelegramWorkspaceDashboardState>();
  let state: TelegramWorkspacesState | undefined;
  let persistChain: Promise<void> = Promise.resolve();

  const now = (): number => deps.now?.() ?? Date.now();
  const isEnabled = (): boolean => deps.getConfig().enabled;
  const streamEditThrottleMs =
    deps.streamEditThrottleMs ?? TELEGRAM_WORKSPACE_STREAM_EDIT_THROTTLE_MS;
  const streamFailureBaseRetryMs =
    deps.streamFailureBaseRetryMs ?? TELEGRAM_WORKSPACE_STREAM_FAILURE_BASE_RETRY_MS;
  const streamFailureMaxRetryMs =
    deps.streamFailureMaxRetryMs ?? TELEGRAM_WORKSPACE_STREAM_FAILURE_MAX_RETRY_MS;
  const typingIntervalMs =
    deps.typingIntervalMs ?? TELEGRAM_WORKSPACE_TYPING_ACTION_INTERVAL_MS;
  const thinkingStreamPreviewsEnabled = getTelegramWorkspaceBooleanEnv(
    "PI_TELEGRAM_THINKING_PREVIEWS",
    true,
  );
  const toolCallPreviewMode = getTelegramWorkspaceToolPreviewMode();
  const toolCallCompactPreviewsEnabled = toolCallPreviewMode === "compact";
  const toolCallStreamPreviewsEnabled = toolCallPreviewMode === "stream";
  const pruneDashboardStates = (): void => {
    const cutoff = now() - TELEGRAM_WORKSPACE_DASHBOARD_STATE_TTL_MS;
    for (const [messageId, dashboardState] of dashboardStates.entries()) {
      if (dashboardState.updatedAt < cutoff) dashboardStates.delete(messageId);
    }
  };
  const getDashboardState = (
    messageId: number,
  ): TelegramWorkspaceDashboardState | undefined => {
    pruneDashboardStates();
    return dashboardStates.get(messageId);
  };
  const setDashboardState = (dashboardState: TelegramWorkspaceDashboardState): void => {
    pruneDashboardStates();
    dashboardStates.set(dashboardState.messageId, dashboardState);
  };
  const persist = (): Promise<void> => {
    if (!state) return Promise.resolve();
    const snapshot = state;
    persistChain = persistChain.then(() =>
      writeTelegramWorkspacesState(statePath, snapshot),
    );
    return persistChain;
  };
  const hydrateWorkspaceRuntimes = (workspaceState: TelegramWorkspacesState): void => {
    for (const record of Object.values(workspaceState.workspaces)) {
      const topicSessionName = getTelegramTopicSessionName(record);
      if (topicSessionName && !record.sessionName) {
        record.sessionName = topicSessionName;
      }
      if (!workspaceRuntimes.has(record.name)) {
        workspaceRuntimes.set(record.name, createWorkspaceRuntime(record));
      }
    }
  };
  const ensureState = async (cwd: string): Promise<TelegramWorkspacesState> => {
    if (!state) {
      state = await readTelegramWorkspacesState(statePath, cwd, now());
      hydrateWorkspaceRuntimes(state);
      await persist();
    }
    return state;
  };
  const ensureStateSync = (cwd: string): TelegramWorkspacesState => {
    if (!state) {
      state = readTelegramWorkspacesStateSync(statePath, cwd, now());
      hydrateWorkspaceRuntimes(state);
      void persist();
    }
    return state;
  };
  const getWorkspaceRuntime = (
    workspaceState: TelegramWorkspacesState,
    name: string,
  ): WorkspaceRuntime | undefined => {
    const record = workspaceState.workspaces[name];
    if (!record) return undefined;
    let runtime = workspaceRuntimes.get(name);
    if (!runtime) {
      runtime = createWorkspaceRuntime(record);
      workspaceRuntimes.set(name, runtime);
    }
    runtime.record = record;
    return runtime;
  };
  const getTopicBindingConfig = () => deps.getConfig().topicBinding;
  const isTopicBindingEnabled = (): boolean =>
    isEnabled() && getTopicBindingConfig()?.enabled === true;
  const isForumNativeMode = (): boolean => isTopicBindingEnabled() &&
    getTopicBindingConfig()?.native === true;
  const isTrustedTopicBindingChat = (chatId: unknown): boolean =>
    isTelegramTrustedChat(getTopicBindingConfig()?.trustedChatIds, chatId);
  const isTopicDeliveryActive = (runtime: WorkspaceRuntime): boolean =>
    runtime.activeTopicDelivery === true;
  const isRuntimeDeliveryActive = (
    workspaceState: TelegramWorkspacesState,
    workspaceName: string,
    runtime: WorkspaceRuntime,
  ): boolean => isTopicDeliveryActive(runtime) || workspaceState.activeWorkspace === workspaceName;
  const isTelegramForumChatId = (chatId: number | undefined): boolean =>
    typeof chatId === "number" && chatId < 0;
  const getForumNativeRuntimeScope = (
    runtime: WorkspaceRuntime,
    turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">,
  ): "topic" | "workspace" | undefined => {
    if (!isForumNativeMode()) return undefined;
    const ambientThread = getAmbientTelegramThreadContext();
    const chatId = runtime.activeChatId ?? turn?.chatId ?? ambientThread?.chatId;
    const messageThreadId = runtime.activeMessageThreadId ??
      turn?.messageThreadId ??
      ambientThread?.messageThreadId;
    if (
      messageThreadId !== undefined ||
      runtime.record.source?.kind === "telegram-topic" ||
      isTelegramForumChatId(chatId)
    ) {
      return "topic";
    }
    return "workspace";
  };
  const formatRuntimeUserScopeTarget = (
    runtime: WorkspaceRuntime,
    turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">,
  ): string => {
    const forumNativeScope = getForumNativeRuntimeScope(runtime, turn);
    if (forumNativeScope) return `current ${forumNativeScope}`;
    return `workspace ${formatTelegramWorkspaceRecordDisplayName(runtime.record)}`;
  };
  const formatRuntimeUserScopeTitle = (
    runtime: WorkspaceRuntime,
    turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">,
  ): string => {
    const target = formatRuntimeUserScopeTarget(runtime, turn);
    return `${target.charAt(0).toUpperCase()}${target.slice(1)}`;
  };
  const formatRuntimeStartedMessage = (
    runtime: WorkspaceRuntime,
    turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">,
  ): string => {
    const forumNativeScope = getForumNativeRuntimeScope(runtime, turn);
    if (forumNativeScope) {
      return `Started run in ${formatRuntimeUserScopeTarget(runtime, turn)}.`;
    }
    return `Started ${formatRuntimeUserScopeTarget(runtime, turn)}.`;
  };
  const formatRuntimeFailureMessage = (
    runtime: WorkspaceRuntime,
    errorMessage: string,
    turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">,
  ): string => `${formatRuntimeUserScopeTitle(runtime, turn)} failed: ${errorMessage}`;
  const formatRuntimeFinishedNotice = (runtime: WorkspaceRuntime, workspaceName: string): string => {
    const forumNativeScope = getForumNativeRuntimeScope(runtime);
    if (forumNativeScope) {
      const title = forumNativeScope.charAt(0).toUpperCase() + forumNativeScope.slice(1);
      return `${title} finished. Open this ${forumNativeScope} to view the latest reply.`;
    }
    const displayName = formatTelegramWorkspaceDisplayName(workspaceName);
    return `Workspace ${displayName} finished. Use /workspace ${displayName} to view latest reply.`;
  };
  const formatRuntimeBusyMessage = (
    runtime: WorkspaceRuntime,
    turn?: Pick<TelegramWorkspacePromptTurn, "chatId" | "messageThreadId">,
  ): string => {
    const forumNativeScope = getForumNativeRuntimeScope(runtime, turn);
    if (forumNativeScope) {
      return `${formatRuntimeUserScopeTitle(runtime, turn)} is busy. Wait for it to go idle or send /stop first.`;
    }
    return `Workspace ${runtime.record.name} is busy. Wait for it to go idle or send /stop first.`;
  };
  const formatRuntimeStopFirstMessage = (runtime: WorkspaceRuntime): string => {
    const forumNativeScope = getForumNativeRuntimeScope(runtime);
    if (forumNativeScope) {
      return `${formatRuntimeUserScopeTitle(runtime)} is busy. Send /stop first.`;
    }
    return `Workspace ${runtime.record.name} is busy. Send /stop first.`;
  };
  const formatRuntimeAbortFirstMessage = (runtime: WorkspaceRuntime): string => {
    const forumNativeScope = getForumNativeRuntimeScope(runtime);
    if (forumNativeScope) {
      return `${formatRuntimeUserScopeTitle(runtime)} is busy. Send /abort first.`;
    }
    return `Workspace ${runtime.record.name} is busy. Send /workspace abort ${runtime.record.name} first.`;
  };
  const formatScopedWorkspaceBusyMessage = (workspaceName: string): string => {
    if (isForumNativeMode()) {
      return "Current workspace is busy. Send /abort first.";
    }
    return `Workspace ${workspaceName} is busy. Send /workspace abort ${workspaceName} first.`;
  };
  const formatRuntimeTreeBranchUnavailableMessage = (): string =>
    isForumNativeMode()
      ? "Current workspace tree branching is not configured."
      : "Active workspace tree branching is not configured.";
  const formatRuntimeSessionBindFailureMessage = (
    workspaceName: string,
    sessionPath: string,
  ): string =>
    isForumNativeMode()
      ? `Current workspace did not bind to resumed session ${sessionPath}.`
      : `Workspace ${workspaceName} did not bind to resumed session ${sessionPath}.`;
  const hasLiveWorker = (runtime: WorkspaceRuntime | undefined): boolean =>
    Boolean(runtime?.backend);
  const getLiveWorkerCount = (): number =>
    [...workspaceRuntimes.values()].filter((runtime) => hasLiveWorker(runtime)).length;
  const getConfiguredMaxWorkers = (): number =>
    isForumNativeMode()
      ? deps.getConfig().maxWorkspaces
      : deps.getConfig().maxWorkers ?? deps.getConfig().maxWorkspaces;
  const formatWorkerCapacityReachedMessage = (maxWorkers: number): string =>
    isForumNativeMode()
      ? `Worker capacity reached (${maxWorkers}). Close another workspace before starting this one.`
      : `Worker capacity reached (${maxWorkers}). Wait for another workspace to finish or close one before starting this one.`;
  const getIdleLiveWorkerStopCandidates = (
    targetWorkspaceRuntime: WorkspaceRuntime,
  ): WorkspaceRuntime[] =>
    [...workspaceRuntimes.values()]
      .filter(
        (runtime) =>
          runtime !== targetWorkspaceRuntime &&
          hasLiveWorker(runtime) &&
          runtime.closing !== true,
      )
      .sort((a, b) => a.record.lastUsedAt - b.record.lastUsedAt);
  const stopIdleLiveWorkerForCapacity = async (
    targetWorkspaceRuntime: WorkspaceRuntime,
    maxWorkers: number,
  ): Promise<boolean> => {
    const skipped = new Set<WorkspaceRuntime>();
    while (getLiveWorkerCount() >= maxWorkers) {
      const candidate = getIdleLiveWorkerStopCandidates(targetWorkspaceRuntime).find(
        (runtime) => !skipped.has(runtime),
      );
      if (!candidate) return false;
      await refreshRuntimeState(candidate);
      if (!hasLiveWorker(candidate)) continue;
      if (!canSwitchTelegramWorkspaceModel(candidate.record)) {
        skipped.add(candidate);
        continue;
      }
      deps.debugLogger?.log("telegram.workspace.worker.capacity.stop", {
        workspace: candidate.record.name,
        reason: "worker_capacity",
        maxWorkers,
      });
      await disposeRuntimeBackend(candidate);
      await persist();
    }
    return true;
  };
  const ensureWorkerCapacity = async (runtime: WorkspaceRuntime): Promise<void> => {
    if (hasLiveWorker(runtime)) return;
    const maxWorkers = getConfiguredMaxWorkers();
    if (getLiveWorkerCount() < maxWorkers) return;
    if (!isForumNativeMode() && await stopIdleLiveWorkerForCapacity(runtime, maxWorkers)) {
      return;
    }
    throw new Error(formatWorkerCapacityReachedMessage(maxWorkers));
  };
  const runInWorkspaceThreadContext = <T>(runtime: WorkspaceRuntime, fn: () => T): T => {
    if (runtime.activeChatId === undefined) return fn();
    return runWithTelegramThreadContext(
      {
        chatId: runtime.activeChatId,
        messageThreadId: runtime.activeMessageThreadId,
      },
      fn,
    );
  };
  const sendTurnTextReply = (
    turn: TelegramWorkspacePromptTurn,
    text: string,
  ): Promise<number | undefined> =>
    runWithTelegramThreadContext(
      { chatId: turn.chatId, messageThreadId: turn.messageThreadId },
      () => deps.sendTextReply(turn.chatId, turn.replyToMessageId, text),
    );
  const sendWorkspaceReply = (
    chatId: number | undefined,
    replyToMessageId: number | undefined,
    text: string,
  ): Promise<number | undefined> => {
    if (chatId === undefined || replyToMessageId === undefined) {
      return Promise.resolve(undefined);
    }
    return deps.sendTextReply(chatId, replyToMessageId, text);
  };
  const sendWorkspaceMarkdownReply = (
    chatId: number | undefined,
    replyToMessageId: number | undefined,
    markdown: string,
  ): Promise<number | undefined> => {
    if (chatId === undefined) return Promise.resolve(undefined);
    return deps.sendMarkdownReply
      ? deps.sendMarkdownReply(chatId, replyToMessageId, markdown)
      : deps.sendTextReply(chatId, replyToMessageId, markdown);
  };
  const sendWorkspaceStreamMarkdownReply = (
    chatId: number | undefined,
    replyToMessageId: number | undefined,
    markdown: string,
  ): Promise<number | undefined> => {
    if (chatId === undefined) return Promise.resolve(undefined);
    return deps.sendStreamMarkdownReply
      ? deps.sendStreamMarkdownReply(chatId, replyToMessageId, markdown)
      : sendWorkspaceMarkdownReply(chatId, replyToMessageId, markdown);
  };
  const editWorkspaceStreamMarkdownMessage = (
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
  const stopWorkspaceTyping = (runtime: WorkspaceRuntime): void => {
    if (runtime.typingInterval) {
      clearInterval(runtime.typingInterval);
      runtime.typingInterval = undefined;
    }
    runtime.typingChatId = undefined;
    runtime.typingMessageThreadId = undefined;
  };
  const stopOtherWorkspaceTyping = (workspaceName: string): void => {
    for (const [name, runtime] of workspaceRuntimes.entries()) {
      if (name !== workspaceName) stopWorkspaceTyping(runtime);
    }
  };
  const startWorkspaceTyping = (workspaceName: string, runtime: WorkspaceRuntime): void => {
    const chatId = runtime.activeChatId;
    if (!deps.sendTypingAction || chatId === undefined || chatId === 0) return;
    if (!isTopicDeliveryActive(runtime)) stopOtherWorkspaceTyping(workspaceName);
    if (
      runtime.typingInterval &&
      runtime.typingChatId === chatId &&
      runtime.typingMessageThreadId === runtime.activeMessageThreadId
    ) {
      return;
    }
    stopWorkspaceTyping(runtime);
    const sendTyping = (): void => {
      void Promise.resolve(
        runInWorkspaceThreadContext(runtime, () => deps.sendTypingAction!(chatId)),
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
    runtime.typingInterval = setInterval(sendTyping, typingIntervalMs);
  };
  const createStreamState = (): TelegramWorkspaceStreamState => ({
    markdown: "",
    sentMarkdown: "",
    lastFlushAt: 0,
  });
  const getStreamState = (
    streams: Map<number, TelegramWorkspaceStreamState>,
    index: number,
  ): TelegramWorkspaceStreamState => {
    let stream = streams.get(index);
    if (!stream) {
      stream = createStreamState();
      streams.set(index, stream);
    }
    return stream;
  };
  const getTextStreamState = (runtime: WorkspaceRuntime): TelegramWorkspaceStreamState => {
    runtime.textStream ??= createStreamState();
    return runtime.textStream;
  };
  const getToolCallStatusStreamState = (
    runtime: WorkspaceRuntime,
  ): TelegramWorkspaceStreamState => {
    runtime.toolCallStatusStream ??= createStreamState();
    return runtime.toolCallStatusStream;
  };
  const getStreamFailureRetryMs = (failureCount: number): number =>
    Math.min(
      streamFailureMaxRetryMs,
      streamFailureBaseRetryMs *
        2 ** Math.min(Math.max(0, failureCount - 1), 6),
    );
  const isWorkspaceStreamStale = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): boolean =>
    stream.turnId !== undefined && runtime.activeTurnId !== stream.turnId;
  const getWorkspaceStreamDeliveryTarget = (
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
  const bindWorkspaceStreamDeliveryTarget = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): void => {
    if (stream.turnId !== undefined) return;
    stream.turnId = runtime.activeTurnId;
    stream.chatId = runtime.activeChatId;
    stream.messageThreadId = runtime.activeMessageThreadId;
    stream.replyToMessageId = runtime.activeReplyToMessageId;
  };
  const schedulePendingWorkspaceStreamRetry = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): void => {
    if (isWorkspaceStreamStale(runtime, stream)) return;
    const nextFlushAt = Math.max(
      stream.nextFlushAt ?? 0,
      runtime.streamDeliveryBlockedUntil ?? 0,
    );
    if (nextFlushAt <= 0 || stream.flushTimer) return;
    if (stream.markdown === stream.sentMarkdown) return;
    const wait = Math.max(0, nextFlushAt - now());
    stream.flushTimer = setTimeout(() => {
      stream.flushTimer = undefined;
      void flushWorkspaceStreamMarkdown(runtime, stream);
    }, wait);
  };
  const blockWorkspaceStreamDelivery = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): void => {
    if (isWorkspaceStreamStale(runtime, stream)) return;
    const failedFlushCount =
      Math.max(
        stream.failedFlushCount ?? 0,
        runtime.streamDeliveryFailureCount ?? 0,
      ) + 1;
    const retryAt = now() + getStreamFailureRetryMs(failedFlushCount);
    stream.failedFlushCount = failedFlushCount;
    stream.lastFlushAt = now();
    stream.nextFlushAt = retryAt;
    runtime.streamDeliveryFailureCount = failedFlushCount;
    runtime.streamDeliveryBlockedUntil = retryAt;
  };
  const unblockWorkspaceStreamDelivery = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): void => {
    stream.failedFlushCount = undefined;
    stream.nextFlushAt = undefined;
    if (isWorkspaceStreamStale(runtime, stream)) return;
    runtime.streamDeliveryFailureCount = undefined;
    runtime.streamDeliveryBlockedUntil = undefined;
  };
  const getWorkspaceStreamDeliveryBlockedUntil = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
  ): number | undefined => {
    const nextFlushAt = Math.max(
      stream.nextFlushAt ?? 0,
      runtime.streamDeliveryBlockedUntil ?? 0,
    );
    return nextFlushAt > 0 ? nextFlushAt : undefined;
  };
  const scheduleAllPendingWorkspaceStreamRetries = (
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
      schedulePendingWorkspaceStreamRetry(runtime, stream);
    }
  };
  const flushWorkspaceStreamMarkdown = async (
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
      stale: isWorkspaceStreamStale(runtime, stream),
    });
    if (!stream.markdown) return makeSkipped("empty");
    if (stream.markdown === stream.sentMarkdown) return makeSkipped("unchanged");
    if (isWorkspaceStreamStale(runtime, stream) && !options.allowStaleDelivery) {
      return makeSkipped("stale-turn");
    }
    const blockedUntil = getWorkspaceStreamDeliveryBlockedUntil(runtime, stream);
    if (!options.force && blockedUntil !== undefined && now() < blockedUntil) {
      schedulePendingWorkspaceStreamRetry(runtime, stream);
      return {
        status: "scheduled",
        reason: "blocked",
        retryAt: blockedUntil,
        stale: isWorkspaceStreamStale(runtime, stream),
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
        if (isWorkspaceStreamStale(runtime, stream) && !options.allowStaleDelivery) {
          return makeSkipped("stale-turn");
        }
        const target = getWorkspaceStreamDeliveryTarget(runtime, stream);
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
                sendWorkspaceStreamMarkdownReply(
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
                editWorkspaceStreamMarkdownMessage(
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
            stale: isWorkspaceStreamStale(runtime, stream),
          };
        }
        if (!delivered) {
          if (lastResult.status !== "failed") {
            lastResult = {
              status: "failed",
              stale: isWorkspaceStreamStale(runtime, stream),
            };
          }
          if (shouldRetryOnFailure()) {
            blockWorkspaceStreamDelivery(runtime, stream);
            scheduleAllPendingWorkspaceStreamRetries(runtime, stream);
          }
          return lastResult;
        }
        const staleAfterDelivery = isWorkspaceStreamStale(runtime, stream);
        if (!staleAfterDelivery) {
          if (deliveredMessageId !== undefined) stream.messageId = deliveredMessageId;
          unblockWorkspaceStreamDelivery(runtime, stream);
          stream.sentMarkdown = markdown;
          removeTelegramWorkspacePostRunMessage(runtime, markdown);
          stream.lastFlushAt = now();
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
        !isWorkspaceStreamStale(runtime, stream) &&
        stream.markdown !== stream.sentMarkdown
      ) {
        schedulePendingWorkspaceStreamRetry(runtime, stream);
      }
    }
  };
  const scheduleWorkspaceStreamMarkdownFlush = (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
    force: boolean,
  ): void => {
    if (stream.flushTimer) {
      if (!force) return;
      clearTimeout(stream.flushTimer);
      stream.flushTimer = undefined;
    }
    const blockedUntil = getWorkspaceStreamDeliveryBlockedUntil(runtime, stream);
    const retryWait =
      !force && blockedUntil !== undefined ? Math.max(0, blockedUntil - now()) : 0;
    const globalThrottleWait = Math.max(
      0,
      streamEditThrottleMs - (now() - (runtime.lastStreamFlushAt ?? 0)),
    );
    const wait =
      retryWait > 0
        ? retryWait
        : force
          ? 0
          : Math.max(
              globalThrottleWait,
              streamEditThrottleMs - (now() - stream.lastFlushAt),
            );
    if (wait === 0) {
      void flushWorkspaceStreamMarkdown(runtime, stream, { force });
      return;
    }
    stream.flushTimer = setTimeout(() => {
      stream.flushTimer = undefined;
      void flushWorkspaceStreamMarkdown(runtime, stream);
    }, wait);
  };
  const streamActiveWorkspaceMarkdown = (
    workspaceState: TelegramWorkspacesState,
    workspaceName: string,
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState,
    markdown: string,
    force = false,
    truncate = true,
  ): void => {
    if (!isRuntimeDeliveryActive(workspaceState, workspaceName, runtime)) return;
    bindWorkspaceStreamDeliveryTarget(runtime, stream);
    if (isWorkspaceStreamStale(runtime, stream) && !force) return;
    stream.markdown = truncate
      ? truncateTelegramWorkspaceStreamMarkdown(markdown)
      : markdown.trim();
    scheduleWorkspaceStreamMarkdownFlush(runtime, stream, force);
  };
  const streamActiveWorkspaceText = (
    workspaceState: TelegramWorkspacesState,
    workspaceName: string,
    runtime: WorkspaceRuntime,
    text: string,
    force = false,
  ): boolean => {
    const trimmed = text.trim();
    if (!trimmed || !isRuntimeDeliveryActive(workspaceState, workspaceName, runtime)) return false;
    streamActiveWorkspaceMarkdown(
      workspaceState,
      workspaceName,
      runtime,
      getTextStreamState(runtime),
      trimmed,
      force,
      !force,
    );
    return true;
  };
  const streamActiveWorkspaceThinking = (
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
    if (thinkingStreamPreviewsEnabled) {
      stream = getStreamState(runtime.thinkingStreams, index);
      streamActiveWorkspaceMarkdown(
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
  const flushActiveWorkspaceThinkingBuffer = (
    workspaceState: TelegramWorkspacesState,
    workspaceName: string,
    runtime: WorkspaceRuntime,
    index: number,
  ): void => {
    const text = runtime.thinkingBuffers.get(index) ?? "";
    runtime.thinkingBuffers.delete(index);
    streamActiveWorkspaceThinking(workspaceState, workspaceName, runtime, index, text, true);
  };
  const streamActiveWorkspaceToolCall = (
    workspaceState: TelegramWorkspacesState,
    workspaceName: string,
    runtime: WorkspaceRuntime,
    index: number,
    markdown: string,
    final: boolean,
  ): void => {
    if (!markdown || !toolCallStreamPreviewsEnabled) return;
    const stream = getStreamState(runtime.toolCallStreams, index);
    streamActiveWorkspaceMarkdown(workspaceState, workspaceName, runtime, stream, markdown, final);
    if (final) {
      runtime.sentToolCallMessages.add(markdown);
      pushTelegramWorkspacePostRunMessage(runtime, "tool", markdown, stream);
      runtime.toolCallStreams.delete(index);
    }
  };
  const streamActiveWorkspaceCompactToolStatus = (
    workspaceState: TelegramWorkspacesState,
    workspaceName: string,
    runtime: WorkspaceRuntime,
    preview: {
      key: string;
      markdown: string;
      status: TelegramWorkspaceToolStatusKind;
    },
  ): void => {
    if (!toolCallCompactPreviewsEnabled) return;
    if (!preview.markdown && !runtime.toolCallStatuses.has(preview.key)) return;
    const current = runtime.toolCallStatuses.get(preview.key);
    runtime.toolCallStatuses.set(preview.key, {
      key: preview.key,
      markdown: preview.markdown || current?.markdown || "\u{1F527} `tool`",
      status: preview.status,
      updatedAt: now(),
    });
    const entries = [...runtime.toolCallStatuses.values()].sort(
      (left, right) => left.updatedAt - right.updatedAt,
    );
    const markdown = formatTelegramWorkspaceCompactToolStatusMarkdown(
      entries,
      runtime.toolCallStatuses.size,
    );
    streamActiveWorkspaceMarkdown(
      workspaceState,
      workspaceName,
      runtime,
      getToolCallStatusStreamState(runtime),
      markdown,
    );
  };
  const getWorkspaceTurnDetails = (workspaceName: string, runtime: WorkspaceRuntime): Record<string, unknown> => ({
    workspace: workspaceName,
    turnId: runtime.activeTurnId,
    chatId: runtime.activeChatId,
    messageThreadId: runtime.activeMessageThreadId,
    replyToMessageId: runtime.activeReplyToMessageId,
  });
  const isFinalWorkspaceStreamDeliveryConfirmed = (
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
  const finalizeActiveWorkspaceTextStream = async (
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
        stale: isWorkspaceStreamStale(runtime, stream),
      };
    }
    bindWorkspaceStreamDeliveryTarget(runtime, stream);
    stream.markdown = trimmed;
    if (stream.flushTimer) {
      clearTimeout(stream.flushTimer);
      stream.flushTimer = undefined;
    }
    return flushWorkspaceStreamMarkdown(runtime, stream, {
      force: true,
      allowStaleDelivery: true,
      retryOnFailure: false,
    });
  };
  const deleteWorkspaceStreamPreviewMessage = async (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState | undefined,
    deletedMessageIds?: Set<number>,
  ): Promise<void> => {
    if (!stream || stream.messageId === undefined || !deps.deleteMessage) return;
    if (deletedMessageIds?.has(stream.messageId)) return;
    const target = getWorkspaceStreamDeliveryTarget(runtime, stream);
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
  const deleteRuntimePostRunPreviewMessages = async (
    runtime: WorkspaceRuntime,
    textStream: TelegramWorkspaceStreamState | undefined,
  ): Promise<void> => {
    const deletedMessageIds = new Set<number>();
    await deleteWorkspaceStreamPreviewMessage(runtime, textStream, deletedMessageIds);
    for (const message of runtime.postRunMessages) {
      await deleteWorkspaceStreamPreviewMessage(runtime, message.stream, deletedMessageIds);
    }
    if (runtime.postRunMessages.some((message) => message.kind === "tool")) {
      await deleteWorkspaceStreamPreviewMessage(
        runtime,
        runtime.toolCallStatusStream,
        deletedMessageIds,
      );
    }
  };
  const markActiveWorkspaceTextStreamAborted = async (
    runtime: WorkspaceRuntime,
    stream: TelegramWorkspaceStreamState | undefined = runtime.textStream,
  ): Promise<TelegramWorkspaceStreamDeliveryResult | undefined> => {
    if (!stream) return undefined;
    const current = (stream.sentMarkdown || stream.markdown).trim();
    if (!current) return undefined;
    const abortedMarkdown = current.includes("[aborted]")
      ? current
      : `${current}\n\n[aborted]`;
    bindWorkspaceStreamDeliveryTarget(runtime, stream);
    stream.markdown = abortedMarkdown;
    if (stream.flushTimer) {
      clearTimeout(stream.flushTimer);
      stream.flushTimer = undefined;
    }
    return flushWorkspaceStreamMarkdown(runtime, stream, {
      force: true,
      allowStaleDelivery: true,
      retryOnFailure: false,
    });
  };
  const logWorkspaceFirstOutput = (
    workspaceName: string,
    runtime: WorkspaceRuntime,
    outputKind: string,
  ): void => {
    if (runtime.firstOutputLogged) return;
    const firstOutputAt = now();
    runtime.firstOutputAt = firstOutputAt;
    runtime.firstOutputLogged = true;
    deps.debugLogger?.log("telegram.workspace.first_output", {
      ...getWorkspaceTurnDetails(workspaceName, runtime),
      outputKind,
      promptSentToFirstOutputMs:
        runtime.promptSentAt === undefined ? undefined : firstOutputAt - runtime.promptSentAt,
      agentStartToFirstOutputMs:
        runtime.agentStartedAt === undefined ? undefined : firstOutputAt - runtime.agentStartedAt,
    });
  };
  const logWorkspaceTurnSummary = (
    workspaceName: string,
    runtime: WorkspaceRuntime,
    stopReason?: string,
    error?: string,
  ): void => {
    const endedAt = now();
    deps.debugLogger?.log("telegram.workspace.turn.summary", {
      ...getWorkspaceTurnDetails(workspaceName, runtime),
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
  const sendActiveWorkspaceToolCallMessage = (
    workspaceState: TelegramWorkspacesState,
    workspaceName: string,
    runtime: WorkspaceRuntime,
    message: unknown,
  ): boolean => {
    if (!agentMessageHasToolCall(message)) return false;
    if (toolCallCompactPreviewsEnabled) {
      getAgentMessageContent(message).forEach((block, index) => {
        const raw = getRecord(block);
        if (raw?.type !== "toolCall") return;
        const key =
          typeof raw.id === "string" && raw.id ? raw.id : `message-tool:${index}`;
        const markdown = formatAgentToolCallBlock({
          name: raw.name,
          arguments: raw.arguments,
        });
        streamActiveWorkspaceCompactToolStatus(workspaceState, workspaceName, runtime, {
          key,
          markdown,
          status: "queued",
        });
        pushTelegramWorkspacePostRunMessage(runtime, "tool", markdown);
      });
      return getAgentMessageBodyText(message).length === 0;
    }
    if (!toolCallStreamPreviewsEnabled) return false;
    if (
      runtime.toolCallStreams.size > 0 ||
      runtime.sentToolCallMessages.size > 0
    ) {
      return true;
    }
    const markdown = getAgentMessagePreviewText(message);
    if (!markdown || runtime.sentToolCallMessages.has(markdown)) return true;
    pushTelegramWorkspacePostRunMessage(runtime, "tool", markdown);
    if (!isRuntimeDeliveryActive(workspaceState, workspaceName, runtime)) return false;
    runtime.sentToolCallMessages.add(markdown);
    void runInWorkspaceThreadContext(runtime, async () => {
      const messageId = await sendWorkspaceMarkdownReply(
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
  const handleChildEvent = (
    workspaceName: string,
    runtime: WorkspaceRuntime,
    event: RpcChildBackendEvent,
  ): void => {
    const workspaceState = state;
    if (!workspaceState || runtime.closing || !workspaceState.workspaces[workspaceName]) return;
    const record = runtime.record;
    const eventNow = now();
    deps.debugLogger?.log(
      "telegram.workspace.worker.event",
      {
        ...getWorkspaceTurnDetails(workspaceName, runtime),
        type: event.type,
        status: record.status,
        bodyOmitted: event.type === "message_update" || event.type === "message_end" || event.type === "agent_end" ? true : undefined,
      },
      event.type === "message_update" || event.type === "message_end" || event.type === "agent_end" ? undefined : event,
    );
    if (event.type === "agent_start") {
      resetRuntimeTurnBuffers(runtime);
      runtime.agentStartedAt = eventNow;
      deps.debugLogger?.log("telegram.workspace.agent.start", getWorkspaceTurnDetails(workspaceName, runtime));
      record.status = "running";
      record.lastError = undefined;
      record.lastAgentStartAt = eventNow;
      if (isRuntimeDeliveryActive(workspaceState, workspaceName, runtime)) {
        startWorkspaceTyping(workspaceName, runtime);
      }
      void persist();
      return;
    }
    if (event.type === "message_start") {
      deps.debugLogger?.log("telegram.workspace.message.start", getWorkspaceTurnDetails(workspaceName, runtime));
      runtime.activeBuffer = "";
      runtime.textStream = undefined;
      return;
    }
    const delta = extractRpcTextDelta(event);
    if (delta) {
      logWorkspaceFirstOutput(workspaceName, runtime, "text_delta");
      runtime.activeBuffer += delta;
      streamActiveWorkspaceText(workspaceState, workspaceName, runtime, runtime.activeBuffer);
    }
    const thinkingDelta = getRpcAssistantThinkingDelta(event);
    if (thinkingDelta) {
      logWorkspaceFirstOutput(workspaceName, runtime, "thinking_delta");
      const nextThinkingText = `${runtime.thinkingBuffers.get(thinkingDelta.index) ?? ""}${
        thinkingDelta.delta
      }`;
      runtime.thinkingBuffers.set(
        thinkingDelta.index,
        nextThinkingText,
      );
      streamActiveWorkspaceThinking(
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
      flushActiveWorkspaceThinkingBuffer(workspaceState, workspaceName, runtime, thinkingEnd.index);
    }
    const toolCallPreview = getRpcAssistantToolCallPreview(event);
    if (toolCallPreview) {
      logWorkspaceFirstOutput(workspaceName, runtime, "tool_call");
      deps.debugLogger?.log("telegram.workspace.tool.preview", {
        ...getWorkspaceTurnDetails(workspaceName, runtime),
        index: toolCallPreview.index,
        final: toolCallPreview.final,
      }, toolCallPreview.markdown);
      streamActiveWorkspaceCompactToolStatus(workspaceState, workspaceName, runtime, {
        key: toolCallPreview.key,
        markdown: toolCallPreview.markdown,
        status: "queued",
      });
      streamActiveWorkspaceToolCall(
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
      streamActiveWorkspaceCompactToolStatus(
        workspaceState,
        workspaceName,
        runtime,
        toolExecutionPreview,
      );
    }
    const assistantText = extractRpcAssistantText(event);
    if (assistantText) {
      logWorkspaceFirstOutput(workspaceName, runtime, "assistant_text");
      runtime.activeAssistantText = assistantText;
      record.lastAssistantText = assistantText;
      record.lastMessageText = assistantText;
      record.lastMessageAt = eventNow;
    }
    if (event.type === "message_end" && isAssistantAgentMessage(event.message)) {
      deps.debugLogger?.log("telegram.workspace.message.end", {
        ...getWorkspaceTurnDetails(workspaceName, runtime),
        hasAssistantMessage: true,
      });
      const finalBodyText = getAgentMessageBodyText(event.message);
      if (runtime.textStream && finalBodyText) {
        runtime.activeBuffer = finalBodyText;
        streamActiveWorkspaceText(workspaceState, workspaceName, runtime, finalBodyText, true);
      }
      for (const thinking of extractAgentThinkingBlocks(event.message)) {
        streamActiveWorkspaceThinking(
          workspaceState,
          workspaceName,
          runtime,
          thinking.index,
          thinking.text,
          true,
        );
      }
      sendActiveWorkspaceToolCallMessage(workspaceState, workspaceName, runtime, event.message);
    }
    if (event.type === "agent_end") {
      deps.debugLogger?.log("telegram.workspace.agent.end", {
        ...getWorkspaceTurnDetails(workspaceName, runtime),
        messageCount: Array.isArray(event.messages) ? event.messages.length : undefined,
      });
      stopWorkspaceTyping(runtime);
      for (const index of [...runtime.thinkingBuffers.keys()]) {
        flushActiveWorkspaceThinkingBuffer(workspaceState, workspaceName, runtime, index);
      }
      const latestAssistant = getLatestAssistantMessage(event.messages);
      if (latestAssistant) {
        for (const thinking of extractAgentThinkingBlocks(latestAssistant)) {
          streamActiveWorkspaceThinking(
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
        sendActiveWorkspaceToolCallMessage(
          workspaceState,
          workspaceName,
          runtime,
          latestAssistant,
        );
      }
      record.lastAgentEndAt = eventNow;
      const assistantError = extractRpcAssistantError(event);
      if (assistantError) {
        logWorkspaceTurnSummary(workspaceName, runtime, "error", assistantError);
        record.status = "error";
        record.lastError = assistantError;
        const isActive = isRuntimeDeliveryActive(workspaceState, workspaceName, runtime);
        if (!runtime.activeErrorDelivered) {
          runtime.activeErrorDelivered = true;
          if (isActive) {
            void runInWorkspaceThreadContext(runtime, () =>
              sendWorkspaceReply(
                runtime.activeChatId,
                runtime.activeReplyToMessageId,
                formatRuntimeFailureMessage(runtime, assistantError),
              ),
            );
          } else {
            runtime.unreadEvents += 1;
            if (deps.getConfig().inactiveNotify) {
              void runInWorkspaceThreadContext(runtime, () =>
                sendWorkspaceReply(
                  runtime.activeChatId,
                  runtime.activeReplyToMessageId,
                  formatRuntimeFailureMessage(runtime, assistantError),
                ),
              );
            }
          }
        }
        void persist();
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
      const isActive = isRuntimeDeliveryActive(workspaceState, workspaceName, runtime);
      const finalBodyText = latestAssistant
        ? getAgentMessageBodyText(latestAssistant)
        : runtime.activeBuffer;
      if (latestAssistantSummary.stopReason === "aborted") {
        void (async () => {
          const result = await markActiveWorkspaceTextStreamAborted(runtime).catch(
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
              ...getWorkspaceTurnDetails(workspaceName, runtime),
              streamMessageId: runtime.textStream?.messageId,
              status: result.status,
              delivered: result.status === "delivered",
              error: "error" in result ? result.error : undefined,
              stale: result.stale,
            });
          }
        })();
        logWorkspaceTurnSummary(workspaceName, runtime, "aborted");
        void persist();
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
              streamResult = await finalizeActiveWorkspaceTextStream(
                runtime,
                stream,
                finalStreamMarkdown,
              );
              streamDelivered = isFinalWorkspaceStreamDeliveryConfirmed(
                streamResult,
                finalStreamMarkdown,
                stream.sentMarkdown,
              );
            } catch (error) {
              fallbackError = getErrorMessage(error);
              streamResult = {
                status: "failed",
                error: fallbackError,
                stale: stream ? isWorkspaceStreamStale(runtime, stream) : false,
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
                  sendWorkspaceMarkdownReply(
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
            await deleteRuntimePostRunPreviewMessages(runtime, stream);
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
          void runInWorkspaceThreadContext(runtime, () =>
            sendWorkspaceReply(
              chatId,
              replyToMessageId,
              formatRuntimeFinishedNotice(runtime, workspaceName),
            ),
          );
        }
      }
      logWorkspaceTurnSummary(workspaceName, runtime, latestAssistantSummary.stopReason ?? "stop");
      void persist();
      return;
    }
    if (event.type === "exit") {
      deps.debugLogger?.log("telegram.workspace.worker.exit", getWorkspaceTurnDetails(workspaceName, runtime), event);
      stopWorkspaceTyping(runtime);
      if (record.status === "running" || record.status === "starting") {
        record.status = "exited";
      }
      runtime.backend = undefined;
      runtime.unsubscribe?.();
      runtime.unsubscribe = undefined;
      void persist();
      return;
    }
    if (event.type === "error") {
      const errorMessage = typeof event.error === "string" ? event.error : "RPC child error";
      deps.debugLogger?.log("telegram.workspace.worker.error", {
        ...getWorkspaceTurnDetails(workspaceName, runtime),
        error: errorMessage,
      }, event);
      logWorkspaceTurnSummary(workspaceName, runtime, "error", errorMessage);
      stopWorkspaceTyping(runtime);
      record.status = "error";
      record.lastError = errorMessage;
      void persist();
    }
  };
  const ensureBackend = async (
    runtime: WorkspaceRuntime,
    ctx: TContext,
  ): Promise<TelegramWorkspaceBackend> => {
    if (runtime.backend) return runtime.backend;
    await ensureWorkerCapacity(runtime);
    runtime.record.status = "starting";
    runtime.record.lastError = undefined;
    const cwd = runtime.record.cwd || deps.getCwd(ctx);
    const sessionDir = deps.getSessionDir?.(ctx) ?? configuredSessionDir;
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
      handleChildEvent(runtime.record.name, runtime, event);
    });
    try {
      const childState = await backend.start();
      deps.debugLogger?.log(
        "telegram.workspace.worker.ready",
        { workspace: runtime.record.name, elapsedMs: Date.now() - workerStartedAt },
        childState,
      );
      applyRpcStateToRecord(runtime.record, childState);
      await syncTopicSessionNameToWorker(runtime, {
        workerSessionName: childState.sessionName,
      });
      await persist();
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
      await persist();
      throw error;
    }
  };
  const disposeRuntimeBackend = async (runtime: WorkspaceRuntime): Promise<void> => {
    stopWorkspaceTyping(runtime);
    const backend = runtime.backend;
    runtime.backend = undefined;
    runtime.unsubscribe?.();
    runtime.unsubscribe = undefined;
    await backend?.dispose();
  };
  const disposeClosingRuntimeBackend = async (
    runtime: WorkspaceRuntime,
  ): Promise<void> => {
    runtime.closing = true;
    stopWorkspaceTyping(runtime);
    resetRuntimeTurnBuffers(runtime);
    const backend = runtime.backend;
    runtime.backend = undefined;
    runtime.unsubscribe?.();
    runtime.unsubscribe = undefined;
    await backend?.dispose();
  };
  const syncTopicSessionNameToWorker = async (
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
  const refreshRuntimeState = async (
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
    await persist();
    return childState;
  };
  const refreshDashboardWorkspaceRecords = async (
    workspaceState: TelegramWorkspacesState,
  ): Promise<void> => {
    await Promise.all(
      Object.keys(workspaceState.workspaces).map(async (name) => {
        const runtime = getWorkspaceRuntime(workspaceState, name);
        if (runtime?.backend) await refreshRuntimeState(runtime);
      }),
    );
  };
  const getOpenSessionConflict = async (
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
        const runtime = getWorkspaceRuntime(workspaceState, record.name);
        if (runtime?.backend) await refreshRuntimeState(runtime);
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
  const assertNoOpenSessionConflict = async (
    workspaceState: TelegramWorkspacesState,
    targetWorkspaceRuntime: WorkspaceRuntime,
    target: Pick<TelegramWorkspaceSessionIdentity, "sessionFile" | "sessionId">,
  ): Promise<void> => {
    const conflict = await getOpenSessionConflict(workspaceState, targetWorkspaceRuntime, target);
    if (!conflict) return;
    throw new Error(
      `Session is already open in workspace ${formatTelegramWorkspaceSessionOwner(conflict)}. Close that workspace first or branch/clone the session.`,
    );
  };
  const getTelegramTopicServiceKind = (
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
  const updateTelegramTopicRecordTitle = (
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
  const createTelegramTopicWorkspaceRecord = (
    workspaceState: TelegramWorkspacesState,
    scope: { chatId: number; messageThreadId: number; topicTitle?: string },
    ctx: TContext,
  ): TelegramWorkspaceRecord => {
    const createdAt = now();
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
  const getOrCreateTopicRuntimeForTurn = async (
    workspaceState: TelegramWorkspacesState,
    turn: TelegramWorkspacePromptTurn,
    ctx: TContext,
  ): Promise<WorkspaceRuntime | undefined> => {
    const topicBinding = getTopicBindingConfig();
    if (!topicBinding?.enabled) return undefined;
    if (!isTrustedTopicBindingChat(turn.chatId)) {
      await sendTurnTextReply(
        turn,
        "This Telegram forum is not authorized for topic workspaces.",
      );
      return undefined;
    }
    if (turn.messageThreadId === undefined && topicBinding.generalIsDefault) {
      return getWorkspaceRuntime(workspaceState, TELEGRAM_DEFAULT_WORKSPACE_NAME);
    }
    if (turn.messageThreadId === undefined) return undefined;
    const existing = findTelegramWorkspaceByTopic(
      workspaceState.workspaces,
      turn.chatId,
      turn.messageThreadId,
    );
    if (existing) return getWorkspaceRuntime(workspaceState, existing.name);
    if (!topicBinding.autoCreate) return undefined;
    if (Object.keys(workspaceState.workspaces).length >= deps.getConfig().maxWorkspaces) {
      await sendTurnTextReply(
        turn,
        "Maximum workspace count reached. Close another topic/workspace first.",
      );
      return undefined;
    }
    const record = createTelegramTopicWorkspaceRecord(
      workspaceState,
      { chatId: turn.chatId, messageThreadId: turn.messageThreadId },
      ctx,
    );
    workspaceState.workspaces[record.name] = record;
    const runtime = createWorkspaceRuntime(record);
    workspaceRuntimes.set(record.name, runtime);
    await persist();
    return runtime;
  };
  const getWorkspaceRuntimeForPromptTurn = async (
    workspaceState: TelegramWorkspacesState,
    turn: TelegramWorkspacePromptTurn,
    ctx: TContext,
  ): Promise<WorkspaceRuntime | undefined> => {
    if (!isTopicBindingEnabled()) return getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
    if (turn.messageThreadId !== undefined && !isTrustedTopicBindingChat(turn.chatId)) {
      await sendTurnTextReply(
        turn,
        "This Telegram forum is not authorized for topic workspaces.",
      );
      return undefined;
    }
    if (turn.messageThreadId === undefined) {
      return getTopicBindingConfig()?.generalIsDefault
        ? getWorkspaceRuntime(workspaceState, TELEGRAM_DEFAULT_WORKSPACE_NAME)
        : getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
    }
    const runtime = await getOrCreateTopicRuntimeForTurn(workspaceState, turn, ctx);
    if (runtime) return runtime;
    if (!getTopicBindingConfig()?.autoCreate) {
      await sendTurnTextReply(
        turn,
        isForumNativeMode()
          ? "No workspace is bound to this Telegram topic."
          : "No workspace is bound to this Telegram topic.",
      );
    }
    return undefined;
  };
  const upsertTelegramTopicWorkspaceRecord = async (
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
      if (updateTelegramTopicRecordTitle(existing, scope.topicTitle)) {
        await persist();
      }
      return existing;
    }
    if (
      options.enforceCapacity &&
      Object.keys(workspaceState.workspaces).length >= deps.getConfig().maxWorkspaces
    ) {
      return undefined;
    }
    const record = createTelegramTopicWorkspaceRecord(workspaceState, scope, ctx);
    workspaceState.workspaces[record.name] = record;
    workspaceRuntimes.set(record.name, createWorkspaceRuntime(record));
    await persist();
    return record;
  };
  const resolveScopedTopicRuntime = async (
    workspaceState: TelegramWorkspacesState,
    ctx: TContext,
  ): Promise<{ scoped: boolean; runtime?: WorkspaceRuntime }> => {
    if (!isTopicBindingEnabled()) return { scoped: false };
    const scope = getAmbientTelegramThreadContext();
    if (!scope) return { scoped: false };
    if (!isTrustedTopicBindingChat(scope.chatId)) {
      return scope.messageThreadId === undefined ? { scoped: false } : { scoped: true };
    }
    const topicBinding = getTopicBindingConfig();
    if (scope.messageThreadId === undefined) {
      return {
        scoped: true,
        runtime: topicBinding?.generalIsDefault
          ? getWorkspaceRuntime(workspaceState, TELEGRAM_DEFAULT_WORKSPACE_NAME)
          : undefined,
      };
    }
    const existing = findTelegramWorkspaceByTopic(
      workspaceState.workspaces,
      scope.chatId,
      scope.messageThreadId,
    );
    if (existing) return { scoped: true, runtime: getWorkspaceRuntime(workspaceState, existing.name) };
    if (!topicBinding?.autoCreate) return { scoped: true };
    const record = await upsertTelegramTopicWorkspaceRecord(
      workspaceState,
      { chatId: scope.chatId, messageThreadId: scope.messageThreadId },
      ctx,
      { enforceCapacity: true },
    );
    return {
      scoped: true,
      runtime: record ? getWorkspaceRuntime(workspaceState, record.name) : undefined,
    };
  };
  const resolveScopedTopicRuntimeSync = (
    workspaceState: TelegramWorkspacesState,
    ctx: TContext,
  ): { scoped: boolean; runtime?: WorkspaceRuntime } => {
    if (!isTopicBindingEnabled()) return { scoped: false };
    const scope = getAmbientTelegramThreadContext();
    if (!scope) return { scoped: false };
    if (!isTrustedTopicBindingChat(scope.chatId)) {
      return scope.messageThreadId === undefined ? { scoped: false } : { scoped: true };
    }
    const topicBinding = getTopicBindingConfig();
    if (scope.messageThreadId === undefined) {
      return {
        scoped: true,
        runtime: topicBinding?.generalIsDefault
          ? getWorkspaceRuntime(workspaceState, TELEGRAM_DEFAULT_WORKSPACE_NAME)
          : undefined,
      };
    }
    const existing = findTelegramWorkspaceByTopic(
      workspaceState.workspaces,
      scope.chatId,
      scope.messageThreadId,
    );
    if (existing) return { scoped: true, runtime: getWorkspaceRuntime(workspaceState, existing.name) };
    if (!topicBinding?.autoCreate) return { scoped: true };
    if (Object.keys(workspaceState.workspaces).length >= deps.getConfig().maxWorkspaces) {
      return { scoped: true };
    }
    const record = createTelegramTopicWorkspaceRecord(
      workspaceState,
      { chatId: scope.chatId, messageThreadId: scope.messageThreadId },
      ctx,
    );
    workspaceState.workspaces[record.name] = record;
    const runtime = createWorkspaceRuntime(record);
    workspaceRuntimes.set(record.name, runtime);
    void persist();
    return { scoped: true, runtime };
  };
  const getActiveRuntime = async (ctx: TContext): Promise<WorkspaceRuntime | undefined> => {
    const workspaceState = await ensureState(deps.getCwd(ctx));
    const scoped = await resolveScopedTopicRuntime(workspaceState, ctx);
    return scoped.scoped ? scoped.runtime : getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
  };
  const getActiveRuntimeSync = (ctx: TContext): WorkspaceRuntime | undefined => {
    const workspaceState = ensureStateSync(deps.getCwd(ctx));
    const scoped = resolveScopedTopicRuntimeSync(workspaceState, ctx);
    return scoped.scoped ? scoped.runtime : getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
  };
  const replyDisabled = (
    chatId: number,
    replyToMessageId: number,
  ): Promise<number | undefined> =>
    deps.sendTextReply(
      chatId,
      replyToMessageId,
      "Concurrent workspaces are disabled. Set concurrentWorkspaces.enabled to true in telegram.json to use /workspace.",
    );
  const getUnreadByWorkspace = (): Record<string, number> =>
    Object.fromEntries(
      [...workspaceRuntimes.entries()].map(([name, runtime]) => [
        name,
        runtime.unreadEvents,
      ]),
    );
  const getDashboardWorkerState = (
    runtime: WorkspaceRuntime | undefined,
  ): TelegramWorkspaceDashboardWorkerState => {
    if (!hasLiveWorker(runtime)) return "not-started";
    return runtime?.record.status === "running" || runtime?.record.status === "starting"
      ? "running"
      : "idle";
  };
  const getDashboardWorkerStateByWorkspace = (
    workspaceState: TelegramWorkspacesState,
  ): Record<string, TelegramWorkspaceDashboardWorkerState> =>
    Object.fromEntries(
      Object.keys(workspaceState.workspaces).map((name) => [
        name,
        getDashboardWorkerState(workspaceRuntimes.get(name)),
      ]),
    );
  const sendForumNativeLifecycleDisabledReply = (
    chatId: number,
    replyToMessageId: number,
  ): Promise<number | undefined> =>
    deps.sendTextReply(
      chatId,
      replyToMessageId,
      TELEGRAM_FORUM_NATIVE_WORKSPACE_LIFECYCLE_DISABLED_MESSAGE,
    );
  const sendWorkspaceDashboard = async (
    workspaceState: TelegramWorkspacesState,
    chatId: number,
    replyToMessageId: number,
    filters: readonly string[] = [],
  ): Promise<void> => {
    await refreshDashboardWorkspaceRecords(workspaceState);
    const unreadByWorkspace = getUnreadByWorkspace();
    const workerStateByWorkspace = getDashboardWorkerStateByWorkspace(workspaceState);
    const forumNativeMode = isForumNativeMode();
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
        formatTelegramWorkspaceList(workspaceState, unreadByWorkspace, now(), {
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
        now(),
        "open",
        [],
        visibleWorkspaces,
        filterResult.trace,
        forumNativeMode,
        { live: getLiveWorkerCount(), max: getConfiguredMaxWorkers() },
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
      setDashboardState({
        chatId,
        messageId,
        mode: "open",
        selectedCloseWorkspaces: [],
        updatedAt: now(),
      });
    }
  };
  const editWorkspaceDashboard = async (
    workspaceState: TelegramWorkspacesState,
    chatId: number,
    messageId: number,
    options: {
      mode?: TelegramWorkspaceDashboardMode;
      selectedCloseWorkspaces?: readonly string[];
    } = {},
  ): Promise<void> => {
    await refreshDashboardWorkspaceRecords(workspaceState);
    const unreadByWorkspace = getUnreadByWorkspace();
    const workerStateByWorkspace = getDashboardWorkerStateByWorkspace(workspaceState);
    const existingState = getDashboardState(messageId);
    const forumNativeMode = isForumNativeMode();
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
        now(),
        mode,
        selectedCloseWorkspaces,
        undefined,
        [],
        forumNativeMode,
        { live: getLiveWorkerCount(), max: getConfiguredMaxWorkers() },
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
    setDashboardState({
      chatId,
      messageId,
      mode,
      selectedCloseWorkspaces,
      updatedAt: now(),
    });
  };
  const answerWorkspaceCallback = (
    callbackQueryId: string,
    text?: string,
  ): Promise<void> =>
    deps.answerCallbackQuery
      ? deps.answerCallbackQuery(callbackQueryId, text)
      : Promise.resolve();
  const closeWorkspaceRuntime = async (
    workspaceState: TelegramWorkspacesState,
    name: string,
    force: boolean,
  ): Promise<{ closed: boolean; message: string }> => {
    if (name === TELEGRAM_DEFAULT_WORKSPACE_NAME) {
      return { closed: false, message: "Cannot close General." };
    }
    const runtime = getWorkspaceRuntime(workspaceState, name);
    if (!runtime) {
      return { closed: false, message: `Unknown workspace: ${formatTelegramWorkspaceDisplayName(name)}` };
    }
    if (runtime.record.status === "running" && !force) {
      return {
        closed: false,
        message: `Workspace ${formatTelegramWorkspaceDisplayName(name)} is running. Use /workspace close ${formatTelegramWorkspaceDisplayName(name)} --force to close it.`,
      };
    }
    await disposeClosingRuntimeBackend(runtime);
    workspaceRuntimes.delete(name);
    delete workspaceState.workspaces[name];
    if (workspaceState.activeWorkspace === name) workspaceState.activeWorkspace = TELEGRAM_DEFAULT_WORKSPACE_NAME;
    return { closed: true, message: `Closed workspace ${formatTelegramWorkspaceDisplayName(name)}.` };
  };
  const commandHandlers = {
    list: async (
      workspaceState: TelegramWorkspacesState,
      chatId: number,
      replyToMessageId: number,
    ) => {
      await sendWorkspaceDashboard(workspaceState, chatId, replyToMessageId);
    },
    query: async (
      workspaceState: TelegramWorkspacesState,
      query: string,
      filters: readonly string[],
      chatId: number,
      replyToMessageId: number,
    ) => {
      const name = normalizeTelegramWorkspaceName(query);
      if (!isForumNativeMode() && getWorkspaceRuntime(workspaceState, name)) {
        await commandHandlers.switch(workspaceState, name, chatId, replyToMessageId);
        return;
      }
      await sendWorkspaceDashboard(workspaceState, chatId, replyToMessageId, filters);
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
      const createdAt = now();
      const record: TelegramWorkspaceRecord = {
        name,
        cwd: deps.getCwd(ctx),
        createdAt,
        lastUsedAt: createdAt,
        status: "idle",
      };
      const previousRuntime = getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
      if (previousRuntime) stopWorkspaceTyping(previousRuntime);
      workspaceState.workspaces[name] = record;
      workspaceState.activeWorkspace = name;
      const runtime: WorkspaceRuntime = createWorkspaceRuntime(record);
      workspaceRuntimes.set(name, runtime);
      await persist();
      try {
        await ensureBackend(runtime, ctx);
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
      const runtime = getWorkspaceRuntime(workspaceState, name);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown workspace: ${formatTelegramWorkspaceDisplayName(name)}`);
        return;
      }
      const previousRuntime = getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
      if (previousRuntime && previousRuntime !== runtime) stopWorkspaceTyping(previousRuntime);
      workspaceState.activeWorkspace = name;
      runtime.record.lastUsedAt = now();
      const shouldReplayUnread = runtime.unreadEvents > 0 && Boolean(deps.sendLastTurnsOnSwitch);
      runtime.unreadEvents = 0;
      if (runtime.record.status === "running") startWorkspaceTyping(name, runtime);
      await persist();
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
      const runtime = getWorkspaceRuntime(workspaceState, sourceName);
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
      runtime.record.lastUsedAt = now();
      workspaceState.workspaces[newName] = runtime.record;
      if (workspaceState.activeWorkspace === sourceName) workspaceState.activeWorkspace = newName;
      workspaceRuntimes.delete(sourceName);
      workspaceRuntimes.set(newName, runtime);
      await persist();
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
      const result = await closeWorkspaceRuntime(workspaceState, targetName, force);
      if (result.closed) await persist();
      await deps.sendTextReply(chatId, replyToMessageId, result.message);
    },
    status: async (
      workspaceState: TelegramWorkspacesState,
      name: string | undefined,
      chatId: number,
      replyToMessageId: number,
    ) => {
      if (!name) {
        await commandHandlers.list(workspaceState, chatId, replyToMessageId);
        return;
      }
      const runtime = getWorkspaceRuntime(workspaceState, name);
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
        await persist();
      }
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        formatTelegramWorkspaceStatus(runtime.record, runtime.unreadEvents, now()),
      );
    },
    abortRuntime: async (
      workspaceState: TelegramWorkspacesState,
      name: string | undefined,
    ): Promise<TelegramWorkspaceAbortResult> => {
      const targetName = name ?? workspaceState.activeWorkspace;
      const runtime = getWorkspaceRuntime(workspaceState, targetName);
      if (runtime) {
        const droppedTurns = runtime.pendingCompactionTurns ?? [];
        runtime.pendingCompactionTurns = undefined;
        for (const droppedTurn of droppedTurns) {
          await sendTurnTextReply(
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
            ? `No active worker for ${formatRuntimeUserScopeTarget(runtime)}.`
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
        await disposeRuntimeBackend(runtime).catch((disposeError) => {
          deps.recordRuntimeEvent?.("workspaces", disposeError, {
            workspace: targetName,
            action: "abort_dispose",
          });
        });
      }
      stopWorkspaceTyping(runtime);
      await markActiveWorkspaceTextStreamAborted(runtime).catch((error) => {
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: targetName,
          action: "stream_abort_mark",
          turnId: runtime.activeTurnId,
        });
      });
      runtime.record.status = "idle";
      runtime.record.lastError = undefined;
      await persist();
      return {
        workspaceName: targetName,
        aborted: true,
        message: abortError
          ? `Aborted ${formatRuntimeUserScopeTarget(runtime)} after worker stopped responding.`
          : `Aborted ${formatRuntimeUserScopeTarget(runtime)}.`,
      };
    },
    abort: async (
      workspaceState: TelegramWorkspacesState,
      name: string | undefined,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const result = await commandHandlers.abortRuntime(workspaceState, name);
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
        const runtime = getWorkspaceRuntime(workspaceState, record.name);
        if (!runtime) continue;
        const didSync = await syncTopicSessionNameToWorker(runtime, {
          forceWorker: true,
        });
        if (didSync) changed += 1;
      }
      if (changed > 0) await persist();
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
      const runtime = getWorkspaceRuntime(workspaceState, name);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown workspace: ${formatTelegramWorkspaceDisplayName(name)}`);
        return;
      }
      await disposeRuntimeBackend(runtime);
      try {
        await ensureBackend(runtime, ctx);
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
        const runtime = getWorkspaceRuntime(workspaceState, record.name);
        const proof = proofs.find((item) =>
          isSameTelegramTopicOrphanTarget(item, record.source!)
        );
        if (proof) {
          provenOrphans.push({ record, proof });
        } else if (record.status === "error" && record.lastError) {
          errored.push(record);
        } else if (!hasLiveWorker(runtime)) {
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
        const runtime = getWorkspaceRuntime(workspaceState, record.name);
        if (runtime) await disposeClosingRuntimeBackend(runtime);
        workspaceRuntimes.delete(record.name);
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
      await persist();
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        `Cleaned ${provenOrphans.length} proven topic orphan${provenOrphans.length === 1 ? "" : "s"}. Session files are kept.`,
      );
    },
  };
  const deliverPromptTurn = async (
    runtime: WorkspaceRuntime,
    turn: TelegramWorkspacePromptTurn,
    ctx: TContext,
    options: { wasRunning: boolean; replyOnSuccess?: boolean },
  ): Promise<void> => {
    const { wasRunning } = options;
    const replyOnSuccess = options.replyOnSuccess ?? true;
    const promptText = buildTelegramWorkspacePromptText(turn);
    if (!promptText) return;
    const promptNow = now();
    runtime.activeChatId = turn.chatId;
    runtime.activeMessageThreadId = turn.messageThreadId;
    runtime.activeReplyToMessageId = turn.replyToMessageId;
    runtime.activeTopicDelivery = isTopicBindingEnabled() &&
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
    await persist();
    startWorkspaceTyping(runtime.record.name, runtime);
    try {
      deps.debugLogger?.log(
        "telegram.workspace.prompt.start",
        {
          ...getWorkspaceTurnDetails(runtime.record.name, runtime),
          wasRunning,
        },
        promptText,
      );
      const promptStartedAt = Date.now();
      const backend = await ensureBackend(runtime, ctx);
      if (wasRunning) {
        await backend.followUp(promptText);
      } else {
        await backend.prompt(promptText);
      }
      runtime.promptSentAt = now();
      deps.debugLogger?.log("telegram.workspace.prompt.sent", {
        ...getWorkspaceTurnDetails(runtime.record.name, runtime),
        elapsedMs: Date.now() - promptStartedAt,
        wasRunning,
      });
      runtime.record.status = "running";
      await persist();
      if (replyOnSuccess) {
        await sendTurnTextReply(
          turn,
          wasRunning
            ? `Queued follow-up in ${formatRuntimeUserScopeTarget(runtime, turn)}.`
            : formatRuntimeStartedMessage(runtime, turn),
        );
      }
    } catch (error) {
      deps.debugLogger?.log("telegram.workspace.prompt.error", {
        ...getWorkspaceTurnDetails(runtime.record.name, runtime),
        error: error instanceof Error ? error.message : String(error),
      });
      logWorkspaceTurnSummary(
        runtime.record.name,
        runtime,
        "error",
        error instanceof Error ? error.message : String(error),
      );
      stopWorkspaceTyping(runtime);
      runtime.record.status = "error";
      runtime.record.lastError = getErrorMessage(error);
      deps.recordRuntimeEvent?.("workspaces", error, {
        workspace: runtime.record.name,
        action: "prompt",
      });
      await persist();
      await sendTurnTextReply(
        turn,
        formatRuntimeFailureMessage(runtime, getErrorMessage(error), turn),
      );
    }
  };
  const flushPendingCompactionTurns = async (
    runtime: WorkspaceRuntime,
    ctx: TContext,
  ): Promise<void> => {
    const pending = runtime.pendingCompactionTurns;
    if (!pending || pending.length === 0) return;
    runtime.pendingCompactionTurns = undefined;
    for (let index = 0; index < pending.length; index += 1) {
      const wasRunning = runtime.record.status === "running";
      await deliverPromptTurn(runtime, pending[index], ctx, { wasRunning });
    }
  };
  const clearPendingCompactionTurns = (runtime: WorkspaceRuntime): number => {
    const count = runtime.pendingCompactionTurns?.length ?? 0;
    runtime.pendingCompactionTurns = undefined;
    return count;
  };
  return {
    isEnabled,
    getActiveModel: async (ctx) => {
      if (!isEnabled()) return undefined;
      const runtime = await getActiveRuntime(ctx);
      if (!runtime) return undefined;
      await refreshRuntimeState(runtime);
      return runtime.record.currentModel;
    },
    getActiveThinkingLevel: async (ctx) => {
      if (!isEnabled()) return undefined;
      const runtime = await getActiveRuntime(ctx);
      if (!runtime) return undefined;
      await refreshRuntimeState(runtime);
      const currentThinkingLevel = runtime.record.currentThinkingLevel;
      if (!isThinkingLevel(currentThinkingLevel ?? "")) return undefined;
      return currentThinkingLevel as ThinkingLevel;
    },
    getActiveSessionReference: (ctx) => {
      if (!isEnabled()) return undefined;
      const runtime = getActiveRuntimeSync(ctx);
      if (!runtime) return undefined;
      return getTelegramWorkspaceSessionReference(runtime.record, deps.getCwd(ctx));
    },
    getActiveResumeSessionScope: (ctx) => {
      if (!isEnabled()) return undefined;
      const runtime = getActiveRuntimeSync(ctx);
      if (!runtime) return undefined;
      const cwd = runtime.record.cwd || deps.getCwd(ctx);
      return {
        kind: "workspace",
        workspaceName: runtime.record.name,
        cwd,
        sessionDir: deps.getSessionDir?.(ctx) ?? configuredSessionDir,
        currentSessionFile: runtime.record.sessionFile,
      };
    },
    getActiveSessionName: (ctx) => {
      if (!isEnabled()) return undefined;
      const runtime = getActiveRuntimeSync(ctx);
      return runtime?.record.sessionName;
    },
    canSwitchActiveModel: async (ctx) => {
      if (!isEnabled()) return false;
      const runtime = await getActiveRuntime(ctx);
      if (!runtime) return false;
      await refreshRuntimeState(runtime);
      return canSwitchTelegramWorkspaceModel(runtime.record);
    },
    selectActiveModel: async (model, ctx) => {
      if (!isEnabled()) return false;
      const runtime = await getActiveRuntime(ctx);
      if (!runtime) return false;
      await refreshRuntimeState(runtime);
      if (!canSwitchTelegramWorkspaceModel(runtime.record)) return false;
      try {
        const backend = await ensureBackend(runtime, ctx);
        await backend.setModel(model.provider, model.id);
        runtime.record.currentModel = {
          provider: model.provider,
          id: model.id,
        };
        await refreshRuntimeState(runtime);
        return true;
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "set_model",
        });
        await persist();
        return false;
      }
    },
    setActiveThinkingLevel: async (level, ctx) => {
      if (!isEnabled()) return undefined;
      const runtime = await getActiveRuntime(ctx);
      if (!runtime) return undefined;
      await refreshRuntimeState(runtime);
      if (!canSwitchTelegramWorkspaceModel(runtime.record)) return undefined;
      try {
        const backend = await ensureBackend(runtime, ctx);
        await backend.setThinkingLevel(level);
        const childState = await backend.getState();
        applyRpcStateToRecord(runtime.record, childState);
        if (!runtime.record.currentThinkingLevel) {
          runtime.record.currentThinkingLevel = level;
        }
        await persist();
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
        await persist();
        return undefined;
      }
    },
    setActiveSessionName: async (name, ctx) => {
      if (!isEnabled()) return false;
      const runtime = await getActiveRuntime(ctx);
      if (!runtime) return false;
      const normalizedName = normalizeTelegramWorkspaceSessionName(name);
      if (normalizedName === undefined) {
        delete runtime.record.sessionName;
      } else {
        runtime.record.sessionName = normalizedName;
      }
      await persist();
      try {
        const backend = await ensureBackend(runtime, ctx);
        await backend.setSessionName(name);
        const childState = await backend.getState();
        applyRpcStateToRecord(runtime.record, childState);
        if (
          normalizedName === undefined &&
          childState.sessionName === undefined
        ) {
          delete runtime.record.sessionName;
        }
        await persist();
      } catch (error) {
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "set_session_name",
        });
      }
      return true;
    },
    compactActive: (ctx, callbacks) => {
      if (!isEnabled()) return false;
      const runtime = getActiveRuntimeSync(ctx);
      if (!runtime) return false;
      if (
        runtime.record.status === "running" ||
        runtime.record.status === "starting"
      ) {
        throw new Error(formatRuntimeBusyMessage(runtime));
      }
      void (async () => {
        try {
          runtime.record.status = "starting";
          runtime.record.lastError = undefined;
          runtime.record.lastUsedAt = now();
          await persist();
          const backend = await ensureBackend(runtime, ctx);
          await backend.compact();
          const childState = await backend.getState();
          applyRpcStateToRecord(runtime.record, childState);
          runtime.record.status =
            childState.isStreaming === true || childState.isCompacting === true
              ? "running"
              : "idle";
          runtime.record.lastUsedAt = now();
          await persist();
          callbacks.onComplete();
          await flushPendingCompactionTurns(runtime, ctx);
        } catch (error) {
          runtime.record.status = "error";
          runtime.record.lastError = getErrorMessage(error);
          deps.recordRuntimeEvent?.("workspaces", error, {
            workspace: runtime.record.name,
            action: "compact",
          });
          await persist();
          callbacks.onError(error);
          const droppedTurns = runtime.pendingCompactionTurns ?? [];
          clearPendingCompactionTurns(runtime);
          for (const droppedTurn of droppedTurns) {
            await sendTurnTextReply(
              droppedTurn,
              "Compaction failed; this queued prompt was dropped. Resend after the worker recovers.",
            ).catch(() => undefined);
          }
        }
      })();
      return true;
    },
    newActiveSession: async (ctx) => {
      if (!isEnabled()) return undefined;
      const runtime = await getActiveRuntime(ctx);
      if (!runtime) return undefined;
      await refreshRuntimeState(runtime);
      if (
        runtime.record.status === "running" ||
        runtime.record.status === "starting"
      ) {
        throw new Error(formatRuntimeBusyMessage(runtime));
      }
      try {
        const backend = await ensureBackend(runtime, ctx);
        const result = await backend.newSession();
        if (result.cancelled) return { cancelled: true };
        const topicSessionName = getTelegramTopicSessionName(runtime.record);
        if (topicSessionName) {
          await syncTopicSessionNameToWorker(runtime, { forceWorker: true });
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
        runtime.record.lastUsedAt = now();
        resetRuntimeTurnBuffers(runtime);
        await persist();
        return { cancelled: false };
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "new_session",
        });
        await persist();
        throw error;
      }
    },
    deleteActiveSession: async (expectedSessionPath, ctx) => {
      if (!isEnabled()) return undefined;
      const workspaceState = await ensureState(deps.getCwd(ctx));
      const scoped = await resolveScopedTopicRuntime(workspaceState, ctx);
      const runtime = scoped.scoped
        ? scoped.runtime
        : getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
      if (!runtime) return undefined;
      await refreshRuntimeState(runtime);
      if (!canSwitchTelegramWorkspaceModel(runtime.record)) {
        throw new Error(formatRuntimeStopFirstMessage(runtime));
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
      await assertNoOpenSessionConflict(workspaceState, runtime, runtime.record);
      try {
        const backend = await ensureBackend(runtime, ctx);
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
        runtime.record.lastUsedAt = now();
        resetRuntimeTurnBuffers(runtime);
        await persist();
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "delete_session",
        });
        await persist();
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
      if (!isEnabled()) return undefined;
      const workspaceState = await ensureState(deps.getCwd(ctx));
      const scoped = await resolveScopedTopicRuntime(workspaceState, ctx);
      return commandHandlers.abortRuntime(workspaceState, scoped.runtime?.record.name);
    },
    switchSession: async (sessionPath, ctx, scope) => {
      if (!isEnabled() || scope?.kind !== "workspace" || !scope.workspaceName) {
        return false;
      }
      const workspaceState = await ensureState(deps.getCwd(ctx));
      const runtime = getWorkspaceRuntime(workspaceState, scope.workspaceName);
      if (!runtime) {
        throw new Error(`Unknown workspace: ${formatTelegramWorkspaceDisplayName(scope.workspaceName)}`);
      }
      await refreshRuntimeState(runtime);
      if (!canSwitchTelegramWorkspaceModel(runtime.record)) {
        throw new Error(formatScopedWorkspaceBusyMessage(scope.workspaceName));
      }
      await assertNoOpenSessionConflict(workspaceState, runtime, {
        sessionFile: sessionPath,
      });
      try {
        const backend = await ensureBackend(runtime, ctx);
        const result = await backend.switchSession(sessionPath);
        if (result.cancelled) {
          throw new Error("switchSession cancelled");
        }
        const topicSessionName = getTelegramTopicSessionName(runtime.record);
        if (topicSessionName) {
          await syncTopicSessionNameToWorker(runtime, { forceWorker: true });
        }
        stopWorkspaceTyping(runtime);
        resetRuntimeTurnBuffers(runtime);
        delete runtime.record.lastAssistantText;
        delete runtime.record.lastMessageText;
        delete runtime.record.lastMessageAt;
        runtime.record.sessionFile = sessionPath;
        runtime.record.lastError = undefined;
        const childState = await refreshRuntimeState(runtime);
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
          await disposeRuntimeBackend(runtime);
          runtime.record.sessionFile = sessionPath;
          runtime.record.status = "starting";
          runtime.record.lastError = undefined;
          delete runtime.record.sessionId;
          delete runtime.record.sessionName;
          await persist();
          await ensureBackend(runtime, ctx);
          if (!isSameTelegramWorkspaceSessionFile(runtime.record.sessionFile, sessionPath)) {
            throw new Error(
              formatRuntimeSessionBindFailureMessage(scope.workspaceName, sessionPath),
            );
          }
          const topicSessionNameAfterRestart = getTelegramTopicSessionName(
            runtime.record,
          );
          if (topicSessionNameAfterRestart && runtime.backend) {
            await syncTopicSessionNameToWorker(runtime, { forceWorker: true });
          }
        }
        const topicSessionNameAfterSwitch = getTelegramTopicSessionName(
          runtime.record,
        );
        if (topicSessionNameAfterSwitch) {
          runtime.record.sessionName = topicSessionNameAfterSwitch;
        }
        runtime.record.lastUsedAt = now();
        await persist();
        return true;
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "switch_session",
        });
        await persist();
        throw error;
      }
    },
    createActiveTreeBranch: async (entryId, ctx) => {
      if (!isEnabled()) return undefined;
      const runtime = await getActiveRuntime(ctx);
      if (!runtime) return undefined;
      await refreshRuntimeState(runtime);
      if (!canSwitchTelegramWorkspaceModel(runtime.record)) {
        throw new Error(formatRuntimeAbortFirstMessage(runtime));
      }
      try {
        if (!deps.createTreeBranch) {
          throw new Error(formatRuntimeTreeBranchUnavailableMessage());
        }
        const result = await deps.createTreeBranch(
          getTelegramWorkspaceSessionReference(runtime.record, deps.getCwd(ctx)),
          entryId,
        );
        if (result.cancelled) return result;
        await disposeRuntimeBackend(runtime);
        resetRuntimeTurnBuffers(runtime);
        delete runtime.record.lastAssistantText;
        delete runtime.record.lastMessageText;
        delete runtime.record.lastMessageAt;
        delete runtime.record.lastAgentStartAt;
        delete runtime.record.lastAgentEndAt;
        runtime.record.lastError = undefined;
        runtime.record.status = "idle";
        runtime.record.lastUsedAt = now();
        await persist();
        return result;
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "create_tree_branch",
        });
        await persist();
        throw error;
      }
    },
    handleCommand: async (args, chatId, replyToMessageId, ctx) => {
      if (!isEnabled()) {
        await replyDisabled(chatId, replyToMessageId);
        return true;
      }
      const workspaceState = await ensureState(deps.getCwd(ctx));
      const command = parseTelegramWorkspaceCommand(args);
      switch (command.kind) {
        case "list":
          await commandHandlers.list(workspaceState, chatId, replyToMessageId);
          return true;
        case "new":
          if (isForumNativeMode()) {
            await sendForumNativeLifecycleDisabledReply(chatId, replyToMessageId);
            return true;
          }
          await commandHandlers.new(workspaceState, command.name, chatId, replyToMessageId, ctx);
          return true;
        case "query":
          await commandHandlers.query(workspaceState, command.query, command.filters, chatId, replyToMessageId);
          return true;
        case "switch":
          if (isForumNativeMode()) {
            await sendForumNativeLifecycleDisabledReply(chatId, replyToMessageId);
            return true;
          }
          await commandHandlers.switch(workspaceState, command.name, chatId, replyToMessageId);
          return true;
        case "rename":
          if (isForumNativeMode()) {
            await sendForumNativeLifecycleDisabledReply(chatId, replyToMessageId);
            return true;
          }
          await commandHandlers.rename(workspaceState, command.oldName, command.newName, chatId, replyToMessageId);
          return true;
        case "syncNames":
          await commandHandlers.syncNames(workspaceState, chatId, replyToMessageId);
          return true;
        case "close":
          if (isForumNativeMode()) {
            await sendForumNativeLifecycleDisabledReply(chatId, replyToMessageId);
            return true;
          }
          await commandHandlers.close(workspaceState, command.name, command.force, chatId, replyToMessageId);
          return true;
        case "status":
          await commandHandlers.status(workspaceState, command.name, chatId, replyToMessageId);
          return true;
        case "abort":
          await commandHandlers.abort(workspaceState, command.name, chatId, replyToMessageId);
          return true;
        case "restart":
          await commandHandlers.restart(workspaceState, command.name, chatId, replyToMessageId, ctx);
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
      if (!isEnabled()) {
        await replyDisabled(chatId, replyToMessageId);
        return true;
      }
      const workspaceState = await ensureState(deps.getCwd(ctx));
      const cleanedArgs = args.trim().toLowerCase();
      if (!cleanedArgs || cleanedArgs === "orphans") {
        await commandHandlers.topicOrphans(workspaceState, chatId, replyToMessageId);
        return true;
      }
      if (cleanedArgs === "cleanup") {
        await commandHandlers.topicCleanup(workspaceState, chatId, replyToMessageId);
        return true;
      }
      await deps.sendTextReply(chatId, replyToMessageId, formatTelegramTopicRepairUsage());
      return true;
    },
    handleCallbackQuery: async (query, ctx) => {
      const data = query.data;
      if (!data?.startsWith("workspace:")) return false;
      if (!isEnabled()) {
        await answerWorkspaceCallback(query.id, "Concurrent workspaces are disabled.");
        return true;
      }
      const chatId = query.message?.chat?.id;
      const messageId = query.message?.message_id;
      if (typeof chatId !== "number" || typeof messageId !== "number") {
        await answerWorkspaceCallback(query.id);
        return true;
      }
      const workspaceState = await ensureState(deps.getCwd(ctx));
      const [, action, rawMode, rawName] = data.split(":");
      if (
        isForumNativeMode() &&
        (action === "switch" || action === "close" || action?.startsWith("close-"))
      ) {
        await answerWorkspaceCallback(
          query.id,
          TELEGRAM_FORUM_NATIVE_WORKSPACE_LIFECYCLE_DISABLED_MESSAGE,
        );
        await editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "open",
          selectedCloseWorkspaces: [],
        });
        return true;
      }
      if (action === "noop") {
        const activeRuntime = getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
        await answerWorkspaceCallback(
          query.id,
          `Active workspace: ${formatTelegramWorkspaceDisplayName(
            activeRuntime?.record.name ?? workspaceState.activeWorkspace,
          )}`,
        );
        return true;
      }
      if (action === "refresh") {
        await editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "open",
          selectedCloseWorkspaces: [],
        });
        await answerWorkspaceCallback(query.id, "Refreshed.");
        return true;
      }
      if (action === "close-manage") {
        await editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "close",
          selectedCloseWorkspaces: [],
        });
        await answerWorkspaceCallback(query.id);
        return true;
      }
      if (action === "close-done") {
        await editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "open",
          selectedCloseWorkspaces: [],
        });
        await answerWorkspaceCallback(query.id, "Done.");
        return true;
      }
      if (action === "close-toggle") {
        const name = decodeTelegramWorkspaceCallbackName(rawMode);
        if (!name || !workspaceState.workspaces[name] || name === TELEGRAM_DEFAULT_WORKSPACE_NAME) {
          await answerWorkspaceCallback(query.id, "Workspace cannot be closed.");
          await editWorkspaceDashboard(workspaceState, chatId, messageId, { mode: "close" });
          return true;
        }
        const dashboardState = getDashboardState(messageId);
        const selected = new Set(
          normalizeTelegramWorkspaceCloseSelection(
            workspaceState,
            dashboardState?.selectedCloseWorkspaces ?? [],
          ),
        );
        if (selected.has(name)) selected.delete(name);
        else selected.add(name);
        await editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "close",
          selectedCloseWorkspaces: [...selected],
        });
        await answerWorkspaceCallback(
          query.id,
          selected.has(name) ? "Selected." : "Unselected.",
        );
        return true;
      }
      if (action === "close-select-all") {
        const selectedCloseWorkspaces = getTelegramWorkspaceCloseableNames(workspaceState);
        await editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "close",
          selectedCloseWorkspaces,
        });
        await answerWorkspaceCallback(
          query.id,
          selectedCloseWorkspaces.length > 0 ? "All closeable workspaces selected." : "No closeable workspaces.",
        );
        return true;
      }
      if (action === "close-clear") {
        await editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "close",
          selectedCloseWorkspaces: [],
        });
        await answerWorkspaceCallback(query.id, "Selection cleared.");
        return true;
      }
      if (action === "close-selected") {
        const dashboardState = getDashboardState(messageId);
        const selectedCloseWorkspaces = normalizeTelegramWorkspaceCloseSelection(
          workspaceState,
          dashboardState?.selectedCloseWorkspaces ?? [],
        );
        if (selectedCloseWorkspaces.length === 0) {
          await answerWorkspaceCallback(query.id, "No workspaces selected.");
          return true;
        }
        await deps.editInteractiveMessage?.(
          chatId,
          messageId,
          buildTelegramWorkspaceMultiCloseConfirmationText(workspaceState, selectedCloseWorkspaces),
          "plain",
          buildTelegramWorkspaceMultiCloseConfirmationReplyMarkup(),
        );
        setDashboardState({
          chatId,
          messageId,
          mode: "close",
          selectedCloseWorkspaces,
          updatedAt: now(),
        });
        await answerWorkspaceCallback(query.id);
        return true;
      }
      if (action === "close-cancel") {
        const selectedCloseWorkspaces = normalizeTelegramWorkspaceCloseSelection(
          workspaceState,
          getDashboardState(messageId)?.selectedCloseWorkspaces ?? [],
        );
        await editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "close",
          selectedCloseWorkspaces,
        });
        await answerWorkspaceCallback(query.id, "Cancelled.");
        return true;
      }
      if (action === "close-confirm") {
        const selectedCloseWorkspaces = normalizeTelegramWorkspaceCloseSelection(
          workspaceState,
          getDashboardState(messageId)?.selectedCloseWorkspaces ?? [],
        );
        if (selectedCloseWorkspaces.length === 0) {
          await answerWorkspaceCallback(query.id, "No workspaces selected.");
          return true;
        }
        const closedNames: string[] = [];
        const skippedMessages: string[] = [];
        try {
          for (const name of selectedCloseWorkspaces) {
            const result = await closeWorkspaceRuntime(workspaceState, name, true);
            if (result.closed) closedNames.push(name);
            else skippedMessages.push(result.message);
          }
          if (closedNames.length > 0) await persist();
        } catch (error) {
          await answerWorkspaceCallback(
            query.id,
            `Close failed: ${getErrorMessage(error)}`,
          );
          return true;
        }
        await editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "open",
          selectedCloseWorkspaces: [],
        });
        const skippedSuffix = skippedMessages.length > 0
          ? ` ${skippedMessages.length} skipped.`
          : "";
        await answerWorkspaceCallback(
          query.id,
          `${closedNames.length} workspace${closedNames.length === 1 ? "" : "s"} closed.${skippedSuffix}`,
        );
        return true;
      }
      if (action === "switch") {
        const name = decodeTelegramWorkspaceCallbackName(rawMode);
        if (!name || !workspaceState.workspaces[name]) {
          await answerWorkspaceCallback(query.id, "Workspace no longer exists.");
          await editWorkspaceDashboard(workspaceState, chatId, messageId, {
            mode: "open",
            selectedCloseWorkspaces: [],
          });
          return true;
        }
        await answerWorkspaceCallback(query.id, `Switching to ${name}.`);
        await commandHandlers.switch(workspaceState, name, chatId, messageId);
        await editWorkspaceDashboard(workspaceState, chatId, messageId, {
          mode: "open",
          selectedCloseWorkspaces: [],
        });
        return true;
      }
      if (action === "last5") {
        const runtime = getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
        if (!runtime || !deps.sendLastTurnsOnSwitch) {
          await answerWorkspaceCallback(query.id, "No replay available.");
          return true;
        }
        await answerWorkspaceCallback(query.id, "Replaying latest turn.");
        await deps.sendLastTurnsOnSwitch(
          getTelegramWorkspaceSessionReference(runtime.record),
          chatId,
          messageId,
        );
        return true;
      }
      if (action === "status") {
        await answerWorkspaceCallback(query.id, "Sending status.");
        await commandHandlers.status(workspaceState, workspaceState.activeWorkspace, chatId, messageId);
        return true;
      }
      if (action === "help") {
        const text = isForumNativeMode()
          ? TELEGRAM_FORUM_NATIVE_WORKSPACE_LIFECYCLE_DISABLED_MESSAGE
          : rawMode === "rename"
            ? "Use /workspace rename [old-name] <new-name>."
            : "Use /workspace new <name>.";
        await answerWorkspaceCallback(query.id, text);
        return true;
      }
      if (action === "abort" || action === "close") {
        const mode = rawMode;
        const name = decodeTelegramWorkspaceCallbackName(
          mode === "do" ? rawName : rawMode,
        );
        if (!name || !workspaceState.workspaces[name]) {
          await answerWorkspaceCallback(query.id, "Workspace no longer exists.");
          await editWorkspaceDashboard(workspaceState, chatId, messageId, {
            mode: "open",
            selectedCloseWorkspaces: [],
          });
          return true;
        }
        if (mode === "do") {
          await answerWorkspaceCallback(
            query.id,
            action === "abort" ? `Aborting ${name}.` : `Closing ${name}.`,
          );
          if (action === "abort") {
            await commandHandlers.abort(workspaceState, name, chatId, messageId);
          } else {
            await commandHandlers.close(workspaceState, name, true, chatId, messageId);
          }
          await editWorkspaceDashboard(workspaceState, chatId, messageId, {
            mode: "open",
            selectedCloseWorkspaces: [],
          });
          return true;
        }
        const runtime = getWorkspaceRuntime(workspaceState, name);
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
        await answerWorkspaceCallback(query.id);
        return true;
      }
      await answerWorkspaceCallback(query.id);
      return true;
    },
    handleTopicServiceMessage: async (message, ctx) => {
      const serviceKind = getTelegramTopicServiceKind(message);
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
      if (!isTopicBindingEnabled()) return true;
      if (typeof chatId !== "number" || typeof messageThreadId !== "number") {
        return true;
      }
      if (!isTrustedTopicBindingChat(chatId)) {
        deps.debugLogger?.log("telegram.workspace.topic.service.untrusted_chat", {
          kind: serviceKind,
          chatId,
          messageThreadId,
          hasFrom: "from" in message,
        });
        return true;
      }
      const workspaceState = await ensureState(deps.getCwd(ctx));
      if (serviceKind === "created") {
        await upsertTelegramTopicWorkspaceRecord(
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
        if (record && updateTelegramTopicRecordTitle(record, message.forum_topic_edited?.name)) {
          const runtime = getWorkspaceRuntime(workspaceState, record.name);
          if (runtime) {
            await syncTopicSessionNameToWorker(runtime, { forceWorker: true });
          }
          await persist();
        }
        return true;
      }
      if (serviceKind === "closed") {
        const topicBinding = getTopicBindingConfig();
        if (!topicBinding?.closeOnTopicClose) return true;
        const record = findTelegramWorkspaceByTopic(
          workspaceState.workspaces,
          chatId,
          messageThreadId,
        );
        if (!record || record.name === TELEGRAM_DEFAULT_WORKSPACE_NAME) return true;
        const result = await closeWorkspaceRuntime(workspaceState, record.name, true);
        if (result.closed) await persist();
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
        if (!getTopicBindingConfig()?.autoCreate) return true;
        await upsertTelegramTopicWorkspaceRecord(
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
      if (!isEnabled()) return false;
      const workspaceState = await ensureState(deps.getCwd(ctx));
      const runtime = await getWorkspaceRuntimeForPromptTurn(workspaceState, turn, ctx);
      if (!runtime) return true;
      let childState: RpcChildSessionState | undefined;
      try {
        childState = await refreshRuntimeState(runtime);
        await assertNoOpenSessionConflict(workspaceState, runtime, runtime.record);
      } catch (error) {
        await sendTurnTextReply(turn, getErrorMessage(error));
        return true;
      }
      const promptText = buildTelegramWorkspacePromptText(turn);
      if (!promptText) {
        await sendTurnTextReply(
          turn,
          isForumNativeMode() ? "Topic prompt is empty." : "Workspace prompt is empty.",
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
        await sendTurnTextReply(
          turn,
          `Queued in ${formatRuntimeUserScopeTarget(runtime, turn)} (compaction in progress, ${queued.length} waiting).`,
        );
        return true;
      }
      if (isStarting) {
        await sendTurnTextReply(turn, formatRuntimeBusyMessage(runtime, turn));
        return true;
      }
      await deliverPromptTurn(runtime, turn, ctx, { wasRunning });
      return true;
    },
    dispose: async () => {
      await Promise.all(
        [...workspaceRuntimes.values()].map(async (runtime) => {
          await disposeClosingRuntimeBackend(runtime);
          if (runtime.record.status === "running" || runtime.record.status === "starting") {
            runtime.record.status = "exited";
          }
        }),
      );
      await persist();
    },
  };
}
