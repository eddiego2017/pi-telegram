/**
 * Telegram resume menu UI helpers
 * Zones: telegram ui, session resume, menu composition
 * Owns the /resume inline keyboard, session-list cache, and callback dispatching;
 * actual session switching happens via tmux-injected `/telegram-resume-exec <path>`
 * (see lib/pi.ts createTmuxDynamicSlashCommandInjector + index.ts wiring).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";

import {
  type SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";

export const TELEGRAM_RESUME_MENU_PAGE_SIZE = 20;
export const TELEGRAM_RESUME_MENU_MAX_ITEMS = 200;
const TELEGRAM_RESUME_MENU_STATE_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_RESUME_MENU_SUMMARY_LEN = 48;
const TELEGRAM_RESUME_MENU_LINE_WIDTH = 37;
const TELEGRAM_RESUME_MENU_BUTTON_COLUMNS = 4;
const TELEGRAM_RESUME_MENU_PAGE_MARKERS = [
  "①\uFE0E",
  "②\uFE0E",
  "③\uFE0E",
  "④\uFE0E",
  "⑤\uFE0E",
  "⑥\uFE0E",
  "⑦\uFE0E",
  "⑧\uFE0E",
  "⑨\uFE0E",
  "⑩\uFE0E",
  "⑪\uFE0E",
  "⑫\uFE0E",
  "⑬\uFE0E",
  "⑭\uFE0E",
  "⑮\uFE0E",
  "⑯\uFE0E",
  "⑰\uFE0E",
  "⑱\uFE0E",
  "⑲\uFE0E",
  "⑳\uFE0E",
];

const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

export type TelegramResumeMenuReplyMarkup = TelegramInlineKeyboardMarkup;
export type TelegramResumeMenuMode = "open" | "delete";
export type TelegramResumeMenuDeleteStyle = "multi" | "single";
export type TelegramResumeMenuSource = "resume" | "delete";
export type TelegramResumeDeleteMethod = "trash" | "unlink";

export interface TelegramResumeDeleteResult {
  method: TelegramResumeDeleteMethod;
}

export interface TelegramResumeMenuEntry {
  /** global index in the menu state's `sessions` array (stable across pagination) */
  index: number;
  path: string;
  sessionId: string;
  name?: string;
  firstMessage: string;
  messageCount: number;
  /** Count of inactive leaf branches in the session tree. Hidden when zero/undefined. */
  inactiveBranchCount?: number;
  modified: Date;
}

export interface TelegramResumeFilterTraceItem {
  filter: string;
  before: number;
  after: number;
}

export interface TelegramResumeMenuState {
  chatId: number;
  messageId: number;
  /** Full session list cached at menu open; pagination slices this in-memory. */
  sessions: TelegramResumeMenuEntry[];
  /** Zero-based current page index. */
  page: number;
  /** Path of the session that was active when the menu opened, filtered out. */
  currentSessionFile: string | undefined;
  /** Current list mode; old cached states without this field default to open. */
  mode?: TelegramResumeMenuMode;
  /** Delete picker style; `/resume` and `/delete` use multi-select by default. */
  deleteStyle?: TelegramResumeMenuDeleteStyle;
  /** Entry command that opened the menu; controls Back vs Cancel affordances. */
  source?: TelegramResumeMenuSource;
  /** Session file paths selected in delete mode. */
  selectedDeletePaths?: string[];
  /** Ordered filters applied when this menu opened. */
  filters?: string[];
  /** Per-filter before/after counts for rendering the filtered menu header. */
  filterTrace?: TelegramResumeFilterTraceItem[];
  updatedAt: number;
}

export interface StoredTelegramResumeMenuState {
  state: TelegramResumeMenuState;
}

export interface TelegramResumeMenuStore {
  get(messageId: number | undefined): TelegramResumeMenuState | undefined;
  set(state: TelegramResumeMenuState): void;
  clear(): void;
}

export function createTelegramResumeMenuStore(now: () => number = Date.now): TelegramResumeMenuStore {
  const states = new Map<number, StoredTelegramResumeMenuState>();
  function pruneExpired(): void {
    const cutoff = now() - TELEGRAM_RESUME_MENU_STATE_TTL_MS;
    for (const [messageId, stored] of states.entries()) {
      if (stored.state.updatedAt < cutoff) {
        states.delete(messageId);
      }
    }
  }
  return {
    get(messageId) {
      if (typeof messageId !== "number") return undefined;
      pruneExpired();
      return states.get(messageId)?.state;
    },
    set(state) {
      pruneExpired();
      states.set(state.messageId, { state });
    },
    clear() {
      states.clear();
    },
  };
}

