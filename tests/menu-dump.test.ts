/**
 * Regression tests for Telegram dump menu helpers
 * Covers /dump argument parsing, menu rendering, and callback dispatch for TXT and Gist outputs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramDumpMainReplyMarkup,
  buildTelegramDumpMainText,
  createTelegramDumpMenuStore,
  handleTelegramDumpMenuCallback,
  openTelegramDumpMenu,
  parseTelegramDumpTurnLimit,
  type TelegramDumpMenuState,
} from "../lib/menu-dump.ts";
import type {
  TelegramDumpExportFileSet,
  TelegramDumpSnapshot,
} from "../lib/dump-export.ts";

const snapshot: TelegramDumpSnapshot = {
  cwd: "/repo",
  sessionId: "sid",
  sessionName: "Work",
  branch: [
    {
      type: "message",
      id: "u1",
      message: { role: "user", content: [{ type: "text", text: "one" }] },
    },
    {
      type: "message",
      id: "a1",
      message: { role: "assistant", content: [{ type: "text", text: "two" }] },
    },
  ],
};

test("parseTelegramDumpTurnLimit accepts empty or positive numeric limits", () => {
  assert.equal(parseTelegramDumpTurnLimit(""), undefined);
  assert.equal(parseTelegramDumpTurnLimit("20"), 20);
  assert.equal(parseTelegramDumpTurnLimit(" 7 "), 7);
  assert.equal(parseTelegramDumpTurnLimit("0"), null);
  assert.equal(parseTelegramDumpTurnLimit("last 20"), null);
});

test("buildTelegramDumpMainText summarizes active branch transcript", () => {
  const text = buildTelegramDumpMainText(snapshot, { turnLimit: 20 });
  assert.match(text, /<b>🧾 Dump transcript<\/b>/);
  assert.match(text, /Range: last 20 turns/);
  assert.match(text, /Turns: 1 \/ 1/);
  assert.match(text, /Messages: 2 \/ 2/);
  assert.match(text, /Tools, thinking, and metadata are hidden\./);
  const firstButton = buildTelegramDumpMainReplyMarkup(true).inline_keyboard[0]?.[0];
  assert.equal(
    firstButton && "callback_data" in firstButton ? firstButton.callback_data : undefined,
    "dump:txt",
  );
});

test("openTelegramDumpMenu stores scope for callbacks", async () => {
  const store = createTelegramDumpMenuStore(() => 1000);
  let sentText = "";
  await openTelegramDumpMenu({
    chatId: 7,
    scope: { turnLimit: 3 },
    getSnapshot: () => snapshot,
    sendDumpMenu: async (text) => {
      sentText = text;
      return 55;
    },
    storeState: store.set,
    now: () => 1000,
  });
  const state = store.get(55);
  assert.equal(state?.chatId, 7);
  assert.equal(state?.scope.turnLimit, 3);
  assert.match(sentText, /Range: last 3 turns/);
});

test("handleTelegramDumpMenuCallback sends TXT export", async () => {
  const state: TelegramDumpMenuState = {
    chatId: 7,
    messageId: 55,
    view: "main",
    scope: { turnLimit: 2 },
    updatedAt: 1000,
  };
  const events: string[] = [];
  const files: TelegramDumpExportFileSet = {
    txtPath: "/tmp/dump.txt",
    fileBaseName: "dump",
    messageCount: 2,
    turnCount: 1,
    chars: 6,
  };
  const handled = await handleTelegramDumpMenuCallback(
    {
      id: "cb",
      data: "dump:txt",
      message: { chat: { id: 7 }, message_id: 55 },
    },
    {
      getState: () => state,
      setState: (next) => {
        events.push(`state:${next.view}`);
      },
      getSnapshot: () => snapshot,
      editDumpMessage: async () => {
        events.push("unexpected:edit");
      },
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
      renderDumpExport: async (_snapshot, scope) => {
        events.push(`render:${scope.turnLimit}`);
        return files;
      },
      sendDumpExportFiles: async (chatId, replyToMessageId, sentFiles) => {
        events.push(`send:${chatId}:${replyToMessageId}:${sentFiles.fileBaseName}`);
      },
    },
  );
  assert.equal(handled, true);
  assert.deepEqual(events, ["answer:Sending TXT…", "render:2", "send:7:55:dump"]);
});

test("handleTelegramDumpMenuCallback confirms and publishes Gist", async () => {
  let state: TelegramDumpMenuState = {
    chatId: 7,
    messageId: 55,
    view: "main",
    scope: {},
    updatedAt: 1000,
  };
  const events: string[] = [];
  const deps = {
    getState: () => state,
    setState: (next: TelegramDumpMenuState) => {
      state = next;
      events.push(`state:${next.view}`);
    },
    getSnapshot: () => snapshot,
    editDumpMessage: async (_chatId: number, _messageId: number, text: string) => {
      events.push(text.includes("Privacy note") ? "edit:confirm" : "edit:published");
    },
    answerCallbackQuery: async (_id: string, text?: string) => {
      events.push(`answer:${text ?? ""}`);
    },
    renderDumpExport: async () => {
      throw new Error("unused");
    },
    sendDumpExportFiles: async () => undefined,
    publishDumpGist: async () => ({
      gistId: "abc123",
      htmlUrl: "https://gist.github.com/abc123",
      rawUrl: "https://gist.githubusercontent.com/abc123/raw/dump.txt",
      fileName: "dump.txt",
    }),
    deleteDumpGist: async (gistId: string) => {
      events.push(`delete:${gistId}`);
    },
  };
  await handleTelegramDumpMenuCallback(
    { id: "ask", data: "dump:gist:ask", message: { chat: { id: 7 }, message_id: 55 } },
    deps,
  );
  await handleTelegramDumpMenuCallback(
    { id: "publish", data: "dump:gist:publish", message: { chat: { id: 7 }, message_id: 55 } },
    deps,
  );
  await handleTelegramDumpMenuCallback(
    { id: "delete", data: "dump:gist:delete", message: { chat: { id: 7 }, message_id: 55 } },
    deps,
  );
  assert.deepEqual(events, [
    "edit:confirm",
    "state:gistConfirm",
    "answer:",
    "answer:Publishing secret Gist…",
    "edit:published",
    "state:gistPublished",
    "answer:Deleting Gist…",
    "delete:abc123",
    "edit:published",
    "state:main",
  ]);
});
