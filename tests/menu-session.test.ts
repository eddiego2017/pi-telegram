/**
 * Regression tests for Telegram /session menu UI
 * Covers compact summary, active-branch history pagination, detail views, and callback dispatch.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramSessionDetailText,
  buildTelegramSessionHistoryItems,
  buildTelegramSessionHistoryReplyMarkup,
  buildTelegramSessionHistoryText,
  buildTelegramSessionMainReplyMarkup,
  buildTelegramSessionMainText,
  buildTelegramSessionStats,
  createTelegramSessionMenuRuntime,
  type TelegramSessionSnapshot,
} from "../lib/menu-session.ts";

function makeSnapshot(): TelegramSessionSnapshot {
  const entries: TelegramSessionSnapshot["entries"] = [
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-05-18T00:00:00Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "[telegram] hello <world>" }],
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-05-18T00:00:01Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hi & welcome" },
          { type: "toolCall", id: "tc1", name: "read", arguments: {} },
        ],
        usage: {
          input: 1200,
          output: 80,
          cacheRead: 50,
          cacheWrite: 0,
          totalTokens: 1330,
          cost: { total: 0.012 },
        },
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: "2026-05-18T00:00:02Z",
      message: {
        role: "toolResult",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "file body" }],
        timestamp: Date.now(),
      },
    },
    {
      type: "session_info",
      id: "n1",
      parentId: "t1",
      timestamp: "2026-05-18T00:00:03Z",
      name: "demo",
    },
  ];
  return {
    cwd: "/repo",
    sessionId: "session-1234567890",
    sessionFile: "/tmp/session.jsonl",
    sessionName: "demo <name>",
    entries,
    branch: entries,
    contextUsage: { tokens: 612000, contextWindow: 1000000, percent: 61.2 },
  };
}

test("Session menu builds compact stats and escaped latest preview", () => {
  const snapshot = makeSnapshot();
  assert.deepEqual(buildTelegramSessionStats(snapshot), {
    userMessages: 1,
    assistantMessages: 1,
    toolResults: 1,
    toolCalls: 1,
    totalMessages: 3,
    totalEntries: 4,
    branchEntries: 4,
    inputTokens: 1200,
    outputTokens: 80,
    cacheReadTokens: 50,
    cacheWriteTokens: 0,
    totalTokens: 1330,
    totalCost: 0.012,
  });
  const text = buildTelegramSessionMainText(snapshot);
  assert.match(text, /<b>🧭 Session<\/b>/);
  assert.match(text, /Name: demo &lt;name&gt;/);
  assert.match(text, /Msgs: 1 user · 1 assistant · 1 tools/);
  assert.match(text, /Ctx: 612K\/1.0M · 61.2%/);
  assert.match(text, /hello &lt;world&gt;/);
  assert.match(text, /Hi &amp; welcome/);
  assert.deepEqual(buildTelegramSessionMainReplyMarkup(true), {
    inline_keyboard: [[{ text: "📜 History", callback_data: "session:history" }]],
  });
});

test("Session history renders active-branch chat lines without tool rows", () => {
  const snapshot = makeSnapshot();
  const items = buildTelegramSessionHistoryItems(snapshot);
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((item) => [item.globalIndex, item.title, item.summary]),
    [
      [1, "👤 User", "hello <world>"],
      [2, "🤖 Assistant", "Hi & welcome"],
    ],
  );
  const historyText = buildTelegramSessionHistoryText(snapshot, 0);
  assert.match(historyText, /1 user: hello &lt;world&gt;/);
  assert.match(historyText, /2 assistant: Hi &amp; welcome/);
  assert.doesNotMatch(historyText, /tool|tools|read/i);
  assert.deepEqual(buildTelegramSessionHistoryReplyMarkup(snapshot, 0).inline_keyboard, [
    [{ text: "⬅️ Back to session", callback_data: "session:back:main" }],
  ]);
  assert.match(buildTelegramSessionDetailText(items[1]), /<b>🤖 Assistant<\/b>/);
  assert.match(buildTelegramSessionDetailText(items[1]), /tools ×1/);
});

test("Session menu runtime opens, pages, details, and refreshes", async () => {
  const events: string[] = [];
  const snapshot = makeSnapshot();
  const runtime = createTelegramSessionMenuRuntime<string>({
    getSnapshot: () => snapshot,
    sendInteractiveMessage: async (chatId, text, mode, markup) => {
      events.push(`send:${chatId}:${mode}:${text.split("\n")[0]}:${markup.inline_keyboard.length}`);
      return 99;
    },
    editInteractiveMessage: async (chatId, messageId, text, mode, markup) => {
      events.push(`edit:${chatId}:${messageId}:${mode}:${text.split("\n")[0]}:${markup.inline_keyboard.length}`);
    },
    answerCallbackQuery: async (id, text) => {
      events.push(`answer:${id}:${text ?? ""}`);
    },
  });

  await runtime.openSessionMenu(7, 11, "ctx");
  await runtime.handleCallbackQuery(
    { id: "cb1", data: "session:history", message: { chat: { id: 7 }, message_id: 99 } },
    "ctx",
  );
  await runtime.handleCallbackQuery(
    { id: "cb2", data: "session:turn:1", message: { chat: { id: 7 }, message_id: 99 } },
    "ctx",
  );
  await runtime.handleCallbackQuery(
    { id: "cb3", data: "session:refresh", message: { chat: { id: 7 }, message_id: 99 } },
    "ctx",
  );

  assert.deepEqual(events, [
    "send:7:html:<b>🧭 Session</b>:1",
    "edit:7:99:html:<b>📜 History</b>:1",
    "answer:cb1:",
    "edit:7:99:html:<b>🤖 Assistant</b>:2",
    "answer:cb2:",
    "edit:7:99:html:<b>🧭 Session</b>:1",
    "answer:cb3:Refreshed.",
  ]);
});
