# Concurrent Telegram Tabs Handoff

Reset-safe handoff for concurrent `/tab` support in `pi-telegram`.

Status as of 2026-05-23: concurrent tabs are implemented, tested, and deployed
in the `pi` Kubernetes deployment. The parent extension owns Telegram polling,
menus, delivery, and Bot API calls. Each tab owns an isolated RPC worker.

Important direction change as of 2026-05-23: remove the original per-tab
private session folder design. Tabs should not have private session storage
under `~/.pi/agent/telegram-tabs/sessions/<tab>`. Sessions are shared by cwd,
as they were before `/tab`; each tab only keeps a pointer to the active shared
session file.

Implementation status as of 2026-05-23: the shared cwd session pool change,
the `/resume` session-name refresh fix, and active-tab `/abort`/`/stop` routing
are implemented locally and applied to the live `pi` Kubernetes deployment.
The Telegram runtime was reloaded through tmux after validation.

Follow-up fix on 2026-05-23: live testing showed bare `/abort` and `/stop`
still replied `No active turn.` because the production command-target runtime
wrapper did not forward the active-tab abort port to the core command handler.
That wrapper now forwards `abortActiveTab`, with a regression covering the
actual routing path.

## What Works

- `/tab` opens the inline dashboard for switching tabs and confirmed abort/close.
- `/tab new A`, `/tab A`, `/tab rename A B`, `/tab close A`, and `/tab abort`
  are parent-owned and stay responsive while workers run.
- Bare `/abort` and `/stop` target the active tab worker when concurrent tabs
  are enabled. `/stop` also clears the Telegram queue.
- Normal Telegram prompts route to the active tab.
- Inactive tabs keep running and send compact completion notices.
- Switching tabs replays the selected tab's last 5 user turns with agent replies
  and replayable image attachments.
- Active tab runs stream answer text, thinking previews, tool-call previews,
  final Markdown replies, and native Telegram `typing` actions.
- `/llm` and `/model` switch the active tab's child worker model while idle.
- `/new` starts a fresh session inside the active tab worker through RPC
  `new_session`, creating the new file in the shared cwd session pool.
- `/resume` lists the normal global cwd sessions and switches the selected
  session into the active tab worker through RPC `switch_session`. If the child reports stale
  session state after a successful switch, the parent restarts that worker on
  the selected session file. The active tab's session name is refreshed from
  the resumed worker state, and stale tab names are cleared when the selected
  session is unnamed.
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

Target worker launch shape:

```bash
pi --mode rpc --no-extensions \
  -e <provider-only-extension> \
  --session-dir <shared cwd session directory>
```

Deprecated original launch shape:

```bash
pi --mode rpc --no-extensions \
  -e <provider-only-extension> \
  --session-dir ~/.pi/agent/telegram-tabs/sessions/<tab>
```

That deprecated shape is the design being removed. Do not create new tab-owned
session directories. Do not make `/resume` list per-tab directories. Do not
describe session isolation as a tab feature in docs.

Guardrails:

- Workers must not load full `pi-telegram`.
- Workers must not poll Telegram or own Telegram locks.
- Parent-owned commands such as `/tab`, `/session`, `/tree`, `/new`, and
  `/resume` must not be routed into a worker as prompts.
- Provider-only extensions may be loaded through
  `concurrentTabs.workerExtensions`.

## New Session Storage Model

The desired model is:

```text
tabs     = UI/runtime/process namespace
sessions = shared cwd session pool
```

Tabs may keep their own active session pointer, but the pointed-to file belongs
to the normal shared session pool for the cwd. There is no concept of
"sessions owned by tab A" or "resume list for tab B".

Durable tab state remains in:

```text
~/.pi/agent/telegram-tabs.json
```

