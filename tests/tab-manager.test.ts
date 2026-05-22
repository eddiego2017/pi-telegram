/**
 * Regression tests for Telegram tab manager orchestration
 * Covers disabled behavior, prompt dispatch, inactive completion notices, and switching back to buffered output
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTelegramTabManager,
  type TelegramTabBackend,
} from "../lib/tab-manager.ts";
import type {
  RpcChildBackendEvent,
  RpcChildSessionState,
} from "../lib/rpc-child.ts";
import type { TelegramConcurrentTabsConfig } from "../lib/config.ts";

class FakeTabBackend implements TelegramTabBackend {
  readonly prompts: string[] = [];
  readonly followUps: string[] = [];
  readonly aborts: string[] = [];
  readonly modelSelections: string[] = [];
  readonly thinkingSelections: string[] = [];
  disposed = false;
  readonly tabName: string;
  private listeners = new Set<(event: RpcChildBackendEvent) => void>();
  private state: RpcChildSessionState;

  constructor(tabName: string) {
    this.tabName = tabName;
    this.state = {
      sessionFile: `/sessions/${tabName}.jsonl`,
      sessionId: `session-${tabName}`,
      isStreaming: false,
    };
  }

  async start(): Promise<RpcChildSessionState> {
    return this.state;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  onEvent(listener: (event: RpcChildBackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async prompt(message: string): Promise<void> {
    this.prompts.push(message);
    this.state = { ...this.state, isStreaming: true };
  }

  async followUp(message: string): Promise<void> {
    this.followUps.push(message);
    this.state = { ...this.state, isStreaming: true };
  }

  async abort(): Promise<void> {
    this.aborts.push(this.tabName);
    this.state = { ...this.state, isStreaming: false };
  }

  async getState(): Promise<RpcChildSessionState> {
    return this.state;
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.modelSelections.push(`${provider}/${modelId}`);
    this.state = {
      ...this.state,
      model: { provider, id: modelId },
    };
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.thinkingSelections.push(level);
    this.state = {
      ...this.state,
      thinkingLevel: level,
    };
  }

  emit(event: RpcChildBackendEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

test("Tab manager declines prompt dispatch when disabled", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-disabled-"));
  const replies: string[] = [];
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: false,
      maxTabs: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "tabs.json"),
    sessionRoot: join(tempDir, "sessions"),
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });
  assert.equal(
    await manager.dispatchPrompt(
      {
        chatId: 1,
        replyToMessageId: 2,
        content: [{ type: "text", text: "hello" }],
      },
      "ctx",
    ),
    false,
  );
  assert.equal(await manager.handleCommand("", 1, 2, "ctx"), true);
  assert.match(replies[0] ?? "", /Concurrent tabs are disabled/);
});

test("Tab manager routes prompts to active workers and notifies inactive completion", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-runtime-"));
  const replies: string[] = [];
  const backends = new Map<string, FakeTabBackend>();
  let currentTime = 1000;
  const config: Required<TelegramConcurrentTabsConfig> = {
    enabled: true,
    maxTabs: 4,
    inactiveNotify: true,
    workerExtensions: ["/agent/extensions/provider.ts"],
  };
  const backendOptions: unknown[] = [];
  const manager = createTelegramTabManager<string>({
    getConfig: () => config,
    getCwd: () => "/repo",
    now: () => currentTime,
    statePath: join(tempDir, "tabs.json"),
    sessionRoot: join(tempDir, "sessions"),
    createBackend: (options) => {
      backendOptions.push(options);
      const backend = new FakeTabBackend(options.tabName);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  assert.match(replies.at(-1) ?? "", /Created and switched to tab A/);
  assert.deepEqual(
    (backendOptions[0] as { args?: string[] }).args,
    ["--extension", "/agent/extensions/provider.ts"],
  );
  assert.equal(await manager.canSwitchActiveModel("ctx"), true);
  assert.equal(
    await manager.selectActiveModel(
      { provider: "openai", id: "gpt-5.5" },
      "ctx",
    ),
    true,
  );
  assert.deepEqual(backends.get("A")?.modelSelections, ["openai/gpt-5.5"]);
  assert.deepEqual(await manager.getActiveModel("ctx"), {
    provider: "openai",
    id: "gpt-5.5",
  });
  assert.equal(await manager.setActiveThinkingLevel("high", "ctx"), true);
  assert.equal(await manager.getActiveThinkingLevel("ctx"), "high");
  assert.deepEqual(backends.get("A")?.thinkingSelections, ["high"]);

  await manager.dispatchPrompt(
    {
      chatId: 1,
      replyToMessageId: 20,
      content: [{ type: "text", text: "hello A" }],
    },
    "ctx",
  );
  assert.deepEqual(backends.get("A")?.prompts, ["hello A"]);
  assert.match(replies.at(-1) ?? "", /Started tab A/);
  assert.equal(await manager.canSwitchActiveModel("ctx"), false);
  assert.equal(
    await manager.selectActiveModel(
      { provider: "openai", id: "gpt-5.4" },
      "ctx",
    ),
    false,
  );
  assert.deepEqual(backends.get("A")?.modelSelections, ["openai/gpt-5.5"]);

  await manager.dispatchPrompt(
    {
      chatId: 1,
      replyToMessageId: 21,
      content: [{ type: "text", text: "second A" }],
    },
    "ctx",
  );
  assert.deepEqual(backends.get("A")?.followUps, ["second A"]);
  assert.match(replies.at(-1) ?? "", /Queued follow-up in tab A/);

  await manager.handleCommand("new B", 1, 30, "ctx");
  assert.match(replies.at(-1) ?? "", /Created and switched to tab B/);

  currentTime = 2000;
  backends.get("A")?.emit({ type: "agent_start" });
  backends.get("A")?.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "answer A" },
  });
  backends.get("A")?.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "answer A" }] },
    ],
  });
  assert.match(replies.at(-1) ?? "", /Tab A finished/);
  assert.equal(replies.includes("answer A"), false);

  await manager.handleCommand("A", 1, 40, "ctx");
  assert.match(replies.at(-1) ?? "", /Switched to tab A\.\n\nLast reply:\nanswer A/);

  await manager.handleCommand("abort A", 1, 50, "ctx");
  assert.deepEqual(backends.get("A")?.aborts, ["A"]);
});
