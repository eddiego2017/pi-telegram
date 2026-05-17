/**
 * Telegram session center UI helpers
 * Zones: telegram controls, session history, menu composition
 * Owns the Telegram-native /session dashboard, active-branch history pager, and session callback dispatching.
 */

import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";

const TELEGRAM_SESSION_STATE_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_SESSION_HISTORY_PAGE_SIZE = 6;
const TELEGRAM_SESSION_SUMMARY_LEN = 54;
const TELEGRAM_SESSION_HISTORY_TABLE_WIDTH = 37;
const TELEGRAM_SESSION_HISTORY_ROLE_WIDTH = 9;
const TELEGRAM_SESSION_DETAIL_TEXT_LEN = 3000;
const TELEGRAM_SESSION_GRAPHEME_SEGMENTER =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

export type TelegramSessionReplyMarkup = TelegramInlineKeyboardMarkup;
export type TelegramSessionView = "main" | "history" | "detail";

export interface TelegramSessionContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface TelegramSessionUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

export interface TelegramSessionContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  arguments?: Record<string, unknown>;
}

export interface TelegramSessionMessage {
  role?: string;
  content?: string | TelegramSessionContentBlock[];
  timestamp?: number;
  usage?: TelegramSessionUsage;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  errorMessage?: string;
  stopReason?: string;
  provider?: string;
  model?: string;
}

export interface TelegramSessionEntry {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  message?: TelegramSessionMessage;
  name?: string;
  customType?: string;
  content?: string | TelegramSessionContentBlock[];
  display?: boolean;
}

export interface TelegramSessionSnapshot {
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  entries: TelegramSessionEntry[];
  branch: TelegramSessionEntry[];
  contextUsage?: TelegramSessionContextUsage;
}

export interface TelegramSessionHistoryItem {
  entryId: string;
  globalIndex: number;
  timestamp?: string;
  role: "user" | "assistant" | "tool" | "custom";
  title: string;
  summary: string;
  detail: string;
  toolCallCount: number;
  tokenOutput?: number;
}

export interface TelegramSessionStats {
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  toolCalls: number;
  totalMessages: number;
  totalEntries: number;
  branchEntries: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCost: number;
}

export interface TelegramSessionMenuState {
  chatId: number;
  messageId: number;
  view: TelegramSessionView;
  page: number;
  detailIndex?: number;
  updatedAt: number;
}

export interface TelegramSessionMenuStore {
  get(messageId: number | undefined): TelegramSessionMenuState | undefined;
  set(state: TelegramSessionMenuState): void;
  clear(): void;
}

