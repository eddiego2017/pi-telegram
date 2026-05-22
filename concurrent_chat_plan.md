# Concurrent Telegram Tabs Handoff Plan

This document is the short reset-safe handoff for concurrent `/tab` support in
`pi-telegram`.

Status as of 2026-05-22: MVP plus active-tab `/llm`, `/model`, live answer
text streaming, live thinking streaming, live tool-call preview streaming,
Markdown final replies, active-tab `/session`/`/tree` history browsing,
`/session` image replay, a 10-tab default limit, `/tab rename`, active-tab
Telegram typing actions, and automatic last-5 replay on tab switch are
implemented, tested, and deployed in the `pi` Kubernetes deployment.

Last committed MVP baseline:

```text
9c494d5 feat: add concurrent Telegram tabs
```

Recent committed milestones:

```text
34ca48f docs: update concurrent tabs handoff
7bf5304 feat: stream tab worker answer text
87fe9cb feat: stream tab worker thinking and tool calls
ed2ae95 feat: relay tab worker thinking and tool calls
8ebb546 docs: record concurrent tab model smoke test
f598e74 feat: route model menu to active tab
5ee3637 feat: route llm command to active tab
```

Current implementation also includes:

```text
active-tab /session and /tree now read the selected tab worker session file
/session replay re-uploads retained local images, including hidden sendPhoto tool calls
default concurrent tab limit is 10 and /tab rename is available
active tab worker runs show native Telegram typing actions
/tab <name> automatically replays that tab's last 5 user turns
```

Implemented updates after the MVP baseline:

- `/llm [tokens...]` keeps the existing list/filter/single-match UX.
- When `concurrentTabs.enabled` is true, `/llm` now switches the active tab's
  RPC child model instead of the parent session model.
- `/model` now opens the active tab's model picker and routes model-menu picks
  to the active tab's RPC child.
- Busy active tabs reject model switches until idle.
- Active tabs first restored thinking/tool-call display by relaying worker RPC
  events through the parent bridge.
- Active tabs now stream worker answer text, thinking previews, tool-call
  previews, and final Markdown replies through the parent Telegram bridge.
- `/session` now opens the active tab's session snapshot when concurrent tabs
  are enabled, so `Last 5 turns`, `Full replay`, and `History` survive tab
  switching and read the selected worker's JSONL session file.
- `/session` replay re-uploads local images recorded in Telegram attachments,
  file-backed image blocks, and hidden assistant `sendPhoto` tool calls that
  later produce a visible confirmation message.
- The default `concurrentTabs.maxTabs` limit is now 10.
- `/tab rename [old-name] <new-name>` renames non-default tabs while preserving
  their session file/history.
- Active tab worker runs show native Telegram `typing` chat actions from the
  parent bridge while the child process is answering; typing stops when the tab
  finishes, exits, errors, is aborted, or is switched away.
- `/tab <name>` automatically sends the selected tab's last 5 user turns,
  including agent replies and replayable image attachments, using the same
  replay formatter as `/session`.
- `/tree` now opens the active tab's prompt history when concurrent tabs are
  enabled. It is read-only for worker tabs until child-safe tree navigation and
  branch mutation are implemented.

## What Works Now

- `/tab` lists tabs without starting a worker.
- `/tab new A` creates a new independent tab.
- Normal Telegram messages go to the active tab when concurrent tabs are enabled.
- A prompt running in tab A does not block tab B.
- Same-tab follow-up prompts use RPC `streamingBehavior: "followUp"`.
- `/llm [tokens...]` lists models and switches the active tab model when a
  single model matches.
- `/model` shows the active tab's current model marker when the child has
  reported a model and applies menu selections to that tab's worker.
- Active tab runs stream worker answer text, thinking content, and assistant
  tool-call previews again without loading full Telegram extensions in the
  worker.
- Active tab runs show Telegram's native `typing` indicator while the selected
  worker is answering.
- Switching tabs with `/tab <name>` shows the selected tab's recent context by
  replaying its last 5 user turns and matching agent replies.
- Up to 10 concurrent tabs are allowed by default.
- `/tab rename A B` renames tab A to B; `/tab rename B` renames the active tab.
- `/session` history/replay controls show the active tab's conversation after
  `/tab <name>` switches.
- `/session` replay sends retained image attachments back to Telegram, including
  images originally sent by hidden `sendPhoto` tool calls.
- `/tree` shows the active tab's prompt history after `/tab <name>` switches;
  rewind/branch mutation buttons are hidden or blocked for worker tabs.
- `/tab close B` closes a tab and keeps its session file.
- Restarting the host `pi` process preserves tab registry and conversation state.
- Feature is opt-in through `telegram.json`; existing single-session behavior remains the fallback when disabled.

Live smoke already passed:

