/**
 * Telegram concurrent tab runtime
 * Zones: telegram controls, pi agent, process lifecycle
 * Owns durable tab registry loading, per-tab RPC backend orchestration, and text-first Telegram delivery
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
  formatAgentToolCallBlock,
  getAgentMessageText,
  isAssistantAgentMessage,
  type TelegramRenderedChunk,
  type TelegramRenderMode,
} from "./replies.ts";
import {
  createDefaultTelegramTabsState,
  filterTelegramTabRecords,
  findTelegramTabByTopic,
  findTelegramTabNameCaseConflict,
  formatTelegramTabDisplayName,
  formatTelegramTabFilterSummary,
  formatTelegramTabList,
  formatTelegramTabRecordDisplayName,
  formatTelegramTabStatus,
  formatTelegramTabStatusLabel,
  formatTelegramTabUsage,
  normalizeTelegramTabName,
  normalizeTelegramTabsState,
  normalizeTelegramTopicTabName,
  parseTelegramTabCommand,
  TELEGRAM_DEFAULT_TAB_NAME,
  truncateTelegramTabText,
  validateTelegramTabName,
  type TelegramTabFilterTraceItem,
  type TelegramTabRecord,
  type TelegramTabSourceTelegramTopic,
  type TelegramTabsState,
} from "./tabs.ts";
import type { TelegramNormalizedConcurrentTabsConfig } from "./config.ts";
import { isTelegramForumTopicPermissionError } from "./api.ts";
import { isThinkingLevel, type ThinkingLevel } from "./model.ts";
import { getTelegramAgentDir, isTelegramTrustedChat } from "./config.ts";
import type { TelegramDebugLogger } from "./debug.ts";
import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import {
  getAmbientTelegramThreadContext,
  getTelegramForumThreadMessageThreadId,
  getTelegramForumTopicMessageThreadId,
  normalizeTelegramForumThread,
  runWithTelegramThreadContext,
} from "./thread-context.ts";

const TELEGRAM_TAB_STREAM_EDIT_THROTTLE_MS = 10_000;
const TELEGRAM_TAB_STREAM_FAILURE_BASE_RETRY_MS = 30_000;
const TELEGRAM_TAB_STREAM_FAILURE_MAX_RETRY_MS = 10 * 60 * 1000;
const TELEGRAM_TAB_STREAM_MARKDOWN_LIMIT = 3600;
const TELEGRAM_TAB_TYPING_ACTION_INTERVAL_MS = 8_000;
const TELEGRAM_TAB_DASHBOARD_STATE_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_TAB_TOOL_STATUS_MAX_ENTRIES = 6;
const TELEGRAM_FORUM_NATIVE_TAB_LIFECYCLE_DISABLED_MESSAGE =
  "Forum-native mode is enabled. Use Telegram topics to create, switch, and close workspaces.";

function getTelegramTabBooleanEnv(
  name: string,
  defaultValue: boolean,
): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return defaultValue;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return defaultValue;
}

type TelegramTabToolPreviewMode = "off" | "stream" | "compact";

function getTelegramTabToolPreviewMode(): TelegramTabToolPreviewMode {
  const value = process.env.PI_TELEGRAM_TOOL_PREVIEW_MODE?.trim().toLowerCase();
  if (value === "compact" || value === "summary") return "compact";
  if (value === "stream" || value === "full" || value === "on") return "stream";
  if (value === "off" || value === "0" || value === "false") return "off";
  return getTelegramTabBooleanEnv("PI_TELEGRAM_TOOL_PREVIEWS", true)
    ? "stream"
    : "off";
}

export interface TelegramTabPromptContent {
  type: string;
  text?: string;
}

export interface TelegramTabPromptTurn {
  chatId: number;
  messageThreadId?: number;
  replyToMessageId: number;
  content: readonly TelegramTabPromptContent[];
  statusSummary?: string;
}

export interface TelegramTabForumTopicServiceMessage {
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

export interface TelegramTabBackend {
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

export interface TelegramTabModelSelection {
  provider: string;
  id: string;
}

export interface TelegramTabSessionReference {
  tabName: string;
  cwd: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  currentModel?: TelegramTabModelSelection;
}

export interface TelegramTabResumeSessionScope {
  kind: "tab";
  tabName: string;
  cwd: string;
  sessionDir?: string;
  currentSessionFile?: string;
}

export interface TelegramTabAbortResult {
  tabName: string;
  aborted: boolean;
  message: string;
}

export interface TelegramTabTreeBranchResult {
  text?: string;
  cancelled: boolean;
  markerId?: string;
}

export interface TelegramTabManagerDeps<TContext> {
  getConfig: () => TelegramNormalizedConcurrentTabsConfig;
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
    reference: TelegramTabSessionReference,
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
  createBackend?: (options: RpcChildBackendOptions) => TelegramTabBackend;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  debugLogger?: TelegramDebugLogger;
  createTreeBranch?: (
    reference: TelegramTabSessionReference,
    entryId: string,
  ) => Promise<TelegramTabTreeBranchResult> | TelegramTabTreeBranchResult;
  deleteSessionFile?: (sessionPath: string) => Promise<void>;
  deleteForumTopic?: (
    chatId: number,
    messageThreadId: number,
  ) => Promise<boolean>;
}

interface RuntimeTab {
  record: TelegramTabRecord;
  backend?: TelegramTabBackend;
  closing?: boolean;
  unreadEvents: number;
  activeBuffer: string;
  activeAssistantText?: string;
  activeErrorDelivered?: boolean;
  streamDeliveryFailureCount?: number;
  streamDeliveryBlockedUntil?: number;
  lastStreamFlushAt?: number;
  textStream?: TelegramTabStreamState;
  thinkingBuffers: Map<number, string>;
  thinkingStreams: Map<number, TelegramTabStreamState>;
  toolCallStreams: Map<number, TelegramTabStreamState>;
  toolCallStatusStream?: TelegramTabStreamState;
  toolCallStatuses: Map<string, TelegramTabToolStatusEntry>;
  sentThinkingTexts: Set<string>;
  sentToolCallMessages: Set<string>;
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
  unsubscribe?: () => void;
}

type TelegramTabToolStatusKind = "queued" | "running" | "done" | "failed";

interface TelegramTabToolStatusEntry {
  key: string;
  markdown: string;
  status: TelegramTabToolStatusKind;
  updatedAt: number;
}

type TelegramTabDashboardMode = "open" | "close";

interface TelegramTabDashboardState {
  chatId: number;
  messageId: number;
  mode: TelegramTabDashboardMode;
  selectedCloseTabs: string[];
  updatedAt: number;
}

interface TelegramTabStreamState {
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
  flushPromise?: Promise<TelegramTabStreamDeliveryResult>;
  flushRequested?: boolean;
  suppressRetryOnFailure?: boolean;
}

type TelegramTabStreamDeliveryResult =
  | {
      status: "delivered";
      sentMarkdown: string;
      messageId?: number;
      stale: boolean;
    }
  | { status: "scheduled"; reason: string; retryAt?: number; stale: boolean }
  | { status: "skipped"; reason: string; stale: boolean }
  | { status: "failed"; error?: string; stale: boolean };

export interface TelegramTabMarkdownMessageEditorDeps {
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

export function createTelegramTabMarkdownMessageEditor(
  deps: TelegramTabMarkdownMessageEditorDeps,
): (chatId: number, messageId: number, markdown: string) => Promise<number | undefined> {
  return (chatId, messageId, markdown) =>
    deps.editRenderedMessage(
      chatId,
      messageId,
      deps.renderTelegramMessage(markdown, { mode: "markdown" }),
      { disableLinkPreview: true },
    );
}

export interface TelegramTabManager<TContext> {
  isEnabled: () => boolean;
  getActiveModel: (
    ctx: TContext,
  ) => Promise<TelegramTabModelSelection | undefined>;
  getActiveThinkingLevel: (ctx: TContext) => Promise<ThinkingLevel | undefined>;
  getActiveSessionReference: (
    ctx: TContext,
  ) => TelegramTabSessionReference | undefined;
  getActiveResumeSessionScope: (
    ctx: TContext,
  ) => TelegramTabResumeSessionScope | undefined;
  getActiveSessionName: (ctx: TContext) => string | undefined;
  canSwitchActiveModel: (ctx: TContext) => Promise<boolean>;
  selectActiveModel: (
    model: TelegramTabModelSelection,
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
  abortActive: (ctx: TContext) => Promise<TelegramTabAbortResult | undefined>;
  switchSession: (
    sessionPath: string,
    ctx: TContext,
    scope?: { kind?: string; tabName?: string },
  ) => Promise<boolean>;
  createActiveTreeBranch: (
    entryId: string,
    ctx: TContext,
  ) => Promise<TelegramTabTreeBranchResult | undefined>;
  handleCommand: (
    args: string,
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<boolean>;
  handleCallbackQuery: (
    query: TelegramTabCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
  handleTopicServiceMessage: (
    message: TelegramTabForumTopicServiceMessage,
    ctx: TContext,
  ) => Promise<boolean>;
  dispatchPrompt: (turn: TelegramTabPromptTurn, ctx: TContext) => Promise<boolean>;
  dispose: () => Promise<void>;
}

export interface TelegramTabCallbackQuery {
  id: string;
  data?: string;
  message?: { chat?: { id?: number }; message_id?: number };
}

export interface TelegramTabAwareModelMenuPorts<
  TContext,
  TModel extends TelegramTabModelSelection,
> {
  getActiveModel: (ctx: TContext) => Promise<TModel | undefined>;
  canSwitchModel: (ctx: TContext) => Promise<boolean> | boolean;
  canOfferInFlightModelSwitch: (ctx: TContext) => boolean;
}

export interface TelegramTabAwareModelMenuPortDeps<
  TContext,
  TModel extends TelegramTabModelSelection,
> {
  tabManager: TelegramTabManager<TContext>;
  getParentModel: (ctx: TContext) => TModel | undefined;
  findModel: (
    identity: TelegramTabModelSelection,
    ctx: TContext,
  ) => TModel | undefined;
  isParentIdle: (ctx: TContext) => boolean;
  canOfferParentInFlightModelSwitch: (ctx: TContext) => boolean;
}

export interface TelegramTabAwareSessionSnapshotPorts<TContext, TSnapshot> {
  getSnapshot: (ctx: TContext) => TSnapshot;
  canDeleteCurrent: (snapshot: unknown, ctx: TContext) => boolean;
  isReadOnly: (snapshot: unknown, ctx: TContext) => boolean;
}

export interface TelegramTabAwareSessionSnapshotPortDeps<TContext, TSnapshot> {
  tabManager: TelegramTabManager<TContext>;
  getParentSnapshot: (ctx: TContext) => TSnapshot;
  getTabSnapshot: (
    reference: TelegramTabSessionReference,
    ctx: TContext,
  ) => TSnapshot;
}

export function createTelegramTabAwareSessionSnapshotPorts<TContext, TSnapshot>(
  deps: TelegramTabAwareSessionSnapshotPortDeps<TContext, TSnapshot>,
): TelegramTabAwareSessionSnapshotPorts<TContext, TSnapshot> {
  const isActiveTabSession = (ctx: TContext): boolean =>
    deps.tabManager.getActiveSessionReference(ctx) !== undefined;
  const hasSessionFile = (snapshot: unknown): boolean =>
    typeof (snapshot as { sessionFile?: unknown }).sessionFile === "string" &&
    ((snapshot as { sessionFile?: string }).sessionFile?.length ?? 0) > 0;
  return {
    getSnapshot: (ctx) => {
      const reference = deps.tabManager.getActiveSessionReference(ctx);
      return reference
        ? deps.getTabSnapshot(reference, ctx)
        : deps.getParentSnapshot(ctx);
    },
    canDeleteCurrent: (snapshot, _ctx) => hasSessionFile(snapshot),
    isReadOnly: (_snapshot, ctx) => isActiveTabSession(ctx),
  };
}

export interface TelegramTabAwareSessionNamePorts<TContext> {
  getSessionName: (ctx: TContext) => string | undefined;
  setSessionName: (name: string, ctx: TContext) => void | Promise<void>;
}

export interface TelegramTabAwareSessionNamePortDeps<TContext> {
  tabManager: TelegramTabManager<TContext>;
  getParentSessionName: (ctx: TContext) => string | undefined;
  setParentSessionName: (
    name: string,
    ctx: TContext,
  ) => void | Promise<void>;
}

export function createTelegramTabAwareSessionNamePorts<TContext>(
  deps: TelegramTabAwareSessionNamePortDeps<TContext>,
): TelegramTabAwareSessionNamePorts<TContext> {
  return {
    getSessionName: (ctx) => {
      const reference = deps.tabManager.getActiveSessionReference(ctx);
      return reference
        ? reference.sessionName
        : deps.getParentSessionName(ctx);
    },
    setSessionName: async (name, ctx) => {
      const reference = deps.tabManager.getActiveSessionReference(ctx);
      if (reference) {
        const handled = await deps.tabManager.setActiveSessionName(name, ctx);
        if (handled) return;
      }
      await deps.setParentSessionName(name, ctx);
    },
  };
}

export interface TelegramTabAwareCompactPorts<TContext> {
  compact: (
    ctx: TContext,
    callbacks: { onComplete: () => void; onError: (error: unknown) => void },
  ) => void;
}

export interface TelegramTabAwareCompactPortDeps<TContext> {
  tabManager: TelegramTabManager<TContext>;
  compactParent: (
    ctx: TContext,
    callbacks: { onComplete: () => void; onError: (error: unknown) => void },
  ) => void;
}

export function createTelegramTabAwareCompactPorts<TContext>(
  deps: TelegramTabAwareCompactPortDeps<TContext>,
): TelegramTabAwareCompactPorts<TContext> {
  return {
    compact: (ctx, callbacks) => {
      const handled = deps.tabManager.compactActive(ctx, callbacks);
      if (!handled) deps.compactParent(ctx, callbacks);
    },
  };
}

export interface TelegramTabAwareNewSessionPorts<TContext> {
  injectNewSession: (ctx: TContext) => Promise<boolean>;
}

export interface TelegramTabAwareNewSessionPortDeps<TContext> {
  tabManager: TelegramTabManager<TContext>;
  injectParentNewSession: () => Promise<void>;
}

export function createTelegramTabAwareNewSessionPorts<TContext>(
  deps: TelegramTabAwareNewSessionPortDeps<TContext>,
): TelegramTabAwareNewSessionPorts<TContext> {
  return {
    injectNewSession: async (ctx) => {
      const result = await deps.tabManager.newActiveSession(ctx);
      if (result !== undefined) return !result.cancelled;
      await deps.injectParentNewSession();
      return true;
    },
  };
}

export interface TelegramTabAwareSessionDeletePorts<TContext> {
  injectDeleteCurrentSession: (
    expectedSessionPath: string,
    ctx: TContext,
  ) => Promise<void>;
}

export interface TelegramTabAwareSessionDeletePortDeps<TContext> {
  tabManager: TelegramTabManager<TContext>;
  injectParentDeleteCurrentSession: (expectedSessionPath: string) => Promise<void>;
}

export function createTelegramTabAwareSessionDeletePorts<TContext>(
  deps: TelegramTabAwareSessionDeletePortDeps<TContext>,
): TelegramTabAwareSessionDeletePorts<TContext> {
  return {
    injectDeleteCurrentSession: async (expectedSessionPath, ctx) => {
      const handled = await deps.tabManager.deleteActiveSession(
        expectedSessionPath,
        ctx,
      );
      if (handled) return;
      await deps.injectParentDeleteCurrentSession(expectedSessionPath);
    },
  };
}

export interface TelegramTabAwareResumeMenuPorts<TContext> {
  getSessionScope: (
    ctx: TContext,
  ) => TelegramTabResumeSessionScope | undefined;
  injectResumeExec: (
    sessionPath: string,
    ctx: TContext,
    sessionScope?: { kind?: string; tabName?: string },
  ) => Promise<void>;
}

export interface TelegramTabAwareResumeMenuPortDeps<TContext> {
  tabManager: TelegramTabManager<TContext>;
  injectParentResumeExec: (sessionPath: string) => Promise<void>;
}

export function createTelegramTabAwareResumeMenuPorts<TContext>(
  deps: TelegramTabAwareResumeMenuPortDeps<TContext>,
): TelegramTabAwareResumeMenuPorts<TContext> {
  return {
    getSessionScope: (ctx) =>
      deps.tabManager.isEnabled()
        ? deps.tabManager.getActiveResumeSessionScope(ctx)
        : undefined,
    injectResumeExec: async (sessionPath, ctx, sessionScope) => {
      if (!deps.tabManager.isEnabled()) {
        await deps.injectParentResumeExec(sessionPath);
        return;
      }
      const activeScope =
        sessionScope?.kind === "tab" && sessionScope.tabName
          ? sessionScope
          : deps.tabManager.getActiveResumeSessionScope(ctx);
      if (!activeScope) {
        throw new Error("No active tab session scope for /resume.");
      }
      const handled = await deps.tabManager.switchSession(
        sessionPath,
        ctx,
        activeScope,
      );
      if (!handled) {
        throw new Error("Active tab did not handle /resume.");
      }
    },
  };
}

export interface TelegramTabAwareTreeMenuPorts<TContext> {
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
  ) => Promise<TelegramTabTreeBranchResult>;
}

export interface TelegramTabAwareTreeMenuPortDeps<TContext> {
  tabManager: TelegramTabManager<TContext>;
  injectParentTreeExec: (entryId: string, summarize: boolean) => Promise<void>;
}

export function createTelegramTabAwareTreeMenuPorts<TContext>(
  deps: TelegramTabAwareTreeMenuPortDeps<TContext>,
): TelegramTabAwareTreeMenuPorts<TContext> {
  const isActiveTabSession = (ctx: TContext): boolean =>
    deps.tabManager.getActiveSessionReference(ctx) !== undefined;
  return {
    isReadOnly: (_snapshot, ctx) => isActiveTabSession(ctx),
    canForkTree: (_snapshot, ctx) => isActiveTabSession(ctx),
    injectTreeExec: async (entryId, summarize, ctx) => {
      if (isActiveTabSession(ctx)) {
        throw new Error("Active tab tree navigation uses Create branch.");
      }
      await deps.injectParentTreeExec(entryId, summarize);
    },
    forkTreeEntry: async (entryId, ctx) => {
      const result = await deps.tabManager.createActiveTreeBranch(entryId, ctx);
      if (!result) throw new Error("No active tab session for tree branch.");
      return result;
    },
  };
}

export interface TelegramTabAwareTreeBranchMutators<TContext> {
  setBranchName: (
    entryId: string,
    name: string | undefined,
    ctx: TContext,
  ) => Promise<void> | void;
  deleteBranch: (entryId: string, ctx: TContext) => Promise<void> | void;
}

export interface TelegramTabAwareTreeBranchMutatorDeps<TContext> {
  tabManager: Pick<TelegramTabManager<TContext>, "getActiveSessionReference">;
  setParentBranchName: (
    entryId: string,
    name: string | undefined,
    ctx: TContext,
  ) => Promise<void> | void;
  deleteParentBranch: (entryId: string, ctx: TContext) => Promise<void> | void;
  setTabBranchName: (
    reference: TelegramTabSessionReference,
    entryId: string,
    name: string | undefined,
  ) => Promise<void> | void;
  deleteTabBranch: (
    reference: TelegramTabSessionReference,
    entryId: string,
    customType: string,
  ) => Promise<void> | void;
  branchMetadataCustomType: string;
}

export function createTelegramTabAwareTreeBranchMutators<TContext>(
  deps: TelegramTabAwareTreeBranchMutatorDeps<TContext>,
): TelegramTabAwareTreeBranchMutators<TContext> {
  return {
    setBranchName: function setBranchName(entryId, name, ctx) {
      const reference = deps.tabManager.getActiveSessionReference(ctx);
      if (reference) {
        return deps.setTabBranchName(reference, entryId, name);
      }
      return deps.setParentBranchName(entryId, name, ctx);
    },
    deleteBranch: function deleteBranch(entryId, ctx) {
      const reference = deps.tabManager.getActiveSessionReference(ctx);
      if (reference) {
        return deps.deleteTabBranch(
          reference,
          entryId,
          deps.branchMetadataCustomType,
        );
      }
      return deps.deleteParentBranch(entryId, ctx);
    },
  };
}

export function createTelegramTabAwareModelMenuPorts<
  TContext,
  TModel extends TelegramTabModelSelection,
>(
  deps: TelegramTabAwareModelMenuPortDeps<TContext, TModel>,
): TelegramTabAwareModelMenuPorts<TContext, TModel> {
  return {
    getActiveModel: async (ctx) => {
      if (!deps.tabManager.isEnabled()) return deps.getParentModel(ctx);
      const tabModel = await deps.tabManager.getActiveModel(ctx);
      if (!tabModel) return undefined;
      return deps.findModel(tabModel, ctx) ?? ({ ...tabModel } as TModel);
    },
    canSwitchModel: (ctx) =>
      deps.tabManager.isEnabled()
        ? deps.tabManager.canSwitchActiveModel(ctx)
        : deps.isParentIdle(ctx),
    canOfferInFlightModelSwitch: (ctx) =>
      deps.tabManager.isEnabled()
        ? false
        : deps.canOfferParentInFlightModelSwitch(ctx),
  };
}

export function createTelegramTabAwareThinkingLevelGetter<TContext>(deps: {
  tabManager: Pick<
    TelegramTabManager<TContext>,
    "isEnabled" | "getActiveThinkingLevel"
  >;
  getParentThinkingLevel: () => ThinkingLevel;
}): (ctx: TContext) => Promise<ThinkingLevel> | ThinkingLevel {
  return async (ctx) => {
    if (!deps.tabManager.isEnabled()) return deps.getParentThinkingLevel();
    return (
      (await deps.tabManager.getActiveThinkingLevel(ctx)) ??
      deps.getParentThinkingLevel()
    );
  };
}

export function createTelegramTabReferenceContextWindowGetter<
  TContext,
  TModel extends { contextWindow?: number },
>(deps: {
  getParentModel: (ctx: TContext) => TModel | undefined;
  findModel: (
    identity: TelegramTabModelSelection,
    ctx: TContext,
  ) => TModel | undefined;
}): (
  reference: TelegramTabSessionReference,
  ctx: TContext,
) => number | undefined {
  return (reference, ctx) =>
    reference.currentModel
      ? deps.findModel(reference.currentModel, ctx)?.contextWindow
      : deps.getParentModel(ctx)?.contextWindow;
}

export function createTelegramTabManagerShutdownHook<TContext>(
  manager: TelegramTabManager<TContext>,
): () => Promise<void> {
  return manager.dispose;
}

function getTelegramTabsStatePath(agentDir: string): string {
  return join(agentDir, "telegram-tabs.json");
}

async function readTelegramTabsState(
  statePath: string,
  cwd: string,
  now: number,
): Promise<TelegramTabsState> {
  if (!existsSync(statePath)) return createDefaultTelegramTabsState(cwd, now);
  const raw = JSON.parse(await readFile(statePath, "utf8")) as unknown;
  return normalizeTelegramTabsState(raw, cwd, now);
}

function readTelegramTabsStateSync(
  statePath: string,
  cwd: string,
  now: number,
): TelegramTabsState {
  if (!existsSync(statePath)) return createDefaultTelegramTabsState(cwd, now);
  const raw = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
  return normalizeTelegramTabsState(raw, cwd, now);
}

async function writeTelegramTabsState(
  statePath: string,
  state: TelegramTabsState,
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, JSON.stringify(state, null, "\t") + "\n", {
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

function buildTelegramTabPromptText(turn: TelegramTabPromptTurn): string {
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
  record: TelegramTabRecord,
  state: RpcChildSessionState,
): void {
  const model = parseTelegramTabModelSelection(state.model);
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

interface TelegramTabSessionIdentity {
  sessionFile?: string;
  canonicalSessionFile?: string;
  sessionId?: string;
}

function canonicalizeTelegramTabSessionFile(
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

function getTelegramTabSessionIdentity(
  value: Pick<TelegramTabSessionIdentity, "sessionFile" | "sessionId">,
): TelegramTabSessionIdentity {
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
          canonicalSessionFile: canonicalizeTelegramTabSessionFile(sessionFile),
        }
      : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function isSameTelegramTabSessionIdentity(
  left: TelegramTabSessionIdentity,
  right: TelegramTabSessionIdentity,
): boolean {
  if (left.canonicalSessionFile && right.canonicalSessionFile) {
    return left.canonicalSessionFile === right.canonicalSessionFile;
  }
  if (left.sessionId && right.sessionId) {
    return left.sessionId === right.sessionId;
  }
  return false;
}

function isSameTelegramTabSessionFile(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left || !right) return false;
  return isSameTelegramTabSessionIdentity(
    getTelegramTabSessionIdentity({ sessionFile: left }),
    getTelegramTabSessionIdentity({ sessionFile: right }),
  );
}

function formatTelegramTabSessionOwner(record: TelegramTabRecord): string {
  const displayName = formatTelegramTabRecordDisplayName(record);
  const topicTitle = record.source?.kind === "telegram-topic"
    ? normalizeTelegramTabSessionName(record.source.topicTitle ?? "")
    : undefined;
  if (topicTitle && topicTitle !== displayName) return `${topicTitle} (${displayName})`;
  return displayName;
}

function normalizeTelegramTabSessionName(name: string): string | undefined {
  const trimmed = name.trim();
  return trimmed ? trimmed : undefined;
}

function getTelegramTopicSessionName(
  record: TelegramTabRecord,
): string | undefined {
  if (record.source?.kind !== "telegram-topic") return undefined;
  return normalizeTelegramTabSessionName(record.source.topicTitle ?? "");
}

function canSwitchTelegramTabModel(record: TelegramTabRecord): boolean {
  return record.status !== "running" && record.status !== "starting";
}

function getTelegramTabSessionReference(
  record: TelegramTabRecord,
  fallbackCwd?: string,
): TelegramTabSessionReference {
  const reference: TelegramTabSessionReference = {
    tabName: record.name,
    cwd: record.cwd || fallbackCwd || "",
    sessionFile: record.sessionFile,
    sessionId: record.sessionId,
    sessionName: record.sessionName,
  };
  if (record.currentModel) reference.currentModel = record.currentModel;
  return reference;
}

function parseTelegramTabModelSelection(
  value: unknown,
): TelegramTabModelSelection | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  return typeof raw.provider === "string" && typeof raw.id === "string"
    ? { provider: raw.provider, id: raw.id }
    : undefined;
}

function buildTelegramTabWorkerExtensionArgs(
  extensions: readonly string[],
): string[] {
  return extensions.flatMap((extensionPath) => ["--extension", extensionPath]);
}

function createRuntimeTab(record: TelegramTabRecord): RuntimeTab {
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
  };
}

function clearTelegramTabStreamState(stream: TelegramTabStreamState): void {
  if (stream.flushTimer) {
    clearTimeout(stream.flushTimer);
    stream.flushTimer = undefined;
  }
}

function resetRuntimeTurnBuffers(runtime: RuntimeTab): void {
  runtime.activeBuffer = "";
  runtime.activeAssistantText = undefined;
  runtime.activeErrorDelivered = false;
  runtime.streamDeliveryFailureCount = undefined;
  runtime.streamDeliveryBlockedUntil = undefined;
  runtime.lastStreamFlushAt = undefined;
  if (runtime.textStream) {
    clearTelegramTabStreamState(runtime.textStream);
    runtime.textStream = undefined;
  }
  runtime.thinkingBuffers.clear();
  for (const stream of runtime.thinkingStreams.values()) {
    clearTelegramTabStreamState(stream);
  }
  for (const stream of runtime.toolCallStreams.values()) {
    clearTelegramTabStreamState(stream);
  }
  if (runtime.toolCallStatusStream) {
    clearTelegramTabStreamState(runtime.toolCallStatusStream);
    runtime.toolCallStatusStream = undefined;
  }
  runtime.thinkingStreams.clear();
  runtime.toolCallStreams.clear();
  runtime.toolCallStatuses.clear();
  runtime.sentThinkingTexts.clear();
  runtime.sentToolCallMessages.clear();
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

function appendTelegramTabTextBlock(current: string, text: string): string {
  if (!text) return current;
  if (!current) return text;
  const separator = current.endsWith("\n\n")
    ? ""
    : current.endsWith("\n")
      ? "\n"
      : "\n\n";
  return `${current}${separator}${text}`;
}

function extractAgentBodyText(message: unknown): string {
  let result = "";
  for (const block of getAgentMessageContent(message)) {
    const raw = getRecord(block);
    if (!raw || raw.type !== "text" || typeof raw.text !== "string") {
      continue;
    }
    result = appendTelegramTabTextBlock(result, raw.text);
  }
  return result.trim();
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

function formatTelegramTabToolCallPreview(block: unknown): string {
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
  const markdown = formatTelegramTabToolCallPreview(block);
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
): { key: string; markdown: string; status: TelegramTabToolStatusKind } | undefined {
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

function formatTelegramTabToolStatusKind(
  status: TelegramTabToolStatusKind,
): string {
  if (status === "running") return "running";
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  return "queued";
}

function formatTelegramTabCompactToolStatusMarkdown(
  entries: TelegramTabToolStatusEntry[],
  totalCount: number,
): string {
  const visibleEntries = entries.slice(-TELEGRAM_TAB_TOOL_STATUS_MAX_ENTRIES);
  const lines = ["\u{1F527} Tools"];
  if (totalCount > visibleEntries.length) {
    lines.push(`Showing latest ${visibleEntries.length} of ${totalCount}.`);
  }
  for (const entry of visibleEntries) {
    const blockLines = entry.markdown.trim().split("\n");
    const title = blockLines.shift()?.replace(/^\u{1F527}\s*/u, "") || "`tool`";
    lines.push("", `${formatTelegramTabToolStatusKind(entry.status)} ${title}`);
    lines.push(...blockLines);
  }
  return truncateTelegramTabStreamMarkdown(lines.join("\n"));
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
    return getAgentMessageText(event.message);
  }
  if (event.type !== "agent_end") return "";
  const latestAssistant = getLatestAssistantMessage(event.messages);
  return latestAssistant ? getAgentMessageText(latestAssistant) : "";
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
    "Telegram tab failed while processing the request."
  );
}

