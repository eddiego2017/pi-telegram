/**
 * Regression tests for Telegram tab manager orchestration
 * Covers disabled behavior, prompt dispatch, inactive completion notices, and switching back to buffered output
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTelegramTabAwareSessionDeletePorts,
  createTelegramTabAwareTreeMenuPorts,
  createTelegramTabAwareResumeMenuPorts,
  createTelegramTabAwareSessionNamePorts,
  createTelegramTabAwareSessionSnapshotPorts,
  createTelegramTabManager,
  type TelegramTabBackend,
  type TelegramTabManager,
} from "../lib/tab-manager.ts";
import type {
  RpcChildBackendEvent,
  RpcChildSessionState,
} from "../lib/rpc-child.ts";
import type { TelegramNormalizedConcurrentTabsConfig } from "../lib/config.ts";
import {
  getAmbientTelegramThreadContext,
  runWithTelegramThreadContext,
} from "../lib/thread-context.ts";
import {
  normalizeTelegramTopicTabName,
  TELEGRAM_DEFAULT_TAB_NAME,
} from "../lib/tabs.ts";

const previewEnvSnapshot = {
  thinking: process.env.PI_TELEGRAM_THINKING_PREVIEWS,
  toolPreviews: process.env.PI_TELEGRAM_TOOL_PREVIEWS,
  toolPreviewMode: process.env.PI_TELEGRAM_TOOL_PREVIEW_MODE,
};

delete process.env.PI_TELEGRAM_THINKING_PREVIEWS;
delete process.env.PI_TELEGRAM_TOOL_PREVIEWS;
delete process.env.PI_TELEGRAM_TOOL_PREVIEW_MODE;

test.after(() => {
  if (previewEnvSnapshot.thinking === undefined) {
    delete process.env.PI_TELEGRAM_THINKING_PREVIEWS;
  } else {
    process.env.PI_TELEGRAM_THINKING_PREVIEWS = previewEnvSnapshot.thinking;
  }
  if (previewEnvSnapshot.toolPreviews === undefined) {
    delete process.env.PI_TELEGRAM_TOOL_PREVIEWS;
  } else {
    process.env.PI_TELEGRAM_TOOL_PREVIEWS = previewEnvSnapshot.toolPreviews;
  }
  if (previewEnvSnapshot.toolPreviewMode === undefined) {
    delete process.env.PI_TELEGRAM_TOOL_PREVIEW_MODE;
  } else {
    process.env.PI_TELEGRAM_TOOL_PREVIEW_MODE = previewEnvSnapshot.toolPreviewMode;
  }
});

class FakeTabBackend implements TelegramTabBackend {
  readonly prompts: string[] = [];
  readonly followUps: string[] = [];
  readonly aborts: string[] = [];
  readonly compactions: string[] = [];
  readonly modelSelections: string[] = [];
  readonly thinkingSelections: string[] = [];
  readonly sessionNames: string[] = [];
  readonly newSessions: (string | undefined)[] = [];
  readonly switchSessions: string[] = [];
  keepStateOnSwitch = false;
  nextSwitchSessionName: string | undefined;
  disposed = false;
  disposeDeferred: ReturnType<typeof createDeferred<void>> | undefined;
  readonly tabName: string;
  private listeners = new Set<(event: RpcChildBackendEvent) => void>();
  private state: RpcChildSessionState;

  constructor(tabName: string, sessionFile?: string) {
    this.tabName = tabName;
    this.state = {
      sessionFile: sessionFile ?? `/sessions/${tabName}.jsonl`,
      sessionId: `session-${tabName}`,
      messageCount: 0,
      isStreaming: false,
    };
  }

  async start(): Promise<RpcChildSessionState> {
    return this.state;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.disposeDeferred) await this.disposeDeferred.promise;
  }

  onEvent(listener: (event: RpcChildBackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async prompt(message: string): Promise<void> {
    this.prompts.push(message);
    this.state = {
      ...this.state,
      messageCount: (this.state.messageCount ?? 0) + 1,
      isStreaming: true,
    };
  }

  async followUp(message: string): Promise<void> {
    this.followUps.push(message);
    this.state = {
      ...this.state,
      messageCount: (this.state.messageCount ?? 0) + 1,
      isStreaming: true,
    };
  }

  async abort(): Promise<void> {
    this.aborts.push(this.tabName);
    this.state = { ...this.state, isStreaming: false };
  }

  async compact(): Promise<void> {
    this.compactions.push(this.tabName);
    this.state = {
      ...this.state,
      messageCount: (this.state.messageCount ?? 0) + 1,
      isStreaming: false,
    };
  }

  async getState(): Promise<RpcChildSessionState> {
    return this.state;
  }

  setState(nextState: Partial<RpcChildSessionState>): void {
    this.state = { ...this.state, ...nextState };
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

  async setSessionName(name: string): Promise<void> {
    this.sessionNames.push(name);
    const trimmed = name.trim();
    this.state = {
      ...this.state,
      sessionName: trimmed || undefined,
    };
  }

  async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
    this.newSessions.push(parentSession);
    const version = this.newSessions.length;
    this.state = {
      ...this.state,
      sessionFile: `/sessions/${this.tabName}-${version}.jsonl`,
      sessionId: `session-${this.tabName}-${version}`,
      sessionName: undefined,
      messageCount: 0,
      isStreaming: false,
    };
    return { cancelled: false };
  }

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    this.switchSessions.push(sessionPath);
    if (this.keepStateOnSwitch) return { cancelled: false };
    const sessionName = this.nextSwitchSessionName;
    this.nextSwitchSessionName = undefined;
    this.state = {
      ...this.state,
      sessionFile: sessionPath,
      sessionId: `resumed-${this.tabName}`,
      sessionName,
      messageCount: 0,
      isStreaming: false,
    };
    return { cancelled: false };
  }

  emit(event: RpcChildBackendEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function makeResumePortTabManager(
  overrides: Partial<TelegramTabManager<string>>,
): TelegramTabManager<string> {
  return {
    isEnabled: () => true,
    getActiveModel: async () => undefined,
    getActiveThinkingLevel: async () => undefined,
    getActiveSessionReference: () => undefined,
    getActiveResumeSessionScope: () => undefined,
    getActiveSessionName: () => undefined,
    canSwitchActiveModel: async () => true,
    selectActiveModel: async () => true,
    setActiveThinkingLevel: async (level) => level,
    setActiveSessionName: async () => true,
    compactActive: () => false,
    newActiveSession: async () => undefined,
    deleteActiveSession: async () => undefined,
    abortActive: async () => undefined,
    switchSession: async () => false,
    createActiveTreeBranch: async () => undefined,
    handleCommand: async () => false,
    handleCallbackQuery: async () => false,
    handleTopicServiceMessage: async () => false,
    dispatchPrompt: async () => false,
    dispose: async () => undefined,
    ...overrides,
  };
}

function waitForTabStreamFlush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

test("Tab-aware resume ports recompute active tab scope before host fallback", async () => {
  const events: string[] = [];
  const ports = createTelegramTabAwareResumeMenuPorts<string>({
    tabManager: makeResumePortTabManager({
      getActiveResumeSessionScope: () => ({
        kind: "tab",
        tabName: "A",
        cwd: "/repo",
        sessionDir: "/sessions/shared",
        currentSessionFile: "/sessions/current.jsonl",
      }),
      switchSession: async (sessionPath, ctx, scope) => {
        events.push(`tab:${sessionPath}:${ctx}:${scope?.tabName ?? ""}`);
        return true;
      },
    }),
    injectParentResumeExec: async (sessionPath) => {
      events.push(`parent:${sessionPath}`);
    },
  });

  await ports.injectResumeExec("/sessions/old.jsonl", "ctx");

  assert.deepEqual(events, ["tab:/sessions/old.jsonl:ctx:A"]);
});

test("Tab-aware resume ports avoid host fallback when active tab scope is missing", async () => {
  const events: string[] = [];
  const ports = createTelegramTabAwareResumeMenuPorts<string>({
    tabManager: makeResumePortTabManager({
      getActiveResumeSessionScope: () => undefined,
    }),
    injectParentResumeExec: async (sessionPath) => {
      events.push(`parent:${sessionPath}`);
    },
  });

  await assert.rejects(
    () => ports.injectResumeExec("/sessions/old.jsonl", "ctx"),
    /No active tab session scope/,
  );
  assert.deepEqual(events, []);
});

test("Tab-aware resume ports keep host fallback when tabs are disabled", async () => {
  const events: string[] = [];
  const ports = createTelegramTabAwareResumeMenuPorts<string>({
    tabManager: makeResumePortTabManager({
      isEnabled: () => false,
      switchSession: async () => {
        events.push("unexpected-tab");
        return true;
      },
    }),
    injectParentResumeExec: async (sessionPath) => {
      events.push(`parent:${sessionPath}`);
    },
  });

  await ports.injectResumeExec("/host/old.jsonl", "ctx");

  assert.deepEqual(events, ["parent:/host/old.jsonl"]);
});

test("Tab-aware session snapshot ports allow persisted active-tab deletion", () => {
  const ports = createTelegramTabAwareSessionSnapshotPorts({
    tabManager: makeResumePortTabManager({
      getActiveSessionReference: () => ({
        tabName: "A",
        cwd: "/repo",
        sessionFile: "/sessions/A.jsonl",
      }),
    }),
    getParentSnapshot: () => ({ sessionFile: "/sessions/parent.jsonl" }),
    getTabSnapshot: () => ({ sessionFile: "/sessions/A.jsonl" }),
  });

  assert.deepEqual(ports.getSnapshot("ctx"), { sessionFile: "/sessions/A.jsonl" });
  assert.equal(ports.canDeleteCurrent({ sessionFile: "/sessions/A.jsonl" }, "ctx"), true);
  assert.equal(ports.canDeleteCurrent({}, "ctx"), false);
  assert.equal(ports.isReadOnly({}, "ctx"), true);
});

test("Tab-aware session delete ports route active tabs before parent fallback", async () => {
  const events: string[] = [];
  const activePorts = createTelegramTabAwareSessionDeletePorts<string>({
    tabManager: makeResumePortTabManager({
      deleteActiveSession: async (path, ctx) => {
        events.push(`tab:${path}:${ctx}`);
        return true;
      },
    }),
    injectParentDeleteCurrentSession: async (path) => {
      events.push(`parent:${path}`);
    },
  });
  await activePorts.injectDeleteCurrentSession("/sessions/A.jsonl", "ctx");

  const fallbackPorts = createTelegramTabAwareSessionDeletePorts<string>({
    tabManager: makeResumePortTabManager({
      deleteActiveSession: async () => undefined,
    }),
    injectParentDeleteCurrentSession: async (path) => {
      events.push(`parent:${path}`);
    },
  });
  await fallbackPorts.injectDeleteCurrentSession("/sessions/parent.jsonl", "ctx");

  assert.deepEqual(events, [
    "tab:/sessions/A.jsonl:ctx",
    "parent:/sessions/parent.jsonl",
  ]);
});

test("Tab-aware tree ports expose active-tab branch without parent tree exec", async () => {
  const events: string[] = [];
  const snapshot = {};
  const ports = createTelegramTabAwareTreeMenuPorts<string>({
    tabManager: makeResumePortTabManager({
      getActiveSessionReference: () => ({
        tabName: "A",
        cwd: "/repo",
        sessionFile: "/sessions/A.jsonl",
      }),
      createActiveTreeBranch: async (entryId, ctx) => {
        events.push(`branch:${entryId}:${ctx}`);
        return { cancelled: false, text: "selected prompt" };
      },
    }),
    injectParentTreeExec: async (entryId, summarize) => {
      events.push(`parent:${entryId}:${summarize}`);
    },
  });

  assert.equal(ports.isReadOnly(snapshot, "ctx"), true);
  assert.equal(ports.canForkTree(snapshot, "ctx"), true);
  assert.deepEqual(await ports.forkTreeEntry("u1", "ctx"), {
    cancelled: false,
    text: "selected prompt",
  });
  await assert.rejects(
    () => ports.injectTreeExec("u1", false, "ctx"),
    /Active tab tree navigation/,
  );
  assert.deepEqual(events, ["branch:u1:ctx"]);
});

test("Tab-aware tree ports fall back to parent tree exec without active tab", async () => {
  const events: string[] = [];
  const snapshot = {};
  const ports = createTelegramTabAwareTreeMenuPorts<string>({
    tabManager: makeResumePortTabManager({
      getActiveSessionReference: () => undefined,
    }),
    injectParentTreeExec: async (entryId, summarize) => {
      events.push(`parent:${entryId}:${summarize}`);
    },
  });

  assert.equal(ports.isReadOnly(snapshot, "ctx"), false);
  assert.equal(ports.canForkTree(snapshot, "ctx"), false);
  await ports.injectTreeExec("u1", false, "ctx");
  assert.deepEqual(events, ["parent:u1:false"]);
});

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
    sessionDir: join(tempDir, "sessions"),
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

test("Tab manager creates spaced tab names and filters implicit tab queries", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-spaced-filter-"));
  const replies: string[] = [];
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 5,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "tabs.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => new FakeTabBackend(options.tabName, options.sessionFile),
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.handleCommand("new eve online marketing", 1, 10, "ctx");
  assert.match(replies.at(-1) ?? "", /Created and switched to tab eve online marketing/);
  assert.equal(manager.getActiveSessionReference("ctx")?.tabName, "eve online marketing");

  await manager.handleCommand("new eve mining", 1, 11, "ctx");
  await manager.handleCommand("eve online marketing", 1, 12, "ctx");
  assert.match(replies.at(-1) ?? "", /Switched to tab eve online marketing/);

  await manager.handleCommand("eve on", 1, 13, "ctx");
  assert.match(replies.at(-1) ?? "", /Tabs \(1\/3\):/);
  assert.match(replies.at(-1) ?? "", /Filters: eve 3→2, on 2→1/);
  assert.match(replies.at(-1) ?? "", /eve online marketing/);
  assert.doesNotMatch(replies.at(-1) ?? "", /eve mining/);
});

test("Tab manager deletes the active tab session after creating a replacement", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-delete-session-"));
  const statePath = join(tempDir, "tabs.json");
  const replies: string[] = [];
  const deletedSessions: string[] = [];
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
    deleteSessionFile: async (sessionPath) => {
      deletedSessions.push(sessionPath);
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  assert.deepEqual(manager.getActiveSessionReference("ctx"), {
    tabName: "A",
    cwd: "/repo",
    sessionFile: "/sessions/A.jsonl",
    sessionId: "session-A",
    sessionName: undefined,
  });

  assert.equal(await manager.deleteActiveSession("/sessions/A.jsonl", "ctx"), true);

  assert.deepEqual(backends.get("A")?.newSessions, ["/sessions/A.jsonl"]);
  assert.deepEqual(deletedSessions, ["/sessions/A.jsonl"]);
  assert.deepEqual(manager.getActiveSessionReference("ctx"), {
    tabName: "A",
    cwd: "/repo",
    sessionFile: "/sessions/A-1.jsonl",
    sessionId: "session-A-1",
    sessionName: undefined,
  });
});

test("Tab manager compacts the active tab worker", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-compact-"));
  const replies: string[] = [];
  const events: string[] = [];
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  const compactDone = new Promise<void>((resolve) => {
    assert.equal(
      manager.compactActive("ctx", {
        onComplete: () => {
          events.push("complete");
          resolve();
        },
        onError: (error) => {
          events.push(`error:${String(error)}`);
          resolve();
        },
      }),
      true,
    );
  });
  await compactDone;

  assert.deepEqual(backends.get("A")?.compactions, ["A"]);
  assert.deepEqual(events, ["complete"]);
  assert.equal(manager.getActiveSessionReference("ctx")?.sessionId, "session-A");
});

test("Tab manager routes prompts to active workers and notifies inactive completion", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-runtime-"));
  const statePath = join(tempDir, "tabs.json");
  const sharedSessionDir = join(tempDir, "sessions");
  const replies: string[] = [];
  const backends = new Map<string, FakeTabBackend>();
  let currentTime = 1000;
  const config: TelegramNormalizedConcurrentTabsConfig = {
    enabled: true,
    maxTabs: 4,
    inactiveNotify: true,
    workerExtensions: ["/agent/extensions/provider.ts"],
    topicBinding: {
      enabled: false,
      native: false,
      generalIsDefault: true,
      autoCreate: true,
      closeOnTopicClose: true,
      deleteTopicOnClose: false,
      trustedChatIds: [],
    },
  };
  const backendOptions: unknown[] = [];
  const branchCalls: Array<{ tabName: string; sessionFile?: string; entryId: string }> = [];
  const manager = createTelegramTabManager<string>({
    getConfig: () => config,
    getCwd: () => "/repo",
    now: () => currentTime,
    statePath,
    sessionDir: sharedSessionDir,
    createBackend: (options) => {
      backendOptions.push(options);
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
    createTreeBranch: (reference, entryId) => {
      branchCalls.push({
        tabName: reference.tabName,
        sessionFile: reference.sessionFile,
        entryId,
      });
      return { cancelled: false, markerId: "cursor-1", text: `prompt ${entryId}` };
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  assert.match(replies.at(-1) ?? "", /Created and switched to tab A/);
  assert.equal(
    (backendOptions[0] as { sessionDir?: string }).sessionDir,
    sharedSessionDir,
  );
  assert.equal(existsSync(join(sharedSessionDir, "A")), false);
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
  assert.deepEqual(manager.getActiveSessionReference("ctx")?.currentModel, {
    provider: "openai",
    id: "gpt-5.5",
  });
  assert.equal(await manager.setActiveThinkingLevel("high", "ctx"), "high");
  assert.equal(await manager.getActiveThinkingLevel("ctx"), "high");
  assert.deepEqual(backends.get("A")?.thinkingSelections, ["high"]);
  assert.equal(manager.getActiveSessionName("ctx"), undefined);
  assert.equal(await manager.setActiveSessionName("mobile debug", "ctx"), true);
  assert.equal(manager.getActiveSessionName("ctx"), "mobile debug");
  assert.equal(
    manager.getActiveSessionReference("ctx")?.sessionName,
    "mobile debug",
  );
  assert.equal(await manager.setActiveSessionName("", "ctx"), true);
  assert.equal(manager.getActiveSessionName("ctx"), undefined);
  assert.deepEqual(backends.get("A")?.sessionNames, ["mobile debug", ""]);
  assert.deepEqual(await manager.newActiveSession("ctx"), { cancelled: false });
  assert.equal(manager.getActiveSessionName("ctx"), undefined);
  assert.deepEqual(backends.get("A")?.newSessions, [undefined]);
  assert.deepEqual(manager.getActiveSessionReference("ctx"), {
    tabName: "A",
    cwd: "/repo",
    sessionFile: "/sessions/A-1.jsonl",
    sessionId: "session-A-1",
    sessionName: undefined,
    currentModel: {
      provider: "openai",
      id: "gpt-5.5",
    },
  });
  const scope = manager.getActiveResumeSessionScope("ctx");
  assert.equal(scope?.kind, "tab");
  assert.equal(scope?.tabName, "A");
  assert.equal(scope?.sessionDir, sharedSessionDir);
  assert.equal(scope?.currentSessionFile, "/sessions/A-1.jsonl");
  assert.equal(
    await manager.switchSession("/sessions/resumed-A.jsonl", "ctx", scope),
    true,
  );
  assert.deepEqual(backends.get("A")?.switchSessions, [
    "/sessions/resumed-A.jsonl",
  ]);
  assert.deepEqual(manager.getActiveSessionReference("ctx"), {
    tabName: "A",
    cwd: "/repo",
    sessionFile: "/sessions/resumed-A.jsonl",
    sessionId: "resumed-A",
    sessionName: undefined,
    currentModel: {
      provider: "openai",
      id: "gpt-5.5",
    },
  });
  const backendBeforeBranch = backends.get("A");
  assert.deepEqual(await manager.createActiveTreeBranch("u1", "ctx"), {
    cancelled: false,
    markerId: "cursor-1",
    text: "prompt u1",
  });
  assert.deepEqual(branchCalls, [
    { tabName: "A", sessionFile: "/sessions/resumed-A.jsonl", entryId: "u1" },
  ]);
  assert.equal(backendBeforeBranch?.disposed, true);
  assert.deepEqual(manager.getActiveSessionReference("ctx"), {
    tabName: "A",
    cwd: "/repo",
    sessionFile: "/sessions/resumed-A.jsonl",
    sessionId: "resumed-A",
    sessionName: undefined,
    currentModel: {
      provider: "openai",
      id: "gpt-5.5",
    },
  });

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
  assert.deepEqual(backendBeforeBranch?.modelSelections, ["openai/gpt-5.5"]);

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

test("Tab manager routes forum topic prompts to topic-bound tabs without switching active tab", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-topic-routing-"));
  const statePath = join(tempDir, "tabs.json");
  const textReplies: string[] = [];
  const streamReplies: Array<{
    chatId: number;
    replyToMessageId: number | undefined;
    markdown: string;
    scope: ReturnType<typeof getAmbientTelegramThreadContext>;
  }> = [];
  const streamEdits: Array<{
    chatId: number;
    messageId: number;
    markdown: string;
    scope: ReturnType<typeof getAmbientTelegramThreadContext>;
  }> = [];
  const typingScopes: Array<ReturnType<typeof getAmbientTelegramThreadContext>> = [];
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 5,
      inactiveNotify: true,
      workerExtensions: [],
      topicBinding: {
        enabled: true,
        native: false,
        generalIsDefault: true,
        autoCreate: true,
        closeOnTopicClose: true,
        deleteTopicOnClose: false,
        trustedChatIds: [],
      },
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      textReplies.push(text);
      return textReplies.length;
    },
    sendTypingAction: async () => {
      typingScopes.push(getAmbientTelegramThreadContext());
    },
    sendStreamMarkdownReply: async (chatId, replyToMessageId, markdown) => {
      streamReplies.push({
        chatId,
        replyToMessageId,
        markdown,
        scope: getAmbientTelegramThreadContext(),
      });
      return 100 + streamReplies.length;
    },
    editStreamMarkdownMessage: async (chatId, messageId, markdown) => {
      streamEdits.push({
        chatId,
        messageId,
        markdown,
        scope: getAmbientTelegramThreadContext(),
      });
      return messageId;
    },
    streamEditThrottleMs: 0,
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  assert.equal(manager.getActiveSessionReference("ctx")?.tabName, "A");

  await manager.dispatchPrompt(
    {
      chatId: -10042,
      replyToMessageId: 20,
      content: [{ type: "text", text: "general prompt" }],
    },
    "ctx",
  );
  assert.deepEqual(backends.get("default")?.prompts, ["general prompt"]);
  assert.match(textReplies.at(-1) ?? "", /Started tab General/);
  assert.equal(manager.getActiveSessionReference("ctx")?.tabName, "A");

  const topicTab = normalizeTelegramTopicTabName(-10042, 77);
  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 77,
      replyToMessageId: 21,
      content: [{ type: "text", text: "topic prompt" }],
    },
    "ctx",
  );
  assert.deepEqual(backends.get(topicTab)?.prompts, ["topic prompt"]);
  assert.match(textReplies.at(-1) ?? "", new RegExp(`Started tab ${topicTab}`));
  assert.equal(manager.getActiveSessionReference("ctx")?.tabName, "A");
  assert.deepEqual(typingScopes.at(-1), {
    chatId: -10042,
    messageThreadId: 77,
  });

  const topicBackend = backends.get(topicTab);
  assert.ok(topicBackend);
  topicBackend.emit({ type: "agent_start" });
  topicBackend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "topic answer" },
  });
  await waitForTabStreamFlush();
  assert.deepEqual(streamReplies.at(-1), {
    chatId: -10042,
    replyToMessageId: 21,
    markdown: "topic answer",
    scope: { chatId: -10042, messageThreadId: 77 },
  });
  topicBackend.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "topic answer final" }] },
    ],
  });
  await waitForTabStreamFlush();
  assert.equal(streamEdits.at(-1)?.chatId, -10042);
  assert.equal(streamEdits.at(-1)?.messageId, 101);
  assert.equal(streamEdits.at(-1)?.markdown, "topic answer final");
  assert.deepEqual(streamEdits.at(-1)?.scope, {
    chatId: -10042,
    messageThreadId: 77,
  });
  assert.equal(textReplies.some((reply) => reply.includes("finished")), false);

  const saved = JSON.parse(await readFile(statePath, "utf8")) as {
    activeTab: string;
    tabs: Record<string, { source?: unknown }>;
  };
  assert.equal(saved.activeTab, "A");
  assert.deepEqual(saved.tabs[topicTab]?.source, {
    kind: "telegram-topic",
    chatId: -10042,
    messageThreadId: 77,
  });
  await manager.dispose();
});

test("Tab manager handles forum topic service create, edit, and close events", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-topic-service-"));
  const statePath = join(tempDir, "tabs.json");
  const disposed: string[] = [];
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 5,
      inactiveNotify: true,
      workerExtensions: [],
      topicBinding: {
        enabled: true,
        native: false,
        generalIsDefault: true,
        autoCreate: true,
        closeOnTopicClose: true,
        deleteTopicOnClose: false,
        trustedChatIds: [],
      },
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      const originalDispose = backend.dispose.bind(backend);
      backend.dispose = async () => {
        disposed.push(options.tabName);
        await originalDispose();
      };
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async () => undefined,
  });

  assert.equal(
    await manager.handleTopicServiceMessage(
      {
        chat: { id: -10042 },
        message_id: 20,
        message_thread_id: 77,
        forum_topic_created: { name: "Deploy Debug" },
      },
      "ctx",
    ),
    true,
  );
  const topicTab = normalizeTelegramTopicTabName(-10042, 77);
  let saved: { tabs: Record<string, { source?: { topicTitle?: string }; sessionName?: string } | undefined> } =
    JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(saved.tabs[topicTab]?.source?.topicTitle, "Deploy Debug");
  assert.equal(saved.tabs[topicTab]?.sessionName, "Deploy Debug");
  assert.equal(backends.size, 0);

  await manager.handleTopicServiceMessage(
    {
      chat: { id: -10042 },
      message_id: 21,
      message_thread_id: 77,
      forum_topic_edited: { name: "Deploy Debug 2" },
    },
    "ctx",
  );
  saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(saved.tabs[topicTab]?.source?.topicTitle, "Deploy Debug 2");
  assert.equal(saved.tabs[topicTab]?.sessionName, "Deploy Debug 2");

  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 77,
      replyToMessageId: 22,
      content: [{ type: "text", text: "start worker" }],
    },
    "ctx",
  );
  assert.ok(backends.get(topicTab));
  await manager.handleTopicServiceMessage(
    {
      chat: { id: -10042 },
      message_id: 23,
      message_thread_id: 77,
      forum_topic_closed: {},
    },
    "ctx",
  );
  saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(saved.tabs[topicTab], undefined);
  assert.deepEqual(disposed, [topicTab]);
  await manager.dispose();
});

test("Tab manager deletes Telegram forum topics after close when configured", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-topic-delete-on-close-"));
  const statePath = join(tempDir, "tabs.json");
  const disposed: string[] = [];
  const deleteCalls: Array<{ chatId: number; messageThreadId: number }> = [];
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 5,
      inactiveNotify: true,
      workerExtensions: [],
      topicBinding: {
        enabled: true,
        native: false,
        generalIsDefault: true,
        autoCreate: true,
        closeOnTopicClose: true,
        deleteTopicOnClose: true,
        trustedChatIds: [],
      },
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      const originalDispose = backend.dispose.bind(backend);
      backend.dispose = async () => {
        disposed.push(options.tabName);
        await originalDispose();
      };
      return backend;
    },
    sendTextReply: async () => undefined,
    deleteForumTopic: async (chatId, messageThreadId) => {
      deleteCalls.push({ chatId, messageThreadId });
      return true;
    },
  });

  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 77,
      replyToMessageId: 22,
      content: [{ type: "text", text: "start worker" }],
    },
    "ctx",
  );
  const topicTab = normalizeTelegramTopicTabName(-10042, 77);
  await manager.handleTopicServiceMessage(
    {
      chat: { id: -10042 },
      message_id: 23,
      message_thread_id: 77,
      forum_topic_closed: {},
    },
    "ctx",
  );

  const saved = JSON.parse(await readFile(statePath, "utf8")) as {
    tabs: Record<string, unknown>;
  };
  assert.equal(saved.tabs[topicTab], undefined);
  assert.deepEqual(disposed, [topicTab]);
  assert.deepEqual(deleteCalls, [{ chatId: -10042, messageThreadId: 77 }]);
  await manager.dispose();
});

test("Tab manager ignores forum topic service events from untrusted chats", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-topic-untrusted-"));
  const statePath = join(tempDir, "tabs.json");
  const deleteCalls: Array<{ chatId: number; messageThreadId: number }> = [];
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 5,
      inactiveNotify: true,
      workerExtensions: [],
      topicBinding: {
        enabled: true,
        native: false,
        generalIsDefault: true,
        autoCreate: true,
        closeOnTopicClose: true,
        deleteTopicOnClose: true,
        trustedChatIds: [-10042],
      },
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => new FakeTabBackend(options.tabName, options.sessionFile),
    sendTextReply: async () => undefined,
    deleteForumTopic: async (chatId, messageThreadId) => {
      deleteCalls.push({ chatId, messageThreadId });
      return true;
    },
  });

  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 77,
      replyToMessageId: 22,
      content: [{ type: "text", text: "start worker" }],
    },
    "ctx",
  );
  const trustedTopicTab = normalizeTelegramTopicTabName(-10042, 77);
  let saved = JSON.parse(await readFile(statePath, "utf8")) as {
    tabs: Record<string, unknown>;
  };
  assert.ok(saved.tabs[trustedTopicTab]);

  await manager.handleTopicServiceMessage(
    {
      chat: { id: -10043 },
      message_id: 20,
      message_thread_id: 77,
      forum_topic_created: { name: "Untrusted" },
    },
    "ctx",
  );
  saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(saved.tabs[normalizeTelegramTopicTabName(-10043, 77)], undefined);

  await manager.handleTopicServiceMessage(
    {
      chat: { id: -10043 },
      message_id: 23,
      message_thread_id: 77,
      forum_topic_closed: {},
    },
    "ctx",
  );
  saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.ok(saved.tabs[trustedTopicTab]);
  assert.deepEqual(deleteCalls, []);
  await manager.dispose();
});

test("Tab manager warns when delete-topic-on-close lacks Telegram rights", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-topic-delete-rights-"));
  const statePath = join(tempDir, "tabs.json");
  const replies: Array<{ chatId: number; replyToMessageId: number | undefined; text: string }> = [];
  const runtimeEvents: Array<Record<string, unknown>> = [];
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 5,
      inactiveNotify: true,
      workerExtensions: [],
      topicBinding: {
        enabled: true,
        native: false,
        generalIsDefault: true,
        autoCreate: true,
        closeOnTopicClose: true,
        deleteTopicOnClose: true,
        trustedChatIds: [],
      },
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => new FakeTabBackend(options.tabName, options.sessionFile),
    sendTextReply: async (chatId, replyToMessageId, text) => {
      replies.push({ chatId, replyToMessageId, text });
      return replies.length;
    },
    deleteForumTopic: async () => {
      throw new Error("Bad Request: not enough rights to manage topics");
    },
    recordRuntimeEvent: (category, error, details) => {
      runtimeEvents.push({
        category,
        message: error instanceof Error ? error.message : String(error),
        details,
      });
    },
  });

  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 77,
      replyToMessageId: 22,
      content: [{ type: "text", text: "start worker" }],
    },
    "ctx",
  );
  const topicTab = normalizeTelegramTopicTabName(-10042, 77);
  replies.length = 0;
  await manager.handleTopicServiceMessage(
    {
      chat: { id: -10042 },
      message_id: 23,
      message_thread_id: 77,
      forum_topic_closed: {},
    },
    "ctx",
  );

  const saved = JSON.parse(await readFile(statePath, "utf8")) as {
    tabs: Record<string, unknown>;
  };
  assert.equal(saved.tabs[topicTab], undefined);
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0], {
    chatId: -10042,
    replyToMessageId: undefined,
    text: "已關閉 pi tab，但無法刪除 Telegram topic。請把 bot 設為 admin，並開啟 Manage Topics 權限。",
  });
  assert.equal(runtimeEvents[0]?.category, "tabs");
  assert.deepEqual((runtimeEvents[0]?.details as Record<string, unknown>).action, "deleteForumTopic");
  await manager.dispose();
});

test("Tab manager syncs forum topic titles into active session names", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-topic-title-session-"));
  const statePath = join(tempDir, "tabs.json");
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 5,
      inactiveNotify: true,
      workerExtensions: [],
      topicBinding: {
        enabled: true,
        native: false,
        generalIsDefault: true,
        autoCreate: true,
        closeOnTopicClose: true,
        deleteTopicOnClose: false,
        trustedChatIds: [],
      },
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async () => undefined,
  });

  await manager.handleTopicServiceMessage(
    {
      chat: { id: -10042 },
      message_id: 20,
      message_thread_id: 77,
      forum_topic_created: { name: "Deploy Debug" },
    },
    "ctx",
  );

  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 77,
      replyToMessageId: 21,
      content: [{ type: "text", text: "start worker" }],
    },
    "ctx",
  );

  const topicTab = normalizeTelegramTopicTabName(-10042, 77);
  assert.deepEqual(backends.get(topicTab)?.sessionNames, ["Deploy Debug"]);

  await manager.handleTopicServiceMessage(
    {
      chat: { id: -10042 },
      message_id: 22,
      message_thread_id: 77,
      forum_topic_edited: { name: "Prod Debug" },
    },
    "ctx",
  );

  assert.deepEqual(backends.get(topicTab)?.sessionNames, [
    "Deploy Debug",
    "Prod Debug",
  ]);
  assert.equal(
    manager.getActiveSessionReference("ctx")?.tabName,
    TELEGRAM_DEFAULT_TAB_NAME,
  );
  await runWithTelegramThreadContext(
    { chatId: -10042, messageThreadId: 77 },
    async () => {
      assert.equal(manager.getActiveSessionName("ctx"), "Prod Debug");
      assert.equal(
        manager.getActiveSessionReference("ctx")?.sessionName,
        "Prod Debug",
      );
    },
  );

  const saved = JSON.parse(await readFile(statePath, "utf8")) as {
    tabs: Record<string, { source?: { topicTitle?: string }; sessionName?: string }>;
  };
  assert.equal(saved.tabs[topicTab]?.source?.topicTitle, "Prod Debug");
  assert.equal(saved.tabs[topicTab]?.sessionName, "Prod Debug");
  await manager.dispose();
});

test("Tab manager blocks one session from being attached to multiple open topics", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-topic-session-owner-"));
  const statePath = join(tempDir, "tabs.json");
  const sessionFile = join(tempDir, "shared.jsonl");
  await writeFile(sessionFile, "", "utf8");
  const symlinkPath = join(tempDir, "shared-link.jsonl");
  await symlink(sessionFile, symlinkPath);
  const replies: string[] = [];
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 5,
      inactiveNotify: true,
      workerExtensions: [],
      topicBinding: {
        enabled: true,
        native: false,
        generalIsDefault: true,
        autoCreate: true,
        closeOnTopicClose: true,
        deleteTopicOnClose: false,
        trustedChatIds: [],
      },
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  const topicA = normalizeTelegramTopicTabName(-10042, 77);
  const topicB = normalizeTelegramTopicTabName(-10042, 88);
  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 77,
      replyToMessageId: 21,
      content: [{ type: "text", text: "topic A" }],
    },
    "ctx",
  );
  backends.get(topicA)?.setState({ isStreaming: false });
  backends.get(topicA)?.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "A done" }] },
    ],
  });
  await runWithTelegramThreadContext(
    { chatId: -10042, messageThreadId: 77 },
    async () => {
      const scope = manager.getActiveResumeSessionScope("ctx");
      assert.equal(scope?.tabName, topicA);
      assert.equal(await manager.switchSession(sessionFile, "ctx", scope), true);
    },
  );

  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 88,
      replyToMessageId: 22,
      content: [{ type: "text", text: "topic B" }],
    },
    "ctx",
  );
  backends.get(topicB)?.setState({ isStreaming: false });
  backends.get(topicB)?.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "B done" }] },
    ],
  });
  const topicBBackend = backends.get(topicB);
  assert.ok(topicBBackend);
  await runWithTelegramThreadContext(
    { chatId: -10042, messageThreadId: 88 },
    async () => {
      const scope = manager.getActiveResumeSessionScope("ctx");
      assert.equal(scope?.tabName, topicB);
      await assert.rejects(
        () => manager.switchSession(symlinkPath, "ctx", scope),
        /already open in workspace/,
      );
    },
  );
  assert.deepEqual(topicBBackend.switchSessions, []);

  await manager.handleTopicServiceMessage(
    {
      chat: { id: -10042 },
      message_id: 30,
      message_thread_id: 77,
      forum_topic_closed: {},
    },
    "ctx",
  );
  await runWithTelegramThreadContext(
    { chatId: -10042, messageThreadId: 88 },
    async () => {
      const scope = manager.getActiveResumeSessionScope("ctx");
      assert.equal(await manager.switchSession(sessionFile, "ctx", scope), true);
    },
  );
  assert.deepEqual(topicBBackend.switchSessions, [sessionFile]);
  await manager.dispose();
});

test("Tab manager blocks conflicting topic prompts by live session state", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-topic-live-owner-"));
  const statePath = join(tempDir, "tabs.json");
  const replies: string[] = [];
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 5,
      inactiveNotify: true,
      workerExtensions: [],
      topicBinding: {
        enabled: true,
        native: false,
        generalIsDefault: true,
        autoCreate: true,
        closeOnTopicClose: true,
        deleteTopicOnClose: false,
        trustedChatIds: [],
      },
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  const topicA = normalizeTelegramTopicTabName(-10042, 77);
  const topicB = normalizeTelegramTopicTabName(-10042, 88);
  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 77,
      replyToMessageId: 21,
      content: [{ type: "text", text: "topic A" }],
    },
    "ctx",
  );
  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 88,
      replyToMessageId: 22,
      content: [{ type: "text", text: "topic B" }],
    },
    "ctx",
  );
  const backendA = backends.get(topicA);
  const backendB = backends.get(topicB);
  assert.ok(backendA);
  assert.ok(backendB);
  backendA.setState({
    isStreaming: false,
    sessionFile: "/sessions/shared-live.jsonl",
    sessionId: "shared-live",
  });
  backendB.setState({
    isStreaming: false,
    sessionFile: "/sessions/shared-live.jsonl",
    sessionId: "shared-live",
  });
  const promptCountBefore = backendB.prompts.length;

  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 88,
      replyToMessageId: 23,
      content: [{ type: "text", text: "should be blocked" }],
    },
    "ctx",
  );

  assert.equal(backendB.prompts.length, promptCountBefore);
  assert.match(replies.at(-1) ?? "", /already open in workspace/);
  await manager.dispose();
});

test("Tab manager ignores late worker output after a forum topic is closed", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-topic-close-late-"));
  const statePath = join(tempDir, "tabs.json");
  const textReplies: string[] = [];
  const markdownReplies: string[] = [];
  const streamReplies: string[] = [];
  const typingScopes: Array<ReturnType<typeof getAmbientTelegramThreadContext>> = [];
  const disposed: string[] = [];
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 5,
      inactiveNotify: true,
      workerExtensions: [],
      topicBinding: {
        enabled: true,
        native: false,
        generalIsDefault: true,
        autoCreate: true,
        closeOnTopicClose: true,
        deleteTopicOnClose: false,
        trustedChatIds: [],
      },
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      const originalDispose = backend.dispose.bind(backend);
      backend.dispose = async () => {
        disposed.push(options.tabName);
        await originalDispose();
      };
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
    sendTypingAction: async () => {
      typingScopes.push(getAmbientTelegramThreadContext());
    },
    streamEditThrottleMs: 0,
    typingIntervalMs: 5,
  });

  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 77,
      replyToMessageId: 21,
      content: [{ type: "text", text: "long topic" }],
    },
    "ctx",
  );
  const topicTab = normalizeTelegramTopicTabName(-10042, 77);
  const backend = backends.get(topicTab);
  assert.ok(backend);
  assert.deepEqual(typingScopes.at(-1), {
    chatId: -10042,
    messageThreadId: 77,
  });

  backend.disposeDeferred = createDeferred<void>();
  const closePromise = manager.handleTopicServiceMessage(
    {
      chat: { id: -10042 },
      message_id: 30,
      message_thread_id: 77,
      forum_topic_closed: {},
    },
    "ctx",
  );
  for (let attempt = 0; attempt < 20 && disposed.length === 0; attempt += 1) {
    await waitForTabStreamFlush();
  }
  assert.deepEqual(disposed, [topicTab]);
  const typingCountAfterClose = typingScopes.length;

  backend.emit({ type: "agent_start" });
  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "late stream" },
  });
  backend.emit({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "late body" }] },
  });
  backend.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "late final" }] },
    ],
  });
  await waitForTabStreamFlush();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(streamReplies, []);
  assert.deepEqual(markdownReplies, []);
  assert.equal(textReplies.some((reply) => reply.includes("finished")), false);
  assert.equal(typingScopes.length, typingCountAfterClose);

  backend.disposeDeferred.resolve();
  await closePromise;
  const saved = JSON.parse(await readFile(statePath, "utf8")) as {
    tabs: Record<string, unknown>;
  };
  assert.equal(saved.tabs[topicTab], undefined);
  await manager.dispose();
});

test("Tab manager preserves session files when closing forum topics", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-topic-session-preserve-"));
  const statePath = join(tempDir, "tabs.json");
  const sessionFile = join(tempDir, "topic-session.jsonl");
  await writeFile(sessionFile, "session data\n", "utf8");
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 5,
      inactiveNotify: true,
      workerExtensions: [],
      topicBinding: {
        enabled: true,
        native: false,
        generalIsDefault: true,
        autoCreate: true,
        closeOnTopicClose: true,
        deleteTopicOnClose: true,
        trustedChatIds: [],
      },
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async () => undefined,
    deleteForumTopic: async () => true,
  });

  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 77,
      replyToMessageId: 21,
      content: [{ type: "text", text: "start topic" }],
    },
    "ctx",
  );
  const topicTab = normalizeTelegramTopicTabName(-10042, 77);
  backends.get(topicTab)?.setState({ isStreaming: false });
  await runWithTelegramThreadContext(
    { chatId: -10042, messageThreadId: 77 },
    async () => {
      const scope = manager.getActiveResumeSessionScope("ctx");
      assert.equal(scope?.tabName, topicTab);
      assert.equal(await manager.switchSession(sessionFile, "ctx", scope), true);
    },
  );
  await manager.handleTopicServiceMessage(
    {
      chat: { id: -10042 },
      message_id: 30,
      message_thread_id: 77,
      forum_topic_closed: {},
    },
    "ctx",
  );

  assert.equal(existsSync(sessionFile), true);
  assert.equal(await readFile(sessionFile, "utf8"), "session data\n");
  await manager.dispose();
});

test("Tab manager applies forum topic titles to new and resumed sessions", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-topic-title-new-resume-"));
  const statePath = join(tempDir, "tabs.json");
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 5,
      inactiveNotify: true,
      workerExtensions: [],
      topicBinding: {
        enabled: true,
        native: false,
        generalIsDefault: true,
        autoCreate: true,
        closeOnTopicClose: true,
        deleteTopicOnClose: false,
        trustedChatIds: [],
      },
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async () => undefined,
  });

  await manager.handleTopicServiceMessage(
    {
      chat: { id: -10042 },
      message_id: 20,
      message_thread_id: 77,
      forum_topic_created: { name: "Deploy Debug" },
    },
    "ctx",
  );

  const topicTab = normalizeTelegramTopicTabName(-10042, 77);
  await runWithTelegramThreadContext(
    { chatId: -10042, messageThreadId: 77 },
    async () => {
      assert.deepEqual(await manager.newActiveSession("ctx"), { cancelled: false });
      assert.equal(manager.getActiveSessionName("ctx"), "Deploy Debug");
      const scope = manager.getActiveResumeSessionScope("ctx");
      assert.equal(
        await manager.switchSession("/sessions/resumed-topic.jsonl", "ctx", scope),
        true,
      );
      assert.equal(manager.getActiveSessionName("ctx"), "Deploy Debug");
    },
  );

  assert.deepEqual(backends.get(topicTab)?.newSessions, [undefined]);
  assert.deepEqual(backends.get(topicTab)?.switchSessions, [
    "/sessions/resumed-topic.jsonl",
  ]);
  assert.deepEqual(backends.get(topicTab)?.sessionNames, [
    "Deploy Debug",
    "Deploy Debug",
    "Deploy Debug",
  ]);
  await manager.dispose();
});

test("Tab manager syncs persisted topic session names on demand", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-topic-sync-names-"));
  const statePath = join(tempDir, "tabs.json");
  const replies: string[] = [];
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 5,
      inactiveNotify: true,
      workerExtensions: [],
      topicBinding: {
        enabled: true,
        native: false,
        generalIsDefault: true,
        autoCreate: true,
        closeOnTopicClose: true,
        deleteTopicOnClose: false,
        trustedChatIds: [],
      },
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.handleTopicServiceMessage(
    {
      chat: { id: -10042 },
      message_id: 20,
      message_thread_id: 77,
      forum_topic_created: { name: "Deploy Debug" },
    },
    "ctx",
  );
  const topicTab = normalizeTelegramTopicTabName(-10042, 77);
  await runWithTelegramThreadContext(
    { chatId: -10042, messageThreadId: 77 },
    async () => {
      await manager.setActiveSessionName("manual", "ctx");
      assert.equal(manager.getActiveSessionName("ctx"), "manual");
    },
  );

  assert.deepEqual(backends.get(topicTab)?.sessionNames, [
    "Deploy Debug",
    "manual",
  ]);
  await manager.handleCommand("sync-names", 1, 30, "ctx");
  assert.equal(replies.at(-1), "Synced 1 topic session name.");
  assert.deepEqual(backends.get(topicTab)?.sessionNames, [
    "Deploy Debug",
    "manual",
    "Deploy Debug",
  ]);
  await runWithTelegramThreadContext(
    { chatId: -10042, messageThreadId: 77 },
    async () => {
      assert.equal(manager.getActiveSessionName("ctx"), "Deploy Debug");
    },
  );
  await manager.dispose();
});

test("Tab manager scopes active APIs to ambient forum topics", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-topic-active-api-"));
  const statePath = join(tempDir, "tabs.json");
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 5,
      inactiveNotify: true,
      workerExtensions: [],
      topicBinding: {
        enabled: true,
        native: false,
        generalIsDefault: true,
        autoCreate: true,
        closeOnTopicClose: true,
        deleteTopicOnClose: false,
        trustedChatIds: [],
      },
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async () => undefined,
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  assert.equal(manager.getActiveSessionReference("ctx")?.tabName, "A");

  const topicTab = normalizeTelegramTopicTabName(-10042, 77);
  await runWithTelegramThreadContext(
    { chatId: -10042, messageThreadId: 77 },
    async () => {
      assert.equal(manager.getActiveSessionReference("ctx")?.tabName, topicTab);
      assert.equal(await manager.setActiveSessionName("topic session", "ctx"), true);
      assert.equal(manager.getActiveSessionName("ctx"), "topic session");
      assert.equal(manager.getActiveSessionReference("ctx")?.tabName, topicTab);
      assert.equal(manager.getActiveResumeSessionScope("ctx")?.tabName, topicTab);
      assert.deepEqual(await manager.newActiveSession("ctx"), { cancelled: false });
    },
  );
  assert.equal(backends.get(topicTab)?.newSessions.length, 1);
  assert.equal(manager.getActiveSessionReference("ctx")?.tabName, "A");

  const saved = JSON.parse(await readFile(statePath, "utf8")) as {
    tabs: Record<string, { source?: unknown; sessionName?: string }>;
  };
  assert.deepEqual(saved.tabs[topicTab]?.source, {
    kind: "telegram-topic",
    chatId: -10042,
    messageThreadId: 77,
  });
  await manager.dispose();
});

test("Tab manager rejects unknown forum topics at max tab capacity", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-topic-max-"));
  const statePath = join(tempDir, "tabs.json");
  const replies: string[] = [];
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 1,
      inactiveNotify: true,
      workerExtensions: [],
      topicBinding: {
        enabled: true,
        native: false,
        generalIsDefault: true,
        autoCreate: true,
        closeOnTopicClose: true,
        deleteTopicOnClose: false,
        trustedChatIds: [],
      },
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  assert.equal(
    await manager.dispatchPrompt(
      {
        chatId: -10042,
        messageThreadId: 77,
        replyToMessageId: 21,
        content: [{ type: "text", text: "topic prompt" }],
      },
      "ctx",
    ),
    true,
  );
  assert.equal(
    replies.at(-1),
    "Maximum workspace count reached. Close another topic/workspace first.",
  );
  assert.equal(backends.size, 0);
  const saved = JSON.parse(await readFile(statePath, "utf8")) as {
    tabs: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(saved.tabs), ["default"]);
});

test("Tab manager reports worker API errors instead of replaying stale text", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-error-"));
  const textReplies: string[] = [];
  const markdownReplies: string[] = [];
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
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
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.dispatchPrompt(
    {
      chatId: 1,
      replyToMessageId: 20,
      content: [{ type: "text", text: "[telegram] first question" }],
    },
    "ctx",
  );
  backends.get("A")?.emit({ type: "agent_start" });
  backends.get("A")?.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
    ],
  });
  assert.deepEqual(markdownReplies, ["old answer"]);

  await manager.dispatchPrompt(
    {
      chatId: 1,
      replyToMessageId: 21,
      content: [{ type: "text", text: "[telegram] failing question" }],
    },
    "ctx",
  );
  backends.get("A")?.emit({ type: "agent_start" });
  backends.get("A")?.emit({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "503 auth_unavailable: no auth available",
      },
    ],
  });

  assert.deepEqual(markdownReplies, ["old answer"]);
  assert.equal(
    textReplies.at(-1),
    "Tab A failed: 503 auth_unavailable: no auth available",
  );
});

test("Tab manager evicts idle workers when live worker capacity is full", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-worker-capacity-"));
  const replies: string[] = [];
  const disposed: string[] = [];
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 4,
      maxWorkers: 1,
      inactiveNotify: true,
      workerExtensions: [],
      topicBinding: {
        enabled: true,
        native: true,
        generalIsDefault: true,
        autoCreate: true,
        closeOnTopicClose: true,
        deleteTopicOnClose: false,
        trustedChatIds: [],
      },
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "tabs.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      const originalDispose = backend.dispose.bind(backend);
      backend.dispose = async () => {
        disposed.push(options.tabName);
        await originalDispose();
      };
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  for (const [messageThreadId, name] of [[77, "A"], [78, "B"]] as const) {
    assert.equal(
      await manager.handleTopicServiceMessage(
        {
          chat: { id: -10042 },
          message_thread_id: messageThreadId,
          forum_topic_created: { name },
        },
        "ctx",
      ),
      true,
    );
  }
  const saved = JSON.parse(await readFile(join(tempDir, "tabs.json"), "utf8")) as {
    tabs: Record<string, unknown>;
  };
  assert.equal(Object.keys(saved.tabs).length, 3);

  assert.equal(
    await manager.dispatchPrompt(
      {
        chatId: -10042,
        messageThreadId: 77,
        replyToMessageId: 21,
        content: [{ type: "text", text: "first topic" }],
      },
      "ctx",
    ),
    true,
  );
  assert.match(replies.at(-1) ?? "", /Started tab/);
  assert.equal(backends.size, 1);
  const firstBackend = [...backends.values()][0];
  assert.ok(firstBackend);
  firstBackend.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    ],
  });
  firstBackend.setState({ isStreaming: false });

  assert.equal(
    await manager.dispatchPrompt(
      {
        chatId: -10042,
        messageThreadId: 78,
        replyToMessageId: 22,
        content: [{ type: "text", text: "second topic" }],
      },
      "ctx",
    ),
    true,
  );
  assert.match(replies.at(-1) ?? "", /Started tab/);
  assert.equal(backends.size, 2);
  assert.equal(disposed.length, 1);
  assert.equal(firstBackend.disposed, true);
  await manager.dispose();
});

test("Tab manager preserves running workers when live worker capacity is full", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-worker-capacity-running-"));
  const replies: string[] = [];
  const disposed: string[] = [];
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 4,
      maxWorkers: 1,
      inactiveNotify: true,
      workerExtensions: [],
      topicBinding: {
        enabled: true,
        native: true,
        generalIsDefault: true,
        autoCreate: true,
        closeOnTopicClose: true,
        deleteTopicOnClose: false,
        trustedChatIds: [],
      },
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "tabs.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      const originalDispose = backend.dispose.bind(backend);
      backend.dispose = async () => {
        disposed.push(options.tabName);
        await originalDispose();
      };
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  for (const [messageThreadId, name] of [[77, "A"], [78, "B"]] as const) {
    assert.equal(
      await manager.handleTopicServiceMessage(
        {
          chat: { id: -10042 },
          message_thread_id: messageThreadId,
          forum_topic_created: { name },
        },
        "ctx",
      ),
      true,
    );
  }
  assert.equal(
    await manager.dispatchPrompt(
      {
        chatId: -10042,
        messageThreadId: 77,
        replyToMessageId: 21,
        content: [{ type: "text", text: "first topic" }],
      },
      "ctx",
    ),
    true,
  );
  assert.equal(
    await manager.dispatchPrompt(
      {
        chatId: -10042,
        messageThreadId: 78,
        replyToMessageId: 22,
        content: [{ type: "text", text: "second topic" }],
      },
      "ctx",
    ),
    true,
  );
  assert.match(
    replies.at(-1) ?? "",
    /^Tab .* failed: Worker capacity reached \(1\)\. Wait for another workspace to finish or restart it later\.$/,
  );
  assert.equal(backends.size, 1);
  assert.equal(disposed.length, 0);
  await manager.dispose();
});

test("Tab manager rebinds worker when resume RPC reports stale session state", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-resume-rebind-"));
  const replies: string[] = [];
  const backends: FakeTabBackend[] = [];
  const backendOptions: unknown[] = [];
  const events: string[] = [];
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 10,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "tabs.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      backendOptions.push(options);
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.push(backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
    recordRuntimeEvent: (_category, error, details) => {
      events.push(`${details?.action ?? ""}:${error instanceof Error ? error.message : String(error)}`);
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  const firstBackend = backends[0]!;
  firstBackend.keepStateOnSwitch = true;
  const scope = manager.getActiveResumeSessionScope("ctx");

  assert.equal(
    await manager.switchSession("/sessions/resumed-A.jsonl", "ctx", scope),
    true,
  );

  assert.equal(firstBackend.disposed, true);
  assert.equal(backends.length, 2);
  assert.deepEqual(firstBackend.switchSessions, ["/sessions/resumed-A.jsonl"]);
  assert.equal(
    (backendOptions[1] as { sessionFile?: string }).sessionFile,
    "/sessions/resumed-A.jsonl",
  );
  assert.equal(
    manager.getActiveSessionReference("ctx")?.sessionFile,
    "/sessions/resumed-A.jsonl",
  );
  assert.match(events.join("\n"), /switch_session_rebind:/);
});

test("Tab manager refreshes session name when resuming another session", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-resume-name-"));
  const replies: string[] = [];
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.setActiveSessionName("empty session", "ctx");
  assert.equal(manager.getActiveSessionName("ctx"), "empty session");

  const scope = manager.getActiveResumeSessionScope("ctx");
  assert.equal(
    await manager.switchSession("/sessions/resumed-unnamed.jsonl", "ctx", scope),
    true,
  );
  assert.equal(manager.getActiveSessionName("ctx"), undefined);
  assert.equal(
    manager.getActiveSessionReference("ctx")?.sessionName,
    undefined,
  );

  const backend = backends.get("A");
  assert.ok(backend);
  backend.nextSwitchSessionName = "named resumed session";
  assert.equal(
    await manager.switchSession("/sessions/resumed-named.jsonl", "ctx", scope),
    true,
  );
  assert.equal(manager.getActiveSessionName("ctx"), "named resumed session");
  assert.equal(
    manager.getActiveSessionReference("ctx")?.sessionName,
    "named resumed session",
  );
});

test("Tab-aware session name ports target the active tab", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-name-"));
  const replies: string[] = [];
  const parentSets: string[] = [];
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });
  const ports = createTelegramTabAwareSessionNamePorts({
    tabManager: manager,
    getParentSessionName: () => "parent",
    setParentSessionName: (name) => {
      parentSets.push(name);
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  assert.equal(ports.getSessionName("ctx"), undefined);
  await ports.setSessionName("hello", "ctx");
  assert.equal(ports.getSessionName("ctx"), "hello");
  assert.deepEqual(backends.get("A")?.sessionNames, ["hello"]);
  await ports.setSessionName("", "ctx");
  assert.equal(ports.getSessionName("ctx"), undefined);
  assert.deepEqual(backends.get("A")?.sessionNames, ["hello", ""]);
  assert.deepEqual(parentSets, []);
});

test("Tab manager replays only unread tab completions after switch", async () => {
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
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
  assert.deepEqual(replays, []);

  await manager.dispatchPrompt(
    {
      chatId: 1,
      replyToMessageId: 31,
      content: [{ type: "text", text: "question A" }],
    },
    "ctx",
  );
  await manager.handleCommand("new C", 1, 32, "ctx");
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
  await waitForTabStreamFlush();

  await manager.handleCommand("A", 7, 40, "ctx");

  assert.match(replies.at(-1) ?? "", /Switched to tab A\. Replaying unread latest messages\./);
  assert.doesNotMatch(replies.at(-1) ?? "", /Last reply/);
  assert.deepEqual(replays, ["A:/sessions/A.jsonl:7:40"]);
});

test("Tab manager sends switched last reply through markdown delivery when available", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-switch-markdown-"));
  const textReplies: string[] = [];
  const markdownReplies: string[] = [];
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
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
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.dispatchPrompt(
    {
      chatId: 1,
      replyToMessageId: 11,
      content: [{ type: "text", text: "question A" }],
    },
    "ctx",
  );
  backends.get("A")?.emit({ type: "agent_start" });
  backends.get("A")?.emit({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "answer **A**\n\n```ts\nconst x = 1\n```" }],
      },
    ],
  });

  await manager.handleCommand("new B", 1, 20, "ctx");
  await manager.handleCommand("A", 7, 30, "ctx");

  assert.match(textReplies.join("\n"), /Created and switched to tab B/);
  assert.equal(
    markdownReplies.at(-1),
    "Switched to tab A.\n\nLast reply:\nanswer **A**\n\n```ts\nconst x = 1\n```",
  );
});

test("Tab manager closes the active tab with bare close command", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-active-close-"));
  const replies: string[] = [];
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 10,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "tabs.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => new FakeTabBackend(options.tabName, options.sessionFile),
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.handleCommand("new B", 1, 11, "ctx");
  await manager.handleCommand("close", 1, 12, "ctx");
  assert.match(replies.at(-1) ?? "", /Closed tab B/);

  await manager.handleCommand("status B", 1, 13, "ctx");
  assert.match(replies.at(-1) ?? "", /Unknown tab: B/);
});

test("Tab manager blocks manual tab lifecycle commands in forum-native mode", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-native-lifecycle-"));
  const statePath = join(tempDir, "tabs.json");
  const replies: string[] = [];
  const config: TelegramNormalizedConcurrentTabsConfig = {
    enabled: true,
    maxTabs: 10,
    inactiveNotify: true,
    workerExtensions: [],
    topicBinding: {
      enabled: true,
      native: false,
      generalIsDefault: true,
      autoCreate: true,
      closeOnTopicClose: true,
      deleteTopicOnClose: false,
      trustedChatIds: [],
    },
  };
  const manager = createTelegramTabManager<string>({
    getConfig: () => config,
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => new FakeTabBackend(options.tabName, options.sessionFile),
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.handleCommand("new B", 1, 11, "ctx");
  assert.equal(manager.getActiveSessionReference("ctx")?.tabName, "B");
  config.topicBinding!.native = true;
  replies.length = 0;

  await manager.handleCommand("new C", 1, 12, "ctx");
  assert.match(replies.at(-1) ?? "", /Forum-native mode is enabled/);
  let saved = JSON.parse(await readFile(statePath, "utf8")) as {
    activeTab: string;
    tabs: Record<string, unknown>;
  };
  assert.equal(saved.tabs.C, undefined);
  assert.equal(saved.activeTab, "B");

  await manager.handleCommand("switch A", 1, 13, "ctx");
  assert.match(replies.at(-1) ?? "", /Forum-native mode is enabled/);
  saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(saved.activeTab, "B");

  await manager.handleCommand("A", 1, 14, "ctx");
  assert.match(replies.at(-1) ?? "", /Tabs \(2\/3\):/);
  assert.doesNotMatch(replies.at(-1) ?? "", /Switched to tab A/);
  saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(saved.activeTab, "B");

  await manager.handleCommand("close B --force", 1, 15, "ctx");
  assert.match(replies.at(-1) ?? "", /Forum-native mode is enabled/);
  saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.ok(saved.tabs.B);

  await manager.handleCommand("rename B Beta", 1, 16, "ctx");
  assert.match(replies.at(-1) ?? "", /Forum-native mode is enabled/);
  saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.ok(saved.tabs.B);
  assert.equal(saved.tabs.Beta, undefined);

  await manager.handleCommand("status B", 1, 17, "ctx");
  assert.match(replies.at(-1) ?? "", /Tab: B/);
  await manager.dispose();
});

test("Tab manager keeps the dashboard read-only in forum-native mode", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-native-dashboard-"));
  const statePath = join(tempDir, "tabs.json");
  const textReplies: string[] = [];
  const dashboardTexts: string[] = [];
  const dashboardMarkups: string[] = [];
  const interactiveEdits: string[] = [];
  const answers: string[] = [];
  const config: TelegramNormalizedConcurrentTabsConfig = {
    enabled: true,
    maxTabs: 10,
    inactiveNotify: true,
    workerExtensions: [],
    topicBinding: {
      enabled: true,
      native: false,
      generalIsDefault: true,
      autoCreate: true,
      closeOnTopicClose: true,
      deleteTopicOnClose: false,
      trustedChatIds: [],
    },
  };
  const manager = createTelegramTabManager<string>({
    getConfig: () => config,
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => new FakeTabBackend(options.tabName, options.sessionFile),
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      textReplies.push(text);
      return textReplies.length;
    },
    sendInteractiveMessage: async (_chatId, text, _mode, markup) => {
      dashboardTexts.push(text);
      dashboardMarkups.push(JSON.stringify(markup));
      return 77;
    },
    editInteractiveMessage: async (_chatId, _messageId, text, mode, markup) => {
      dashboardTexts.push(text);
      dashboardMarkups.push(JSON.stringify(markup));
      interactiveEdits.push(`${mode}:${text.split("\n")[0]}`);
    },
    answerCallbackQuery: async (_id, text) => {
      answers.push(text ?? "");
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.handleCommand("new B", 1, 11, "ctx");
  assert.equal(manager.getActiveSessionReference("ctx")?.tabName, "B");
  config.topicBinding!.native = true;

  await manager.handleCommand("", 1, 12, "ctx");
  assert.match(dashboardTexts.at(-1) ?? "", /^Forum topics 3\/10/);
  assert.match(dashboardTexts.at(-1) ?? "", /\nWorkers: 2\/10 hot\n/);
  assert.doesNotMatch(dashboardMarkups.at(-1) ?? "", /tab:switch:/);
  assert.doesNotMatch(dashboardMarkups.at(-1) ?? "", /tab:close/);
  assert.doesNotMatch(dashboardMarkups.at(-1) ?? "", /Manage 🗑/);
  assert.doesNotMatch(dashboardMarkups.at(-1) ?? "", /Close/);

  await manager.handleCallbackQuery(
    {
      id: "cb-switch-native",
      data: "tab:switch:A",
      message: { chat: { id: 7 }, message_id: 77 },
    },
    "ctx",
  );
  assert.match(answers.at(-1) ?? "", /Forum-native mode is enabled/);
  let saved = JSON.parse(await readFile(statePath, "utf8")) as {
    activeTab: string;
    tabs: Record<string, unknown>;
  };
  assert.equal(saved.activeTab, "B");
  assert.match(interactiveEdits.at(-1) ?? "", /^plain:Forum topics 3\/10/);
  assert.match(dashboardTexts.at(-1) ?? "", /\nWorkers: 2\/10 hot\n/);

  await manager.handleCallbackQuery(
    {
      id: "cb-close-native",
      data: "tab:close:do:B",
      message: { chat: { id: 7 }, message_id: 77 },
    },
    "ctx",
  );
  assert.match(answers.at(-1) ?? "", /Forum-native mode is enabled/);
  saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.ok(saved.tabs.B);

  await manager.handleCallbackQuery(
    {
      id: "cb-close-manage-native",
      data: "tab:close-manage",
      message: { chat: { id: 7 }, message_id: 77 },
    },
    "ctx",
  );
  assert.match(answers.at(-1) ?? "", /Forum-native mode is enabled/);
  assert.match(interactiveEdits.at(-1) ?? "", /^plain:Forum topics 3\/10/);
  await manager.dispose();
});

test("Tab manager opens interactive dashboard and handles tab callbacks", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-dashboard-"));
  const textReplies: string[] = [];
  const interactiveSends: string[] = [];
  const interactiveEdits: string[] = [];
  const dashboardTexts: string[] = [];
  const dashboardMarkups: string[] = [];
  const answers: string[] = [];
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      textReplies.push(text);
      return textReplies.length;
    },
    sendInteractiveMessage: async (_chatId, text, mode, markup) => {
      dashboardTexts.push(text);
      dashboardMarkups.push(
        markup.inline_keyboard
          .map((row) => row.map((button) => button.text).join("|"))
          .join("\n"),
      );
      interactiveSends.push(
        `${mode}:${text.split("\n")[0]}:${markup.inline_keyboard[0]?.map((button) => button.text).join("|")}`,
      );
      return 77;
    },
    editInteractiveMessage: async (_chatId, _messageId, text, mode, markup) => {
      dashboardTexts.push(text);
      interactiveEdits.push(
        `${mode}:${text.split("\n")[0]}:${markup.inline_keyboard[0]?.map((button) => button.text).join("|")}`,
      );
    },
    answerCallbackQuery: async (_id, text) => {
      answers.push(text ?? "");
    },
    sendLastTurnsOnSwitch: async (reference, chatId, replyToMessageId) => {
      replays.push(`${reference.tabName}:${chatId}:${replyToMessageId}`);
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.handleCommand("new B", 1, 11, "ctx");
  await manager.handleCommand("", 1, 12, "ctx");

  assert.deepEqual(interactiveSends, ["plain:Tabs 3/10:General|A"]);
  assert.match(dashboardTexts.at(-1) ?? "", /\nWorkers: 2\/10 hot\n/);
  assert.match(dashboardTexts.at(-1) ?? "", /○ General · idle · \d+s · 0msg · unset/);
  assert.match(dashboardTexts.at(-1) ?? "", /\n  ↳ No messages yet\./);
  assert.doesNotMatch(dashboardTexts.at(-1) ?? "", /opencode\//);
  assert.doesNotMatch(dashboardMarkups.at(-1) ?? "", /\bRefresh\b/);
  assert.doesNotMatch(dashboardMarkups.at(-1) ?? "", /\bLast 5\b/);
  assert.doesNotMatch(dashboardMarkups.at(-1) ?? "", /\bStatus\b/);
  assert.doesNotMatch(dashboardMarkups.at(-1) ?? "", /\bNew\b/);
  assert.doesNotMatch(dashboardMarkups.at(-1) ?? "", /\bRename\b/);
  assert.match(dashboardMarkups.at(-1) ?? "", /Manage 🗑/);
  assert.doesNotMatch(dashboardMarkups.at(-1) ?? "", /\bAbort\b/);
  assert.match(dashboardMarkups.at(-1) ?? "", /\bClose\b/);

  await manager.handleCallbackQuery(
    {
      id: "cb-switch",
      data: "tab:switch:A",
      message: { chat: { id: 7 }, message_id: 77 },
    },
    "ctx",
  );

  assert.equal(answers.at(-1), "Switching to A.");
  assert.match(textReplies.at(-1) ?? "", /Switched to tab A/);
  assert.deepEqual(replays, []);
  assert.match(interactiveEdits.at(-1) ?? "", /plain:Tabs 3\/10/);

  await manager.handleCallbackQuery(
    {
      id: "cb-last5",
      data: "tab:last5",
      message: { chat: { id: 7 }, message_id: 77 },
    },
    "ctx",
  );
  assert.equal(answers.at(-1), "Replaying latest turn.");
  assert.deepEqual(replays, ["A:7:77"]);

  await manager.handleCallbackQuery(
    {
      id: "cb-close",
      data: "tab:close:A",
      message: { chat: { id: 7 }, message_id: 77 },
    },
    "ctx",
  );
  assert.match(interactiveEdits.at(-1) ?? "", /Close tab A/);
  await manager.handleCallbackQuery(
    {
      id: "cb-close-do",
      data: "tab:close:do:A",
      message: { chat: { id: 7 }, message_id: 77 },
    },
    "ctx",
  );
  assert.equal(answers.at(-1), "Closing A.");
  assert.match(textReplies.at(-1) ?? "", /Closed tab A/);
});

test("Tab dashboard closes multiple selected tabs", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-multi-close-"));
  const statePath = join(tempDir, "tabs.json");
  const textReplies: string[] = [];
  const interactiveEdits: string[] = [];
  const editMarkups: string[] = [];
  const answers: string[] = [];
  const backends = new Map<string, FakeTabBackend>();
  const manager = createTelegramTabManager<string>({
    getConfig: () => ({
      enabled: true,
      maxTabs: 10,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      textReplies.push(text);
      return textReplies.length;
    },
    sendInteractiveMessage: async () => 88,
    editInteractiveMessage: async (_chatId, _messageId, text, mode, markup) => {
      interactiveEdits.push(`${mode}:${text}`);
      editMarkups.push(
        markup.inline_keyboard
          .flat()
          .map((button) => `${button.text}:${button.callback_data}`)
          .join("\n"),
      );
    },
    answerCallbackQuery: async (_id, text) => {
      answers.push(text ?? "");
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.handleCommand("new B", 1, 11, "ctx");
  await manager.handleCommand("new C", 1, 12, "ctx");
  await manager.handleCommand("", 1, 13, "ctx");

  await manager.handleCallbackQuery(
    {
      id: "manage",
      data: "tab:close-manage",
      message: { chat: { id: 7 }, message_id: 88 },
    },
    "ctx",
  );
  assert.match(interactiveEdits.at(-1) ?? "", /Close mode: select tabs to close/);
  assert.match(editMarkups.at(-1) ?? "", /☐ A:tab:close-toggle:A/);

  await manager.handleCallbackQuery(
    {
      id: "select-a",
      data: "tab:close-toggle:A",
      message: { chat: { id: 7 }, message_id: 88 },
    },
    "ctx",
  );
  assert.equal(answers.at(-1), "Selected.");
  await manager.handleCallbackQuery(
    {
      id: "select-b",
      data: "tab:close-toggle:B",
      message: { chat: { id: 7 }, message_id: 88 },
    },
    "ctx",
  );
  assert.match(interactiveEdits.at(-1) ?? "", /Selected: 2/);

  await manager.handleCallbackQuery(
    {
      id: "close-selected",
      data: "tab:close-selected",
      message: { chat: { id: 7 }, message_id: 88 },
    },
    "ctx",
  );
  assert.match(interactiveEdits.at(-1) ?? "", /Close 2 selected tabs\?/);
  assert.match(editMarkups.at(-1) ?? "", /Close selected:tab:close-confirm/);

  await manager.handleCallbackQuery(
    {
      id: "confirm-close",
      data: "tab:close-confirm",
      message: { chat: { id: 7 }, message_id: 88 },
    },
    "ctx",
  );
  assert.equal(answers.at(-1), "2 tabs closed.");
  assert.match(interactiveEdits.at(-1) ?? "", /Tabs 2\/10/);

  const saved = JSON.parse(await readFile(statePath, "utf8")) as {
    activeTab: string;
    tabs: Record<string, unknown>;
  };
  assert.equal(saved.activeTab, "C");
  assert.deepEqual(Object.keys(saved.tabs).sort(), ["C", "default"]);
  assert.equal(backends.get("A")?.disposed, true);
  assert.equal(backends.get("B")?.disposed, true);
  assert.equal(backends.get("C")?.disposed, false);
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
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
  assert.match(replies.at(-1) ?? "", /Tab General already exists/);
  await manager.handleCommand("rename default Other", 1, 15, "ctx");
  assert.match(replies.at(-1) ?? "", /Cannot rename General/);
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
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
  assert.equal(typingActions[0], 7);

  await manager.handleCommand("new B", 1, 30, "ctx");
  const inactiveTypingCount = typingActions.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(typingActions.length, inactiveTypingCount);

  await manager.handleCommand("A", 1, 40, "ctx");
  assert.ok(typingActions.length > inactiveTypingCount);
  backends.get("A")?.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "done A" }] },
    ],
  });
  const stoppedTypingCount = typingActions.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(typingActions.length, stoppedTypingCount);
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
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

  const streamReplyCountBeforeTool = streamReplies.length;
  const streamEditCountBeforeTool = streamEdits.length;
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
  assert.equal(streamReplies.length, streamReplyCountBeforeTool);
  assert.equal(streamEdits.length, streamEditCountBeforeTool);

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
  assert.equal(streamReplies.length, streamReplyCountBeforeTool);
  assert.equal(streamEdits.length, streamEditCountBeforeTool);

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
  assert.equal(streamReplies.length, streamReplyCountBeforeTool + 1);
  assert.match(streamReplies.at(-1) ?? "", /🔧 `bash`/);
  assert.match(streamReplies.at(-1) ?? "", /"command": "pwd"/);
  assert.equal(streamEdits.length, streamEditCountBeforeTool);

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
  assert.equal(
    [...streamReplies, ...streamEdits].filter((reply) =>
      reply.includes("🔧 `bash`"),
    ).length,
    1,
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

test("Tab manager can compact tool previews into one status stream", async () => {
  const previousMode = process.env.PI_TELEGRAM_TOOL_PREVIEW_MODE;
  const previousToolPreviews = process.env.PI_TELEGRAM_TOOL_PREVIEWS;
  process.env.PI_TELEGRAM_TOOL_PREVIEW_MODE = "compact";
  process.env.PI_TELEGRAM_TOOL_PREVIEWS = "0";
  try {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-tool-compact-"));
    const streamReplies: string[] = [];
    const streamEdits: string[] = [];
    const markdownReplies: string[] = [];
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
      sessionDir: join(tempDir, "sessions"),
      createBackend: (options) => {
        const backend = new FakeTabBackend(options.tabName, options.sessionFile);
        backends.set(options.tabName, backend);
        return backend;
      },
      sendTextReply: async () => undefined,
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
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "sleep 8" },
    });
    await waitForTabStreamFlush();
    assert.equal(streamReplies.length, 1);
    assert.match(streamReplies[0] ?? "", /🔧 Tools/);
    assert.match(streamReplies[0] ?? "", /running `bash`/);
    assert.match(streamReplies[0] ?? "", /"command": "sleep 8"/);

    backend.emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "sleep 8" },
      result: { content: [], isError: false },
    });
    await waitForTabStreamFlush();
    assert.equal(streamReplies.length, 1);
    assert.match(streamEdits.at(-1) ?? "", /done `bash`/);

    backend.emit({
      type: "tool_execution_start",
      toolCallId: "tool-2",
      toolName: "read",
      args: { path: "/tmp/a.txt" },
    });
    await waitForTabStreamFlush();
    assert.equal(streamReplies.length, 1);
    assert.match(streamEdits.at(-1) ?? "", /running `read`/);
    assert.match(streamEdits.at(-1) ?? "", /"path": "\/tmp\/a.txt"/);
    assert.equal(markdownReplies.length, 0);
    await manager.dispose();
  } finally {
    if (previousMode === undefined) delete process.env.PI_TELEGRAM_TOOL_PREVIEW_MODE;
    else process.env.PI_TELEGRAM_TOOL_PREVIEW_MODE = previousMode;
    if (previousToolPreviews === undefined) delete process.env.PI_TELEGRAM_TOOL_PREVIEWS;
    else process.env.PI_TELEGRAM_TOOL_PREVIEWS = previousToolPreviews;
  }
});

test("Tab manager confirms final stream delivery without fallback", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-final-stream-ok-"));
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async () => undefined,
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
      content: [{ type: "text", text: "question" }],
    },
    "ctx",
  );

  const backend = backends.get("A");
  assert.ok(backend);
  backend.emit({ type: "agent_start" });
  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "partial" },
  });
  await waitForTabStreamFlush();
  backend.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "partial plus final" }] },
    ],
  });
  await waitForTabStreamFlush();

  assert.deepEqual(streamReplies, ["partial"]);
  assert.equal(streamEdits.at(-1), "101:partial plus final");
  assert.deepEqual(markdownReplies, []);
});

test("Tab manager treats unchanged final stream as delivered without fallback", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-final-stream-unchanged-"));
  const markdownReplies: string[] = [];
  const streamReplies: string[] = [];
  const streamEdits: string[] = [];
  const pendingFinalEdit = createDeferred<number | undefined>();
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async () => undefined,
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
      return pendingFinalEdit.promise;
    },
    streamEditThrottleMs: 0,
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.dispatchPrompt(
    {
      chatId: 1,
      replyToMessageId: 20,
      content: [{ type: "text", text: "question" }],
    },
    "ctx",
  );

  const backend = backends.get("A");
  assert.ok(backend);
  backend.emit({ type: "agent_start" });
  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "partial" },
  });
  await waitForTabStreamFlush();
  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: " plus final" },
  });
  await waitForTabStreamFlush();
  backend.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "partial plus final" }] },
    ],
  });
  pendingFinalEdit.resolve(101);
  await waitForTabStreamFlush();
  await waitForTabStreamFlush();

  assert.deepEqual(streamReplies, ["partial"]);
  assert.deepEqual(streamEdits, ["101:partial plus final"]);
  assert.deepEqual(markdownReplies, []);
});

test("Tab manager falls back to a full reply when final stream edit fails", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-final-stream-fail-"));
  const markdownReplies: string[] = [];
  const streamReplies: string[] = [];
  const streamEdits: string[] = [];
  const runtimeEvents: string[] = [];
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async () => undefined,
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
      throw new Error("Telegram edit failed");
    },
    recordRuntimeEvent: (category, error, details) => {
      runtimeEvents.push(
        `${category}:${details?.action ?? ""}:${error instanceof Error ? error.message : String(error)}`,
      );
    },
    streamEditThrottleMs: 0,
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.dispatchPrompt(
    {
      chatId: 1,
      replyToMessageId: 20,
      content: [{ type: "text", text: "question" }],
    },
    "ctx",
  );

  const backend = backends.get("A");
  assert.ok(backend);
  backend.emit({ type: "agent_start" });
  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "partial" },
  });
  await waitForTabStreamFlush();
  backend.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "complete final" }] },
    ],
  });
  await waitForTabStreamFlush();

  assert.deepEqual(streamReplies, ["partial"]);
  assert.deepEqual(streamEdits, ["101:complete final"]);
  assert.deepEqual(markdownReplies, ["complete final"]);
  assert.match(runtimeEvents.join("\n"), /tabs:stream_markdown:Telegram edit failed/);
});

test("Tab manager marks partial stream previews when a tab turn is aborted", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-stream-abort-"));
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async () => undefined,
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
      content: [{ type: "text", text: "question" }],
    },
    "ctx",
  );

  const backend = backends.get("A");
  assert.ok(backend);
  backend.emit({ type: "agent_start" });
  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "partial answer" },
  });
  await waitForTabStreamFlush();

  assert.deepEqual(await manager.abortActive("ctx"), {
    tabName: "A",
    aborted: true,
    message: "Aborted tab A.",
  });
  await waitForTabStreamFlush();

  assert.deepEqual(streamReplies, ["partial answer"]);
  assert.equal(streamEdits.at(-1), "101:partial answer\n\n[aborted]");
  assert.deepEqual(backends.get("A")?.aborts, ["A"]);
});

test("Tab manager keeps stale final stream failures from blocking the next turn", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-final-stream-stale-"));
  const markdownReplies: string[] = [];
  const streamReplies: string[] = [];
  const streamEdits: string[] = [];
  const pendingOldEdit = createDeferred<number | undefined>();
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async () => undefined,
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
      if (markdown === "A complete final") return pendingOldEdit.promise;
      return messageId;
    },
    streamEditThrottleMs: 0,
    streamFailureBaseRetryMs: 60_000,
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.dispatchPrompt(
    {
      chatId: 1,
      replyToMessageId: 20,
      content: [{ type: "text", text: "question A" }],
    },
    "ctx",
  );

  const backend = backends.get("A");
  assert.ok(backend);
  backend.emit({ type: "agent_start" });
  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "A partial" },
  });
  await waitForTabStreamFlush();
  backend.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "A complete final" }] },
    ],
  });
  await waitForTabStreamFlush();
  assert.deepEqual(streamEdits, ["101:A complete final"]);

  await manager.dispatchPrompt(
    {
      chatId: 1,
      replyToMessageId: 21,
      content: [{ type: "text", text: "question B" }],
    },
    "ctx",
  );
  backend.emit({ type: "agent_start" });
  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "B first" },
  });
  await waitForTabStreamFlush();
  assert.deepEqual(streamReplies, ["A partial", "B first"]);

  pendingOldEdit.reject(new Error("late old edit failed"));
  await waitForTabStreamFlush();
  assert.deepEqual(markdownReplies, ["A complete final"]);

  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: " plus more" },
  });
  await waitForTabStreamFlush();
  assert.equal(streamEdits.at(-1), "102:B first plus more");
});

test("Tab manager throttles stream delivery across text and thinking streams", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-stream-throttle-"));
  const streamReplies: string[] = [];
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async () => undefined,
    sendMarkdownReply: async () => undefined,
    sendStreamMarkdownReply: async (_chatId, _replyToMessageId, markdown) => {
      streamReplies.push(markdown);
      return 100 + streamReplies.length;
    },
    editStreamMarkdownMessage: async (_chatId, _messageId, markdown) => {
      streamReplies.push(markdown);
      return undefined;
    },
    streamEditThrottleMs: 50,
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
      delta: "I should inspect",
    },
  });
  await waitForTabStreamFlush();
  assert.equal(streamReplies.length, 1);

  backend.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 1,
      delta: "I'll check",
    },
  });
  await waitForTabStreamFlush();
  assert.equal(streamReplies.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(streamReplies.length, 2);
  assert.match(streamReplies[1] ?? "", /I'll check/);
});

test("Tab manager does not reuse finalized thinking or tool streams", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tabs-stream-seal-"));
  const streamReplies: string[] = [];
  const streamEdits: string[] = [];
  const markdownReplies: string[] = [];
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
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeTabBackend(options.tabName, options.sessionFile);
      backends.set(options.tabName, backend);
      return backend;
    },
    sendTextReply: async () => undefined,
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
      delta: "first thought",
    },
  });
  await waitForTabStreamFlush();
  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
  });
  await waitForTabStreamFlush();
  backend.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "second thought",
    },
  });
  await waitForTabStreamFlush();

  assert.equal(streamReplies.length, 2);
  assert.match(streamReplies[0] ?? "", /first thought/);
  assert.match(streamReplies[1] ?? "", /second thought/);
  assert.equal(streamEdits.some((edit) => edit.includes("second thought")), false);

  backend.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 0,
      partial: {
        role: "assistant",
        content: [
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
  backend.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
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
      type: "toolcall_start",
      contentIndex: 0,
      partial: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-2",
            name: "bash",
            arguments: { command: "ls" },
            partialJson: '{ "command": "ls" }',
          },
        ],
      },
    },
  });
  await waitForTabStreamFlush();
  assert.equal(streamReplies.length, 3);
  backend.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: {
        type: "toolCall",
        id: "tool-2",
        name: "bash",
        arguments: { command: "ls" },
      },
    },
  });
  await waitForTabStreamFlush();

  assert.equal(streamReplies.length, 4);
  assert.match(streamReplies[2] ?? "", /"command": "pwd"/);
  assert.match(streamReplies[3] ?? "", /"command": "ls"/);
  assert.equal(
    streamEdits.some(
      (edit) => edit.startsWith("103:") && edit.includes('"command": "ls"'),
    ),
    false,
  );

  backend.emit({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-2",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
      },
    ],
  });
  await waitForTabStreamFlush();
  assert.equal(markdownReplies.length, 0);
});
