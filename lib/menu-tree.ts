/**
 * Telegram tree rewind menu UI helpers
 * Zones: telegram controls, session tree, menu composition
 * Owns the Telegram-native /tree MVP: session-tree listing, entry detail views, and rewind callback dispatch.
 */

import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";

const TELEGRAM_TREE_STATE_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_TREE_PAGE_SIZE = 8;
const TELEGRAM_TREE_SUMMARY_LEN = 42;
const TELEGRAM_TREE_DETAIL_TEXT_LEN = 2600;

export type TelegramTreeReplyMarkup = TelegramInlineKeyboardMarkup;
export type TelegramTreeView = "list" | "detail";
export type TelegramTreeEntryRole =
  | "user"
  | "assistant"
  | "custom"
  | "summary"
  | "other";
export type TelegramTreeFilter = "active" | "branches";

export interface TelegramTreeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
}

export interface TelegramTreeMessage {
  role?: string;
  content?: string | TelegramTreeContentBlock[];
}

export interface TelegramTreeSessionEntry {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  message?: TelegramTreeMessage;
  customType?: string;
  content?: string | TelegramTreeContentBlock[];
  display?: boolean;
  summary?: string;
  label?: string;
}

export interface TelegramTreeSnapshot {
  cwd: string;
  sessionId: string;
  entries: TelegramTreeSessionEntry[];
  branch: TelegramTreeSessionEntry[];
  leafId?: string | null;
}

export interface TelegramTreeMenuEntry {
  index: number;
  entryId: string;
  parentId?: string | null;
  depth: number;
  role: TelegramTreeEntryRole;
  title: string;
  summary: string;
  detail: string;
  active: boolean;
  kind: "prompt" | "branch";
}

export interface TelegramTreeMenuState {
  chatId: number;
  messageId: number;
  entries: TelegramTreeMenuEntry[];
  page: number;
  view: TelegramTreeView;
  filter: TelegramTreeFilter;
  detailIndex?: number;
  updatedAt: number;
}

export interface TelegramTreeMenuStore {
  get(messageId: number | undefined): TelegramTreeMenuState | undefined;
  set(state: TelegramTreeMenuState): void;
  clear(): void;
}