function cleanText(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function normalizeTelegramResumeFilterText(s: string): string {
  return cleanText(s.normalize("NFKC")).toLowerCase();
}

export function parseTelegramResumeFilterTokens(args: string): string[] {
  return args
    .split(/\s+/)
    .map((token) => cleanText(token))
    .filter((token) => normalizeTelegramResumeFilterText(token).length > 0);
}

function buildTelegramResumeEntrySearchText(entry: TelegramResumeMenuEntry): string {
  return normalizeTelegramResumeFilterText(
    [entry.name, entry.firstMessage].filter(Boolean).join("\n"),
  );
}

export function filterTelegramResumeMenuEntries(
  entries: TelegramResumeMenuEntry[],
  filters: readonly string[],
): { entries: TelegramResumeMenuEntry[]; trace: TelegramResumeFilterTraceItem[] } {
  let filtered = entries;
  const trace: TelegramResumeFilterTraceItem[] = [];
  for (const rawFilter of filters) {
    const normalizedFilter = normalizeTelegramResumeFilterText(rawFilter);
    if (!normalizedFilter) continue;
    const before = filtered.length;
    filtered = filtered.filter((entry) =>
      buildTelegramResumeEntrySearchText(entry).includes(normalizedFilter)
    );
    trace.push({ filter: cleanText(rawFilter), before, after: filtered.length });
  }
  return { entries: filtered, trace };
}

function getGraphemes(text: string): string[] {
  if (!graphemeSegmenter) return Array.from(text);
  return [...graphemeSegmenter.segment(text)].map((segment) => segment.segment);
}

function codePointWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (
    codePoint === 0 ||
    codePoint < 32 ||
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
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

function truncateSummary(s: string, n: number): string {
  const clean = cleanText(s);
  return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
}

function formatAgo(d: Date, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - d.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function formatTelegramResumePageMarker(pageIndex: number): string {
  return TELEGRAM_RESUME_MENU_PAGE_MARKERS[pageIndex] ?? String(pageIndex + 1);
}

function formatTelegramResumeMeta(
  entry: TelegramResumeMenuEntry,
  nowMs: number,
): string {
  const parts = [`${formatAgo(entry.modified, nowMs)}`, `${entry.messageCount}msg`];
  if ((entry.inactiveBranchCount ?? 0) > 0) {
    parts.push(`🌿${entry.inactiveBranchCount}`);
  }
  return parts.join(" · ");
}

function formatTelegramResumeLine(
  entry: TelegramResumeMenuEntry,
  pageIndex: number,
  nowMs: number,
  mode: TelegramResumeMenuMode,
  selected: boolean,
  deleteStyle: TelegramResumeMenuDeleteStyle,
): string {
  const marker = formatTelegramResumePageMarker(pageIndex);
  const selectedPrefix = mode === "delete" && deleteStyle === "multi" ? `${selected ? "☑" : "☐"} ` : "";
  const meta = formatTelegramResumeMeta(entry, nowMs);
  const summary = truncateDisplay(
    entry.name || entry.firstMessage || "(no preview)",
    TELEGRAM_RESUME_MENU_LINE_WIDTH,
  );
  return `${escapeHtml(selectedPrefix)}${escapeHtml(marker)} <code>${escapeHtml(meta)}</code>\n${escapeHtml(summary)}`;
}

function formatTelegramResumeButtonText(
  pageIndex: number,
  mode: TelegramResumeMenuMode,
  selected: boolean,
  deleteStyle: TelegramResumeMenuDeleteStyle,
): string {
  const index = String(pageIndex + 1);
  return mode === "delete" && deleteStyle === "multi"
    ? `${selected ? "☑" : "☐"}${index}`
    : index;
}

export const TELEGRAM_RESUME_MENU_TITLE = "<b>📂 Resume session</b>";
export const TELEGRAM_DELETE_MENU_TITLE = "<b>🗑 Delete session</b>";

function getTelegramResumeMenuTitle(mode: TelegramResumeMenuMode): string {
  return mode === "delete" ? TELEGRAM_DELETE_MENU_TITLE : TELEGRAM_RESUME_MENU_TITLE;
}

export function getTelegramResumeMenuPageCount(total: number): number {
  if (total <= 0) return 1;
  return Math.ceil(total / TELEGRAM_RESUME_MENU_PAGE_SIZE);
}

export function clampTelegramResumeMenuPage(
  page: number,
  total: number,
): number {
  const pageCount = getTelegramResumeMenuPageCount(total);
  if (!Number.isInteger(page) || page < 0) return 0;
  if (page >= pageCount) return pageCount - 1;
  return page;
}

export function sliceTelegramResumeMenuPage(
  entries: TelegramResumeMenuEntry[],
  page: number,
): TelegramResumeMenuEntry[] {
  const start = page * TELEGRAM_RESUME_MENU_PAGE_SIZE;
  return entries.slice(start, start + TELEGRAM_RESUME_MENU_PAGE_SIZE);
}

function formatTelegramResumeFilterChip(filter: string): string {
  return escapeHtml(truncateDisplay(filter, 14));
}

function formatTelegramResumeFilterSummary(
  trace: readonly TelegramResumeFilterTraceItem[],
): string | undefined {
  if (trace.length === 0) return undefined;
  return `🔎 ${trace.map((item) => formatTelegramResumeFilterChip(item.filter)).join(" → ")}`;
}

function formatTelegramResumeFilterTrace(
  trace: readonly TelegramResumeFilterTraceItem[],
): string[] {
  if (trace.length === 0) return [];
  return [
    "Filters:",
    ...trace.map((item) =>
      `${formatTelegramResumeFilterChip(item.filter)} ${item.before}→${item.after}`
    ),
  ];
}

export function buildTelegramResumeMenuText(
  entries: TelegramResumeMenuEntry[],
  cwd: string,
  page = 0,
  mode: TelegramResumeMenuMode = "open",
  nowMs: number = Date.now(),
  selectedDeletePaths: string[] = [],
  deleteStyle: TelegramResumeMenuDeleteStyle = "multi",
  filterTrace: readonly TelegramResumeFilterTraceItem[] = [],
): string {
  const title = getTelegramResumeMenuTitle(mode);
  const filterSummary = mode === "open" ? formatTelegramResumeFilterSummary(filterTrace) : undefined;
  if (entries.length === 0) {
    if (filterTrace.length > 0) {
      return [
        title,
        ...(filterSummary ? [filterSummary] : []),
        "No match",
        "",
        ...formatTelegramResumeFilterTrace(filterTrace),
        "",
        `<code>${escapeHtml(cwd)}</code>`,
      ].join("\n");
    }
    return `${title}\n\nNo other sessions for <code>${escapeHtml(cwd)}</code>.`;
  }
  const pageCount = getTelegramResumeMenuPageCount(entries.length);
  const safePage = clampTelegramResumeMenuPage(page, entries.length);
  const pageLine =
    pageCount > 1
      ? `Page ${safePage + 1}/${pageCount} · ${entries.length} sessions`
      : undefined;
  const prompt =
    mode === "delete"
      ? deleteStyle === "single"
        ? "Pick a session to delete:"
        : "Select sessions to delete:"
      : "Pick a session to switch to:";
  const pageEntries = sliceTelegramResumeMenuPage(entries, safePage);
  const selectedPaths = new Set(selectedDeletePaths);
  const lines = pageEntries.map((entry, pageIndex) =>
    formatTelegramResumeLine(
      entry,
      pageIndex,
      nowMs,
      mode,
      selectedPaths.has(entry.path),
      deleteStyle,
    ),
  );
  return [
    title,
    ...(filterSummary ? [filterSummary] : []),
    ...(pageLine ? [pageLine] : []),
    "",
    `<code>${escapeHtml(cwd)}</code>`,
    prompt,
    "",
    ...lines,
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildTelegramResumeMenuReplyMarkup(
  entries: TelegramResumeMenuEntry[],
  nowMs: number = Date.now(),
  page = 0,
  mode: TelegramResumeMenuMode = "open",
  selectedDeletePaths: string[] = [],
  deleteStyle: TelegramResumeMenuDeleteStyle = "multi",
  source?: TelegramResumeMenuSource,
): TelegramResumeMenuReplyMarkup {
  const effectiveSource = source ?? (mode === "delete" ? "delete" : "resume");
  const isDeleteMenu = mode === "delete" && effectiveSource === "delete";
  const callbackPrefix = isDeleteMenu ? "delete" : "resume";
  const selectedPaths = new Set(selectedDeletePaths);
  const selectedCount = entries.filter((entry) => selectedPaths.has(entry.path)).length;
  const rows: TelegramResumeMenuReplyMarkup["inline_keyboard"] = [];
  const pageCount = getTelegramResumeMenuPageCount(entries.length);
  const safePage = clampTelegramResumeMenuPage(page, entries.length);
  const pageEntries = sliceTelegramResumeMenuPage(entries, safePage);
  if (entries.length > 0 && isDeleteMenu && deleteStyle === "multi") {
    if (selectedCount > 0) {
      rows.push([
        {
          text: `🗑 Delete ${selectedCount} selected`,
          callback_data: "delete:delete-selected",
        },
      ]);
      rows.push([
        { text: "Select page", callback_data: "delete:select-page" },
        { text: "Clear selection", callback_data: "delete:clear-selected" },
      ]);
    } else {
      rows.push([{ text: "Select page", callback_data: "delete:select-page" }]);
    }
  }
  const buttonRow: TelegramResumeMenuReplyMarkup["inline_keyboard"][number] = [];
  for (const [pageIndex, entry] of pageEntries.entries()) {
    const selected = selectedPaths.has(entry.path);
    buttonRow.push({
      text: formatTelegramResumeButtonText(pageIndex, mode, selected, deleteStyle),
      callback_data:
        isDeleteMenu
          ? deleteStyle === "single"
            ? `delete:delete:${entry.index}`
            : `delete:select:${entry.index}`
          : `resume:open:${entry.index}`,
    });
    if (buttonRow.length === TELEGRAM_RESUME_MENU_BUTTON_COLUMNS) {
      rows.push([...buttonRow]);
      buttonRow.length = 0;
    }
  }
  if (buttonRow.length > 0) rows.push(buttonRow);
  if (entries.length === 0) {
    rows.push([{ text: "(no sessions)", callback_data: `${callbackPrefix}:noop` }]);
  }
  if (isDeleteMenu) {
    rows.push([{ text: "Cancel", callback_data: "delete:cancel-menu" }]);
  }
  if (pageCount > 1) {
    const prevPage = safePage - 1;
    const nextPage = safePage + 1;
    rows.push([
      {
        text: prevPage >= 0 ? "⬅️ Prev" : "·",
        callback_data:
          prevPage >= 0 ? `${callbackPrefix}:page:${prevPage}` : `${callbackPrefix}:noop`,
      },
      {
        text: `${safePage + 1}/${pageCount}`,
        callback_data: `${callbackPrefix}:noop`,
      },
      {
        text: nextPage < pageCount ? "Next ➡️" : "·",
        callback_data:
          nextPage < pageCount ? `${callbackPrefix}:page:${nextPage}` : `${callbackPrefix}:noop`,
      },
    ]);
  }
  return { inline_keyboard: rows };
}

function reindexTelegramResumeMenuEntries(
  entries: TelegramResumeMenuEntry[],
): TelegramResumeMenuEntry[] {
  return entries.map((entry, index) => ({ ...entry, index }));
}

function buildResumeMenuEntries(
  sessions: SessionInfo[],
  currentSessionFile: string | undefined,
  maxItems: number | null = TELEGRAM_RESUME_MENU_MAX_ITEMS,
): TelegramResumeMenuEntry[] {
  const filtered = sessions.filter((s) => s.path !== currentSessionFile);
  const limited = maxItems === null ? filtered : filtered.slice(0, maxItems);
  return limited.map((s, index) => ({
    index,
    path: s.path,
    sessionId: s.id,
    name: s.name,
    firstMessage: s.firstMessage,
    messageCount: s.messageCount,
    modified: s.modified,
  }));
}

interface TelegramResumeTreeEntry {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
}

interface TelegramResumeSessionEntry extends TelegramResumeTreeEntry {
  message?: unknown;
}

interface TelegramResumeSessionMessage {
  role?: unknown;
  content?: unknown;
}

interface TelegramResumeSessionContentBlock {
  type?: unknown;
  text?: unknown;
}

interface TelegramResumeSessionFileStats {
  inactiveBranchCount: number;
  visibleMessageCount: number;
}

function isTelegramResumeObject(entry: unknown): entry is Record<string, unknown> {
  return typeof entry === "object" && entry !== null;
}

function isTelegramResumeTreeEntry(entry: unknown): entry is TelegramResumeTreeEntry {
  return isTelegramResumeObject(entry);
}

function isTelegramResumeSessionEntry(entry: unknown): entry is TelegramResumeSessionEntry {
  return isTelegramResumeObject(entry);
}

function isTelegramResumeSessionMessage(
  message: unknown,
): message is TelegramResumeSessionMessage {
  return isTelegramResumeObject(message);
}

function hasTelegramResumeVisibleText(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block): block is TelegramResumeSessionContentBlock =>
    isTelegramResumeObject(block) &&
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.trim().length > 0
  );
}

export function countTelegramResumeVisibleMessages(
  fileEntries: unknown[],
): number {
  return fileEntries.filter((entry) => {
    if (!isTelegramResumeSessionEntry(entry) || entry.type !== "message") {
      return false;
    }
    if (!isTelegramResumeSessionMessage(entry.message)) return false;
    if (entry.message.role === "user") return true;
    if (entry.message.role !== "assistant") return false;
    return hasTelegramResumeVisibleText(entry.message.content);
  }).length;
}

export function countTelegramResumeInactiveBranchLeaves(
  fileEntries: unknown[],
): number {
  const entries = fileEntries.filter((entry): entry is TelegramResumeTreeEntry =>
    isTelegramResumeTreeEntry(entry) &&
    entry.type !== "session" &&
    typeof entry.id === "string" &&
    Object.hasOwn(entry, "parentId")
  );
  if (entries.length <= 1) return 0;

  const childIds = new Set<string>();
  let leafId: string | undefined;
  for (const entry of entries) {
    leafId = entry.id as string;
    if (typeof entry.parentId === "string" && entry.parentId.length > 0) {
      childIds.add(entry.parentId);
    }
  }
  if (!leafId) return 0;

  return entries.filter((entry) =>
    typeof entry.id === "string" &&
    entry.id !== leafId &&
    !childIds.has(entry.id)
  ).length;
}

async function readTelegramResumeSessionFileStats(
  sessionPath: string,
): Promise<TelegramResumeSessionFileStats | undefined> {
  try {
    const content = await readFile(sessionPath, "utf8");
    const fileEntries: unknown[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        fileEntries.push(JSON.parse(line));
      } catch {
        // Ignore malformed lines, matching pi core session-list behavior.
      }
    }
    return {
      inactiveBranchCount: countTelegramResumeInactiveBranchLeaves(fileEntries),
      visibleMessageCount: countTelegramResumeVisibleMessages(fileEntries),
    };
  } catch {
    return undefined;
  }
}

async function addResumeMenuFileStats(
  entries: TelegramResumeMenuEntry[],
): Promise<TelegramResumeMenuEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      const stats = await readTelegramResumeSessionFileStats(entry.path);
      return {
        ...entry,
        messageCount: stats?.visibleMessageCount ?? entry.messageCount,
        inactiveBranchCount: stats?.inactiveBranchCount,
      };
    }),
  );
}

