/**
 * Telegram transcript dump menu UI helpers
 * Zones: telegram controls, transcript export, menu composition
 * Owns the Telegram-native /dump menu, output selection, and transcript export callback dispatch.
 */

import * as DumpExport from "./dump-export.ts";

const TELEGRAM_DUMP_STATE_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_DUMP_MAX_TURN_LIMIT = 10_000;

export type TelegramDumpReplyMarkup = {
  inline_keyboard: Array<Array<
    | { text: string; callback_data: string }
    | { text: string; url: string }
  >>;
};
export type TelegramDumpView = "main" | "gistConfirm" | "gistPublished";

export interface TelegramDumpMenuState {
  chatId: number;
  messageId: number;
  view: TelegramDumpView;
  scope: DumpExport.TelegramDumpScope;
  publishedGist?: DumpExport.TelegramDumpGistPublishResult;
  updatedAt: number;
}

export interface TelegramDumpMenuStore {
  get(messageId: number | undefined): TelegramDumpMenuState | undefined;
  set(state: TelegramDumpMenuState): void;
  clear(): void;
}

export function createTelegramDumpMenuStore(
  now: () => number = Date.now,
): TelegramDumpMenuStore {
  const states = new Map<number, TelegramDumpMenuState>();
  function pruneExpired(): void {
    const cutoff = now() - TELEGRAM_DUMP_STATE_TTL_MS;
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

function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(n));
}

function formatScopeLabel(scope: DumpExport.TelegramDumpScope): string {
  return scope.turnLimit && scope.turnLimit > 0
    ? `last ${scope.turnLimit} turns`
    : "all turns";
}

export function parseTelegramDumpTurnLimit(args: string): number | undefined | null {
  const trimmed = args.trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || value > TELEGRAM_DUMP_MAX_TURN_LIMIT) return null;
  return value;
}

export function buildTelegramDumpMainText(
  snapshot: DumpExport.TelegramDumpSnapshot,
  scope: DumpExport.TelegramDumpScope,
): string {
  const transcript = DumpExport.buildTelegramDumpTranscript(snapshot, scope);
  const stats = transcript.stats;
  const name = snapshot.sessionName?.trim();
  return [
    "<b>🧾 Dump transcript</b>",
    "",
    `Session: ${name ? escapeHtml(name) : `<code>${escapeHtml(snapshot.sessionId)}</code>`}`,
    "Scope: active branch",
    `Range: ${escapeHtml(formatScopeLabel(scope))}`,
    `Turns: ${formatCount(stats.selectedTurns)} / ${formatCount(stats.totalTurns)}`,
    `Messages: ${formatCount(stats.selectedMessages)} / ${formatCount(stats.totalMessages)}`,
    `Chars: ${formatCount(stats.chars)}`,
    "",
    "Only visible <b>User</b>/<b>Agent</b> text is included.",
    "Tools, thinking, and metadata are hidden.",
    "",
    "Choose output:",
  ].join("\n");
}

export function buildTelegramDumpMainReplyMarkup(
  hasMessages: boolean,
): TelegramDumpReplyMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: hasMessages ? "📄 Send TXT" : "📄 TXT (empty)",
          callback_data: hasMessages ? "dump:txt" : "dump:noop",
        },
        {
          text: hasMessages ? "🌐 Publish Gist" : "🌐 Gist (empty)",
          callback_data: hasMessages ? "dump:gist:ask" : "dump:noop",
        },
      ],
      [{ text: "🔄 Refresh", callback_data: "dump:refresh" }],
    ],
  };
}

