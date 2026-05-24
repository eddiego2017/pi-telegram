/**
 * Regression tests for Telegram /session menu UI
 * Covers compact summary, active-branch history pagination, detail views, and callback dispatch.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramSessionDeleteConfirmReplyMarkup,
  buildTelegramSessionDeleteConfirmText,
  buildTelegramSessionDetailText,
  buildTelegramSessionHistoryItems,
  buildTelegramSessionHistoryReplyMarkup,
  buildTelegramSessionHistoryText,
  buildTelegramSessionMainReplyMarkup,
  buildTelegramSessionMainText,
  buildTelegramSessionReplayPlan,
  buildTelegramSessionReplayTurns,
  buildTelegramSessionStats,
  createTelegramTabSwitchReplaySender,
  createTelegramSessionMenuRuntime,
  createTelegramSessionReplayAttachmentSender,
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
  assert.deepEqual(buildTelegramSessionMainReplyMarkup(true, true), {
    inline_keyboard: [
      [
        { text: "📜 Last 5 turns", callback_data: "session:replay:last5" },
        { text: "📜 Full replay", callback_data: "session:replay:full" },
      ],
      [{ text: "📜 History", callback_data: "session:history" }],
      [{ text: "🗑 Delete this session", callback_data: "session:delete-current" }],
    ],
  });
  assert.match(buildTelegramSessionDeleteConfirmText(snapshot), /Delete current session/);
  assert.deepEqual(buildTelegramSessionDeleteConfirmReplyMarkup().inline_keyboard, [
    [{ text: "✅ Delete & start new", callback_data: "session:delete-current:confirm" }],
    [{ text: "Cancel", callback_data: "session:delete-current:cancel" }],
  ]);
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

test("Session replay keeps image attachments from session history", () => {
  const branch: TelegramSessionSnapshot["branch"] = [
    {
      type: "message",
      id: "u-image",
      timestamp: "2026-05-18T00:00:00Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "[telegram] look at this\n\n" +
              "[attachments] /tmp/telegram\n" +
              "- /demo.png\n" +
              "- /notes.txt",
          },
          { type: "image", url: "file:///tmp/telegram/second.jpg", mimeType: "image/jpeg" },
        ],
      },
    },
  ];
  const snapshot: TelegramSessionSnapshot = {
    cwd: "/repo",
    sessionId: "session-images",
    entries: branch,
    branch,
  };

  const plan = buildTelegramSessionReplayPlan(snapshot, "last5");
  assert.equal(plan.messages.length, 1);
  assert.equal(plan.messages[0]?.text, "look at this");
  assert.deepEqual(plan.messages[0]?.attachments, [
    { path: "/tmp/telegram/demo.png", fileName: "demo.png" },
    { path: "/tmp/telegram/second.jpg", fileName: "second.jpg", mimeType: "image/jpeg" },
  ]);
});

test("Session replay attaches hidden sendPhoto tool images to next agent message", () => {
  const photoPath =
    "/home/pi/.pi/agent/tmp/telegram/b5c7a1cc-075a-43d7-b40f-eb88bb605b3f-photo-2390.jpg";
  const branch: TelegramSessionSnapshot["branch"] = [
    {
      type: "message",
      id: "u-photo",
      timestamp: "2026-05-22T10:27:55Z",
      message: { role: "user", content: "[telegram] send SDAM-146 image" },
    },
    {
      type: "message",
      id: "a-hidden-photo-tool",
      timestamp: "2026-05-22T10:28:01Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden reasoning" },
          {
            type: "toolCall",
            id: "tc-send-photo",
            name: "bash",
            arguments: {
              command:
                'curl -s -X POST "https://api.telegram.org/botTOKEN/sendPhoto" \\\n' +
                "  -F chat_id=123 \\\n" +
                `  -F photo=@${photoPath} \\\n` +
                '  -F caption="SDAM-146 第二張圖"',
            },
          },
        ],
      },
    },
    {
      type: "message",
      id: "tool-send-photo",
      timestamp: "2026-05-22T10:28:03Z",
      message: { role: "toolResult", content: [{ type: "text", text: '{"ok":true}' }] },
    },
    {
      type: "message",
      id: "a-photo",
      timestamp: "2026-05-22T10:28:07Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已經 send 咗去你 Telegram 啦" }],
      },
    },
  ];
  const snapshot: TelegramSessionSnapshot = {
    cwd: "/repo",
    sessionId: "session-hidden-send-photo",
    entries: branch,
    branch,
  };

  const plan = buildTelegramSessionReplayPlan(snapshot, "last5");
  assert.deepEqual(
    plan.messages.map((message) => message.entryId),
    ["u-photo", "a-photo"],
  );
  assert.equal(plan.messages[1]?.text, "已經 send 咗去你 Telegram 啦");
  assert.deepEqual(plan.messages[1]?.attachments, [
    { path: photoPath, fileName: "b5c7a1cc-075a-43d7-b40f-eb88bb605b3f-photo-2390.jpg" },
  ]);
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

test("Session replay callback sends image attachments after their text", async () => {
  const snapshot: TelegramSessionSnapshot = {
    cwd: "/repo",
    sessionId: "session-current",
    entries: [],
    branch: [
      {
        type: "message",
        id: "u-current",
        timestamp: "2026-05-18T01:00:00Z",
        message: {
          role: "user",
          content:
            "[telegram] current prompt\n\n" +
            "[attachments] /tmp/telegram\n" +
            "- /demo.png",
        },
      },
    ],
  };
  snapshot.entries = snapshot.branch;
  const events: string[] = [];
  const runtime = createTelegramSessionMenuRuntime<string>({
    getSnapshot: () => snapshot,
    sendInteractiveMessage: async () => 77,
    editInteractiveMessage: async () => {},
    sendReplayMessage: async (_chatId, _replyToMessageId, text) => {
      events.push(`text:${text}`);
      return 78;
    },
    sendReplayAttachment: async (_chatId, replyToMessageId, attachment) => {
      events.push(`image:${replyToMessageId}:${attachment.path}:${attachment.fileName}`);
      return 79;
    },
    answerCallbackQuery: async (_id, text) => {
      events.push(`answer:${text ?? ""}`);
    },
  });

  await runtime.openSessionMenu(7, 11, "ctx");
  await runtime.handleCallbackQuery(
    { id: "cb-replay", data: "session:replay:last5", message: { chat: { id: 7 }, message_id: 77 } },
    "ctx",
  );

  assert.deepEqual(events, [
    "answer:Replaying 1 message and 1 image.",
    "text:Replay msg 2026-05-18 01:00 user\ncurrent prompt",
    "image:78:/tmp/telegram/demo.png:demo.png",
  ]);
});

test("Session reference tab-switch replay sender replays latest full turn with thinking and tools", async () => {
  const branch: TelegramSessionSnapshot["branch"] = [];
  for (let i = 1; i <= 6; i += 1) {
    branch.push({
      type: "message",
      id: `u${i}`,
      timestamp: `2026-05-18T01:0${i}:00Z`,
      message: {
        role: "user",
        content:
          i === 6
            ? "[telegram] prompt 6\n\n[attachments] /tmp/telegram\n- /demo.png"
            : `[telegram] prompt ${i}`,
      },
    });
    branch.push({
      type: "message",
      id: `a${i}`,
      timestamp: `2026-05-18T01:0${i}:30Z`,
      message: {
        role: "assistant",
        content:
          i === 6
            ? [
                { type: "thinking", thinking: "reasoning 6" },
                { type: "toolCall", name: "read", arguments: { path: "demo.ts" } },
                { type: "text", text: "answer 6" },
              ]
            : `answer ${i}`,
      },
    });
    if (i === 6) {
      branch.push({
        type: "message",
        id: "tool6",
        timestamp: "2026-05-18T01:06:45Z",
        message: { role: "toolResult", content: [{ type: "text", text: "tool result 6" }] },
      });
    }
  }
  const snapshot: TelegramSessionSnapshot = {
    cwd: "/repo",
    sessionId: "session-ref",
    entries: branch,
    branch,
  };
  const events: string[] = [];
  let nextMessageId = 90;
  const sender = createTelegramTabSwitchReplaySender<string>({
    getSnapshot: (reference) => {
      events.push(`snapshot:${reference}`);
      return snapshot;
    },
    sendReplayMessage: async (_chatId, replyToMessageId, text) => {
      events.push(`text:${replyToMessageId ?? "none"}:${text}`);
      return nextMessageId++;
    },
    sendReplayAttachment: async (_chatId, replyToMessageId, attachment) => {
      events.push(`image:${replyToMessageId}:${attachment.path}:${attachment.fileName}`);
      return nextMessageId++;
    },
  });

  await sender("tab-A", 7, 77);

  assert.equal(events[0], "snapshot:tab-A");
  assert.equal(events.length, 5);
  assert.equal(
    events[1],
    "text:none:Replay msg 2026-05-18 01:06 user\nprompt 6\n\n[attachments] /tmp/telegram\n- /demo.png",
  );
  assert.equal(events[2], "image:90:/tmp/telegram/demo.png:demo.png");
  assert.match(events[3], /Replay msg 2026-05-18 01:06 agent\n💭 Thinking/);
  assert.match(events[3], /reasoning 6/);
  assert.match(events[3], /🔧 Tool call: read/);
  assert.match(events[3], /answer 6/);
  assert.equal(events[4], "text:none:Replay msg 2026-05-18 01:06 tool\ntool result 6");
});

test("Session replay attachment sender uploads photos and reports failures", async () => {
  const events: string[] = [];
  const sender = createTelegramSessionReplayAttachmentSender({
    sendMultipart: async (method, fields, fileField, filePath, fileName) => {
      events.push(`${method}:${fields.chat_id}:${fields.reply_parameters}:${fileField}:${filePath}:${fileName}`);
      throw new Error("missing file");
    },
    sendTextReply: async (chatId, replyToMessageId, text) => {
      events.push(`fallback:${chatId}:${replyToMessageId}:${text}`);
      return 12;
    },
  });

  const result = await sender(7, 77, {
    path: "/tmp/telegram/demo.png",
    fileName: "demo.png",
  });

  assert.equal(result, 12);
  assert.deepEqual(events, [
    'sendPhoto:7:{"message_id":77,"allow_sending_without_reply":true}:photo:/tmp/telegram/demo.png:demo.png',
    "fallback:7:77:Failed to replay image demo.png: missing file",
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
    "send:7:html:<b>🧭 Session</b>:3",
    "answer:cb1:",
    "edit:7:99:html:<b>📜 History</b>:1",
    "answer:cb2:",
    "edit:7:99:html:<b>🤖 Assistant</b>:2",
    "answer:cb3:Refreshed.",
    "edit:7:99:html:<b>🧭 Session</b>:3",
  ]);
});

test("Session delete callback confirms and injects current session path", async () => {
  const events: string[] = [];
  const snapshot = makeSnapshot();
  const runtime = createTelegramSessionMenuRuntime<string>({
    getSnapshot: () => snapshot,
    sendInteractiveMessage: async () => 99,
    editInteractiveMessage: async (chatId, messageId, text, mode, markup) => {
      events.push(`edit:${chatId}:${messageId}:${mode}:${text.split("\n")[0]}:${markup.inline_keyboard.length}`);
    },
    sendReplayMessage: async () => 100,
    answerCallbackQuery: async (id, text) => {
      events.push(`answer:${id}:${text ?? ""}`);
    },
    injectDeleteCurrentSession: async (path) => {
      events.push(`inject:${path}`);
    },
  });

  await runtime.openSessionMenu(7, 11, "ctx");
  await runtime.handleCallbackQuery(
    { id: "cb-delete", data: "session:delete-current", message: { chat: { id: 7 }, message_id: 99 } },
    "ctx",
  );
  await runtime.handleCallbackQuery(
    { id: "cb-confirm", data: "session:delete-current:confirm", message: { chat: { id: 7 }, message_id: 99 } },
    "ctx",
  );

  assert.deepEqual(events, [
    "answer:cb-delete:",
    "edit:7:99:html:<b>⚠️ Delete current session?</b>:2",
    "inject:/tmp/session.jsonl",
    "answer:cb-confirm:Delete queued.",
  ]);
});

test("Session menu can hide and block current-session delete", async () => {
  const events: string[] = [];
  const snapshot = makeSnapshot();
  const runtime = createTelegramSessionMenuRuntime<string>({
    getSnapshot: () => snapshot,
    canDeleteCurrent: () => false,
    sendInteractiveMessage: async (_chatId, _text, _mode, markup) => {
      events.push(`send:${markup.inline_keyboard.length}`);
      return 99;
    },
    editInteractiveMessage: async () => {
      events.push("edit");
    },
    sendReplayMessage: async () => 100,
    answerCallbackQuery: async (_id, text) => {
      events.push(`answer:${text ?? ""}`);
    },
    injectDeleteCurrentSession: async () => {
      events.push("inject");
    },
  });

  await runtime.openSessionMenu(7, 11, "ctx");
  await runtime.handleCallbackQuery(
    { id: "cb-delete", data: "session:delete-current", message: { chat: { id: 7 }, message_id: 99 } },
    "ctx",
  );

  assert.deepEqual(events, [
    "send:2",
    "answer:Delete is not available for this session.",
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
