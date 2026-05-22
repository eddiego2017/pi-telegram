# Concurrent Chat / Multi-Tab Plan for pi-telegram

This plan was originally written for a future implementer, likely Codex, to add concurrent chat support to `pi-telegram` without rewriting pi core. It now also records the MVP that was implemented and smoke-tested on 2026-05-22.

The key design is: **keep pi-telegram as the Telegram-facing parent/supervisor, and run each chat tab as a separate headless `pi --mode rpc` child process.**

This is intentionally different from an in-process multi-`AgentSessionRuntime` design. It uses OS processes for isolation and pi's existing RPC protocol for child communication.

---

## 0. Current implementation status

Status as of 2026-05-22: **MVP implemented and live-tested in the `pi` Kubernetes pod.**

Implemented:

- `lib/tabs.ts`: pure tab state, name validation, command parsing, list/status formatting.
- `lib/rpc-child.ts`: `pi --mode rpc` JSONL child backend, response-id correlation, stderr ring buffer, graceful dispose, text extraction helpers.
- `lib/tab-manager.ts`: durable tab registry, per-tab worker lifecycle, prompt routing, inactive completion notices, parent-owned `/tab` handling, shutdown cleanup.
- `lib/config.ts`: `concurrentTabs` config, including `workerExtensions` for explicitly loading provider-only extensions into workers.
- `lib/commands.ts`: `/tab` as a reserved immediate Telegram command and bot command menu entry.
- `lib/routing.ts`: normal prompts route to the active tab only when concurrent tabs are enabled; `/tab` commands bypass worker prompt routing.
- `index.ts`: composition wiring and session shutdown disposal.
- Tests for config, command routing, tab state, RPC child helpers, and tab manager orchestration.
- Docs updated in `README.md`, `docs/architecture.md`, `BACKLOG.md`, and `CHANGELOG.md`.

Live smoke result:

- `/tab` lists tabs without starting a worker.
- `/tab new A` creates a tab and supports multi-turn conversation.
- `/tab new B` creates an isolated second tab.
- `/tab close B` closes the second tab.
- Restarting the host `pi` process preserves tab state and conversation session files.

Important implementation fix found during smoke testing:

- The command target runtime must pass `handleTabCommand` through to the lower command handler. Without that wiring, `/tab` is parsed as a known command but returns "not handled", then the concurrent prompt fallback sends `/tab` to the active worker. That bug caused the default worker to start and fail with a provider error. This is now covered by tests.

Current live config shape:

```json
{
  "concurrentTabs": {
    "enabled": true,
    "maxTabs": 4,
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

The `workerExtensions` entries are intentionally provider-only. Workers still use `--no-extensions`, so they do not discover or load full `pi-telegram`; they only load the explicit extensions needed to make the configured models available.

---

## 1. Problem statement

Current `pi-telegram` binds one Telegram DM to one running pi session. While the agent is busy, normal Telegram prompts enter a queue. This works, but it means the user cannot start an unrelated second task until the active task is done or aborted.

Target behavior:

```text
/tab
  default (*)

/tab new A
/tab new B

/tab A
幫我研究貓 temu 玩具
# tab A starts long work

/tab B
幫我看 pi-telegram queue design
# tab B starts independently while A is still running

/tab A
# inspect A status/history/output

