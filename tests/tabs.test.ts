/**
 * Compatibility tests for the legacy Telegram tabs helper module path
 * Ensures tab-named imports keep working while canonical helpers move to workspaces.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultTelegramTabsState,
  normalizeTelegramTopicTabName,
  parseTelegramTabCommand,
  validateTelegramTabName,
} from "../lib/tabs.ts";

test("Legacy tabs module path re-exports tab compatibility helpers", () => {
  assert.equal(validateTelegramTabName("A_1-ok"), undefined);
  assert.deepEqual(parseTelegramTabCommand("new A"), { kind: "new", name: "A" });
  assert.match(normalizeTelegramTopicTabName(-1001234567890, 123), /^tg-[a-z0-9]{6}-3f$/);
  const state = createDefaultTelegramTabsState("/repo", 1000);
  assert.equal(state.activeTab, "default");
  assert.equal(state.tabs, state.workspaces);
});