function formatTelegramTabThinkingMarkdown(text: string): string {
  const quoted = text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `💡 Thinking\n${quoted}`;
}

function getSortedTelegramTabRecords(state: TelegramTabsState): TelegramTabRecord[] {
  return Object.values(state.tabs).sort((a, b) => a.createdAt - b.createdAt);
}

function formatTelegramTabDashboardAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

function formatTelegramTabDashboardName(record: TelegramTabRecord): string {
  const name = record.sessionName?.trim();
  return name ? truncateTelegramTabText(name.replace(/\s+/g, " "), 36) : "unset";
}

function formatTelegramTabDashboardLastMessage(record: TelegramTabRecord): string {
  const text = (record.lastMessageText ?? record.lastAssistantText)?.replace(/\s+/g, " ").trim();
  return text ? truncateTelegramTabText(text, 96) : "No messages yet.";
}

function formatTelegramTabDashboardMeta(
  record: TelegramTabRecord,
  nowMs: number,
): string {
  const age = formatTelegramTabDashboardAge(nowMs - record.createdAt);
  const messageCount = Math.max(0, record.messageCount ?? 0);
  return [
    formatTelegramTabRecordDisplayName(record),
    formatTelegramTabStatusLabel(record.status),
    age,
    `${messageCount}msg`,
    formatTelegramTabDashboardName(record),
  ].join(" · ");
}

