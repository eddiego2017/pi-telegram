/**
 * Regression tests for Telegram workspace helpers
 * Covers workspace/tab compatibility validation, command parsing, state normalization, and compact status formatting
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultTelegramTabsState,
  filterTelegramTabRecords,
  findTelegramTabByTopic,
  findTelegramTabNameCaseConflict,
  formatTelegramTabList,
  formatTelegramTabStatus,
  normalizeTelegramTabsState,
  normalizeTelegramTopicTabName,
  parseTelegramTabCommand,
  truncateTelegramTabText,
  validateTelegramTabName,
  createDefaultTelegramWorkspacesState,
  filterTelegramWorkspaceRecords,
  findTelegramWorkspaceByTopic,
  formatTelegramWorkspaceList,
  formatTelegramWorkspaceStatus,
  normalizeTelegramTopicWorkspaceName,
  parseTelegramWorkspaceCommand,
  validateTelegramWorkspaceName,
} from "../lib/workspaces.ts";

test("Tab helpers validate safe names and case conflicts", () => {
  assert.equal(validateTelegramTabName("A_1-ok"), undefined);
  assert.equal(validateTelegramTabName("has space"), undefined);
  assert.equal(validateTelegramTabName("has  double"), undefined);
  assert.match(validateTelegramTabName("has space!") ?? "", /single spaces/);
  assert.match(validateTelegramTabName("") ?? "", /required/);
  const state = createDefaultTelegramTabsState("/repo", 1000);
  state.tabs.Work = {
    name: "Work",
    cwd: "/repo",
    createdAt: 1000,
    lastUsedAt: 1000,
    status: "idle",
  };
  assert.equal(findTelegramTabNameCaseConflict(state.tabs, "work"), "Work");
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

test("Tab command parser handles MVP command forms", () => {
  assert.deepEqual(parseTelegramTabCommand(""), { kind: "list" });
  assert.deepEqual(parseTelegramTabCommand("list"), { kind: "list" });
  assert.deepEqual(parseTelegramTabCommand("new A"), { kind: "new", name: "A" });
  assert.deepEqual(parseTelegramTabCommand("new eve online marketing"), {
    kind: "new",
    name: "eve online marketing",
  });
  assert.deepEqual(parseTelegramTabCommand("rename B"), {
    kind: "rename",
    newName: "B",
  });
  assert.deepEqual(parseTelegramTabCommand("rename A B"), {
    kind: "rename",
    oldName: "A",
    newName: "B",
  });
  assert.deepEqual(parseTelegramTabCommand("rename eve online marketing"), {
    kind: "rename",
    newName: "eve online marketing",
  });
  assert.deepEqual(parseTelegramTabCommand("A"), {
    kind: "query",
    query: "A",
    filters: ["A"],
  });
  assert.deepEqual(parseTelegramTabCommand("eve on"), {
    kind: "query",
    query: "eve on",
    filters: ["eve", "on"],
  });
  assert.deepEqual(parseTelegramTabCommand("switch A"), {
    kind: "switch",
    name: "A",
  });
  assert.deepEqual(parseTelegramTabCommand("switch eve online marketing"), {
    kind: "switch",
    name: "eve online marketing",
  });
  assert.deepEqual(parseTelegramTabCommand("close"), {
    kind: "close",
    force: false,
  });
  assert.deepEqual(parseTelegramTabCommand("close --force"), {
    kind: "close",
    force: true,
  });
  assert.deepEqual(parseTelegramTabCommand("close A --force"), {
    kind: "close",
    name: "A",
    force: true,
  });
  assert.deepEqual(parseTelegramTabCommand("close eve online marketing --force"), {
    kind: "close",
    name: "eve online marketing",
    force: true,
  });
  assert.deepEqual(parseTelegramTabCommand("status A"), {
    kind: "status",
    name: "A",
  });
  assert.deepEqual(parseTelegramTabCommand("abort"), { kind: "abort" });
  assert.deepEqual(parseTelegramTabCommand("restart A"), {
    kind: "restart",
    name: "A",
  });
  assert.deepEqual(parseTelegramTabCommand("sync-names"), {
    kind: "syncNames",
  });
  assert.deepEqual(parseTelegramTabCommand("new"), {
    kind: "invalid",
    message: "Usage: /tab new <name>",
  });
  assert.deepEqual(parseTelegramTabCommand("rename"), {
    kind: "invalid",
    message: "Usage: /tab rename [old-name] <new-name>",
  });
});

test("Workspace topic helpers build stable names and find topic-bound records", () => {
  const name = normalizeTelegramTopicWorkspaceName(-1001234567890, 123);
  assert.match(name, /^tg-[a-z0-9]{6}-3f$/);
  const state = createDefaultTelegramWorkspacesState("/repo", 1000);
  state.tabs[name] = {
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
    findTelegramWorkspaceByTopic(state.tabs, -1001234567890, 123)?.name,
    name,
  );
});

test("Tab topic helpers build stable names and find topic-bound records", () => {
  const name = normalizeTelegramTopicTabName(-1001234567890, 123);
  assert.match(name, /^tg-[a-z0-9]{6}-3f$/);
  assert.equal(name.length <= 32, true);
  const state = createDefaultTelegramTabsState("/repo", 1000);
  state.tabs[name] = {
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
    findTelegramTabByTopic(state.tabs, -1001234567890, 123)?.name,
    name,
  );
  assert.equal(findTelegramTabByTopic(state.tabs, -1001234567890, 124), undefined);
});

test("Tab state normalization preserves records and marks stale running tabs exited", () => {
  const defaultState = normalizeTelegramTabsState(undefined, "/repo", 1000);
  assert.equal(defaultState.activeWorkspace, "default");
  assert.equal(defaultState.activeTab, "default");
  assert.deepEqual(defaultState.workspaces, {
    default: {
      name: "default",
      cwd: "/repo",
      createdAt: 1000,
      lastUsedAt: 1000,
      status: "idle",
    },
  });
  assert.equal(defaultState.tabs, defaultState.workspaces);
  const normalized = normalizeTelegramTabsState(
    {
      version: 1,
      activeTab: "A",
      tabs: {
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
  assert.equal(normalized.activeTab, "A");
  assert.equal(normalized.workspaces.A?.status, "exited");
  assert.equal(normalized.tabs.A?.status, "exited");
  assert.equal(normalized.workspaces.default?.status, "idle");
  const normalizedWithSource = normalizeTelegramTabsState(
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

test("Tab filters apply multiple tokens like resume filters", () => {
  const state = createDefaultTelegramTabsState("/repo", 1000);
  state.tabs["eve online marketing"] = {
    name: "eve online marketing",
    cwd: "/repo",
    createdAt: 1100,
    lastUsedAt: 1200,
    status: "idle",
    lastAssistantText: "market orders",
  };
  state.tabs["eve mining"] = {
    name: "eve mining",
    cwd: "/repo",
    createdAt: 1200,
    lastUsedAt: 1300,
    status: "idle",
  };
  const result = filterTelegramTabRecords(Object.values(state.tabs), ["eve", "on"]);
  assert.deepEqual(result.tabs.map((tab) => tab.name), ["eve online marketing"]);
  assert.deepEqual(result.trace, [
    { filter: "eve", before: 3, after: 2 },
    { filter: "on", before: 2, after: 1 },
  ]);
});

test("Workspace filters and formatters keep list and status compact", () => {
  const state = createDefaultTelegramWorkspacesState("/repo", 1000);
  state.tabs.A = {
    name: "A",
    cwd: "/repo",
    createdAt: 1100,
    lastUsedAt: 1200,
    status: "running",
    lastAgentStartAt: 500,
    lastAssistantText: "hello",
  };
  state.activeTab = "A";
  const filtered = filterTelegramWorkspaceRecords(Object.values(state.tabs), ["hello"]);
  assert.deepEqual(filtered.workspaces.map((workspace) => workspace.name), ["A"]);
  assert.match(formatTelegramWorkspaceList(state, { A: 1 }, 1500), /^Workspaces:/);
  assert.match(formatTelegramWorkspaceList(state, { A: 1 }, 1500), /A \* running 1s unread/);
  assert.match(
    formatTelegramWorkspaceStatus(state.tabs.A!, 1, 1500),
    /Workspace: A\nStatus: running/,
  );
});

test("Tab formatters keep list and status compact", () => {
  const defaultState = createDefaultTelegramTabsState("/repo", 1000);
  assert.match(formatTelegramTabList(defaultState, {}, 1000), /- General \* idle/);
  assert.match(formatTelegramTabStatus(defaultState.tabs.default!, 0, 1000), /Tab: General/);

  const state = createDefaultTelegramTabsState("/repo", 1000);
  state.tabs.A = {
    name: "A",
    cwd: "/repo",
    createdAt: 1100,
    lastUsedAt: 1200,
    status: "running",
    lastAgentStartAt: 500,
    lastAssistantText: "hello",
  };
  state.activeTab = "A";
  assert.match(
    formatTelegramTabList(state, { A: 1 }, 1500),
    /A \* running 1s unread/,
  );
  assert.match(formatTelegramTabStatus(state.tabs.A!, 1, 1500), /Last reply:\nhello/);
  const topicName = normalizeTelegramTopicTabName(-10042, 77);
  state.tabs[topicName] = {
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
    formatTelegramTabList(state, {}, 1500),
    new RegExp(`${topicName} · Deploy Debug · topic #77 idle`),
  );
  assert.match(
    formatTelegramTabStatus(state.tabs[topicName]!, 0, 1500),
    /Topic: Deploy Debug · topic #77/,
  );
});

test("Tab text truncation does not split surrogate pairs", () => {
  const truncated = truncateTelegramTabText(`${"a".repeat(95)}📝 tail`, 97);
  assert.equal(truncated, `${"a".repeat(95)}…`);
  assert.doesNotThrow(() => new TextEncoder().encode(truncated));
  assert.doesNotMatch(JSON.stringify(truncated), /\\ud[89ab][0-9a-f]{2}/i);
});