export function createTelegramTreeMenuStore(
  now: () => number = Date.now,
): TelegramTreeMenuStore {
  const states = new Map<number, TelegramTreeMenuState>();
  function pruneExpired(): void {
    const cutoff = now() - TELEGRAM_TREE_STATE_TTL_MS;
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
    .replace(/^\[telegram[^\]]*\]\s*/i, "")
    .replace(/\n\[reply[^\n]*\][\s\S]*$/i, "")
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

function contentText(content: string | TelegramTreeContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function entryRole(entry: TelegramTreeSessionEntry): TelegramTreeEntryRole {
  if (entry.type === "message") {
    if (entry.message?.role === "user") return "user";
    if (entry.message?.role === "assistant") return "assistant";
    return "other";
  }
  if (entry.type === "custom_message" && entry.display !== false) return "custom";
  if (entry.type === "branch_summary" || entry.type === "compaction") return "summary";
  return "other";
}

function entryDetail(entry: TelegramTreeSessionEntry): string {
  if (entry.type === "message") {
    return contentText(entry.message?.content) || `(${entry.message?.role ?? "message"})`;
  }
  if (entry.type === "custom_message") {
    return contentText(entry.content) || `custom: ${entry.customType ?? "message"}`;
  }
  if (typeof entry.summary === "string" && entry.summary.trim()) return entry.summary;
  return entry.label || entry.type;
}

function roleTitle(role: TelegramTreeEntryRole): string {
  switch (role) {
    case "user":
      return "👤 User";
    case "assistant":
      return "🤖 Assistant";
    case "custom":
      return "🧩 Custom";
    case "summary":
      return "📝 Summary";
    case "other":
      return "• Entry";
  }
}

function roleButtonLabel(role: TelegramTreeEntryRole): string {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "asst";
    case "custom":
      return "custom";
    case "summary":
      return "sum";
    case "other":
      return "entry";
  }
}

function includeEntry(entry: TelegramTreeSessionEntry, _filter: TelegramTreeFilter): boolean {
  const role = entryRole(entry);
  return (role === "user" || role === "custom") && entryDetail(entry).trim().length > 0;
}

function entrySortTime(entry: TelegramTreeSessionEntry): number {
  return entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
}

function sortedByTimestamp(entries: TelegramTreeSessionEntry[]): TelegramTreeSessionEntry[] {
  return [...entries].sort((a, b) => {
    const at = entrySortTime(a);
    const bt = entrySortTime(b);
    return at - bt;
  });
}

function buildActivePromptEntries(snapshot: TelegramTreeSnapshot): TelegramTreeMenuEntry[] {
  const result: TelegramTreeMenuEntry[] = [];
  for (const entry of snapshot.branch) {
    const role = entryRole(entry);
    const detail = entryDetail(entry);
    if (!includeEntry(entry, "active")) continue;
    result.push({
      index: result.length,
      entryId: entry.id,
      parentId: entry.parentId,
      depth: 0,
      role,
      title: roleTitle(role),
      summary: truncate(detail, TELEGRAM_TREE_SUMMARY_LEN),
      detail,
      active: snapshot.leafId === entry.id,
      kind: "prompt",
    });
  }
  return result.map((entry, index) => ({ ...entry, index }));
}

function buildBranchEntries(snapshot: TelegramTreeSnapshot): TelegramTreeMenuEntry[] {
  const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry] as const));
  const childIds = new Set(
    snapshot.entries
      .map((entry) => entry.parentId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const activeIds = new Set(snapshot.branch.map((entry) => entry.id));
  const pathToRoot = (leaf: TelegramTreeSessionEntry): TelegramTreeSessionEntry[] => {
    const path: TelegramTreeSessionEntry[] = [];
    const seen = new Set<string>();
    let current: TelegramTreeSessionEntry | undefined = leaf;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      path.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return path.reverse();
  };
  const leaves = snapshot.entries
    .filter((entry) => !childIds.has(entry.id) && entry.id !== snapshot.leafId)
    .sort((a, b) => entrySortTime(a) - entrySortTime(b));
  const result: TelegramTreeMenuEntry[] = [];
  for (const leaf of leaves) {
    const path = pathToRoot(leaf);
    const prompt = path.find((entry) => !activeIds.has(entry.id) && includeEntry(entry, "branches"));
    if (!prompt) continue;
    const role = entryRole(prompt);
    const detail = entryDetail(prompt);
    result.push({
      index: result.length,
      entryId: leaf.id,
      parentId: leaf.parentId,
      depth: 0,
      role,
      title: "🌿 Branch",
      summary: truncate(detail, TELEGRAM_TREE_SUMMARY_LEN),
      detail,
      active: false,
      kind: "branch",
    });
  }
  return result.map((entry, index) => ({ ...entry, index }));
}

export function buildTelegramTreeMenuEntries(
  snapshot: TelegramTreeSnapshot,
  filter: TelegramTreeFilter = "active",
): TelegramTreeMenuEntry[] {
  return filter === "branches" ? buildBranchEntries(snapshot) : buildActivePromptEntries(snapshot);
}

function pageCount(total: number): number {
  return total <= 0 ? 1 : Math.ceil(total / TELEGRAM_TREE_PAGE_SIZE);
}

function clampPage(page: number, total: number): number {
  const count = pageCount(total);
  if (!Number.isInteger(page) || page < 0) return 0;
  if (page >= count) return count - 1;
  return page;
}

function pageSlice<T>(items: readonly T[], page: number): readonly T[] {
  const start = page * TELEGRAM_TREE_PAGE_SIZE;
  return items.slice(start, start + TELEGRAM_TREE_PAGE_SIZE);
}

function formatTreeLine(entry: TelegramTreeMenuEntry): string {
  const marker = entry.active ? "●" : "○";
  const index = String(entry.index + 1).padStart(2, "0");
  const role = entry.kind === "branch" ? "branch" : roleButtonLabel(entry.role);
  const text = entry.summary || "(empty)";
  return `${marker} <code>${escapeHtml(index)}</code> ${escapeHtml(role)}  ${escapeHtml(text)}`;
}

function formatTreeButton(entry: TelegramTreeMenuEntry): string {
  return String(entry.index + 1).padStart(2, "0");
}

export const TELEGRAM_TREE_MENU_TITLE = "<b>🌳 Session tree</b>";

export function buildTelegramTreeListText(
  snapshot: TelegramTreeSnapshot,
  entries: TelegramTreeMenuEntry[],
  page: number,
  filter: TelegramTreeFilter,
): string {
  if (entries.length === 0) {
    return `${TELEGRAM_TREE_MENU_TITLE}\n\nNo visible entries for <code>${escapeHtml(snapshot.cwd)}</code>.`;
  }
  const safePage = clampPage(page, entries.length);
  const count = pageCount(entries.length);
  const start = safePage * TELEGRAM_TREE_PAGE_SIZE;
  const end = Math.min(entries.length, start + TELEGRAM_TREE_PAGE_SIZE);
  const suffix = count > 1 ? ` · Page ${safePage + 1}/${count}` : "";
  const leaf = snapshot.leafId ? snapshot.leafId.slice(0, 8) : "root";
  const body = filter === "branches"
    ? ["Other branches", "Pick a branch to switch to:"]
    : ["Active path · user prompts only", "Pick a prompt to replace:"];
  const visibleEntries = pageSlice(entries, safePage).map(formatTreeLine);
  return [
    `${TELEGRAM_TREE_MENU_TITLE}${suffix}`,
    "",
    `<code>${escapeHtml(snapshot.cwd)}</code>`,
    `Leaf: <code>${escapeHtml(leaf)}</code> · ${start + 1}-${end}/${entries.length}`,
    ...body,
    "",
    ...visibleEntries,
  ].join("\n");
}

export function buildTelegramTreeListReplyMarkup(
  entries: TelegramTreeMenuEntry[],
  page: number,
  filter: TelegramTreeFilter,
): TelegramTreeReplyMarkup {
  const safePage = clampPage(page, entries.length);
  const rows: TelegramTreeReplyMarkup["inline_keyboard"] = [];
  rows.push([
    filter === "branches"
      ? { text: "🟢 Active path", callback_data: "tree:filter:active" }
      : { text: "🌿 Branches", callback_data: "tree:filter:branches" },
  ]);
  const buttonRow: TelegramTreeReplyMarkup["inline_keyboard"][number] = [];
  for (const entry of pageSlice(entries, safePage)) {
    buttonRow.push({ text: formatTreeButton(entry), callback_data: `tree:entry:${entry.index}` });
    if (buttonRow.length === 4) {
      rows.push([...buttonRow]);
      buttonRow.length = 0;
    }
  }
  if (buttonRow.length > 0) rows.push(buttonRow);
  if (entries.length === 0) rows.push([{ text: "(no entries)", callback_data: "tree:noop" }]);
  const count = pageCount(entries.length);
  if (count > 1) {
    const prev = safePage - 1;
    const next = safePage + 1;
    rows.push([
      {
        text: prev >= 0 ? "⬅️ Prev" : "·",
        callback_data: prev >= 0 ? `tree:page:${prev}` : "tree:noop",
      },
      { text: `${safePage + 1}/${count}`, callback_data: "tree:noop" },
      {
        text: next < count ? "Next ➡️" : "·",
        callback_data: next < count ? `tree:page:${next}` : "tree:noop",
      },
    ]);
  }
  return { inline_keyboard: rows };
}

export function buildTelegramTreeDetailText(entry: TelegramTreeMenuEntry): string {
  const rawDetail = entry.detail || "(empty)";
  const truncated = rawDetail.length > TELEGRAM_TREE_DETAIL_TEXT_LEN;
  const detail = truncated
    ? rawDetail.slice(0, TELEGRAM_TREE_DETAIL_TEXT_LEN - 1) + "…"
    : rawDetail;
  return [
    "<b>🌳 Tree entry</b>",
    `${escapeHtml(entry.title)} · #${entry.index + 1} · <code>${escapeHtml(entry.entryId)}</code>`,
    entry.kind === "branch"
      ? "Inactive branch leaf. Switch to jump back to this branch."
      : "Prompt on current branch.",
    "",
    escapeHtml(detail),
    ...(truncated ? ["", "<i>Truncated. Use the session file for full content.</i>"] : []),
  ].join("\n");
}

export function buildTelegramTreeDetailReplyMarkup(
  entry: TelegramTreeMenuEntry,
): TelegramTreeReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "⬅️ Back to tree", callback_data: "tree:back:list" }],
      [
        entry.kind === "branch"
          ? {
              text: "🌿 Switch to this branch",
              callback_data: `tree:switch:${entry.index}`,
            }
          : {
              text: "↩️ Rewind and replace this prompt",
              callback_data: `tree:rewind:${entry.index}:none`,
            },
      ],
    ],
  };
}

