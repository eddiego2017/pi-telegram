/**
 * Regression tests for the pi SDK adapter boundary
 * Covers narrow bridge-facing helpers over concrete pi context contracts
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  compactExtensionContext,
  createEffectiveThinkingLevelSetter,
  createExtensionApiRuntimePorts,
  createTelegramSessionFileTreeBranchCursor,
  createScopedModelPatternPersister,
  deleteTelegramSessionFileBranch,
  deriveSessionContextUsageFromEntries,
  setTelegramSessionFileBranchName,
  type ExtensionContext,
  getExtensionContextCwd,
  getExtensionContextModel,
  hasExtensionContextPendingMessages,
  isExtensionContextIdle,
  TELEGRAM_TREE_BRANCH_CURSOR_CUSTOM_TYPE,
} from "../lib/pi.ts";
import { TELEGRAM_TREE_BRANCH_METADATA_CUSTOM_TYPE } from "../lib/menu-tree.ts";

type PiRuntimeApiHarness = Parameters<
  typeof createExtensionApiRuntimePorts
>[0] & {
  events: string[];
};

type PiRuntimeModel = Parameters<PiRuntimeApiHarness["setModel"]>[0];

function createHarnessModel(id: string): PiRuntimeModel {
  return { id } as PiRuntimeModel;
}

function getHarnessModelId(model: PiRuntimeModel): string {
  return String(Reflect.get(Object(model), "id"));
}

test("Pi API runtime ports bind methods without losing receiver context", async () => {
  const api: PiRuntimeApiHarness = {
    events: [],
    sendUserMessage(content, options) {
      this.events.push(
        `send:${String(content)}:${options?.deliverAs ?? "default"}`,
      );
    },
    async exec(command, args) {
      this.events.push(`exec:${command}:${args.join(",")}`);
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
    getCommands() {
      this.events.push("commands");
      return [];
    },
    getThinkingLevel() {
      this.events.push("get-thinking");
      return "high";
    },
    setThinkingLevel(level) {
      this.events.push(`thinking:${String(level)}`);
    },
    async setModel(model) {
      this.events.push(`model:${getHarnessModelId(model)}`);
      return true;
    },
  };
  const runtime = createExtensionApiRuntimePorts(api);
  runtime.sendUserMessage("hello", { deliverAs: "followUp" });
  assert.deepEqual(await runtime.exec("cmd", ["arg"]), {
    stdout: "ok",
    stderr: "",
    code: 0,
    killed: false,
  });
  assert.deepEqual(runtime.getCommands(), []);
  assert.equal(runtime.getThinkingLevel(), "high");
  runtime.setThinkingLevel("low");
  assert.equal(
    createEffectiveThinkingLevelSetter({
      setThinkingLevel: api.setThinkingLevel.bind(api),
      getThinkingLevel: api.getThinkingLevel.bind(api),
    })("medium"),
    "high",
  );
  assert.equal(await runtime.setModel(createHarnessModel("gpt-5")), true);
  assert.deepEqual(api.events, [
    "send:hello:followUp",
    "exec:cmd:arg",
    "commands",
    "get-thinking",
    "thinking:low",
    "thinking:medium",
    "get-thinking",
    "model:gpt-5",
  ]);
});

test("Pi tree branch cursor rewinds a session file without forking it", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tree-cursor-"));
  const manager = SessionManager.create("/repo", tempDir);
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("missing test session file");
  const userId = manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "[telegram] first prompt" }],
  } as never);
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "first answer" }],
  } as never);

  const result = createTelegramSessionFileTreeBranchCursor(
    { cwd: "/repo", sessionFile },
    userId,
  );
  assert.equal(result.cancelled, false);
  assert.equal(result.text, "[telegram] first prompt");

  const reopened = SessionManager.open(sessionFile, undefined, "/repo");
  assert.equal(reopened.getSessionFile(), sessionFile);
  assert.equal(reopened.getLeafId(), result.markerId);
  const marker = reopened.getEntry(result.markerId) as {
    type?: string;
    customType?: string;
    parentId?: string | null;
    data?: { targetId?: string; branchFromId?: string | null };
  };
  assert.equal(marker.type, "custom");
  assert.equal(marker.customType, TELEGRAM_TREE_BRANCH_CURSOR_CUSTOM_TYPE);
  assert.equal(marker.parentId, null);
  assert.equal(marker.data?.targetId, userId);
  assert.equal(marker.data?.branchFromId, null);
});

test("Pi session-file branch metadata helpers preserve active leaf cursor", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tree-branch-metadata-"));
  const manager = SessionManager.create("/repo", tempDir);
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("missing test session file");
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "first prompt" }],
  } as never);
  const firstAssistantId = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "first answer" }],
  } as never);
  manager.branch(firstAssistantId);
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "old branch prompt" }],
  } as never);
  const inactiveBranchLeafId = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "old answer" }],
  } as never);
  manager.branch(firstAssistantId);
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "current prompt" }],
  } as never);
  const activeLeafId = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "current answer" }],
  } as never);

  const reference = { cwd: "/repo", sessionFile };
  setTelegramSessionFileBranchName(reference, inactiveBranchLeafId, "old path");
  let reopened = SessionManager.open(sessionFile, undefined, "/repo");
  assert.equal(reopened.getLabel(inactiveBranchLeafId), "old path");
  let leaf = reopened.getLeafEntry() as {
    customType?: string;
    parentId?: string | null;
    data?: { preserveLeafId?: string; reason?: string };
  };
  assert.equal(leaf.customType, TELEGRAM_TREE_BRANCH_CURSOR_CUSTOM_TYPE);
  assert.equal(leaf.parentId, activeLeafId);
  assert.equal(leaf.data?.preserveLeafId, activeLeafId);
  assert.equal(leaf.data?.reason, "branch-rename");

  deleteTelegramSessionFileBranch(
    reference,
    inactiveBranchLeafId,
    TELEGRAM_TREE_BRANCH_METADATA_CUSTOM_TYPE,
  );
  reopened = SessionManager.open(sessionFile, undefined, "/repo");
  leaf = reopened.getLeafEntry() as {
    customType?: string;
    parentId?: string | null;
    data?: { preserveLeafId?: string; reason?: string };
  };
  assert.equal(leaf.customType, TELEGRAM_TREE_BRANCH_CURSOR_CUSTOM_TYPE);
  assert.equal(leaf.data?.reason, "branch-delete");
  assert.equal(leaf.data?.preserveLeafId, leaf.parentId);
  const deleteEntry = reopened.getEntries().find((entry) => {
    const raw = entry as {
      type?: string;
      customType?: string;
      data?: { leafId?: string; deleted?: boolean };
    };
    return (
      raw.type === "custom" &&
      raw.customType === TELEGRAM_TREE_BRANCH_METADATA_CUSTOM_TYPE &&
      raw.data?.leafId === inactiveBranchLeafId &&
      raw.data.deleted === true
    );
  });
  assert.ok(deleteEntry);
});

test("Pi scoped model persister invalidates cached inputs without clearing live menus", async () => {
  const events: string[] = [];
  const persist = createScopedModelPatternPersister({
    createSettingsManager: (cwd) => ({
      reload: async () => {},
      flush: async () => {
        events.push("flush");
      },
      getEnabledModels: () => undefined,
      setEnabledModels: (patterns) => {
        events.push(`set:${cwd}:${patterns?.join(",") ?? "all"}`);
      },
    }),
    clearCachedModelMenuInputs: () => {
      events.push("clear-cache");
    },
  });
  await persist(["openai/gpt-5"], { cwd: "/tmp/project" } as ExtensionContext);
  assert.deepEqual(events, [
    "set:/tmp/project:openai/gpt-5",
    "flush",
    "clear-cache",
  ]);
});

test("Pi context helpers expose model, idle, pending-message, and compact adapters", () => {
  const model = { provider: "openai", id: "gpt-5", name: "GPT-5" };
  const events: string[] = [];
  const ctx = {
    model,
    isIdle: () => true,
    hasPendingMessages: () => false,
    cwd: "/tmp/project",
    compact: (callbacks: { onComplete: () => void }) => {
      events.push("compact");
      callbacks.onComplete();
    },
  } as unknown as ExtensionContext;
  compactExtensionContext(ctx, {
    onComplete: () => {
      events.push("complete");
    },
    onError: () => {
      events.push("error");
    },
  });
  assert.equal(getExtensionContextModel(ctx), model);
  assert.equal(getExtensionContextCwd(ctx), "/tmp/project");
  assert.equal(isExtensionContextIdle(ctx), true);
  assert.equal(hasExtensionContextPendingMessages(ctx), false);
  assert.deepEqual(events, ["compact", "complete"]);
});

test("Pi session context usage derives from latest assistant usage", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 100,
          cacheWrite: 0,
          totalTokens: 115,
        },
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: {
          input: 20,
          output: 8,
          cacheRead: 200,
          cacheWrite: 2,
          totalTokens: 230,
        },
      },
    },
  ];

  assert.deepEqual(deriveSessionContextUsageFromEntries(entries, 1000), {
    tokens: 230,
    contextWindow: 1000,
    percent: 23,
  });
  assert.equal(deriveSessionContextUsageFromEntries(entries, undefined), undefined);
});

test("Pi tmux slash-command injector wraps send-keys in nohup/sleep and quotes the command", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const { createTmuxSlashCommandInjector } = await import("../lib/pi.ts");
  const inject = createTmuxSlashCommandInjector({
    exec: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
    target: "pi:0",
    command: "/new",
  });
  await inject();
  assert.deepEqual(calls, [
    {
      command: "nohup",
      args: [
        "bash",
        "-c",
        'sleep 1 && tmux send-keys -t pi:0 C-u "/new" Enter',
      ],
    },
  ]);
});

test("Pi dynamic tmux slash-command injector clears stale editor text", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const { createTelegramTreeExecInjector } = await import("../lib/pi.ts");
  const inject = createTelegramTreeExecInjector({
    exec: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
    target: "pi:0",
  });
  await inject("94911c33", false);
  assert.deepEqual(calls, [
    {
      command: "nohup",
      args: [
        "bash",
        "-c",
        'sleep 1 && tmux send-keys -t pi:0 C-u "/telegram-tree-exec 94911c33 none" Enter',
      ],
    },
  ]);
});

test("Pi tmux slash-command injector throws and records on non-zero exit", async () => {
  const events: Array<{ category: string; message: string }> = [];
  const { createTmuxSlashCommandInjector } = await import("../lib/pi.ts");
  const inject = createTmuxSlashCommandInjector({
    exec: async () => ({
      stdout: "",
      stderr: "no such session: pi",
      code: 1,
      killed: false,
    }),
    target: "pi:0",
    command: "/new",
    recordRuntimeEvent: (category, error) => {
      const message = error instanceof Error ? error.message : String(error);
      events.push({ category, message });
    },
  });
  await assert.rejects(() => inject(), /tmux send-keys failed/);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.category, "tmux_inject");
  assert.match(events[0]?.message ?? "", /no such session/);
});
