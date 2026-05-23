/**
 * Regression tests for Telegram /resume menu pagination
 * Covers page slicing, nav rows, callback dispatch, and stable open indices.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  TELEGRAM_RESUME_MENU_PAGE_SIZE,
  type TelegramResumeMenuEntry,
  type TelegramResumeMenuState,
  buildTelegramResumeMenuReplyMarkup,
  buildTelegramResumeMenuText,
  clampTelegramResumeMenuPage,
  countTelegramResumeInactiveBranchLeaves,
  countTelegramResumeVisibleMessages,
  createTelegramResumeMenuStore,
  filterTelegramResumeMenuEntries,
  getTelegramResumeMenuPageCount,
  handleTelegramResumeMenuCallback,
  openTelegramResumeMenu,
  parseTelegramResumeFilterTokens,
  sliceTelegramResumeMenuPage,
} from "../lib/menu-resume.ts";

function makeEntries(n: number): TelegramResumeMenuEntry[] {
  const base = Date.UTC(2025, 0, 1);
  return Array.from({ length: n }, (_unused, i) => ({
    index: i,
    path: `/sessions/s${i}.json`,
    sessionId: `id-${i.toString().padStart(4, "0")}`,
    name: undefined,
    firstMessage: `session ${i}`,
    messageCount: i,
    modified: new Date(base + i * 1000),
  }));
}

test("getTelegramResumeMenuPageCount handles empty and partial pages", () => {
  assert.equal(TELEGRAM_RESUME_MENU_PAGE_SIZE, 20);
  assert.equal(getTelegramResumeMenuPageCount(0), 1);
  assert.equal(getTelegramResumeMenuPageCount(1), 1);
  assert.equal(getTelegramResumeMenuPageCount(TELEGRAM_RESUME_MENU_PAGE_SIZE), 1);
  assert.equal(
    getTelegramResumeMenuPageCount(TELEGRAM_RESUME_MENU_PAGE_SIZE + 1),
    2,
  );
});

test("clampTelegramResumeMenuPage keeps page in range", () => {
  const total = TELEGRAM_RESUME_MENU_PAGE_SIZE * 2 + 3; // 3 pages
  assert.equal(clampTelegramResumeMenuPage(-1, total), 0);
  assert.equal(clampTelegramResumeMenuPage(0, total), 0);
  assert.equal(clampTelegramResumeMenuPage(2, total), 2);
  assert.equal(clampTelegramResumeMenuPage(99, total), 2);
});

test("sliceTelegramResumeMenuPage returns the requested window", () => {
  const entries = makeEntries(TELEGRAM_RESUME_MENU_PAGE_SIZE * 2 + 3);
  const first = sliceTelegramResumeMenuPage(entries, 0);
  const last = sliceTelegramResumeMenuPage(entries, 2);
  assert.equal(first.length, TELEGRAM_RESUME_MENU_PAGE_SIZE);
  assert.equal(first[0].index, 0);
  assert.equal(last.length, 3);
  assert.equal(last[0].index, TELEGRAM_RESUME_MENU_PAGE_SIZE * 2);
});

test("buildTelegramResumeMenuText appends page suffix only when paginated", () => {
  const single = makeEntries(3);
  const many = makeEntries(TELEGRAM_RESUME_MENU_PAGE_SIZE + 1);
  assert.ok(!buildTelegramResumeMenuText(single, "/cwd", 0).includes("Page"));
  const paginated = buildTelegramResumeMenuText(many, "/cwd", 1);
  assert.ok(paginated.includes("Page 2/2"));
  assert.ok(paginated.includes(`${many.length} sessions`));
});

test("parseTelegramResumeFilterTokens splits whitespace filters", () => {
  assert.deepEqual(parseTelegramResumeFilterTokens("  apple   cat mouse  "), [
    "apple",
    "cat",
    "mouse",
  ]);
});

test("filterTelegramResumeMenuEntries searches display title only", () => {
  const entries = makeEntries(5);
  entries[0].name = "Apple Cat";
  entries[0].firstMessage = "unrelated";
  entries[1].name = "Apple";
  entries[1].firstMessage = "cat only in hidden first message";
  entries[2].firstMessage = "cat apple";
  entries[3].firstMessage = "apple dog";
  entries[4].name = "resume + filter";
  entries[4].firstMessage = "quoted darren text";
  entries[4].allMessagesText = "quoted darren text";
  const result = filterTelegramResumeMenuEntries(entries, ["apple", "cat"]);
  assert.deepEqual(
    result.entries.map((entry) => entry.index),
    [0, 2],
  );
  assert.deepEqual(result.trace, [
    { filter: "apple", before: 5, after: 4 },
    { filter: "cat", before: 4, after: 2 },
  ]);
  assert.deepEqual(
    filterTelegramResumeMenuEntries(entries, ["darren"]).entries.map((entry) => entry.index),
    [],
  );
  assert.deepEqual(
    filterTelegramResumeMenuEntries(entries, ["darren"], true).entries.map((entry) => entry.index),
    [4],
  );
});

test("buildTelegramResumeMenuText renders filter summary, highlights matches, and no-match trace", () => {
  const entries = makeEntries(2);
  entries[0].name = "Darren <call>";
  entries[1].firstMessage = "apple cat";
  const trace = [{ filter: "darren", before: 2, after: 1 }];
  const text = buildTelegramResumeMenuText(entries, "/cwd", 0, "open", 0, [], "multi", trace);
  assert.match(text, /🔎 darren · title/);
  assert.match(text, /<b><u>Darren<\/u><\/b> &lt;call&gt;/);
  entries[0].name = "resume + filter";
  entries[0].allMessagesText = "quoted Darren call in hidden session text";
  const fullText = buildTelegramResumeMenuText(entries, "/cwd", 0, "open", 0, [], "multi", trace, true);
  assert.match(fullText, /🔎 darren · full/);
  assert.match(fullText, /↳ quoted <b><u>Darren<\/u><\/b> call/);
  const empty = buildTelegramResumeMenuText([], "/cwd", 0, "open", 0, [], "multi", [
    { filter: "apple", before: 2, after: 1 },
    { filter: "cat", before: 1, after: 0 },
  ]);
  assert.match(empty, /No match/);
  assert.match(empty, /apple 2→1/);
  assert.match(empty, /cat 1→0/);
});

test("openTelegramResumeMenu includes current session as a read-only row", async () => {
  const sessions = [
    {
      path: "/sessions/current.jsonl",
      id: "current-id",
      cwd: "/cwd",
      created: new Date(0),
      modified: new Date(0),
      messageCount: 1,
      firstMessage: "current session headline",
      allMessagesText: "current session body",
    },
    {
      path: "/sessions/other.jsonl",
      id: "other-id",
      cwd: "/cwd",
      created: new Date(0),
      modified: new Date(1),
      messageCount: 2,
      firstMessage: "other session headline",
      allMessagesText: "other session body",
    },
  ];
  let sentText = "";
  let sentMarkup: ReturnType<typeof buildTelegramResumeMenuReplyMarkup> | undefined;
  let stored: TelegramResumeMenuState | undefined;
  await openTelegramResumeMenu({
    chatId: 1,
    getCwd: () => "/cwd",
    getCurrentSessionFile: () => "/sessions/current.jsonl",
    listSessions: async () => sessions,
    sendResumeMenu: async (text, replyMarkup) => {
      sentText = text;
      sentMarkup = replyMarkup;
      return 55;
    },
    storeState: (state) => {
      stored = state;
    },
    now: () => 0,
  });
  assert.deepEqual(stored?.sessions.map((entry) => [entry.path, entry.isCurrent]), [
    ["/sessions/current.jsonl", true],
    ["/sessions/other.jsonl", false],
  ]);
  assert.match(sentText, /🟢 current session headline/);
  assert.equal(sentMarkup?.inline_keyboard[0]?.[0]?.text, "1");
  assert.equal(sentMarkup?.inline_keyboard[0]?.[0]?.callback_data, "resume:open:0");
});

test("openTelegramResumeMenu keeps tab scope while listing global sessions", async () => {
  const sessions = [
    {
      path: "/sessions/current.jsonl",
      id: "current-id",
      cwd: "/cwd",
      created: new Date(0),
      modified: new Date(0),
      messageCount: 1,
      firstMessage: "global session",
      allMessagesText: "global session",
    },
  ];
  let listedSessionDir: string | undefined;
  let stored: TelegramResumeMenuState | undefined;
  await openTelegramResumeMenu({
    chatId: 1,
    getCwd: () => "/cwd",
    getCurrentSessionFile: () => "/host/current.jsonl",
    getSessionScope: () => ({
      kind: "tab",
      tabName: "A",
      sessionDir: "/tabs/A",
      currentSessionFile: "/sessions/current.jsonl",
    }),
    listSessions: async (_cwd, sessionDir) => {
      listedSessionDir = sessionDir;
      return sessions;
    },
    sendResumeMenu: async () => 55,
    storeState: (state) => {
      stored = state;
    },
    now: () => 0,
  });
  assert.equal(listedSessionDir, undefined);
  assert.equal(stored?.sessionScope?.tabName, "A");
  assert.equal(stored?.currentSessionFile, "/sessions/current.jsonl");
  assert.equal(stored?.sessions[0]?.isCurrent, true);
});

test("openTelegramResumeMenu filters before applying menu item cap", async () => {
  const sessions = Array.from({ length: TELEGRAM_RESUME_MENU_PAGE_SIZE * 10 + 1 }, (_unused, i) => ({
    path: `/sessions/s${i}.jsonl`,
    id: `id-${i}`,
    cwd: "/cwd",
    created: new Date(0),
    modified: new Date(0),
    messageCount: 1,
    firstMessage: i === TELEGRAM_RESUME_MENU_PAGE_SIZE * 10 ? "needle cat" : `boring ${i}`,
    allMessagesText: "ignored",
  }));
  let sentText = "";
  let stored: TelegramResumeMenuState | undefined;
  await openTelegramResumeMenu({
    chatId: 1,
    getCwd: () => "/cwd",
    getCurrentSessionFile: () => undefined,
    listSessions: async () => sessions,
    filters: ["needle"],
    sendResumeMenu: async (text) => {
      sentText = text;
      return 55;
    },
    storeState: (state) => {
      stored = state;
    },
    now: () => 0,
  });
  assert.equal(stored?.sessions.length, 1);
  assert.equal(stored?.allSessions?.length, 201);
  assert.equal(stored?.sessions[0]?.path, "/sessions/s200.jsonl");
  assert.deepEqual(stored?.filterTrace, [{ filter: "needle", before: 201, after: 1 }]);
  assert.match(sentText, /🔎 needle/);
  assert.match(sentText, /<b><u>needle<\/u><\/b> cat/);
});

test("buildTelegramResumeMenuText renders two-line list items", () => {
  const entries = makeEntries(20);
  entries[0].modified = new Date(Date.UTC(2025, 0, 1, 10));
  entries[0].messageCount = 14;
  entries[0].inactiveBranchCount = 2;
  entries[0].firstMessage = "Fix telegram resume UI";
  entries[1].modified = new Date(Date.UTC(2025, 0, 1, 7));
  entries[1].messageCount = 8;
  entries[1].inactiveBranchCount = 0;
  entries[1].firstMessage = "k8s registry debug";
  entries[19].firstMessage = "twentieth session";
  const now = Date.UTC(2025, 0, 1, 12);
  const text = buildTelegramResumeMenuText(entries, "/cwd", 0, "open", now);
  assert.match(
    text,
    /①\uFE0E <code>2h · 14msg · 🌿2<\/code>\nFix telegram resume UI/,
  );
  assert.match(
    text,
    /②\uFE0E <code>5h · 8msg<\/code>\nk8s registry debug/,
  );
  assert.match(text, /⑳\uFE0E <code>11h · 19msg<\/code>\ntwentieth session/);
});

test("countTelegramResumeInactiveBranchLeaves counts inactive leaves only", () => {
  const fileEntries = [
    { type: "session", id: "session-id" },
    { type: "message", id: "root", parentId: null },
    { type: "message", id: "main-1", parentId: "root" },
    { type: "message", id: "old-branch", parentId: "root" },
    { type: "message", id: "main-2", parentId: "main-1" },
  ];
  assert.equal(countTelegramResumeInactiveBranchLeaves(fileEntries), 1);
});

test("countTelegramResumeInactiveBranchLeaves ignores old flat sessions", () => {
  const fileEntries = [
    { type: "session", id: "session-id" },
    { type: "message", id: "old-1" },
    { type: "message", id: "old-2" },
  ];
  assert.equal(countTelegramResumeInactiveBranchLeaves(fileEntries), 0);
});

test("countTelegramResumeVisibleMessages excludes thinking, tool calls, and tool results", () => {
  const fileEntries = [
    { type: "session", id: "session-id" },
    { type: "model_change", id: "model" },
    {
      type: "message",
      id: "user-1",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      type: "message",
      id: "assistant-tool-call",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "toolCall", name: "bash", arguments: {} },
        ],
      },
    },
    {
      type: "message",
      id: "tool-result",
      message: { role: "toolResult", content: [{ type: "text", text: "stdout" }] },
    },
    {
      type: "message",
      id: "assistant-text",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "text", text: "visible answer" },
        ],
      },
    },
    {
      type: "message",
      id: "assistant-empty",
      message: { role: "assistant", content: [{ type: "text", text: "   " }] },
    },
    {
      type: "message",
      id: "user-2",
      message: { role: "user", content: [{ type: "image", url: "file://img.png" }] },
    },
  ];
  assert.equal(countTelegramResumeVisibleMessages(fileEntries), 3);
});

test("buildTelegramResumeMenuText shows delete selections in body rows", () => {
  const entries = makeEntries(2);
  const now = Date.UTC(2025, 0, 1, 1);
  const text = buildTelegramResumeMenuText(
    entries,
    "/cwd",
    0,
    "delete",
    now,
    ["/sessions/s1.json"],
  );
  assert.match(text, /Current session cannot be deleted\./);
  assert.match(text, /Selected: 1/);
  assert.match(text, /☐ ①\uFE0E <code>1h · 0msg<\/code>/);
  assert.match(text, /☑ ②\uFE0E <code>59m · 1msg<\/code>/);
});

test("buildTelegramResumeMenuReplyMarkup keeps page-1 open index stable and adds nav row", () => {
  const total = TELEGRAM_RESUME_MENU_PAGE_SIZE * 2 + 1; // 3 pages
  const entries = makeEntries(total);
  const page1 = buildTelegramResumeMenuReplyMarkup(entries, 0, 1);
  // Last row: nav; preceding rows: compact page-local numeric buttons.
  const rows = page1.inline_keyboard;
  const navRow = rows[rows.length - 1];
  assert.ok(!rows.flat().some((button) => button.text.includes("Main menu")));
  assert.ok(!rows.flat().some((button) => button.callback_data === "resume:mode:delete"));
  assert.equal(navRow.length, 3);
  assert.equal(navRow[0].callback_data, "resume:page:0");
  assert.equal(navRow[1].callback_data, "resume:noop");
  assert.equal(navRow[1].text, "2/3");
  assert.equal(navRow[2].callback_data, "resume:page:2");
  assert.ok(rows.flat().some((button) => button.callback_data === "resume:manage"));
  const firstEntryRow = rows[0];
  assert.equal(firstEntryRow.length, 4);
  assert.equal(firstEntryRow[0].text, "1");
  assert.equal(
    firstEntryRow[0].callback_data,
    `resume:open:${TELEGRAM_RESUME_MENU_PAGE_SIZE}`,
  );
});

test("buildTelegramResumeMenuReplyMarkup uses compact checkbox index buttons in delete mode", () => {
  const entries = makeEntries(3);
  const markup = buildTelegramResumeMenuReplyMarkup(
    entries,
    0,
    0,
    "delete",
    ["/sessions/s1.json"],
  );
  const rows = markup.inline_keyboard;
  assert.equal(rows[0][0].callback_data, "delete:delete-selected");
  assert.equal(rows[1][0].callback_data, "delete:select-page");
  assert.equal(rows[1][1].callback_data, "delete:clear-selected");
  assert.equal(rows[2].length, 3);
  assert.equal(rows[2][0].callback_data, "delete:select:0");
  assert.equal(rows[2][0].text, "☐1");
  assert.equal(rows[2][1].callback_data, "delete:select:1");
  assert.equal(rows[2][1].text, "☑2");
});

test("buildTelegramResumeMenuReplyMarkup uses standalone multi-select delete controls", () => {
  const entries = makeEntries(3);
  const markup = buildTelegramResumeMenuReplyMarkup(
    entries,
    0,
    0,
    "delete",
    [],
    "multi",
    "resume",
  );
  const rows = markup.inline_keyboard;
  assert.equal(rows[0][0].callback_data, "delete:select-page");
  assert.ok(!rows.flat().some((button) => button.callback_data.startsWith("resume:")));
  assert.equal(rows[2][0].callback_data, "delete:cancel-menu");
  assert.equal(rows[2][0].text, "Done");
});

test("buildTelegramResumeMenuReplyMarkup uses single-select delete buttons", () => {
  const entries = makeEntries(3);
  const text = buildTelegramResumeMenuText(
    entries,
    "/cwd",
    0,
    "delete",
    Date.UTC(2025, 0, 1, 1),
    [],
    "single",
  );
  const markup = buildTelegramResumeMenuReplyMarkup(
    entries,
    0,
    0,
    "delete",
    [],
    "single",
  );
  const rows = markup.inline_keyboard;
  assert.match(text, /<b>🗑 Delete session<\/b>/);
  assert.match(text, /Pick a session to delete:/);
  assert.ok(!text.includes("☐"));
  assert.equal(rows[0][0].callback_data, "delete:delete:0");
  assert.equal(rows[0][0].text, "1");
  assert.equal(rows[1][0].callback_data, "delete:cancel-menu");
});

test("buildTelegramResumeMenuReplyMarkup hides Prev on first / Next on last page", () => {
  const entries = makeEntries(TELEGRAM_RESUME_MENU_PAGE_SIZE + 1); // 2 pages
  const first = buildTelegramResumeMenuReplyMarkup(entries, 0, 0);
  const firstNav = first.inline_keyboard[first.inline_keyboard.length - 1];
  assert.equal(firstNav[0].callback_data, "resume:noop");
  assert.equal(firstNav[2].callback_data, "resume:page:1");
  const last = buildTelegramResumeMenuReplyMarkup(entries, 0, 1);
  const lastNav = last.inline_keyboard[last.inline_keyboard.length - 1];
  assert.equal(lastNav[0].callback_data, "resume:page:0");
  assert.equal(lastNav[2].callback_data, "resume:noop");
});

test("buildTelegramResumeMenuReplyMarkup omits nav row when single page", () => {
  const entries = makeEntries(3);
  const markup = buildTelegramResumeMenuReplyMarkup(entries, 0, 0);
  // Just compact index rows; no nav row appended.
  const flat = markup.inline_keyboard.flat();
  assert.ok(!flat.some((b) => b.text.includes("Main menu")));
  assert.ok(!flat.some((b) => b.callback_data.startsWith("resume:page:")));
});

test("buildTelegramResumeMenuReplyMarkup adds full-text toggle for filtered resume menus", () => {
  const entries = makeEntries(1);
  const off = buildTelegramResumeMenuReplyMarkup(entries, 0, 0, "open", [], "multi", "resume", ["darren"], false);
  assert.deepEqual(off.inline_keyboard.at(-1), [
    { text: "Full text: off", callback_data: "resume:fulltext:toggle" },
  ]);
  const on = buildTelegramResumeMenuReplyMarkup(entries, 0, 0, "open", [], "multi", "resume", ["darren"], true);
  assert.deepEqual(on.inline_keyboard.at(-1), [
    { text: "Full text: ON", callback_data: "resume:fulltext:toggle" },
  ]);
});

function makeState(
  total: number,
  page = 0,
): TelegramResumeMenuState {
  return {
    chatId: 1,
    messageId: 100,
    sessions: makeEntries(total),
    page,
    currentSessionFile: undefined,
    updatedAt: 0,
  };
}

function makeCallbackDeps(
  state: TelegramResumeMenuState,
  getCurrentSessionFile = () => state.currentSessionFile,
) {
  const store = createTelegramResumeMenuStore(() => 1);
  store.set(state);
  const events: string[] = [];
  return {
    store,
    events,
    deps: {
      getState: store.get,
      setState: store.set,
      getCwd: () => "/cwd",
      getCurrentSessionFile,
      editResumeMessage: async (
        chatId: number,
        messageId: number,
        text: string,
      ) => {
        const kind = text.includes("Delete ") && text.includes("selected session")
          ? "confirm"
          : text.includes("Select sessions to delete:")
            ? "delete-list"
            : text.includes("Page")
              ? "paged"
              : "plain";
        events.push(`edit:${chatId}:${messageId}:${kind}`);
      },
      answerCallbackQuery: async (id: string, text?: string) => {
        events.push(`answer:${id}:${text ?? ""}`);
      },
      injectResumeExec: async (
        path: string,
        scope?: { tabName?: string },
      ) => {
        events.push(
          scope?.tabName ? `inject:${path}:${scope.tabName}` : `inject:${path}`,
        );
      },
      deleteSessionFile: async (path: string) => {
        events.push(`delete:${path}`);
      },
      now: () => 2,
    },
  };
}

test("handleTelegramResumeMenuCallback opens manage mode from /resume", async () => {
  const state = makeState(3, 0);
  const { store, events, deps } = makeCallbackDeps(state);
  const handled = await handleTelegramResumeMenuCallback(
    {
      id: "manage",
      data: "resume:manage",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.equal(handled, true);
  assert.deepEqual(events, ["edit:1:100:delete-list", "answer:manage:"]);
  const updated = store.get(100);
  assert.equal(updated?.mode, "delete");
  assert.equal(updated?.source, "resume");
  assert.deepEqual(updated?.selectedDeletePaths, []);
});

test("handleTelegramResumeMenuCallback returns from resume manage mode", async () => {
  const state = makeState(3, 0);
  state.mode = "delete";
  state.source = "resume";
  const { store, events, deps } = makeCallbackDeps(state);
  const handled = await handleTelegramResumeMenuCallback(
    {
      id: "done",
      data: "delete:cancel-menu",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.equal(handled, true);
  assert.deepEqual(events, ["edit:1:100:plain", "answer:done:Done."]);
  const updated = store.get(100);
  assert.equal(updated?.mode, "open");
  assert.equal(updated?.source, "resume");
});

test("handleTelegramResumeMenuCallback paginates and updates state", async () => {
  const state = makeState(TELEGRAM_RESUME_MENU_PAGE_SIZE * 2 + 1, 0);
  const { store, events, deps } = makeCallbackDeps(state);
  const handled = await handleTelegramResumeMenuCallback(
    {
      id: "cb1",
      data: "resume:page:1",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.equal(handled, true);
  assert.deepEqual(events, ["edit:1:100:paged", "answer:cb1:"]);
  const updated = store.get(100);
  assert.equal(updated?.page, 1);
  assert.equal(updated?.updatedAt, 2);
});

test("handleTelegramResumeMenuCallback clamps out-of-range page requests", async () => {
  const state = makeState(TELEGRAM_RESUME_MENU_PAGE_SIZE + 1, 0);
  const { store, deps } = makeCallbackDeps(state);
  await handleTelegramResumeMenuCallback(
    {
      id: "cb2",
      data: "resume:page:99",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.equal(store.get(100)?.page, 1);
});

test("handleTelegramResumeMenuCallback no-ops when page is unchanged", async () => {
  const state = makeState(TELEGRAM_RESUME_MENU_PAGE_SIZE + 1, 1);
  const { events, deps } = makeCallbackDeps(state);
  await handleTelegramResumeMenuCallback(
    {
      id: "cb3",
      data: "resume:page:1",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.deepEqual(events, ["answer:cb3:"]);
});

test("handleTelegramResumeMenuCallback toggles full-text search from cached sessions", async () => {
  const allSessions = makeEntries(2);
  allSessions[0].name = "visible needle";
  allSessions[1].name = "hidden title";
  allSessions[1].allMessagesText = "needle only appears later";
  const state: TelegramResumeMenuState = {
    chatId: 1,
    messageId: 100,
    sessions: [allSessions[0]],
    allSessions,
    page: 0,
    currentSessionFile: undefined,
    filters: ["needle"],
    fullTextSearch: false,
    filterTrace: [{ filter: "needle", before: 2, after: 1 }],
    updatedAt: 0,
  };
  const { store, events, deps } = makeCallbackDeps(state);
  await handleTelegramResumeMenuCallback(
    {
      id: "full",
      data: "resume:fulltext:toggle",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  const updated = store.get(100);
  assert.equal(updated?.fullTextSearch, true);
  assert.deepEqual(updated?.sessions.map((entry) => entry.path), [
    "/sessions/s0.json",
    "/sessions/s1.json",
  ]);
  assert.deepEqual(updated?.filterTrace, [{ filter: "needle", before: 2, after: 2 }]);
  assert.deepEqual(events, ["edit:1:100:plain", "answer:full:Full text search on."]);
});

test("handleTelegramResumeMenuCallback opens entry using global index", async () => {
  const state = makeState(TELEGRAM_RESUME_MENU_PAGE_SIZE * 2 + 1, 1);
  const { events, deps } = makeCallbackDeps(state);
  const globalIndex = TELEGRAM_RESUME_MENU_PAGE_SIZE; // first entry on page 1
  await handleTelegramResumeMenuCallback(
    {
      id: "cb4",
      data: `resume:open:${globalIndex}`,
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.deepEqual(events, [
    `inject:/sessions/s${globalIndex}.json`,
    "edit:1:100:plain",
    "answer:cb4:Session switching…",
  ]);
});

test("handleTelegramResumeMenuCallback resumes through captured tab scope", async () => {
  const state = makeState(3, 0);
  state.sessionScope = {
    kind: "tab",
    tabName: "A",
    sessionDir: "/tabs/A",
    currentSessionFile: "/sessions/s0.json",
  };
  const { events, deps } = makeCallbackDeps(
    state,
    () => "/host/current.jsonl",
  );
  await handleTelegramResumeMenuCallback(
    {
      id: "tab-open",
      data: "resume:open:1",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.deepEqual(events, [
    "inject:/sessions/s1.json:A",
    "edit:1:100:plain",
    "answer:tab-open:Session switching…",
  ]);
});

test("handleTelegramResumeMenuCallback refuses to resume the current session", async () => {
  const state = makeState(3, 0);
  state.currentSessionFile = "/sessions/s1.json";
  const { events, deps } = makeCallbackDeps(state);
  await handleTelegramResumeMenuCallback(
    {
      id: "current-open",
      data: "resume:open:1",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.deepEqual(events, ["answer:current-open:This is the current session; can't switch."]);
});

test("handleTelegramResumeMenuCallback rejects invalid open index", async () => {
  const state = makeState(3, 0);
  const { events, deps } = makeCallbackDeps(state);
  await handleTelegramResumeMenuCallback(
    {
      id: "cb5",
      data: "resume:open:99",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.deepEqual(events, ["answer:cb5:Invalid selection."]);
});

test("handleTelegramResumeMenuCallback toggles fake checkbox selection", async () => {
  const state = makeState(3, 0);
  state.mode = "delete";
  state.source = "delete";
  const { store, events, deps } = makeCallbackDeps(state);
  await handleTelegramResumeMenuCallback(
    {
      id: "sel",
      data: "delete:select:1",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.deepEqual(events, ["edit:1:100:delete-list", "answer:sel:Selected."]);
  assert.deepEqual(store.get(100)?.selectedDeletePaths, ["/sessions/s1.json"]);
  await handleTelegramResumeMenuCallback(
    {
      id: "unsel",
      data: "delete:select:1",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.deepEqual(store.get(100)?.selectedDeletePaths, []);
});

test("handleTelegramResumeMenuCallback selects only the current delete page", async () => {
  const state = makeState(TELEGRAM_RESUME_MENU_PAGE_SIZE + 5, 1);
  state.mode = "delete";
  state.source = "delete";
  state.currentSessionFile = "/sessions/s21.json";
  state.selectedDeletePaths = ["/sessions/s0.json"];
  const { store, events, deps } = makeCallbackDeps(state);
  await handleTelegramResumeMenuCallback(
    {
      id: "select-page",
      data: "delete:select-page",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.deepEqual(events, ["edit:1:100:delete-list", "answer:select-page:Page selected."]);
  assert.deepEqual(store.get(100)?.selectedDeletePaths, [
    "/sessions/s0.json",
    "/sessions/s20.json",
    "/sessions/s22.json",
    "/sessions/s23.json",
    "/sessions/s24.json",
  ]);
});

test("handleTelegramResumeMenuCallback opens selected delete confirmation", async () => {
  const state = makeState(3, 0);
  state.mode = "delete";
  state.source = "delete";
  state.selectedDeletePaths = ["/sessions/s1.json", "/sessions/s2.json"];
  const { events, deps } = makeCallbackDeps(state);
  await handleTelegramResumeMenuCallback(
    {
      id: "del",
      data: "delete:delete-selected",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.deepEqual(events, ["edit:1:100:confirm", "answer:del:"]);
});

test("handleTelegramResumeMenuCallback cancels delete confirmation", async () => {
  const state = makeState(3, 0);
  state.mode = "delete";
  state.source = "delete";
  const { events, deps } = makeCallbackDeps(state);
  await handleTelegramResumeMenuCallback(
    {
      id: "cancel",
      data: "delete:cancel-delete",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.deepEqual(events, ["edit:1:100:delete-list", "answer:cancel:Cancelled."]);
});

test("handleTelegramResumeMenuCallback ignores removed /resume delete mode callbacks", async () => {
  const state = makeState(3, 0);
  const { store, events, deps } = makeCallbackDeps(state);
  await handleTelegramResumeMenuCallback(
    {
      id: "mode",
      data: "resume:mode:delete",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.deepEqual(events, ["answer:mode:"]);
  assert.equal(store.get(100)?.mode, undefined);
});

test("handleTelegramResumeMenuCallback deletes selected sessions and reindexes rows", async () => {
  const state = makeState(4, 0);
  state.mode = "delete";
  state.source = "delete";
  state.selectedDeletePaths = ["/sessions/s1.json", "/sessions/s3.json"];
  const { store, events, deps } = makeCallbackDeps(state);
  await handleTelegramResumeMenuCallback(
    {
      id: "confirm",
      data: "delete:confirm-delete-selected",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.deepEqual(events, [
    "delete:/sessions/s1.json",
    "delete:/sessions/s3.json",
    "edit:1:100:delete-list",
    "answer:confirm:2 sessions deleted.",
  ]);
  const updated = store.get(100);
  assert.equal(updated?.sessions.length, 2);
  assert.equal(updated?.mode, "delete");
  assert.deepEqual(updated?.selectedDeletePaths, []);
  assert.deepEqual(
    updated?.sessions.map((entry) => [entry.index, entry.path]),
    [
      [0, "/sessions/s0.json"],
      [1, "/sessions/s2.json"],
    ],
  );
});

test("handleTelegramResumeMenuCallback refuses to delete current session", async () => {
  const state = makeState(3, 0);
  state.mode = "delete";
  state.source = "delete";
  state.currentSessionFile = "/sessions/s1.json";
  state.selectedDeletePaths = ["/sessions/s1.json"];
  const { events, deps } = makeCallbackDeps(state);
  await handleTelegramResumeMenuCallback(
    {
      id: "current",
      data: "delete:confirm-delete-selected",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.deepEqual(events, ["answer:current:Can't delete current session."]);
});

test("handleTelegramResumeMenuCallback checks the live current session before delete", async () => {
  const state = makeState(3, 0);
  state.mode = "delete";
  state.source = "delete";
  const { events, deps } = makeCallbackDeps(
    state,
    () => "/sessions/s1.json",
  );
  await handleTelegramResumeMenuCallback(
    {
      id: "live-current",
      data: "delete:delete:1",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.deepEqual(events, ["answer:live-current:Can't delete current session."]);
});

test("handleTelegramResumeMenuCallback opens single delete confirmation", async () => {
  const state = makeState(3, 0);
  state.mode = "delete";
  state.source = "delete";
  state.deleteStyle = "single";
  const { store, events, deps } = makeCallbackDeps(state);
  await handleTelegramResumeMenuCallback(
    {
      id: "single",
      data: "delete:delete:1",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.deepEqual(events, ["edit:1:100:plain", "answer:single:"]);
  assert.deepEqual(store.get(100)?.selectedDeletePaths, ["/sessions/s1.json"]);
  assert.equal(store.get(100)?.deleteStyle, "single");
});

test("handleTelegramResumeMenuCallback deletes one session with success actions", async () => {
  const state = makeState(3, 0);
  state.mode = "delete";
  state.source = "delete";
  state.deleteStyle = "single";
  state.selectedDeletePaths = ["/sessions/s1.json"];
  const { store, events, deps } = makeCallbackDeps(state);
  await handleTelegramResumeMenuCallback(
    {
      id: "confirm-single",
      data: "delete:confirm-delete:1",
      message: { chat: { id: 1 }, message_id: 100 },
    },
    deps,
  );
  assert.deepEqual(events, [
    "delete:/sessions/s1.json",
    "edit:1:100:plain",
    "answer:confirm-single:1 session deleted.",
  ]);
  const updated = store.get(100);
  assert.equal(updated?.sessions.length, 2);
  assert.equal(updated?.deleteStyle, "single");
  assert.deepEqual(
    updated?.sessions.map((entry) => [entry.index, entry.path]),
    [
      [0, "/sessions/s0.json"],
      [1, "/sessions/s2.json"],
    ],
  );
});
