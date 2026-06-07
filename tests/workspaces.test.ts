/**
 * Regression tests for Telegram workspace helpers
 * Covers workspace validation, command parsing, state normalization, and compact status formatting
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultTelegramWorkspacesState,
  filterTelegramWorkspaceRecords,
  findTelegramWorkspaceByTopic,
  findTelegramWorkspaceNameCaseConflict,
  formatTelegramWorkspaceList,
  formatTelegramWorkspaceStatus,
  normalizeTelegramWorkspacesState,
  normalizeTelegramTopicWorkspaceName,
  parseTelegramWorkspaceCommand,
  truncateTelegramWorkspaceText,
  validateTelegramWorkspaceName,
} from "../lib/workspaces.ts";

test("Workspace helpers validate safe names and case conflicts", () => {
  assert.equal(validateTelegramWorkspaceName("A_1-ok"), undefined);
  assert.equal(validateTelegramWorkspaceName("has space"), undefined);
  assert.equal(validateTelegramWorkspaceName("has  double"), undefined);
  assert.match(validateTelegramWorkspaceName("has space!") ?? "", /single spaces/);
  assert.match(validateTelegramWorkspaceName("") ?? "", /required/);
  const state = createDefaultTelegramWorkspacesState("/repo", 1000);
  state.workspaces.Work = {
    name: "Work",
    cwd: "/repo",
    createdAt: 1000,
    lastUsedAt: 1000,
    status: "idle",
  };
  assert.equal(findTelegramWorkspaceNameCaseConflict(state.workspaces, "work"), "Work");
});

test("Workspace aliases validate names and parse commands with workspace wording", () => {
  assert.equal(validateTelegramWorkspaceName("A_1-ok"), undefined);
  assert.match(validateTelegramWorkspaceName("has space!") ?? "", /Workspace names/);
  assert.deepEqual(parseTelegramWorkspaceCommand("new A"), { kind: "new", name: "A" });
  assert.deepEqual(parseTelegramWorkspaceCommand("new"), {
    kind: "invalid",
    message: "Usage: /workspace new <name>",
  });
});

test("Workspace command parser handles MVP command forms", () => {
  assert.deepEqual(parseTelegramWorkspaceCommand(""), { kind: "list" });
  assert.deepEqual(parseTelegramWorkspaceCommand("list"), { kind: "list" });
  assert.deepEqual(parseTelegramWorkspaceCommand("new A"), { kind: "new", name: "A" });
  assert.deepEqual(parseTelegramWorkspaceCommand("new eve online marketing"), {
    kind: "new",
    name: "eve online marketing",
  });
  assert.deepEqual(parseTelegramWorkspaceCommand("rename B"), {
    kind: "rename",
    newName: "B",
  });
  assert.deepEqual(parseTelegramWorkspaceCommand("rename A B"), {
    kind: "rename",
    oldName: "A",
    newName: "B",
  });
  assert.deepEqual(parseTelegramWorkspaceCommand("rename eve online marketing"), {
    kind: "rename",
    newName: "eve online marketing",
  });
  assert.deepEqual(parseTelegramWorkspaceCommand("A"), {
    kind: "query",
    query: "A",
    filters: ["A"],
  });
  assert.deepEqual(parseTelegramWorkspaceCommand("eve on"), {
    kind: "query",
    query: "eve on",
    filters: ["eve", "on"],
  });
  assert.deepEqual(parseTelegramWorkspaceCommand("switch A"), {
    kind: "switch",
    name: "A",
  });
  assert.deepEqual(parseTelegramWorkspaceCommand("switch eve online marketing"), {
    kind: "switch",
    name: "eve online marketing",
  });
  assert.deepEqual(parseTelegramWorkspaceCommand("close"), {
    kind: "close",
    force: false,
  });
  assert.deepEqual(parseTelegramWorkspaceCommand("close --force"), {
    kind: "close",
    force: true,
  });
  assert.deepEqual(parseTelegramWorkspaceCommand("close A --force"), {
    kind: "close",
    name: "A",
    force: true,
  });
  assert.deepEqual(parseTelegramWorkspaceCommand("close eve online marketing --force"), {
    kind: "close",
    name: "eve online marketing",
    force: true,
  });
  assert.deepEqual(parseTelegramWorkspaceCommand("status A"), {
    kind: "status",
    name: "A",
  });
  assert.deepEqual(parseTelegramWorkspaceCommand("abort"), { kind: "abort" });
  assert.deepEqual(parseTelegramWorkspaceCommand("restart A"), {
    kind: "restart",
    name: "A",
  });
  assert.deepEqual(parseTelegramWorkspaceCommand("sync-names"), {
    kind: "syncNames",
  });
  assert.deepEqual(parseTelegramWorkspaceCommand("new"), {
    kind: "invalid",
    message: "Usage: /workspace new <name>",
  });
  assert.deepEqual(parseTelegramWorkspaceCommand("rename"), {
    kind: "invalid",
    message: "Usage: /workspace rename [old-name] <new-name>",
  });
});

test("Workspace topic helpers build stable names and find topic-bound records", () => {
  const name = normalizeTelegramTopicWorkspaceName(-1001234567890, 123);
  assert.match(name, /^tg-[a-z0-9]{6}-3f$/);
  const state = createDefaultTelegramWorkspacesState("/repo", 1000);
  state.workspaces[name] = {
    name,
    cwd: "/repo",
    createdAt: 1000,
    lastUsedAt: 1000,
    status: "idle",
    source: {
      kind: "telegram-topic",
      chatId: -1001234567890,
      messageThreadId: 123,
      topicTitle: "Deploy Debug",
    },
  };
  assert.equal(
    findTelegramWorkspaceByTopic(state.workspaces, -1001234567890, 123)?.name,
    name,
  );
});

test("Workspace topic helpers build stable names and find topic-bound records", () => {
  const name = normalizeTelegramTopicWorkspaceName(-1001234567890, 123);
  assert.match(name, /^tg-[a-z0-9]{6}-3f$/);
  assert.equal(name.length <= 32, true);
  const state = createDefaultTelegramWorkspacesState("/repo", 1000);
  state.workspaces[name] = {
    name,
    cwd: "/repo",
    createdAt: 1000,
    lastUsedAt: 1000,
    status: "idle",
    source: {
      kind: "telegram-topic",
      chatId: -1001234567890,
      messageThreadId: 123,
      topicTitle: "Deploy Debug",
    },
  };
  assert.equal(
    findTelegramWorkspaceByTopic(state.workspaces, -1001234567890, 123)?.name,
    name,
  );
  assert.equal(findTelegramWorkspaceByTopic(state.workspaces, -1001234567890, 124), undefined);
});

test("Workspace state normalization preserves records and marks stale running workspaces exited", () => {
  const defaultState = normalizeTelegramWorkspacesState(undefined, "/repo", 1000);
  assert.equal(defaultState.activeWorkspace, "default");
  assert.deepEqual(defaultState.workspaces, {
    default: {
      name: "default",
      cwd: "/repo",
      createdAt: 1000,
      lastUsedAt: 1000,
      status: "idle",
    },
  });

  const normalized = normalizeTelegramWorkspacesState(
    {
      version: 1,
      activeWorkspace: "A",
      workspaces: {
        A: {
          name: "A",
          cwd: "/repo",
          createdAt: 1,
          lastUsedAt: 2,
          status: "running",
        },
      },
    },
    "/repo",
    1000,
  );
  assert.equal(normalized.activeWorkspace, "A");
  assert.equal(normalized.activeWorkspace, "A");
  assert.equal(normalized.workspaces.A?.status, "exited");
  assert.equal(normalized.workspaces.A?.status, "exited");
  assert.equal(normalized.workspaces.default?.status, "idle");
  const normalizedWithSource = normalizeTelegramWorkspacesState(
    {
      version: 1,
      activeWorkspace: "tg-topic",
      workspaces: {
        "tg-topic": {
          name: "tg-topic",
          cwd: "/repo",
          createdAt: 1,
          lastUsedAt: 2,
          status: "idle",
          source: {
            kind: "telegram-topic",
            chatId: -1001,
            messageThreadId: 77,
            topicTitle: "Ops",
          },
        },
      },
    },
    "/repo",
    1000,
  );
  assert.deepEqual(normalizedWithSource.workspaces["tg-topic"]?.source, {
    kind: "telegram-topic",
    chatId: -1001,
    messageThreadId: 77,
    topicTitle: "Ops",
  });
});

test("Workspace filters apply multiple tokens like resume filters", () => {
  const state = createDefaultTelegramWorkspacesState("/repo", 1000);
  state.workspaces["eve online marketing"] = {
    name: "eve online marketing",
    cwd: "/repo",
    createdAt: 1100,
    lastUsedAt: 1200,
    status: "idle",
    lastAssistantText: "market orders",
  };
  state.workspaces["eve mining"] = {
    name: "eve mining",
    cwd: "/repo",
    createdAt: 1200,
    lastUsedAt: 1300,
    status: "idle",
  };
  const result = filterTelegramWorkspaceRecords(Object.values(state.workspaces), ["eve", "on"]);
  assert.deepEqual(result.workspaces.map((workspace) => workspace.name), ["eve online marketing"]);
  assert.deepEqual(result.trace, [
    { filter: "eve", before: 3, after: 2 },
    { filter: "on", before: 2, after: 1 },
  ]);
});

test("Workspace filters and formatters keep list and status compact", () => {
  const state = createDefaultTelegramWorkspacesState("/repo", 1000);
  state.workspaces.A = {
    name: "A",
    cwd: "/repo",
    createdAt: 1100,
    lastUsedAt: 1200,
    status: "running",
    lastAgentStartAt: 500,
    lastAssistantText: "hello",
  };
  state.activeWorkspace = "A";
  const filtered = filterTelegramWorkspaceRecords(Object.values(state.workspaces), ["hello"]);
  assert.deepEqual(filtered.workspaces.map((workspace) => workspace.name), ["A"]);
  assert.match(formatTelegramWorkspaceList(state, { A: 1 }, 1500), /^Workspaces:/);
  assert.match(formatTelegramWorkspaceList(state, { A: 1 }, 1500), /A \* running 1s unread/);
  assert.match(
    formatTelegramWorkspaceStatus(state.workspaces.A!, 1, 1500),
    /Workspace: A\nStatus: running/,
  );
});

test("Workspace formatters keep list and status compact", () => {
  const defaultState = createDefaultTelegramWorkspacesState("/repo", 1000);
  assert.match(formatTelegramWorkspaceList(defaultState, {}, 1000), /- General \* idle/);
  assert.match(formatTelegramWorkspaceStatus(defaultState.workspaces.default!, 0, 1000), /Workspace: General/);

  const state = createDefaultTelegramWorkspacesState("/repo", 1000);
  state.workspaces.A = {
    name: "A",
    cwd: "/repo",
    createdAt: 1100,
    lastUsedAt: 1200,
    status: "running",
    lastAgentStartAt: 500,
    lastAssistantText: "hello",
  };
  state.activeWorkspace = "A";
  assert.match(
    formatTelegramWorkspaceList(state, { A: 1 }, 1500),
    /A \* running 1s unread/,
  );
  assert.match(formatTelegramWorkspaceStatus(state.workspaces.A!, 1, 1500), /Last reply:\nhello/);
  const topicName = normalizeTelegramTopicWorkspaceName(-10042, 77);
  state.workspaces[topicName] = {
    name: topicName,
    cwd: "/repo",
    createdAt: 1300,
    lastUsedAt: 1300,
    status: "idle",
    source: {
      kind: "telegram-topic",
      chatId: -10042,
      messageThreadId: 77,
      topicTitle: "Deploy Debug",
    },
  };
  assert.match(
    formatTelegramWorkspaceList(state, {}, 1500),
    new RegExp(`${topicName} · Deploy Debug · topic #77 idle`),
  );
  assert.match(
    formatTelegramWorkspaceStatus(state.workspaces[topicName]!, 0, 1500),
    /Topic: Deploy Debug · topic #77/,
  );
});

test("Workspace text truncation does not split surrogate pairs", () => {
  const truncated = truncateTelegramWorkspaceText(`${"a".repeat(95)}📝 tail`, 97);
  assert.equal(truncated, `${"a".repeat(95)}…`);
  assert.doesNotThrow(() => new TextEncoder().encode(truncated));
  assert.doesNotMatch(JSON.stringify(truncated), /\\ud[89ab][0-9a-f]{2}/i);
});
