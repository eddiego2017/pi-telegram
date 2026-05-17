/**
 * Telegram resume menu UI helpers
 * Zones: telegram ui, session resume, menu composition
 * Owns the /resume inline keyboard, session-list cache, and callback dispatching;
 * actual session switching happens via tmux-injected `/telegram-resume-exec <path>`
 * (see lib/pi.ts createTmuxDynamicSlashCommandInjector + index.ts wiring).
 */

import { unlink } from "node:fs/promises";

import {
  type SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";

export const TELEGRAM_RESUME_MENU_PAGE_SIZE = 8;
export const TELEGRAM_RESUME_MENU_MAX_ITEMS = 200;
const TELEGRAM_RESUME_MENU_STATE_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_RESUME_MENU_SUMMARY_LEN = 48;

export type TelegramResumeMenuReplyMarkup = TelegramInlineKeyboardMarkup;
export type TelegramResumeMenuMode = "open" | "delete";

export interface TelegramResumeMenuEntry {
  /** global index in the menu state's `sessions` array (stable across pagination) */
  index: number;
  path: string;
  sessionId: string;
  name?: string;
  firstMessage: string;
  messageCount: number;
  modified: Date;
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
  /** Session file paths selected in delete mode. */
  selectedDeletePaths?: string[];
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

function truncateSummary(s: string, n: number): string {
  const clean = (s ?? "").replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
}

function formatAgo(d: Date, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - d.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function formatTelegramResumeButtonText(
  entry: TelegramResumeMenuEntry,
  nowMs: number,
): string {
  const head = entry.name || entry.firstMessage || "(no preview)";
  const summary = truncateSummary(head, TELEGRAM_RESUME_MENU_SUMMARY_LEN);
  const ago = formatAgo(entry.modified, nowMs).padStart(4);
  const msgs = String(entry.messageCount).padStart(3);
  return `${ago} · ${msgs}msg · ${summary}`;
}

export const TELEGRAM_RESUME_MENU_TITLE = "<b>📂 Resume session</b>";

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

export function buildTelegramResumeMenuText(
  entries: TelegramResumeMenuEntry[],
  cwd: string,
  page = 0,
  mode: TelegramResumeMenuMode = "open",
): string {
  if (entries.length === 0) {
    return `${TELEGRAM_RESUME_MENU_TITLE}\n\nNo other sessions for <code>${escapeHtml(cwd)}</code>.`;
  }
  const pageCount = getTelegramResumeMenuPageCount(entries.length);
  const safePage = clampTelegramResumeMenuPage(page, entries.length);
  const suffix =
    pageCount > 1
      ? ` (Page ${safePage + 1}/${pageCount} · ${entries.length} sessions)`
      : "";
  const prompt =
    mode === "delete"
      ? "Select sessions to delete:"
      : "Pick a session to switch to:";
  return `${TELEGRAM_RESUME_MENU_TITLE}${suffix}\n\n<code>${escapeHtml(cwd)}</code>\n${prompt}`;
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
): TelegramResumeMenuReplyMarkup {
  const selectedPaths = new Set(selectedDeletePaths);
  const selectedCount = entries.filter((entry) => selectedPaths.has(entry.path)).length;
  const rows: TelegramResumeMenuReplyMarkup["inline_keyboard"] = [];
  if (mode === "delete") {
    rows.push([{ text: "⬅️ Back to resume list", callback_data: "resume:mode:open" }]);
  }
  if (entries.length > 0 && mode === "open") {
    rows.push([{ text: "🗑 Delete sessions", callback_data: "resume:mode:delete" }]);
  }
  if (entries.length > 0 && mode === "delete") {
    if (selectedCount > 0) {
      rows.push([
        {
          text: `🗑 Delete ${selectedCount} selected`,
          callback_data: "resume:delete-selected",
        },
      ]);
      rows.push([{ text: "Clear selection", callback_data: "resume:clear-selected" }]);
    } else {
      rows.push([{ text: "☐ Select sessions below", callback_data: "resume:noop" }]);
    }
  }
  const pageCount = getTelegramResumeMenuPageCount(entries.length);
  const safePage = clampTelegramResumeMenuPage(page, entries.length);
  const pageEntries = sliceTelegramResumeMenuPage(entries, safePage);
  for (const entry of pageEntries) {
    const text = formatTelegramResumeButtonText(entry, nowMs);
    const selected = selectedPaths.has(entry.path);
    rows.push([
      {
        text:
          mode === "delete"
            ? `${selected ? "☑" : "☐"} ${text}`
            : text,
        callback_data:
          mode === "delete"
            ? `resume:select:${entry.index}`
            : `resume:open:${entry.index}`,
      },
    ]);
  }
  if (entries.length === 0) {
    rows.push([{ text: "(no sessions)", callback_data: "resume:noop" }]);
  }
  if (pageCount > 1) {
    const prevPage = safePage - 1;
    const nextPage = safePage + 1;
    rows.push([
      {
        text: prevPage >= 0 ? "⬅️ Prev" : "·",
        callback_data:
          prevPage >= 0 ? `resume:page:${prevPage}` : "resume:noop",
      },
      {
        text: `${safePage + 1}/${pageCount}`,
        callback_data: "resume:noop",
      },
      {
        text: nextPage < pageCount ? "Next ➡️" : "·",
        callback_data:
          nextPage < pageCount ? `resume:page:${nextPage}` : "resume:noop",
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
): TelegramResumeMenuEntry[] {
  return sessions
    .filter((s) => s.path !== currentSessionFile)
    .slice(0, TELEGRAM_RESUME_MENU_MAX_ITEMS)
    .map((s, index) => ({
      index,
      path: s.path,
      sessionId: s.id,
      name: s.name,
      firstMessage: s.firstMessage,
      messageCount: s.messageCount,
      modified: s.modified,
    }));
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
  return `${TELEGRAM_RESUME_MENU_TITLE}\n\nDelete ${entries.length} selected session${entries.length === 1 ? "" : "s"}?\n\n${shown.join("\n")}${more}`;
}

function buildTelegramResumeDeleteConfirmationReplyMarkup(): TelegramResumeMenuReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: "❌ No", callback_data: "resume:cancel-delete" },
        {
          text: "🗑 Yes, delete",
          callback_data: "resume:confirm-delete-selected",
        },
      ],
    ],
  };
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
  now?: () => number;
}

export async function openTelegramResumeMenu(
  deps: TelegramResumeMenuOpenDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const cwd = deps.getCwd();
  const currentSessionFile = deps.getCurrentSessionFile();
  const sessions = await deps.listSessions(cwd);
  const entries = buildResumeMenuEntries(sessions, currentSessionFile);
  const page = 0;
  const text = buildTelegramResumeMenuText(entries, cwd, page);
  const replyMarkup = buildTelegramResumeMenuReplyMarkup(entries, now(), page);
  const messageId = await deps.sendResumeMenu(text, replyMarkup);
  if (messageId === undefined) return;
  deps.storeState({
    chatId: deps.chatId,
    messageId,
    sessions: entries,
    page,
    currentSessionFile,
    mode: "open",
    selectedDeletePaths: [],
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
  deleteSessionFile: (sessionPath: string) => Promise<void>;
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
  if (!data?.startsWith("resume:")) return false;
  if (data === "resume:noop") {
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
    await deps.answerCallbackQuery(query.id, "Resume menu expired.");
    return true;
  }
  const now = deps.now ?? Date.now;
  if (data.startsWith("resume:page:")) {
    const pageStr = data.slice("resume:page:".length);
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
    const text = buildTelegramResumeMenuText(
      state.sessions,
      cwd,
      nextPage,
      mode,
    );
    const selectedDeletePaths = state.selectedDeletePaths ?? [];
    const replyMarkup = buildTelegramResumeMenuReplyMarkup(
      state.sessions,
      now(),
      nextPage,
      mode,
      selectedDeletePaths,
    );
    await deps.editResumeMessage(chatId, messageId, text, replyMarkup);
    deps.setState({
      ...state,
      page: nextPage,
      mode,
      selectedDeletePaths,
      updatedAt: now(),
    });
    await deps.answerCallbackQuery(query.id);
    return true;
  }
  if (data === "resume:cancel-delete") {
    const cwd = deps.getCwd();
    const page = clampTelegramResumeMenuPage(state.page, state.sessions.length);
    const mode = state.mode ?? "delete";
    const selectedDeletePaths = state.selectedDeletePaths ?? [];
    const text = buildTelegramResumeMenuText(state.sessions, cwd, page, mode);
    const replyMarkup = buildTelegramResumeMenuReplyMarkup(
      state.sessions,
      now(),
      page,
      mode,
      selectedDeletePaths,
    );
    await deps.editResumeMessage(chatId, messageId, text, replyMarkup);
    deps.setState({ ...state, page, mode, selectedDeletePaths, updatedAt: now() });
    await deps.answerCallbackQuery(query.id, "Cancelled.");
    return true;
  }
  if (data.startsWith("resume:mode:")) {
    const mode: TelegramResumeMenuMode =
      data === "resume:mode:delete" ? "delete" : "open";
    const selectedDeletePaths = mode === "delete" ? (state.selectedDeletePaths ?? []) : [];
    const cwd = deps.getCwd();
    const page = clampTelegramResumeMenuPage(state.page, state.sessions.length);
    const text = buildTelegramResumeMenuText(state.sessions, cwd, page, mode);
    const replyMarkup = buildTelegramResumeMenuReplyMarkup(
      state.sessions,
      now(),
      page,
      mode,
      selectedDeletePaths,
    );
    await deps.editResumeMessage(chatId, messageId, text, replyMarkup);
    deps.setState({ ...state, page, mode, selectedDeletePaths, updatedAt: now() });
    await deps.answerCallbackQuery(query.id);
    return true;
  }
  if (data === "resume:clear-selected") {
    const cwd = deps.getCwd();
    const page = clampTelegramResumeMenuPage(state.page, state.sessions.length);
    const mode: TelegramResumeMenuMode = "delete";
    const text = buildTelegramResumeMenuText(state.sessions, cwd, page, mode);
    const replyMarkup = buildTelegramResumeMenuReplyMarkup(
      state.sessions,
      now(),
      page,
      mode,
      [],
    );
    await deps.editResumeMessage(chatId, messageId, text, replyMarkup);
    deps.setState({ ...state, page, mode, selectedDeletePaths: [], updatedAt: now() });
    await deps.answerCallbackQuery(query.id, "Selection cleared.");
    return true;
  }
  if (data.startsWith("resume:select:") || data.startsWith("resume:delete:")) {
    const prefix = data.startsWith("resume:select:")
      ? "resume:select:"
      : "resume:delete:";
    const index = parseTelegramResumeMenuIndex(
      data,
      prefix,
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
    const selectedPaths = new Set(state.selectedDeletePaths ?? []);
    if (selectedPaths.has(entry.path)) selectedPaths.delete(entry.path);
    else selectedPaths.add(entry.path);
    const selectedDeletePaths = [...selectedPaths];
    const cwd = deps.getCwd();
    const page = clampTelegramResumeMenuPage(state.page, state.sessions.length);
    const mode: TelegramResumeMenuMode = "delete";
    const text = buildTelegramResumeMenuText(state.sessions, cwd, page, mode);
    const replyMarkup = buildTelegramResumeMenuReplyMarkup(
      state.sessions,
      now(),
      page,
      mode,
      selectedDeletePaths,
    );
    await deps.editResumeMessage(chatId, messageId, text, replyMarkup);
    deps.setState({
      ...state,
      page,
      mode,
      selectedDeletePaths,
      updatedAt: now(),
    });
    await deps.answerCallbackQuery(
      query.id,
      selectedPaths.has(entry.path) ? "Selected." : "Unselected.",
    );
    return true;
  }
  if (data === "resume:delete-selected") {
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
  if (data === "resume:confirm-delete-selected" || data.startsWith("resume:confirm-delete:")) {
    let selectedPaths = new Set(state.selectedDeletePaths ?? []);
    if (data.startsWith("resume:confirm-delete:")) {
      const index = parseTelegramResumeMenuIndex(
        data,
        "resume:confirm-delete:",
        state.sessions.length,
      );
      if (index === undefined) {
        await deps.answerCallbackQuery(query.id, "Invalid selection.");
        return true;
      }
      selectedPaths = new Set([state.sessions[index].path]);
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
    try {
      for (const entry of selectedEntries) {
        await deps.deleteSessionFile(entry.path);
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
    const text = buildTelegramResumeMenuText(nextSessions, cwd, page, mode);
    const replyMarkup = buildTelegramResumeMenuReplyMarkup(
      nextSessions,
      now(),
      page,
      mode,
      [],
    );
    await deps.editResumeMessage(chatId, messageId, text, replyMarkup);
    deps.setState({
      ...state,
      sessions: nextSessions,
      page,
      mode,
      selectedDeletePaths: [],
      updatedAt: now(),
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
  deleteSessionFile?: (sessionPath: string) => Promise<void>;
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

export function defaultTelegramResumeMenuDeleteSessionFile(
  sessionPath: string,
): Promise<void> {
  return unlink(sessionPath);
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
