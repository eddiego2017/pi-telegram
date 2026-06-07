/**
 * Regression tests for Telegram workspace manager orchestration
 * Covers disabled behavior, prompt dispatch, inactive completion notices, and switching back to buffered output
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTelegramWorkspaceAwareSessionDeletePorts,
  createTelegramWorkspaceAwareTreeMenuPorts,
  createTelegramWorkspaceAwareResumeMenuPorts,
  createTelegramWorkspaceAwareSessionNamePorts,
  createTelegramWorkspaceAwareSessionSnapshotPorts,
  createTelegramWorkspaceManager,
  type TelegramWorkspaceBackend,
  type TelegramWorkspaceManager,
} from "../lib/workspace-manager.ts";
import type {
  RpcChildBackendEvent,
  RpcChildSessionState,
} from "../lib/rpc-child.ts";
import type { TelegramNormalizedConcurrentWorkspacesConfig } from "../lib/config.ts";
import { createTelegramTopicOrphanProofStore } from "../lib/topic-orphans.ts";
import {
  getAmbientTelegramThreadContext,
  runWithTelegramThreadContext,
} from "../lib/thread-context.ts";
import {
  normalizeTelegramTopicWorkspaceName,
  TELEGRAM_DEFAULT_WORKSPACE_NAME,
} from "../lib/workspaces.ts";

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

class FakeWorkspaceBackend implements TelegramWorkspaceBackend {
  readonly prompts: string[] = [];
  readonly followUps: string[] = [];
  readonly aborts: string[] = [];
  readonly compactions: string[] = [];
  readonly modelSelections: string[] = [];
  readonly thinkingSelections: string[] = [];
  readonly sessionNames: string[] = [];
  readonly newSessions: (string | undefined)[] = [];
  readonly switchSessions: string[] = [];
  abortError: unknown;
  keepStateOnSwitch = false;
  nextSwitchSessionName: string | undefined;
  disposed = false;
  disposeDeferred: ReturnType<typeof createDeferred<void>> | undefined;
  readonly workspaceName: string;
  private listeners = new Set<(event: RpcChildBackendEvent) => void>();
  private state: RpcChildSessionState;

  constructor(workspaceName: string, sessionFile?: string) {
    this.workspaceName = workspaceName;
    this.state = {
      sessionFile: sessionFile ?? `/sessions/${workspaceName}.jsonl`,
      sessionId: `session-${workspaceName}`,
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
    this.aborts.push(this.workspaceName);
    if (this.abortError) throw this.abortError;
    this.state = { ...this.state, isStreaming: false };
  }

  compactDeferred: ReturnType<typeof createDeferred<void>> | undefined;
  compactError: unknown;

  async compact(): Promise<void> {
    this.compactions.push(this.workspaceName);
    this.state = { ...this.state, isStreaming: false, isCompacting: true };
    if (this.compactDeferred) await this.compactDeferred.promise;
    if (this.compactError) {
      this.state = { ...this.state, isCompacting: false };
      throw this.compactError;
    }
    this.state = {
      ...this.state,
      messageCount: (this.state.messageCount ?? 0) + 1,
      isCompacting: false,
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
      sessionFile: `/sessions/${this.workspaceName}-${version}.jsonl`,
      sessionId: `session-${this.workspaceName}-${version}`,
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
      sessionId: `resumed-${this.workspaceName}`,
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

function makeResumePortWorkspaceManager(
  overrides: Partial<TelegramWorkspaceManager<string>>,
): TelegramWorkspaceManager<string> {
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

function waitForWorkspaceStreamFlush(): Promise<void> {
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

test("Workspace-aware resume ports recompute active workspace scope before host fallback", async () => {
  const events: string[] = [];
  const ports = createTelegramWorkspaceAwareResumeMenuPorts<string>({
    workspaceManager: makeResumePortWorkspaceManager({
      getActiveResumeSessionScope: () => ({
        kind: "workspace",
        workspaceName: "A",
        cwd: "/repo",
        sessionDir: "/sessions/shared",
        currentSessionFile: "/sessions/current.jsonl",
      }),
      switchSession: async (sessionPath, ctx, scope) => {
        events.push(`workspace:${sessionPath}:${ctx}:${scope?.workspaceName ?? ""}`);
        return true;
      },
    }),
    injectParentResumeExec: async (sessionPath) => {
      events.push(`parent:${sessionPath}`);
    },
  });

  await ports.injectResumeExec("/sessions/old.jsonl", "ctx");

  assert.deepEqual(events, ["workspace:/sessions/old.jsonl:ctx:A"]);
});

test("Workspace-aware resume ports avoid host fallback when active workspace scope is missing", async () => {
  const events: string[] = [];
  const ports = createTelegramWorkspaceAwareResumeMenuPorts<string>({
    workspaceManager: makeResumePortWorkspaceManager({
      getActiveResumeSessionScope: () => undefined,
    }),
    injectParentResumeExec: async (sessionPath) => {
      events.push(`parent:${sessionPath}`);
    },
  });

  await assert.rejects(
    () => ports.injectResumeExec("/sessions/old.jsonl", "ctx"),
    /No active workspace session scope/,
  );
  assert.deepEqual(events, []);
});

test("Workspace-aware resume ports keep host fallback when workspaces are disabled", async () => {
  const events: string[] = [];
  const ports = createTelegramWorkspaceAwareResumeMenuPorts<string>({
    workspaceManager: makeResumePortWorkspaceManager({
      isEnabled: () => false,
      switchSession: async () => {
        events.push("unexpected-workspace");
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

test("Workspace-aware session snapshot ports allow persisted active-workspace deletion", () => {
  const ports = createTelegramWorkspaceAwareSessionSnapshotPorts({
    workspaceManager: makeResumePortWorkspaceManager({
      getActiveSessionReference: () => ({
        workspaceName: "A",
        cwd: "/repo",
        sessionFile: "/sessions/A.jsonl",
      }),
    }),
    getParentSnapshot: () => ({ sessionFile: "/sessions/parent.jsonl" }),
    getWorkspaceSnapshot: () => ({ sessionFile: "/sessions/A.jsonl" }),
  });

  assert.deepEqual(ports.getSnapshot("ctx"), { sessionFile: "/sessions/A.jsonl" });
  assert.equal(ports.canDeleteCurrent({ sessionFile: "/sessions/A.jsonl" }, "ctx"), true);
  assert.equal(ports.canDeleteCurrent({}, "ctx"), false);
  assert.equal(ports.isReadOnly({}, "ctx"), true);
});

test("Workspace-aware session delete ports route active workspaces before parent fallback", async () => {
  const events: string[] = [];
  const activePorts = createTelegramWorkspaceAwareSessionDeletePorts<string>({
    workspaceManager: makeResumePortWorkspaceManager({
      deleteActiveSession: async (path, ctx) => {
        events.push(`workspace:${path}:${ctx}`);
        return true;
      },
    }),
    injectParentDeleteCurrentSession: async (path) => {
      events.push(`parent:${path}`);
    },
  });
  await activePorts.injectDeleteCurrentSession("/sessions/A.jsonl", "ctx");

  const fallbackPorts = createTelegramWorkspaceAwareSessionDeletePorts<string>({
    workspaceManager: makeResumePortWorkspaceManager({
      deleteActiveSession: async () => undefined,
    }),
    injectParentDeleteCurrentSession: async (path) => {
      events.push(`parent:${path}`);
    },
  });
  await fallbackPorts.injectDeleteCurrentSession("/sessions/parent.jsonl", "ctx");

  assert.deepEqual(events, [
    "workspace:/sessions/A.jsonl:ctx",
    "parent:/sessions/parent.jsonl",
  ]);
});

test("Workspace-aware tree ports expose active-workspace branch without parent tree exec", async () => {
  const events: string[] = [];
  const snapshot = {};
  const ports = createTelegramWorkspaceAwareTreeMenuPorts<string>({
    workspaceManager: makeResumePortWorkspaceManager({
      getActiveSessionReference: () => ({
        workspaceName: "A",
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
    /Active workspace tree navigation/,
  );
  assert.deepEqual(events, ["branch:u1:ctx"]);
});

test("Workspace-aware tree ports fall back to parent tree exec without active workspace", async () => {
  const events: string[] = [];
  const snapshot = {};
  const ports = createTelegramWorkspaceAwareTreeMenuPorts<string>({
    workspaceManager: makeResumePortWorkspaceManager({
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

test("Workspace manager declines prompt dispatch when disabled", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-disabled-"));
  const replies: string[] = [];
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: false,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
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
  assert.match(replies[0] ?? "", /Concurrent workspaces are disabled/);
});

test("Workspace manager reads and writes the workspaces state file", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-state-"));
  const workspaceStatePath = join(tempDir, "telegram-workspaces.json");
  await writeFile(
    workspaceStatePath,
    JSON.stringify({
      version: 1,
      activeWorkspace: "A",
      workspaces: {
        general: {
          name: "general",
          cwd: "/repo",
          createdAt: 1000,
          lastUsedAt: 1000,
          status: "idle",
        },
        A: {
          name: "A",
          cwd: "/repo",
          createdAt: 1001,
          lastUsedAt: 1002,
          status: "running",
        },
      },
    }),
  );
  const replies: string[] = [];
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    agentDir: tempDir,
    sessionDir: join(tempDir, "sessions"),
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.handleCommand("status", 1, 2, "ctx");
  await manager.dispose();

  assert.match(replies.at(-1) ?? "", /A \* stopped/);
  assert.equal(existsSync(workspaceStatePath), true);
  const saved = JSON.parse(await readFile(workspaceStatePath, "utf8")) as {
    activeWorkspace?: string;
    workspaces?: Record<string, { status?: string }>;
  };
  assert.equal(saved.activeWorkspace, "A");
  assert.equal(saved.workspaces?.A?.status, "exited");
});

test("Workspace manager creates spaced workspace names and filters implicit workspace queries", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-spaced-filter-"));
  const replies: string[] = [];
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 5,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => new FakeWorkspaceBackend(options.workspaceName, options.sessionFile),
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.handleCommand("new eve online marketing", 1, 10, "ctx");
  assert.match(replies.at(-1) ?? "", /Created and switched to workspace eve online marketing/);
  assert.equal(manager.getActiveSessionReference("ctx")?.workspaceName, "eve online marketing");

  await manager.handleCommand("new eve mining", 1, 11, "ctx");
  await manager.handleCommand("eve online marketing", 1, 12, "ctx");
  assert.match(replies.at(-1) ?? "", /Switched to workspace eve online marketing/);

  await manager.handleCommand("eve on", 1, 13, "ctx");
  assert.match(replies.at(-1) ?? "", /Workspaces \(1\/3\):/);
  assert.match(replies.at(-1) ?? "", /Filters: eve 3→2, on 2→1/);
  assert.match(replies.at(-1) ?? "", /eve online marketing/);
  assert.doesNotMatch(replies.at(-1) ?? "", /eve mining/);
});

test("Workspace manager deletes the active workspace session after creating a replacement", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-delete-session-"));
  const statePath = join(tempDir, "workspaces.json");
  const replies: string[] = [];
  const deletedSessions: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
    workspaceName: "A",
    cwd: "/repo",
    sessionFile: "/sessions/A.jsonl",
    sessionId: "session-A",
    sessionName: undefined,
  });

  assert.equal(await manager.deleteActiveSession("/sessions/A.jsonl", "ctx"), true);

  assert.deepEqual(backends.get("A")?.newSessions, ["/sessions/A.jsonl"]);
  assert.deepEqual(deletedSessions, ["/sessions/A.jsonl"]);
  assert.deepEqual(manager.getActiveSessionReference("ctx"), {
    workspaceName: "A",
    cwd: "/repo",
    sessionFile: "/sessions/A-1.jsonl",
    sessionId: "session-A-1",
    sessionName: undefined,
  });
});

test("Workspace manager compacts the active workspace worker", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-compact-"));
  const replies: string[] = [];
  const events: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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

test("Workspace manager queues prompts during compaction and flushes them after", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-compact-queue-"));
  const replies: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  const backend = backends.get("A");
  assert.ok(backend);
  backend.compactDeferred = createDeferred<void>();

  const compactDone = new Promise<void>((resolve) => {
    manager.compactActive("ctx", {
      onComplete: () => resolve(),
      onError: () => resolve(),
    });
  });
  while (backend.compactions.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // While compaction is mid-flight, queue two prompts instead of rejecting.
  await manager.dispatchPrompt(
    { chatId: 1, replyToMessageId: 20, content: [{ type: "text", text: "first" }] },
    "ctx",
  );
  await manager.dispatchPrompt(
    { chatId: 1, replyToMessageId: 21, content: [{ type: "text", text: "second" }] },
    "ctx",
  );
  assert.deepEqual(backend.prompts, []);
  assert.deepEqual(backend.followUps, []);
  assert.ok(
    replies.some((r) => r.includes("compaction in progress") && r.includes("1 waiting")),
  );
  assert.ok(
    replies.some((r) => r.includes("compaction in progress") && r.includes("2 waiting")),
  );

  backend.compactDeferred.resolve();
  await compactDone;
  while (backend.prompts.length === 0 || backend.followUps.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // After compaction the queued prompts are delivered in order.
  assert.deepEqual(backend.prompts, ["first"]);
  assert.deepEqual(backend.followUps, ["second"]);
});

test("Workspace manager drops compaction queue on abort", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-compact-abort-"));
  const replies: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  const backend = backends.get("A");
  assert.ok(backend);
  backend.compactDeferred = createDeferred<void>();

  const compactDone = new Promise<void>((resolve) => {
    manager.compactActive("ctx", {
      onComplete: () => resolve(),
      onError: () => resolve(),
    });
  });
  while (backend.compactions.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await manager.dispatchPrompt(
    { chatId: 1, replyToMessageId: 20, content: [{ type: "text", text: "queued" }] },
    "ctx",
  );

  const abortResult = await manager.abortActive("ctx");
  assert.ok(abortResult?.aborted);
  assert.ok(replies.some((r) => r === "Aborted; this queued prompt was dropped."));

  backend.compactDeferred.resolve();
  await compactDone;
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The dropped prompt is never delivered.
  assert.deepEqual(backend.prompts, []);
  assert.deepEqual(backend.followUps, []);
});

test("Workspace manager routes prompts to active workers and notifies inactive completion", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-runtime-"));
  const statePath = join(tempDir, "workspaces.json");
  const sharedSessionDir = join(tempDir, "sessions");
  const replies: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  let currentTime = 1000;
  const config: TelegramNormalizedConcurrentWorkspacesConfig = {
    enabled: true,
    maxWorkspaces: 4,
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
  const branchCalls: Array<{ workspaceName: string; sessionFile?: string; entryId: string }> = [];
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => config,
    getCwd: () => "/repo",
    now: () => currentTime,
    statePath,
    sessionDir: sharedSessionDir,
    createBackend: (options) => {
      backendOptions.push(options);
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
    createTreeBranch: (reference, entryId) => {
      branchCalls.push({
        workspaceName: reference.workspaceName,
        sessionFile: reference.sessionFile,
        entryId,
      });
      return { cancelled: false, markerId: "cursor-1", text: `prompt ${entryId}` };
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  assert.match(replies.at(-1) ?? "", /Created and switched to workspace A/);
  assert.equal(
    (backendOptions[0] as { sessionDir?: string }).sessionDir,
    sharedSessionDir,
  );
  assert.equal(existsSync(join(sharedSessionDir, "A")), false);
  assert.deepEqual(manager.getActiveSessionReference("ctx"), {
    workspaceName: "A",
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
    workspaceName: "A",
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
  assert.equal(scope?.kind, "workspace");
  assert.equal(scope?.workspaceName, "A");
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
    workspaceName: "A",
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
    { workspaceName: "A", sessionFile: "/sessions/resumed-A.jsonl", entryId: "u1" },
  ]);
  assert.equal(backendBeforeBranch?.disposed, true);
  assert.deepEqual(manager.getActiveSessionReference("ctx"), {
    workspaceName: "A",
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
  assert.match(replies.at(-1) ?? "", /Started workspace A/);
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
  assert.match(replies.at(-1) ?? "", /Queued follow-up in workspace A/);

  await manager.handleCommand("new B", 1, 30, "ctx");
  assert.match(replies.at(-1) ?? "", /Created and switched to workspace B/);
  assert.deepEqual(manager.getActiveSessionReference("ctx"), {
    workspaceName: "B",
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
  assert.match(replies.at(-1) ?? "", /Workspace A finished/);
  assert.equal(replies.includes("answer A"), false);

  await manager.handleCommand("A", 1, 40, "ctx");
  assert.match(replies.at(-1) ?? "", /Switched to workspace A\.\n\nLast reply:\nanswer A/);
  assert.equal(manager.getActiveSessionReference("ctx")?.workspaceName, "A");

  await manager.handleCommand("abort A", 1, 50, "ctx");
  assert.deepEqual(backends.get("A")?.aborts, ["A"]);
});

test("Workspace manager routes forum topic prompts to topic-bound workspaces without switching active workspace", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-topic-routing-"));
  const statePath = join(tempDir, "workspaces.json");
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
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 5,
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
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
  assert.equal(manager.getActiveSessionReference("ctx")?.workspaceName, "A");

  await manager.dispatchPrompt(
    {
      chatId: -10042,
      replyToMessageId: 20,
      content: [{ type: "text", text: "general prompt" }],
    },
    "ctx",
  );
  assert.deepEqual(backends.get("general")?.prompts, ["general prompt"]);
  assert.match(textReplies.at(-1) ?? "", /Started workspace General/);
  assert.equal(manager.getActiveSessionReference("ctx")?.workspaceName, "A");

  const topicWorkspace = normalizeTelegramTopicWorkspaceName(-10042, 77);
  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 77,
      replyToMessageId: 21,
      content: [{ type: "text", text: "topic prompt" }],
    },
    "ctx",
  );
  assert.deepEqual(backends.get(topicWorkspace)?.prompts, ["topic prompt"]);
  assert.match(textReplies.at(-1) ?? "", new RegExp(`Started workspace ${topicWorkspace}`));
  assert.equal(manager.getActiveSessionReference("ctx")?.workspaceName, "A");
  assert.deepEqual(typingScopes.at(-1), {
    chatId: -10042,
    messageThreadId: 77,
  });

  const topicBackend = backends.get(topicWorkspace);
  assert.ok(topicBackend);
  topicBackend.emit({ type: "agent_start" });
  topicBackend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "topic answer" },
  });
  await waitForWorkspaceStreamFlush();
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
  await waitForWorkspaceStreamFlush();
  assert.equal(streamEdits.at(-1)?.chatId, -10042);
  assert.equal(streamEdits.at(-1)?.messageId, 101);
  assert.equal(streamEdits.at(-1)?.markdown, "topic answer final");
  assert.deepEqual(streamEdits.at(-1)?.scope, {
    chatId: -10042,
    messageThreadId: 77,
  });
  assert.equal(textReplies.some((reply) => reply.includes("finished")), false);

  const saved = JSON.parse(await readFile(statePath, "utf8")) as {
    activeWorkspace: string;
    workspaces: Record<string, { source?: unknown }>;
  };
  assert.equal(saved.activeWorkspace, "A");
  assert.deepEqual(saved.workspaces[topicWorkspace]?.source, {
    kind: "telegram-topic",
    chatId: -10042,
    messageThreadId: 77,
  });
  await manager.dispose();
});

test("Workspace manager handles forum topic service create, edit, and close events", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-topic-service-"));
  const statePath = join(tempDir, "workspaces.json");
  const disposed: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 5,
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
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      const originalDispose = backend.dispose.bind(backend);
      backend.dispose = async () => {
        disposed.push(options.workspaceName);
        await originalDispose();
      };
      backends.set(options.workspaceName, backend);
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
  const topicWorkspace = normalizeTelegramTopicWorkspaceName(-10042, 77);
  let saved: { workspaces: Record<string, { source?: { topicTitle?: string }; sessionName?: string } | undefined> } =
    JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(saved.workspaces[topicWorkspace]?.source?.topicTitle, "Deploy Debug");
  assert.equal(saved.workspaces[topicWorkspace]?.sessionName, "Deploy Debug");
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
  assert.equal(saved.workspaces[topicWorkspace]?.source?.topicTitle, "Deploy Debug 2");
  assert.equal(saved.workspaces[topicWorkspace]?.sessionName, "Deploy Debug 2");

  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 77,
      replyToMessageId: 22,
      content: [{ type: "text", text: "start worker" }],
    },
    "ctx",
  );
  assert.ok(backends.get(topicWorkspace));
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
  assert.equal(saved.workspaces[topicWorkspace], undefined);
  assert.deepEqual(disposed, [topicWorkspace]);
  await manager.dispose();
});

test("Workspace manager deletes Telegram forum topics after close when configured", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-topic-delete-on-close-"));
  const statePath = join(tempDir, "workspaces.json");
  const disposed: string[] = [];
  const deleteCalls: Array<{ chatId: number; messageThreadId: number }> = [];
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 5,
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
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      const originalDispose = backend.dispose.bind(backend);
      backend.dispose = async () => {
        disposed.push(options.workspaceName);
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
  const topicWorkspace = normalizeTelegramTopicWorkspaceName(-10042, 77);
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
    workspaces: Record<string, unknown>;
  };
  assert.equal(saved.workspaces[topicWorkspace], undefined);
  assert.deepEqual(disposed, [topicWorkspace]);
  assert.deepEqual(deleteCalls, [{ chatId: -10042, messageThreadId: 77 }]);
  await manager.dispose();
});

test("Workspace manager ignores forum topic service events from untrusted chats", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-topic-untrusted-"));
  const statePath = join(tempDir, "workspaces.json");
  const deleteCalls: Array<{ chatId: number; messageThreadId: number }> = [];
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 5,
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
    createBackend: (options) => new FakeWorkspaceBackend(options.workspaceName, options.sessionFile),
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
  const trustedTopicWorkspace = normalizeTelegramTopicWorkspaceName(-10042, 77);
  let saved = JSON.parse(await readFile(statePath, "utf8")) as {
    workspaces: Record<string, unknown>;
  };
  assert.ok(saved.workspaces[trustedTopicWorkspace]);

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
  assert.equal(saved.workspaces[normalizeTelegramTopicWorkspaceName(-10043, 77)], undefined);

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
  assert.ok(saved.workspaces[trustedTopicWorkspace]);
  assert.deepEqual(deleteCalls, []);
  await manager.dispose();
});

test("Workspace manager warns when delete-topic-on-close lacks Telegram rights", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-topic-delete-rights-"));
  const statePath = join(tempDir, "workspaces.json");
  const replies: Array<{ chatId: number; replyToMessageId: number | undefined; text: string }> = [];
  const runtimeEvents: Array<Record<string, unknown>> = [];
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 5,
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
    createBackend: (options) => new FakeWorkspaceBackend(options.workspaceName, options.sessionFile),
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
  const topicWorkspace = normalizeTelegramTopicWorkspaceName(-10042, 77);
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
    workspaces: Record<string, unknown>;
  };
  assert.equal(saved.workspaces[topicWorkspace], undefined);
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0], {
    chatId: -10042,
    replyToMessageId: undefined,
    text: "已關閉 pi workspace，但無法刪除 Telegram topic。請把 bot 設為 admin，並開啟 Manage Topics 權限。",
  });
  assert.equal(runtimeEvents[0]?.category, "workspaces");
  assert.deepEqual((runtimeEvents[0]?.details as Record<string, unknown>).action, "deleteForumTopic");
  await manager.dispose();
});

test("Workspace manager syncs forum topic titles into active session names", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-topic-title-session-"));
  const statePath = join(tempDir, "workspaces.json");
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 5,
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
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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

  const topicWorkspace = normalizeTelegramTopicWorkspaceName(-10042, 77);
  assert.deepEqual(backends.get(topicWorkspace)?.sessionNames, ["Deploy Debug"]);

  await manager.handleTopicServiceMessage(
    {
      chat: { id: -10042 },
      message_id: 22,
      message_thread_id: 77,
      forum_topic_edited: { name: "Prod Debug" },
    },
    "ctx",
  );

  assert.deepEqual(backends.get(topicWorkspace)?.sessionNames, [
    "Deploy Debug",
    "Prod Debug",
  ]);
  assert.equal(
    manager.getActiveSessionReference("ctx")?.workspaceName,
    TELEGRAM_DEFAULT_WORKSPACE_NAME,
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
    workspaces: Record<string, { source?: { topicTitle?: string }; sessionName?: string }>;
  };
  assert.equal(saved.workspaces[topicWorkspace]?.source?.topicTitle, "Prod Debug");
  assert.equal(saved.workspaces[topicWorkspace]?.sessionName, "Prod Debug");
  await manager.dispose();
});

test("Workspace manager blocks one session from being attached to multiple open topics", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-topic-session-owner-"));
  const statePath = join(tempDir, "workspaces.json");
  const sessionFile = join(tempDir, "shared.jsonl");
  await writeFile(sessionFile, "", "utf8");
  const symlinkPath = join(tempDir, "shared-link.jsonl");
  await symlink(sessionFile, symlinkPath);
  const replies: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 5,
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
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  const topicA = normalizeTelegramTopicWorkspaceName(-10042, 77);
  const topicB = normalizeTelegramTopicWorkspaceName(-10042, 88);
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
      assert.equal(scope?.workspaceName, topicA);
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
      assert.equal(scope?.workspaceName, topicB);
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

test("Workspace manager blocks conflicting topic prompts by live session state", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-topic-live-owner-"));
  const statePath = join(tempDir, "workspaces.json");
  const replies: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 5,
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
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  const topicA = normalizeTelegramTopicWorkspaceName(-10042, 77);
  const topicB = normalizeTelegramTopicWorkspaceName(-10042, 88);
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

test("Workspace manager ignores late worker output after a forum topic is closed", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-topic-close-late-"));
  const statePath = join(tempDir, "workspaces.json");
  const textReplies: string[] = [];
  const markdownReplies: string[] = [];
  const streamReplies: string[] = [];
  const typingScopes: Array<ReturnType<typeof getAmbientTelegramThreadContext>> = [];
  const disposed: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 5,
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
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      const originalDispose = backend.dispose.bind(backend);
      backend.dispose = async () => {
        disposed.push(options.workspaceName);
        await originalDispose();
      };
      backends.set(options.workspaceName, backend);
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
  const topicWorkspace = normalizeTelegramTopicWorkspaceName(-10042, 77);
  const backend = backends.get(topicWorkspace);
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
    await waitForWorkspaceStreamFlush();
  }
  assert.deepEqual(disposed, [topicWorkspace]);
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
  await waitForWorkspaceStreamFlush();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(streamReplies, []);
  assert.deepEqual(markdownReplies, []);
  assert.equal(textReplies.some((reply) => reply.includes("finished")), false);
  assert.equal(typingScopes.length, typingCountAfterClose);

  backend.disposeDeferred.resolve();
  await closePromise;
  const saved = JSON.parse(await readFile(statePath, "utf8")) as {
    workspaces: Record<string, unknown>;
  };
  assert.equal(saved.workspaces[topicWorkspace], undefined);
  await manager.dispose();
});

test("Workspace manager preserves session files when closing forum topics", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-topic-session-preserve-"));
  const statePath = join(tempDir, "workspaces.json");
  const sessionFile = join(tempDir, "topic-session.jsonl");
  await writeFile(sessionFile, "session data\n", "utf8");
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 5,
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
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
  const topicWorkspace = normalizeTelegramTopicWorkspaceName(-10042, 77);
  backends.get(topicWorkspace)?.setState({ isStreaming: false });
  await runWithTelegramThreadContext(
    { chatId: -10042, messageThreadId: 77 },
    async () => {
      const scope = manager.getActiveResumeSessionScope("ctx");
      assert.equal(scope?.workspaceName, topicWorkspace);
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

test("Workspace manager applies forum topic titles to new and resumed sessions", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-topic-title-new-resume-"));
  const statePath = join(tempDir, "workspaces.json");
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 5,
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
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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

  const topicWorkspace = normalizeTelegramTopicWorkspaceName(-10042, 77);
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

  assert.deepEqual(backends.get(topicWorkspace)?.newSessions, [undefined]);
  assert.deepEqual(backends.get(topicWorkspace)?.switchSessions, [
    "/sessions/resumed-topic.jsonl",
  ]);
  assert.deepEqual(backends.get(topicWorkspace)?.sessionNames, [
    "Deploy Debug",
    "Deploy Debug",
    "Deploy Debug",
  ]);
  await manager.dispose();
});

test("Workspace manager syncs persisted topic session names on demand", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-topic-sync-names-"));
  const statePath = join(tempDir, "workspaces.json");
  const replies: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 5,
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
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
  const topicWorkspace = normalizeTelegramTopicWorkspaceName(-10042, 77);
  await runWithTelegramThreadContext(
    { chatId: -10042, messageThreadId: 77 },
    async () => {
      await manager.setActiveSessionName("manual", "ctx");
      assert.equal(manager.getActiveSessionName("ctx"), "manual");
    },
  );

  assert.deepEqual(backends.get(topicWorkspace)?.sessionNames, [
    "Deploy Debug",
    "manual",
  ]);
  await manager.handleCommand("sync-names", 1, 30, "ctx");
  assert.equal(replies.at(-1), "Synced 1 topic session name.");
  assert.deepEqual(backends.get(topicWorkspace)?.sessionNames, [
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

test("Workspace manager scopes active APIs to ambient forum topics", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-topic-active-api-"));
  const statePath = join(tempDir, "workspaces.json");
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 5,
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
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
      return backend;
    },
    sendTextReply: async () => undefined,
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  assert.equal(manager.getActiveSessionReference("ctx")?.workspaceName, "A");

  const topicWorkspace = normalizeTelegramTopicWorkspaceName(-10042, 77);
  await runWithTelegramThreadContext(
    { chatId: -10042, messageThreadId: 77 },
    async () => {
      assert.equal(manager.getActiveSessionReference("ctx")?.workspaceName, topicWorkspace);
      assert.equal(await manager.setActiveSessionName("topic session", "ctx"), true);
      assert.equal(manager.getActiveSessionName("ctx"), "topic session");
      assert.equal(manager.getActiveSessionReference("ctx")?.workspaceName, topicWorkspace);
      assert.equal(manager.getActiveResumeSessionScope("ctx")?.workspaceName, topicWorkspace);
      assert.deepEqual(await manager.newActiveSession("ctx"), { cancelled: false });
    },
  );
  assert.equal(backends.get(topicWorkspace)?.newSessions.length, 1);
  assert.equal(manager.getActiveSessionReference("ctx")?.workspaceName, "A");

  const saved = JSON.parse(await readFile(statePath, "utf8")) as {
    workspaces: Record<string, { source?: unknown; sessionName?: string }>;
  };
  assert.deepEqual(saved.workspaces[topicWorkspace]?.source, {
    kind: "telegram-topic",
    chatId: -10042,
    messageThreadId: 77,
  });
  await manager.dispose();
});

test("Workspace manager rejects unknown forum topics at max workspace capacity", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-topic-max-"));
  const statePath = join(tempDir, "workspaces.json");
  const replies: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 1,
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
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
    workspaces: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(saved.workspaces), ["general"]);
});

test("Workspace manager reports worker API errors instead of replaying stale text", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-error-"));
  const textReplies: string[] = [];
  const markdownReplies: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
    "Workspace A failed: 503 auth_unavailable: no auth available",
  );
});

test("Workspace manager keeps sticky topic workers when another topic starts", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-sticky-topic-workers-"));
  const replies: string[] = [];
  const disposed: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
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
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      const originalDispose = backend.dispose.bind(backend);
      backend.dispose = async () => {
        disposed.push(options.workspaceName);
        await originalDispose();
      };
      backends.set(options.workspaceName, backend);
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
  const saved = JSON.parse(await readFile(join(tempDir, "workspaces.json"), "utf8")) as {
    workspaces: Record<string, unknown>;
  };
  assert.equal(Object.keys(saved.workspaces).length, 3);

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
  assert.equal(replies.at(-1), "Started run in current topic.");
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
  assert.equal(replies.at(-1), "Started run in current topic.");
  assert.equal(backends.size, 2);
  assert.equal(disposed.length, 0);
  assert.equal(firstBackend.disposed, false);
  await manager.dispose();
});

test("Workspace manager uses current-topic wording for native prompt replies", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-native-prompt-wording-"));
  const replies: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
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
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 77,
      replyToMessageId: 20,
      content: [{ type: "text", text: "   " }],
    },
    "ctx",
  );
  assert.equal(replies.at(-1), "Topic prompt is empty.");

  const topicWorkspace = normalizeTelegramTopicWorkspaceName(-10042, 77);
  await runWithTelegramThreadContext(
    { chatId: -10042, messageThreadId: 77 },
    async () => {
      assert.deepEqual(await manager.abortActive("ctx"), {
        workspaceName: topicWorkspace,
        aborted: false,
        message: "No active worker for current topic.",
      });
    },
  );

  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 77,
      replyToMessageId: 21,
      content: [{ type: "text", text: "first" }],
    },
    "ctx",
  );
  assert.equal(replies.at(-1), "Started run in current topic.");

  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 77,
      replyToMessageId: 22,
      content: [{ type: "text", text: "second" }],
    },
    "ctx",
  );
  assert.equal(replies.at(-1), "Queued follow-up in current topic.");

  const backend = backends.get(topicWorkspace);
  assert.ok(backend);
  assert.deepEqual(backend.prompts, ["first"]);
  assert.deepEqual(backend.followUps, ["second"]);
  backend.emit({ type: "agent_start" });
  backend.emit({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "native boom",
      },
    ],
  });
  assert.equal(replies.at(-1), "Current topic failed: native boom");
  await runWithTelegramThreadContext(
    { chatId: -10042, messageThreadId: 77 },
    async () => {
      assert.deepEqual(await manager.abortActive("ctx"), {
        workspaceName: topicWorkspace,
        aborted: true,
        message: "Aborted current topic.",
      });
      assert.deepEqual(backend.aborts, [topicWorkspace]);
      assert.deepEqual(await manager.abortActive("ctx"), {
        workspaceName: topicWorkspace,
        aborted: true,
        message: "Aborted current topic.",
      });
    },
  );
  await manager.dispose();
});

test("Workspace manager uses workspace wording for native inactive completion notices", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-native-inactive-notice-"));
  const replies: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const config: TelegramNormalizedConcurrentWorkspacesConfig = {
    enabled: true,
    maxWorkspaces: 4,
    inactiveNotify: true,
    workerExtensions: [],
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
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => config,
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.handleCommand("new A", 1, 30, "ctx");
  await manager.dispatchPrompt(
    {
      chatId: 1,
      replyToMessageId: 21,
      content: [{ type: "text", text: "workspace prompt" }],
    },
    "ctx",
  );
  await manager.handleCommand("new B", 1, 31, "ctx");
  config.topicBinding!.enabled = true;
  config.topicBinding!.native = true;

  const backend = backends.get("A");
  assert.ok(backend);
  backend.emit({ type: "agent_start" });
  backend.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "workspace answer" }] },
    ],
  });

  assert.equal(
    replies.at(-1),
    "Workspace finished. Open this workspace to view the latest reply.",
  );
  assert.doesNotMatch(replies.at(-1) ?? "", /tg-/);
  await manager.dispose();
});

test("Workspace manager uses current-topic wording for native worker lifecycle errors", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-native-worker-wording-"));
  const replies: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
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
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.dispatchPrompt(
    {
      chatId: -10042,
      messageThreadId: 77,
      replyToMessageId: 21,
      content: [{ type: "text", text: "first" }],
    },
    "ctx",
  );
  const topicWorkspace = normalizeTelegramTopicWorkspaceName(-10042, 77);
  const backend = backends.get(topicWorkspace);
  assert.ok(backend);
  backend.setState({ isStreaming: true });

  await runWithTelegramThreadContext(
    { chatId: -10042, messageThreadId: 77 },
    async () => {
      assert.throws(
        () => manager.compactActive("ctx", { onComplete: () => {}, onError: () => {} }),
        /Current topic is busy\. Wait for it to go idle or send \/stop first\./,
      );
      backend.setState({ isStreaming: false, isCompacting: true });
      await manager.dispatchPrompt(
        {
          chatId: -10042,
          messageThreadId: 77,
          replyToMessageId: 22,
          content: [{ type: "text", text: "second" }],
        },
        "ctx",
      );
      assert.equal(
        replies.at(-1),
        "Queued in current topic (compaction in progress, 1 waiting).",
      );
      assert.deepEqual(backend.followUps, []);
      await assert.rejects(
        () => manager.newActiveSession("ctx"),
        /Current topic is busy\. Wait for it to go idle or send \/stop first\./,
      );
      await assert.rejects(
        () => manager.deleteActiveSession("/sessions/topic.jsonl", "ctx"),
        /Current topic is busy\. Send \/stop first\./,
      );
      await assert.rejects(
        () => manager.createActiveTreeBranch("u1", "ctx"),
        /Current topic is busy\. Send \/abort first\./,
      );
    },
  );
  await manager.dispose();
});

test("Workspace manager may stop idle non-native workers when live worker capacity is full", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-worker-capacity-stop-"));
  const replies: string[] = [];
  const disposed: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      maxWorkers: 1,
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
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      const originalDispose = backend.dispose.bind(backend);
      backend.dispose = async () => {
        disposed.push(options.workspaceName);
        await originalDispose();
      };
      backends.set(options.workspaceName, backend);
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
  assert.equal(replies.at(-1), "Started workspace tg-o6dmkl-26.");
  assert.equal(backends.size, 2);
  assert.equal(disposed.length, 1);
  assert.equal(firstBackend.disposed, true);
  await manager.dispose();
});

test("Workspace manager rebinds worker when resume RPC reports stale session state", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-resume-rebind-"));
  const replies: string[] = [];
  const backends: FakeWorkspaceBackend[] = [];
  const backendOptions: unknown[] = [];
  const events: string[] = [];
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 10,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      backendOptions.push(options);
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
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

test("Workspace manager refreshes session name when resuming another session", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-resume-name-"));
  const replies: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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

test("Workspace-aware session name ports target the active workspace", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-name-"));
  const replies: string[] = [];
  const parentSets: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });
  const ports = createTelegramWorkspaceAwareSessionNamePorts({
    workspaceManager: manager,
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

test("Workspace manager replays only unread workspace completions after switch", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-switch-replay-"));
  const replies: string[] = [];
  const replays: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 10,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
    sendLastTurnsOnSwitch: async (reference, chatId, replyToMessageId) => {
      replays.push(
        `${reference.workspaceName}:${reference.sessionFile}:${chatId}:${replyToMessageId}`,
      );
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.handleCommand("new B", 1, 20, "ctx");
  await manager.handleCommand("A", 7, 30, "ctx");

  assert.match(replies.at(-1) ?? "", /Switched to workspace A/);
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
  await waitForWorkspaceStreamFlush();

  await manager.handleCommand("A", 7, 40, "ctx");

  assert.match(replies.at(-1) ?? "", /Switched to workspace A\. Replaying unread latest messages\./);
  assert.doesNotMatch(replies.at(-1) ?? "", /Last reply/);
  assert.deepEqual(replays, ["A:/sessions/A.jsonl:7:40"]);
});

test("Workspace manager sends switched last reply through markdown delivery when available", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-switch-markdown-"));
  const textReplies: string[] = [];
  const markdownReplies: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 10,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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

  assert.match(textReplies.join("\n"), /Created and switched to workspace B/);
  assert.equal(
    markdownReplies.at(-1),
    "Switched to workspace A.\n\nLast reply:\nanswer **A**\n\n```ts\nconst x = 1\n```",
  );
});

test("Workspace manager closes the active workspace with bare close command", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-active-close-"));
  const replies: string[] = [];
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 10,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => new FakeWorkspaceBackend(options.workspaceName, options.sessionFile),
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.handleCommand("new B", 1, 11, "ctx");
  await manager.handleCommand("close", 1, 12, "ctx");
  assert.match(replies.at(-1) ?? "", /Closed workspace B/);

  await manager.handleCommand("status B", 1, 13, "ctx");
  assert.match(replies.at(-1) ?? "", /Unknown workspace: B/);
});

test("Workspace manager blocks manual workspace lifecycle commands in forum-native mode", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-native-lifecycle-"));
  const statePath = join(tempDir, "workspaces.json");
  const replies: string[] = [];
  const config: TelegramNormalizedConcurrentWorkspacesConfig = {
    enabled: true,
    maxWorkspaces: 10,
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
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => config,
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => new FakeWorkspaceBackend(options.workspaceName, options.sessionFile),
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.handleCommand("new B", 1, 11, "ctx");
  assert.equal(manager.getActiveSessionReference("ctx")?.workspaceName, "B");
  config.topicBinding!.native = true;
  replies.length = 0;

  await manager.handleCommand("new C", 1, 12, "ctx");
  assert.match(replies.at(-1) ?? "", /Forum-native mode is enabled/);
  let saved = JSON.parse(await readFile(statePath, "utf8")) as {
    activeWorkspace: string;
    workspaces: Record<string, unknown>;
  };
  assert.equal(saved.workspaces.C, undefined);
  assert.equal(saved.activeWorkspace, "B");

  await manager.handleCommand("switch A", 1, 13, "ctx");
  assert.match(replies.at(-1) ?? "", /Forum-native mode is enabled/);
  saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(saved.activeWorkspace, "B");

  await manager.handleCommand("A", 1, 14, "ctx");
  assert.match(replies.at(-1) ?? "", /Workspaces \(2\/3\):/);
  assert.doesNotMatch(replies.at(-1) ?? "", /Switched to workspace A/);
  saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(saved.activeWorkspace, "B");

  await manager.handleCommand("close B --force", 1, 15, "ctx");
  assert.match(replies.at(-1) ?? "", /Forum-native mode is enabled/);
  saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.ok(saved.workspaces.B);

  await manager.handleCommand("rename B Beta", 1, 16, "ctx");
  assert.match(replies.at(-1) ?? "", /Forum-native mode is enabled/);
  saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.ok(saved.workspaces.B);
  assert.equal(saved.workspaces.Beta, undefined);

  await manager.handleCommand("status B", 1, 17, "ctx");
  assert.match(replies.at(-1) ?? "", /Workspace: B/);
  await manager.dispose();
});

test("Workspace manager cleans proven topic orphan records", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-topic-diagnostics-"));
  const statePath = join(tempDir, "workspaces.json");
  const replies: string[] = [];
  const topicOrphanProofStore = createTelegramTopicOrphanProofStore();
  topicOrphanProofStore.record({
    chatId: -10042,
    messageThreadId: 77,
    method: "sendMessage",
    message: "Bad Request: message thread not found",
    at: 1234,
  });
  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      activeWorkspace: TELEGRAM_DEFAULT_WORKSPACE_NAME,
      workspaces: {
        [TELEGRAM_DEFAULT_WORKSPACE_NAME]: {
          name: TELEGRAM_DEFAULT_WORKSPACE_NAME,
          cwd: "/repo",
          createdAt: 1000,
          lastUsedAt: 1000,
          status: "idle",
        },
        [normalizeTelegramTopicWorkspaceName(-10042, 77)]: {
          name: normalizeTelegramTopicWorkspaceName(-10042, 77),
          cwd: "/repo",
          createdAt: 1000,
          lastUsedAt: 1000,
          status: "error",
          lastError: "Bad Request: message thread not found",
          source: {
            kind: "telegram-topic",
            chatId: -10042,
            messageThreadId: 77,
            topicTitle: "Deleted Topic",
          },
        },
        [normalizeTelegramTopicWorkspaceName(-10042, 88)]: {
          name: normalizeTelegramTopicWorkspaceName(-10042, 88),
          cwd: "/repo",
          createdAt: 1000,
          lastUsedAt: 1000,
          status: "idle",
          source: {
            kind: "telegram-topic",
            chatId: -10042,
            messageThreadId: 88,
            topicTitle: "Cold Topic",
          },
        },
      },
    }),
  );
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 10,
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
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => new FakeWorkspaceBackend(options.workspaceName, options.sessionFile),
    topicOrphanProofStore,
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.handleTopicCommand?.("orphans", 1, 10, "ctx");
  assert.match(replies.at(-1) ?? "", /^Topic orphan diagnostics:/);
  assert.match(replies.at(-1) ?? "", /Proven orphans: 1/);
  assert.match(replies.at(-1) ?? "", /Deleted Topic/);
  assert.match(replies.at(-1) ?? "", /proof sendMessage/);
  assert.match(replies.at(-1) ?? "", /Errored topic records: 0/);
  assert.match(replies.at(-1) ?? "", /Suspected topic records without workers: 1/);
  assert.match(replies.at(-1) ?? "", /Cold Topic/);

  await manager.handleTopicCommand?.("cleanup", 1, 11, "ctx");
  assert.equal(
    replies.at(-1),
    "Cleaned 1 proven topic orphan. Session files are kept.",
  );
  const saved = JSON.parse(await readFile(statePath, "utf8")) as {
    workspaces: Record<string, unknown>;
  };
  assert.equal(saved.workspaces[normalizeTelegramTopicWorkspaceName(-10042, 77)], undefined);
  assert.ok(saved.workspaces[normalizeTelegramTopicWorkspaceName(-10042, 88)]);
  assert.deepEqual(topicOrphanProofStore.getProofs(), []);

  await manager.handleTopicCommand?.("cleanup", 1, 12, "ctx");
  assert.equal(replies.at(-1), "No proven topic orphans to clean.");

  await manager.handleTopicCommand?.("unknown", 1, 13, "ctx");
  assert.match(replies.at(-1) ?? "", /Usage:\n\/topic orphans\n\/topic cleanup/);
  await manager.dispose();
});

test("Workspace manager keeps the dashboard read-only in forum-native mode", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-native-dashboard-"));
  const statePath = join(tempDir, "workspaces.json");
  const textReplies: string[] = [];
  const dashboardTexts: string[] = [];
  const dashboardMarkups: string[] = [];
  const interactiveEdits: string[] = [];
  const answers: string[] = [];
  const config: TelegramNormalizedConcurrentWorkspacesConfig = {
    enabled: true,
    maxWorkspaces: 10,
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
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => config,
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => new FakeWorkspaceBackend(options.workspaceName, options.sessionFile),
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
  assert.equal(manager.getActiveSessionReference("ctx")?.workspaceName, "B");
  config.topicBinding!.native = true;

  await manager.handleCommand("", 1, 12, "ctx");
  assert.match(dashboardTexts.at(-1) ?? "", /^Forum topics 3\/10/);
  assert.match(dashboardTexts.at(-1) ?? "", /\nWorkers: 2\/10\n/);
  assert.match(dashboardTexts.at(-1) ?? "", /○ General · idle · worker not started · \d+s · 0msg · unset/);
  assert.match(dashboardTexts.at(-1) ?? "", /● B · idle · worker idle · \d+s · 0msg · unset/);
  assert.doesNotMatch(dashboardMarkups.at(-1) ?? "", /workspace:switch:/);
  assert.doesNotMatch(dashboardMarkups.at(-1) ?? "", /workspace:close/);
  assert.doesNotMatch(dashboardMarkups.at(-1) ?? "", /Manage 🗑/);
  assert.doesNotMatch(dashboardMarkups.at(-1) ?? "", /Close/);

  await manager.handleCallbackQuery(
    {
      id: "cb-switch-native",
      data: "workspace:switch:A",
      message: { chat: { id: 7 }, message_id: 77 },
    },
    "ctx",
  );
  assert.match(answers.at(-1) ?? "", /Forum-native mode is enabled/);
  let saved = JSON.parse(await readFile(statePath, "utf8")) as {
    activeWorkspace: string;
    workspaces: Record<string, unknown>;
  };
  assert.equal(saved.activeWorkspace, "B");
  assert.match(interactiveEdits.at(-1) ?? "", /^plain:Forum topics 3\/10/);
  assert.match(dashboardTexts.at(-1) ?? "", /\nWorkers: 2\/10\n/);
  assert.match(dashboardTexts.at(-1) ?? "", /○ General · idle · worker not started · \d+s · 0msg · unset/);

  await manager.handleCallbackQuery(
    {
      id: "cb-close-native",
      data: "workspace:close:do:B",
      message: { chat: { id: 7 }, message_id: 77 },
    },
    "ctx",
  );
  assert.match(answers.at(-1) ?? "", /Forum-native mode is enabled/);
  saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.ok(saved.workspaces.B);

  await manager.handleCallbackQuery(
    {
      id: "cb-close-manage-native",
      data: "workspace:close-manage",
      message: { chat: { id: 7 }, message_id: 77 },
    },
    "ctx",
  );
  assert.match(answers.at(-1) ?? "", /Forum-native mode is enabled/);
  assert.match(interactiveEdits.at(-1) ?? "", /^plain:Forum topics 3\/10/);
  await manager.dispose();
});

test("Workspace manager opens interactive dashboard and handles workspace callbacks", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-dashboard-"));
  const textReplies: string[] = [];
  const interactiveSends: string[] = [];
  const interactiveEdits: string[] = [];
  const dashboardTexts: string[] = [];
  const dashboardMarkups: string[] = [];
  const answers: string[] = [];
  const replays: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 10,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
      replays.push(`${reference.workspaceName}:${chatId}:${replyToMessageId}`);
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.handleCommand("new B", 1, 11, "ctx");
  await manager.handleCommand("", 1, 12, "ctx");

  assert.deepEqual(interactiveSends, ["plain:Workspaces 3/10:General|A"]);
  assert.match(dashboardTexts.at(-1) ?? "", /\nWorkers: 2\/10\n/);
  assert.match(dashboardTexts.at(-1) ?? "", /○ General · idle · worker not started · \d+s · 0msg · unset/);
  assert.match(dashboardTexts.at(-1) ?? "", /● B · idle · worker idle · \d+s · 0msg · unset/);
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
      data: "workspace:switch:A",
      message: { chat: { id: 7 }, message_id: 77 },
    },
    "ctx",
  );

  assert.equal(answers.at(-1), "Switching to A.");
  assert.match(textReplies.at(-1) ?? "", /Switched to workspace A/);
  assert.deepEqual(replays, []);
  assert.match(interactiveEdits.at(-1) ?? "", /plain:Workspaces 3\/10/);

  await manager.handleCallbackQuery(
    {
      id: "cb-last5",
      data: "workspace:last5",
      message: { chat: { id: 7 }, message_id: 77 },
    },
    "ctx",
  );
  assert.equal(answers.at(-1), "Replaying latest turn.");
  assert.deepEqual(replays, ["A:7:77"]);

  await manager.handleCallbackQuery(
    {
      id: "cb-close",
      data: "workspace:close:A",
      message: { chat: { id: 7 }, message_id: 77 },
    },
    "ctx",
  );
  assert.match(interactiveEdits.at(-1) ?? "", /Close workspace A/);
  await manager.handleCallbackQuery(
    {
      id: "cb-close-do",
      data: "workspace:close:do:A",
      message: { chat: { id: 7 }, message_id: 77 },
    },
    "ctx",
  );
  assert.equal(answers.at(-1), "Closing A.");
  assert.match(textReplies.at(-1) ?? "", /Closed workspace A/);
});

test("Workspace dashboard closes multiple selected workspaces", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-multi-close-"));
  const statePath = join(tempDir, "workspaces.json");
  const textReplies: string[] = [];
  const interactiveEdits: string[] = [];
  const editMarkups: string[] = [];
  const answers: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 10,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
      data: "workspace:close-manage",
      message: { chat: { id: 7 }, message_id: 88 },
    },
    "ctx",
  );
  assert.match(interactiveEdits.at(-1) ?? "", /Close mode: select workspaces to close/);
  assert.match(editMarkups.at(-1) ?? "", /☐ A:workspace:close-toggle:A/);

  await manager.handleCallbackQuery(
    {
      id: "select-a",
      data: "workspace:close-toggle:A",
      message: { chat: { id: 7 }, message_id: 88 },
    },
    "ctx",
  );
  assert.equal(answers.at(-1), "Selected.");
  await manager.handleCallbackQuery(
    {
      id: "select-b",
      data: "workspace:close-toggle:B",
      message: { chat: { id: 7 }, message_id: 88 },
    },
    "ctx",
  );
  assert.match(interactiveEdits.at(-1) ?? "", /Selected: 2/);

  await manager.handleCallbackQuery(
    {
      id: "close-selected",
      data: "workspace:close-selected",
      message: { chat: { id: 7 }, message_id: 88 },
    },
    "ctx",
  );
  assert.match(interactiveEdits.at(-1) ?? "", /Close 2 selected workspaces\?/);
  assert.match(editMarkups.at(-1) ?? "", /Close selected:workspace:close-confirm/);

  await manager.handleCallbackQuery(
    {
      id: "confirm-close",
      data: "workspace:close-confirm",
      message: { chat: { id: 7 }, message_id: 88 },
    },
    "ctx",
  );
  assert.equal(answers.at(-1), "2 workspaces closed.");
  assert.match(interactiveEdits.at(-1) ?? "", /Workspaces 2\/10/);

  const saved = JSON.parse(await readFile(statePath, "utf8")) as {
    activeWorkspace: string;
    workspaces: Record<string, unknown>;
  };
  assert.equal(saved.activeWorkspace, "C");
  assert.deepEqual(Object.keys(saved.workspaces).sort(), ["C", "general"]);
  assert.equal(backends.get("A")?.disposed, true);
  assert.equal(backends.get("B")?.disposed, true);
  assert.equal(backends.get("C")?.disposed, false);
});

test("Workspace manager renames workspaces without discarding session state", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-rename-"));
  const replies: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const statePath = join(tempDir, "workspaces.json");
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 10,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath,
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
      return backend;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return replies.length;
    },
  });

  await manager.handleCommand("new A", 1, 10, "ctx");
  await manager.handleCommand("rename A Alpha", 1, 11, "ctx");
  assert.match(replies.at(-1) ?? "", /Renamed workspace A to Alpha/);
  assert.deepEqual(manager.getActiveSessionReference("ctx"), {
    workspaceName: "Alpha",
    cwd: "/repo",
    sessionFile: "/sessions/A.jsonl",
    sessionId: "session-A",
    sessionName: undefined,
  });
  await manager.dispatchPrompt(
    {
      chatId: 1,
      replyToMessageId: 12,
      content: [{ type: "text", text: "hello renamed workspace" }],
    },
    "ctx",
  );
  assert.deepEqual(backends.get("A")?.prompts, ["hello renamed workspace"]);
  assert.match(replies.at(-1) ?? "", /Started workspace Alpha/);

  const saved = JSON.parse(await readFile(statePath, "utf8")) as {
    activeWorkspace: string;
    workspaces: Record<string, unknown>;
  };
  assert.equal(saved.activeWorkspace, "Alpha");
  assert.equal(saved.workspaces.A, undefined);
  assert.ok(saved.workspaces.Alpha);

  await manager.handleCommand("rename Alpha", 1, 13, "ctx");
  assert.match(replies.at(-1) ?? "", /already named Alpha/);
  await manager.handleCommand("rename Alpha general", 1, 14, "ctx");
  assert.match(replies.at(-1) ?? "", /Workspace General already exists/);
  await manager.handleCommand("rename general Other", 1, 15, "ctx");
  assert.match(replies.at(-1) ?? "", /Cannot rename General/);
});

test("Workspace manager sends typing actions for the active running workspace", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-typing-"));
  const replies: string[] = [];
  const typingActions: number[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 10,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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

test("Workspace manager relays active worker thinking and tool call output", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-rendering-"));
  const textReplies: string[] = [];
  const markdownReplies: string[] = [];
  const streamReplies: string[] = [];
  const streamEdits: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
  await waitForWorkspaceStreamFlush();
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
  await waitForWorkspaceStreamFlush();
  assert.match(streamEdits.at(-1) ?? "", /101:💡 Thinking/);
  assert.match(streamEdits.at(-1) ?? "", /I should inspect the repo\./);

  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
  });
  await waitForWorkspaceStreamFlush();
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
  await waitForWorkspaceStreamFlush();
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
  await waitForWorkspaceStreamFlush();
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
  await waitForWorkspaceStreamFlush();
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
  await waitForWorkspaceStreamFlush();
  assert.equal(streamReplies.at(-1), "I'll check");

  backend.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 2,
      delta: "the working directory",
    },
  });
  await waitForWorkspaceStreamFlush();
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
  await waitForWorkspaceStreamFlush();
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
  await waitForWorkspaceStreamFlush();
  assert.equal(
    markdownReplies.at(-1),
    ["💡 Thinking\n> I should inspect the repo.", "Done."].join("\n\n"),
  );
});

test("Workspace manager can compact tool previews into one status stream", async () => {
  const previousMode = process.env.PI_TELEGRAM_TOOL_PREVIEW_MODE;
  const previousToolPreviews = process.env.PI_TELEGRAM_TOOL_PREVIEWS;
  process.env.PI_TELEGRAM_TOOL_PREVIEW_MODE = "compact";
  process.env.PI_TELEGRAM_TOOL_PREVIEWS = "0";
  try {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-tool-compact-"));
    const streamReplies: string[] = [];
    const streamEdits: string[] = [];
    const markdownReplies: string[] = [];
    const backends = new Map<string, FakeWorkspaceBackend>();
    const manager = createTelegramWorkspaceManager<string>({
      getConfig: () => ({
        enabled: true,
        maxWorkspaces: 4,
        inactiveNotify: true,
        workerExtensions: [],
      }),
      getCwd: () => "/repo",
      statePath: join(tempDir, "workspaces.json"),
      sessionDir: join(tempDir, "sessions"),
      createBackend: (options) => {
        const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
        backends.set(options.workspaceName, backend);
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
    await waitForWorkspaceStreamFlush();
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
    await waitForWorkspaceStreamFlush();
    assert.equal(streamReplies.length, 1);
    assert.match(streamEdits.at(-1) ?? "", /done `bash`/);

    backend.emit({
      type: "tool_execution_start",
      toolCallId: "tool-2",
      toolName: "read",
      args: { path: "/tmp/a.txt" },
    });
    await waitForWorkspaceStreamFlush();
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

test("Workspace manager confirms final stream delivery without fallback", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-final-stream-ok-"));
  const markdownReplies: string[] = [];
  const streamReplies: string[] = [];
  const streamEdits: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
  await waitForWorkspaceStreamFlush();
  backend.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "partial plus final" }] },
    ],
  });
  await waitForWorkspaceStreamFlush();

  assert.deepEqual(streamReplies, ["partial"]);
  assert.equal(streamEdits.at(-1), "101:partial plus final");
  assert.deepEqual(markdownReplies, []);
});

test("Workspace manager treats unchanged final stream as delivered without fallback", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-final-stream-unchanged-"));
  const markdownReplies: string[] = [];
  const streamReplies: string[] = [];
  const streamEdits: string[] = [];
  const pendingFinalEdit = createDeferred<number | undefined>();
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
  await waitForWorkspaceStreamFlush();
  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: " plus final" },
  });
  await waitForWorkspaceStreamFlush();
  backend.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "partial plus final" }] },
    ],
  });
  pendingFinalEdit.resolve(101);
  await waitForWorkspaceStreamFlush();
  await waitForWorkspaceStreamFlush();

  assert.deepEqual(streamReplies, ["partial"]);
  assert.deepEqual(streamEdits, ["101:partial plus final"]);
  assert.deepEqual(markdownReplies, []);
});

test("Workspace manager falls back to a full reply when final stream edit fails", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-final-stream-fail-"));
  const markdownReplies: string[] = [];
  const streamReplies: string[] = [];
  const streamEdits: string[] = [];
  const deletedMessages: Array<{ chatId: number; messageId: number }> = [];
  const runtimeEvents: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
    deleteMessage: async (chatId, messageId) => {
      deletedMessages.push({ chatId, messageId });
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
  await waitForWorkspaceStreamFlush();
  backend.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "complete final" }] },
    ],
  });
  await waitForWorkspaceStreamFlush();

  assert.deepEqual(streamReplies, ["partial"]);
  assert.deepEqual(streamEdits, ["101:complete final"]);
  assert.deepEqual(markdownReplies, ["complete final"]);
  assert.deepEqual(deletedMessages, [{ chatId: 1, messageId: 101 }]);
  assert.match(runtimeEvents.join("\n"), /workspaces:stream_markdown:Telegram edit failed/);
});

test("Workspace manager deletes stale thinking preview when final fallback includes it", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-thinking-fallback-delete-"));
  const markdownReplies: string[] = [];
  const streamReplies: string[] = [];
  const streamEdits: string[] = [];
  const deletedMessages: Array<{ chatId: number; messageId: number }> = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
      if (markdown === "final answer") throw new Error("Telegram edit failed");
      return messageId;
    },
    deleteMessage: async (chatId, messageId) => {
      deletedMessages.push({ chatId, messageId });
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
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "complete thought",
    },
  });
  await waitForWorkspaceStreamFlush();
  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
  });
  await waitForWorkspaceStreamFlush();
  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "partial" },
  });
  await waitForWorkspaceStreamFlush();
  backend.emit({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "complete thought" },
          { type: "text", text: "final answer" },
        ],
      },
    ],
  });
  await waitForWorkspaceStreamFlush();

  assert.equal(streamReplies[0], "💡 Thinking\n> complete thought");
  assert.equal(streamReplies[1], "partial");
  assert.deepEqual(streamEdits, ["102:final answer"]);
  assert.deepEqual(
    markdownReplies,
    [["💡 Thinking\n> complete thought", "final answer"].join("\n\n")],
  );
  assert.deepEqual(deletedMessages, [
    { chatId: 1, messageId: 102 },
    { chatId: 1, messageId: 101 },
  ]);
  await manager.dispose();
});

test("Workspace manager marks partial stream previews when a workspace turn is aborted", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-stream-abort-"));
  const streamReplies: string[] = [];
  const streamEdits: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
  await waitForWorkspaceStreamFlush();

  assert.deepEqual(await manager.abortActive("ctx"), {
    workspaceName: "A",
    aborted: true,
    message: "Aborted workspace A.",
  });
  await waitForWorkspaceStreamFlush();

  assert.deepEqual(streamReplies, ["partial answer"]);
  assert.equal(streamEdits.at(-1), "101:partial answer\n\n[aborted]");
  assert.deepEqual(backends.get("A")?.aborts, ["A"]);
});

test("Workspace manager disposes unresponsive worker and clears busy state on abort failure", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-abort-unresponsive-"));
  const backends = new Map<string, FakeWorkspaceBackend>();
  const events: { area: string; action?: string; error: string }[] = [];
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
      return backend;
    },
    sendTextReply: async () => undefined,
    recordRuntimeEvent: (area, error, details) => {
      events.push({
        area,
        action: typeof details?.action === "string" ? details.action : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    },
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
  backend.abortError = new Error("abort timed out");

  assert.deepEqual(await manager.abortActive("ctx"), {
    workspaceName: "A",
    aborted: true,
    message: "Aborted workspace A after worker stopped responding.",
  });

  assert.deepEqual(backend.aborts, ["A"]);
  assert.equal(backend.disposed, true);
  assert.deepEqual(await manager.canSwitchActiveModel("ctx"), true);
  assert.equal(events.some((event) => event.area === "workspaces" && event.action === "abort" && event.error === "abort timed out"), true);
  await manager.dispose();
});

test("Workspace manager keeps stale final stream failures from blocking the next turn", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-final-stream-stale-"));
  const markdownReplies: string[] = [];
  const streamReplies: string[] = [];
  const streamEdits: string[] = [];
  const pendingOldEdit = createDeferred<number | undefined>();
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
  await waitForWorkspaceStreamFlush();
  backend.emit({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "A complete final" }] },
    ],
  });
  await waitForWorkspaceStreamFlush();
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
  await waitForWorkspaceStreamFlush();
  assert.deepEqual(streamReplies, ["A partial", "B first"]);

  pendingOldEdit.reject(new Error("late old edit failed"));
  await waitForWorkspaceStreamFlush();
  assert.deepEqual(markdownReplies, ["A complete final"]);

  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: " plus more" },
  });
  await waitForWorkspaceStreamFlush();
  assert.equal(streamEdits.at(-1), "102:B first plus more");
});

test("Workspace manager throttles stream delivery across text and thinking streams", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-stream-throttle-"));
  const streamReplies: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
  await waitForWorkspaceStreamFlush();
  assert.equal(streamReplies.length, 1);

  backend.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 1,
      delta: "I'll check",
    },
  });
  await waitForWorkspaceStreamFlush();
  assert.equal(streamReplies.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(streamReplies.length, 2);
  assert.match(streamReplies[1] ?? "", /I'll check/);
});

test("Workspace manager does not reuse finalized thinking or tool streams", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-workspaces-stream-seal-"));
  const streamReplies: string[] = [];
  const streamEdits: string[] = [];
  const markdownReplies: string[] = [];
  const backends = new Map<string, FakeWorkspaceBackend>();
  const manager = createTelegramWorkspaceManager<string>({
    getConfig: () => ({
      enabled: true,
      maxWorkspaces: 4,
      inactiveNotify: true,
      workerExtensions: [],
    }),
    getCwd: () => "/repo",
    statePath: join(tempDir, "workspaces.json"),
    sessionDir: join(tempDir, "sessions"),
    createBackend: (options) => {
      const backend = new FakeWorkspaceBackend(options.workspaceName, options.sessionFile);
      backends.set(options.workspaceName, backend);
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
  await waitForWorkspaceStreamFlush();
  backend.emit({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
  });
  await waitForWorkspaceStreamFlush();
  backend.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "second thought",
    },
  });
  await waitForWorkspaceStreamFlush();

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
  await waitForWorkspaceStreamFlush();
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
  await waitForWorkspaceStreamFlush();
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
  await waitForWorkspaceStreamFlush();
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
  await waitForWorkspaceStreamFlush();

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
  await waitForWorkspaceStreamFlush();
  assert.equal(markdownReplies.length, 1);
  assert.match(markdownReplies[0] ?? "", /"command": "ls"/);
});
