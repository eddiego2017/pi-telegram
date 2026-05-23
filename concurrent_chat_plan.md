# Concurrent Telegram Tabs Handoff

This is the reset-safe handoff for concurrent `/tab` support in `pi-telegram`.

Status as of 2026-05-23: the concurrent tabs MVP is implemented, tested, live
in the `pi` Kubernetes deployment, and the main active-tab controls now follow
the selected tab.

## Current State

Implemented and smoke-tested:

- `/tab` opens an inline dashboard for switching tabs and confirming abort/close.
- `/tab new A`, `/tab A`, `/tab rename`, `/tab abort`, and `/tab close A` work.
- The default tab limit is 10.
- Each tab owns an isolated `pi --mode rpc --no-extensions` worker and session
  directory under `~/.pi/agent/telegram-tabs/sessions/<tab>`.
- Normal Telegram prompts route to the active tab.
- Same-tab follow-ups use RPC `streamingBehavior: "followUp"`.
- Inactive tabs keep running and send compact completion notices.
- Switching tabs automatically replays the selected tab's latest 5 user turns,
  including agent replies and replayable images.
- Active tabs stream answer text, thinking previews, tool-call previews, final
  Markdown replies, and Telegram native `typing` actions through the parent
  bridge.
- `/llm` and `/model` switch the active tab's worker model while that tab is idle.
- `/session` follows the active tab, including `Last 5 turns`, `Full replay`,
  `History`, and image replay.
- `/tree` follows the active tab in read-only mode.
- `/resume` follows the active tab: it lists that tab's session directory and
  switches the selected worker session through RPC `switch_session`. When tabs
  are enabled it no longer silently falls back to the host `/telegram-resume-exec`
  path.

Recent commits:

```text
e07dac4 fix: keep resume inside active tab
e29f005 feat: make resume tab-aware
9780916 feat: simplify tab dashboard controls
3bab7b5 feat: add tab dashboard controls
4392e75 fix: avoid reusing tab stream blocks
ddcf487 feat: replay tab history on switch
```

## Architecture

The parent `pi-telegram` extension remains the only Telegram owner:

```text
host pi process
  pi-telegram parent
    Telegram polling/auth/menus/replies
    TabManager
      default -> RpcChildBackend
      A       -> RpcChildBackend
      B       -> RpcChildBackend
```

Workers are launched like this:

```bash
pi --mode rpc --no-extensions \
  -e <provider-only-extension> \
  --session-dir ~/.pi/agent/telegram-tabs/sessions/<tab>
```

Guardrails:

- Workers must not load full `pi-telegram`.
- Workers must not poll Telegram or own Telegram locks.
- Parent-owned commands such as `/tab` must never be routed into a worker prompt.
- The parent may relay worker RPC events to Telegram.
- Worker extensions should stay provider-only.

Live config shape in `/home/pi/.pi/agent/telegram.json`:

```json
{
  "concurrentTabs": {
    "enabled": true,
    "maxTabs": 10,
    "inactiveNotify": true,
    "workerExtensions": [
      "/home/pi/.pi/agent/extensions/cpa-openai-proxy.ts",
      "/home/pi/.pi/agent/extensions/cpa-anthropic-proxy.ts",
      "/home/pi/.pi/agent/extensions/opencode-cpa-provider.ts",
      "/home/pi/.pi/agent/extensions/groq-filter.ts"
    ]
  }
}
```

## Main Files

```text
lib/tabs.ts          tab state, validation, command parsing, formatting
lib/rpc-child.ts     JSONL RPC child backend and event helpers
lib/tab-manager.ts   durable tab registry, worker orchestration, active-tab ports
lib/menu-resume.ts   /resume menu, tab-scoped listing, callback dispatch
lib/menu-session.ts  /session active-tab snapshot/replay/history
lib/menu-tree.ts     /tree active-tab read-only history
lib/config.ts        concurrentTabs config and workerExtensions
lib/commands.ts      /tab and immediate command routing
lib/routing.ts       prompt/control routing to active tab when enabled
index.ts             composition root and shutdown cleanup
```

Core tests:

```text
tests/tabs.test.ts
tests/rpc-child.test.ts
tests/tab-manager.test.ts
tests/menu-resume.test.ts
tests/menu-session.test.ts
tests/menu-tree.test.ts
tests/routing.test.ts
```

Latest validation:

```bash
npm run typecheck
node --experimental-strip-types --test --test-concurrency=1 tests/*.test.ts
# 643 pass, 0 fail
```

## Remaining Work

Recommended next items:

1. Observe real usage.
   - Watch for orphan child processes, confusing status, or reply routing bugs.
   - Useful checks:
     ```bash
     ps -eo pid,ppid,args | grep 'pi --mode rpc'
     cat ~/.pi/agent/telegram-tabs.json
     ```

2. Add optional tab UX controls only if needed.
   - `/tab mute <name>`
   - `/tab watch <name>`
   - `/tab delete <name>` as destructive history cleanup, separate from `close`

3. Add child-safe `/tree` mutation if tab-side rewind becomes important.
   - Current worker-tab `/tree` is intentionally read-only.
   - Rewind, branch rename, and soft delete must target the worker session
     safely, not the parent tmux injector.

4. Add worker-safe attachment spool only if file delivery from tabs matters.
   - Current behavior: workers can create files and mention local paths.
   - Future safe design: worker writes a spool request, parent validates and
     sends through the existing Telegram Bot API path.

5. Add advanced per-tab controls later if active-tab semantics are not enough.
   - `/tab compact`
   - `/tab thinking`
   - specified-tab model/session/tree controls

## Rollback

Disable concurrent tabs without reverting code:

```json
{
  "concurrentTabs": {
    "enabled": false
  }
}
```

Then restart or `/reload` the parent `pi` runtime.

If child workers are left behind:

```bash
ps -eo pid,ppid,args | grep 'pi --mode rpc'
kill <pid>
```

Do not delete `~/.pi/agent/telegram-tabs/sessions/` unless intentionally
discarding tab conversation history.