function parseIndex(data: string, prefix: string, total: number): number | undefined {
  const raw = data.slice(prefix.length).split(":")[0] ?? "";
  const index = Number.parseInt(raw, 10);
  if (!Number.isInteger(index) || index < 0 || index >= total) return undefined;
  return index;
}

export interface TelegramTreeMenuOpenDeps {
  chatId: number;
  getSnapshot: () => TelegramTreeSnapshot;
  sendTreeMenu: (
    text: string,
    replyMarkup: TelegramTreeReplyMarkup,
  ) => Promise<number | undefined>;
  storeState: (state: TelegramTreeMenuState) => void;
  now?: () => number;
}

export async function openTelegramTreeMenu(
  deps: TelegramTreeMenuOpenDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const snapshot = deps.getSnapshot();
  const filter: TelegramTreeFilter = "active";
  const entries = buildTelegramTreeMenuEntries(snapshot, filter);
  const messageId = await deps.sendTreeMenu(
    buildTelegramTreeListText(snapshot, entries, 0, filter),
    buildTelegramTreeListReplyMarkup(entries, 0, filter),
  );
  if (messageId === undefined) return;
  deps.storeState({
    chatId: deps.chatId,
    messageId,
    entries,
    page: 0,
    view: "list",
    filter,
    updatedAt: now(),
  });
}

