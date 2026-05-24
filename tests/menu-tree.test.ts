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
  handleTelegramTreeMenuTextMessage,
  openTelegramTreeMenu,
  TELEGRAM_TREE_BRANCH_METADATA_CUSTOM_TYPE,
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
  assert.equal(buildTelegramTreeListReplyMarkup(entries, 0, "branches").inline_keyboard[2]?.[0]?.text, "a-old");
  snapshot.entries.push({
    type: "label",
    id: "label-old",
    parentId: "u2",
    targetId: "a-old",
    label: "legacy branch",
    timestamp: "2026-01-01T00:00:06.000Z",
  });
  const namedEntries = buildTelegramTreeMenuEntries(snapshot, "branches");
  assert.equal(namedEntries[0]?.branchName, "legacy branch");
  assert.equal(buildTelegramTreeListReplyMarkup(namedEntries, 0, "branches").inline_keyboard[2]?.[0]?.text, "legacy branch");
  const listText = buildTelegramTreeListText(snapshot, entries, 0, "branches");
  assert.match(listText, /Branches grouped by fork point/);
  assert.match(listText, /① first prompt/);
  assert.match(listText, /│ now second prompt/);
  assert.match(listText, /│ <code>01<\/code> ❸ \+1 old branch prompt/);
  assert.doesNotMatch(listText, /fork #01/);
  assert.match(buildTelegramTreeDetailText(entries[0]!), /First difference/);
  assert.match(buildTelegramTreeDetailText(entries[0]!), /Leaf id: <code>a-old<\/code>/);
  assert.equal(buildTelegramTreeListReplyMarkup(entries, 0, "branches").inline_keyboard[0]?.[0]?.text, "🟢 Active path");
});

test("Tree menu branch delete metadata hides inactive leaves", () => {
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
  snapshot.entries.push(oldUser, oldAssistant, {
    type: "custom",
    id: "delete-old",
    parentId: "u2",
    customType: TELEGRAM_TREE_BRANCH_METADATA_CUSTOM_TYPE,
    data: { leafId: "a-old", deleted: true },
    timestamp: "2026-01-01T00:00:06.000Z",
  });
  assert.deepEqual(buildTelegramTreeMenuEntries(snapshot, "branches"), []);
  const svg = buildTelegramTreeSvg(snapshot);
  assert.doesNotMatch(svg, /old branch prompt/);
});

test("Tree menu opens branches when a branch cursor leaves active path empty", async () => {
  const snapshot: TelegramTreeSnapshot = {
    cwd: "/repo",
    sessionId: "session",
    entries: [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "first prompt" }] },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      },
      {
        type: "custom",
        id: "cursor",
        parentId: null,
        timestamp: "2026-01-01T00:00:02.000Z",
        customType: "pi-telegram:tree-branch-cursor",
      },
    ],
    branch: [
      {
        type: "custom",
        id: "cursor",
        parentId: null,
        timestamp: "2026-01-01T00:00:02.000Z",
        customType: "pi-telegram:tree-branch-cursor",
      },
    ],
    leafId: "cursor",
  };
  const events: string[] = [];
  const store = createTelegramTreeMenuStore();
  await openTelegramTreeMenu({
    chatId: 7,
    getSnapshot: () => snapshot,
    sendTreeMenu: async (text, markup) => {
      events.push(text.includes("Branches grouped by fork point") ? "branches" : "active");
      const button = markup.inline_keyboard[0]?.[0];
      events.push(button && "callback_data" in button ? button.callback_data : "");
      return 99;
    },
    storeState: store.set,
  });

  assert.deepEqual(events, ["branches", "tree:filter:active"]);
  assert.equal(store.get(99)?.filter, "branches");
});

test("Tree branch rename reply labels the branch and refreshes detail", async () => {
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
  const store = createTelegramTreeMenuStore();
  store.set({
    chatId: 7,
    messageId: 99,
    entries,
    page: 0,
    view: "detail",
    filter: "branches",
    detailIndex: 0,
    pendingRename: { entryIndex: 0, entryId: "a-old" },
    updatedAt: Date.now(),
  });
  const events: string[] = [];
  const handled = await handleTelegramTreeMenuTextMessage(
    {
      chat: { id: 7 },
      message_id: 123,
      text: "prod fix",
      reply_to_message: { message_id: 99 },
    },
    {
      getState: store.get,
      setState: store.set,
      getSnapshot: () => snapshot,
      editTreeMessage: async (_chatId, _messageId, text) => {
        events.push(`edit:${text.includes("prod fix")}`);
      },
      sendTextReply: async (_chatId, _replyTo, text) => {
        events.push(`reply:${text}`);
      },
      setBranchName: (_entryId, name) => {
        snapshot.entries.push({
          type: "label",
          id: "label-old",
          parentId: "u2",
          targetId: "a-old",
          label: name,
          timestamp: "2026-01-01T00:00:06.000Z",
        });
      },
    },
  );
  assert.equal(handled, true);
  assert.deepEqual(events, ["edit:true", "reply:✅ Branch renamed: prod fix"]);
  assert.equal(store.get(99)?.pendingRename, undefined);
});

