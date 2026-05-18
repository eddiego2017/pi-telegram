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
  createTelegramTreeMenuStore,
  createTelegramTreeNavigationGate,
  createTelegramTreeOutcomeNotifier,
  handleTelegramTreeMenuCallback,
  type TelegramTreeSnapshot,
} from "../lib/menu-tree.ts";

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
  const entries = buildTelegramTreeMenuEntries(createSnapshot());
  assert.deepEqual(
    entries.map((entry) => [entry.entryId, entry.role, entry.depth, entry.active]),
    [
      ["u1", "user", 0, false],
      ["u2", "user", 0, true],
    ],
  );
  assert.equal(entries[0]?.summary, "first prompt");
  assert.equal(buildTelegramTreeListReplyMarkup(entries, 0, "active").inline_keyboard.length, 2);
  assert.match(buildTelegramTreeDetailText(entries[0]!), /first prompt/);
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
