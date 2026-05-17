/**
 * Regression tests for Telegram context-usage display footer helpers
 * Covers compact formatting, Markdown appending, and reply-context stripping
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  appendTelegramContextUsageFooter,
  formatTelegramContextUsageFooter,
  stripTelegramContextUsageFooter,
} from "../lib/context-usage.ts";

test("Context usage footer formats compact kilotoken and percent values", () => {
  assert.equal(
    formatTelegramContextUsageFooter({
      tokens: 25_600,
      contextWindow: 400_000,
      percent: 6.4,
    }),
    "—\n📊 ctx 25.6K/400K 6.4%",
  );
  assert.equal(
    formatTelegramContextUsageFooter({
      tokens: 100,
      contextWindow: 400_000,
      percent: 0.025,
    }),
    "—\n📊 ctx 0.1K/400K 0.03%",
  );
  assert.equal(
    formatTelegramContextUsageFooter({
      tokens: null,
      contextWindow: 400_000,
      percent: null,
    }),
    undefined,
  );
});

test("Context usage footer appends as display-only markdown tail", () => {
  assert.equal(
    appendTelegramContextUsageFooter(
      "hello\n",
      "—\n📊 ctx 25.6K/400K 6.4%",
    ),
    "hello\n\n—\n📊 ctx 25.6K/400K 6.4%",
  );
  assert.equal(appendTelegramContextUsageFooter("hello", undefined), "hello");
});

test("Context usage footer strips only recognized footer tails", () => {
  assert.equal(
    stripTelegramContextUsageFooter(
      "hello\n\n—\n📊 ctx 25.6K/400K 6.4%",
    ),
    "hello",
  );
  assert.equal(
    stripTelegramContextUsageFooter(
      "hello\n\n---\n📊 ctx 25.6K/400K 6.4%\n---",
    ),
    "hello",
  );
  assert.equal(
    stripTelegramContextUsageFooter(
      "hello\n\n────────────\n📊 ctx 25.6K/400K 6.4%",
    ),
    "hello",
  );
  assert.equal(
    stripTelegramContextUsageFooter(
      "hello\n—\nnot a context footer",
    ),
    "hello\n—\nnot a context footer",
  );
});