function buildTelegramResumeDeleteConfirmationText(
  entries: TelegramResumeMenuEntry[],
): string {
  const shown = entries.slice(0, 5).map((entry) => {
    const headline = truncateSummary(
      entry.name || entry.firstMessage || entry.sessionId,
      TELEGRAM_RESUME_MENU_SUMMARY_LEN,
    );
    return `• <code>${escapeHtml(headline)}</code>`;
  });
  const more = entries.length > shown.length ? `\n• …and ${entries.length - shown.length} more` : "";
  return `${TELEGRAM_DELETE_MENU_TITLE}\n\nDelete ${entries.length} selected session${entries.length === 1 ? "" : "s"}?\n\n${shown.join("\n")}${more}`;
}

function buildTelegramSingleDeleteConfirmationText(
  entry: TelegramResumeMenuEntry,
  cwd: string,
  nowMs: number,
): string {
  const headline = truncateSummary(
    entry.name || entry.firstMessage || entry.sessionId,
    TELEGRAM_RESUME_MENU_SUMMARY_LEN,
  );
  return [
    TELEGRAM_DELETE_MENU_TITLE,
    "",
    "Delete this session?",
    "",
    `<code>${escapeHtml(headline)}</code>`,
    `${entry.messageCount} msg · modified ${formatAgo(entry.modified, nowMs)} ago`,
    `cwd: <code>${escapeHtml(cwd)}</code>`,
    "",
    "This cannot be undone here.",
  ].join("\n");
}

