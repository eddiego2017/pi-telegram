# Concurrent Telegram Tabs Handoff

Reset-safe handoff for concurrent `/tab` support in `pi-telegram`.

Status as of 2026-05-23: concurrent tabs are implemented, tested, and deployed
in the `pi` Kubernetes deployment. The parent extension owns Telegram polling,
menus, delivery, and Bot API calls. Each tab owns an isolated RPC worker.

## What Works

- `/tab` opens the inline dashboard for switching tabs and confirmed abort/close.
- `/tab new A`, `/tab A`, `/tab rename A B`, `/tab close A`, and `/tab abort`
  are parent-owned and stay responsive while workers run.
- Normal Telegram prompts route to the active tab.
- Inactive tabs keep running and send compact completion notices.
- Switching tabs replays the selected tab's last 5 user turns with agent replies
  and replayable image attachments.
- Active tab runs stream answer text, thinking previews, tool-call previews,
  final Markdown replies, and native Telegram `typing` actions.
- `/llm` and `/model` switch the active tab's child worker model while idle.
- `/new` starts a fresh session inside the active tab worker through RPC
  `new_session`.
- `/resume` lists the normal global cwd sessions and switches the selected
  session into the active tab worker through RPC `switch_session`. If the child reports stale
  session state after a successful switch, the parent restarts that worker on
  the selected session file.
- `/session` follows the active tab, including `Last 5 turns`, `Full replay`,
  history pagination, context usage, and replayable image attachments.
- `/tree` follows the active tab in read-only mode.
- Tabs persist across host `pi` restarts.
- Default tab limit is 10.

## Live Smoke

Already passed in Telegram:

```text
/tab
/tab new A
multi-turn conversation in A
/tab new B
conversation in B isolated from A
/tab close B
restart host pi
continue preserved tab session
/llm <model tokens>
/model
/session
/tree
/new
/resume
```

## Architecture

```text
host pi process
  pi-telegram parent
    Telegram polling/auth/menus/replies
    TabManager
      default -> RpcChildBackend
      A       -> RpcChildBackend
      B       -> RpcChildBackend
```

Worker launch shape:

```bash
pi --mode rpc --no-extensions \
  -e <provider-only-extension> \
  --session-dir ~/.pi/agent/telegram-tabs/sessions/<tab>
```

Guardrails:

- Workers must not load full `pi-telegram`.
- Workers must not poll Telegram or own Telegram locks.
- Parent-owned commands such as `/tab`, `/session`, `/tree`, `/new`, and
  `/resume` must not be routed into a worker as prompts.
- Provider-only extensions may be loaded through
  `concurrentTabs.workerExtensions`.

## Main Files

```text
lib/tabs.ts          tab state, validation, command parsing, formatting
lib/rpc-child.ts     JSONL RPC child backend and RPC command helpers
lib/tab-manager.ts   durable tab registry and worker orchestration
lib/menu-resume.ts   /resume menu, global listing, tab-scoped callback dispatch
lib/menu-session.ts  /session snapshot/replay/history rendering
lib/menu-tree.ts     /tree prompt history rendering
lib/commands.ts      command routing for /tab, /new, /name, /llm, etc.
lib/routing.ts       inbound prompt/control routing
index.ts             extension composition root
```

Tests:

```text
tests/tab-manager.test.ts
tests/menu-resume.test.ts
tests/menu-session.test.ts
tests/menu-tree.test.ts
tests/rpc-child.test.ts
tests/routing.test.ts
tests/commands.test.ts
tests/status.test.ts
tests/pi.test.ts
```

## Current Config Shape

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

## Recent Validation

```text
npm run typecheck
node --experimental-strip-types --test tests/tab-manager.test.ts tests/menu-resume.test.ts tests/routing.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/*.test.ts
```

Latest full sequential result: 647 pass, 0 fail.

## Known Limits

- Worker tabs still do not load full Telegram extensions, so child-local
  `telegram_attach` remains future work.
- Worker-tab `/tree` is read-only until child-safe rewind and branch mutation
  are implemented.
