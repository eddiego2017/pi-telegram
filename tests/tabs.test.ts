/**
 * Regression tests for Telegram concurrent tab helpers
 * Covers tab-name validation, command parsing, state normalization, and compact status formatting
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultTelegramTabsState,
  filterTelegramTabRecords,
  findTelegramTabNameCaseConflict,
  formatTelegramTabList,
  formatTelegramTabStatus,
  normalizeTelegramTabsState,
  parseTelegramTabCommand,
  truncateTelegramTabText,
  validateTelegramTabName,
} from "../lib/tabs.ts";

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
  assert.deepEqual(parseTelegramTabCommand("new"), {
    kind: "invalid",
    message: "Usage: /tab new <name>",
  });
  assert.deepEqual(parseTelegramTabCommand("rename"), {
    kind: "invalid",
    message: "Usage: /tab rename [old-name] <new-name>",
  });
});

test("Tab state normalization preserves records and marks stale running tabs exited", () => {
  assert.deepEqual(normalizeTelegramTabsState(undefined, "/repo", 1000), {
    version: 1,
    activeTab: "default",
    tabs: {
      default: {
        name: "default",
        cwd: "/repo",
        createdAt: 1000,
        lastUsedAt: 1000,
        status: "idle",
      },
    },
  });
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
  assert.equal(normalized.activeTab, "A");
  assert.equal(normalized.tabs.A?.status, "exited");
  assert.equal(normalized.tabs.default?.status, "idle");
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

test("Tab formatters keep list and status compact", () => {
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
});

test("Tab text truncation does not split surrogate pairs", () => {
  const truncated = truncateTelegramTabText(`${"a".repeat(95)}📝 tail`, 97);
  assert.equal(truncated, `${"a".repeat(95)}…`);
  assert.doesNotThrow(() => new TextEncoder().encode(truncated));
  assert.doesNotMatch(JSON.stringify(truncated), /\\ud[89ab][0-9a-f]{2}/i);
});
