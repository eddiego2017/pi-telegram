/**
 * Telegram resume menu UI helpers
 * Zones: telegram ui, session resume, menu composition
 * Owns the /resume inline keyboard, session-list cache, and callback dispatching;
 * actual session switching happens via tmux-injected `/telegram-resume-exec <path>`
 * (see lib/pi.ts createTmuxDynamicSlashCommandInjector + index.ts wiring).
 */

import {
  type SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";

export const TELEGRAM_RESUME_MENU_MAX_ITEMS = 10;
const TELEGRAM_RESUME_MENU_STATE_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_RESUME_MENU_SUMMARY_LEN = 48;

export type TelegramResumeMenuReplyMarkup = TelegramInlineKeyboardMarkup;

export interface TelegramResumeMenuEntry {
  /** index in the menu state's `sessions` array */
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
  sessions: TelegramResumeMenuEntry[];
  /** Path of the session that was active when the menu opened, filtered out. */
  currentSessionFile: string | undefined;
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

export function buildTelegramResumeMenuText(
  entries: TelegramResumeMenuEntry[],
  cwd: string,
): string {
  if (entries.length === 0) {
    return `${TELEGRAM_RESUME_MENU_TITLE}\n\nNo other sessions for <code>${escapeHtml(cwd)}</code>.`;
  }
  return `${TELEGRAM_RESUME_MENU_TITLE}\n\n<code>${escapeHtml(cwd)}</code>\nPick a session to switch to:`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildTelegramResumeMenuReplyMarkup(
  entries: TelegramResumeMenuEntry[],
  nowMs: number = Date.now(),
): TelegramResumeMenuReplyMarkup {
  const rows: TelegramResumeMenuReplyMarkup["inline_keyboard"] = [
    [{ text: "⬆️ Main menu", callback_data: "menu:back" }],
  ];
  for (const entry of entries) {
    rows.push([
      {
        text: formatTelegramResumeButtonText(entry, nowMs),
        callback_data: `resume:open:${entry.index}`,
      },
    ]);
  }
  if (entries.length === 0) {
    rows.push([{ text: "(no sessions)", callback_data: "resume:noop" }]);
  }
  return { inline_keyboard: rows };
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
  const text = buildTelegramResumeMenuText(entries, cwd);
  const replyMarkup = buildTelegramResumeMenuReplyMarkup(entries, now());
  const messageId = await deps.sendResumeMenu(text, replyMarkup);
  if (messageId === undefined) return;
  deps.storeState({
    chatId: deps.chatId,
    messageId,
    sessions: entries,
    currentSessionFile,
    updatedAt: now(),
  });
}

export interface TelegramResumeMenuCallbackDeps {
  getState: (messageId: number | undefined) => TelegramResumeMenuState | undefined;
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
  if (!data.startsWith("resume:open:")) {
    await deps.answerCallbackQuery(query.id);
    return true;
  }
  const indexStr = data.slice("resume:open:".length);
  const index = Number.parseInt(indexStr, 10);
  if (!Number.isInteger(index) || index < 0 || index >= state.sessions.length) {
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

export interface TelegramResumeMenuRuntimePiContextDeps<TContext> {
  sendInteractiveMessage: TelegramResumeMenuRuntimeDeps<TContext>["sendInteractiveMessage"];
  editInteractiveMessage: TelegramResumeMenuRuntimeDeps<TContext>["editInteractiveMessage"];
  answerCallbackQuery: TelegramResumeMenuRuntimeDeps<TContext>["answerCallbackQuery"];
  injectResumeExec: TelegramResumeMenuRuntimeDeps<TContext>["injectResumeExec"];
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
  });
}

export function createTelegramResumeMenuRuntime<TContext>(
  deps: TelegramResumeMenuRuntimeDeps<TContext>,
): TelegramResumeMenuRuntime<TContext> {
  const store = deps.store ?? createTelegramResumeMenuStore();
  const listSessions =
    deps.listSessions ?? defaultTelegramResumeMenuListSessions;
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
    handleCallbackQuery: function handleResumeCallbackForContext(query) {
      return handleTelegramResumeMenuCallback(query, {
        getState: store.get,
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
      });
    },
  };
}
