/**
 * Regression tests for the Telegram tree rewind menu
 * Covers tree flattening, idle navigation gating, callback injection, and outcome notices
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramTreeDetailText,
  buildTelegramTreeMenuEntries,
  buildTelegramTreeListReplyMarkup,
  buildTelegramTreeListText,
  createTelegramTreeMenuStore,
  getTelegramTreeEntryEditorText,
  createTelegramTreeNavigationGate,
  createTelegramTreeOutcomeNotifier,
  handleTelegramTreeMenuCallback,
  type TelegramTreeSnapshot,
} from "../lib/menu-tree.ts";
import { buildTelegramTreeSvg } from "../lib/tree-export.ts";

function createSnapshot(): TelegramTreeSnapshot {
  const user = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "[telegram] first prompt" }] },
  };
  const assistant = {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "first answer" }] },
  };
  const tool = {
    type: "message",
    id: "t1",
    parentId: "a1",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: { role: "toolResult", content: [{ type: "text", text: "tool noise" }] },
  };
  const branchUser = {
    type: "message",
    id: "u2",
    parentId: "a1",
    timestamp: "2026-01-01T00:00:03.000Z",
    message: { role: "user", content: [{ type: "text", text: "second prompt" }] },
  };
  return {
    cwd: "/repo",
    sessionId: "session",
    entries: [user, assistant, tool, branchUser],
    branch: [user, assistant, branchUser],
    leafId: "u2",
  };
}

test("Tree menu entries show active-branch user prompts only", () => {
  const snapshot = createSnapshot();
  const entries = buildTelegramTreeMenuEntries(snapshot);
  assert.deepEqual(
    entries.map((entry) => [entry.entryId, entry.role, entry.depth, entry.active]),
    [
      ["u1", "user", 0, false],
      ["u2", "user", 0, true],
    ],
  );
  assert.equal(entries[0]?.summary, "first prompt");
  const activeMarkup = buildTelegramTreeListReplyMarkup(entries, 0, "active");
  assert.equal(activeMarkup.inline_keyboard.length, 2);
  assert.deepEqual(activeMarkup.inline_keyboard[0], [
    { text: "🌿 Branches", callback_data: "tree:filter:branches" },
  ]);
  const branchMarkup = buildTelegramTreeListReplyMarkup(entries, 0, "branches");
  assert.deepEqual(branchMarkup.inline_keyboard[0], [
    { text: "🟢 Active path", callback_data: "tree:filter:active" },
    { text: "📄 Full SVG", callback_data: "tree:export:svg" },
  ]);
  assert.deepEqual(branchMarkup.inline_keyboard[1], [
    { text: "🌐 Publish Gist", callback_data: "tree:gist:ask" },
  ]);
  assert.match(buildTelegramTreeDetailText(entries[0]!), /first prompt/);
  assert.equal(getTelegramTreeEntryEditorText(snapshot.entries[0]), "[telegram] first prompt");
  assert.equal(getTelegramTreeEntryEditorText(snapshot.entries[1]), undefined);
});

test("Tree menu branch list shows inactive branch leaves", () => {
  const oldUser = {
    type: "message",
    id: "u-old",
    parentId: "a1",
    timestamp: "2026-01-01T00:00:04.000Z",
    message: { role: "user", content: [{ type: "text", text: "old branch prompt" }] },
  };
  const oldAssistant = {
    type: "message",
    id: "a-old",
    parentId: "u-old",
    timestamp: "2026-01-01T00:00:05.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "old answer" }] },
  };
  const snapshot = createSnapshot();
  snapshot.entries.push(oldUser, oldAssistant);
  const entries = buildTelegramTreeMenuEntries(snapshot, "branches");
  assert.deepEqual(
    entries.map((entry) => [entry.entryId, entry.kind, entry.summary]),
    [["a-old", "branch", "old branch prompt"]],
  );
  assert.equal(entries[0]?.forkIndex, 1);
  assert.equal(entries[0]?.forkSummary, "first prompt");
  assert.equal(entries[0]?.activeNextSummary, "second prompt");
  assert.equal(entries[0]?.branchNextSummary, "old branch prompt");
  assert.equal(entries[0]?.branchPromptCount, 1);
  assert.equal(entries[0]?.leafShortId, "a-old");
  const listText = buildTelegramTreeListText(snapshot, entries, 0, "branches");
  assert.match(listText, /fork first prompt/);
  assert.doesNotMatch(listText, /fork #01/);
  assert.match(listText, /🟢 now second prompt/);
  assert.match(listText, /🌿 this old branch prompt/);
  assert.match(buildTelegramTreeDetailText(entries[0]!), /First difference/);
  assert.match(buildTelegramTreeDetailText(entries[0]!), /Leaf id: <code>a-old<\/code>/);
  assert.equal(buildTelegramTreeListReplyMarkup(entries, 0, "branches").inline_keyboard[0]?.[0]?.text, "🟢 Active path");
});

test("Tree navigation gate rejects any busy queue or pi state", () => {
  const gate = createTelegramTreeNavigationGate<{ idle: boolean; pending: boolean }>({
    isIdle: (ctx) => ctx.idle,
    hasPendingMessages: (ctx) => ctx.pending,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
  });
  assert.equal(gate({ idle: true, pending: false }), true);
  assert.equal(gate({ idle: false, pending: false }), false);
  assert.equal(gate({ idle: true, pending: true }), false);
});

test("Tree SVG export callback renders and sends file", async () => {
  const snapshot = createSnapshot();
  const entries = buildTelegramTreeMenuEntries(snapshot);
  const store = createTelegramTreeMenuStore();
  store.set({
    chatId: 7,
    messageId: 99,
    entries,
    page: 0,
    view: "list",
    filter: "active",
    updatedAt: Date.now(),
  });
  const events: string[] = [];
  const handled = await handleTelegramTreeMenuCallback(
    {
      id: "cb",
      data: "tree:export:svg",
      message: { chat: { id: 7 }, message_id: 99 },
    },
    {
      getState: store.get,
      setState: store.set,
      getSnapshot: () => snapshot,
      editTreeMessage: async () => {
        events.push("edit");
      },
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
      injectTreeExec: async () => {},
      canNavigate: () => true,
      renderTreeExport: async (exportSnapshot) => {
        events.push(`render:${exportSnapshot.sessionId}`);
        return {
          svgPath: "/tmp/tree.svg",
          fileBaseName: "tree",
          nodeCount: 2,
          width: 900,
          height: 220,
        };
      },
      sendTreeExportFiles: async (chatId, replyToMessageId, files) => {
        events.push(`send:${chatId}:${replyToMessageId}:${files.fileBaseName}`);
      },
    },
  );
  assert.equal(handled, true);
  assert.deepEqual(events, [
    "answer:Rendering full tree SVG…",
    "render:session",
    "send:7:99:tree",
  ]);
});

test("Tree Gist publish callback confirms privacy and returns raw SVG URL", async () => {
  const snapshot = createSnapshot();
  const entries = buildTelegramTreeMenuEntries(snapshot);
  const store = createTelegramTreeMenuStore();
  store.set({
    chatId: 7,
    messageId: 99,
    entries,
    page: 0,
    view: "list",
    filter: "active",
    updatedAt: Date.now(),
  });
  const events: string[] = [];
  const markups: unknown[] = [];
  const baseDeps = {
    getState: store.get,
    setState: store.set,
    getSnapshot: () => snapshot,
    editTreeMessage: async (_chatId: number, _messageId: number, text: string, markup: unknown) => {
      events.push(`edit:${text.includes("Secret Gists")}:${text.includes("Published secret Gist")}`);
      markups.push(markup);
    },
    answerCallbackQuery: async (_id: string, text?: string) => {
      events.push(`answer:${text ?? ""}`);
    },
    injectTreeExec: async () => {},
    canNavigate: () => true,
  };
  assert.equal(await handleTelegramTreeMenuCallback(
    {
      id: "cb1",
      data: "tree:gist:ask",
      message: { chat: { id: 7 }, message_id: 99 },
    },
    baseDeps,
  ), true);
  assert.equal(await handleTelegramTreeMenuCallback(
    {
      id: "cb2",
      data: "tree:gist:publish",
      message: { chat: { id: 7 }, message_id: 99 },
    },
    {
      ...baseDeps,
      publishTreeGist: async (publishSnapshot) => {
        events.push(`publish:${publishSnapshot.sessionId}`);
        return {
          gistId: "gist123",
          htmlUrl: "https://gist.github.com/eddie/gist123",
          rawUrl: "https://gist.githubusercontent.com/eddie/gist123/raw/tree.svg",
          fileName: "tree.svg",
        };
      },
    },
  ), true);
  assert.deepEqual(events, [
    "edit:true:false",
    "answer:",
    "answer:Publishing secret Gist…",
    "publish:session",
    "edit:false:true",
  ]);
  assert.deepEqual(markups.at(-1), {
    inline_keyboard: [
      [{ text: "🌐 Open SVG", url: "https://gist.githubusercontent.com/eddie/gist123/raw/tree.svg" }],
      [{ text: "📄 Gist page", url: "https://gist.github.com/eddie/gist123" }],
      [{ text: "🗑 Delete Gist", callback_data: "tree:gist:delete" }],
      [{ text: "⬅️ Back to tree", callback_data: "tree:back:list" }],
    ],
  });
});

test("Tree Gist delete callback deletes remembered published gist", async () => {
  const snapshot = createSnapshot();
  const entries = buildTelegramTreeMenuEntries(snapshot);
  const store = createTelegramTreeMenuStore();
  store.set({
    chatId: 7,
    messageId: 99,
    entries,
    page: 0,
    view: "list",
    filter: "active",
    publishedGist: {
      gistId: "abc123",
      htmlUrl: "https://gist.github.com/eddie/abc123",
      rawUrl: "https://gist.githubusercontent.com/eddie/abc123/raw/tree.svg",
      fileName: "tree.svg",
    },
    updatedAt: Date.now(),
  });
  const events: string[] = [];
  const handled = await handleTelegramTreeMenuCallback(
    {
      id: "cb",
      data: "tree:gist:delete",
      message: { chat: { id: 7 }, message_id: 99 },
    },
    {
      getState: store.get,
      setState: store.set,
      getSnapshot: () => snapshot,
      editTreeMessage: async (_chatId, _messageId, text) => {
        events.push(`edit:${text.includes("Deleted Gist")}`);
      },
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
      injectTreeExec: async () => {},
      canNavigate: () => true,
      deleteTreeGist: async (gistId) => {
        events.push(`delete:${gistId}`);
      },
    },
  );
  assert.equal(handled, true);
  assert.deepEqual(events, [
    "answer:Deleting Gist…",
    "delete:abc123",
    "edit:true",
  ]);
  assert.equal(store.get(99)?.publishedGist, undefined);
});

test("Tree SVG export renders prompt nodes and labels", () => {
  const svg = buildTelegramTreeSvg(createSnapshot());
  assert.match(svg, /Session tree/);
  assert.match(svg, /first prompt/);
  assert.match(svg, /second prompt/);
  assert.match(svg, /active path/);
  assert.match(svg, /<circle/);
});

test("Tree callback injects selected prompt without summary", async () => {
  const snapshot = createSnapshot();
  const entries = buildTelegramTreeMenuEntries(snapshot);
  const store = createTelegramTreeMenuStore();
  store.set({
    chatId: 7,
    messageId: 99,
    entries,
    page: 0,
    view: "detail",
    filter: "active",
    detailIndex: 1,
    updatedAt: Date.now(),
  });
  const events: string[] = [];
  const handled = await handleTelegramTreeMenuCallback(
    {
      id: "cb",
      data: "tree:rewind:1:none",
      message: { chat: { id: 7 }, message_id: 99 },
    },
    {
      getState: store.get,
      setState: store.set,
      getSnapshot: () => snapshot,
      editTreeMessage: async (_chatId, _messageId, text) => {
        events.push(`edit:${text.includes("Rewinding")}`);
      },
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
      injectTreeExec: async (entryId, summarize) => {
        events.push(`inject:${entryId}:${summarize}`);
      },
      canNavigate: () => true,
    },
  );
  assert.equal(handled, true);
  assert.deepEqual(events, ["inject:u2:false", "edit:true", "answer:Rewinding…"]);
});

test("Tree outcome notifier includes returned editor text", async () => {
  const sent: string[] = [];
  const notify = createTelegramTreeOutcomeNotifier({
    getAllowedUserId: () => 7,
    sendTextReply: async (_chatId, _replyTo, text) => {
      sent.push(text);
    },
  });
  await notify({ ok: true, entryId: "abcdef12", summarize: false, editorText: "rerun me" });
  assert.match(sent[0] ?? "", /Rewound to abcdef12/);
  assert.match(sent[0] ?? "", /rerun me/);
});
