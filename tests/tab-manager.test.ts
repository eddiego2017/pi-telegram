/**
 * Regression tests for Telegram tab manager orchestration
 * Covers disabled behavior, prompt dispatch, inactive completion notices, and switching back to buffered output
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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

function waitForTabStreamFlush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
  assert.deepEqual(manager.getActiveSessionReference("ctx"), {
    tabName: "A",
    cwd: "/repo",
    sessionFile: "/sessions/A.jsonl",
    sessionId: "session-A",
    sessionName: undefined,
  });
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
  assert.deepEqual(manager.getActiveSessionReference("ctx"), {
    tabName: "B",
    cwd: "/repo",
    sessionFile: "/sessions/B.jsonl",
    sessionId: "session-B",
    sessionName: undefined,
  });

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
  assert.equal(manager.getActiveSessionReference("ctx")?.tabName, "A");

  await manager.handleCommand("abort A", 1, 50, "ctx");
  assert.deepEqual(backends.get("A")?.aborts, ["A"]);
});

test("Tab manager sends last-turn replay after tab switch", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-switch-replay-"));
  const replies: string[] = [];
  const replays: string[] = [];
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 10,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "tabs.json"),
    sessionRoot: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
    sendLastTurnsOnSwitch: async (reference, chatId, replyToMessageId) => {
      replays.push(
        `${reference.tabName}:${reference.sessionFile}:${chatId}:${replyToMessageId}`,
      );
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.handleCommand("new B", 1, 20, "ctx");
  await manager.handleCommand("A", 7, 30, "ctx");

  assert.match(replies.at(-1) ?? "", /Switched to tab A/);
  assert.deepEqual(replays, ["A:/sessions/A.jsonl:7:30"]);
});

test("Tab manager renames tabs without discarding session state", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-rename-"));
  const replies: string[] = [];
  const backends = new Map<string, FakeTabBackend>();
  const statePath = join(tempDir, "tabs.json");
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 10,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath,
    sessionRoot: join(tempDir, "sessions"),
    createBackend: (options) => {
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
  await manager.handleCommand("rename A Alpha", 1, 11, "ctx");
  assert.match(replies.at(-1) ?? "", /Renamed tab A to Alpha/);
  assert.deepEqual(manager.getActiveSessionReference("ctx"), {
    tabName: "Alpha",
    cwd: "/repo",
    sessionFile: "/sessions/A.jsonl",
    sessionId: "session-A",
    sessionName: undefined,
  });
  await manager.dispatchPrompt(
    {
      chatId: 1,
      replyToMessageId: 12,
      content: [{ type: "text", text: "hello renamed tab" }],
    },
    "ctx",
  );
  assert.deepEqual(backends.get("A")?.prompts, ["hello renamed tab"]);
  assert.match(replies.at(-1) ?? "", /Started tab Alpha/);

  const saved = JSON.parse(await readFile(statePath, "utf8")) as {
    activeTab: string;
    tabs: Record<string, unknown>;
  };
  assert.equal(saved.activeTab, "Alpha");
  assert.equal(saved.tabs.A, undefined);
  assert.ok(saved.tabs.Alpha);

  await manager.handleCommand("rename Alpha", 1, 13, "ctx");
  assert.match(replies.at(-1) ?? "", /already named Alpha/);
  await manager.handleCommand("rename Alpha default", 1, 14, "ctx");
  assert.match(replies.at(-1) ?? "", /Tab default already exists/);
  await manager.handleCommand("rename default Other", 1, 15, "ctx");
  assert.match(replies.at(-1) ?? "", /Cannot rename default tab/);
});

test("Tab manager sends typing actions for the active running tab", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-typing-"));
  const replies: string[] = [];
  const typingActions: number[] = [];
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 10,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "tabs.json"),
    sessionRoot: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
    sendTypingAction: async (chatId) => {
      typingActions.push(chatId);
    },
    typingIntervalMs: 5,
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.dispatchPrompt(
    {
      chatId: 7,
      replyToMessageId: 20,
      content: [{ type: "text", text: "long A" }],
    },
    "ctx",
  );
  assert.deepEqual(typingActions, [7]);

  await manager.handleCommand("new B", 1, 30, "ctx");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(typingActions, [7]);

  await manager.handleCommand("A", 1, 40, "ctx");
  assert.deepEqual(typingActions, [7, 7]);
  backends.get("A")?.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "done A" }] },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(typingActions, [7, 7]);
  await manager.dispose();
});

test("Tab manager relays active worker thinking and tool call output", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-rendering-"));
  const textReplies: string[] = [];
  const markdownReplies: string[] = [];
  const streamReplies: string[] = [];
  const streamEdits: string[] = [];
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "tabs.json"),
    sessionRoot: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      textReplies.push(text);
      return textReplies.length;
    },
    sendMarkdownReply: async (_chatId, _replyToMessageId, markdown) => {
      markdownReplies.push(markdown);
      return markdownReplies.length;
    },
    sendStreamMarkdownReply: async (_chatId, _replyToMessageId, markdown) => {
      streamReplies.push(markdown);
      return 100 + streamReplies.length;
    },
    editStreamMarkdownMessage: async (_chatId, messageId, markdown) => {
      streamEdits.push(`${messageId}:${markdown}`);
      return messageId;
    },
    streamEditThrottleMs: 0,
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.dispatchPrompt(
    {
      chatId: 1,
      replyToMessageId: 20,
      content: [{ type: "text", text: "inspect repo" }],
    },
    "ctx",
  );

  const backend = backends.get("A");
  assert.ok(backend);
  backend.emit({ type: "agent_start" });
  backend.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "I should ",
    },
  });
  await waitForTabStreamFlush();
  assert.match(streamReplies.at(-1) ?? "", /💡 Thinking/);
  assert.match(streamReplies.at(-1) ?? "", /I should/);

  backend.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "inspect the repo.",
    },
  });
  await waitForTabStreamFlush();
  assert.match(streamEdits.at(-1) ?? "", /101:💡 Thinking/);
  assert.match(streamEdits.at(-1) ?? "", /I should inspect the repo\./);

  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
  });
  await waitForTabStreamFlush();
  assert.equal(
    [...streamReplies, ...streamEdits].filter((reply) =>
      reply.includes("I should inspect the repo."),
    ).length,
    1,
  );

  backend.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 1,
      partial: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should inspect the repo." },
          {
            type: "toolCall",
            id: "tool-1",
            name: "bash",
            arguments: {},
            partialJson: "",
          },
        ],
      },
    },
  });
  await waitForTabStreamFlush();
  assert.match(streamReplies.at(-1) ?? "", /🔧 `bash`/);

  backend.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_delta",
      contentIndex: 1,
      partial: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should inspect the repo." },
          {
            type: "toolCall",
            id: "tool-1",
            name: "bash",
            arguments: { command: "pwd" },
            partialJson: '{ "command": "pwd" }',
          },
        ],
      },
    },
  });
  await waitForTabStreamFlush();
  assert.match(streamEdits.at(-1) ?? "", /102:🔧 `bash`/);
  assert.match(streamEdits.at(-1) ?? "", /"command": "pwd"/);

  backend.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: {
        type: "toolCall",
        id: "tool-1",
        name: "bash",
        arguments: { command: "pwd" },
      },
    },
  });
  await waitForTabStreamFlush();

  backend.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 2,
      delta: "I'll check ",
    },
  });
  await waitForTabStreamFlush();
  assert.equal(streamReplies.at(-1), "I'll check");

  backend.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 2,
      delta: "the working directory",
    },
  });
  await waitForTabStreamFlush();
  assert.match(streamEdits.at(-1) ?? "", /103:I'll check the working directory/);

  backend.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should inspect the repo." },
        { type: "text", text: "I'll check the working directory." },
        {
          type: "toolCall",
          id: "tool-1",
          name: "bash",
          arguments: { command: "pwd" },
        },
      ],
    },
  });
  await waitForTabStreamFlush();
  assert.equal(
    [...streamReplies, ...streamEdits, ...markdownReplies].filter((reply) =>
      reply.includes("I should inspect the repo."),
    ).length,
    1,
  );
  assert.equal(markdownReplies.some((reply) => reply.includes("🔧 `bash`")), false);
  assert.ok(
    [...streamReplies, ...streamEdits].filter((reply) =>
      reply.includes("🔧 `bash`"),
    ).length >= 2,
  );
  assert.equal(
    markdownReplies.some((reply) => reply.includes("I'll check")),
    false,
  );
  assert.match(streamEdits.at(-1) ?? "", /103:I'll check the working directory\./);

  backend.emit({
    type: "message_start",
    message: {
      role: "assistant",
      content: [],
    },
  });

  backend.emit({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
      },
    ],
  });
  await waitForTabStreamFlush();
  assert.equal(markdownReplies.at(-1), "Done.");
});