/tab close A
```

Hard requirements:

1. One Telegram bot / one polling owner only.
2. Multiple independent agent sessions can run concurrently.
3. `/tab` and Telegram operator controls are handled by the parent, not by a worker session.
4. A busy tab must not block another tab from accepting work.
5. Worker children must **not** load full `pi-telegram`, otherwise multiple Telegram pollers / locks / recursive bridges happen.
6. Start with a safe MVP. Do not attempt full `/tree`, `/resume`, `telegram_attach`, and external extension UI parity in the first patch.

---

## 2. Important discovery: RPC mode exists, but default RPC loads extensions

pi has a first-party headless RPC mode:

```bash
pi --mode rpc
```

RPC uses LF-delimited JSON lines over stdin/stdout.

Example command to child stdin:

```json
{"type":"prompt","message":"Hello"}
```

Example events from child stdout:

```json
{"type":"message_update", ...}
{"type":"tool_execution_start", ...}
{"type":"agent_end", ...}
```

However, **do not spawn child workers with only `pi --mode rpc`**.

Local test showed:

```bash
pi --mode rpc --no-session
```

still loaded global extensions and emitted a `telegram` extension status request. Therefore workers would load `@llblab/pi-telegram` again unless prevented.

Correct MVP worker command must include:

```bash
pi --mode rpc --no-extensions ...
```

This is non-negotiable for the MVP.

Implication: child workers will not have general extension-provided tools such as `telegram_attach`. That is acceptable for MVP, but must be documented and later solved with a tiny worker-safe extension.

Important nuance discovered during implementation: custom model providers can also be registered by extensions. If the parent session uses provider extensions, a worker launched with only `--no-extensions` may not know about those providers and can fail before the first prompt. The implemented solution keeps extension discovery disabled but allows an explicit allowlist:

```bash
pi --mode rpc \
  --no-extensions \
  -e /path/to/provider-only-extension.ts \
  --session-dir <tab-session-dir>
```

This preserves the main safety property: workers still do not load full `pi-telegram`, do not poll Telegram, and do not compete for the singleton lock.

---

## 3. Architecture overview

Current reality: `pi-telegram` is a pi extension, not a standalone daemon. The parent is therefore the host pi process running this extension.

Target MVP architecture:

```text
host pi process
  └─ pi-telegram extension
       ├─ Telegram polling / auth / menus / rendering
       ├─ TabManager
       │    ├─ default tab: RpcChildBackend
       │    ├─ tab A:      RpcChildBackend
       │    └─ tab B:      RpcChildBackend
       └─ Child process supervisor
            ├─ pi --mode rpc --no-extensions --session <A.jsonl>
            └─ pi --mode rpc --no-extensions --session <B.jsonl>
```

Implemented worker commands may also include explicit provider-only extensions after `--no-extensions`:

```text
pi --mode rpc --no-extensions -e <provider-extension> --session-dir <tab-dir>
```

Those explicit extensions are configured through `concurrentTabs.workerExtensions`.

The parent remains the only Telegram bridge. Children are pure headless agents.

Message routing:

```text
Telegram update
  ├─ /tab command?       -> parent TabManager handles it immediately
  ├─ parent command?     -> existing pi-telegram command/menu handler
  └─ normal prompt       -> active tab's RpcChildBackend.prompt()

Child stdout event
  ├─ active tab?         -> stream/render to Telegram normally
  └─ inactive tab?       -> either quiet accumulate or send compact status notification
```

---

## 4. Why this design is preferred over in-process SDK tabs

Original in-process idea:

```text
one process
  ├─ pi-telegram
  ├─ tab-router
  ├─ AgentSessionRuntime A
  └─ AgentSessionRuntime B
```

Problems:

- Need to prove multiple `AgentSessionRuntime` instances are safe in one process.
- Extension loading/resource loading/session events may have singleton assumptions.
- `/tab` control-channel semantics become ambiguous.
- One bad session can crash/hang the entire process.

RPC process design:

- Uses pi's existing process integration protocol.
- OS process isolation is real isolation.
- `/tab` always belongs to the parent.
- No pi core changes.
- Worker crashes are recoverable per tab.

Tradeoff: more memory per tab and process lifecycle complexity.

---

## 5. MVP scope

### MVP includes

Commands:

```text
/tab
/tab list
/tab new <name>
/tab <name>
/tab switch <name>
/tab close <name>
/tab status
/tab status <name>
/tab abort
```

Behavior:

- Multiple tabs can run concurrently.
- Active tab receives normal Telegram prompts.
- Each tab owns one child `pi --mode rpc --no-extensions` process.
- Each tab owns one persistent pi session file.
- Streaming text from the active tab is delivered to Telegram.
- Tool status from active tab can be rendered using existing preview/status mechanisms, or initially simplified.
- Inactive tab completion sends a short notification, e.g. `✅ tab A finished`.
- `/tab` commands must work while any child is busy.
- `/stop` and `/abort` initially apply to the active tab only unless explicitly documented otherwise.

### MVP does NOT include

- `telegram_attach` from child workers.
- Full Telegram-native `/tree` parity per tab.
- Full Telegram-native `/resume` parity per tab.
- Complex extension UI relay from child workers.
- Allowing arbitrary child extensions.
- Cross-tab shared context.
- Moving an active running task between tabs.

These can be added later.

---

## 6. Data model

Add a parent-side durable registry. Suggested path:

```text
~/.pi/agent/telegram-tabs.json
```

or inside existing `telegram.json` if that is more consistent with current config ownership. Prefer a separate file if tab state becomes large/noisy.

Suggested shape:

```ts
interface TelegramTabsState {
  version: 1;
  activeTab: string;
  tabs: Record<string, TelegramTabRecord>;
}

