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
  buildTelegramSessionReplayPlan,
  buildTelegramSessionReplayTurns,
  buildTelegramSessionStats,
  createTelegramSessionMenuRuntime,
  formatTelegramSessionReplayMessage,
  handleTelegramSessionMenuCallback,
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
    inline_keyboard: [
      [
        { text: "📜 Last 5 turns", callback_data: "session:replay:last5" },
        { text: "📜 Full replay", callback_data: "session:replay:full" },
      ],
      [{ text: "📜 History", callback_data: "session:history" }],
    ],
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
  assert.match(historyText, /<code>#<\/code> <code>role     <\/code> msg/);
  assert.match(historyText, /<code>1<\/code> <code>user     <\/code> hello &lt;world&gt;/);
  assert.match(historyText, /<code>2<\/code> <code>assistant<\/code> Hi &amp; welcome/);
  assert.match(historyText, /Tools hidden · 1 calls · 1 results/);
  assert.doesNotMatch(historyText, /read|file body/i);
  assert.deepEqual(buildTelegramSessionHistoryReplyMarkup(snapshot, 0).inline_keyboard, [
    [{ text: "⬅️ Back to session", callback_data: "session:back:main" }],
  ]);
  assert.match(buildTelegramSessionDetailText(items[1]), /<b>🤖 Assistant<\/b>/);
  assert.match(buildTelegramSessionDetailText(items[1]), /tools ×1/);
});

test("Session replay groups by user turns and hides tool/thinking noise", () => {
  const branch: TelegramSessionSnapshot["branch"] = [
    {
      type: "message",
      id: "orphan-assistant",
      timestamp: "2026-05-18T00:00:00Z",
      message: { role: "assistant", content: [{ type: "text", text: "before user" }] },
    },
  ];
  for (let i = 1; i <= 6; i += 1) {
    branch.push({
      type: "message",
      id: `u${i}`,
      timestamp: `2026-05-18T00:0${i}:00Z`,
      message: { role: "user", content: `[telegram] prompt ${i}\n[reply]\nhidden` },
    });
    branch.push({
      type: "message",
      id: `a${i}`,
      timestamp: `2026-05-18T00:0${i}:01Z`,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret reasoning" },
          { type: "toolCall", id: `tc${i}`, name: "read", arguments: {} },
          { type: "text", text: `answer ${i}` },
        ],
      },
    });
    branch.push({
      type: "message",
      id: `tool${i}`,
      timestamp: `2026-05-18T00:0${i}:02Z`,
      message: { role: "toolResult", content: [{ type: "text", text: `tool result ${i}` }] },
    });
  }
  branch.push({
    type: "custom_message",
    id: "c6",
    timestamp: "2026-05-18T00:06:03Z",
    display: true,
    content: [{ type: "text", text: "visible custom" }],
  });
  branch.push({
    type: "custom_message",
    id: "hidden-custom",
    display: false,
    content: [{ type: "text", text: "hidden custom" }],
  });
  const snapshot: TelegramSessionSnapshot = {
    cwd: "/repo",
    sessionId: "session-replay",
    entries: branch,
    branch,
  };

  const turns = buildTelegramSessionReplayTurns(snapshot);
  assert.equal(turns.length, 6);
  assert.deepEqual(
    turns.map((turn) => turn.user.text),
    ["prompt 1", "prompt 2", "prompt 3", "prompt 4", "prompt 5", "prompt 6"],
  );

  const last5 = buildTelegramSessionReplayPlan(snapshot, "last5");
  assert.equal(last5.turns.length, 5);
  assert.equal(last5.messages[0].entryId, "u2");
  assert.deepEqual(
    last5.messages.map((message) => message.text),
    [
      "prompt 2",
      "answer 2",
      "prompt 3",
      "answer 3",
      "prompt 4",
      "answer 4",
      "prompt 5",
      "answer 5",
      "prompt 6",
      "answer 6",
      "visible custom",
    ],
  );
  assert.doesNotMatch(
    last5.messages.map((message) => message.text).join("\n"),
    /secret reasoning|tool result|hidden custom|before user|\[reply\]/,
  );
  assert.equal(
    formatTelegramSessionReplayMessage(last5.messages[0]),
    "Replay msg 2026-05-18 00:02 user\nprompt 2",
  );
});

test("Session replay callback uses current snapshot and sends normal messages", async () => {
  const initial = makeSnapshot();
  const current: TelegramSessionSnapshot = {
    cwd: "/repo",
    sessionId: "session-current",
    entries: [],
    branch: [
      {
        type: "message",
        id: "u-current",
        timestamp: "2026-05-18T01:00:00Z",
        message: { role: "user", content: "[telegram] current prompt" },
      },
      {
        type: "message",
        id: "a-current",
        timestamp: "2026-05-18T01:00:01Z",
        message: { role: "assistant", content: [{ type: "text", text: "current answer" }] },
      },
    ],
  };
  current.entries = current.branch;
  let snapshot = initial;
  const replayed: string[] = [];
  const runtime = createTelegramSessionMenuRuntime<string>({
    getSnapshot: () => snapshot,
    sendInteractiveMessage: async () => 77,
    editInteractiveMessage: async () => {},
    sendReplayMessage: async (_chatId, _replyToMessageId, text) => {
      replayed.push(text);
      return 78;
    },
    answerCallbackQuery: async (_id, text) => {
      replayed.push(`answer:${text ?? ""}`);
    },
  });

  await runtime.openSessionMenu(7, 11, "ctx");
  snapshot = current;
  await runtime.handleCallbackQuery(
    { id: "cb-replay", data: "session:replay:last5", message: { chat: { id: 7 }, message_id: 77 } },
    "ctx",
  );

  assert.deepEqual(replayed, [
    "answer:Replaying 2 messages.",
    "Replay msg 2026-05-18 01:00 user\ncurrent prompt",
    "Replay msg 2026-05-18 01:00 agent\ncurrent answer",
  ]);
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
    sendReplayMessage: async (chatId, _replyToMessageId, text) => {
      events.push(`replay:${chatId}:${text.split("\n")[0]}`);
      return 100;
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
    "send:7:html:<b>🧭 Session</b>:2",
    "answer:cb1:",
    "edit:7:99:html:<b>📜 History</b>:1",
    "answer:cb2:",
    "edit:7:99:html:<b>🤖 Assistant</b>:2",
    "answer:cb3:Refreshed.",
    "edit:7:99:html:<b>🧭 Session</b>:2",
  ]);
});

test("Session callback failures are answered and swallowed", async () => {
  const snapshot = makeSnapshot();
  const answers: string[] = [];
  const handled = await handleTelegramSessionMenuCallback(
    { id: "cb", data: "session:history", message: { chat: { id: 7 }, message_id: 99 } },
    {
      getState: () => ({
        chatId: 7,
        messageId: 99,
        view: "main",
        page: 0,
        updatedAt: 1,
      }),
      setState: () => {},
      getSnapshot: () => snapshot,
      editSessionMessage: async () => {
        throw new Error("Telegram edit failed");
      },
      sendReplayMessage: async () => 100,
      answerCallbackQuery: async (_id, text) => {
        answers.push(text ?? "");
      },
    },
  );
  assert.equal(handled, true);
  assert.deepEqual(answers, [""]);
});
