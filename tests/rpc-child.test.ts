/**
 * Regression tests for pi RPC child helpers
 * Covers JSONL splitting, worker argv isolation, and event text extraction
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRpcChildArgs,
  createJsonlLineSplitter,
  extractRpcAssistantText,
  extractRpcTextDelta,
} from "../lib/rpc-child.ts";

test("RPC JSONL splitter handles partial chunks and CRLF", () => {
  const lines: string[] = [];
  const split = createJsonlLineSplitter((line) => lines.push(line));
  split(Buffer.from('{"a":1}\r'));
  split(Buffer.from('\n{"b"'));
  split(Buffer.from(":2}\n"));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("RPC child args always include no-extensions isolation", () => {
  assert.deepEqual(
    buildRpcChildArgs({ sessionDir: "/tmp/sessions/shared" }),
    ["--mode", "rpc", "--no-extensions", "--session-dir", "/tmp/sessions/shared"],
  );
  assert.deepEqual(
    buildRpcChildArgs({
      sessionDir: "/tmp/sessions/shared",
      sessionFile: "/tmp/sessions/shared/session.jsonl",
      extraArgs: ["--thinking", "low"],
    }),
    [
      "--mode",
      "rpc",
      "--no-extensions",
      "--session",
      "/tmp/sessions/shared/session.jsonl",
      "--thinking",
      "low",
    ],
  );
  assert.deepEqual(
    buildRpcChildArgs({}),
    ["--mode", "rpc", "--no-extensions"],
  );
});

test("RPC event helpers extract text deltas and final assistant text", () => {
  assert.equal(
    extractRpcTextDelta({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    }),
    "hi",
  );
  assert.equal(
    extractRpcTextDelta({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "hidden" },
    }),
    "",
  );
  assert.equal(
    extractRpcAssistantText({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "question" }] },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
      ],
    }),
    "answer",
  );
});