interface TelegramTabRecord {
  name: string;
  cwd: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  createdAt: number;
  lastUsedAt: number;
  status: "idle" | "starting" | "running" | "exited" | "error";
  lastError?: string;
  lastAgentStartAt?: number;
  lastAgentEndAt?: number;
  lastAssistantText?: string;
}
```

Runtime-only fields should not be persisted:

```ts
interface RuntimeTab {
  record: TelegramTabRecord;
  backend: RpcChildBackend;
  unreadEvents: number;
  activeTurn?: ...;
}
```

Tab names:

- Start with `default`.
- Accept simple safe names only for MVP: `/^[A-Za-z0-9_-]{1,32}$/`.
- Case-sensitive or case-insensitive must be decided and documented. Recommendation: case-sensitive display, but reject names differing only by case to avoid mobile confusion.

---

## 7. Session file strategy

Do not let two tabs share one session file.

Recommended directory:

```text
~/.pi/agent/telegram-tabs/sessions/<safe-tab-name>/
```

Simplest worker spawn for a new tab:

```bash
pi --mode rpc \
  --no-extensions \
  --session-dir ~/.pi/agent/telegram-tabs/sessions/<tab-name>
```

Then call `get_state` and persist `sessionFile` returned by RPC. For reopening an existing tab, spawn:

```bash
pi --mode rpc \
  --no-extensions \
  --session <persisted-session-file>
```

If `--session <path>` fails because the file is missing, mark the tab as `error` and offer:

```text
/tab recover <name>
/tab close <name>
/tab recreate <name>
```

Implementation note: spawn child with `cwd` equal to the host pi context cwd for that tab. For MVP, all tabs can use the host `ctx.cwd`. Later, `/tab new <name> --cwd <path>` can be considered.

---

## 8. Child process command

Base command for MVP:

```bash
pi --mode rpc --no-extensions --session-dir <dir>
```

Recommended env overrides:

```ts
{
  ...process.env,
  PI_SKIP_VERSION_CHECK: "1",
}
```

Do not pass secrets explicitly. Let child inherit provider API env vars already available to the parent pod/process.

Implemented addition:

```ts
interface TelegramConcurrentTabsConfig {
  enabled?: boolean;
  maxTabs?: number;
  inactiveNotify?: boolean;
  workerExtensions?: string[];
}
```

`workerExtensions` is converted into repeated `--extension <path>` args while keeping `--no-extensions` in place. Use it only for worker-safe provider registration extensions. Do not put `pi-telegram`, Telegram polling extensions, status-stream extensions, or UI-owning extensions in this list.

Optional future hardening:

- Set `PI_CODING_AGENT_DIR` to a worker-specific agent dir that has no global extensions but still has copied settings/models/credentials as needed.
- Or keep normal agent dir and always pass `--no-extensions` plus explicitly loaded worker-safe extensions.

Do not use Node `readline` for RPC stdout parsing if following pi RPC docs strictly. Implement an LF-only JSONL splitter:

- Split only on `\n`.
- Strip trailing `\r`.
- Do not split on Unicode line separators.

---

## 9. Backend abstraction

Avoid hard-wiring child RPC everywhere. Add a narrow backend interface so current single-session behavior can coexist with the new RPC backend.

Suggested interface:

```ts
interface AgentBackend {
  readonly kind: "host" | "rpc-child";
  readonly tabName: string;