function buildTelegramResumeDeleteConfirmationReplyMarkup(): TelegramResumeMenuReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: "❌ No", callback_data: "delete:cancel-delete" },
        {
          text: "🗑 Yes, delete",
          callback_data: "delete:confirm-delete-selected",
        },
      ],
    ],
  };
}

function buildTelegramSingleDeleteConfirmationReplyMarkup(
  entryIndex: number,
): TelegramResumeMenuReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "🗑 Delete", callback_data: `delete:confirm-delete:${entryIndex}` }],
      [
        { text: "⬅️ Back", callback_data: "delete:cancel-delete" },
        { text: "Cancel", callback_data: "delete:cancel-menu" },
      ],
    ],
  };
}

function buildTelegramSingleDeleteSuccessText(
  entry: TelegramResumeMenuEntry,
  result: TelegramResumeDeleteResult | void,
): string {
  const headline = truncateSummary(
    entry.name || entry.firstMessage || entry.sessionId,
    TELEGRAM_RESUME_MENU_SUMMARY_LEN,
  );
  const status = result?.method === "trash" ? "Session moved to trash." : "Session deleted.";
  return `${TELEGRAM_DELETE_MENU_TITLE}\n\n${status}\n\n<code>${escapeHtml(headline)}</code>`;
}

function buildTelegramSingleDeleteSuccessReplyMarkup(): TelegramResumeMenuReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "🗑 Delete another", callback_data: "delete:delete-another" }],
    ],
  };
}

function buildTelegramResumeCancelText(): string {
  return `${TELEGRAM_DELETE_MENU_TITLE}\n\nDelete cancelled.`;
}

function parseTelegramResumeMenuIndex(
  data: string,
  prefix: string,
  total: number,
): number | undefined {
  const indexStr = data.slice(prefix.length);
  const index = Number.parseInt(indexStr, 10);
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    return undefined;
  }
  return index;
}

export interface TelegramResumeMenuOpenDeps {
  getCwd: () => string;
  getCurrentSessionFile: () => string | undefined;
  listSessions: (cwd: string) => Promise<SessionInfo[]>;
  sendResumeMenu: (
    text: string,
    replyMarkup: TelegramResumeMenuReplyMarkup,
  ) => Promise<number | undefined>;
  storeState: (state: TelegramResumeMenuState) => void;
  chatId: number;
  mode?: TelegramResumeMenuMode;
  deleteStyle?: TelegramResumeMenuDeleteStyle;
  source?: TelegramResumeMenuSource;
  filters?: readonly string[];
  now?: () => number;
}