test("Tree branch text groups sibling leaves by fork point", () => {
  const snapshot = createSnapshot();
  const oldUserA = {
    type: "message",
    id: "u-old-a",
    parentId: "a1",
    timestamp: "2026-01-01T00:00:04.000Z",
    message: { role: "user", content: [{ type: "text", text: "old branch A" }] },
  };
  const oldUserB = {
    type: "message",
    id: "u-old-b",
    parentId: "a1",
    timestamp: "2026-01-01T00:00:05.000Z",
    message: { role: "user", content: [{ type: "text", text: "old branch B" }] },
  };
  const rootAlt = {
    type: "message",
    id: "u-root-alt",
    parentId: null,
    timestamp: "2026-01-01T00:00:06.000Z",
    message: { role: "user", content: [{ type: "text", text: "alternate root" }] },
  };
  snapshot.entries.push(oldUserA, oldUserB, rootAlt);
  const entries = buildTelegramTreeMenuEntries(snapshot, "branches");
  assert.deepEqual(entries.map((entry) => entry.entryId), ["u-root-alt", "u-old-a", "u-old-b"]);
  const listText = buildTelegramTreeListText(snapshot, entries, 0, "branches");
  assert.match(listText, /root root/);
  assert.equal((listText.match(/① first prompt/g) ?? []).length, 1);
  assert.match(listText, /│ <code>02<\/code> ❸ \+1 old branch A/);
  assert.match(listText, /│ <code>03<\/code> ❹ \+1 old branch B/);
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

test("Tree menu read-only mode hides and blocks mutation callbacks", async () => {
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
  const baseDeps = {
    getState: store.get,
    setState: store.set,
    getSnapshot: () => snapshot,
    isReadOnly: () => true,
    injectTreeExec: async () => {
      events.push("inject");
    },
    canNavigate: () => true,
  };
  const handledEntry = await handleTelegramTreeMenuCallback(
    {
      id: "cb-entry",
      data: "tree:entry:1",
      message: { chat: { id: 7 }, message_id: 99 },
    },
    {
      ...baseDeps,
      editTreeMessage: async (_chatId, _messageId, _text, markup) => {
        events.push(`edit:${markup.inline_keyboard.length}`);
      },
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
    },
  );
  const handledRewind = await handleTelegramTreeMenuCallback(
    {
      id: "cb-rewind",
      data: "tree:rewind:1:none",
      message: { chat: { id: 7 }, message_id: 99 },
    },
    {
      ...baseDeps,
      editTreeMessage: async () => {
        events.push("edit-rewind");
      },
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
    },
  );

  assert.equal(handledEntry, true);
  assert.equal(handledRewind, true);
  assert.deepEqual(events, [
    "edit:1",
    "answer:",
    "answer:Tree history is read-only for this session.",
  ]);
});

test("Tree menu read-only mode can create active-tab branch", async () => {
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
  const baseDeps = {
    getState: store.get,
    setState: store.set,
    getSnapshot: () => snapshot,
    isReadOnly: () => true,
    canForkTree: () => true,
    forkTreeEntry: async (entryId: string) => {
      events.push(`branch:${entryId}`);
      return { cancelled: false, text: "second prompt" };
    },
    injectTreeExec: async () => {
      events.push("inject");
    },
    canNavigate: () => true,
  };
  const handledEntry = await handleTelegramTreeMenuCallback(
    {
      id: "cb-entry",
      data: "tree:entry:1",
      message: { chat: { id: 7 }, message_id: 99 },
    },
    {
      ...baseDeps,
      editTreeMessage: async (_chatId, _messageId, _text, markup) => {
        const button = markup.inline_keyboard[1]?.[0];
        events.push(button && "callback_data" in button ? button.callback_data : "");
      },
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
    },
  );
  const handledFork = await handleTelegramTreeMenuCallback(
    {
      id: "cb-fork",
      data: "tree:fork:1",
      message: { chat: { id: 7 }, message_id: 99 },
    },
    {
      ...baseDeps,
      editTreeMessage: async (_chatId, _messageId, text, markup) => {
        events.push(`edit:${text.includes("Created branch")}:${markup.inline_keyboard.length}`);
      },
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
      sendTextReply: async (_chatId, _replyTo, text) => {
        events.push(`reply:${text.includes("second prompt")}`);
      },
    },
  );

  assert.equal(handledEntry, true);
  assert.equal(handledFork, true);
  assert.deepEqual(events, [
    "tree:fork:1",
    "answer:",
    "branch:u2",
    "edit:true:0",
    "answer:Branch created.",
    "reply:true",
  ]);
});

test("Tree menu read-only branch detail can switch and mutate when enabled", async () => {
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
  const store = createTelegramTreeMenuStore();
  store.set({
    chatId: 7,
    messageId: 99,
    entries,
    page: 0,
    view: "list",
    filter: "branches",
    updatedAt: Date.now(),
  });
  const events: string[] = [];
  const baseDeps = {
    getState: store.get,
    setState: store.set,
    getSnapshot: () => snapshot,
    isReadOnly: () => true,
    canMutateBranches: () => true,
    forkTreeEntry: async (entryId: string) => {
      events.push(`switch:${entryId}`);
      return { cancelled: false };
    },
    injectTreeExec: async () => {
      events.push("inject");
    },
    deleteBranch: async (entryId: string) => {
      events.push(`delete:${entryId}`);
      snapshot.entries.push({
        type: "custom",
        id: "delete-old",
        parentId: "u2",
        customType: TELEGRAM_TREE_BRANCH_METADATA_CUSTOM_TYPE,
        data: { leafId: entryId, deleted: true },
        timestamp: "2026-01-01T00:00:06.000Z",
      });
    },
    canNavigate: () => true,
  };
  const handledEntry = await handleTelegramTreeMenuCallback(
    {
      id: "cb-entry",
      data: "tree:entry:0",
      message: { chat: { id: 7 }, message_id: 99 },
    },
    {
      ...baseDeps,
      editTreeMessage: async (_chatId, _messageId, _text, markup) => {
        events.push(
          markup.inline_keyboard
            .flat()
            .map((button) => button.text)
            .join("|"),
        );
      },
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
    },
  );
  const handledSwitch = await handleTelegramTreeMenuCallback(
    {
      id: "cb-switch",
      data: "tree:switch:0",
      message: { chat: { id: 7 }, message_id: 99 },
    },
    {
      ...baseDeps,
      editTreeMessage: async (_chatId, _messageId, text) => {
        events.push(`edit:${text.includes("Switching to branch leaf")}`);
      },
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
    },
  );
  const handledDelete = await handleTelegramTreeMenuCallback(
    {
      id: "cb-delete",
      data: "tree:delete-confirm:0",
      message: { chat: { id: 7 }, message_id: 99 },
    },
    {
      ...baseDeps,
      editTreeMessage: async (_chatId, _messageId, text) => {
        events.push(`delete-edit:${text.includes("No visible entries")}`);
      },
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
    },
  );

  assert.equal(handledEntry, true);
  assert.equal(handledSwitch, true);
  assert.equal(handledDelete, true);
  assert.deepEqual(events, [
    "⬅️ Back to tree|🌿 Switch to this branch|✏️ Rename branch|🗑 Delete branch",
    "answer:",
    "switch:a-old",
    "edit:true",
    "answer:Switched.",
    "delete:a-old",
    "delete-edit:true",
    "answer:Branch deleted.",
  ]);
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

test("Tree SVG export projects current leaf and branch tails onto visible prompt nodes", () => {
  const snapshot = createSnapshot();
  const activeAssistantLeaf = {
    type: "message",
    id: "a2",
    parentId: "u2",
    timestamp: "2026-01-01T00:00:04.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "second answer" }] },
  };
  const branchUser = {
    type: "message",
    id: "u-old",
    parentId: "a1",
    timestamp: "2026-01-01T00:00:05.000Z",
    message: { role: "user", content: [{ type: "text", text: "old branch prompt" }] },
  };
  const branchAssistantLeaf = {
    type: "message",
    id: "a-old",
    parentId: "u-old",
    timestamp: "2026-01-01T00:00:06.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "old branch answer" }] },
  };
  snapshot.entries.push(activeAssistantLeaf, branchUser, branchAssistantLeaf);
  snapshot.branch.push(activeAssistantLeaf);
  snapshot.leafId = "a2";
  const svg = buildTelegramTreeSvg(snapshot);
  assert.match(svg, /r="22" fill="none" stroke="#2563eb"/);
  assert.match(svg, /r="21" fill="none" stroke="#f97316" stroke-width="2" stroke-dasharray="4 3"/);
  assert.match(svg, /branch tail/);
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