export function createTelegramSessionMenuStore(
  now: () => number = Date.now,
): TelegramSessionMenuStore {
  const states = new Map<number, TelegramSessionMenuState>();
  function pruneExpired(): void {
    const cutoff = now() - TELEGRAM_SESSION_STATE_TTL_MS;
    for (const [messageId, state] of states.entries()) {
      if (state.updatedAt < cutoff) states.delete(messageId);
    }
  }
  return {
    get(messageId) {
      if (typeof messageId !== "number") return undefined;
      pruneExpired();
      return states.get(messageId);
    },
    set(state) {
      pruneExpired();
      states.set(state.messageId, state);
    },
    clear() {
      states.clear();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cleanText(s: string): string {
  return s
    .replace(/^\[telegram\]\s*/i, "")
    .replace(/\n\[reply\][\s\S]*$/i, "")
    .replace(/\n\[attachments\][\s\S]*$/i, "")
    .replace(/\n\[outputs\][\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, n: number): string {
  const clean = cleanText(s);
  if (clean.length <= n) return clean;
  return clean.slice(0, Math.max(0, n - 1)) + "…";
}

function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(n));
}

function formatMoney(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatContextUsage(usage: TelegramSessionContextUsage | undefined): string {
  if (!usage) return "unknown";
  const total = formatCount(usage.contextWindow);
  const used = usage.tokens === null ? "?" : formatCount(usage.tokens);
  const pct = usage.percent === null ? "?" : `${usage.percent.toFixed(1)}%`;
  return `${used}/${total} · ${pct}`;
}

function shortSessionFile(file: string | undefined): string {
  if (!file) return "In-memory";
  const home = process.env.HOME;
  if (home && file.startsWith(`${home}/`)) return `~/${file.slice(home.length + 1)}`;
  return file;
}

function contentText(content: TelegramSessionMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function countToolCalls(message: TelegramSessionMessage | undefined): number {
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((block) => block?.type === "toolCall").length;
}

function usageValue(value: number | undefined): number {
  return Number.isFinite(value) ? value ?? 0 : 0;
}

export function buildTelegramSessionStats(
  snapshot: TelegramSessionSnapshot,
): TelegramSessionStats {
  const stats: TelegramSessionStats = {
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    toolCalls: 0,
    totalMessages: 0,
    totalEntries: snapshot.entries.length,
    branchEntries: snapshot.branch.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
  for (const entry of snapshot.entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message) continue;
    if (message.role === "user") stats.userMessages += 1;
    else if (message.role === "assistant") stats.assistantMessages += 1;
    else if (message.role === "toolResult") stats.toolResults += 1;
    else continue;
    stats.totalMessages += 1;
    stats.toolCalls += countToolCalls(message);
    if (message.role === "assistant" && message.usage) {
      stats.inputTokens += usageValue(message.usage.input);
      stats.outputTokens += usageValue(message.usage.output);
      stats.cacheReadTokens += usageValue(message.usage.cacheRead);
      stats.cacheWriteTokens += usageValue(message.usage.cacheWrite);
      stats.totalTokens += usageValue(message.usage.totalTokens);
      stats.totalCost += usageValue(message.usage.cost?.total);
    }
  }
  if (stats.totalTokens === 0) {
    stats.totalTokens =
      stats.inputTokens +
      stats.outputTokens +
      stats.cacheReadTokens +
      stats.cacheWriteTokens;
  }
  return stats;
}

export function buildTelegramSessionHistoryItems(
  snapshot: TelegramSessionSnapshot,
): TelegramSessionHistoryItem[] {
  const items: TelegramSessionHistoryItem[] = [];
  snapshot.branch.forEach((entry) => {
    if (entry.type === "message") {
      const message = entry.message;
      if (!message) return;
      if (message.role === "user") {
        const detail = contentText(message.content) || "(empty user message)";
        items.push({
          entryId: entry.id,
          globalIndex: items.length + 1,
          timestamp: entry.timestamp,
          role: "user",
          title: "👤 User",
          summary: truncate(detail, TELEGRAM_SESSION_SUMMARY_LEN),
          detail,
          toolCallCount: 0,
        });
        return;
      }
      if (message.role === "assistant") {
        const text = contentText(message.content);
        if (!text) return;
        const toolCallCount = countToolCalls(message);
        items.push({
          entryId: entry.id,
          globalIndex: items.length + 1,
          timestamp: entry.timestamp,
          role: "assistant",
          title: "🤖 Assistant",
          summary: truncate(text, TELEGRAM_SESSION_SUMMARY_LEN),
          detail: text,
          toolCallCount,
          tokenOutput: message.usage?.output,
        });
        return;
      }
      return;
    }
    if (entry.type === "custom_message" && entry.display !== false) {
      const detail = contentText(entry.content) || `custom: ${entry.customType ?? "message"}`;
      items.push({
        entryId: entry.id,
        globalIndex: items.length + 1,
        timestamp: entry.timestamp,
        role: "custom",
        title: "🧩 Custom",
        summary: truncate(detail, TELEGRAM_SESSION_SUMMARY_LEN),
        detail,
        toolCallCount: 0,
      });
    }
  });
  return items;
}

function pageCount(total: number): number {
  return total <= 0 ? 1 : Math.ceil(total / TELEGRAM_SESSION_HISTORY_PAGE_SIZE);
}

function clampPage(page: number, total: number): number {
  const count = pageCount(total);
  if (!Number.isInteger(page) || page < 0) return 0;
  if (page >= count) return count - 1;
  return page;
}

function latestPage(total: number): number {
  return pageCount(total) - 1;
}

function pageSlice<T>(items: readonly T[], page: number): readonly T[] {
  const start = page * TELEGRAM_SESSION_HISTORY_PAGE_SIZE;
  return items.slice(start, start + TELEGRAM_SESSION_HISTORY_PAGE_SIZE);
}

function getGraphemes(text: string): string[] {
  if (TELEGRAM_SESSION_GRAPHEME_SEGMENTER) {
    return Array.from(
      TELEGRAM_SESSION_GRAPHEME_SEGMENTER.segment(text),
      (segment) => segment.segment,
    );
  }
  return Array.from(text);
}

function codePointWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (
    codePoint === 0 ||
    codePoint < 32 ||
    (codePoint >= 0x300 && codePoint <= 0x36f)
  ) {
    return 0;
  }
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6))
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(text: string): number {
  return getGraphemes(text).reduce(
    (sum, grapheme) =>
      sum + Array.from(grapheme).reduce((n, char) => n + codePointWidth(char), 0),
    0,
  );
}

function truncateDisplay(s: string, width: number): string {
  const clean = cleanText(s);
  if (displayWidth(clean) <= width) return clean;
  let result = "";
  let used = 0;
  for (const grapheme of getGraphemes(clean)) {
    const nextWidth = displayWidth(grapheme);
    if (used + nextWidth > Math.max(0, width - 1)) break;
    result += grapheme;
    used += nextWidth;
  }
  return `${result}…`;
}

function padRight(s: string, width: number): string {
  const padding = width - displayWidth(s);
  return padding > 0 ? s + " ".repeat(padding) : s;
}

function historyTableTextWidth(indexWidth: number): number {
  return Math.max(
    12,
    TELEGRAM_SESSION_HISTORY_TABLE_WIDTH -
      indexWidth -
      2 -
      TELEGRAM_SESSION_HISTORY_ROLE_WIDTH -
      1,
  );
}

function buildHistoryTable(items: readonly TelegramSessionHistoryItem[]): string {
  const maxIndex = Math.max(...items.map((item) => item.globalIndex), 1);
  const indexWidth = Math.max(1, String(maxIndex).length);
  const textWidth = historyTableTextWidth(indexWidth);
  const rows = [
    `<code>${escapeHtml(padRight("#", indexWidth))}</code> <code>${escapeHtml(padRight("role", TELEGRAM_SESSION_HISTORY_ROLE_WIDTH))}</code> msg`,
  ];
  for (const item of items) {
    rows.push(
      `<code>${escapeHtml(padRight(String(item.globalIndex), indexWidth))}</code> <code>${escapeHtml(padRight(item.role, TELEGRAM_SESSION_HISTORY_ROLE_WIDTH))}</code> ${escapeHtml(truncateDisplay(item.detail, textWidth) || "(empty)")}`,
    );
  }
  return rows.join("\n");
}

function buildLatestPreview(items: TelegramSessionHistoryItem[]): string {
  const latest = items
    .filter((item) => item.role !== "tool")
    .slice(-2)
    .map((item) => `${item.title}: ${escapeHtml(truncate(item.detail, 72))}`);
  if (latest.length === 0) return "Latest: <i>No chat messages yet.</i>";
  return ["Latest:", ...latest].join("\n");
}

export function buildTelegramSessionMainText(
  snapshot: TelegramSessionSnapshot,
): string {
  const stats = buildTelegramSessionStats(snapshot);
  const history = buildTelegramSessionHistoryItems(snapshot);
  const name = snapshot.sessionName?.trim();
  const lines = [
    "<b>🧭 Session</b>",
    "",
    `Name: ${name ? escapeHtml(name) : "<i>unset</i>"}`,
    `ID: <code>${escapeHtml(snapshot.sessionId)}</code>`,
    `File: <code>${escapeHtml(shortSessionFile(snapshot.sessionFile))}</code>`,
    "",
    `Msgs: ${stats.userMessages} user · ${stats.assistantMessages} assistant · ${stats.toolResults} tools`,
    `Tools: ${stats.toolCalls} calls`,
    `Ctx: ${escapeHtml(formatContextUsage(snapshot.contextUsage))}`,
    `Tokens: ${formatCount(stats.inputTokens)} in · ${formatCount(stats.outputTokens)} out · ${formatCount(stats.totalTokens)} total`,
  ];
  if (stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0) {
    lines.push(
      `Cache: ${formatCount(stats.cacheReadTokens)} read · ${formatCount(stats.cacheWriteTokens)} write`,
    );
  }
  if (stats.totalCost > 0) lines.push(`Cost: ${formatMoney(stats.totalCost)}`);
  if (stats.totalEntries !== stats.branchEntries) {
    lines.push(`Branch: ${stats.branchEntries}/${stats.totalEntries} entries`);
  }
  lines.push("", buildLatestPreview(history));
  return lines.join("\n");
}

export function buildTelegramSessionMainReplyMarkup(
  hasHistory: boolean,
): TelegramSessionReplyMarkup {
  const rows: TelegramSessionReplyMarkup["inline_keyboard"] = [];
  rows.push([
    {
      text: hasHistory ? "📜 History" : "📜 History (empty)",
      callback_data: hasHistory ? "session:history" : "session:noop",
    },
  ]);
  return { inline_keyboard: rows };
}

export function buildTelegramSessionHistoryText(
  snapshot: TelegramSessionSnapshot,
  page: number,
): string {
  const items = buildTelegramSessionHistoryItems(snapshot);
  if (items.length === 0) return "<b>📜 History</b>\n\nNo chat history yet.";
  const safePage = clampPage(page, items.length);
  const count = pageCount(items.length);
  const start = safePage * TELEGRAM_SESSION_HISTORY_PAGE_SIZE;
  const end = Math.min(items.length, start + TELEGRAM_SESSION_HISTORY_PAGE_SIZE);
  const stats = buildTelegramSessionStats(snapshot);
  const lines = [
    "<b>📜 History</b>",
    `Chat rows · ${start + 1}–${end} / ${items.length}`,
  ];
  if (stats.toolCalls > 0 || stats.toolResults > 0) {
    lines.push(`Tools hidden · ${stats.toolCalls} calls · ${stats.toolResults} results`);
  }
  lines.push("", buildHistoryTable(pageSlice(items, safePage)));
  if (count > 1) lines.push("", `Page ${safePage + 1}/${count}`);
  return lines.join("\n");
}

export function buildTelegramSessionHistoryReplyMarkup(
  snapshot: TelegramSessionSnapshot,
  page: number,
): TelegramSessionReplyMarkup {
  const items = buildTelegramSessionHistoryItems(snapshot);
  const safePage = clampPage(page, items.length);
  const rows: TelegramSessionReplyMarkup["inline_keyboard"] = [
    [{ text: "⬅️ Back to session", callback_data: "session:back:main" }],
  ];
  const count = pageCount(items.length);
  if (count > 1) {
    const prev = safePage - 1;
    const next = safePage + 1;
    rows.push([
      {
        text: prev >= 0 ? "⬅️ Older" : "·",
        callback_data: prev >= 0 ? `session:page:${prev}` : "session:noop",
      },
      { text: `${safePage + 1}/${count}`, callback_data: "session:noop" },
      {
        text: next < count ? "Newer ➡️" : "·",
        callback_data: next < count ? `session:page:${next}` : "session:noop",
      },
    ]);
  }
  return { inline_keyboard: rows };
}

export function buildTelegramSessionDetailText(
  item: TelegramSessionHistoryItem,
): string {
  const meta = [`Entry: <code>${escapeHtml(item.entryId)}</code>`];
  if (item.tokenOutput !== undefined) meta.push(`${formatCount(item.tokenOutput)} output tokens`);
  if (item.toolCallCount > 0) meta.push(`tools ×${item.toolCallCount}`);
  const rawDetail = item.detail || "(empty)";
  const truncated = rawDetail.length > TELEGRAM_SESSION_DETAIL_TEXT_LEN;
  const detail = truncated
    ? rawDetail.slice(0, TELEGRAM_SESSION_DETAIL_TEXT_LEN - 1) + "…"
    : rawDetail;
  return [
    `<b>${escapeHtml(item.title)}</b>`,
    meta.join(" · "),
    "",
    escapeHtml(detail),
    ...(truncated ? ["", "<i>Truncated. Use the session file for full content.</i>"] : []),
  ].join("\n");
}

export function buildTelegramSessionDetailReplyMarkup(
  snapshot: TelegramSessionSnapshot,
  detailIndex: number,
): TelegramSessionReplyMarkup {
  const items = buildTelegramSessionHistoryItems(snapshot);
  const rows: TelegramSessionReplyMarkup["inline_keyboard"] = [
    [{ text: "⬅️ History", callback_data: "session:back:history" }],
  ];
  rows.push([
    {
      text: detailIndex > 0 ? "⬅️ Prev" : "·",
      callback_data: detailIndex > 0 ? `session:turn:${detailIndex - 1}` : "session:noop",
    },
    {
      text: detailIndex + 1 < items.length ? "Next ➡️" : "·",
      callback_data:
        detailIndex + 1 < items.length
          ? `session:turn:${detailIndex + 1}`
          : "session:noop",
    },
  ]);
  return { inline_keyboard: rows };
}

function parseIndex(data: string, prefix: string, total: number): number | undefined {
  const raw = data.slice(prefix.length);
  const index = Number.parseInt(raw, 10);
  if (!Number.isInteger(index) || index < 0 || index >= total) return undefined;
  return index;
}

export interface TelegramSessionMenuOpenDeps {
  chatId: number;
  getSnapshot: () => TelegramSessionSnapshot;
  sendSessionMenu: (
    text: string,
    replyMarkup: TelegramSessionReplyMarkup,
  ) => Promise<number | undefined>;
  storeState: (state: TelegramSessionMenuState) => void;
  now?: () => number;
}

export async function openTelegramSessionMenu(
  deps: TelegramSessionMenuOpenDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const snapshot = deps.getSnapshot();
  const history = buildTelegramSessionHistoryItems(snapshot);
  const messageId = await deps.sendSessionMenu(
    buildTelegramSessionMainText(snapshot),
    buildTelegramSessionMainReplyMarkup(history.length > 0),
  );
  if (messageId === undefined) return;
  deps.storeState({
    chatId: deps.chatId,
    messageId,
    view: "main",
    page: latestPage(history.length),
    updatedAt: now(),
  });
}

export interface TelegramSessionMenuCallbackQuery {
  id: string;
  data?: string;
  message?: { chat?: { id?: number }; message_id?: number };
}

export interface TelegramSessionMenuCallbackDeps {
  getState: (messageId: number | undefined) => TelegramSessionMenuState | undefined;
  setState: (state: TelegramSessionMenuState) => void;
  getSnapshot: () => TelegramSessionSnapshot;
  editSessionMessage: (
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup: TelegramSessionReplyMarkup,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  now?: () => number;
}

async function handleTelegramSessionMenuCallbackUnsafe(
  query: TelegramSessionMenuCallbackQuery,
  deps: TelegramSessionMenuCallbackDeps,
): Promise<boolean> {
  const data = query.data;
  if (!data?.startsWith("session:")) return false;
  if (data === "session:noop") {
    await deps.answerCallbackQuery(query.id);
    return true;
  }
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (typeof chatId !== "number" || typeof messageId !== "number") {
    await deps.answerCallbackQuery(query.id);
    return true;
  }
  const state = deps.getState(messageId);
  if (!state) {
    await deps.answerCallbackQuery(query.id, "Session menu expired.");
    return true;
  }
  const now = deps.now ?? Date.now;
  const snapshot = deps.getSnapshot();
  const history = buildTelegramSessionHistoryItems(snapshot);
  const updateState = (next: Partial<TelegramSessionMenuState>) => {
    deps.setState({ ...state, ...next, updatedAt: now() });
  };

  if (data === "session:refresh" || data === "session:back:main") {
    await deps.answerCallbackQuery(query.id, data === "session:refresh" ? "Refreshed." : undefined);
    await deps.editSessionMessage(
      chatId,
      messageId,
      buildTelegramSessionMainText(snapshot),
      buildTelegramSessionMainReplyMarkup(history.length > 0),
    );
    updateState({ view: "main", page: latestPage(history.length), detailIndex: undefined });
    return true;
  }

  if (data === "session:history" || data === "session:back:history") {
    if (history.length === 0) {
      await deps.answerCallbackQuery(query.id, "No history yet.");
      return true;
    }
    const page = clampPage(state.page, history.length);
    await deps.answerCallbackQuery(query.id);
    await deps.editSessionMessage(
      chatId,
      messageId,
      buildTelegramSessionHistoryText(snapshot, page),
      buildTelegramSessionHistoryReplyMarkup(snapshot, page),
    );
    updateState({ view: "history", page, detailIndex: undefined });
    return true;
  }

  if (data.startsWith("session:page:")) {
    if (history.length === 0) {
      await deps.answerCallbackQuery(query.id, "No history yet.");
      return true;
    }
    const requested = Number.parseInt(data.slice("session:page:".length), 10);
    const page = clampPage(requested, history.length);
    await deps.answerCallbackQuery(query.id);
    await deps.editSessionMessage(
      chatId,
      messageId,
      buildTelegramSessionHistoryText(snapshot, page),
      buildTelegramSessionHistoryReplyMarkup(snapshot, page),
    );
    updateState({ view: "history", page, detailIndex: undefined });
    return true;
  }

  if (data.startsWith("session:turn:")) {
    const index = parseIndex(data, "session:turn:", history.length);
    if (index === undefined) {
      await deps.answerCallbackQuery(query.id, "Message no longer exists.");
      return true;
    }
    const item = history[index];
    await deps.answerCallbackQuery(query.id);
    await deps.editSessionMessage(
      chatId,
      messageId,
      buildTelegramSessionDetailText(item),
      buildTelegramSessionDetailReplyMarkup(snapshot, index),
    );
    updateState({
      view: "detail",
      detailIndex: index,
      page: clampPage(Math.floor(index / TELEGRAM_SESSION_HISTORY_PAGE_SIZE), history.length),
    });
    return true;
  }

  await deps.answerCallbackQuery(query.id);
  return true;
}

export async function handleTelegramSessionMenuCallback(
  query: TelegramSessionMenuCallbackQuery,
  deps: TelegramSessionMenuCallbackDeps,
): Promise<boolean> {
  if (!query.data?.startsWith("session:")) return false;
  let answered = false;
  const safeDeps: TelegramSessionMenuCallbackDeps = {
    ...deps,
    answerCallbackQuery: async (callbackQueryId, text) => {
      await deps.answerCallbackQuery(callbackQueryId, text);
      answered = true;
    },
  };
  try {
    return await handleTelegramSessionMenuCallbackUnsafe(query, safeDeps);
  } catch {
    if (!answered) {
      try {
        await deps.answerCallbackQuery(
          query.id,
          "Session menu update failed. Try /session.",
        );
      } catch {
        // Keep polling alive even if the callback query has already expired.
      }
    }
    return true;
  }
}

export interface TelegramSessionMenuRuntime<TContext> {
  openSessionMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  handleCallbackQuery: (
    query: TelegramSessionMenuCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
}

export interface TelegramSessionMenuRuntimeDeps<TContext> {
  getSnapshot: (ctx: TContext) => TelegramSessionSnapshot;
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "html",
    replyMarkup: TelegramSessionReplyMarkup,
  ) => Promise<number | undefined>;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "html",
    replyMarkup: TelegramSessionReplyMarkup,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  store?: TelegramSessionMenuStore;
}

export function createTelegramSessionMenuRuntime<TContext>(
  deps: TelegramSessionMenuRuntimeDeps<TContext>,
): TelegramSessionMenuRuntime<TContext> {
  const store = deps.store ?? createTelegramSessionMenuStore();
  return {
    openSessionMenu(chatId, _replyToMessageId, ctx) {
      return openTelegramSessionMenu({
        chatId,
        getSnapshot: () => deps.getSnapshot(ctx),
        sendSessionMenu: (text, replyMarkup) =>
          deps.sendInteractiveMessage(chatId, text, "html", replyMarkup),
        storeState: store.set,
      });
    },
    handleCallbackQuery(query, ctx) {
      return handleTelegramSessionMenuCallback(query, {
        getState: store.get,
        setState: store.set,
        getSnapshot: () => deps.getSnapshot(ctx),
        editSessionMessage: (chatId, messageId, text, replyMarkup) =>
          deps.editInteractiveMessage(chatId, messageId, text, "html", replyMarkup),
        answerCallbackQuery: deps.answerCallbackQuery,
      });
    },
  };
}