export async function openTelegramResumeMenu(
  deps: TelegramResumeMenuOpenDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const cwd = deps.getCwd();
  const currentSessionFile = deps.getCurrentSessionFile();
  const sessions = await deps.listSessions(cwd);
  const mode = deps.mode ?? "open";
  const filters = mode === "open" ? [...(deps.filters ?? [])] : [];
  const unfilteredEntries = buildResumeMenuEntries(
    sessions,
    currentSessionFile,
    filters.length > 0 ? null : TELEGRAM_RESUME_MENU_MAX_ITEMS,
  );
  const filterResult = filterTelegramResumeMenuEntries(unfilteredEntries, filters);
  const limitedEntries = reindexTelegramResumeMenuEntries(
    filterResult.entries.slice(0, TELEGRAM_RESUME_MENU_MAX_ITEMS),
  );
  const entries = await addResumeMenuFileStats(limitedEntries);
  const page = 0;
  const nowMs = now();
  const deleteStyle = deps.deleteStyle ?? "multi";
  const source = deps.source ?? "resume";
  const text = buildTelegramResumeMenuText(
    entries,
    cwd,
    page,
    mode,
    nowMs,
    [],
    deleteStyle,
    filterResult.trace,
  );
  const replyMarkup = buildTelegramResumeMenuReplyMarkup(
    entries,
    nowMs,
    page,
    mode,
    [],
    deleteStyle,
    source,
  );
  const messageId = await deps.sendResumeMenu(text, replyMarkup);
  if (messageId === undefined) return;
  deps.storeState({
    chatId: deps.chatId,
    messageId,
    sessions: entries,
    page,
    currentSessionFile,
    mode,
    deleteStyle,
    source,
    selectedDeletePaths: [],
    filters,
    filterTrace: filterResult.trace,
    updatedAt: now(),
  });
}

