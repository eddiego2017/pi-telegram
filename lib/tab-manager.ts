/**
 * Telegram concurrent tab runtime
 * Zones: telegram controls, pi agent, process lifecycle
 * Owns durable tab registry loading, per-tab RPC backend orchestration, and text-first Telegram delivery
 */

import { existsSync, readFileSync } from "node:fs";
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
  findTelegramTabNameCaseConflict,
  formatTelegramTabFilterSummary,
  formatTelegramTabList,
  formatTelegramTabStatus,
  formatTelegramTabStatusLabel,
  formatTelegramTabUsage,
  normalizeTelegramTabName,
  normalizeTelegramTabsState,
  parseTelegramTabCommand,
  TELEGRAM_DEFAULT_TAB_NAME,
  truncateTelegramTabText,
  validateTelegramTabName,
  type TelegramTabFilterTraceItem,
  type TelegramTabRecord,
  type TelegramTabsState,
} from "./tabs.ts";
import type { TelegramConcurrentTabsConfig } from "./config.ts";
import { isThinkingLevel, type ThinkingLevel } from "./model.ts";
import { getTelegramAgentDir } from "./config.ts";
import type { TelegramDebugLogger } from "./debug.ts";
import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";

const TELEGRAM_TAB_STREAM_EDIT_THROTTLE_MS = 1200;
const TELEGRAM_TAB_STREAM_FAILURE_BASE_RETRY_MS = 30_000;
const TELEGRAM_TAB_STREAM_FAILURE_MAX_RETRY_MS = 10 * 60 * 1000;
const TELEGRAM_TAB_STREAM_MARKDOWN_LIMIT = 3600;
const TELEGRAM_TAB_TYPING_ACTION_INTERVAL_MS = 2500;
const TELEGRAM_TAB_DASHBOARD_STATE_TTL_MS = 10 * 60 * 1000;

export interface TelegramTabPromptContent {
  type: string;
  text?: string;
}

export interface TelegramTabPromptTurn {
  chatId: number;
  replyToMessageId: number;
  content: readonly TelegramTabPromptContent[];
  statusSummary?: string;
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
  getConfig: () => Required<TelegramConcurrentTabsConfig>;
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
}

interface RuntimeTab {
  record: TelegramTabRecord;
  backend?: TelegramTabBackend;
  unreadEvents: number;
  activeBuffer: string;
  activeAssistantText?: string;
  activeErrorDelivered?: boolean;
  streamDeliveryFailureCount?: number;
  streamDeliveryBlockedUntil?: number;
  textStream?: TelegramTabStreamState;
  thinkingBuffers: Map<number, string>;
  thinkingStreams: Map<number, TelegramTabStreamState>;
  toolCallStreams: Map<number, TelegramTabStreamState>;
  sentThinkingTexts: Set<string>;
  sentToolCallMessages: Set<string>;
  typingChatId?: number;
  typingInterval?: ReturnType<typeof setInterval>;
  activeChatId?: number;
  activeReplyToMessageId?: number;
  activeTurnId?: string;
  promptStartedAt?: number;
  promptSentAt?: number;
  agentStartedAt?: number;
  firstOutputAt?: number;
  firstOutputLogged?: boolean;
  unsubscribe?: () => void;
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
  flushTimer?: ReturnType<typeof setTimeout>;
  flushPromise?: Promise<void>;
  flushRequested?: boolean;
}

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

function isSameTelegramTabSessionFile(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left || !right) return false;
  return resolve(left) === resolve(right);
}