  start(): Promise<void>;
  dispose(): Promise<void>;

  prompt(message: string, options?: BackendPromptOptions): Promise<void>;
  steer(message: string, options?: BackendPromptOptions): Promise<void>;
  followUp(message: string, options?: BackendPromptOptions): Promise<void>;
  abort(): Promise<void>;

  getState(): Promise<BackendState>;
  getSessionStats?(): Promise<BackendSessionStats>;
  getMessages?(): Promise<BackendMessages>;

  setModel?(provider: string, modelId: string): Promise<void>;
  setThinkingLevel?(level: string): Promise<void>;
  compact?(customInstructions?: string): Promise<void>;

  onEvent(listener: (event: BackendEvent) => void): Unsubscribe;
}
```

Implement first:

```text
RpcChildBackend
```

Optionally later:

```text
HostPiBackend
```

`HostPiBackend` would wrap current `ExtensionAPI` / `ExtensionContext`. This is useful if maintaining backward compatibility with the original one-session mode.

For MVP, it is acceptable to implement the tab manager as a new path used only when concurrent mode is enabled.

---

## 10. RPC command mapping

Use documented RPC commands:

Prompt:

```json
{"id":"...","type":"prompt","message":"..."}
```

If child is streaming and user sends another prompt to the same active tab, choose one of:

1. reject with `Tab A is busy; use /tab abort or wait`; or
2. queue into child using `streamingBehavior: "followUp"`; or
3. maintain parent-side per-tab queue.

Recommendation for MVP: use child RPC queueing explicitly:

```json
{"type":"prompt","message":"...","streamingBehavior":"followUp"}
```

Abort:

```json
{"type":"abort"}
```

State:

```json
{"type":"get_state"}
```

Stats:

```json
{"type":"get_session_stats"}
```

Model:

```json
{"type":"set_model","provider":"anthropic","modelId":"..."}
```

Thinking:

```json
{"type":"set_thinking_level","level":"high"}
```

Session name:

```json
{"type":"set_session_name","name":"tab A"}
```

---

## 11. Event handling

Important event types from child:

```text
agent_start
agent_end
turn_start
turn_end
message_start
message_update
message_end
tool_execution_start
tool_execution_update
tool_execution_end
queue_update
compaction_start
compaction_end
auto_retry_start
auto_retry_end
extension_error
extension_ui_request
```

MVP handling:

- `message_update` with `text_delta`: append to tab's active output buffer.
- `tool_execution_start/end`: update tab status; active tab can show simplified tool messages.
- `agent_start`: mark tab running.
- `agent_end`: mark tab idle; store last assistant text; notify if inactive.
- `queue_update`: store pending count for `/tab status`.
- `extension_error`: send or log a warning.
- `extension_ui_request`: MVP can respond with a safe default if timeout exists, or send a clear unsupported message. Since children are launched with `--no-extensions`, these should be rare except built-in degraded UI calls if any.

Do not assume every `message_update` is text. Check `assistantMessageEvent.type === "text_delta"`.

---

## 12. Telegram rendering / active vs inactive tab UX

### Active tab

For active tab, reuse as much of existing preview/final rendering as feasible:

- streaming preview while generating
- final rich HTML reply on `agent_end`
- reply to the source Telegram message when possible

If integrating existing preview system is too invasive, MVP can use simpler delivery:

- show `🤖 [tab A] started`
- collect text deltas
- send final text on `agent_end`

But avoid flooding Telegram with every delta as a separate message.

### Inactive tab

Do not stream full inactive output by default. It will be noisy and confusing.

Recommended inactive behavior:

- Accumulate output silently.
- On `agent_end`, send compact notification:

```text
✅ tab A finished. Use /tab A to view latest reply.
```

When switching to an inactive tab, show:

```text
Switched to tab A.
Last reply:
<latest assistant text, maybe truncated>
```

Later UX option:

```text
/tab watch A
/tab mute A
```

---

## 13. Command design

Add Telegram commands under current update routing:

```text
/tab                         list tabs
/tab list                    list tabs
/tab new <name>              create and switch to tab
/tab <name>                  switch to tab
/tab switch <name>           switch to tab
/tab close <name>            close tab, kill child, keep session file by default
/tab status                  status all tabs
/tab status <name>           status one tab
/tab abort                   abort active tab
/tab abort <name>            abort named tab
/tab restart <name>          kill and respawn child for existing session
```

Safety rules:

- Cannot close `default` unless a later explicit design allows it.
- Closing a running tab requires confirmation or first marks a warning:

```text
Tab A is running. Use /tab close A --force
```

- `close` should kill process but keep session file.
- Future `delete` should be separate and destructive.

Command output should stay mobile-friendly. Example:

```text
Tabs:
• default * idle
• A running 2m
• B idle ✅ unread
```

---

## 14. Interaction with existing pi-telegram queue

Existing pi-telegram has a parent-level queue designed for one host session. Concurrent mode should not blindly reuse the global queue for all tabs.

MVP options:

### Option A: parent routes directly to active child

If active child is idle, send prompt. If active child is busy, send with `streamingBehavior: "followUp"` or reject.

This is simplest.

### Option B: per-tab parent queues

Each tab has its own queue. Parent dispatches prompts to each child when that child is ready.

This gives more control but is more work.

Recommendation for MVP: Option A, using RPC child queue support for same-tab follow-ups. Add parent per-tab queue later only if needed.

Important: `/tab` commands must bypass any child queue and execute immediately in parent.

---

## 15. `telegram_attach` problem and future solution

With `--no-extensions`, child workers do not have `telegram_attach`.

MVP consequence:

- Child can create files with `write`/`bash`.
- Child can mention file paths in text.
- It cannot send Telegram attachments directly.

This is acceptable for first MVP, but user-facing docs must say:

```text
Concurrent tab MVP is text-first. Generated files are saved locally and path is shown; direct Telegram attachment delivery from worker tabs comes later.
```

Future solution: worker-safe mini extension.

Why this is needed:

- The existing `telegram_attach` behavior is parent-turn scoped. It depends on the parent `pi-telegram` runtime knowing the active Telegram chat, message, Bot API client, and delivery rules.
- A worker is intentionally launched with `--no-extensions`, so it cannot call parent-owned Telegram tools.
- Loading full `pi-telegram` inside a worker would be unsafe: the worker could start another poller, register bot commands, touch the singleton lock, or recurse back into Telegram handling.
- A worker-safe attach extension keeps the boundary clean. The child only writes an attachment request to disk; the parent remains the only process that sends Telegram messages or files.

Child command later:

```bash
pi --mode rpc \
  --no-extensions \
  -e ~/.pi/agent/extensions/telegram-worker-attach.ts \
  --session <file>
