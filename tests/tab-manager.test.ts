/**
 * Compatibility tests for the legacy Telegram tab manager module path
 * Ensures tab-manager imports keep working while canonical runtime moves to workspace-manager.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramTabManager,
  createTelegramTabManagerShutdownHook,
} from "../lib/tab-manager.ts";

test("Legacy tab-manager module path re-exports manager compatibility APIs", () => {
  assert.equal(typeof createTelegramTabManager, "function");
  assert.equal(typeof createTelegramTabManagerShutdownHook, "function");
});