function buildTelegramDumpGistConfirmText(
  snapshot: DumpExport.TelegramDumpSnapshot,
  scope: DumpExport.TelegramDumpScope,
): string {
  const transcript = DumpExport.buildTelegramDumpTranscript(snapshot, scope);
  return [
    "<b>🧾 Dump transcript</b>",
    "",
    "Publish transcript to a secret GitHub Gist?",
    "",
    `Range: ${escapeHtml(formatScopeLabel(scope))}`,
    `Turns: ${formatCount(transcript.stats.selectedTurns)}`,
    `Messages: ${formatCount(transcript.stats.selectedMessages)}`,
    "",
    "<b>Privacy note</b>",
    "Secret Gists are unlisted, not private.",
    "Anyone with the URL can read this transcript.",
  ].join("\n");
}

function buildTelegramDumpGistConfirmReplyMarkup(): TelegramDumpReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "✅ Publish secret Gist", callback_data: "dump:gist:publish" }],
      [{ text: "Cancel", callback_data: "dump:back:main" }],
    ],
  };
}

function buildTelegramDumpGistPublishedText(
  result: DumpExport.TelegramDumpGistPublishResult,
): string {
  return [
    "<b>🧾 Dump transcript</b>",
    "",
    "Published secret Gist.",
    "",
    `File: <code>${escapeHtml(result.fileName)}</code>`,
    `Gist: <code>${escapeHtml(result.gistId)}</code>`,
    "",
    "Use Open TXT for direct browser rendering.",
  ].join("\n");
}

function buildTelegramDumpGistPublishedReplyMarkup(
  result: DumpExport.TelegramDumpGistPublishResult,
): TelegramDumpReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "🌐 Open TXT", url: result.rawUrl }],
      [{ text: "📄 Gist page", url: result.htmlUrl }],
      [{ text: "🗑 Delete Gist", callback_data: "dump:gist:delete" }],
      [{ text: "⬅️ Back", callback_data: "dump:back:main" }],
    ],
  };
}

export interface TelegramDumpMenuOpenDeps {
  chatId: number;
  scope: DumpExport.TelegramDumpScope;
  getSnapshot: () => DumpExport.TelegramDumpSnapshot;
  sendDumpMenu: (
    text: string,
    replyMarkup: TelegramDumpReplyMarkup,
  ) => Promise<number | undefined>;
  storeState: (state: TelegramDumpMenuState) => void;
  now?: () => number;
}

export async function openTelegramDumpMenu(
  deps: TelegramDumpMenuOpenDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const snapshot = deps.getSnapshot();
  const transcript = DumpExport.buildTelegramDumpTranscript(snapshot, deps.scope);
  const messageId = await deps.sendDumpMenu(
    buildTelegramDumpMainText(snapshot, deps.scope),
    buildTelegramDumpMainReplyMarkup(transcript.stats.selectedMessages > 0),
  );
  if (messageId === undefined) return;
  deps.storeState({
    chatId: deps.chatId,
    messageId,
    view: "main",
    scope: deps.scope,
    updatedAt: now(),
  });
}

export interface TelegramDumpMenuCallbackQuery {
  id: string;
  data?: string;
  message?: { chat?: { id?: number }; message_id?: number };
}

