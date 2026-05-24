# Concurrent Telegram Tabs Handoff

Reset-safe handoff for concurrent `/tab` support in `pi-telegram`.

Status as of 2026-05-24: concurrent tabs are implemented, tested, and deployed
in the `pi` Kubernetes deployment. The parent extension owns Telegram polling,
menus, delivery, Bot API calls, and durable tab state. Each tab owns one
isolated RPC worker process.

## Current Model

```text
tabs     = UI/runtime/process namespace
sessions = shared cwd session pool
```

Tabs keep a pointer to one active shared session file. They do not own private
session directories, and `/resume` remains the normal global cwd session list.

Worker launch shape:

```bash
pi --mode rpc --no-extensions \
  -e <provider-only-extension> \
  --session-dir <shared cwd session directory>
```

If a tab already points at an old absolute session file under
`~/.pi/agent/telegram-tabs/sessions/<tab>`, it may keep reading that file until
the user runs `/new` or `/resume`. New sessions and new workers use the shared
cwd session directory.

## Durable Tab State

Durable state lives in:

```text
~/.pi/agent/telegram-tabs.json
```

Allowed per-tab fields:

```text
name
cwd
sessionFile
sessionId
sessionName
currentModel
currentThinkingLevel
createdAt
lastUsedAt
status
lastError
lastAgentStartAt
lastAgentEndAt
lastAssistantText
lastMessageText
lastMessageAt
messageCount
```

Do not add browser checkpoint delivery state to tab records. Removed fields:
`telegramChatId`, `telegramReplyToMessageId`, `telegramTargetUpdatedAt`,
`browserTargetId`, `browserTargetUrl`, `browserTargetTitle`, and
`browserTargetUpdatedAt`.

Browser skill automatic step images were removed. Browser skill scripts must not
write `telegram-tabs.json`, read tab reply targets, or call Bot API `sendPhoto`
for automatic visual checkpoints.

## Behavior

- `/tab` opens the dashboard; `Manage` supports multi-select close.
- `/tab new A`, `/tab A`, `/tab rename A B`, `/tab close A`, and
  `/tab abort [name]` are parent-owned.
- Bare `/abort` and `/stop` target the active tab worker when concurrent tabs
  are enabled. `/stop` still clears the Telegram queue.
- Normal Telegram prompts route to the active tab.
- Inactive tabs keep running and send compact completion notices.
- Switching tabs replays the selected tab's latest turns.
- Active tabs stream answer text, thinking previews, tool-call previews, final
  Markdown replies, and Telegram `typing` actions.
- `/llm`, `/model`, `/new`, `/resume`, `/session`, and `/tree` follow the
  active tab.
- `/tree` worker branch actions use same-session cursors/metadata; parent-style
  prompt rewind remains read-only for worker tabs.
- Default tab limit is 10.

## Guardrails

- Workers must not load full `pi-telegram`.
- Workers must not poll Telegram or own Telegram locks.
- Parent-owned commands must not be routed into a worker as prompts.
- Do not create new tab-owned session directories.
- Do not make `/resume`, `/session`, `/tree`, `/new`, or docs treat a tab as
  owning a private session list.
- Browser skill must remain outside `telegram-tabs.json` ownership.

## Main Files

```text
lib/tabs.ts          tab state, validation, command parsing, formatting
lib/rpc-child.ts     JSONL RPC child backend and RPC command helpers
lib/tab-manager.ts   durable tab registry and worker orchestration
lib/menu-resume.ts   /resume menu, global listing, tab-scoped callbacks
lib/menu-session.ts  /session snapshot/replay/history rendering
lib/menu-tree.ts     /tree prompt history and worker branch actions
lib/commands.ts      command routing for /tab, /new, /name, /llm, etc.
lib/routing.ts       inbound prompt/control routing
index.ts             extension composition root
```

Focused tests:

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

## Validation

Latest local validation:

```text
npm run typecheck
node --experimental-strip-types --test tests/tab-manager.test.ts tests/rpc-child.test.ts
```

Latest full local sequential result before the browser-checkpoint removal:

```text
node --experimental-strip-types --test --test-concurrency=1 tests/*.test.ts
647 pass, 0 fail
```

Live `pi` pod validation after browser-checkpoint removal:

```text
cd /home/pi/projects/pi-telegram && npm run typecheck
python3 -m py_compile browser skill scripts
telegram-tabs.json cleaned of removed checkpoint fields
pi runtime restarted
```
