/**
 * Regression tests for transcript dump export helpers
 * Covers active-branch User/Agent extraction, turn limits, metadata stripping, and TXT file generation.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildTelegramDumpTranscript,
  renderTelegramDumpExportFiles,
  type TelegramDumpSnapshot,
} from "../lib/dump-export.ts";

const snapshot: TelegramDumpSnapshot = {
  cwd: "/repo",
  sessionId: "session-abc",
  sessionFile: "/sessions/session-abc.jsonl",
  sessionName: "Mobile debug",
  branch: [
    {
      type: "message",
      id: "u1",
      timestamp: "2026-05-21T10:00:00.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "[telegram] first prompt\n[reply] quoted old text\n[attachments] files",
          },
        ],
      },
    },
    {
      type: "message",
      id: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "toolCall", text: "hidden tool call" },
          { type: "text", text: "first answer" },
        ],
      },
    },
    {
      type: "message",
      id: "tool1",
      message: {
        role: "toolResult",
        content: [{ type: "text", text: "hidden tool result" }],
      },
    },
    {
      type: "message",
      id: "u2",
      message: {
        role: "user",
        content: [{ type: "text", text: "second prompt" }],
      },
    },
    {
      type: "message",
      id: "a2",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "second answer" }],
      },
    },
  ],
};

test("buildTelegramDumpTranscript keeps only visible User/Agent text", () => {
  const transcript = buildTelegramDumpTranscript(snapshot, {}, {
    now: () => Date.parse("2026-05-21T12:00:00.000Z"),
  });
  assert.equal(transcript.stats.totalTurns, 2);
  assert.equal(transcript.stats.selectedMessages, 4);
  assert.match(transcript.text, /Scope: active branch, all turns/);
  assert.match(transcript.text, /User: first prompt/);
  assert.match(transcript.text, /Agent: first answer/);
  assert.match(transcript.text, /User: second prompt/);
  assert.match(transcript.text, /Agent: second answer/);
  assert.doesNotMatch(transcript.text, /quoted old text/);
  assert.doesNotMatch(transcript.text, /hidden reasoning/);
  assert.doesNotMatch(transcript.text, /hidden tool result/);
});

test("buildTelegramDumpTranscript limits by recent user turns", () => {
  const transcript = buildTelegramDumpTranscript(snapshot, { turnLimit: 1 }, {
    now: () => Date.parse("2026-05-21T12:00:00.000Z"),
  });
  assert.equal(transcript.stats.totalTurns, 2);
  assert.equal(transcript.stats.selectedTurns, 1);
  assert.equal(transcript.stats.selectedMessages, 2);
  assert.doesNotMatch(transcript.text, /first prompt/);
  assert.match(transcript.text, /User: second prompt/);
  assert.match(transcript.text, /Agent: second answer/);
});

test("renderTelegramDumpExportFiles writes a transcript txt file", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "pi-dump-test-"));
  try {
    const files = await renderTelegramDumpExportFiles(snapshot, { turnLimit: 1 }, {
      outputDir,
      now: () => Date.parse("2026-05-21T12:00:00.000Z"),
    });
    assert.equal(files.turnCount, 1);
    assert.equal(files.messageCount, 2);
    assert.match(files.fileBaseName, /^pi-dump-Mobile_debug-last1-20260521-1200-[a-f0-9]{8}$/);
    const text = await readFile(files.txtPath, "utf8");
    assert.match(text, /Scope: active branch, last 1 turns/);
    assert.match(text, /User: second prompt/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