function getTelegramTabCloseableNames(state: TelegramTabsState): string[] {
  return getSortedTelegramTabRecords(state)
    .filter((tab) => tab.name !== TELEGRAM_DEFAULT_TAB_NAME)
    .map((tab) => tab.name);
}

function normalizeTelegramTabCloseSelection(
  state: TelegramTabsState,
  selectedCloseTabs: readonly string[],
): string[] {
  const closeable = new Set(getTelegramTabCloseableNames(state));
  const selected = new Set<string>();
  for (const name of selectedCloseTabs) {
    if (closeable.has(name)) selected.add(name);
  }
  return [...selected];
}

function formatTelegramTabDashboardSummary(
  state: TelegramTabsState,
  unreadByTab: Record<string, number>,
  maxTabs: number,
  nowMs: number,
  mode: TelegramTabDashboardMode = "open",
  selectedCloseTabs: readonly string[] = [],
  visibleTabs?: readonly TelegramTabRecord[],
  filterTrace: readonly TelegramTabFilterTraceItem[] = [],
  forumNativeMode = false,
): string {
  const allTabs = getSortedTelegramTabRecords(state);
  const tabs = mode === "open" && visibleTabs ? [...visibleTabs] : allTabs;
  const active = state.tabs[state.activeTab];
  const safeSelectedCloseTabs = normalizeTelegramTabCloseSelection(
    state,
    selectedCloseTabs,
  );
  const selectedSet = new Set(safeSelectedCloseTabs);
  const unreadTabs = allTabs
    .filter((tab) => (unreadByTab[tab.name] ?? 0) > 0)
    .map((tab) =>
      `${formatTelegramTabRecordDisplayName(tab)} ${unreadByTab[tab.name]}`
    );
  const filterSummary = mode === "open"
    ? formatTelegramTabFilterSummary(filterTrace)
    : undefined;
  const title = forumNativeMode ? "Forum topics" : "Tabs";
  const currentLabel = forumNativeMode ? "Current" : "Active";
  const lines = [
    filterSummary
      ? `${title} ${tabs.length}/${allTabs.length} filtered (${allTabs.length}/${maxTabs} total)`
      : `${title} ${allTabs.length}/${maxTabs}`,
    active
      ? [
          `${currentLabel}: ${formatTelegramTabRecordDisplayName(active)}`,
          formatTelegramTabStatusLabel(active.status),
          `${Math.max(0, active.messageCount ?? 0)}msg`,
          formatTelegramTabDashboardName(active),
        ].join(" · ")
      : `${currentLabel}: ${formatTelegramTabDisplayName(state.activeTab)}`,
  ];
  if (active?.currentThinkingLevel) {
    lines.push(`Thinking: ${active.currentThinkingLevel}`);
  }
  if (filterSummary) lines.push(filterSummary);
  lines.push(`Unread: ${unreadTabs.length > 0 ? unreadTabs.join(", ") : "none"}`);
  if (mode === "close") {
    const runningSelected = tabs
      .filter((tab) =>
        selectedSet.has(tab.name) &&
        (tab.status === "running" || tab.status === "starting")
      )
      .map((tab) => formatTelegramTabRecordDisplayName(tab));
    lines.push("Close mode: select tabs to close.");
    lines.push(`Selected: ${safeSelectedCloseTabs.length}`);
    lines.push("General is protected. Session files are kept.");
    if (runningSelected.length > 0) {
      lines.push(`Running selected: ${runningSelected.join(", ")} will be stopped.`);
    }
  }
  lines.push("");
  if (tabs.length === 0) {
    lines.push("No tabs match filters.");
  }
  for (const tab of tabs) {
    const marker = tab.name === state.activeTab ? "●" : "○";
    const unread = unreadByTab[tab.name] ? ` · unread ${unreadByTab[tab.name]}` : "";
    const closePrefix =
      mode === "close" && tab.name !== TELEGRAM_DEFAULT_TAB_NAME
        ? `${selectedSet.has(tab.name) ? "☑" : "☐"} `
        : "";
    const protectedLabel =
      mode === "close" && tab.name === TELEGRAM_DEFAULT_TAB_NAME
        ? " · protected"
        : "";
    lines.push(
      `${closePrefix}${marker} ${formatTelegramTabDashboardMeta(tab, nowMs)}${unread}${protectedLabel}`,
      `  ↳ ${formatTelegramTabDashboardLastMessage(tab)}`,
    );
  }
  return lines.join("\n");
}

function formatTelegramTabButtonLabel(
  record: TelegramTabRecord,
  activeTab: string,
  unreadCount: number,
): string {
  const active = record.name === activeTab ? "● " : "";
  const unread = unreadCount > 0 ? ` ${unreadCount}` : "";
  const running = record.status === "running" || record.status === "starting"
    ? " ▶"
    : record.status === "error"
      ? " !"
      : "";
  return `${active}${formatTelegramTabRecordDisplayName(record)}${unread}${running}`;
}

function encodeTelegramTabCallbackName(name: string): string {
  return encodeURIComponent(name).replace(/%20/g, "+");
}

function decodeTelegramTabCallbackName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  try {
    return decodeURIComponent(name.replace(/\+/g, "%20"));
  } catch {
    return undefined;
  }
}

function buildTelegramTabDashboardReplyMarkup(
  state: TelegramTabsState,
  unreadByTab: Record<string, number>,
  mode: TelegramTabDashboardMode = "open",
  selectedCloseTabs: readonly string[] = [],
  visibleTabs?: readonly TelegramTabRecord[],
  forumNativeMode = false,
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];
  const tabs = mode === "open" && visibleTabs
    ? [...visibleTabs]
    : getSortedTelegramTabRecords(state);
  if (mode === "close") {
    const safeSelectedCloseTabs = normalizeTelegramTabCloseSelection(
      state,
      selectedCloseTabs,
    );
    const selectedSet = new Set(safeSelectedCloseTabs);
    if (safeSelectedCloseTabs.length > 0) {
      rows.push([
        {
          text: `Close ${safeSelectedCloseTabs.length} selected`,
          callback_data: "tab:close-selected",
        },
      ]);
    }
    const closeableNames = getTelegramTabCloseableNames(state);
    if (closeableNames.length > 0) {
      const controls = [
        { text: "Select all", callback_data: "tab:close-select-all" },
      ];
      if (safeSelectedCloseTabs.length > 0) {
        controls.push({ text: "Clear selection", callback_data: "tab:close-clear" });
      }
      rows.push(controls);
    }
    for (let index = 0; index < tabs.length; index += 2) {
      const row = tabs.slice(index, index + 2).map((tab) => {
        if (tab.name === TELEGRAM_DEFAULT_TAB_NAME) {
          return {
            text: `${formatTelegramTabRecordDisplayName(tab)} protected`,
            callback_data: "tab:noop",
          };
        }
        const selected = selectedSet.has(tab.name);
        return {
          text: `${selected ? "☑" : "☐"} ${formatTelegramTabRecordDisplayName(tab)}`,
          callback_data: `tab:close-toggle:${encodeTelegramTabCallbackName(tab.name)}`,
        };
      });
      rows.push(row);
    }
    rows.push([{ text: "Done", callback_data: "tab:close-done" }]);
    return { inline_keyboard: rows };
  }
  for (let index = 0; index < tabs.length; index += 2) {
    const row = tabs.slice(index, index + 2).map((tab) => ({
      text: formatTelegramTabButtonLabel(
        tab,
        state.activeTab,
        unreadByTab[tab.name] ?? 0,
      ),
      callback_data:
        forumNativeMode || tab.name === state.activeTab
          ? "tab:noop"
          : `tab:switch:${encodeTelegramTabCallbackName(tab.name)}`,
    }));
    rows.push(row);
  }
  if (visibleTabs) {
    rows.push([{ text: "All tabs", callback_data: "tab:refresh" }]);
  }
  if (!forumNativeMode && getTelegramTabCloseableNames(state).length > 0) {
    rows.push([{ text: "Manage 🗑", callback_data: "tab:close-manage" }]);
  }
  if (!forumNativeMode) {
    rows.push([
      {
        text: "Close",
        callback_data: `tab:close:${encodeTelegramTabCallbackName(state.activeTab)}`,
      },
    ]);
  }
  return { inline_keyboard: rows };
}

function buildTelegramTabMultiCloseConfirmationText(
  state: TelegramTabsState,
  selectedCloseTabs: readonly string[],
): string {
  const selected = normalizeTelegramTabCloseSelection(state, selectedCloseTabs);
  const tabs = selected
    .map((name) => state.tabs[name])
    .filter((tab): tab is TelegramTabRecord => tab !== undefined);
  const shown = tabs.slice(0, 5).map((tab) =>
    `- ${formatTelegramTabRecordDisplayName(tab)} · ${formatTelegramTabStatusLabel(tab.status)}`
  );
  const more = tabs.length > shown.length
    ? [`- ...and ${tabs.length - shown.length} more`]
    : [];
  const hasRunning = tabs.some((tab) =>
    tab.status === "running" || tab.status === "starting"
  );
  return [
    `Close ${tabs.length} selected tab${tabs.length === 1 ? "" : "s"}?`,
    "",
    ...shown,
    ...more,
    "",
    "Session files are kept.",
    ...(hasRunning ? ["Running tabs will be stopped."] : []),
  ].join("\n");
}

function buildTelegramTabMultiCloseConfirmationReplyMarkup(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "No", callback_data: "tab:close-cancel" },
        { text: "Close selected", callback_data: "tab:close-confirm" },
      ],
    ],
  };
}

function buildTelegramTabConfirmReplyMarkup(
  action: "abort" | "close",
  tabName: string,
): TelegramInlineKeyboardMarkup {
  const encoded = encodeTelegramTabCallbackName(tabName);
  return {
    inline_keyboard: [
      [
        { text: action === "abort" ? "Confirm Abort" : "Confirm Close", callback_data: `tab:${action}:do:${encoded}` },
      ],
      [{ text: "Cancel", callback_data: "tab:refresh" }],
    ],
  };
}

function truncateTelegramTabStreamMarkdown(markdown: string): string {
  const trimmed = markdown.trim();
  if (trimmed.length <= TELEGRAM_TAB_STREAM_MARKDOWN_LIMIT) return trimmed;
  return trimmed.slice(trimmed.length - TELEGRAM_TAB_STREAM_MARKDOWN_LIMIT);
}

