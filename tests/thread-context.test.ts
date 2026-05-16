/**
 * Regression tests for the Telegram message_thread_id ambient context
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramActiveTurnThreadContextGetter,
  createTelegramMessageThreadIdResolver,
  getAmbientTelegramThreadContext,
  runWithTelegramThreadContext,
} from "../lib/thread-context.ts";

test("Thread context exposes the running scope and isolates async runs", async () => {
  assert.equal(getAmbientTelegramThreadContext(), undefined);
  await runWithTelegramThreadContext(
    { chatId: -1, messageThreadId: 5 },
    async () => {
      assert.deepEqual(getAmbientTelegramThreadContext(), {
        chatId: -1,
        messageThreadId: 5,
      });
    },
  );
  assert.equal(getAmbientTelegramThreadContext(), undefined);
});

test("Thread id resolver prefers ambient scope and matches chat ids strictly", () => {
  const resolve = createTelegramMessageThreadIdResolver({});
  assert.equal(resolve(-1), undefined);
  runWithTelegramThreadContext({ chatId: -1, messageThreadId: 5 }, () => {
    assert.equal(resolve(-1), 5);
    assert.equal(resolve(-2), undefined);
  });
  runWithTelegramThreadContext({ chatId: -1 }, () => {
    assert.equal(resolve(-1), undefined);
  });
});

test("Thread id resolver falls back to active turn context outside ambient scope", () => {
  let activeChatId: number | undefined;
  let activeThreadId: number | undefined;
  const getter = createTelegramActiveTurnThreadContextGetter({
    getChatId: () => activeChatId,
    getMessageThreadId: () => activeThreadId,
  });
  const resolve = createTelegramMessageThreadIdResolver({
    getActiveTurnThreadContext: getter,
  });
  assert.equal(resolve(-1), undefined);
  activeChatId = -1;
  activeThreadId = 9;
  assert.equal(resolve(-1), 9);
  assert.equal(resolve(-2), undefined);
  runWithTelegramThreadContext({ chatId: -3, messageThreadId: 4 }, () => {
    // Ambient wins over fallback.
    assert.equal(resolve(-3), 4);
    assert.equal(resolve(-1), undefined);
  });
});
