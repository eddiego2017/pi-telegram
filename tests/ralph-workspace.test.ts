/**
 * Regression tests for the workspace-scoped Ralph loop
 * Covers marker parsing, loop-state persistence, decide transitions, command
 * parsing, prompts, and the parent-side controller (arm via marker, handoff,
 * stall, stop, and topic-only rejection).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RALPH_DEFAULT_BASE_NAME,
  RALPH_MAX_ITERATIONS,
  buildRalphArmDialoguePrompt,
  buildRalphIterationPrompt,
  buildRalphWorkspaceState,
  createRalphStateStore,
  decideRalphNext,
  formatRalphStatus,
  getTelegramRalphStatePath,
  parseRalphCommand,
  parseRalphMarker,
  ralphSessionName,
  stripRalphLoopSuffix,
} from "../lib/ralph-workspace.ts";
import type { RalphWorkspaceState } from "../lib/ralph-workspace.ts";
import {
  RALPH_TOPIC_ONLY_MESSAGE,
  installRalph,
} from "../lib/workspace-manager-ralph.ts";
import type { WsRuntimeContext } from "../lib/workspace-manager-context.ts";
import type {
  TelegramWorkspaceBackend,
  TelegramWorkspaceManagerDeps,
  WorkspaceRuntime,
} from "../lib/workspace-manager-types.ts";
import { createWorkspaceRuntime } from "../lib/workspace-manager-events.ts";

function makeState(
  overrides: Partial<RalphWorkspaceState> = {},
): RalphWorkspaceState {
  return {
    active: true,
    baseName: "task",
    kickoff: "do one unit",
    exitCondition: "counter >= 3",
    guardrails: "",
    loop: 0,
    maxIterations: RALPH_MAX_ITERATIONS,
    startedAt: 1000,
    ...overrides,
  };
}

test("parseRalphMarker parses arm, next, and malformed markers", () => {
  assert.deepEqual(
    parseRalphMarker(
      'Confirmed, starting.\nRALPH-ARM: {"kickoff":"do x","exit_condition":"y done","guardrails":"keep z"}',
    ),
    {
      kind: "arm",
      spec: { kickoff: "do x", exitCondition: "y done", guardrails: "keep z" },
    },
  );
  assert.deepEqual(parseRalphMarker("done!\nRALPH: done | note=all finished"), {
    kind: "next",
    done: true,
    note: "all finished",
  });
  assert.deepEqual(parseRalphMarker("RALPH: continue | note=counter at 2"), {
    kind: "next",
    done: false,
    note: "counter at 2",
  });
  assert.deepEqual(parseRalphMarker("RALPH: continue"), {
    kind: "next",
    done: false,
    note: undefined,
  });
  assert.equal(parseRalphMarker("no marker here"), undefined);
  assert.equal(parseRalphMarker("inline RALPH: done mention"), undefined);
  const malformed = parseRalphMarker("RALPH-ARM: {broken json");
  assert.equal(malformed, undefined);
  const badJson = parseRalphMarker("RALPH-ARM: {\"kickoff\":}");
  assert.equal(badJson?.kind, "arm-invalid");
  const missingExit = parseRalphMarker('RALPH-ARM: {"kickoff":"x"}');
  assert.equal(missingExit?.kind, "arm-invalid");
  assert.match(
    (missingExit as { error: string }).error,
    /exit_condition/,
  );
});

test("ralphSessionName composes base#loopN without compounding", () => {
  assert.equal(ralphSessionName("task", 0), "task");
  assert.equal(ralphSessionName("task", 2), "task#loop2");
  assert.equal(ralphSessionName("  ", 1), `${RALPH_DEFAULT_BASE_NAME}#loop1`);
  // A name that already carries a loop suffix must not compound.
  assert.equal(ralphSessionName("task#loop2", 1), "task#loop1");
  assert.equal(ralphSessionName("task#loop2#loop1", 3), "task#loop3");
});

test("stripRalphLoopSuffix removes one or many trailing loop segments", () => {
  assert.equal(stripRalphLoopSuffix("task"), "task");
  assert.equal(stripRalphLoopSuffix("task#loop2"), "task");
  assert.equal(stripRalphLoopSuffix("task#loop2#loop1#loop2"), "task");
  assert.equal(stripRalphLoopSuffix("my task#loop9"), "my task");
  assert.equal(stripRalphLoopSuffix(undefined), "");
  assert.equal(stripRalphLoopSuffix("  "), "");
  // Only a strict trailing suffix is stripped, not an internal #loopN.
  assert.equal(stripRalphLoopSuffix("a#loop1-b"), "a#loop1-b");
});

test("createRalphStateStore round-trips per-workspace state on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-test-"));
  try {
    const store = createRalphStateStore(getTelegramRalphStatePath(dir));
    assert.equal(store.read("topic-1"), undefined);
    const state = makeState();
    store.write("topic-1", state);
    store.write("topic-2", makeState({ baseName: "other" }));
    assert.deepEqual(store.read("topic-1"), state);
    assert.equal(store.read("topic-2")?.baseName, "other");
    store.clear("topic-1");
    assert.equal(store.read("topic-1"), undefined);
    assert.equal(store.read("topic-2")?.baseName, "other");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decideRalphNext advances, stops on done, and enforces the ceiling", () => {
  const cont = decideRalphNext(makeState(), { done: false, note: "n1" });
  assert.equal(cont.kind, "continue");
  if (cont.kind === "continue") {
    assert.equal(cont.state.loop, 1);
    assert.equal(cont.state.lastNote, "n1");
    assert.equal(cont.nextName, "task#loop1");
  }
  const done = decideRalphNext(makeState({ loop: 4 }), { done: true });
  assert.deepEqual(done, { kind: "done", iterations: 5, reason: "exit_condition" });
  const ceiling = decideRalphNext(
    makeState({ loop: 2, maxIterations: 3 }),
    { done: false },
  );
  assert.deepEqual(ceiling, { kind: "done", iterations: 3, reason: "max_iterations" });
});

test("parseRalphCommand distinguishes status, stop, and arm dialogue", () => {
  assert.deepEqual(parseRalphCommand("status"), { kind: "status" });
  assert.deepEqual(parseRalphCommand(" STOP "), { kind: "stop" });
  assert.deepEqual(parseRalphCommand("count to 3"), {
    kind: "arm-dialogue",
    initialTask: "count to 3",
  });
  assert.deepEqual(parseRalphCommand(""), { kind: "arm-dialogue", initialTask: "" });
});

test("Ralph prompts restate spec, protocol, and carried note", () => {
  const armPrompt = buildRalphArmDialoguePrompt("count things");
  assert.match(armPrompt, /count things/);
  assert.match(armPrompt, /RALPH-ARM:/);
  assert.match(armPrompt, /confirms/i);
  const state = makeState({ loop: 1, lastNote: "counter at 1", guardrails: "no force push" });
  const prompt = buildRalphIterationPrompt(state);
  assert.match(prompt, /iteration #2/);
  assert.match(prompt, /counter at 1/);
  assert.match(prompt, /no force push/);
  assert.match(prompt, /RALPH: done/);
  assert.match(prompt, /RALPH: continue/);
});

test("buildRalphWorkspaceState captures base name and delivery target", () => {
  const armed = buildRalphWorkspaceState({
    spec: { kickoff: "k", exitCondition: "e", guardrails: "" },
    baseName: "topic name",
    now: 5,
    chatId: -100,
    messageThreadId: 7,
    replyToMessageId: 42,
  });
  assert.equal(armed.active, true);
  assert.equal(armed.baseName, "topic name");
  assert.equal(armed.loop, 0);
  assert.equal(armed.chatId, -100);
  assert.equal(armed.messageThreadId, 7);
  const fallback = buildRalphWorkspaceState({
    spec: { kickoff: "k", exitCondition: "e", guardrails: "" },
    baseName: undefined,
    now: 5,
  });
  assert.equal(fallback.baseName, RALPH_DEFAULT_BASE_NAME);
});

test("formatRalphStatus reports missing, active, and inactive loops", () => {
  assert.match(formatRalphStatus(undefined), /No Ralph loop/);
  assert.match(formatRalphStatus(makeState({ loop: 1 })), /iteration #2/);
  assert.match(formatRalphStatus(makeState({ active: false, loop: 3 })), /inactive/);
});

// --- Controller tests ---

interface FakeBackendCall {
  method: string;
  args: unknown[];
}

function createFakeBackend(): TelegramWorkspaceBackend & { calls: FakeBackendCall[] } {
  const calls: FakeBackendCall[] = [];
  return {
    kind: "rpc-child",
    workspaceName: "topic-1",
    calls,
    async start() {
      return {};
    },
    async dispose() {},
    onEvent() {
      return () => {};
    },
    getStderr: () => "",
    getCachedState: () => undefined,
    async prompt(message: string) {
      calls.push({ method: "prompt", args: [message] });
    },
    async steer() {},
    async followUp(message: string) {
      calls.push({ method: "followUp", args: [message] });
    },
    async abort() {},
    async compact() {},
    async newSession() {
      calls.push({ method: "newSession", args: [] });
      return { cancelled: false };
    },
    async switchSession() {
      return { cancelled: false };
    },
    async getState() {
      return { sessionFile: "/tmp/s.jsonl" };
    },
    async setModel() {},
    async setThinkingLevel() {},
    async setSessionName(name: string) {
      calls.push({ method: "setSessionName", args: [name] });
    },
  } as TelegramWorkspaceBackend & { calls: FakeBackendCall[] };
}

interface ControllerHarness {
  self: WsRuntimeContext<unknown>;
  deps: TelegramWorkspaceManagerDeps<unknown>;
  runtime: WorkspaceRuntime;
  backend: ReturnType<typeof createFakeBackend>;
  replies: string[];
  api: { handleRalphCommand?: (args: string, chatId: number, replyToMessageId: number, ctx: unknown) => Promise<boolean> };
  statePath: string;
  cleanup: () => void;
}

function createControllerHarness(options: {
  scoped?: boolean;
  hasRuntime?: boolean;
  sessionName?: string;
  nonTopicSource?: boolean;
} = {}): ControllerHarness {
  const dir = mkdtempSync(join(tmpdir(), "ralph-ctrl-"));
  const replies: string[] = [];
  const backend = createFakeBackend();
  const runtime = createWorkspaceRuntime({
    name: "topic-1",
    cwd: "/repo",
    createdAt: 1,
    lastUsedAt: 1,
    status: "idle",
    sessionName: options.sessionName ?? "my task",
    source: options.nonTopicSource
      ? undefined
      : { kind: "telegram-topic", chatId: -100, messageThreadId: 7, topicTitle: "my task" },
  });
  runtime.backend = backend;
  runtime.activeChatId = -100;
  runtime.activeMessageThreadId = 7;
  runtime.activeReplyToMessageId = 11;
  const deliveredPrompts: string[] = [];
  const self = {
    agentDir: dir,
    now: () => 1000,
    isEnabled: () => true,
    isTopicBindingEnabled: () => true,
    replyDisabled: async () => undefined,
    ensureState: async () => ({ activeWorkspace: "topic-1", workspaces: {} }),
    resolveScopedTopicRuntime: async () => ({
      scoped: options.scoped ?? true,
      runtime: (options.hasRuntime ?? true) ? runtime : undefined,
    }),
    refreshRuntimeState: async () => undefined,
    deliverPromptTurn: async (_runtime: WorkspaceRuntime, turn: { content: readonly { text?: string }[] }) => {
      deliveredPrompts.push(turn.content[0]?.text ?? "");
    },
    runInWorkspaceThreadContext: <T>(_runtime: WorkspaceRuntime, fn: () => T): T => fn(),
    sendWorkspaceReply: async (_chatId: number | undefined, _replyTo: number | undefined, text: string) => {
      replies.push(text);
      return 1;
    },
    startWorkspaceTyping: () => {},
    stopWorkspaceTyping: () => {},
    persist: async () => {},
  } as unknown as WsRuntimeContext<unknown>;
  (self as unknown as { deliveredPrompts: string[] }).deliveredPrompts = deliveredPrompts;
  const deps = {
    getCwd: () => "/repo",
    sendTextReply: async (_chatId: number, _replyTo: number | undefined, text: string) => {
      replies.push(text);
      return 1;
    },
    getConfig: () => ({ inactiveNotify: false, workerExtensions: [] }),
  } as unknown as TelegramWorkspaceManagerDeps<unknown>;
  const api = installRalph(self, deps, { tickDelayMs: 0 });
  return {
    self,
    deps,
    runtime,
    backend,
    replies,
    api,
    statePath: getTelegramRalphStatePath(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function waitForTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

test("handleRalphCommand rejects outside a bound topic", async () => {
  const harness = createControllerHarness({ scoped: false, hasRuntime: false });
  try {
    const handled = await harness.api.handleRalphCommand?.("count to 3", -1, 5, {});
    assert.equal(handled, true);
    assert.deepEqual(harness.replies, [RALPH_TOPIC_ONLY_MESSAGE]);
  } finally {
    harness.cleanup();
  }
});

test("handleRalphCommand rejects a non-topic runtime (General default workspace)", async () => {
  // With generalIsDefault, the General chat resolves to a scoped default
  // workspace whose source is not telegram-topic; /ralph must still be rejected
  // so the parent never arms a loop against itself.
  const harness = createControllerHarness({ scoped: true, nonTopicSource: true });
  try {
    const handled = await harness.api.handleRalphCommand?.("count to 3", -100, 5, {});
    assert.equal(handled, true);
    assert.deepEqual(harness.replies, [RALPH_TOPIC_ONLY_MESSAGE]);
    const delivered = (harness.self as unknown as { deliveredPrompts: string[] })
      .deliveredPrompts;
    assert.equal(delivered.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("handleRalphCommand starts the arm dialogue in the topic child", async () => {
  const harness = createControllerHarness();
  try {
    await harness.api.handleRalphCommand?.("count to 3", -100, 5, {});
    const delivered = (harness.self as unknown as { deliveredPrompts: string[] })
      .deliveredPrompts;
    assert.equal(delivered.length, 1);
    assert.match(delivered[0], /count to 3/);
    assert.match(delivered[0], /RALPH-ARM:/);
  } finally {
    harness.cleanup();
  }
});

test("RALPH-ARM marker arms the loop and hands off iteration #1", async () => {
  const harness = createControllerHarness();
  try {
    harness.self.handleRalphAgentEnd?.(
      "topic-1",
      harness.runtime,
      'ok, confirmed.\nRALPH-ARM: {"kickoff":"count","exit_condition":"counter >= 3","guardrails":""}',
      "ok",
    );
    await waitForTick();
    assert.ok(harness.replies.some((reply) => reply.includes("Ralph loop armed")));
    const methods = harness.backend.calls.map((call) => call.method);
    assert.deepEqual(methods, ["newSession", "setSessionName", "prompt"]);
    assert.deepEqual(harness.backend.calls[1].args, ["my task"]);
    assert.match(String(harness.backend.calls[2].args[0]), /iteration #1/);
    const store = createRalphStateStore(harness.statePath);
    const state = store.read("topic-1");
    assert.equal(state?.active, true);
    assert.equal(state?.expectedTurnId, harness.runtime.activeTurnId);
  } finally {
    harness.cleanup();
  }
});

test("re-arming from a compounded session name uses a clean base (no compounding)", async () => {
  // Bug 1 regression: a prior run leaves record.sessionName as base#loop2; the
  // next arm must strip the suffix so names never grow base#loop2#loop1...
  const harness = createControllerHarness({ sessionName: "my task#loop2" });
  try {
    harness.self.handleRalphAgentEnd?.(
      "topic-1",
      harness.runtime,
      'RALPH-ARM: {"kickoff":"count","exit_condition":"counter >= 3","guardrails":""}',
      "ok",
    );
    await waitForTick();
    const store = createRalphStateStore(harness.statePath);
    assert.equal(store.read("topic-1")?.baseName, "my task");
    // Iteration #1 renames to the clean base, not base#loop2.
    assert.deepEqual(harness.backend.calls[1].args, ["my task"]);
  } finally {
    harness.cleanup();
  }
});

test("RALPH continue marker advances loop and renames base#loopN", async () => {
  const harness = createControllerHarness();
  const store = createRalphStateStore(harness.statePath);
  try {
    harness.runtime.activeTurnId = "ralph:topic-1:loop0:1";
    store.write("topic-1", makeState({ baseName: "my task", expectedTurnId: "ralph:topic-1:loop0:1" }));
    harness.self.handleRalphAgentEnd?.(
      "topic-1",
      harness.runtime,
      "did one unit\nRALPH: continue | note=counter at 1",
      "ok",
    );
    await waitForTick();
    const methods = harness.backend.calls.map((call) => call.method);
    assert.deepEqual(methods, ["newSession", "setSessionName", "prompt"]);
    assert.deepEqual(harness.backend.calls[1].args, ["my task#loop1"]);
    const prompt = String(harness.backend.calls[2].args[0]);
    assert.match(prompt, /iteration #2/);
    assert.match(prompt, /counter at 1/);
    assert.equal(store.read("topic-1")?.loop, 1);
  } finally {
    harness.cleanup();
  }
});

test("RALPH done marker finishes the loop without handing off", async () => {
  const harness = createControllerHarness();
  const store = createRalphStateStore(harness.statePath);
  try {
    harness.runtime.activeTurnId = "ralph:topic-1:loop2:1";
    store.write("topic-1", makeState({ loop: 2, expectedTurnId: "ralph:topic-1:loop2:1" }));
    harness.self.handleRalphAgentEnd?.(
      "topic-1",
      harness.runtime,
      "all finished\nRALPH: done | note=counter reached 3",
      "ok",
    );
    await waitForTick();
    assert.equal(harness.backend.calls.length, 0);
    assert.equal(store.read("topic-1")?.active, false);
    assert.ok(
      harness.replies.some((reply) =>
        reply.includes("finished after 3 iteration(s)") &&
        reply.includes("exit condition met"),
      ),
    );
  } finally {
    harness.cleanup();
  }
});

test("missing marker on an expected Ralph turn stalls and stops the loop", async () => {
  const harness = createControllerHarness();
  const store = createRalphStateStore(harness.statePath);
  try {
    harness.runtime.activeTurnId = "ralph:topic-1:loop1:1";
    store.write("topic-1", makeState({ loop: 1, expectedTurnId: "ralph:topic-1:loop1:1" }));
    harness.self.handleRalphAgentEnd?.("topic-1", harness.runtime, "no marker", "ok");
    await waitForTick();
    assert.equal(harness.backend.calls.length, 0);
    assert.equal(store.read("topic-1")?.active, false);
    assert.ok(harness.replies.some((reply) => reply.includes("stalled")));
  } finally {
    harness.cleanup();
  }
});

test("error and abort on an expected Ralph turn stop the loop", async () => {
  for (const stopReason of ["error", "aborted"] as const) {
    const harness = createControllerHarness();
    const store = createRalphStateStore(harness.statePath);
    try {
      harness.runtime.activeTurnId = "ralph:topic-1:loop0:1";
      store.write("topic-1", makeState({ expectedTurnId: "ralph:topic-1:loop0:1" }));
      harness.self.handleRalphAgentEnd?.("topic-1", harness.runtime, "", stopReason);
      await waitForTick();
      assert.equal(harness.backend.calls.length, 0, stopReason);
      assert.equal(store.read("topic-1")?.active, false, stopReason);
    } finally {
      harness.cleanup();
    }
  }
});

test("non-Ralph turns and unexpected turn ids are ignored", async () => {
  const harness = createControllerHarness();
  const store = createRalphStateStore(harness.statePath);
  try {
    harness.runtime.activeTurnId = "workspace:topic-1:other";
    store.write("topic-1", makeState({ expectedTurnId: "ralph:topic-1:loop0:1" }));
    harness.self.handleRalphAgentEnd?.(
      "topic-1",
      harness.runtime,
      "user turn\nRALPH: continue | note=spoofed",
      "ok",
    );
    await waitForTick();
    assert.equal(harness.backend.calls.length, 0);
    assert.equal(store.read("topic-1")?.active, true);
    assert.equal(store.read("topic-1")?.loop, 0);
  } finally {
    harness.cleanup();
  }
});

test("/ralph stop deactivates and /ralph status reports", async () => {
  const harness = createControllerHarness();
  const store = createRalphStateStore(harness.statePath);
  try {
    store.write("topic-1", makeState({ loop: 1 }));
    await harness.api.handleRalphCommand?.("status", -100, 5, {});
    assert.ok(harness.replies.some((reply) => reply.includes("iteration #2")));
    await harness.api.handleRalphCommand?.("stop", -100, 6, {});
    assert.equal(store.read("topic-1")?.active, false);
    await harness.api.handleRalphCommand?.("stop", -100, 7, {});
    assert.ok(harness.replies.some((reply) => reply.includes("No active Ralph loop")));
  } finally {
    harness.cleanup();
  }
});

test("arming while a loop is active is rejected", async () => {
  const harness = createControllerHarness();
  const store = createRalphStateStore(harness.statePath);
  try {
    store.write("topic-1", makeState());
    await harness.api.handleRalphCommand?.("another task", -100, 5, {});
    assert.ok(
      harness.replies.some((reply) => reply.includes("already active")),
    );
    harness.self.handleRalphAgentEnd?.(
      "topic-1",
      harness.runtime,
      'RALPH-ARM: {"kickoff":"x","exit_condition":"y"}',
      "ok",
    );
    await waitForTick();
    assert.ok(
      harness.replies.some((reply) => reply.includes("ignoring RALPH-ARM")),
    );
    assert.equal(harness.backend.calls.length, 0);
  } finally {
    harness.cleanup();
  }
});