export function createTelegramTabManager<TContext>(
  deps: TelegramTabManagerDeps<TContext>,
): TelegramTabManager<TContext> {
  const agentDir = deps.agentDir ?? getTelegramAgentDir();
  const statePath = deps.statePath ?? getTelegramTabsStatePath(agentDir);
  const configuredSessionDir = deps.sessionDir;
  const runtimeTabs = new Map<string, RuntimeTab>();
  const dashboardStates = new Map<number, TelegramTabDashboardState>();
  let state: TelegramTabsState | undefined;
  let persistChain: Promise<void> = Promise.resolve();

  const now = (): number => deps.now?.() ?? Date.now();
  const isEnabled = (): boolean => deps.getConfig().enabled;
  const streamEditThrottleMs =
    deps.streamEditThrottleMs ?? TELEGRAM_TAB_STREAM_EDIT_THROTTLE_MS;
  const streamFailureBaseRetryMs =
    deps.streamFailureBaseRetryMs ?? TELEGRAM_TAB_STREAM_FAILURE_BASE_RETRY_MS;
  const streamFailureMaxRetryMs =
    deps.streamFailureMaxRetryMs ?? TELEGRAM_TAB_STREAM_FAILURE_MAX_RETRY_MS;
  const typingIntervalMs =
    deps.typingIntervalMs ?? TELEGRAM_TAB_TYPING_ACTION_INTERVAL_MS;
  const thinkingStreamPreviewsEnabled = getTelegramTabBooleanEnv(
    "PI_TELEGRAM_THINKING_PREVIEWS",
    true,
  );
  const toolCallPreviewMode = getTelegramTabToolPreviewMode();
  const toolCallCompactPreviewsEnabled = toolCallPreviewMode === "compact";
  const toolCallStreamPreviewsEnabled = toolCallPreviewMode === "stream";
  const pruneDashboardStates = (): void => {
    const cutoff = now() - TELEGRAM_TAB_DASHBOARD_STATE_TTL_MS;
    for (const [messageId, dashboardState] of dashboardStates.entries()) {
      if (dashboardState.updatedAt < cutoff) dashboardStates.delete(messageId);
    }
  };
  const getDashboardState = (
    messageId: number,
  ): TelegramTabDashboardState | undefined => {
    pruneDashboardStates();
    return dashboardStates.get(messageId);
  };
  const setDashboardState = (dashboardState: TelegramTabDashboardState): void => {
    pruneDashboardStates();
    dashboardStates.set(dashboardState.messageId, dashboardState);
  };
  const persist = (): Promise<void> => {
    if (!state) return Promise.resolve();
    const snapshot = {
      ...state,
      tabs: Object.fromEntries(
        Object.entries(state.tabs).map(([name, record]) => [name, { ...record }]),
      ),
    };
    persistChain = persistChain.then(() =>
      writeTelegramTabsState(statePath, snapshot),
    );
    return persistChain;
  };
  const hydrateRuntimeTabs = (tabState: TelegramTabsState): void => {
    for (const record of Object.values(tabState.tabs)) {
      const topicSessionName = getTelegramTopicSessionName(record);
      if (topicSessionName && !record.sessionName) {
        record.sessionName = topicSessionName;
      }
      if (!runtimeTabs.has(record.name)) {
        runtimeTabs.set(record.name, createRuntimeTab(record));
      }
    }
  };
  const ensureState = async (cwd: string): Promise<TelegramTabsState> => {
    if (!state) {
      state = await readTelegramTabsState(statePath, cwd, now());
      hydrateRuntimeTabs(state);
      await persist();
    }
    return state;
  };
  const ensureStateSync = (cwd: string): TelegramTabsState => {
    if (!state) {
      state = readTelegramTabsStateSync(statePath, cwd, now());
      hydrateRuntimeTabs(state);
      void persist();
    }
    return state;
  };
  const getRuntime = (
    tabState: TelegramTabsState,
    name: string,
  ): RuntimeTab | undefined => {
    const record = tabState.tabs[name];
    if (!record) return undefined;
    let runtime = runtimeTabs.get(name);
    if (!runtime) {
      runtime = createRuntimeTab(record);
      runtimeTabs.set(name, runtime);
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
  const isTopicDeliveryActive = (runtime: RuntimeTab): boolean =>
    runtime.activeTopicDelivery === true;
  const isRuntimeDeliveryActive = (
    tabState: TelegramTabsState,
    tabName: string,
    runtime: RuntimeTab,
  ): boolean => isTopicDeliveryActive(runtime) || tabState.activeTab === tabName;
  const runInTabThreadContext = <T>(runtime: RuntimeTab, fn: () => T): T => {
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
    turn: TelegramTabPromptTurn,
    text: string,
  ): Promise<number | undefined> =>
    runWithTelegramThreadContext(
      { chatId: turn.chatId, messageThreadId: turn.messageThreadId },
      () => deps.sendTextReply(turn.chatId, turn.replyToMessageId, text),
    );
  const sendTabReply = (
    chatId: number | undefined,
    replyToMessageId: number | undefined,
    text: string,
  ): Promise<number | undefined> => {
    if (chatId === undefined || replyToMessageId === undefined) {
      return Promise.resolve(undefined);
    }
    return deps.sendTextReply(chatId, replyToMessageId, text);
  };
  const sendTabMarkdownReply = (
    chatId: number | undefined,
    replyToMessageId: number | undefined,
    markdown: string,
  ): Promise<number | undefined> => {
    if (chatId === undefined) return Promise.resolve(undefined);
    return deps.sendMarkdownReply
      ? deps.sendMarkdownReply(chatId, replyToMessageId, markdown)
      : deps.sendTextReply(chatId, replyToMessageId, markdown);
  };
  const sendTabStreamMarkdownReply = (
    chatId: number | undefined,
    replyToMessageId: number | undefined,
    markdown: string,
  ): Promise<number | undefined> => {
    if (chatId === undefined) return Promise.resolve(undefined);
    return deps.sendStreamMarkdownReply
      ? deps.sendStreamMarkdownReply(chatId, replyToMessageId, markdown)
      : sendTabMarkdownReply(chatId, replyToMessageId, markdown);
  };
  const editTabStreamMarkdownMessage = (
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
  const stopTabTyping = (runtime: RuntimeTab): void => {
    if (runtime.typingInterval) {
      clearInterval(runtime.typingInterval);
      runtime.typingInterval = undefined;
    }
    runtime.typingChatId = undefined;
    runtime.typingMessageThreadId = undefined;
  };
  const stopOtherTabTyping = (tabName: string): void => {
    for (const [name, runtime] of runtimeTabs.entries()) {
      if (name !== tabName) stopTabTyping(runtime);
    }
  };
  const startTabTyping = (tabName: string, runtime: RuntimeTab): void => {
    const chatId = runtime.activeChatId;
    if (!deps.sendTypingAction || chatId === undefined || chatId === 0) return;
    if (!isTopicDeliveryActive(runtime)) stopOtherTabTyping(tabName);
    if (
      runtime.typingInterval &&
      runtime.typingChatId === chatId &&
      runtime.typingMessageThreadId === runtime.activeMessageThreadId
    ) {
      return;
    }
    stopTabTyping(runtime);
    const sendTyping = (): void => {
      void Promise.resolve(
        runInTabThreadContext(runtime, () => deps.sendTypingAction!(chatId)),
      ).catch((error) => {
        deps.recordRuntimeEvent?.("typing", error, {
          tab: runtime.record.name,
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
  const createStreamState = (): TelegramTabStreamState => ({
    markdown: "",
    sentMarkdown: "",
    lastFlushAt: 0,
  });
  const getStreamState = (
    streams: Map<number, TelegramTabStreamState>,
    index: number,
  ): TelegramTabStreamState => {
    let stream = streams.get(index);
    if (!stream) {
      stream = createStreamState();
      streams.set(index, stream);
    }
    return stream;
  };
  const getTextStreamState = (runtime: RuntimeTab): TelegramTabStreamState => {
    runtime.textStream ??= createStreamState();
    return runtime.textStream;
  };
  const getToolCallStatusStreamState = (
    runtime: RuntimeTab,
  ): TelegramTabStreamState => {
    runtime.toolCallStatusStream ??= createStreamState();
    return runtime.toolCallStatusStream;
  };
  const getStreamFailureRetryMs = (failureCount: number): number =>
    Math.min(
      streamFailureMaxRetryMs,
      streamFailureBaseRetryMs *
        2 ** Math.min(Math.max(0, failureCount - 1), 6),
    );
  const isTabStreamStale = (
    runtime: RuntimeTab,
    stream: TelegramTabStreamState,
  ): boolean =>
    stream.turnId !== undefined && runtime.activeTurnId !== stream.turnId;
  const getTabStreamDeliveryTarget = (
    runtime: RuntimeTab,
    stream: TelegramTabStreamState,
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
  const bindTabStreamDeliveryTarget = (
    runtime: RuntimeTab,
    stream: TelegramTabStreamState,
  ): void => {
    if (stream.turnId !== undefined) return;
    stream.turnId = runtime.activeTurnId;
    stream.chatId = runtime.activeChatId;
    stream.messageThreadId = runtime.activeMessageThreadId;
    stream.replyToMessageId = runtime.activeReplyToMessageId;
  };
  const schedulePendingTabStreamRetry = (
    runtime: RuntimeTab,
    stream: TelegramTabStreamState,
  ): void => {
    if (isTabStreamStale(runtime, stream)) return;
    const nextFlushAt = Math.max(
      stream.nextFlushAt ?? 0,
      runtime.streamDeliveryBlockedUntil ?? 0,
    );
    if (nextFlushAt <= 0 || stream.flushTimer) return;
    if (stream.markdown === stream.sentMarkdown) return;
    const wait = Math.max(0, nextFlushAt - now());
    stream.flushTimer = setTimeout(() => {
      stream.flushTimer = undefined;
      void flushTabStreamMarkdown(runtime, stream);
    }, wait);
  };
  const blockTabStreamDelivery = (
    runtime: RuntimeTab,
    stream: TelegramTabStreamState,
  ): void => {
    if (isTabStreamStale(runtime, stream)) return;
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
  const unblockTabStreamDelivery = (
    runtime: RuntimeTab,
    stream: TelegramTabStreamState,
  ): void => {
    stream.failedFlushCount = undefined;
    stream.nextFlushAt = undefined;
    if (isTabStreamStale(runtime, stream)) return;
    runtime.streamDeliveryFailureCount = undefined;
    runtime.streamDeliveryBlockedUntil = undefined;
  };
  const getTabStreamDeliveryBlockedUntil = (
    runtime: RuntimeTab,
    stream: TelegramTabStreamState,
  ): number | undefined => {
    const nextFlushAt = Math.max(
      stream.nextFlushAt ?? 0,
      runtime.streamDeliveryBlockedUntil ?? 0,
    );
    return nextFlushAt > 0 ? nextFlushAt : undefined;
  };
  const scheduleAllPendingTabStreamRetries = (
    runtime: RuntimeTab,
    except?: TelegramTabStreamState,
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
      schedulePendingTabStreamRetry(runtime, stream);
    }
  };
  const flushTabStreamMarkdown = async (
    runtime: RuntimeTab,
    stream: TelegramTabStreamState,
    options: {
      force?: boolean;
      allowStaleDelivery?: boolean;
      retryOnFailure?: boolean;
    } = {},
  ): Promise<TelegramTabStreamDeliveryResult> => {
    if (options.retryOnFailure === false) {
      stream.suppressRetryOnFailure = true;
    }
    const shouldRetryOnFailure = (): boolean =>
      options.retryOnFailure !== false && stream.suppressRetryOnFailure !== true;
    const makeSkipped = (reason: string): TelegramTabStreamDeliveryResult => ({
      status: "skipped",
      reason,
      stale: isTabStreamStale(runtime, stream),
    });
    if (!stream.markdown) return makeSkipped("empty");
    if (stream.markdown === stream.sentMarkdown) return makeSkipped("unchanged");
    if (isTabStreamStale(runtime, stream) && !options.allowStaleDelivery) {
      return makeSkipped("stale-turn");
    }
    const blockedUntil = getTabStreamDeliveryBlockedUntil(runtime, stream);
    if (!options.force && blockedUntil !== undefined && now() < blockedUntil) {
      schedulePendingTabStreamRetry(runtime, stream);
      return {
        status: "scheduled",
        reason: "blocked",
        retryAt: blockedUntil,
        stale: isTabStreamStale(runtime, stream),
      };
    }
    if (stream.flushPromise) {
      stream.flushRequested = true;
      return stream.flushPromise;
    }
    stream.flushPromise = (async () => {
      let lastResult: TelegramTabStreamDeliveryResult = makeSkipped("empty");
      do {
        stream.flushRequested = false;
        const markdown = stream.markdown;
        if (!markdown) return makeSkipped("empty");
        if (markdown === stream.sentMarkdown) return makeSkipped("unchanged");
        if (isTabStreamStale(runtime, stream) && !options.allowStaleDelivery) {
          return makeSkipped("stale-turn");
        }
        const target = getTabStreamDeliveryTarget(runtime, stream);
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
                sendTabStreamMarkdownReply(
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
                editTabStreamMarkdownMessage(
                  target.chatId,
                  currentMessageId,
                  markdown,
                ),
            );
            deliveredMessageId = messageId ?? currentMessageId;
            delivered = true;
          }
        } catch (error) {
          deps.recordRuntimeEvent?.("tabs", error, {
            tab: runtime.record.name,
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
            stale: isTabStreamStale(runtime, stream),
          };
        }
        if (!delivered) {
          if (lastResult.status !== "failed") {
            lastResult = {
              status: "failed",
              stale: isTabStreamStale(runtime, stream),
            };
          }
          if (shouldRetryOnFailure()) {
            blockTabStreamDelivery(runtime, stream);
            scheduleAllPendingTabStreamRetries(runtime, stream);
          }
          return lastResult;
        }
        const staleAfterDelivery = isTabStreamStale(runtime, stream);
        if (!staleAfterDelivery) {
          if (deliveredMessageId !== undefined) stream.messageId = deliveredMessageId;
          unblockTabStreamDelivery(runtime, stream);
          stream.sentMarkdown = markdown;
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
        !isTabStreamStale(runtime, stream) &&
        stream.markdown !== stream.sentMarkdown
      ) {
        schedulePendingTabStreamRetry(runtime, stream);
      }
    }
  };
  const scheduleTabStreamMarkdownFlush = (
    runtime: RuntimeTab,
    stream: TelegramTabStreamState,
    force: boolean,
  ): void => {
    if (stream.flushTimer) {
      if (!force) return;
      clearTimeout(stream.flushTimer);
      stream.flushTimer = undefined;
    }
    const blockedUntil = getTabStreamDeliveryBlockedUntil(runtime, stream);
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
      void flushTabStreamMarkdown(runtime, stream, { force });
      return;
    }
    stream.flushTimer = setTimeout(() => {
      stream.flushTimer = undefined;
      void flushTabStreamMarkdown(runtime, stream);
    }, wait);
  };
  const streamActiveTabMarkdown = (
    tabState: TelegramTabsState,
    tabName: string,
    runtime: RuntimeTab,
    stream: TelegramTabStreamState,
    markdown: string,
    force = false,
    truncate = true,
  ): void => {
    if (!isRuntimeDeliveryActive(tabState, tabName, runtime)) return;
    bindTabStreamDeliveryTarget(runtime, stream);
    if (isTabStreamStale(runtime, stream) && !force) return;
    stream.markdown = truncate
      ? truncateTelegramTabStreamMarkdown(markdown)
      : markdown.trim();
    scheduleTabStreamMarkdownFlush(runtime, stream, force);
  };
  const streamActiveTabText = (
    tabState: TelegramTabsState,
    tabName: string,
    runtime: RuntimeTab,
    text: string,
    force = false,
  ): boolean => {
    const trimmed = text.trim();
    if (!trimmed || !isRuntimeDeliveryActive(tabState, tabName, runtime)) return false;
    streamActiveTabMarkdown(
      tabState,
      tabName,
      runtime,
      getTextStreamState(runtime),
      trimmed,
      force,
      !force,
    );
    return true;
  };
  const streamActiveTabThinking = (
    tabState: TelegramTabsState,
    tabName: string,
    runtime: RuntimeTab,
    index: number,
    text: string,
    force = false,
  ): void => {
    const trimmed = text.trim();
    if (
      !trimmed ||
      !thinkingStreamPreviewsEnabled ||
      runtime.sentThinkingTexts.has(trimmed)
    ) {
      return;
    }
    const stream = getStreamState(runtime.thinkingStreams, index);
    streamActiveTabMarkdown(
      tabState,
      tabName,
      runtime,
      stream,
      formatTelegramTabThinkingMarkdown(trimmed),
      force,
    );
    if (force) {
      runtime.sentThinkingTexts.add(trimmed);
      runtime.thinkingStreams.delete(index);
    }
  };
  const flushActiveTabThinkingBuffer = (
    tabState: TelegramTabsState,
    tabName: string,
    runtime: RuntimeTab,
    index: number,
  ): void => {
    const text = runtime.thinkingBuffers.get(index) ?? "";
    runtime.thinkingBuffers.delete(index);
    streamActiveTabThinking(tabState, tabName, runtime, index, text, true);
  };
  const streamActiveTabToolCall = (
    tabState: TelegramTabsState,
    tabName: string,
    runtime: RuntimeTab,
    index: number,
    markdown: string,
    final: boolean,
  ): void => {
    if (!markdown || !toolCallStreamPreviewsEnabled) return;
    const stream = getStreamState(runtime.toolCallStreams, index);
    streamActiveTabMarkdown(tabState, tabName, runtime, stream, markdown, final);
    if (final) {
      runtime.sentToolCallMessages.add(markdown);
      runtime.toolCallStreams.delete(index);
    }
  };
  const streamActiveTabCompactToolStatus = (
    tabState: TelegramTabsState,
    tabName: string,
    runtime: RuntimeTab,
    preview: {
      key: string;
      markdown: string;
      status: TelegramTabToolStatusKind;
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
    const markdown = formatTelegramTabCompactToolStatusMarkdown(
      entries,
      runtime.toolCallStatuses.size,
    );
    streamActiveTabMarkdown(
      tabState,
      tabName,
      runtime,
      getToolCallStatusStreamState(runtime),
      markdown,
    );
  };
  const getTabTurnDetails = (tabName: string, runtime: RuntimeTab): Record<string, unknown> => ({
    tab: tabName,
    turnId: runtime.activeTurnId,
    chatId: runtime.activeChatId,
    messageThreadId: runtime.activeMessageThreadId,
    replyToMessageId: runtime.activeReplyToMessageId,
  });
  const isFinalTabStreamDeliveryConfirmed = (
    result: TelegramTabStreamDeliveryResult,
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
  const finalizeActiveTabTextStream = async (
    runtime: RuntimeTab,
    stream: TelegramTabStreamState | undefined,
    finalMarkdown: string,
  ): Promise<TelegramTabStreamDeliveryResult> => {
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
        stale: isTabStreamStale(runtime, stream),
      };
    }
    bindTabStreamDeliveryTarget(runtime, stream);
    stream.markdown = trimmed;
    if (stream.flushTimer) {
      clearTimeout(stream.flushTimer);
      stream.flushTimer = undefined;
    }
    return flushTabStreamMarkdown(runtime, stream, {
      force: true,
      allowStaleDelivery: true,
      retryOnFailure: false,
    });
  };
  const markActiveTabTextStreamAborted = async (
    runtime: RuntimeTab,
    stream: TelegramTabStreamState | undefined = runtime.textStream,
  ): Promise<TelegramTabStreamDeliveryResult | undefined> => {
    if (!stream) return undefined;
    const current = (stream.sentMarkdown || stream.markdown).trim();
    if (!current) return undefined;
    const abortedMarkdown = current.includes("[aborted]")
      ? current
      : `${current}\n\n[aborted]`;
    bindTabStreamDeliveryTarget(runtime, stream);
    stream.markdown = abortedMarkdown;
    if (stream.flushTimer) {
      clearTimeout(stream.flushTimer);
      stream.flushTimer = undefined;
    }
    return flushTabStreamMarkdown(runtime, stream, {
      force: true,
      allowStaleDelivery: true,
      retryOnFailure: false,
    });
  };
  const logTabFirstOutput = (
    tabName: string,
    runtime: RuntimeTab,
    outputKind: string,
  ): void => {
    if (runtime.firstOutputLogged) return;
    const firstOutputAt = now();
    runtime.firstOutputAt = firstOutputAt;
    runtime.firstOutputLogged = true;
    deps.debugLogger?.log("telegram.tab.first_output", {
      ...getTabTurnDetails(tabName, runtime),
      outputKind,
      promptSentToFirstOutputMs:
        runtime.promptSentAt === undefined ? undefined : firstOutputAt - runtime.promptSentAt,
      agentStartToFirstOutputMs:
        runtime.agentStartedAt === undefined ? undefined : firstOutputAt - runtime.agentStartedAt,
    });
  };
  const logTabTurnSummary = (
    tabName: string,
    runtime: RuntimeTab,
    stopReason?: string,
    error?: string,
  ): void => {
    const endedAt = now();
    deps.debugLogger?.log("telegram.tab.turn.summary", {
      ...getTabTurnDetails(tabName, runtime),
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
  const sendActiveTabToolCallMessage = (
    tabState: TelegramTabsState,
    tabName: string,
    runtime: RuntimeTab,
    message: unknown,
  ): boolean => {
    if (!agentMessageHasToolCall(message)) return false;
    if (toolCallCompactPreviewsEnabled) {
      getAgentMessageContent(message).forEach((block, index) => {
        const raw = getRecord(block);
        if (raw?.type !== "toolCall") return;
        const key =
          typeof raw.id === "string" && raw.id ? raw.id : `message-tool:${index}`;
        streamActiveTabCompactToolStatus(tabState, tabName, runtime, {
          key,
          markdown: formatAgentToolCallBlock({
            name: raw.name,
            arguments: raw.arguments,
          }),
          status: "queued",
        });
      });
      return extractAgentBodyText(message).length === 0;
    }
    if (!toolCallStreamPreviewsEnabled) return false;
    if (
      runtime.toolCallStreams.size > 0 ||
      runtime.sentToolCallMessages.size > 0
    ) {
      return true;
    }
    const markdown = getAgentMessageText(message);
    if (!markdown || runtime.sentToolCallMessages.has(markdown)) return true;
    if (!isRuntimeDeliveryActive(tabState, tabName, runtime)) return false;
    runtime.sentToolCallMessages.add(markdown);
    void runInTabThreadContext(runtime, () =>
      sendTabMarkdownReply(
        runtime.activeChatId,
        runtime.activeReplyToMessageId,
        markdown,
      ),
    );
    return true;
  };
  const handleChildEvent = (
    tabName: string,
    runtime: RuntimeTab,
    event: RpcChildBackendEvent,
  ): void => {
    const tabState = state;
    if (!tabState || runtime.closing || !tabState.tabs[tabName]) return;
    const record = runtime.record;
    const eventNow = now();
    deps.debugLogger?.log(
      "telegram.tab.worker.event",
      {
        ...getTabTurnDetails(tabName, runtime),
        type: event.type,
        status: record.status,
        bodyOmitted: event.type === "message_update" || event.type === "message_end" || event.type === "agent_end" ? true : undefined,
      },
      event.type === "message_update" || event.type === "message_end" || event.type === "agent_end" ? undefined : event,
    );
    if (event.type === "agent_start") {
      resetRuntimeTurnBuffers(runtime);
      runtime.agentStartedAt = eventNow;
      deps.debugLogger?.log("telegram.tab.agent.start", getTabTurnDetails(tabName, runtime));
      record.status = "running";
      record.lastError = undefined;
      record.lastAgentStartAt = eventNow;
      if (isRuntimeDeliveryActive(tabState, tabName, runtime)) {
        startTabTyping(tabName, runtime);
      }
      void persist();
      return;
    }
    if (event.type === "message_start") {
      deps.debugLogger?.log("telegram.tab.message.start", getTabTurnDetails(tabName, runtime));
      runtime.activeBuffer = "";
      runtime.textStream = undefined;
      return;
    }
    const delta = extractRpcTextDelta(event);
    if (delta) {
      logTabFirstOutput(tabName, runtime, "text_delta");
      runtime.activeBuffer += delta;
      streamActiveTabText(tabState, tabName, runtime, runtime.activeBuffer);
    }
    const thinkingDelta = getRpcAssistantThinkingDelta(event);
    if (thinkingDelta) {
      logTabFirstOutput(tabName, runtime, "thinking_delta");
      const nextThinkingText = `${runtime.thinkingBuffers.get(thinkingDelta.index) ?? ""}${
        thinkingDelta.delta
      }`;
      runtime.thinkingBuffers.set(
        thinkingDelta.index,
        nextThinkingText,
      );
      streamActiveTabThinking(
        tabState,
        tabName,
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
      flushActiveTabThinkingBuffer(tabState, tabName, runtime, thinkingEnd.index);
    }
    const toolCallPreview = getRpcAssistantToolCallPreview(event);
    if (toolCallPreview) {
      logTabFirstOutput(tabName, runtime, "tool_call");
      deps.debugLogger?.log("telegram.tab.tool.preview", {
        ...getTabTurnDetails(tabName, runtime),
        index: toolCallPreview.index,
        final: toolCallPreview.final,
      }, toolCallPreview.markdown);
      streamActiveTabCompactToolStatus(tabState, tabName, runtime, {
        key: toolCallPreview.key,
        markdown: toolCallPreview.markdown,
        status: "queued",
      });
      streamActiveTabToolCall(
        tabState,
        tabName,
        runtime,
        toolCallPreview.index,
        toolCallPreview.markdown,
        toolCallPreview.final,
      );
    }
    const toolExecutionPreview = getRpcToolExecutionPreview(event);
    if (toolExecutionPreview) {
      streamActiveTabCompactToolStatus(
        tabState,
        tabName,
        runtime,
        toolExecutionPreview,
      );
    }
    const assistantText = extractRpcAssistantText(event);
    if (assistantText) {
      logTabFirstOutput(tabName, runtime, "assistant_text");
      runtime.activeAssistantText = assistantText;
      record.lastAssistantText = assistantText;
      record.lastMessageText = assistantText;
      record.lastMessageAt = eventNow;
    }
    if (event.type === "message_end" && isAssistantAgentMessage(event.message)) {
      deps.debugLogger?.log("telegram.tab.message.end", {
        ...getTabTurnDetails(tabName, runtime),
        hasAssistantMessage: true,
      });
      const finalBodyText = extractAgentBodyText(event.message);
      if (runtime.textStream && finalBodyText) {
        runtime.activeBuffer = finalBodyText;
        streamActiveTabText(tabState, tabName, runtime, finalBodyText, true);
      }
      for (const thinking of extractAgentThinkingBlocks(event.message)) {
        streamActiveTabThinking(
          tabState,
          tabName,
          runtime,
          thinking.index,
          thinking.text,
          true,
        );
      }
      sendActiveTabToolCallMessage(tabState, tabName, runtime, event.message);
    }
    if (event.type === "agent_end") {
      deps.debugLogger?.log("telegram.tab.agent.end", {
        ...getTabTurnDetails(tabName, runtime),
        messageCount: Array.isArray(event.messages) ? event.messages.length : undefined,
      });
      stopTabTyping(runtime);
      for (const index of [...runtime.thinkingBuffers.keys()]) {
        flushActiveTabThinkingBuffer(tabState, tabName, runtime, index);
      }
      const latestAssistant = getLatestAssistantMessage(event.messages);
      if (latestAssistant) {
        for (const thinking of extractAgentThinkingBlocks(latestAssistant)) {
          streamActiveTabThinking(
            tabState,
            tabName,
            runtime,
            thinking.index,
            thinking.text,
            true,
          );
        }
      }
      const finalAlreadySentAsToolCall = latestAssistant
        ? sendActiveTabToolCallMessage(
            tabState,
            tabName,
            runtime,
            latestAssistant,
          )
        : false;
      record.lastAgentEndAt = eventNow;
      const assistantError = extractRpcAssistantError(event);
      if (assistantError) {
        logTabTurnSummary(tabName, runtime, "error", assistantError);
        record.status = "error";
        record.lastError = assistantError;
        const displayName = formatTelegramTabDisplayName(tabName);
        const isActive = isRuntimeDeliveryActive(tabState, tabName, runtime);
        if (!runtime.activeErrorDelivered) {
          runtime.activeErrorDelivered = true;
          if (isActive) {
            void runInTabThreadContext(runtime, () =>
              sendTabReply(
                runtime.activeChatId,
                runtime.activeReplyToMessageId,
                `Tab ${displayName} failed: ${assistantError}`,
              ),
            );
          } else {
            runtime.unreadEvents += 1;
            if (deps.getConfig().inactiveNotify) {
              void runInTabThreadContext(runtime, () =>
                sendTabReply(
                  runtime.activeChatId,
                  runtime.activeReplyToMessageId,
                  `Tab ${displayName} failed: ${assistantError}`,
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
      const isActive = isRuntimeDeliveryActive(tabState, tabName, runtime);
      const finalBodyText = latestAssistant
        ? extractAgentBodyText(latestAssistant)
        : runtime.activeBuffer;
      if (latestAssistantSummary.stopReason === "aborted") {
        void (async () => {
          const result = await markActiveTabTextStreamAborted(runtime).catch(
            (error) => {
              deps.recordRuntimeEvent?.("tabs", error, {
                tab: tabName,
                action: "stream_abort_mark",
                turnId: runtime.activeTurnId,
              });
              return undefined;
            },
          );
          if (result) {
            deps.debugLogger?.log("telegram.tab.stream.abort.result", {
              ...getTabTurnDetails(tabName, runtime),
              streamMessageId: runtime.textStream?.messageId,
              status: result.status,
              delivered: result.status === "delivered",
              error: "error" in result ? result.error : undefined,
              stale: result.stale,
            });
          }
        })();
        logTabTurnSummary(tabName, runtime, "aborted");
        void persist();
        return;
      }
      const finalReplyMarkdown = finalBodyText || runtime.activeAssistantText || "";
      if (isActive && finalReplyMarkdown && !finalAlreadySentAsToolCall) {
        const deliveryTarget = {
          chatId: runtime.activeChatId,
          messageThreadId: runtime.activeMessageThreadId,
          replyToMessageId: runtime.activeReplyToMessageId,
          turnId: runtime.activeTurnId,
        };
        const stream = runtime.textStream;
        const finalStreamMarkdown = finalBodyText.trim();
        void (async () => {
          let streamResult: TelegramTabStreamDeliveryResult | undefined;
          let streamDelivered = false;
          let fallbackSent = false;
          let fallbackError: string | undefined;
          if (stream && finalStreamMarkdown) {
            deps.debugLogger?.log("telegram.tab.stream.finalize.start", {
              tab: tabName,
              turnId: deliveryTarget.turnId,
              chatId: deliveryTarget.chatId,
              messageThreadId: deliveryTarget.messageThreadId,
              replyToMessageId: deliveryTarget.replyToMessageId,
              streamMessageId: stream.messageId,
              finalTextLength: finalStreamMarkdown.length,
              sentMarkdownLength: stream.sentMarkdown.length,
            });
            try {
              streamResult = await finalizeActiveTabTextStream(
                runtime,
                stream,
                finalStreamMarkdown,
              );
              streamDelivered = isFinalTabStreamDeliveryConfirmed(
                streamResult,
                finalStreamMarkdown,
                stream.sentMarkdown,
              );
            } catch (error) {
              fallbackError = getErrorMessage(error);
              streamResult = {
                status: "failed",
                error: fallbackError,
                stale: stream ? isTabStreamStale(runtime, stream) : false,
              };
              deps.recordRuntimeEvent?.("tabs", error, {
                tab: tabName,
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
                  sendTabMarkdownReply(
                    deliveryTarget.chatId,
                    deliveryTarget.replyToMessageId,
                    finalReplyMarkdown,
                  ),
              );
              fallbackSent = messageId !== undefined;
            } catch (error) {
              fallbackError = getErrorMessage(error);
              deps.recordRuntimeEvent?.("tabs", error, {
                tab: tabName,
                action: "stream_final_fallback",
                turnId: deliveryTarget.turnId,
                chatId: deliveryTarget.chatId,
                messageThreadId: deliveryTarget.messageThreadId,
                replyToMessageId: deliveryTarget.replyToMessageId,
              });
            }
          }
          if (stream || streamResult) {
            deps.debugLogger?.log("telegram.tab.stream.finalize.result", {
              tab: tabName,
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
          void runInTabThreadContext(runtime, () =>
            sendTabReply(
              chatId,
              replyToMessageId,
              `Tab ${formatTelegramTabDisplayName(tabName)} finished. Use /tab ${formatTelegramTabDisplayName(tabName)} to view latest reply.`,
            ),
          );
        }
      }
      logTabTurnSummary(tabName, runtime, latestAssistantSummary.stopReason ?? "stop");
      void persist();
      return;
    }
    if (event.type === "exit") {
      deps.debugLogger?.log("telegram.tab.worker.exit", getTabTurnDetails(tabName, runtime), event);
      stopTabTyping(runtime);
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
      deps.debugLogger?.log("telegram.tab.worker.error", {
        ...getTabTurnDetails(tabName, runtime),
        error: errorMessage,
      }, event);
      logTabTurnSummary(tabName, runtime, "error", errorMessage);
      stopTabTyping(runtime);
      record.status = "error";
      record.lastError = errorMessage;
      void persist();
    }
  };
  const ensureBackend = async (
    runtime: RuntimeTab,
    ctx: TContext,
  ): Promise<TelegramTabBackend> => {
    if (runtime.backend) return runtime.backend;
    runtime.record.status = "starting";
    runtime.record.lastError = undefined;
    const cwd = runtime.record.cwd || deps.getCwd(ctx);
    const sessionDir = deps.getSessionDir?.(ctx) ?? configuredSessionDir;
    const config = deps.getConfig();
    const workerArgs = buildTelegramTabWorkerExtensionArgs(
      config.workerExtensions,
    );
    const defaultModel = config.topicBinding?.defaultModel;
    if (defaultModel) {
      workerArgs.push("--model", defaultModel);
    }
    deps.debugLogger?.log(
      "telegram.tab.worker.start",
      {
        tab: runtime.record.name,
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
      tabName: runtime.record.name,
      cwd,
      sessionDir,
      sessionFile: runtime.record.sessionFile,
      args: workerArgs,
    }) ?? new RpcChildBackend({
      tabName: runtime.record.name,
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
        "telegram.tab.worker.ready",
        { tab: runtime.record.name, elapsedMs: Date.now() - workerStartedAt },
        childState,
      );
      applyRpcStateToRecord(runtime.record, childState);
      await syncTopicSessionNameToWorker(runtime, {
        workerSessionName: childState.sessionName,
      });
      await persist();
      return backend;
    } catch (error) {
      deps.debugLogger?.log("telegram.tab.worker.start_error", {
        tab: runtime.record.name,
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
  const disposeRuntimeBackend = async (runtime: RuntimeTab): Promise<void> => {
    stopTabTyping(runtime);
    const backend = runtime.backend;
    runtime.backend = undefined;
    runtime.unsubscribe?.();
    runtime.unsubscribe = undefined;
    await backend?.dispose();
  };
  const disposeClosingRuntimeBackend = async (
    runtime: RuntimeTab,
  ): Promise<void> => {
    runtime.closing = true;
    stopTabTyping(runtime);
    resetRuntimeTurnBuffers(runtime);
    const backend = runtime.backend;
    runtime.backend = undefined;
    runtime.unsubscribe?.();
    runtime.unsubscribe = undefined;
    await backend?.dispose();
  };
  const syncTopicSessionNameToWorker = async (
    runtime: RuntimeTab,
    options: { workerSessionName?: string; forceWorker?: boolean } = {},
  ): Promise<boolean> => {
    const topicSessionName = getTelegramTopicSessionName(runtime.record);
    if (!topicSessionName) return false;
    let changed = false;
    if (runtime.record.sessionName !== topicSessionName) {
      runtime.record.sessionName = topicSessionName;
      changed = true;
    }
    const workerSessionName = normalizeTelegramTabSessionName(
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
        deps.recordRuntimeEvent?.("tabs", error, {
          tab: runtime.record.name,
          action: "sync_topic_session_name",
        });
      }
    }
    return changed;
  };
  const refreshRuntimeState = async (
    runtime: RuntimeTab,
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
  const refreshDashboardTabRecords = async (
    tabState: TelegramTabsState,
  ): Promise<void> => {
    await Promise.all(
      Object.keys(tabState.tabs).map(async (name) => {
        const runtime = getRuntime(tabState, name);
        if (runtime?.backend) await refreshRuntimeState(runtime);
      }),
    );
  };
  const getOpenSessionConflict = async (
    tabState: TelegramTabsState,
    targetRuntime: RuntimeTab,
    target: Pick<TelegramTabSessionIdentity, "sessionFile" | "sessionId">,
  ): Promise<TelegramTabRecord | undefined> => {
    const targetIdentity = getTelegramTabSessionIdentity(target);
    if (!targetIdentity.canonicalSessionFile && !targetIdentity.sessionId) {
      return undefined;
    }
    await Promise.all(
      Object.values(tabState.tabs).map(async (record) => {
        if (record.name === targetRuntime.record.name) return;
        const runtime = getRuntime(tabState, record.name);
        if (runtime?.backend) await refreshRuntimeState(runtime);
      }),
    );
    return Object.values(tabState.tabs).find((record) => {
      if (record.name === targetRuntime.record.name) return false;
      return isSameTelegramTabSessionIdentity(
        getTelegramTabSessionIdentity(record),
        targetIdentity,
      );
    });
  };
  const assertNoOpenSessionConflict = async (
    tabState: TelegramTabsState,
    targetRuntime: RuntimeTab,
    target: Pick<TelegramTabSessionIdentity, "sessionFile" | "sessionId">,
  ): Promise<void> => {
    const conflict = await getOpenSessionConflict(tabState, targetRuntime, target);
    if (!conflict) return;
    throw new Error(
      `Session is already open in workspace ${formatTelegramTabSessionOwner(conflict)}. Close that workspace first or branch/clone the session.`,
    );
  };
  const getTelegramTopicServiceKind = (
    message: TelegramTabForumTopicServiceMessage,
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
    record: TelegramTabRecord,
    topicTitle: string | undefined,
  ): boolean => {
    const sessionName = normalizeTelegramTabSessionName(topicTitle ?? "");
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
  const createTelegramTopicTabRecord = (
    tabState: TelegramTabsState,
    scope: { chatId: number; messageThreadId: number; topicTitle?: string },
    ctx: TContext,
  ): TelegramTabRecord => {
    const createdAt = now();
    let name = normalizeTelegramTopicTabName(scope.chatId, scope.messageThreadId);
    if (tabState.tabs[name]) {
      let suffix = 2;
      const base = name.slice(0, Math.max(1, 29));
      while (tabState.tabs[name]) {
        name = `${base}-${suffix}`.slice(0, 32);
        suffix += 1;
      }
    }
    const topicSessionName = normalizeTelegramTabSessionName(
      scope.topicTitle ?? "",
    );
    const source: TelegramTabSourceTelegramTopic = {
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
    tabState: TelegramTabsState,
    turn: TelegramTabPromptTurn,
    ctx: TContext,
  ): Promise<RuntimeTab | undefined> => {
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
      return getRuntime(tabState, TELEGRAM_DEFAULT_TAB_NAME);
    }
    if (turn.messageThreadId === undefined) return undefined;
    const existing = findTelegramTabByTopic(
      tabState.tabs,
      turn.chatId,
      turn.messageThreadId,
    );
    if (existing) return getRuntime(tabState, existing.name);
    if (!topicBinding.autoCreate) return undefined;
    if (Object.keys(tabState.tabs).length >= deps.getConfig().maxTabs) {
      await sendTurnTextReply(
        turn,
        "Maximum tab count reached. Close another topic/tab first.",
      );
      return undefined;
    }
    const record = createTelegramTopicTabRecord(
      tabState,
      { chatId: turn.chatId, messageThreadId: turn.messageThreadId },
      ctx,
    );
    tabState.tabs[record.name] = record;
    const runtime = createRuntimeTab(record);
    runtimeTabs.set(record.name, runtime);
    await persist();
    return runtime;
  };
  const getRuntimeForPromptTurn = async (
    tabState: TelegramTabsState,
    turn: TelegramTabPromptTurn,
    ctx: TContext,
  ): Promise<RuntimeTab | undefined> => {
    if (!isTopicBindingEnabled()) return getRuntime(tabState, tabState.activeTab);
    if (turn.messageThreadId !== undefined && !isTrustedTopicBindingChat(turn.chatId)) {
      await sendTurnTextReply(
        turn,
        "This Telegram forum is not authorized for topic workspaces.",
      );
      return undefined;
    }
    if (turn.messageThreadId === undefined) {
      return getTopicBindingConfig()?.generalIsDefault
        ? getRuntime(tabState, TELEGRAM_DEFAULT_TAB_NAME)
        : getRuntime(tabState, tabState.activeTab);
    }
    const runtime = await getOrCreateTopicRuntimeForTurn(tabState, turn, ctx);
    if (runtime) return runtime;
    if (!getTopicBindingConfig()?.autoCreate) {
      await sendTurnTextReply(
        turn,
        "No tab is bound to this Telegram topic.",
      );
    }
    return undefined;
  };
  const upsertTelegramTopicTabRecord = async (
    tabState: TelegramTabsState,
    scope: { chatId: number; messageThreadId: number; topicTitle?: string },
    ctx: TContext,
    options: { enforceCapacity: boolean },
  ): Promise<TelegramTabRecord | undefined> => {
    const existing = findTelegramTabByTopic(
      tabState.tabs,
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
      Object.keys(tabState.tabs).length >= deps.getConfig().maxTabs
    ) {
      return undefined;
    }
    const record = createTelegramTopicTabRecord(tabState, scope, ctx);
    tabState.tabs[record.name] = record;
    runtimeTabs.set(record.name, createRuntimeTab(record));
    await persist();
    return record;
  };
  const resolveScopedTopicRuntime = async (
    tabState: TelegramTabsState,
    ctx: TContext,
  ): Promise<{ scoped: boolean; runtime?: RuntimeTab }> => {
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
          ? getRuntime(tabState, TELEGRAM_DEFAULT_TAB_NAME)
          : undefined,
      };
    }
    const existing = findTelegramTabByTopic(
      tabState.tabs,
      scope.chatId,
      scope.messageThreadId,
    );
    if (existing) return { scoped: true, runtime: getRuntime(tabState, existing.name) };
    if (!topicBinding?.autoCreate) return { scoped: true };
    const record = await upsertTelegramTopicTabRecord(
      tabState,
      { chatId: scope.chatId, messageThreadId: scope.messageThreadId },
      ctx,
      { enforceCapacity: true },
    );
    return {
      scoped: true,
      runtime: record ? getRuntime(tabState, record.name) : undefined,
    };
  };
  const resolveScopedTopicRuntimeSync = (
    tabState: TelegramTabsState,
    ctx: TContext,
  ): { scoped: boolean; runtime?: RuntimeTab } => {
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
          ? getRuntime(tabState, TELEGRAM_DEFAULT_TAB_NAME)
          : undefined,
      };
    }
    const existing = findTelegramTabByTopic(
      tabState.tabs,
      scope.chatId,
      scope.messageThreadId,
    );
    if (existing) return { scoped: true, runtime: getRuntime(tabState, existing.name) };
    if (!topicBinding?.autoCreate) return { scoped: true };
    if (Object.keys(tabState.tabs).length >= deps.getConfig().maxTabs) {
      return { scoped: true };
    }
    const record = createTelegramTopicTabRecord(
      tabState,
      { chatId: scope.chatId, messageThreadId: scope.messageThreadId },
      ctx,
    );
    tabState.tabs[record.name] = record;
    const runtime = createRuntimeTab(record);
    runtimeTabs.set(record.name, runtime);
    void persist();
    return { scoped: true, runtime };
  };
  const getActiveRuntime = async (ctx: TContext): Promise<RuntimeTab | undefined> => {
    const tabState = await ensureState(deps.getCwd(ctx));
    const scoped = await resolveScopedTopicRuntime(tabState, ctx);
    return scoped.scoped ? scoped.runtime : getRuntime(tabState, tabState.activeTab);
  };
  const getActiveRuntimeSync = (ctx: TContext): RuntimeTab | undefined => {
    const tabState = ensureStateSync(deps.getCwd(ctx));
    const scoped = resolveScopedTopicRuntimeSync(tabState, ctx);
    return scoped.scoped ? scoped.runtime : getRuntime(tabState, tabState.activeTab);
  };
  const replyDisabled = (
    chatId: number,
    replyToMessageId: number,
  ): Promise<number | undefined> =>
    deps.sendTextReply(
      chatId,
      replyToMessageId,
      "Concurrent tabs are disabled. Set concurrentTabs.enabled to true in telegram.json to use /tab.",
    );
  const getUnreadByTab = (): Record<string, number> =>
    Object.fromEntries(
      [...runtimeTabs.entries()].map(([name, runtime]) => [
        name,
        runtime.unreadEvents,
      ]),
    );
  const sendForumNativeLifecycleDisabledReply = (
    chatId: number,
    replyToMessageId: number,
  ): Promise<number | undefined> =>
    deps.sendTextReply(
      chatId,
      replyToMessageId,
      TELEGRAM_FORUM_NATIVE_TAB_LIFECYCLE_DISABLED_MESSAGE,
    );
  const sendTabDashboard = async (
    tabState: TelegramTabsState,
    chatId: number,
    replyToMessageId: number,
    filters: readonly string[] = [],
  ): Promise<void> => {
    await refreshDashboardTabRecords(tabState);
    const unreadByTab = getUnreadByTab();
    const forumNativeMode = isForumNativeMode();
    const filterResult = filterTelegramTabRecords(
      getSortedTelegramTabRecords(tabState),
      filters,
    );
    const visibleTabs = filterResult.trace.length > 0
      ? filterResult.tabs
      : undefined;
    if (!deps.sendInteractiveMessage) {
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        formatTelegramTabList(tabState, unreadByTab, now(), {
          tabs: visibleTabs,
          filterTrace: filterResult.trace,
        }),
      );
      return;
    }
    const messageId = await deps.sendInteractiveMessage(
      chatId,
      formatTelegramTabDashboardSummary(
        tabState,
        unreadByTab,
        deps.getConfig().maxTabs,
        now(),
        "open",
        [],
        visibleTabs,
        filterResult.trace,
        forumNativeMode,
      ),
      "plain",
      buildTelegramTabDashboardReplyMarkup(
        tabState,
        unreadByTab,
        "open",
        [],
        visibleTabs,
        forumNativeMode,
      ),
    );
    if (messageId !== undefined) {
      setDashboardState({
        chatId,
        messageId,
        mode: "open",
        selectedCloseTabs: [],
        updatedAt: now(),
      });
    }
  };
  const editTabDashboard = async (
    tabState: TelegramTabsState,
    chatId: number,
    messageId: number,
    options: {
      mode?: TelegramTabDashboardMode;
      selectedCloseTabs?: readonly string[];
    } = {},
  ): Promise<void> => {
    await refreshDashboardTabRecords(tabState);
    const unreadByTab = getUnreadByTab();
    const existingState = getDashboardState(messageId);
    const forumNativeMode = isForumNativeMode();
    const mode = forumNativeMode ? "open" : options.mode ?? existingState?.mode ?? "open";
    const selectedCloseTabs = normalizeTelegramTabCloseSelection(
      tabState,
      options.selectedCloseTabs ?? existingState?.selectedCloseTabs ?? [],
    );
    if (!deps.editInteractiveMessage) return;
    await deps.editInteractiveMessage(
      chatId,
      messageId,
      formatTelegramTabDashboardSummary(
        tabState,
        unreadByTab,
        deps.getConfig().maxTabs,
        now(),
        mode,
        selectedCloseTabs,
        undefined,
        [],
        forumNativeMode,
      ),
      "plain",
      buildTelegramTabDashboardReplyMarkup(
        tabState,
        unreadByTab,
        mode,
        selectedCloseTabs,
        undefined,
        forumNativeMode,
      ),
    );
    setDashboardState({
      chatId,
      messageId,
      mode,
      selectedCloseTabs,
      updatedAt: now(),
    });
  };
  const answerTabCallback = (
    callbackQueryId: string,
    text?: string,
  ): Promise<void> =>
    deps.answerCallbackQuery
      ? deps.answerCallbackQuery(callbackQueryId, text)
      : Promise.resolve();
  const closeRuntimeTab = async (
    tabState: TelegramTabsState,
    name: string,
    force: boolean,
  ): Promise<{ closed: boolean; message: string }> => {
    if (name === TELEGRAM_DEFAULT_TAB_NAME) {
      return { closed: false, message: "Cannot close General." };
    }
    const runtime = getRuntime(tabState, name);
    if (!runtime) {
      return { closed: false, message: `Unknown tab: ${formatTelegramTabDisplayName(name)}` };
    }
    if (runtime.record.status === "running" && !force) {
      return {
        closed: false,
        message: `Tab ${formatTelegramTabDisplayName(name)} is running. Use /tab close ${formatTelegramTabDisplayName(name)} --force to close it.`,
      };
    }
    await disposeClosingRuntimeBackend(runtime);
    runtimeTabs.delete(name);
    delete tabState.tabs[name];
    if (tabState.activeTab === name) tabState.activeTab = TELEGRAM_DEFAULT_TAB_NAME;
    return { closed: true, message: `Closed tab ${formatTelegramTabDisplayName(name)}.` };
  };
  const commandHandlers = {
    list: async (
      tabState: TelegramTabsState,
      chatId: number,
      replyToMessageId: number,
    ) => {
      await sendTabDashboard(tabState, chatId, replyToMessageId);
    },
    query: async (
      tabState: TelegramTabsState,
      query: string,
      filters: readonly string[],
      chatId: number,
      replyToMessageId: number,
    ) => {
      const name = normalizeTelegramTabName(query);
      if (!isForumNativeMode() && getRuntime(tabState, name)) {
        await commandHandlers.switch(tabState, name, chatId, replyToMessageId);
        return;
      }
      await sendTabDashboard(tabState, chatId, replyToMessageId, filters);
    },
    new: async (
      tabState: TelegramTabsState,
      name: string,
      chatId: number,
      replyToMessageId: number,
      ctx: TContext,
    ) => {
      name = normalizeTelegramTabName(name);
      const validationError = validateTelegramTabName(name);
      if (validationError) {
        await deps.sendTextReply(chatId, replyToMessageId, validationError);
        return;
      }
      if (tabState.tabs[name]) {
        await deps.sendTextReply(chatId, replyToMessageId, `Tab ${formatTelegramTabDisplayName(name)} already exists.`);
        return;
      }
      const conflict = findTelegramTabNameCaseConflict(tabState.tabs, name);
      if (conflict) {
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Tab ${conflict} already exists with different case.`,
        );
        return;
      }
      if (Object.keys(tabState.tabs).length >= deps.getConfig().maxTabs) {
        await deps.sendTextReply(chatId, replyToMessageId, "Maximum tab count reached.");
        return;
      }
      const createdAt = now();
      const record: TelegramTabRecord = {
        name,
        cwd: deps.getCwd(ctx),
        createdAt,
        lastUsedAt: createdAt,
        status: "idle",
      };
      const previousRuntime = getRuntime(tabState, tabState.activeTab);
      if (previousRuntime) stopTabTyping(previousRuntime);
      tabState.tabs[name] = record;
      tabState.activeTab = name;
      const runtime: RuntimeTab = createRuntimeTab(record);
      runtimeTabs.set(name, runtime);
      await persist();
      try {
        await ensureBackend(runtime, ctx);
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Created and switched to tab ${formatTelegramTabDisplayName(name)}.`,
        );
      } catch (error) {
        deps.recordRuntimeEvent?.("tabs", error, { tab: name, action: "new" });
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Created tab ${formatTelegramTabDisplayName(name)}, but worker failed: ${getErrorMessage(error)}`,
        );
      }
    },
    switch: async (
      tabState: TelegramTabsState,
      name: string,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const runtime = getRuntime(tabState, name);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown tab: ${formatTelegramTabDisplayName(name)}`);
        return;
      }
      const previousRuntime = getRuntime(tabState, tabState.activeTab);
      if (previousRuntime && previousRuntime !== runtime) stopTabTyping(previousRuntime);
      tabState.activeTab = name;
      runtime.record.lastUsedAt = now();
      const shouldReplayUnread = runtime.unreadEvents > 0 && Boolean(deps.sendLastTurnsOnSwitch);
      runtime.unreadEvents = 0;
      if (runtime.record.status === "running") startTabTyping(name, runtime);
      await persist();
      const lastAssistantText = !shouldReplayUnread
        ? runtime.record.lastAssistantText
        : undefined;
      const replayNote = shouldReplayUnread ? " Replaying unread latest messages." : "";
      if (lastAssistantText && deps.sendMarkdownReply) {
        await deps.sendMarkdownReply(
          chatId,
          replyToMessageId,
          `Switched to tab ${formatTelegramTabDisplayName(name)}.\n\nLast reply:\n${lastAssistantText}`,
        );
      } else {
        const latest = lastAssistantText
          ? `\n\nLast reply:\n${truncateTelegramTabText(lastAssistantText)}`
          : "";
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Switched to tab ${formatTelegramTabDisplayName(name)}.${replayNote}${latest}`,
        );
      }
      if (shouldReplayUnread && deps.sendLastTurnsOnSwitch) {
        await deps.sendLastTurnsOnSwitch(
          getTelegramTabSessionReference(runtime.record),
          chatId,
          replyToMessageId,
        ).catch((error) => {
          deps.recordRuntimeEvent?.("tabs", error, {
            tab: runtime.record.name,
            action: "switch_replay",
          });
        });
      }
    },
    rename: async (
      tabState: TelegramTabsState,
      oldName: string | undefined,
      newName: string,
      chatId: number,
      replyToMessageId: number,
    ) => {
      newName = normalizeTelegramTabName(newName);
      const sourceName = oldName ? normalizeTelegramTabName(oldName) : tabState.activeTab;
      if (sourceName === TELEGRAM_DEFAULT_TAB_NAME) {
        await deps.sendTextReply(chatId, replyToMessageId, "Cannot rename General.");
        return;
      }
      const runtime = getRuntime(tabState, sourceName);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown tab: ${formatTelegramTabDisplayName(sourceName)}`);
        return;
      }
      const validationError = validateTelegramTabName(newName);
      if (validationError) {
        await deps.sendTextReply(chatId, replyToMessageId, validationError);
        return;
      }
      if (newName === sourceName) {
        await deps.sendTextReply(chatId, replyToMessageId, `Tab ${formatTelegramTabDisplayName(sourceName)} is already named ${formatTelegramTabDisplayName(newName)}.`);
        return;
      }
      if (tabState.tabs[newName]) {
        await deps.sendTextReply(chatId, replyToMessageId, `Tab ${formatTelegramTabDisplayName(newName)} already exists.`);
        return;
      }
      const conflict = Object.keys(tabState.tabs).find(
        (existing) =>
          existing !== sourceName && existing.toLowerCase() === newName.toLowerCase(),
      );
      if (conflict) {
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Tab ${conflict} already exists with different case.`,
        );
        return;
      }
      delete tabState.tabs[sourceName];
      runtime.record.name = newName;
      runtime.record.lastUsedAt = now();
      tabState.tabs[newName] = runtime.record;
      if (tabState.activeTab === sourceName) tabState.activeTab = newName;
      runtimeTabs.delete(sourceName);
      runtimeTabs.set(newName, runtime);
      await persist();
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        `Renamed tab ${formatTelegramTabDisplayName(sourceName)} to ${formatTelegramTabDisplayName(newName)}.`,
      );
    },
    close: async (
      tabState: TelegramTabsState,
      name: string | undefined,
      force: boolean,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const targetName = name ?? tabState.activeTab;
      const result = await closeRuntimeTab(tabState, targetName, force);
      if (result.closed) await persist();
      await deps.sendTextReply(chatId, replyToMessageId, result.message);
    },
    status: async (
      tabState: TelegramTabsState,
      name: string | undefined,
      chatId: number,
      replyToMessageId: number,
    ) => {
      if (!name) {
        await commandHandlers.list(tabState, chatId, replyToMessageId);
        return;
      }
      const runtime = getRuntime(tabState, name);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown tab: ${formatTelegramTabDisplayName(name)}`);
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
        formatTelegramTabStatus(runtime.record, runtime.unreadEvents, now()),
      );
    },
    abortRuntime: async (
      tabState: TelegramTabsState,
      name: string | undefined,
    ): Promise<TelegramTabAbortResult> => {
      const targetName = name ?? tabState.activeTab;
      const runtime = getRuntime(tabState, targetName);
      if (!runtime?.backend) {
        return {
          tabName: targetName,
          aborted: false,
          message: `No active worker for tab ${formatTelegramTabDisplayName(targetName)}.`,
        };
      }
      await runtime.backend.abort();
      stopTabTyping(runtime);
      await markActiveTabTextStreamAborted(runtime).catch((error) => {
        deps.recordRuntimeEvent?.("tabs", error, {
          tab: targetName,
          action: "stream_abort_mark",
          turnId: runtime.activeTurnId,
        });
      });
      runtime.record.status = "idle";
      await persist();
      return {
        tabName: targetName,
        aborted: true,
        message: `Aborted tab ${formatTelegramTabDisplayName(targetName)}.`,
      };
    },
    abort: async (
      tabState: TelegramTabsState,
      name: string | undefined,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const result = await commandHandlers.abortRuntime(tabState, name);
      await deps.sendTextReply(chatId, replyToMessageId, result.message);
    },
    syncNames: async (
      tabState: TelegramTabsState,
      chatId: number,
      replyToMessageId: number,
    ) => {
      let changed = 0;
      for (const record of Object.values(tabState.tabs)) {
        if (record.source?.kind !== "telegram-topic") continue;
        const runtime = getRuntime(tabState, record.name);
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
      tabState: TelegramTabsState,
      name: string,
      chatId: number,
      replyToMessageId: number,
      ctx: TContext,
    ) => {
      const runtime = getRuntime(tabState, name);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown tab: ${formatTelegramTabDisplayName(name)}`);
        return;
      }
      await disposeRuntimeBackend(runtime);
      try {
        await ensureBackend(runtime, ctx);
        await deps.sendTextReply(chatId, replyToMessageId, `Restarted tab ${formatTelegramTabDisplayName(name)}.`);
      } catch (error) {
        deps.recordRuntimeEvent?.("tabs", error, { tab: name, action: "restart" });
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Tab ${formatTelegramTabDisplayName(name)} restart failed: ${getErrorMessage(error)}`,
        );
      }
    },
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
      return getTelegramTabSessionReference(runtime.record, deps.getCwd(ctx));
    },
    getActiveResumeSessionScope: (ctx) => {
      if (!isEnabled()) return undefined;
      const runtime = getActiveRuntimeSync(ctx);
      if (!runtime) return undefined;
      const cwd = runtime.record.cwd || deps.getCwd(ctx);
      return {
        kind: "tab",
        tabName: runtime.record.name,
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
      return canSwitchTelegramTabModel(runtime.record);
    },
    selectActiveModel: async (model, ctx) => {
      if (!isEnabled()) return false;
      const runtime = await getActiveRuntime(ctx);
      if (!runtime) return false;
      await refreshRuntimeState(runtime);
      if (!canSwitchTelegramTabModel(runtime.record)) return false;
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
        deps.recordRuntimeEvent?.("tabs", error, {
          tab: runtime.record.name,
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
      if (!canSwitchTelegramTabModel(runtime.record)) return undefined;
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
        deps.recordRuntimeEvent?.("tabs", error, {
          tab: runtime.record.name,
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
      const normalizedName = normalizeTelegramTabSessionName(name);
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
        deps.recordRuntimeEvent?.("tabs", error, {
          tab: runtime.record.name,
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
        throw new Error(
          `Tab ${runtime.record.name} is busy. Wait for it to go idle or send /stop first.`,
        );
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
        } catch (error) {
          runtime.record.status = "error";
          runtime.record.lastError = getErrorMessage(error);
          deps.recordRuntimeEvent?.("tabs", error, {
            tab: runtime.record.name,
            action: "compact",
          });
          await persist();
          callbacks.onError(error);
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
        throw new Error(
          `Tab ${runtime.record.name} is busy. Wait for it to go idle or send /stop first.`,
        );
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
        deps.recordRuntimeEvent?.("tabs", error, {
          tab: runtime.record.name,
          action: "new_session",
        });
        await persist();
        throw error;
      }
    },
    deleteActiveSession: async (expectedSessionPath, ctx) => {
      if (!isEnabled()) return undefined;
      const tabState = await ensureState(deps.getCwd(ctx));
      const scoped = await resolveScopedTopicRuntime(tabState, ctx);
      const runtime = scoped.scoped
        ? scoped.runtime
        : getRuntime(tabState, tabState.activeTab);
      if (!runtime) return undefined;
      await refreshRuntimeState(runtime);
      if (!canSwitchTelegramTabModel(runtime.record)) {
        throw new Error(
          `Tab ${runtime.record.name} is busy. Send /stop first.`,
        );
      }
      const sessionPath = runtime.record.sessionFile;
      if (!sessionPath) {
        throw new Error("current session is not persisted");
      }
      if (
        expectedSessionPath &&
        !isSameTelegramTabSessionFile(expectedSessionPath, sessionPath)
      ) {
        throw new Error("current session changed before deletion");
      }
      await assertNoOpenSessionConflict(tabState, runtime, runtime.record);
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
          isSameTelegramTabSessionFile(runtime.record.sessionFile, sessionPath)
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
        deps.recordRuntimeEvent?.("tabs", error, {
          tab: runtime.record.name,
          action: "delete_session",
        });
        await persist();
        throw error;
      }
      try {
        await (deps.deleteSessionFile ?? unlink)(sessionPath);
      } catch (error) {
        deps.recordRuntimeEvent?.("tabs", error, {
          tab: runtime.record.name,
          action: "delete_session_file",
        });
        throw error;
      }
      return true;
    },
    abortActive: async (ctx) => {
      if (!isEnabled()) return undefined;
      const tabState = await ensureState(deps.getCwd(ctx));
      const scoped = await resolveScopedTopicRuntime(tabState, ctx);
      return commandHandlers.abortRuntime(tabState, scoped.runtime?.record.name);
    },
    switchSession: async (sessionPath, ctx, scope) => {
      if (!isEnabled() || scope?.kind !== "tab" || !scope.tabName) {
        return false;
      }
      const tabState = await ensureState(deps.getCwd(ctx));
      const runtime = getRuntime(tabState, scope.tabName);
      if (!runtime) {
        throw new Error(`Unknown tab: ${formatTelegramTabDisplayName(scope.tabName)}`);
      }
      await refreshRuntimeState(runtime);
      if (!canSwitchTelegramTabModel(runtime.record)) {
        throw new Error(
          `Tab ${scope.tabName} is busy. Send /tab abort ${scope.tabName} first.`,
        );
      }
      await assertNoOpenSessionConflict(tabState, runtime, {
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
        stopTabTyping(runtime);
        resetRuntimeTurnBuffers(runtime);
        delete runtime.record.lastAssistantText;
        delete runtime.record.lastMessageText;
        delete runtime.record.lastMessageAt;
        runtime.record.sessionFile = sessionPath;
        runtime.record.lastError = undefined;
        const childState = await refreshRuntimeState(runtime);
        if (!isSameTelegramTabSessionFile(childState?.sessionFile, sessionPath)) {
          const reported = childState?.sessionFile ?? "(none)";
          deps.recordRuntimeEvent?.(
            "tabs",
            new Error(
              `RPC worker reported ${reported} after switch_session ${sessionPath}; restarting worker on target session.`,
            ),
            {
              tab: runtime.record.name,
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
          if (!isSameTelegramTabSessionFile(runtime.record.sessionFile, sessionPath)) {
            throw new Error(
              `Tab ${scope.tabName} did not bind to resumed session ${sessionPath}.`,
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
        deps.recordRuntimeEvent?.("tabs", error, {
          tab: runtime.record.name,
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
      if (!canSwitchTelegramTabModel(runtime.record)) {
        throw new Error(
          `Tab ${runtime.record.name} is busy. Send /tab abort ${runtime.record.name} first.`,
        );
      }
      try {
        if (!deps.createTreeBranch) {
          throw new Error("Active tab tree branching is not configured.");
        }
        const result = await deps.createTreeBranch(
          getTelegramTabSessionReference(runtime.record, deps.getCwd(ctx)),
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
        deps.recordRuntimeEvent?.("tabs", error, {
          tab: runtime.record.name,
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
      const tabState = await ensureState(deps.getCwd(ctx));
      const command = parseTelegramTabCommand(args);
      switch (command.kind) {
        case "list":
          await commandHandlers.list(tabState, chatId, replyToMessageId);
          return true;
        case "new":
          if (isForumNativeMode()) {
            await sendForumNativeLifecycleDisabledReply(chatId, replyToMessageId);
            return true;
          }
          await commandHandlers.new(tabState, command.name, chatId, replyToMessageId, ctx);
          return true;
        case "query":
          await commandHandlers.query(tabState, command.query, command.filters, chatId, replyToMessageId);
          return true;
        case "switch":
          if (isForumNativeMode()) {
            await sendForumNativeLifecycleDisabledReply(chatId, replyToMessageId);
            return true;
          }
          await commandHandlers.switch(tabState, command.name, chatId, replyToMessageId);
          return true;
        case "rename":
          if (isForumNativeMode()) {
            await sendForumNativeLifecycleDisabledReply(chatId, replyToMessageId);
            return true;
          }
          await commandHandlers.rename(tabState, command.oldName, command.newName, chatId, replyToMessageId);
          return true;
        case "syncNames":
          await commandHandlers.syncNames(tabState, chatId, replyToMessageId);
          return true;
        case "close":
          if (isForumNativeMode()) {
            await sendForumNativeLifecycleDisabledReply(chatId, replyToMessageId);
            return true;
          }
          await commandHandlers.close(tabState, command.name, command.force, chatId, replyToMessageId);
          return true;
        case "status":
          await commandHandlers.status(tabState, command.name, chatId, replyToMessageId);
          return true;
        case "abort":
          await commandHandlers.abort(tabState, command.name, chatId, replyToMessageId);
          return true;
        case "restart":
          await commandHandlers.restart(tabState, command.name, chatId, replyToMessageId, ctx);
          return true;
        case "invalid":
          await deps.sendTextReply(chatId, replyToMessageId, command.message);
          return true;
        case "usage":
          await deps.sendTextReply(chatId, replyToMessageId, formatTelegramTabUsage());
          return true;
      }
    },
    handleCallbackQuery: async (query, ctx) => {
      const data = query.data;
      if (!data?.startsWith("tab:")) return false;
      if (!isEnabled()) {
        await answerTabCallback(query.id, "Concurrent tabs are disabled.");
        return true;
      }
      const chatId = query.message?.chat?.id;
      const messageId = query.message?.message_id;
      if (typeof chatId !== "number" || typeof messageId !== "number") {
        await answerTabCallback(query.id);
        return true;
      }
      const tabState = await ensureState(deps.getCwd(ctx));
      const [, action, rawMode, rawName] = data.split(":");
      if (
        isForumNativeMode() &&
        (action === "switch" || action === "close" || action?.startsWith("close-"))
      ) {
        await answerTabCallback(
          query.id,
          TELEGRAM_FORUM_NATIVE_TAB_LIFECYCLE_DISABLED_MESSAGE,
        );
        await editTabDashboard(tabState, chatId, messageId, {
          mode: "open",
          selectedCloseTabs: [],
        });
        return true;
      }
      if (action === "noop") {
        const activeRuntime = getRuntime(tabState, tabState.activeTab);
        await answerTabCallback(
          query.id,
          `Active tab: ${formatTelegramTabDisplayName(
            activeRuntime?.record.name ?? tabState.activeTab,
          )}`,
        );
        return true;
      }
      if (action === "refresh") {
        await editTabDashboard(tabState, chatId, messageId, {
          mode: "open",
          selectedCloseTabs: [],
        });
        await answerTabCallback(query.id, "Refreshed.");
        return true;
      }
      if (action === "close-manage") {
        await editTabDashboard(tabState, chatId, messageId, {
          mode: "close",
          selectedCloseTabs: [],
        });
        await answerTabCallback(query.id);
        return true;
      }
      if (action === "close-done") {
        await editTabDashboard(tabState, chatId, messageId, {
          mode: "open",
          selectedCloseTabs: [],
        });
        await answerTabCallback(query.id, "Done.");
        return true;
      }
      if (action === "close-toggle") {
        const name = decodeTelegramTabCallbackName(rawMode);
        if (!name || !tabState.tabs[name] || name === TELEGRAM_DEFAULT_TAB_NAME) {
          await answerTabCallback(query.id, "Tab cannot be closed.");
          await editTabDashboard(tabState, chatId, messageId, { mode: "close" });
          return true;
        }
        const dashboardState = getDashboardState(messageId);
        const selected = new Set(
          normalizeTelegramTabCloseSelection(
            tabState,
            dashboardState?.selectedCloseTabs ?? [],
          ),
        );
        if (selected.has(name)) selected.delete(name);
        else selected.add(name);
        await editTabDashboard(tabState, chatId, messageId, {
          mode: "close",
          selectedCloseTabs: [...selected],
        });
        await answerTabCallback(
          query.id,
          selected.has(name) ? "Selected." : "Unselected.",
        );
        return true;
      }
      if (action === "close-select-all") {
        const selectedCloseTabs = getTelegramTabCloseableNames(tabState);
        await editTabDashboard(tabState, chatId, messageId, {
          mode: "close",
          selectedCloseTabs,
        });
        await answerTabCallback(
          query.id,
          selectedCloseTabs.length > 0 ? "All closeable tabs selected." : "No closeable tabs.",
        );
        return true;
      }
      if (action === "close-clear") {
        await editTabDashboard(tabState, chatId, messageId, {
          mode: "close",
          selectedCloseTabs: [],
        });
        await answerTabCallback(query.id, "Selection cleared.");
        return true;
      }
      if (action === "close-selected") {
        const dashboardState = getDashboardState(messageId);
        const selectedCloseTabs = normalizeTelegramTabCloseSelection(
          tabState,
          dashboardState?.selectedCloseTabs ?? [],
        );
        if (selectedCloseTabs.length === 0) {
          await answerTabCallback(query.id, "No tabs selected.");
          return true;
        }
        await deps.editInteractiveMessage?.(
          chatId,
          messageId,
          buildTelegramTabMultiCloseConfirmationText(tabState, selectedCloseTabs),
          "plain",
          buildTelegramTabMultiCloseConfirmationReplyMarkup(),
        );
        setDashboardState({
          chatId,
          messageId,
          mode: "close",
          selectedCloseTabs,
          updatedAt: now(),
        });
        await answerTabCallback(query.id);
        return true;
      }
      if (action === "close-cancel") {
        const selectedCloseTabs = normalizeTelegramTabCloseSelection(
          tabState,
          getDashboardState(messageId)?.selectedCloseTabs ?? [],
        );
        await editTabDashboard(tabState, chatId, messageId, {
          mode: "close",
          selectedCloseTabs,
        });
        await answerTabCallback(query.id, "Cancelled.");
        return true;
      }
      if (action === "close-confirm") {
        const selectedCloseTabs = normalizeTelegramTabCloseSelection(
          tabState,
          getDashboardState(messageId)?.selectedCloseTabs ?? [],
        );
        if (selectedCloseTabs.length === 0) {
          await answerTabCallback(query.id, "No tabs selected.");
          return true;
        }
        const closedNames: string[] = [];
        const skippedMessages: string[] = [];
        try {
          for (const name of selectedCloseTabs) {
            const result = await closeRuntimeTab(tabState, name, true);
            if (result.closed) closedNames.push(name);
            else skippedMessages.push(result.message);
          }
          if (closedNames.length > 0) await persist();
        } catch (error) {
          await answerTabCallback(
            query.id,
            `Close failed: ${getErrorMessage(error)}`,
          );
          return true;
        }
        await editTabDashboard(tabState, chatId, messageId, {
          mode: "open",
          selectedCloseTabs: [],
        });
        const skippedSuffix = skippedMessages.length > 0
          ? ` ${skippedMessages.length} skipped.`
          : "";
        await answerTabCallback(
          query.id,
          `${closedNames.length} tab${closedNames.length === 1 ? "" : "s"} closed.${skippedSuffix}`,
        );
        return true;
      }
      if (action === "switch") {
        const name = decodeTelegramTabCallbackName(rawMode);
        if (!name || !tabState.tabs[name]) {
          await answerTabCallback(query.id, "Tab no longer exists.");
          await editTabDashboard(tabState, chatId, messageId, {
            mode: "open",
            selectedCloseTabs: [],
          });
          return true;
        }
        await answerTabCallback(query.id, `Switching to ${name}.`);
        await commandHandlers.switch(tabState, name, chatId, messageId);
        await editTabDashboard(tabState, chatId, messageId, {
          mode: "open",
          selectedCloseTabs: [],
        });
        return true;
      }
      if (action === "last5") {
        const runtime = getRuntime(tabState, tabState.activeTab);
        if (!runtime || !deps.sendLastTurnsOnSwitch) {
          await answerTabCallback(query.id, "No replay available.");
          return true;
        }
        await answerTabCallback(query.id, "Replaying latest turn.");
        await deps.sendLastTurnsOnSwitch(
          getTelegramTabSessionReference(runtime.record),
          chatId,
          messageId,
        );
        return true;
      }
      if (action === "status") {
        await answerTabCallback(query.id, "Sending status.");
        await commandHandlers.status(tabState, tabState.activeTab, chatId, messageId);
        return true;
      }
      if (action === "help") {
        const text = isForumNativeMode()
          ? TELEGRAM_FORUM_NATIVE_TAB_LIFECYCLE_DISABLED_MESSAGE
          : rawMode === "rename"
            ? "Use /tab rename [old-name] <new-name>."
            : "Use /tab new <name>.";
        await answerTabCallback(query.id, text);
        return true;
      }
      if (action === "abort" || action === "close") {
        const mode = rawMode;
        const name = decodeTelegramTabCallbackName(
          mode === "do" ? rawName : rawMode,
        );
        if (!name || !tabState.tabs[name]) {
          await answerTabCallback(query.id, "Tab no longer exists.");
          await editTabDashboard(tabState, chatId, messageId, {
            mode: "open",
            selectedCloseTabs: [],
          });
          return true;
        }
        if (mode === "do") {
          await answerTabCallback(
            query.id,
            action === "abort" ? `Aborting ${name}.` : `Closing ${name}.`,
          );
          if (action === "abort") {
            await commandHandlers.abort(tabState, name, chatId, messageId);
          } else {
            await commandHandlers.close(tabState, name, true, chatId, messageId);
          }
          await editTabDashboard(tabState, chatId, messageId, {
            mode: "open",
            selectedCloseTabs: [],
          });
          return true;
        }
        const runtime = getRuntime(tabState, name);
        const detail =
          action === "abort"
            ? `Abort tab ${name}?`
            : `Close tab ${name}? Session file will be kept.`;
        const status = runtime?.record.status
          ? `\nStatus: ${formatTelegramTabStatusLabel(runtime.record.status)}`
          : "";
        await deps.editInteractiveMessage?.(
          chatId,
          messageId,
          `${detail}${status}`,
          "plain",
          buildTelegramTabConfirmReplyMarkup(action, name),
        );
        await answerTabCallback(query.id);
        return true;
      }
      await answerTabCallback(query.id);
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
      deps.debugLogger?.log("telegram.tab.topic.service", {
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
        deps.debugLogger?.log("telegram.tab.topic.service.untrusted_chat", {
          kind: serviceKind,
          chatId,
          messageThreadId,
          hasFrom: "from" in message,
        });
        return true;
      }
      const tabState = await ensureState(deps.getCwd(ctx));
      if (serviceKind === "created") {
        await upsertTelegramTopicTabRecord(
          tabState,
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
        const record = findTelegramTabByTopic(
          tabState.tabs,
          chatId,
          messageThreadId,
        );
        if (record && updateTelegramTopicRecordTitle(record, message.forum_topic_edited?.name)) {
          const runtime = getRuntime(tabState, record.name);
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
        const record = findTelegramTabByTopic(
          tabState.tabs,
          chatId,
          messageThreadId,
        );
        if (!record || record.name === TELEGRAM_DEFAULT_TAB_NAME) return true;
        const result = await closeRuntimeTab(tabState, record.name, true);
        if (result.closed) await persist();
        if (topicBinding.deleteTopicOnClose && deps.deleteForumTopic) {
          try {
            await deps.deleteForumTopic(chatId, messageThreadId);
            deps.debugLogger?.log("telegram.tab.topic.delete", {
              chatId,
              messageThreadId,
              tab: record.name,
              result: "deleted",
            });
          } catch (error) {
            deps.debugLogger?.log("telegram.tab.topic.delete_error", {
              chatId,
              messageThreadId,
              tab: record.name,
              error: getErrorMessage(error),
            });
            deps.recordRuntimeEvent?.("tabs", error, {
              action: "deleteForumTopic",
              tab: record.name,
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
                    "已關閉 pi tab，但無法刪除 Telegram topic。請把 bot 設為 admin，並開啟 Manage Topics 權限。",
                  ),
              );
            }
          }
        }
        return true;
      }
      if (serviceKind === "reopened") {
        if (!getTopicBindingConfig()?.autoCreate) return true;
        await upsertTelegramTopicTabRecord(
          tabState,
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
      const tabState = await ensureState(deps.getCwd(ctx));
      const runtime = await getRuntimeForPromptTurn(tabState, turn, ctx);
      if (!runtime) return true;
      try {
        await refreshRuntimeState(runtime);
        await assertNoOpenSessionConflict(tabState, runtime, runtime.record);
      } catch (error) {
        await sendTurnTextReply(turn, getErrorMessage(error));
        return true;
      }
      const promptText = buildTelegramTabPromptText(turn);
      if (!promptText) {
        await sendTurnTextReply(turn, "Tab prompt is empty.");
        return true;
      }
      const wasRunning = runtime.record.status === "running";
      const promptNow = now();
      runtime.activeChatId = turn.chatId;
      runtime.activeMessageThreadId = turn.messageThreadId;
      runtime.activeReplyToMessageId = turn.replyToMessageId;
      runtime.activeTopicDelivery = isTopicBindingEnabled() &&
        (turn.messageThreadId !== undefined ||
          runtime.record.name === TELEGRAM_DEFAULT_TAB_NAME ||
          runtime.record.source?.kind === "telegram-topic");
      runtime.activeTurnId = `tab:${runtime.record.name}:${turn.chatId}:${turn.messageThreadId ?? "general"}:${turn.replyToMessageId}:${promptNow}`;
      runtime.promptStartedAt = promptNow;
      runtime.promptSentAt = undefined;
      runtime.agentStartedAt = undefined;
      runtime.firstOutputAt = undefined;
      runtime.firstOutputLogged = false;
      runtime.record.lastUsedAt = promptNow;
      runtime.record.lastMessageText = promptText;
      runtime.record.lastMessageAt = promptNow;
      await persist();
      startTabTyping(runtime.record.name, runtime);
      try {
        deps.debugLogger?.log(
          "telegram.tab.prompt.start",
          {
            ...getTabTurnDetails(runtime.record.name, runtime),
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
        deps.debugLogger?.log("telegram.tab.prompt.sent", {
          ...getTabTurnDetails(runtime.record.name, runtime),
          elapsedMs: Date.now() - promptStartedAt,
          wasRunning,
        });
        runtime.record.status = "running";
        await persist();
        await sendTurnTextReply(
          turn,
          wasRunning
            ? `Queued follow-up in tab ${formatTelegramTabRecordDisplayName(runtime.record)}.`
            : `Started tab ${formatTelegramTabRecordDisplayName(runtime.record)}.`,
        );
      } catch (error) {
        deps.debugLogger?.log("telegram.tab.prompt.error", {
          ...getTabTurnDetails(runtime.record.name, runtime),
          error: error instanceof Error ? error.message : String(error),
        });
        logTabTurnSummary(
          runtime.record.name,
          runtime,
          "error",
          error instanceof Error ? error.message : String(error),
        );
        stopTabTyping(runtime);
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("tabs", error, {
          tab: runtime.record.name,
          action: "prompt",
        });
        await persist();
        await sendTurnTextReply(
          turn,
          `Tab ${formatTelegramTabRecordDisplayName(runtime.record)} failed: ${getErrorMessage(error)}`,
        );
      }
      return true;
    },
    dispose: async () => {
      await Promise.all(
        [...runtimeTabs.values()].map(async (runtime) => {
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
