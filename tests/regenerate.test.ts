/**
 * Regression tests for Telegram /regenerate pure logic
 * Covers target discovery, content normalization, guard decisions, and the
 * rewind-outcome notifier (dispatch on success, cleanup + notify on failure)
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramRegenerateOutcomeNotifier,
  createTelegramRegeneratePendingStore,
  decideTelegramRegenerate,
  findTelegramRegenerateTarget,
  normalizeTelegramRegenerateContent,
  type TelegramRegenerateGuardState,
  type TelegramRegenerateSessionEntry,
} from "../lib/regenerate.ts";

function userEntry(
  id: string,
  parentId: string | null,
  content: unknown,
): TelegramRegenerateSessionEntry {
  return { type: "message", id, parentId, message: { role: "user", content } };
}

function assistantEntry(
  id: string,
  parentId: string | null,
): TelegramRegenerateSessionEntry {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "assistant", content: "ok" },
  };
}

const idleState: TelegramRegenerateGuardState = {
  isIdle: true,
  hasPendingMessages: false,
  hasActiveTurn: false,
  hasDispatchPending: false,
  hasQueuedItems: false,
  isCompactionInProgress: false,
};

test("normalizeTelegramRegenerateContent handles strings and blocks", () => {
  assert.deepEqual(normalizeTelegramRegenerateContent("hi"), [
    { type: "text", text: "hi" },
  ]);
  assert.deepEqual(normalizeTelegramRegenerateContent("  "), []);
  assert.deepEqual(
    normalizeTelegramRegenerateContent([
      { type: "text", text: "a" },
      { type: "thinking", thinking: "x" },
      { type: "image", data: "ZGF0YQ==", mimeType: "image/png" },
      { type: "toolCall", id: "t", name: "n", arguments: {} },
    ]),
    [
      { type: "text", text: "a" },
      { type: "image", data: "ZGF0YQ==", mimeType: "image/png" },
    ],
  );
});

test("findTelegramRegenerateTarget picks the last user message on the branch", () => {
  const branch: TelegramRegenerateSessionEntry[] = [
    userEntry("u1", null, "first"),
    assistantEntry("a1", "u1"),
    userEntry("u2", "a1", "second"),
    assistantEntry("a2", "u2"),
  ];
  const target = findTelegramRegenerateTarget(branch);
  assert.deepEqual(target, {
    entryId: "u2",
    content: [{ type: "text", text: "second" }],
  });
});

test("findTelegramRegenerateTarget returns undefined when no user message exists", () => {
  assert.equal(findTelegramRegenerateTarget([assistantEntry("a1", null)]), undefined);
  assert.equal(findTelegramRegenerateTarget([]), undefined);
});

test("findTelegramRegenerateTarget returns undefined for an empty-content prompt", () => {
  const branch = [userEntry("u1", null, "  ")];
  assert.equal(findTelegramRegenerateTarget(branch), undefined);
});

test("decideTelegramRegenerate allows when idle with a target", () => {
  const branch = [userEntry("u1", null, "hello"), assistantEntry("a1", "u1")];
  const decision = decideTelegramRegenerate(idleState, branch);
  assert.equal(decision.ok, true);
  if (decision.ok) assert.equal(decision.target.entryId, "u1");
});

test("decideTelegramRegenerate rejects when busy", () => {
  const branch = [userEntry("u1", null, "hello")];
  for (const key of [
    "hasActiveTurn",
    "hasPendingMessages",
    "hasDispatchPending",
    "hasQueuedItems",
    "isCompactionInProgress",
  ] as const) {
    const decision = decideTelegramRegenerate(
      { ...idleState, [key]: true },
      branch,
    );
    assert.deepEqual(decision, { ok: false, reason: "busy" });
  }
  assert.deepEqual(
    decideTelegramRegenerate({ ...idleState, isIdle: false }, branch),
    { ok: false, reason: "busy" },
  );
});

test("decideTelegramRegenerate rejects when idle but no target", () => {
  assert.deepEqual(decideTelegramRegenerate(idleState, []), {
    ok: false,
    reason: "no-target",
  });
});

test("regenerate outcome notifier dispatches the queued turn on success", async () => {
  const store = createTelegramRegeneratePendingStore<string>();
  store.set({ entryId: "u1", messageId: 42, ctx: "ctx" });
  const dispatched: string[] = [];
  const removed: Array<[number[], string]> = [];
  const sent: string[] = [];
  const notify = createTelegramRegenerateOutcomeNotifier<string>({
    pendingStore: store,
    getAllowedUserId: () => 7,
    sendTextReply: async (_chatId, _replyTo, text) => {
      sent.push(text);
    },
    dispatchNextQueuedTelegramTurn: (ctx) => dispatched.push(ctx),
    removeQueuedTurnsByMessageIds: (ids, ctx) => removed.push([ids, ctx]),
  });
  await notify({ ok: true, entryId: "u1" });
  assert.deepEqual(dispatched, ["ctx"]);
  assert.deepEqual(removed, []);
  assert.deepEqual(sent, []);
  // pending slot is consumed
  assert.equal(store.take(), undefined);
});

test("regenerate outcome notifier removes the stranded turn and notifies on failure", async () => {
  const store = createTelegramRegeneratePendingStore<string>();
  store.set({ entryId: "u1", messageId: 42, ctx: "ctx" });
  const dispatched: string[] = [];
  const removed: Array<[number[], string]> = [];
  const sent: Array<[number, number, string]> = [];
  const notify = createTelegramRegenerateOutcomeNotifier<string>({
    pendingStore: store,
    getAllowedUserId: () => 7,
    sendTextReply: async (chatId, replyTo, text) => {
      sent.push([chatId, replyTo, text]);
    },
    dispatchNextQueuedTelegramTurn: (ctx) => dispatched.push(ctx),
    removeQueuedTurnsByMessageIds: (ids, ctx) => removed.push([ids, ctx]),
  });
  await notify({ ok: false, entryId: "u1", error: "boom" });
  assert.deepEqual(dispatched, []);
  assert.deepEqual(removed, [[[42], "ctx"]]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.slice(0, 2), [7, 42]);
  assert.match(sent[0]?.[2] ?? "", /Regenerate failed: boom/);
});