export interface TelegramResumeMenuCallbackDeps {
  getState: (messageId: number | undefined) => TelegramResumeMenuState | undefined;
  setState: (state: TelegramResumeMenuState) => void;
  getCwd: () => string;
  getCurrentSessionFile: () => string | undefined;
  editResumeMessage: (
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup: TelegramResumeMenuReplyMarkup,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  injectResumeExec: (sessionPath: string) => Promise<void>;
  deleteSessionFile: (sessionPath: string) => Promise<void | TelegramResumeDeleteResult>;
  now?: () => number;
}

export interface TelegramResumeMenuCallbackQuery {
  id: string;
  data?: string;
  message?: { chat?: { id?: number }; message_id?: number };
}

export async function handleTelegramResumeMenuCallback(
  query: TelegramResumeMenuCallbackQuery,
  deps: TelegramResumeMenuCallbackDeps,
): Promise<boolean> {
  const data = query.data;
  const callbackPrefix = data?.startsWith("delete:")
    ? "delete"
    : data?.startsWith("resume:")
      ? "resume"
      : undefined;
  if (!data || !callbackPrefix) return false;
  const prefix = `${callbackPrefix}:`;
  const isDeleteCallback = callbackPrefix === "delete";
  if (data === `${prefix}noop`) {
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
    await deps.answerCallbackQuery(query.id, isDeleteCallback ? "Delete menu expired." : "Resume menu expired.");
    return true;
  }
  if (isDeleteCallback && state.source !== "delete") {
    await deps.answerCallbackQuery(query.id, "Delete menu expired.");
    return true;
  }
  const now = deps.now ?? Date.now;
  if (data.startsWith(`${prefix}page:`)) {
    const pageStr = data.slice(`${prefix}page:`.length);
    const requested = Number.parseInt(pageStr, 10);
    if (!Number.isInteger(requested)) {
      await deps.answerCallbackQuery(query.id, "Invalid page.");
      return true;
    }
    const nextPage = clampTelegramResumeMenuPage(
      requested,
      state.sessions.length,
    );
    if (nextPage === state.page) {
      await deps.answerCallbackQuery(query.id);
      return true;
    }
    const cwd = deps.getCwd();
    const mode = state.mode ?? "open";
    const deleteStyle = state.deleteStyle ?? "multi";
    const source = state.source ?? "resume";
    const selectedDeletePaths = state.selectedDeletePaths ?? [];
    const nowMs = now();
    const text = buildTelegramResumeMenuText(
      state.sessions,
      cwd,
      nextPage,
      mode,
      nowMs,
      selectedDeletePaths,
      deleteStyle,
      state.filterTrace ?? [],
    );
    const replyMarkup = buildTelegramResumeMenuReplyMarkup(
      state.sessions,
      nowMs,
      nextPage,
      mode,
      selectedDeletePaths,
      deleteStyle,
      source,
    );
    await deps.editResumeMessage(chatId, messageId, text, replyMarkup);
    deps.setState({
      ...state,
      page: nextPage,
      mode,
      deleteStyle,
      source,
      selectedDeletePaths,
      updatedAt: nowMs,
    });
    await deps.answerCallbackQuery(query.id);
    return true;
  }
  if (data === `${prefix}cancel-menu`) {
    await deps.editResumeMessage(chatId, messageId, buildTelegramResumeCancelText(), {
      inline_keyboard: [],
    });
    deps.setState({ ...state, updatedAt: now() });
    await deps.answerCallbackQuery(query.id, "Cancelled.");
    return true;
  }
  if (data === "delete:delete-another") {
    const cwd = deps.getCwd();
    const page = clampTelegramResumeMenuPage(state.page, state.sessions.length);
    const mode: TelegramResumeMenuMode = "delete";
    const deleteStyle: TelegramResumeMenuDeleteStyle = "single";
    const source = state.source ?? "delete";
    const nowMs = now();
    const text = buildTelegramResumeMenuText(
      state.sessions,
      cwd,
      page,
      mode,
      nowMs,
      [],
      deleteStyle,
    );
    const replyMarkup = buildTelegramResumeMenuReplyMarkup(
      state.sessions,
      nowMs,
      page,
      mode,
      [],
      deleteStyle,
      source,
    );
    await deps.editResumeMessage(chatId, messageId, text, replyMarkup);
    deps.setState({ ...state, page, mode, deleteStyle, source, selectedDeletePaths: [], updatedAt: nowMs });
    await deps.answerCallbackQuery(query.id);
    return true;
  }
  if (data === "delete:cancel-delete") {
    const cwd = deps.getCwd();
    const page = clampTelegramResumeMenuPage(state.page, state.sessions.length);
    const mode = state.mode ?? "delete";
    const deleteStyle = state.deleteStyle ?? "multi";
    const source = state.source ?? "resume";
    const selectedDeletePaths = state.selectedDeletePaths ?? [];
    const nowMs = now();
    const text = buildTelegramResumeMenuText(
      state.sessions,
      cwd,
      page,
      mode,
      nowMs,
      selectedDeletePaths,
      deleteStyle,
    );
    const replyMarkup = buildTelegramResumeMenuReplyMarkup(
      state.sessions,
      nowMs,
      page,
      mode,
      selectedDeletePaths,
      deleteStyle,
      source,
    );
    await deps.editResumeMessage(chatId, messageId, text, replyMarkup);
    deps.setState({ ...state, page, mode, deleteStyle, source, selectedDeletePaths, updatedAt: nowMs });
    await deps.answerCallbackQuery(query.id, "Cancelled.");
    return true;
  }
  if (data === "delete:select-page") {
    const page = clampTelegramResumeMenuPage(state.page, state.sessions.length);
    const pageEntries = sliceTelegramResumeMenuPage(state.sessions, page);
    const currentSessionFile = deps.getCurrentSessionFile();
    const selectedPaths = new Set(state.selectedDeletePaths ?? []);
    let added = 0;
    for (const entry of pageEntries) {
      if (entry.path === state.currentSessionFile || entry.path === currentSessionFile) continue;
      if (!selectedPaths.has(entry.path)) added += 1;
      selectedPaths.add(entry.path);
    }
    if (added === 0 && pageEntries.length === 0) {
      await deps.answerCallbackQuery(query.id, "No sessions on this page.");
      return true;
    }
    const selectedDeletePaths = [...selectedPaths];
    const cwd = deps.getCwd();
    const mode: TelegramResumeMenuMode = "delete";
    const deleteStyle = state.deleteStyle ?? "multi";
    const source = state.source ?? "resume";
    const nowMs = now();
    const text = buildTelegramResumeMenuText(
      state.sessions,
      cwd,
      page,
      mode,
      nowMs,
      selectedDeletePaths,
      deleteStyle,
    );
    const replyMarkup = buildTelegramResumeMenuReplyMarkup(
      state.sessions,
      nowMs,
      page,
      mode,
      selectedDeletePaths,
      deleteStyle,
      source,
    );
    await deps.editResumeMessage(chatId, messageId, text, replyMarkup);
    deps.setState({
      ...state,
      page,
      mode,
      deleteStyle,
      source,
      selectedDeletePaths,
      updatedAt: nowMs,
    });
    await deps.answerCallbackQuery(query.id, added > 0 ? "Page selected." : "Page already selected.");
    return true;
  }
  if (data === "delete:clear-selected") {
    const cwd = deps.getCwd();
    const page = clampTelegramResumeMenuPage(state.page, state.sessions.length);
    const mode: TelegramResumeMenuMode = "delete";
    const deleteStyle = state.deleteStyle ?? "multi";
    const source = state.source ?? "resume";
    const nowMs = now();
    const text = buildTelegramResumeMenuText(
      state.sessions,
      cwd,
      page,
      mode,
      nowMs,
      [],
      deleteStyle,
    );
    const replyMarkup = buildTelegramResumeMenuReplyMarkup(
      state.sessions,
      nowMs,
      page,
      mode,
      [],
      deleteStyle,
      source,
    );
    await deps.editResumeMessage(chatId, messageId, text, replyMarkup);
    deps.setState({ ...state, page, mode, deleteStyle, source, selectedDeletePaths: [], updatedAt: nowMs });
    await deps.answerCallbackQuery(query.id, "Selection cleared.");
    return true;
  }
  if (data.startsWith("delete:select:") || data.startsWith("delete:delete:")) {
    const selectionPrefix = data.startsWith("delete:select:")
      ? "delete:select:"
      : "delete:delete:";
    const index = parseTelegramResumeMenuIndex(
      data,
      selectionPrefix,
      state.sessions.length,
    );
    if (index === undefined) {
      await deps.answerCallbackQuery(query.id, "Invalid selection.");
      return true;
    }
    const entry = state.sessions[index];
    const currentSessionFile = deps.getCurrentSessionFile();
    if (
      entry.path === state.currentSessionFile ||
      entry.path === currentSessionFile
    ) {
      await deps.answerCallbackQuery(query.id, "Can't delete current session.");
      return true;
    }
    if (selectionPrefix === "delete:delete:" && (state.deleteStyle ?? "multi") === "single") {
      const nowMs = now();
      await deps.editResumeMessage(
        chatId,
        messageId,
        buildTelegramSingleDeleteConfirmationText(entry, deps.getCwd(), nowMs),
        buildTelegramSingleDeleteConfirmationReplyMarkup(index),
      );
      deps.setState({ ...state, mode: "delete", deleteStyle: "single", source: state.source ?? "delete", selectedDeletePaths: [entry.path], updatedAt: nowMs });
      await deps.answerCallbackQuery(query.id);
      return true;
    }
    const selectedPaths = new Set(state.selectedDeletePaths ?? []);
    if (selectedPaths.has(entry.path)) selectedPaths.delete(entry.path);
    else selectedPaths.add(entry.path);
    const selectedDeletePaths = [...selectedPaths];
    const cwd = deps.getCwd();
    const page = clampTelegramResumeMenuPage(state.page, state.sessions.length);
    const mode: TelegramResumeMenuMode = "delete";
    const deleteStyle = state.deleteStyle ?? "multi";
    const source = state.source ?? "resume";
    const nowMs = now();
    const text = buildTelegramResumeMenuText(
      state.sessions,
      cwd,
      page,
      mode,
      nowMs,
      selectedDeletePaths,
      deleteStyle,
    );
    const replyMarkup = buildTelegramResumeMenuReplyMarkup(
      state.sessions,
      nowMs,
      page,
      mode,
      selectedDeletePaths,
      deleteStyle,
      source,
    );
    await deps.editResumeMessage(chatId, messageId, text, replyMarkup);
    deps.setState({
      ...state,
      page,
      mode,
      deleteStyle,
      source,
      selectedDeletePaths,
      updatedAt: nowMs,
    });
    await deps.answerCallbackQuery(
      query.id,
      selectedPaths.has(entry.path) ? "Selected." : "Unselected.",
    );
    return true;
  }
  if (data === "delete:delete-selected") {
    const selectedPaths = new Set(state.selectedDeletePaths ?? []);
    const selectedEntries = state.sessions.filter((entry) => selectedPaths.has(entry.path));
    if (selectedEntries.length === 0) {
      await deps.answerCallbackQuery(query.id, "No sessions selected.");
      return true;
    }
    const currentSessionFile = deps.getCurrentSessionFile();
    if (
      selectedEntries.some(
        (entry) => entry.path === state.currentSessionFile || entry.path === currentSessionFile,
      )
    ) {
      await deps.answerCallbackQuery(query.id, "Can't delete current session.");
      return true;
    }
    await deps.editResumeMessage(
      chatId,
      messageId,
      buildTelegramResumeDeleteConfirmationText(selectedEntries),
      buildTelegramResumeDeleteConfirmationReplyMarkup(),
    );
    deps.setState({ ...state, mode: "delete", updatedAt: now() });
    await deps.answerCallbackQuery(query.id);
    return true;
  }
  if (data === "delete:confirm-delete-selected" || data.startsWith("delete:confirm-delete:")) {
    let selectedPaths = new Set(state.selectedDeletePaths ?? []);
    if (data.startsWith("delete:confirm-delete:")) {
      const index = parseTelegramResumeMenuIndex(
        data,
        "delete:confirm-delete:",
        state.sessions.length,
      );
      if (index === undefined) {
        await deps.answerCallbackQuery(query.id, "Invalid selection.");
        return true;
      }
      const selectedEntry = state.sessions[index];
      if (!selectedEntry) {
        await deps.answerCallbackQuery(query.id, "Invalid selection.");
        return true;
      }
      selectedPaths = new Set([selectedEntry.path]);
    }
    const selectedEntries = state.sessions.filter((entry) => selectedPaths.has(entry.path));
    if (selectedEntries.length === 0) {
      await deps.answerCallbackQuery(query.id, "No sessions selected.");
      return true;
    }
    const currentSessionFile = deps.getCurrentSessionFile();
    if (
      selectedEntries.some(
        (entry) => entry.path === state.currentSessionFile || entry.path === currentSessionFile,
      )
    ) {
      await deps.answerCallbackQuery(query.id, "Can't delete current session.");
      return true;
    }
    let singleDeleteResult: TelegramResumeDeleteResult | void = undefined;
    try {
      for (const entry of selectedEntries) {
        const result = await deps.deleteSessionFile(entry.path);
        if (selectedEntries.length === 1) singleDeleteResult = result;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.answerCallbackQuery(query.id, `Delete failed: ${message}`);
      return true;
    }
    const deletedPaths = new Set(selectedEntries.map((entry) => entry.path));
    const nextSessions = reindexTelegramResumeMenuEntries(
      state.sessions.filter((entry) => !deletedPaths.has(entry.path)),
    );
    const page = clampTelegramResumeMenuPage(state.page, nextSessions.length);
    const cwd = deps.getCwd();
    const mode: TelegramResumeMenuMode = "delete";
    const nowMs = now();
    const deleteStyle = state.deleteStyle ?? "multi";
    const source = state.source ?? "resume";
    const isSingleDelete = deleteStyle === "single" && selectedEntries.length === 1;
    const text = isSingleDelete
      ? buildTelegramSingleDeleteSuccessText(selectedEntries[0]!, singleDeleteResult)
      : buildTelegramResumeMenuText(
        nextSessions,
        cwd,
        page,
        mode,
        nowMs,
        [],
        deleteStyle,
      );
    const replyMarkup = isSingleDelete
      ? buildTelegramSingleDeleteSuccessReplyMarkup()
      : buildTelegramResumeMenuReplyMarkup(
        nextSessions,
        nowMs,
        page,
        mode,
        [],
        deleteStyle,
        source,
      );
    await deps.editResumeMessage(chatId, messageId, text, replyMarkup);
    deps.setState({
      ...state,
      sessions: nextSessions,
      page,
      mode,
      deleteStyle,
      source,
      selectedDeletePaths: [],
      updatedAt: nowMs,
    });
    await deps.answerCallbackQuery(
      query.id,
      `${selectedEntries.length} session${selectedEntries.length === 1 ? "" : "s"} deleted.`,
    );
    return true;
  }
  if (!data.startsWith("resume:open:")) {
    await deps.answerCallbackQuery(query.id);
    return true;
  }
  const index = parseTelegramResumeMenuIndex(
    data,
    "resume:open:",
    state.sessions.length,
  );
  if (index === undefined) {
    await deps.answerCallbackQuery(query.id, "Invalid selection.");
    return true;
  }
  const entry = state.sessions[index];
  try {
    await deps.injectResumeExec(entry.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.answerCallbackQuery(query.id, `Resume failed: ${message}`);
    return true;
  }
  const headline = truncateSummary(
    entry.name || entry.firstMessage || entry.sessionId,
    TELEGRAM_RESUME_MENU_SUMMARY_LEN,
  );
  const resumedText = `${TELEGRAM_RESUME_MENU_TITLE}\n\nResumed: <code>${escapeHtml(headline)}</code>\n(${entry.messageCount} msgs · id ${entry.sessionId.slice(0, 8)})`;
  await deps.editResumeMessage(chatId, messageId, resumedText, {
    inline_keyboard: [],
  });
  await deps.answerCallbackQuery(query.id, "Session switching…");
  return true;
}

export interface TelegramResumeMenuRuntime<TContext> {
  openResumeMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
    filters?: readonly string[],
  ) => Promise<void>;
  openDeleteMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  handleCallbackQuery: (
    query: TelegramResumeMenuCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
}

export interface TelegramResumeMenuRuntimeDeps<TContext> {
  getCwd: (ctx: TContext) => string;
  getCurrentSessionFile: (ctx: TContext) => string | undefined;
  listSessions?: (cwd: string) => Promise<SessionInfo[]>;
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "html",
    replyMarkup: TelegramResumeMenuReplyMarkup,
  ) => Promise<number | undefined>;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "html",
    replyMarkup: TelegramResumeMenuReplyMarkup,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  injectResumeExec: (sessionPath: string) => Promise<void>;
  deleteSessionFile?: (sessionPath: string) => Promise<void | TelegramResumeDeleteResult>;
  store?: TelegramResumeMenuStore;
}

export type TelegramResumeOutcome =
  | { ok: true; sessionPath: string }
  | { ok: false; sessionPath: string; error: string };

export interface TelegramResumeOutcomeNotifierDeps {
  getAllowedUserId: () => number | undefined;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
  ) => Promise<unknown>;
}

function formatTelegramResumeOutcomeText(
  outcome: TelegramResumeOutcome,
): string {
  const tail = outcome.sessionPath
    ? (outcome.sessionPath.split("/").pop() ?? outcome.sessionPath)
    : "(unknown)";
  if (outcome.ok) return `✅ Resumed session: ${tail}`;
  return `⚠️ Resume failed (${tail}): ${outcome.error}`;
}

export function createTelegramResumeOutcomeNotifier(
  deps: TelegramResumeOutcomeNotifierDeps,
): (outcome: TelegramResumeOutcome) => Promise<void> {
  return async function notifyTelegramResumeOutcome(outcome) {
    const chatId = deps.getAllowedUserId();
    if (typeof chatId !== "number") return;
    try {
      await deps.sendTextReply(
        chatId,
        0,
        formatTelegramResumeOutcomeText(outcome),
      );
    } catch {
      // best-effort notification only
    }
  };
}

export function defaultTelegramResumeMenuListSessions(
  cwd: string,
): Promise<SessionInfo[]> {
  return SessionManager.list(cwd);
}

export async function defaultTelegramResumeMenuDeleteSessionFile(
  sessionPath: string,
): Promise<TelegramResumeDeleteResult> {
  const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
  const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });
  if (trashResult.status === 0 || !existsSync(sessionPath)) {
    return { method: "trash" };
  }
  await unlink(sessionPath);
  return { method: "unlink" };
}

