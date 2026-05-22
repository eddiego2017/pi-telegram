/**
 * Telegram concurrent tab runtime
 * Zones: telegram controls, pi agent, process lifecycle
 * Owns durable tab registry loading, per-tab RPC backend orchestration, and text-first Telegram delivery
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  extractRpcTextDelta,
  RpcChildBackend,
  type RpcChildBackendEvent,
  type RpcChildBackendOptions,
  type RpcChildSessionState,
} from "./rpc-child.ts";
import {
  formatAgentToolCallBlock,
  getAgentMessageText,
  isAssistantAgentMessage,
  type TelegramRenderedChunk,
  type TelegramRenderMode,
} from "./replies.ts";
import {
  createDefaultTelegramTabsState,
  findTelegramTabNameCaseConflict,
  formatTelegramTabList,
  formatTelegramTabStatus,
  formatTelegramTabUsage,
  normalizeTelegramTabsState,
  parseTelegramTabCommand,
  TELEGRAM_DEFAULT_TAB_NAME,
  truncateTelegramTabText,
  validateTelegramTabName,
  type TelegramTabRecord,
  type TelegramTabsState,
} from "./tabs.ts";
import type { TelegramConcurrentTabsConfig } from "./config.ts";
import { getTelegramAgentDir } from "./config.ts";

const TELEGRAM_TAB_STREAM_EDIT_THROTTLE_MS = 1200;
const TELEGRAM_TAB_STREAM_MARKDOWN_LIMIT = 3600;

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
  getState: () => Promise<RpcChildSessionState>;
  setModel: (provider: string, modelId: string) => Promise<void>;
  setThinkingLevel: (level: string) => Promise<void>;
}

export interface TelegramTabModelSelection {
  provider: string;
  id: string;
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
  streamEditThrottleMs?: number;
  now?: () => number;
  agentDir?: string;
  statePath?: string;
  sessionRoot?: string;
  createBackend?: (options: RpcChildBackendOptions) => TelegramTabBackend;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

interface RuntimeTab {
  record: TelegramTabRecord;
  backend?: TelegramTabBackend;
  unreadEvents: number;
  activeBuffer: string;
  textStream?: TelegramTabStreamState;
  thinkingBuffers: Map<number, string>;
  thinkingStreams: Map<number, TelegramTabStreamState>;
  toolCallStreams: Map<number, TelegramTabStreamState>;
  sentThinkingTexts: Set<string>;
  sentToolCallMessages: Set<string>;
  activeChatId?: number;
  activeReplyToMessageId?: number;
  unsubscribe?: () => void;
}

interface TelegramTabStreamState {
  markdown: string;
  sentMarkdown: string;
  lastFlushAt: number;
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
  getActiveThinkingLevel: (ctx: TContext) => Promise<string | undefined>;
  canSwitchActiveModel: (ctx: TContext) => Promise<boolean>;
  selectActiveModel: (
    model: TelegramTabModelSelection,
    ctx: TContext,
  ) => Promise<boolean>;
  setActiveThinkingLevel: (
    level: string,
    ctx: TContext,
  ) => Promise<boolean>;
  handleCommand: (
    args: string,
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<boolean>;
  dispatchPrompt: (turn: TelegramTabPromptTurn, ctx: TContext) => Promise<boolean>;
  dispose: () => Promise<void>;
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

export function createTelegramTabManagerShutdownHook<TContext>(
  manager: TelegramTabManager<TContext>,
): () => Promise<void> {
  return manager.dispose;
}

function getTelegramTabsStatePath(agentDir: string): string {
  return join(agentDir, "telegram-tabs.json");
}

function getTelegramTabsSessionRoot(agentDir: string): string {
  return join(agentDir, "telegram-tabs", "sessions");
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
  if (state.sessionName !== undefined) record.sessionName = state.sessionName;
  if (state.isStreaming === true) {
    record.status = "running";
  } else if (record.status === "starting" || record.status === "running") {
    record.status = "idle";
  }
}

function canSwitchTelegramTabModel(record: TelegramTabRecord): boolean {
  return record.status !== "running" && record.status !== "starting";
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

function formatTelegramTabThinkingMarkdown(text: string): string {
  const quoted = text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `💡 Thinking\n${quoted}`;
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
  const sessionRoot = deps.sessionRoot ?? getTelegramTabsSessionRoot(agentDir);
  const runtimeTabs = new Map<string, RuntimeTab>();
  let state: TelegramTabsState | undefined;
  let persistChain: Promise<void> = Promise.resolve();

  const now = (): number => deps.now?.() ?? Date.now();
  const isEnabled = (): boolean => deps.getConfig().enabled;
  const streamEditThrottleMs =
    deps.streamEditThrottleMs ?? TELEGRAM_TAB_STREAM_EDIT_THROTTLE_MS;
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
  const ensureState = async (cwd: string): Promise<TelegramTabsState> => {
    if (!state) {
      state = await readTelegramTabsState(statePath, cwd, now());
      for (const record of Object.values(state.tabs)) {
        runtimeTabs.set(record.name, createRuntimeTab(record));
      }
      await persist();
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
  const flushTabStreamMarkdown = async (
    runtime: RuntimeTab,
    stream: TelegramTabStreamState,
  ): Promise<void> => {
    if (!stream.markdown || stream.markdown === stream.sentMarkdown) return;
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
        if (!delivered) return;
        stream.sentMarkdown = markdown;
        stream.lastFlushAt = now();
      } while (stream.flushRequested);
    })().catch((error) => {
      deps.recordRuntimeEvent?.("tabs", error, {
        tab: runtime.record.name,
        action: "stream_markdown",
      });
    });
    try {
      await stream.flushPromise;
    } finally {
      stream.flushPromise = undefined;
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
    const wait = force
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
    if (force) runtime.sentThinkingTexts.add(trimmed);
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
    if (!markdown || runtime.sentToolCallMessages.has(markdown)) return;
    const stream = getStreamState(runtime.toolCallStreams, index);
    streamActiveTabMarkdown(tabState, tabName, runtime, stream, markdown, final);
    if (final) runtime.sentToolCallMessages.add(markdown);
  };
  const sendActiveTabToolCallMessage = (
    tabState: TelegramTabsState,
    tabName: string,
    runtime: RuntimeTab,
    message: unknown,
  ): boolean => {
    if (!agentMessageHasToolCall(message)) return false;
    if (runtime.toolCallStreams.size > 0) {
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
    if (event.type === "agent_start") {
      resetRuntimeTurnBuffers(runtime);
      record.status = "running";
      record.lastError = undefined;
      record.lastAgentStartAt = eventNow;
      void persist();
      return;
    }
    if (event.type === "message_start") {
      runtime.activeBuffer = "";
      runtime.textStream = undefined;
      return;
    }
    const delta = extractRpcTextDelta(event);
    if (delta) {
      runtime.activeBuffer += delta;
      streamActiveTabText(tabState, tabName, runtime, runtime.activeBuffer);
    }
    const thinkingDelta = getRpcAssistantThinkingDelta(event);
    if (thinkingDelta) {
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
    if (assistantText) record.lastAssistantText = assistantText;
    if (event.type === "message_end" && isAssistantAgentMessage(event.message)) {
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
      record.status = "idle";
      record.lastAgentEndAt = eventNow;
      if (!record.lastAssistantText && runtime.activeBuffer) {
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
        record.lastAssistantText &&
        !finalAlreadySentAsToolCall &&
        !finalAlreadyStreamedAsText
      ) {
        void sendTabMarkdownReply(
          runtime.activeChatId,
          runtime.activeReplyToMessageId,
          record.lastAssistantText,
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
      void persist();
      return;
    }
    if (event.type === "exit") {
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
      record.status = "error";
      record.lastError =
        typeof event.error === "string" ? event.error : "RPC child error";
      void persist();
    }
  };
  const ensureBackend = async (
    runtime: RuntimeTab,
    cwd: string,
  ): Promise<TelegramTabBackend> => {
    if (runtime.backend) return runtime.backend;
    runtime.record.status = "starting";
    runtime.record.lastError = undefined;
    await mkdir(join(sessionRoot, runtime.record.name), { recursive: true });
    const workerArgs = buildTelegramTabWorkerExtensionArgs(
      deps.getConfig().workerExtensions,
    );
    const backend = deps.createBackend?.({
      tabName: runtime.record.name,
      cwd: runtime.record.cwd || cwd,
      sessionDir: join(sessionRoot, runtime.record.name),
      sessionFile: runtime.record.sessionFile,
      args: workerArgs,
    }) ?? new RpcChildBackend({
      tabName: runtime.record.name,
      cwd: runtime.record.cwd || cwd,
      sessionDir: join(sessionRoot, runtime.record.name),
      sessionFile: runtime.record.sessionFile,
      args: workerArgs,
    });
    runtime.backend = backend;
    runtime.unsubscribe = backend.onEvent((event) => {
      handleChildEvent(runtime.record.name, runtime, event);
    });
    try {
      const childState = await backend.start();
      applyRpcStateToRecord(runtime.record, childState);
      await persist();
      return backend;
    } catch (error) {
      runtime.record.status = "error";
      runtime.record.lastError = getErrorMessage(error);
      runtime.backend = undefined;
      runtime.unsubscribe?.();
      runtime.unsubscribe = undefined;
      await persist();
      throw error;
    }
  };
  const refreshRuntimeState = async (runtime: RuntimeTab): Promise<void> => {
    if (!runtime.backend) return;
    await runtime.backend
      .getState()
      .then((childState) => applyRpcStateToRecord(runtime.record, childState))
      .catch((error) => {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
      });
    await persist();
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
  const commandHandlers = {
    list: async (
      tabState: TelegramTabsState,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const unread = Object.fromEntries(
        [...runtimeTabs.entries()].map(([name, runtime]) => [
          name,
          runtime.unreadEvents,
        ]),
      );
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        formatTelegramTabList(tabState, unread, now()),
      );
    },
    new: async (
      tabState: TelegramTabsState,
      name: string,
      chatId: number,
      replyToMessageId: number,
      ctx: TContext,
    ) => {
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
      tabState.tabs[name] = record;
      tabState.activeTab = name;
      const runtime: RuntimeTab = createRuntimeTab(record);
      runtimeTabs.set(name, runtime);
      await persist();
      try {
        await ensureBackend(runtime, record.cwd);
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
      tabState.activeTab = name;
      runtime.record.lastUsedAt = now();
      runtime.unreadEvents = 0;
      await persist();
      const latest = runtime.record.lastAssistantText
        ? `\n\nLast reply:\n${truncateTelegramTabText(runtime.record.lastAssistantText)}`
        : "";
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        `Switched to tab ${name}.${latest}`,
      );
    },
    close: async (
      tabState: TelegramTabsState,
      name: string,
      force: boolean,
      chatId: number,
      replyToMessageId: number,
    ) => {
      if (name === TELEGRAM_DEFAULT_TAB_NAME) {
        await deps.sendTextReply(chatId, replyToMessageId, "Cannot close default tab.");
        return;
      }
      const runtime = getRuntime(tabState, name);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown tab: ${name}`);
        return;
      }
      if (runtime.record.status === "running" && !force) {
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Tab ${name} is running. Use /tab close ${name} --force to close it.`,
        );
        return;
      }
      await runtime.backend?.dispose();
      runtime.unsubscribe?.();
      runtimeTabs.delete(name);
      delete tabState.tabs[name];
      if (tabState.activeTab === name) tabState.activeTab = TELEGRAM_DEFAULT_TAB_NAME;
      await persist();
      await deps.sendTextReply(chatId, replyToMessageId, `Closed tab ${name}.`);
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
    abort: async (
      tabState: TelegramTabsState,
      name: string | undefined,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const targetName = name ?? tabState.activeTab;
      const runtime = getRuntime(tabState, targetName);
      if (!runtime?.backend) {
        await deps.sendTextReply(chatId, replyToMessageId, `No active worker for tab ${targetName}.`);
        return;
      }
      await runtime.backend.abort();
      runtime.record.status = "idle";
      await persist();
      await deps.sendTextReply(chatId, replyToMessageId, `Aborted tab ${targetName}.`);
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
      await runtime.backend?.dispose();
      runtime.unsubscribe?.();
      runtime.backend = undefined;
      runtime.unsubscribe = undefined;
      try {
        await ensureBackend(runtime, deps.getCwd(ctx));
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
      return runtime.record.currentThinkingLevel;
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
        const backend = await ensureBackend(runtime, deps.getCwd(ctx));
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
      if (!isEnabled()) return false;
      const runtime = await getActiveRuntime(ctx);
      if (!runtime) return false;
      await refreshRuntimeState(runtime);
      if (!canSwitchTelegramTabModel(runtime.record)) return false;
      try {
        const backend = await ensureBackend(runtime, deps.getCwd(ctx));
        await backend.setThinkingLevel(level);
        runtime.record.currentThinkingLevel = level;
        await refreshRuntimeState(runtime);
        return true;
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("tabs", error, {
          tab: runtime.record.name,
          action: "set_thinking_level",
        });
        await persist();
        return false;
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
        case "switch":
          await commandHandlers.switch(tabState, command.name, chatId, replyToMessageId);
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
      runtime.activeChatId = turn.chatId;
      runtime.activeReplyToMessageId = turn.replyToMessageId;
      runtime.record.lastUsedAt = now();
      try {
        const backend = await ensureBackend(runtime, deps.getCwd(ctx));
        if (wasRunning) {
          await backend.followUp(promptText);
        } else {
          await backend.prompt(promptText);
        }
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