export interface TelegramTreeMenuCallbackQuery {
  id: string;
  data?: string;
  message?: { chat?: { id?: number }; message_id?: number };
}

export interface TelegramTreeMenuCallbackDeps {
  getState: (messageId: number | undefined) => TelegramTreeMenuState | undefined;
  setState: (state: TelegramTreeMenuState) => void;
  getSnapshot: () => TelegramTreeSnapshot;
  editTreeMessage: (
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup: TelegramTreeReplyMarkup,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  injectTreeExec: (entryId: string, summarize: boolean) => Promise<void>;
  canNavigate: () => boolean;
  now?: () => number;
}

async function handleTelegramTreeMenuCallbackUnsafe(
  query: TelegramTreeMenuCallbackQuery,
  deps: TelegramTreeMenuCallbackDeps,
): Promise<boolean> {
  const data = query.data;
  if (!data?.startsWith("tree:")) return false;
  if (data === "tree:noop") {
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
    await deps.answerCallbackQuery(query.id, "Tree menu expired. Send /tree again.");
    return true;
  }
  const now = deps.now ?? Date.now;
  const updateState = (next: Partial<TelegramTreeMenuState>) => {
    deps.setState({ ...state, ...next, updatedAt: now() });
  };

  if (data.startsWith("tree:filter:")) {
    const filter: TelegramTreeFilter = data.endsWith(":branches") ? "branches" : "active";
    const snapshot = deps.getSnapshot();
    const entries = buildTelegramTreeMenuEntries(snapshot, filter);
    const page = clampPage(0, entries.length);
    await deps.editTreeMessage(
      chatId,
      messageId,
      buildTelegramTreeListText(snapshot, entries, page, filter),
      buildTelegramTreeListReplyMarkup(entries, page, filter),
    );
    updateState({ entries, page, filter, view: "list", detailIndex: undefined });
    await deps.answerCallbackQuery(query.id);
    return true;
  }

  if (data === "tree:back:list" || data.startsWith("tree:page:")) {
    const requested = data.startsWith("tree:page:")
      ? Number.parseInt(data.slice("tree:page:".length), 10)
      : state.page;
    const page = clampPage(requested, state.entries.length);
    const snapshot = deps.getSnapshot();
    await deps.editTreeMessage(
      chatId,
      messageId,
      buildTelegramTreeListText(snapshot, state.entries, page, state.filter),
      buildTelegramTreeListReplyMarkup(state.entries, page, state.filter),
    );
    updateState({ page, view: "list", detailIndex: undefined });
    await deps.answerCallbackQuery(query.id);
    return true;
  }

  if (data.startsWith("tree:entry:")) {
    const index = parseIndex(data, "tree:entry:", state.entries.length);
    if (index === undefined) {
      await deps.answerCallbackQuery(query.id, "Entry no longer exists.");
      return true;
    }
    const entry = state.entries[index];
    await deps.editTreeMessage(
      chatId,
      messageId,
      buildTelegramTreeDetailText(entry),
      buildTelegramTreeDetailReplyMarkup(entry),
    );
    updateState({
      view: "detail",
      detailIndex: index,
      page: clampPage(Math.floor(index / TELEGRAM_TREE_PAGE_SIZE), state.entries.length),
    });
    await deps.answerCallbackQuery(query.id);
    return true;
  }

  if (data.startsWith("tree:switch:")) {
    const index = parseIndex(data, "tree:switch:", state.entries.length);
    if (index === undefined) {
      await deps.answerCallbackQuery(query.id, "Branch no longer exists.");
      return true;
    }
    if (!deps.canNavigate()) {
      await deps.answerCallbackQuery(
        query.id,
        "Cannot switch while π or Telegram queue is busy.",
      );
      return true;
    }
    const entry = state.entries[index];
    try {
      await deps.injectTreeExec(entry.entryId, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.answerCallbackQuery(query.id, `Switch failed: ${message}`);
      return true;
    }
    await deps.editTreeMessage(
      chatId,
      messageId,
      `${TELEGRAM_TREE_MENU_TITLE}\n\nSwitching to branch leaf <code>${escapeHtml(entry.entryId)}</code>…`,
      { inline_keyboard: [] },
    );
    updateState({ view: "detail", detailIndex: index });
    await deps.answerCallbackQuery(query.id, "Switching…");
    return true;
  }

  if (data.startsWith("tree:rewind:")) {
    const index = parseIndex(data, "tree:rewind:", state.entries.length);
    if (index === undefined) {
      await deps.answerCallbackQuery(query.id, "Entry no longer exists.");
      return true;
    }
    if (!deps.canNavigate()) {
      await deps.answerCallbackQuery(
        query.id,
        "Cannot rewind while π or Telegram queue is busy.",
      );
      return true;
    }
    const entry = state.entries[index];
    const summarize = false;
    try {
      await deps.injectTreeExec(entry.entryId, summarize);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.answerCallbackQuery(query.id, `Rewind failed: ${message}`);
      return true;
    }
    await deps.editTreeMessage(
      chatId,
      messageId,
      `${TELEGRAM_TREE_MENU_TITLE}\n\nRewinding to <code>${escapeHtml(entry.entryId)}</code>${summarize ? " with summary" : ""}…`,
      { inline_keyboard: [] },
    );
    updateState({ view: "detail", detailIndex: index });
    await deps.answerCallbackQuery(query.id, "Rewinding…");
    return true;
  }

  await deps.answerCallbackQuery(query.id);
  return true;
}

export async function handleTelegramTreeMenuCallback(
  query: TelegramTreeMenuCallbackQuery,
  deps: TelegramTreeMenuCallbackDeps,
): Promise<boolean> {
  if (!query.data?.startsWith("tree:")) return false;
  let answered = false;
  const safeDeps: TelegramTreeMenuCallbackDeps = {
    ...deps,
    answerCallbackQuery: async (callbackQueryId, text) => {
      await deps.answerCallbackQuery(callbackQueryId, text);
      answered = true;
    },
  };
  try {
    return await handleTelegramTreeMenuCallbackUnsafe(query, safeDeps);
  } catch {
    if (!answered) {
      try {
        await deps.answerCallbackQuery(query.id, "Tree menu update failed. Try /tree.");
      } catch {
        // Keep polling alive even if the callback query has already expired.
      }
    }
    return true;
  }
}

export interface TelegramTreeMenuRuntime<TContext> {
  openTreeMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  handleCallbackQuery: (
    query: TelegramTreeMenuCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
}

export interface TelegramTreeMenuRuntimeDeps<TContext> {
  getSnapshot: (ctx: TContext) => TelegramTreeSnapshot;
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "html",
    replyMarkup: TelegramTreeReplyMarkup,
  ) => Promise<number | undefined>;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "html",
    replyMarkup: TelegramTreeReplyMarkup,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  injectTreeExec: (entryId: string, summarize: boolean) => Promise<void>;
  canNavigate: (ctx: TContext) => boolean;
  store?: TelegramTreeMenuStore;
}

export function createTelegramTreeMenuRuntime<TContext>(
  deps: TelegramTreeMenuRuntimeDeps<TContext>,
): TelegramTreeMenuRuntime<TContext> {
  const store = deps.store ?? createTelegramTreeMenuStore();
  return {
    openTreeMenu: function openTreeMenuForContext(chatId, _replyToMessageId, ctx) {
      return openTelegramTreeMenu({
        chatId,
        getSnapshot: function getSnapshotForContext() {
          return deps.getSnapshot(ctx);
        },
        sendTreeMenu: function sendTreeMenuForContext(text, replyMarkup) {
          return deps.sendInteractiveMessage(chatId, text, "html", replyMarkup);
        },
        storeState: store.set,
      });
    },
    handleCallbackQuery: function handleTreeCallbackForContext(query, ctx) {
      return handleTelegramTreeMenuCallback(query, {
        getState: store.get,
        setState: store.set,
        getSnapshot: function getSnapshotForCallback() {
          return deps.getSnapshot(ctx);
        },
        editTreeMessage: function editTreeMessageHtml(
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
        injectTreeExec: deps.injectTreeExec,
        canNavigate: function canNavigateWithContext() {
          return deps.canNavigate(ctx);
        },
      });
    },
  };
}

export interface TelegramTreeNavigationGateDeps<TContext> {
  isIdle: (ctx: TContext) => boolean;
  hasPendingMessages: (ctx: TContext) => boolean;
  hasActiveTelegramTurn: () => boolean;
  hasDispatchPending: () => boolean;
  hasQueuedTelegramItems: () => boolean;
  isCompactionInProgress: () => boolean;
}

export function createTelegramTreeNavigationGate<TContext>(
  deps: TelegramTreeNavigationGateDeps<TContext>,
): (ctx: TContext) => boolean {
  return function canNavigateTelegramTree(ctx) {
    return (
      deps.isIdle(ctx) &&
      !deps.hasPendingMessages(ctx) &&
      !deps.hasActiveTelegramTurn() &&
      !deps.hasDispatchPending() &&
      !deps.hasQueuedTelegramItems() &&
      !deps.isCompactionInProgress()
    );
  };
}

export interface TelegramTreeMenuRuntimePiContextDeps<TContext> {
  getSnapshot: (ctx: TContext) => TelegramTreeSnapshot;
  sendInteractiveMessage: TelegramTreeMenuRuntimeDeps<TContext>["sendInteractiveMessage"];
  editInteractiveMessage: TelegramTreeMenuRuntimeDeps<TContext>["editInteractiveMessage"];
  answerCallbackQuery: TelegramTreeMenuRuntimeDeps<TContext>["answerCallbackQuery"];
  injectTreeExec: TelegramTreeMenuRuntimeDeps<TContext>["injectTreeExec"];
  canNavigate: TelegramTreeMenuRuntimeDeps<TContext>["canNavigate"];
}

export function buildTelegramTreeMenuRuntime<TContext>(
  deps: TelegramTreeMenuRuntimePiContextDeps<TContext>,
): TelegramTreeMenuRuntime<TContext> {
  return createTelegramTreeMenuRuntime({
    getSnapshot: deps.getSnapshot,
    sendInteractiveMessage: deps.sendInteractiveMessage,
    editInteractiveMessage: deps.editInteractiveMessage,
    answerCallbackQuery: deps.answerCallbackQuery,
    injectTreeExec: deps.injectTreeExec,
    canNavigate: deps.canNavigate,
  });
}

export type TelegramTreeOutcome =
  | {
      ok: true;
      entryId: string;
      summarize: boolean;
      editorText?: string;
    }
  | { ok: false; entryId: string; summarize: boolean; error: string };

export interface TelegramTreeOutcomeNotifierDeps {
  getAllowedUserId: () => number | undefined;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
  ) => Promise<unknown>;
}

function formatTelegramTreeOutcomeText(outcome: TelegramTreeOutcome): string {
  const head = outcome.entryId ? outcome.entryId.slice(0, 8) : "unknown";
  if (!outcome.ok) return `⚠️ Tree rewind failed (${head}): ${outcome.error}`;
  const summary = outcome.summarize ? " with summary" : "";
  const base = `✅ Rewound to ${head}${summary}.\nSend a new prompt to continue from there.`;
  if (!outcome.editorText?.trim()) return base;
  const text = outcome.editorText.trim();
  const safeText = text.length > 3000 ? text.slice(0, 2999) + "…" : text;
  return `${base}\n\nSelected entry returned prompt text. Telegram cannot prefill π's editor; copy/edit/send if needed:\n\n${safeText}`;
}

export function createTelegramTreeOutcomeNotifier(
  deps: TelegramTreeOutcomeNotifierDeps,
): (outcome: TelegramTreeOutcome) => Promise<void> {
  return async function notifyTelegramTreeOutcome(outcome) {
    const chatId = deps.getAllowedUserId();
    if (typeof chatId !== "number") return;
    try {
      await deps.sendTextReply(chatId, 0, formatTelegramTreeOutcomeText(outcome));
    } catch {
      // best-effort notification only
    }
  };
}