export interface TelegramResumeMenuRuntimePiContextDeps<TContext> {
  sendInteractiveMessage: TelegramResumeMenuRuntimeDeps<TContext>["sendInteractiveMessage"];
  editInteractiveMessage: TelegramResumeMenuRuntimeDeps<TContext>["editInteractiveMessage"];
  answerCallbackQuery: TelegramResumeMenuRuntimeDeps<TContext>["answerCallbackQuery"];
  injectResumeExec: TelegramResumeMenuRuntimeDeps<TContext>["injectResumeExec"];
  deleteSessionFile?: TelegramResumeMenuRuntimeDeps<TContext>["deleteSessionFile"];
  getCwd: (ctx: TContext) => string;
  getCurrentSessionFile: (ctx: TContext) => string | undefined;
}

/**
 * Convenience wrapper used by the extension composition root so it can stay
 * arrow-function-free; mirrors createTelegramResumeMenuRuntime exactly.
 */
export function buildTelegramResumeMenuRuntime<TContext>(
  deps: TelegramResumeMenuRuntimePiContextDeps<TContext>,
): TelegramResumeMenuRuntime<TContext> {
  return createTelegramResumeMenuRuntime({
    getCwd: deps.getCwd,
    getCurrentSessionFile: deps.getCurrentSessionFile,
    sendInteractiveMessage: deps.sendInteractiveMessage,
    editInteractiveMessage: deps.editInteractiveMessage,
    answerCallbackQuery: deps.answerCallbackQuery,
    injectResumeExec: deps.injectResumeExec,
    deleteSessionFile: deps.deleteSessionFile,
  });
}