Expected durable fields per tab:

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
```

These are tab state, not a private session namespace. `sessionFile` is just the
active shared session file for that tab.

Per-tab state that should remain:

- One isolated RPC worker process per tab, for concurrency.
- One active shared-session pointer per tab: `sessionFile`, `sessionId`,
  `sessionName`.
- One model/thinking selection per tab: `currentModel`,
  `currentThinkingLevel`.
- In-memory streaming buffers per tab: text, thinking, tool-call preview state,
  sent-preview de-duplication, typing timers, active Telegram message ids.
- Per-tab status/unread/last-reply UI state.

Per-tab state that should be removed:

- `~/.pi/agent/telegram-tabs/sessions/<tab>` as a storage root.
- Any worker launch that chooses `--session-dir` by tab name.
- Any `/resume`, `/session`, `/tree`, `/new`, or docs behavior that treats a
  tab as owning a private session list.

Existing old files under `~/.pi/agent/telegram-tabs/sessions/<tab>` must not be
deleted automatically. If an existing tab already points at one of those files,
it may keep reading it by absolute `sessionFile` until the user runs `/new` or
`/resume`. New sessions and new workers should use the shared cwd session
directory.

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

Resolved code areas that previously reflected the old private-folder design:

```text
lib/tab-manager.ts
  Removed getTelegramTabsSessionRoot(agentDir).
  Removed tab-name session directory creation.
  RpcChildBackend now receives the current shared cwd session directory.
  getActiveResumeSessionScope().sessionDir is the shared cwd session directory.

lib/rpc-child.ts
  buildRpcChildArgs() still supports --session-dir and omits it when no
  sessionDir is provided, allowing the pi CLI to use its normal default.

tests/tab-manager.test.ts
tests/menu-resume.test.ts
  Expectations now make the shared-session behavior explicit.
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

## Completed Implementation Plan

Goal completed: remove per-tab private session folders while preserving
concurrent tab behavior.

1. Add or expose a reliable way for `createTelegramTabManager()` to know the
   normal shared session directory for the current cwd. Prefer the same source
   the non-tab session manager uses; do not infer it from
   `~/.pi/agent/telegram-tabs`.
2. Change `lib/tab-manager.ts` so `ensureBackend()` passes the shared cwd
   session directory to `RpcChildBackend` when `runtime.record.sessionFile` is
   absent.
3. Stop creating `join(sessionRoot, runtime.record.name)`. After the change,
   creating or switching tabs must not create a tab-named session directory.
4. Keep `runtime.record.sessionFile` semantics. If a tab has an explicit
   `sessionFile`, start the worker with that file so existing old private files
   remain readable.
5. Remove `sessionDir` from the active resume scope if no longer needed, or set
   it to the shared cwd session directory only. `/resume` must keep listing
   global cwd sessions.
6. Ensure `/new` on a tab creates a new session in the shared cwd session pool
   and updates that tab's `sessionFile`, `sessionId`, and `sessionName`.
7. Ensure `/resume` selection applies the selected shared session file to the
   active tab only.
8. Update README/CHANGELOG/docs after implementation so they no longer claim
   that each tab has its own session directory.
9. Local validation completed:

```text
npm run typecheck
node --experimental-strip-types --test tests/tab-manager.test.ts tests/menu-resume.test.ts tests/routing.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/*.test.ts
```

10. Validated and reloaded in the `pi` Kubernetes deployment:

```text
kubectl -n pi exec deploy/pi -c pi -- sh -lc 'cd /home/pi/projects/pi-telegram && npm run typecheck'
kubectl -n pi exec deploy/pi -c pi -- sh -lc 'cd /home/pi/projects/pi-telegram && node --experimental-strip-types --test --test-name-pattern "routes prompts to active workers|rebinds worker" tests/tab-manager.test.ts'
kubectl -n pi exec deploy/pi -c pi -- sh -lc 'cd /home/pi/projects/pi-telegram && node --experimental-strip-types --test --test-name-pattern "refreshes session name|routes prompts to active workers|rebinds worker" tests/tab-manager.test.ts'
kubectl -n pi exec deploy/pi -c pi -- sh -lc 'cd /home/pi/projects/pi-telegram && node --experimental-strip-types --test tests/rpc-child.test.ts tests/menu-resume.test.ts'
kubectl -n pi exec deploy/pi -c pi -- sh -lc 'tmux send-keys -t pi:0 C-u /telegram-reload-runtime Enter'
```

Note: one pod-only run of the full targeted tab-manager test file hit the
timing-sensitive `Tab manager sends typing actions for the active running tab`
assertion because the pod scheduler allowed one extra typing interval. The same
full suite passed locally; the pod rerun used focused tests for the changed
shared-session behavior.

Acceptance criteria:

- `/tab new A` does not create
  `~/.pi/agent/telegram-tabs/sessions/A`.
- `/new` inside any tab creates the new session in the same shared session pool
  used by normal `/resume`.
- `/resume` shows all sessions for the cwd, not a tab-specific list.
- Selecting a `/resume` item changes only the active tab's session pointer.
- `/session`, `/tree`, `/llm`, `/model`, streaming, typing, inactive
  completion notices, and tab switching still behave as before.