```

Mini extension only registers one tool:

```text
telegram_attach(path)
```

It must not:

- poll Telegram
- register `/telegram-connect`
- touch locks
- read bot token unnecessarily
- own menus

It should write a spool request:

```text
~/.pi/agent/telegram-rpc-spool/<tab>/<id>.json
```

Example:

```json
{
  "type": "attach",
  "tab": "A",
  "path": "/tmp/result.csv",
  "createdAt": 1770000000000
}
```

Parent watches/reads spool and sends file through existing Telegram outbound attachment logic.

This should be phase 2 or 3, not MVP.

---

## 16. Extension UI relay future work

RPC supports `extension_ui_request` / `extension_ui_response` for `select`, `confirm`, `input`, `editor`, `notify`, etc.

MVP can mostly ignore because child runs `--no-extensions`.

Future implementation:

- `confirm` -> Telegram inline buttons Yes/No.
- `select` -> Telegram inline keyboard options.
- `input` / `editor` -> ask user to reply to a prompt message.
- `notify` -> Telegram message or status log.

Need timeout handling. If RPC request includes timeout, parent can rely on child auto-resolving after timeout, but UI should still expire old buttons.

---

## 17. Settings / feature flag

Do not replace current behavior unconditionally.

Add a setting in `telegram.json` or bridge settings menu:

```json
{
  "concurrentTabs": {
    "enabled": false,
    "maxTabs": 4,
    "inactiveNotify": true,
    "workerExtensions": []
  }
}
```

In deployments where models are registered by extensions, explicitly allow only the provider extensions:

```json
{
  "concurrentTabs": {
    "enabled": true,
    "maxTabs": 4,
    "inactiveNotify": true,
    "workerExtensions": [
      "/home/pi/.pi/agent/extensions/cpa-openai-proxy.ts",
      "/home/pi/.pi/agent/extensions/cpa-anthropic-proxy.ts"
    ]
  }
}
```

Recommended rollout:

1. Code lands disabled by default.
2. Enable manually in config or hidden `/settings` menu.
3. Once stable, consider default-on later.

This is important because current pi-telegram is actively used and should not be destabilized.

---

## 18. File/module placement suggestion

Respect the existing flat domain architecture.

Suggested new modules:

```text
lib/tabs.ts              pure tab state, name validation, command parsing helpers
lib/rpc-child.ts         child process RPC client/backend
lib/tab-manager.ts       runtime orchestration of tabs/backends
lib/menu-tabs.ts         optional Telegram inline menu for tabs later
```

Avoid dumping this into `index.ts`.

`index.ts` should only wire:

- config
- Telegram API runtime
- tab manager
- update routing command hook
- lifecycle cleanup

Keep direct pi SDK imports centralized in `lib/pi.ts` as the project currently requires.

---

## 19. Process lifecycle details

`RpcChildBackend` must handle:

- spawn
- ready handshake via `get_state`
- stdin write queue
- stdout JSONL parser
- stderr capture/ring buffer
- exit event
- error event
- timeout on command response id
- graceful dispose

Graceful shutdown sequence:

1. Send `abort` if streaming.
2. Send SIGTERM.
3. Wait e.g. 3 seconds.
4. SIGKILL if still alive.

Parent shutdown hook must dispose all children:

```ts
pi.on("shutdown", async () => tabManager.dispose())
```

If host pi process crashes, children may become orphans. Mitigations:

- Spawn children with enough metadata in env or argv to identify them.
- On next startup, cleanup stale child processes for same cwd/session root if safe.
- At minimum, document manual cleanup and ensure normal shutdown cleans up.

Possible env marker:

```text
PI_TELEGRAM_CHILD=1
PI_TELEGRAM_PARENT_PID=<pid>
PI_TELEGRAM_TAB=<name>
```

A watchdog can exit child if parent pid disappears, but that requires extra wrapper or periodic parent check. Not needed for MVP unless orphaning becomes common.

---

## 20. Testing plan

### Unit tests

Add tests for:

- tab name validation
- `/tab` command parsing
- tab state persistence roundtrip
- JSONL parser with partial chunks and `\r\n`
- command response correlation by id
- child event mapping to backend events

### Integration-ish tests with fake child

Do not require real LLM calls in tests. Use a fake child process script that reads JSONL and emits canned events.

Test:

- create tab
- switch tab
- prompt active tab
- active tab receives prompt
- inactive tab does not receive prompt
- child `agent_end` marks tab idle
- child exit marks tab error

### Manual tests with real `pi --mode rpc --no-extensions --no-session`

1. Spawn child and call `get_state`.
2. Send a tiny prompt with a cheap model if available.
3. Verify stdout events parse.
4. Verify `--no-extensions` prevents pi-telegram status events.
5. Verify two children can run at once.

### Telegram manual tests

1. Enable concurrent tabs.
2. `/tab` shows default.
3. `/tab new A` creates child.
4. Send prompt to A.
5. Before A completes, `/tab new B` and send prompt.
6. A and B complete independently.
7. `/tab A` shows latest output.
8. `/tab abort B` aborts B only.
9. Restart host pi and verify tab registry/session files survive.

---

## 21. Rollback plan

Because feature is behind `concurrentTabs.enabled`, rollback is simple:

```json
{
  "concurrentTabs": {
    "enabled": false
  }
}
```

When disabled:

- `/tab` can reply `Concurrent tabs disabled` or show instructions.
- Existing single-session pi-telegram path continues unchanged.
- No child processes should be spawned.

If a bad deployment leaves children running, kill them by matching argv:

```bash
ps aux | grep 'pi --mode rpc' | grep telegram-tabs
```

Then terminate cautiously.

---

## 22. Acceptance criteria for MVP

Feature is acceptable when:

1. Done: child workers are always spawned with `--no-extensions` or equivalent isolation.
2. Done: no second Telegram poller is started by worker tabs.
3. Done: `/tab new A` and `/tab new B` can create two independent child pi RPC workers.
4. Done: a long-running prompt in A does not prevent prompt dispatch to B.
5. Done: `/tab` commands remain parent-owned and responsive while children run.
6. Covered by design/tests: child crash in A marks A failed and does not kill B or parent Telegram polling.
7. Done: session files are stored per tab under `~/.pi/agent/telegram-tabs/sessions/<tab>/`.
8. Done: host shutdown disposes children through a lifecycle hook.
9. Done: feature is disabled by default and bypasses the tab path unless `concurrentTabs.enabled` is true.
10. Done: documentation states MVP lacks worker `telegram_attach`.
11. Done: provider-only worker extensions can be explicitly loaded without enabling general extension discovery.
12. Done: restart smoke test preserves tab registry and session files.

---

## 23. Recommended implementation phases

### Phase 0: Spike, no Telegram UI

Status: done.

Create `RpcChildBackend` and a small local script/test that:

- spawns `pi --mode rpc --no-extensions --no-session`
- sends `get_state`
- sends a simple prompt
- logs streaming events
- aborts/disposes

Goal: prove backend reliable.

### Phase 1: TabManager without full UI

Status: done.

Implement tab registry + create/switch/status/close in pure code with fake backend tests.

Goal: tab lifecycle reliable without Telegram complexity.

### Phase 2: Telegram `/tab` commands

Status: done.

Wire `/tab` command parsing into update routing. Keep all existing behavior untouched when disabled.

Goal: text-only concurrent tabs work from Telegram.

### Phase 3: Better rendering and inactive notifications

Status: partially done. The MVP sends final text replies and inactive completion notices. Rich streaming preview/tool rendering parity with the original single-session Telegram path is still future work.

Integrate with existing preview/final rendering where feasible.

Goal: active tab feels close to current Telegram streaming UX; inactive tabs notify cleanly.

### Phase 4: worker-safe attachment extension

Add mini extension and spool mechanism for `telegram_attach` from workers.

Goal: generated files from child tabs can be sent back to Telegram.

Status: not started.

### Phase 5: advanced session controls

Add per-tab versions of:

- `/session`
- `/tree`
- `/resume`
- `/name`
- model/thinking menus

Use RPC commands where possible. Avoid tmux injection for child sessions.

Status: not started.

---

## 24. Final guidance to implementer

The architecture is viable and worth building, but keep the first patch conservative.

Most important guardrails:

1. **Never let child workers load full pi-telegram.** Use `--no-extensions` for MVP.
2. **Do not rewrite existing single-session flow first.** Put concurrent mode behind a feature flag.
3. **Do not chase full feature parity in MVP.** Text-only concurrent tabs are already valuable.
4. **Use pi RPC protocol instead of pi SDK internals.** This avoids multi-runtime in-process risk.
5. **Keep parent controls parent-owned.** `/tab` never goes to child.
6. **One Telegram poller only.** Parent remains the only owner of bot token, locks, polling, menus, and transport.

If these rules are followed, this design should be safer and cleaner than an in-process multi-session router.