export function createTelegramResumeMenuRuntime<TContext>(
  deps: TelegramResumeMenuRuntimeDeps<TContext>,
): TelegramResumeMenuRuntime<TContext> {
  const store = deps.store ?? createTelegramResumeMenuStore();
  const listSessions =
    deps.listSessions ?? defaultTelegramResumeMenuListSessions;
  const deleteSessionFile =
    deps.deleteSessionFile ?? defaultTelegramResumeMenuDeleteSessionFile;
  return {
    openResumeMenu: function openResumeMenuForContext(
      chatId,
      _replyToMessageId,
      ctx,
      filters,
    ) {
      return openTelegramResumeMenu({
        chatId,
        getCwd: function getCwdForContext() {
          return deps.getCwd(ctx);
        },
        getCurrentSessionFile: function getSessionFileForContext() {
          return deps.getCurrentSessionFile(ctx);
        },
        listSessions,
        filters,
        sendResumeMenu: function sendResumeMenuForContext(text, replyMarkup) {
          return deps.sendInteractiveMessage(
            chatId,
            text,
            "html",
            replyMarkup,
          );
        },
        storeState: store.set,
      });
    },
    openDeleteMenu: function openDeleteMenuForContext(
      chatId,
      _replyToMessageId,
      ctx,
    ) {
      return openTelegramResumeMenu({
        chatId,
        getCwd: function getCwdForContext() {
          return deps.getCwd(ctx);
        },
        getCurrentSessionFile: function getSessionFileForContext() {
          return deps.getCurrentSessionFile(ctx);
        },
        listSessions,
        mode: "delete",
        deleteStyle: "multi",
        source: "delete",
        sendResumeMenu: function sendResumeMenuForContext(text, replyMarkup) {
          return deps.sendInteractiveMessage(
            chatId,
            text,
            "html",
            replyMarkup,
          );
        },
        storeState: store.set,
      });
    },
    handleCallbackQuery: function handleResumeCallbackForContext(query, ctx) {
      return handleTelegramResumeMenuCallback(query, {
        getState: store.get,
        setState: store.set,
        getCwd: function getCwdForCallback() {
          return deps.getCwd(ctx);
        },
        getCurrentSessionFile: function getSessionFileForCallback() {
          return deps.getCurrentSessionFile(ctx);
        },
        editResumeMessage: function editResumeMessageHtml(
          chatId,
          messageId,
          text,
          replyMarkup,
        ) {
          return deps.editInteractiveMessage(
            chatId,
            messageId,
            text,
            "html",
            replyMarkup,
          );
        },
        answerCallbackQuery: deps.answerCallbackQuery,
        injectResumeExec: deps.injectResumeExec,
        deleteSessionFile,
      });
    },
  };
}