export interface TelegramDumpMenuCallbackDeps {
  getState: (messageId: number | undefined) => TelegramDumpMenuState | undefined;
  setState: (state: TelegramDumpMenuState) => void;
  getSnapshot: () => DumpExport.TelegramDumpSnapshot;
  editDumpMessage: (
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup: TelegramDumpReplyMarkup,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  renderDumpExport: (
    snapshot: DumpExport.TelegramDumpSnapshot,
    scope: DumpExport.TelegramDumpScope,
  ) => Promise<DumpExport.TelegramDumpExportFileSet>;
  sendDumpExportFiles: (
    chatId: number,
    replyToMessageId: number,
    files: DumpExport.TelegramDumpExportFileSet,
  ) => Promise<void>;
  publishDumpGist?: (
    snapshot: DumpExport.TelegramDumpSnapshot,
    scope: DumpExport.TelegramDumpScope,
  ) => Promise<DumpExport.TelegramDumpGistPublishResult>;
  deleteDumpGist?: (gistId: string) => Promise<void>;
  now?: () => number;
}

async function handleTelegramDumpMenuCallbackUnsafe(
  query: TelegramDumpMenuCallbackQuery,
  deps: TelegramDumpMenuCallbackDeps,
): Promise<boolean> {
  const data = query.data;
  if (!data?.startsWith("dump:")) return false;
  if (data === "dump:noop") {
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
    await deps.answerCallbackQuery(query.id, "Dump menu expired. Send /dump again.");
    return true;
  }
  const now = deps.now ?? Date.now;
  const updateState = (next: Partial<TelegramDumpMenuState>) => {
    deps.setState({ ...state, ...next, updatedAt: now() });
  };

  if (data === "dump:refresh" || data === "dump:back:main") {
    const snapshot = deps.getSnapshot();
    const transcript = DumpExport.buildTelegramDumpTranscript(snapshot, state.scope);
    await deps.editDumpMessage(
      chatId,
      messageId,
      buildTelegramDumpMainText(snapshot, state.scope),
      buildTelegramDumpMainReplyMarkup(transcript.stats.selectedMessages > 0),
    );
    updateState({ view: "main" });
    await deps.answerCallbackQuery(query.id, data === "dump:refresh" ? "Refreshed." : undefined);
    return true;
  }

  if (data === "dump:txt") {
    await deps.answerCallbackQuery(query.id, "Sending TXT…");
    try {
      const files = await deps.renderDumpExport(deps.getSnapshot(), state.scope);
      await deps.sendDumpExportFiles(chatId, messageId, files);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.editDumpMessage(
        chatId,
        messageId,
        `<b>🧾 Dump transcript</b>\n\nTXT export failed: ${escapeHtml(message)}`,
        buildTelegramDumpMainReplyMarkup(true),
      );
      updateState({ view: "main" });
    }
    return true;
  }

  if (data === "dump:gist:ask") {
    const snapshot = deps.getSnapshot();
    await deps.editDumpMessage(
      chatId,
      messageId,
      buildTelegramDumpGistConfirmText(snapshot, state.scope),
      buildTelegramDumpGistConfirmReplyMarkup(),
    );
    updateState({ view: "gistConfirm" });
    await deps.answerCallbackQuery(query.id);
    return true;
  }

  if (data === "dump:gist:publish") {
    if (!deps.publishDumpGist) {
      await deps.answerCallbackQuery(query.id, "Gist publishing is not available.");
      return true;
    }
    await deps.answerCallbackQuery(query.id, "Publishing secret Gist…");
    try {
      const result = await deps.publishDumpGist(deps.getSnapshot(), state.scope);
      await deps.editDumpMessage(
        chatId,
        messageId,
        buildTelegramDumpGistPublishedText(result),
        buildTelegramDumpGistPublishedReplyMarkup(result),
      );
      updateState({ view: "gistPublished", publishedGist: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.editDumpMessage(
        chatId,
        messageId,
        `<b>🧾 Dump transcript</b>\n\nGist publish failed: ${escapeHtml(message)}`,
        buildTelegramDumpGistConfirmReplyMarkup(),
      );
      updateState({ view: "gistConfirm" });
    }
    return true;
  }

  if (data === "dump:gist:delete") {
    const gist = state.publishedGist;
    if (!gist) {
      await deps.answerCallbackQuery(query.id, "No published Gist remembered for this menu.");
      return true;
    }
    if (!deps.deleteDumpGist) {
      await deps.answerCallbackQuery(query.id, "Gist deletion is not available.");
      return true;
    }
    await deps.answerCallbackQuery(query.id, "Deleting Gist…");
    try {
      await deps.deleteDumpGist(gist.gistId);
      await deps.editDumpMessage(
        chatId,
        messageId,
        [
          "<b>🧾 Dump transcript</b>",
          "",
          `Deleted Gist <code>${escapeHtml(gist.gistId)}</code>.`,
          "",
          "The raw TXT URL should stop working shortly.",
        ].join("\n"),
        { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "dump:back:main" }]] },
      );
      updateState({ view: "main", publishedGist: undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.editDumpMessage(
        chatId,
        messageId,
        `<b>🧾 Dump transcript</b>\n\nGist delete failed: ${escapeHtml(message)}`,
        buildTelegramDumpGistPublishedReplyMarkup(gist),
      );
    }
    return true;
  }

  await deps.answerCallbackQuery(query.id);
  return true;
}

export async function handleTelegramDumpMenuCallback(
  query: TelegramDumpMenuCallbackQuery,
  deps: TelegramDumpMenuCallbackDeps,
): Promise<boolean> {
  if (!query.data?.startsWith("dump:")) return false;
  let answered = false;
  const safeDeps: TelegramDumpMenuCallbackDeps = {
    ...deps,
    answerCallbackQuery: async (callbackQueryId, text) => {
      await deps.answerCallbackQuery(callbackQueryId, text);
      answered = true;
    },
  };
  try {
    return await handleTelegramDumpMenuCallbackUnsafe(query, safeDeps);
  } catch {
    if (!answered) {
      try {
        await deps.answerCallbackQuery(query.id, "Dump menu update failed. Try /dump.");
      } catch {
        // Keep polling alive even if the callback query has already expired.
      }
    }
    return true;
  }
}

export interface TelegramDumpMenuRuntime<TContext> {
  openDumpMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
    scope?: DumpExport.TelegramDumpScope,
  ) => Promise<void>;
  handleCallbackQuery: (
    query: TelegramDumpMenuCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
}

export interface TelegramDumpMenuRuntimeDeps<TContext> {
  getSnapshot: (ctx: TContext) => DumpExport.TelegramDumpSnapshot;
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "html",
    replyMarkup: TelegramDumpReplyMarkup,
  ) => Promise<number | undefined>;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "html",
    replyMarkup: TelegramDumpReplyMarkup,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  renderDumpExport: (
    snapshot: DumpExport.TelegramDumpSnapshot,
    scope: DumpExport.TelegramDumpScope,
  ) => Promise<DumpExport.TelegramDumpExportFileSet>;
  sendDumpExportFiles: (
    chatId: number,
    replyToMessageId: number,
    files: DumpExport.TelegramDumpExportFileSet,
  ) => Promise<void>;
  publishDumpGist?: (
    snapshot: DumpExport.TelegramDumpSnapshot,
    scope: DumpExport.TelegramDumpScope,
  ) => Promise<DumpExport.TelegramDumpGistPublishResult>;
  deleteDumpGist?: (gistId: string) => Promise<void>;
  store?: TelegramDumpMenuStore;
}

export function createTelegramDumpMenuRuntime<TContext>(
  deps: TelegramDumpMenuRuntimeDeps<TContext>,
): TelegramDumpMenuRuntime<TContext> {
  const store = deps.store ?? createTelegramDumpMenuStore();
  return {
    openDumpMenu(chatId, _replyToMessageId, ctx, scope = {}) {
      return openTelegramDumpMenu({
        chatId,
        scope,
        getSnapshot: () => deps.getSnapshot(ctx),
        sendDumpMenu: (text, replyMarkup) =>
          deps.sendInteractiveMessage(chatId, text, "html", replyMarkup),
        storeState: store.set,
      });
    },
    handleCallbackQuery(query, ctx) {
      return handleTelegramDumpMenuCallback(query, {
        getState: store.get,
        setState: store.set,
        getSnapshot: () => deps.getSnapshot(ctx),
        editDumpMessage: (chatId, messageId, text, replyMarkup) =>
          deps.editInteractiveMessage(chatId, messageId, text, "html", replyMarkup),
        answerCallbackQuery: deps.answerCallbackQuery,
        renderDumpExport: deps.renderDumpExport,
        sendDumpExportFiles: deps.sendDumpExportFiles,
        publishDumpGist: deps.publishDumpGist,
        deleteDumpGist: deps.deleteDumpGist,
      });
    },
  };
}