```text
/tab
/tab new A
multi-turn conversation in A
/tab new B
conversation in B isolated from A
/tab close B
restart host pi
continue preserved tab session
/tab A
/llm <model tokens>
active tab A model switched
/model
active tab A model picker shows/applies the tab model
/tab B
/model
tab B model picker remains isolated from A
/tab A
/session
Last 5 / Full replay / History show tab A history
/tree
active-path prompt history shows tab A prompts
```

## Current Architecture

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

Each tab runs a child process:

```bash
pi --mode rpc --no-extensions \
  -e <provider-only-extension> \
  --session-dir ~/.pi/agent/telegram-tabs/sessions/<tab>
```

Important guardrail:

- Workers must never load full `pi-telegram`.
- Workers must never poll Telegram.
- Workers must never own Telegram locks, menus, bot commands, or Bot API delivery.
- Parent-owned commands such as `/tab` must never be routed into a worker prompt.
- The parent may relay worker RPC events to Telegram; workers still only load
  provider-safe extensions from `concurrentTabs.workerExtensions`.

## Live Config

The pod currently uses this shape in `/home/pi/.pi/agent/telegram.json`:

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

`workerExtensions` is intentionally provider-only. It exists because
`--no-extensions` disables extension discovery, and this deployment's models are
registered by extension files. Do not add `pi-telegram` or Telegram delivery
extensions to this list.

## Main Files

Implemented modules:

```text
lib/tabs.ts          pure tab state, validation, command parsing, formatting
lib/rpc-child.ts     JSONL RPC child backend and event helpers
lib/tab-manager.ts   durable tab registry and worker orchestration
```

Wiring:

```text
lib/config.ts        concurrentTabs config and workerExtensions
lib/commands.ts      /tab reserved immediate command
lib/routing.ts       prompt, /llm, and /model routing to active tab when enabled
index.ts             tab manager composition and shutdown cleanup
```

Tests:

```text
tests/tabs.test.ts
tests/rpc-child.test.ts
tests/tab-manager.test.ts
tests/config.test.ts
tests/commands.test.ts
```

Full validation passed for the current implementation:

```bash
npm run typecheck
npm test
# 628 pass, 0 fail
```

## Important Bug Already Fixed

During live smoke, `/tab` was initially routed into the default worker and
failed with:

```text
Tab default failed: No API key found for openai.
```

Root cause:

- `buildTelegramCommandAction("tab")` existed.
- `handleTabCommand` was not passed through
  `createTelegramCommandHandlerTargetRuntime`.
- The command handler returned "not handled".
- Concurrent prompt fallback sent `/tab` to the active worker.

Fix:

- Pass `handleTabCommand` through the command target runtime.
- Add test coverage so `/tab` is handled before prompt fallback.

## Why Worker-Safe `telegram_attach` Exists

This is not required for the current text-first MVP.

It becomes useful when a tab creates a file and the user expects Telegram to
receive it directly:

```text
generate a CSV
render a PNG
write a report and send it back
```

Current MVP behavior: the worker can create the file and mention its path.

Why not load normal `telegram_attach` in workers:

- Normal `telegram_attach` belongs to the parent `pi-telegram` turn context.
- Loading full `pi-telegram` inside a worker risks a second poller, lock
  contention, duplicate bot command registration, and recursive Telegram bridge
  behavior.

Safe future design:

```text
worker tab
  writes ~/.pi/agent/telegram-rpc-spool/<tab>/<id>.json

parent pi-telegram
  reads spool
  validates path/size
  sends file through the existing Telegram Bot API path
```

The worker-side extension should only expose a small `telegram_attach(path)`
tool that writes a spool request. It must not poll Telegram or own Bot API
delivery.

## Next Work

Recommended order:

1. Observe MVP in real use for a day or two.
   - Watch for orphan child processes, confusing tab status, and reply routing
     surprises.
   - Useful checks:
     ```bash
     ps -eo pid,ppid,args | grep 'pi --mode rpc'
     cat ~/.pi/agent/telegram-tabs.json
     ```

2. Add tab UX polish.
   - `/tab mute <name>`
   - `/tab watch <name>`
   - `/tab delete <name>` as a separate destructive action from `close`
   - optional inline keyboard tab switcher

3. Optional active tab rendering polish.
   - Current active tabs stream answer text plus thinking/tool-call previews
     and send final Markdown through the parent bridge.
   - Future work can reuse more of the original single-session renderer for
     richer progress/status blocks, but the core visibility gap is closed.

4. Add child-safe `/tree` navigation and branch mutation if tab-side rewind is
   needed.
   - Current `/tree` for worker tabs is intentionally read-only.
   - Rewind, branch switch, rename, and soft delete still require parent-side
     `ctx.sessionManager` today and must not target worker session files through
     the parent tmux injector.

5. Add worker-safe attachment spool only if real use shows file delivery is
   important.
   - This is phase 2/3, not an urgent fix.

6. Add advanced per-tab session controls later.
   - specified-tab model controls, if `/llm` active-tab semantics are not enough
   - `/tab thinking`
   - `/tab compact`
   - `/tab tree`
   - `/tab resume`

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