function normalizeTelegramTabSessionName(name: string): string | undefined {
  const trimmed = name.trim();
  return trimmed ? trimmed : undefined;
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
  runtime.thinkingStreams.clear();
  runtime.toolCallStreams.clear();
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
): { index: number; markdown: string; final: boolean } | undefined {
  if (event.type !== "message_update") return undefined;
  const assistantEvent = getRpcAssistantMessageEvent(event);
  if (!assistantEvent) return undefined;
  const eventType = assistantEvent.type;
  if (
    eventType !== "toolcall_start" &&
    eventType !== "toolcall_delta" &&
    eventType !== "toolcall_end"
  ) {
    return undefined;
  }
  const index = getRpcAssistantEventContentIndex(assistantEvent);
  const block =
    eventType === "toolcall_end"
      ? assistantEvent.toolCall
      : getAgentMessageContentBlock(assistantEvent.partial, index);
  const markdown = formatTelegramTabToolCallPreview(block);
  return markdown
    ? { index, markdown, final: eventType === "toolcall_end" }
    : undefined;
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
    record.name,
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
    .map((tab) => `${tab.name} ${unreadByTab[tab.name]}`);
  const filterSummary = mode === "open"
    ? formatTelegramTabFilterSummary(filterTrace)
    : undefined;
  const lines = [
    filterSummary
      ? `Tabs ${tabs.length}/${allTabs.length} filtered (${allTabs.length}/${maxTabs} total)`
      : `Tabs ${allTabs.length}/${maxTabs}`,
    active
      ? [
          `Active: ${active.name}`,
          formatTelegramTabStatusLabel(active.status),
          `${Math.max(0, active.messageCount ?? 0)}msg`,
          formatTelegramTabDashboardName(active),
        ].join(" · ")
      : `Active: ${state.activeTab}`,
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
      .map((tab) => tab.name);
    lines.push("Close mode: select tabs to close.");
    lines.push(`Selected: ${safeSelectedCloseTabs.length}`);
    lines.push("Default tab is protected. Session files are kept.");
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
  return `${active}${record.name}${unread}${running}`;
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
            text: `${tab.name} protected`,
            callback_data: "tab:noop",
          };
        }
        const selected = selectedSet.has(tab.name);
        return {
          text: `${selected ? "☑" : "☐"} ${tab.name}`,
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
        tab.name === state.activeTab
          ? "tab:noop"
          : `tab:switch:${encodeTelegramTabCallbackName(tab.name)}`,
    }));
    rows.push(row);
  }
  if (visibleTabs) {
    rows.push([{ text: "All tabs", callback_data: "tab:refresh" }]);
  }
  if (getTelegramTabCloseableNames(state).length > 0) {
    rows.push([{ text: "Manage 🗑", callback_data: "tab:close-manage" }]);
  }
  rows.push([
    {
      text: "Close",
      callback_data: `tab:close:${encodeTelegramTabCallbackName(state.activeTab)}`,
    },
  ]);
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
    `- ${tab.name} · ${formatTelegramTabStatusLabel(tab.status)}`
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
  };
  const stopOtherTabTyping = (tabName: string): void => {
    for (const [name, runtime] of runtimeTabs.entries()) {
      if (name !== tabName) stopTabTyping(runtime);
    }
  };
  const startTabTyping = (tabName: string, runtime: RuntimeTab): void => {
    const chatId = runtime.activeChatId;
    if (!deps.sendTypingAction || chatId === undefined || chatId === 0) return;
    stopOtherTabTyping(tabName);
    if (runtime.typingInterval && runtime.typingChatId === chatId) return;
    stopTabTyping(runtime);
    const sendTyping = (): void => {
      void deps.sendTypingAction?.(chatId).catch((error) => {
        deps.recordRuntimeEvent?.("typing", error, {
          tab: runtime.record.name,
          chatId,
        });
      });
    };
    runtime.typingChatId = chatId;
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
  const getStreamFailureRetryMs = (failureCount: number): number =>
    Math.min(
      streamFailureMaxRetryMs,
      streamFailureBaseRetryMs *
        2 ** Math.min(Math.max(0, failureCount - 1), 6),
    );
  const schedulePendingTabStreamRetry = (
    runtime: RuntimeTab,
    stream: TelegramTabStreamState,
  ): void => {
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
  ): Promise<void> => {
    if (!stream.markdown || stream.markdown === stream.sentMarkdown) return;
    const blockedUntil = getTabStreamDeliveryBlockedUntil(runtime, stream);
    if (blockedUntil !== undefined && now() < blockedUntil) {
      schedulePendingTabStreamRetry(runtime, stream);
      return;
    }
    if (stream.flushPromise) {
      stream.flushRequested = true;
      await stream.flushPromise;
      return;
    }
    stream.flushPromise = (async () => {
      do {
        stream.flushRequested = false;
        const markdown = stream.markdown;
        if (!markdown || markdown === stream.sentMarkdown) return;
        let delivered = false;
        try {
          if (stream.messageId === undefined) {
            const messageId = await sendTabStreamMarkdownReply(
              runtime.activeChatId,
              runtime.activeReplyToMessageId,
              markdown,
            );
            if (messageId !== undefined) {
              stream.messageId = messageId;
              delivered = true;
            }
          } else if (deps.editStreamMarkdownMessage) {
            const messageId = await editTabStreamMarkdownMessage(
              runtime.activeChatId,
              stream.messageId,
              markdown,
            );
            delivered = true;
            if (messageId !== undefined) stream.messageId = messageId;
          }
        } catch (error) {
          deps.recordRuntimeEvent?.("tabs", error, {
            tab: runtime.record.name,
            action: "stream_markdown",
          });
        }
        if (!delivered) {
          blockTabStreamDelivery(runtime, stream);
          scheduleAllPendingTabStreamRetries(runtime, stream);
          return;
        }
        unblockTabStreamDelivery(runtime, stream);
        stream.sentMarkdown = markdown;
        stream.lastFlushAt = now();
      } while (stream.flushRequested);
    })();
    try {
      await stream.flushPromise;
    } finally {
      stream.flushPromise = undefined;
      if (stream.markdown !== stream.sentMarkdown) {
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
      blockedUntil === undefined ? 0 : Math.max(0, blockedUntil - now());
    const wait =
      retryWait > 0
        ? retryWait
        : force
          ? 0
          : Math.max(0, streamEditThrottleMs - (now() - stream.lastFlushAt));
    if (wait === 0) {
      void flushTabStreamMarkdown(runtime, stream);
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
    if (tabState.activeTab !== tabName) return;
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
    if (!trimmed || tabState.activeTab !== tabName) return false;
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
    if (!trimmed || runtime.sentThinkingTexts.has(trimmed)) return;
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
    if (!markdown) return;
    const stream = getStreamState(runtime.toolCallStreams, index);
    streamActiveTabMarkdown(tabState, tabName, runtime, stream, markdown, final);
    if (final) {
      runtime.sentToolCallMessages.add(markdown);
      runtime.toolCallStreams.delete(index);
    }
  };
  const getTabTurnDetails = (tabName: string, runtime: RuntimeTab): Record<string, unknown> => ({
    tab: tabName,
    turnId: runtime.activeTurnId,
    chatId: runtime.activeChatId,
    replyToMessageId: runtime.activeReplyToMessageId,
  });
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
    if (
      runtime.toolCallStreams.size > 0 ||
      runtime.sentToolCallMessages.size > 0
    ) {
      return true;
    }
    const markdown = getAgentMessageText(message);
    if (!markdown || runtime.sentToolCallMessages.has(markdown)) return true;
    if (tabState.activeTab !== tabName) return false;
    runtime.sentToolCallMessages.add(markdown);
    void sendTabMarkdownReply(
      runtime.activeChatId,
      runtime.activeReplyToMessageId,
      markdown,
    );
    return true;
  };
  const handleChildEvent = (
    tabName: string,
    runtime: RuntimeTab,
    event: RpcChildBackendEvent,
  ): void => {
    const tabState = state;
    if (!tabState) return;
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
      if (tabState.activeTab === tabName) startTabTyping(tabName, runtime);
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
      streamActiveTabToolCall(
        tabState,
        tabName,
        runtime,
        toolCallPreview.index,
        toolCallPreview.markdown,
        toolCallPreview.final,
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
        const isActive = tabState.activeTab === tabName;
        if (!runtime.activeErrorDelivered) {
          runtime.activeErrorDelivered = true;
          if (isActive) {
            void sendTabReply(
              runtime.activeChatId,
              runtime.activeReplyToMessageId,
              `Tab ${tabName} failed: ${assistantError}`,
            );
          } else {
            runtime.unreadEvents += 1;
            if (deps.getConfig().inactiveNotify) {
              void sendTabReply(
                runtime.activeChatId,
                runtime.activeReplyToMessageId,
                `Tab ${tabName} failed: ${assistantError}`,
              );
            }
          }
        }
        void persist();
        return;
      }
      record.status = "idle";
      record.lastError = undefined;
      if (!runtime.activeAssistantText && runtime.activeBuffer) {
        runtime.activeAssistantText = runtime.activeBuffer;
        record.lastAssistantText = runtime.activeBuffer;
      }
      const isActive = tabState.activeTab === tabName;
      const finalBodyText = latestAssistant
        ? extractAgentBodyText(latestAssistant)
        : runtime.activeBuffer;
      const finalAlreadyStreamedAsText =
        runtime.textStream !== undefined && finalBodyText
          ? streamActiveTabText(tabState, tabName, runtime, finalBodyText, true)
          : false;
      if (
        isActive &&
        runtime.activeAssistantText &&
        !finalAlreadySentAsToolCall &&
        !finalAlreadyStreamedAsText
      ) {
        void sendTabMarkdownReply(
          runtime.activeChatId,
          runtime.activeReplyToMessageId,
          runtime.activeAssistantText,
        );
      } else if (!isActive) {
        runtime.unreadEvents += 1;
        if (deps.getConfig().inactiveNotify) {
          const chatId = runtime.activeChatId;
          const replyToMessageId = runtime.activeReplyToMessageId;
          void sendTabReply(
            chatId,
            replyToMessageId,
            `Tab ${tabName} finished. Use /tab ${tabName} to view latest reply.`,
          );
        }
      }
      logTabTurnSummary(tabName, runtime, "stop");
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
    const workerArgs = buildTelegramTabWorkerExtensionArgs(
      deps.getConfig().workerExtensions,
    );
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
  const getActiveRuntime = async (ctx: TContext): Promise<RuntimeTab | undefined> => {
    const tabState = await ensureState(deps.getCwd(ctx));
    return getRuntime(tabState, tabState.activeTab);
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
  const sendTabDashboard = async (
    tabState: TelegramTabsState,
    chatId: number,
    replyToMessageId: number,
    filters: readonly string[] = [],
  ): Promise<void> => {
    await refreshDashboardTabRecords(tabState);
    const unreadByTab = getUnreadByTab();
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
      ),
      "plain",
      buildTelegramTabDashboardReplyMarkup(tabState, unreadByTab, "open", [], visibleTabs),
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
    const mode = options.mode ?? existingState?.mode ?? "open";
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
      ),
      "plain",
      buildTelegramTabDashboardReplyMarkup(
        tabState,
        unreadByTab,
        mode,
        selectedCloseTabs,
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
      return { closed: false, message: "Cannot close default tab." };
    }
    const runtime = getRuntime(tabState, name);
    if (!runtime) {
      return { closed: false, message: `Unknown tab: ${name}` };
    }
    if (runtime.record.status === "running" && !force) {
      return {
        closed: false,
        message: `Tab ${name} is running. Use /tab close ${name} --force to close it.`,
      };
    }
    stopTabTyping(runtime);
    await runtime.backend?.dispose();
    runtime.unsubscribe?.();
    runtimeTabs.delete(name);
    delete tabState.tabs[name];
    if (tabState.activeTab === name) tabState.activeTab = TELEGRAM_DEFAULT_TAB_NAME;
    return { closed: true, message: `Closed tab ${name}.` };
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
      if (getRuntime(tabState, name)) {
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
        await deps.sendTextReply(chatId, replyToMessageId, `Tab ${name} already exists.`);
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
          `Created and switched to tab ${name}.`,
        );
      } catch (error) {
        deps.recordRuntimeEvent?.("tabs", error, { tab: name, action: "new" });
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Created tab ${name}, but worker failed: ${getErrorMessage(error)}`,
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
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown tab: ${name}`);
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
          `Switched to tab ${name}.\n\nLast reply:\n${lastAssistantText}`,
        );
      } else {
        const latest = lastAssistantText
          ? `\n\nLast reply:\n${truncateTelegramTabText(lastAssistantText)}`
          : "";
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Switched to tab ${name}.${replayNote}${latest}`,
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
        await deps.sendTextReply(chatId, replyToMessageId, "Cannot rename default tab.");
        return;
      }
      const runtime = getRuntime(tabState, sourceName);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown tab: ${sourceName}`);
        return;
      }
      const validationError = validateTelegramTabName(newName);
      if (validationError) {
        await deps.sendTextReply(chatId, replyToMessageId, validationError);
        return;
      }
      if (newName === sourceName) {
        await deps.sendTextReply(chatId, replyToMessageId, `Tab ${sourceName} is already named ${newName}.`);
        return;
      }
      if (tabState.tabs[newName]) {
        await deps.sendTextReply(chatId, replyToMessageId, `Tab ${newName} already exists.`);
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
        `Renamed tab ${sourceName} to ${newName}.`,
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
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown tab: ${name}`);
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
          message: `No active worker for tab ${targetName}.`,
        };
      }
      await runtime.backend.abort();
      stopTabTyping(runtime);
      runtime.record.status = "idle";
      await persist();
      return {
        tabName: targetName,
        aborted: true,
        message: `Aborted tab ${targetName}.`,
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
    restart: async (
      tabState: TelegramTabsState,
      name: string,
      chatId: number,
      replyToMessageId: number,
      ctx: TContext,
    ) => {
      const runtime = getRuntime(tabState, name);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown tab: ${name}`);
        return;
      }
      stopTabTyping(runtime);
      await runtime.backend?.dispose();
      runtime.unsubscribe?.();
      runtime.backend = undefined;
      runtime.unsubscribe = undefined;
      try {
        await ensureBackend(runtime, ctx);
        await deps.sendTextReply(chatId, replyToMessageId, `Restarted tab ${name}.`);
      } catch (error) {
        deps.recordRuntimeEvent?.("tabs", error, { tab: name, action: "restart" });
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Tab ${name} restart failed: ${getErrorMessage(error)}`,
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
      const tabState = ensureStateSync(deps.getCwd(ctx));
      const runtime = getRuntime(tabState, tabState.activeTab);
      if (!runtime) return undefined;
      return getTelegramTabSessionReference(runtime.record, deps.getCwd(ctx));
    },
    getActiveResumeSessionScope: (ctx) => {
      if (!isEnabled()) return undefined;
      const tabState = ensureStateSync(deps.getCwd(ctx));
      const runtime = getRuntime(tabState, tabState.activeTab);
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
      const tabState = ensureStateSync(deps.getCwd(ctx));
      const runtime = getRuntime(tabState, tabState.activeTab);
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
      const tabState = ensureStateSync(deps.getCwd(ctx));
      const runtime = getRuntime(tabState, tabState.activeTab);
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
        const childState = await backend.getState();
        applyRpcStateToRecord(runtime.record, childState);
        const sessionName =
          typeof childState.sessionName === "string"
            ? childState.sessionName.trim()
            : undefined;
        if (sessionName) {
          runtime.record.sessionName = sessionName;
        } else {
          delete runtime.record.sessionName;
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
      const runtime = getRuntime(tabState, tabState.activeTab);
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
      const otherTab = Object.values(tabState.tabs).find(
        (record) =>
          record.name !== runtime.record.name &&
          isSameTelegramTabSessionFile(record.sessionFile, sessionPath),
      );
      if (otherTab) {
        throw new Error(
          `Session is also open in tab ${otherTab.name}. Switch or close that tab first.`,
        );
      }
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
      return commandHandlers.abortRuntime(tabState, undefined);
    },
    switchSession: async (sessionPath, ctx, scope) => {
      if (!isEnabled() || scope?.kind !== "tab" || !scope.tabName) {
        return false;
      }
      const tabState = await ensureState(deps.getCwd(ctx));
      const runtime = getRuntime(tabState, scope.tabName);
      if (!runtime) {
        throw new Error(`Unknown tab: ${scope.tabName}`);
      }
      await refreshRuntimeState(runtime);
      if (!canSwitchTelegramTabModel(runtime.record)) {
        throw new Error(
          `Tab ${scope.tabName} is busy. Send /tab abort ${scope.tabName} first.`,
        );
      }
      try {
        const backend = await ensureBackend(runtime, ctx);
        const result = await backend.switchSession(sessionPath);
        if (result.cancelled) {
          throw new Error("switchSession cancelled");
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
          await commandHandlers.new(tabState, command.name, chatId, replyToMessageId, ctx);
          return true;
        case "query":
          await commandHandlers.query(tabState, command.query, command.filters, chatId, replyToMessageId);
          return true;
        case "switch":
          await commandHandlers.switch(tabState, command.name, chatId, replyToMessageId);
          return true;
        case "rename":
          await commandHandlers.rename(tabState, command.oldName, command.newName, chatId, replyToMessageId);
          return true;
        case "close":
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
      if (action === "noop") {
        await answerTabCallback(query.id, `Active tab: ${tabState.activeTab}`);
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
        const text =
          rawMode === "rename"
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
    dispatchPrompt: async (turn, ctx) => {
      if (!isEnabled()) return false;
      const tabState = await ensureState(deps.getCwd(ctx));
      const runtime = getRuntime(tabState, tabState.activeTab);
      if (!runtime) return false;
      const promptText = buildTelegramTabPromptText(turn);
      if (!promptText) {
        await deps.sendTextReply(
          turn.chatId,
          turn.replyToMessageId,
          "Tab prompt is empty.",
        );
        return true;
      }
      const wasRunning = runtime.record.status === "running";
      const promptNow = now();
      runtime.activeChatId = turn.chatId;
      runtime.activeReplyToMessageId = turn.replyToMessageId;
      runtime.activeTurnId = `tab:${runtime.record.name}:${turn.chatId}:${turn.replyToMessageId}:${promptNow}`;
      runtime.promptStartedAt = promptNow;
      runtime.promptSentAt = undefined;
      runtime.agentStartedAt = undefined;
      runtime.firstOutputAt = undefined;
      runtime.firstOutputLogged = false;
      runtime.record.lastUsedAt = promptNow;
      runtime.record.lastMessageText = promptText;
      runtime.record.lastMessageAt = promptNow;
      await persist();
      startTabTyping(tabState.activeTab, runtime);
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
        await deps.sendTextReply(
          turn.chatId,
          turn.replyToMessageId,
          wasRunning
            ? `Queued follow-up in tab ${runtime.record.name}.`
            : `Started tab ${runtime.record.name}.`,
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
        await deps.sendTextReply(
          turn.chatId,
          turn.replyToMessageId,
          `Tab ${runtime.record.name} failed: ${getErrorMessage(error)}`,
        );
      }
      return true;
    },
    dispose: async () => {
      await Promise.all(
        [...runtimeTabs.values()].map(async (runtime) => {
          stopTabTyping(runtime);
          resetRuntimeTurnBuffers(runtime);
          runtime.unsubscribe?.();
          await runtime.backend?.dispose();
          runtime.backend = undefined;
          if (runtime.record.status === "running" || runtime.record.status === "starting") {
            runtime.record.status = "exited";
          }
        }),
      );
      await persist();
    },
  };
}
