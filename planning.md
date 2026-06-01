# Telegram Forum-Native Topics Plan

## North Star

Telegram forum topics should be the native workspace/tab model for pi-telegram in a forum supergroup.

User-facing model:

```text
Telegram forum topic = workspace / topic / user-visible tab
General topic        = General workspace
a pi worker          = temporary runtime for a topic
session JSONL        = durable conversation history, independent from topic/workspace lifecycle
```

Implementation model for now:

```text
existing tab-manager / tab records = implementation detail for per-topic runtime isolation
```

Long-term direction:

```text
Stop exposing independent manual tabs in Telegram forum-native mode.
Use Telegram forum topics as the canonical UI and lifecycle.
Gradually retire the user-facing "tab" concept.
```

This means:

```text
Create Telegram topic  -> create/update local topic binding
Switch Telegram topic  -> switch workspace
Close Telegram topic   -> close/remove local binding, optionally delete Telegram topic
Manual /tab lifecycle  -> disabled/legacy in forum-native mode
```

## Current Confirmed Behavior

Already implemented and live smoke-tested:

- Topic-bound records store stable source metadata:

  ```text
  source.kind = telegram-topic
  source.chatId
  source.messageThreadId
  source.topicTitle
  ```

- Topic titles seed the topic-bound session display name when a topic is created or renamed. New/resumed topic worker sessions are named from the current topic title.
- `/tab sync-names` reapplies topic titles to topic-bound session names/workers as a repair/backfill command.

- Routing uses `(chatId, message_thread_id)` for non-General topics.
- Topic title is display metadata and session-name seed only; identity is `chatId + messageThreadId`.
- Topic prompts route to their topic-bound runtime and do not depend on global `/tab activeTab`.
- Worker output, typing, tool previews, and final replies return to the originating topic.
- `forum_topic_created` creates/updates a topic-bound record.
- Unknown topic ordinary messages can lazily create a record when `autoCreate=true`.
- `forum_topic_closed` closes/removes the corresponding non-default topic-bound record.
- With `deleteTopicOnClose=true`, `forum_topic_closed` also calls Telegram Bot API `deleteForumTopic`.
- `trustedChatIds` restricts forum-native routing/lifecycle to Eddie's whitelisted forum chat while preserving private DM behavior.
- From-less forum service messages are accepted only when the chat is trusted.
- Untrusted non-private messages, callback queries, reaction updates, and topic lifecycle events are ignored before they can enqueue work or mutate topic records.
- Live smoke test passed:

  ```text
  create topic -> send test -> Close topic
  result: pi topic-bound record removed, Telegram topic deleted
  ```

Eddie's current local desired/live config:

```json
{
  "concurrentTabs": {
    "enabled": true,
    "maxTabs": 20,
    "maxWorkers": 20,
    "topicBinding": {
      "enabled": true,
      "native": true,
      "generalIsDefault": true,
      "autoCreate": true,
      "closeOnTopicClose": true,
      "deleteTopicOnClose": true,
      "trustedChatIds": [-1003961592045]
    }
  }
}
```

## Verified Telegram/Bot API Facts

Live observations:

- `Close topic` reliably sends `forum_topic_closed` to the bot.
- `Reopen topic` sends `forum_topic_reopened` to the bot.
- Direct Telegram UI `Delete topic` did not produce a usable Bot API update in live testing:

  ```text
  no forum_topic_closed
  no forum_topic_deleted
  no deleted_business_messages
  no later update for that thread
  ```

Therefore:

```text
Close topic  -> reliable lifecycle signal
Delete topic -> not reliable via Bot API alone
```

Design consequence:

- Official lifecycle should be Telegram UI **Close topic**.
- When `deleteTopicOnClose=true`, pi treats Close topic as destructive completion and deletes the Telegram topic itself.
- Manual Telegram UI Delete topic may leave local orphan records; cleanup will be best-effort Level 1 for now.

## Product Decisions

### 1. Forum topic is the workspace

In forum-native mode, users should not think in terms of independent pi tabs.

Preferred language:

```text
topic
workspace
General
session
worker
```

Avoid presenting manual tabs as a separate user concept in Telegram.

### 2. Existing tab machinery remains internal for now

Do not immediately rewrite the whole runtime from tabs to topics. The existing tab machinery already provides:

- isolated worker processes,
- per-runtime session state,
- streaming/final reply delivery,
- model/thinking/session controls,
- persisted record state.

Short-term implementation can keep names like `TelegramTabRecord`, `tab-manager`, and `RuntimeTab` internally while changing Telegram-facing semantics.

Long-term Phase 5+ can rename/refactor internals toward topic/workspace terminology.

### 3. `/tab` lifecycle commands should be disabled in forum-native mode

Disable user-facing manual lifecycle operations that conflict with topic-native semantics:

```text
/tab new
/tab switch
/tab close
/tab rename
```

Reason:

```text
Telegram topic list is the workspace selector.
Telegram Close topic is the lifecycle close operation.
```

`/tab` may temporarily remain as a legacy/read-only dashboard during migration, but it should not be the primary control surface.

Long-term: hide or remove `/tab` from normal Telegram forum-native UX.

### 4. Repair commands may use `/topic`

Although the long-term goal is to avoid multiplying slash commands, repair/orphan operations are conceptually topic operations, not tab operations.

Acceptable future commands:

```text
/topic orphans
/topic cleanup
```

Scope:

- diagnostic/repair only,
- not primary workflow,
- not for creating topics,
- not for switching topics,
- not for normal close lifecycle.

Do **not** add `/topic new` for now. Official creation remains Telegram UI Create topic.

### 5. Close topic is the official close lifecycle

With Eddie's current config:

```json
"deleteTopicOnClose": true
```

The intended lifecycle is:

```text
Telegram UI Close topic
-> Bot receives forum_topic_closed
-> local topic-bound record is closed/removed
-> local session JSONL is preserved
-> bot calls deleteForumTopic
-> Telegram topic is deleted
```

This is intentionally stronger than Telegram's default Close semantics, but it is opt-in and documented by `deleteTopicOnClose=true`.

### 6. Manual Delete topic gets Level 1 cleanup only

Bot API does not provide a reliable topic-deleted update or topic-list API.

For now, implement only Level 1 best-effort cleanup:

```text
If a Bot API operation against a topic fails with a clear topic/thread missing error:
  -> mark/remove local topic-bound record
  -> dispose worker if any
  -> preserve session JSONL
  -> log runtime event
```

Operations that can discover orphans opportunistically:

```text
sendMessage
editMessageText
sendChatAction
deleteForumTopic
attachment/send helpers if they target a topic
```

Be conservative. Do not treat unrelated Telegram errors as orphan proof.

Examples that may indicate missing topic/thread:

```text
message thread not found
topic not found
TOPIC_CLOSED only if the operation expected an open topic and policy says closed means gone
```

Examples that should not automatically orphan a record:

```text
message to be replied not found
message is not modified
message can't be edited
rate limit errors
temporary network errors
```

No MTProto/user-session reconciler for now.

### 7. General should be the display name; internal default can wait

User-facing name should be:

```text
General
```

Short-term implementation:

```text
internal record name: default
user-facing display: General
```

Do not rush internal migration yet. Later migration can map:

```text
default -> general
```

and keep `default` as a legacy alias.

### 8. Topic identity and title handling

Stable identity:

```text
chatId + messageThreadId
```

Topic title:

```text
display metadata and default session display name
```

Rename behavior:

```text
Deploy Debug renamed to Prod Debug
-> same topic-bound record
-> update display title
-> update topic-bound session display name
```

The stable identity remains `chatId + messageThreadId`; title/name sync must not be used as identity.

Duplicate topic titles must be allowed.

### 9. Session and topic are different things

Closing/deleting a topic should not delete the session JSONL.

```text
topic/workspace lifecycle != session history lifecycle
```

A session JSONL is durable history and may later be resumed, branched, archived, or inspected.

### 10. One session should not be attached to multiple open topics

Policy decision: A.

```text
A session can be attached to at most one open topic/workspace at a time.
```

If Topic B tries to resume a session already attached to Topic A:

```text
block the operation
explain which topic owns the session
suggest closing the other topic or branching/cloning later
```

Detection strategy:

1. Canonicalize target `sessionFile`:

   ```text
   resolve(path), optionally realpath when file exists
   ```

2. Scan persisted topic records in `telegram-tabs.json`:

   ```text
   if another open topic record has the same canonical sessionFile -> conflict
   ```

3. Also consider latest live runtime state when available:

   ```text
   backend.getState().sessionFile may be newer than persisted record
   ```

4. Fallback compare `sessionId` when `sessionFile` is unavailable.

5. Add a simple state mutation lock later if concurrent resume operations race.

### 11. Closing a topic while worker is running needs explicit guards

Desired behavior:

```text
forum_topic_closed received
-> mark runtime closing
-> stop typing loop
-> abort/dispose backend
-> persist best-known state if possible
-> remove topic-bound record
-> ignore late worker events
-> deleteForumTopic if configured
-> preserve session JSONL
```

Important guard:

```text
late child events must not send messages into a closed/deleted topic
```

Implementation options:

```text
runtime.closing = true
unregister backend event listener on dispose
ignore events when record no longer exists
use generation token to discard stale events
```

Add regression tests for late stream/final/tool events after close.

### 12. `activeTab` becomes legacy in forum-native mode

In forum-native mode:

```text
current Telegram topic decides runtime
activeTab should not decide prompt routing
activeTab should not be user-visible
activeTab should not be mutated by topic messages
```

`activeTab` may remain only for:

```text
legacy manual tab mode
DM/non-forum fallback
backward compatibility
tests during transition
```

Long-term goal: remove user-facing reliance on activeTab entirely in Telegram forum-native UX.

### 13. Forum topics own sticky workers in native mode

Forum-native mode should use a deliberately simple one-to-one mental model:

```text
one Telegram forum topic = one workspace = one sticky RPC worker = one active session pointer
```

Use Option A for worker startup:

```text
topic create/edit/reopen -> create/update the durable topic record only
first prompt or worker-scoped command in that topic -> spawn that topic's worker
subsequent topic prompts -> reuse the same worker
topic close -> dispose the worker, remove the topic record, preserve the session JSONL
bot reload -> workers are gone; the next prompt lazily starts that topic's worker again
```

Important simplification:

```text
No topic record / worker separation as a product model.
No background capacity lifecycle.
No worker reuse across topics.
No "many records, few workers" UX.
```

Capacity should be intuitive:

```text
maxTabs / maxTopics = maximum open topic/workspace records and therefore maximum sticky workers.
maxWorkers remains a compatibility/internal guard for older configs, but Eddie's forum-native policy is maxWorkers == maxTabs.
```

Dashboard wording should eventually describe worker presence as a topic-owned state such as `worker running`, `worker idle`, `not started after reload`, or `error`.

## Phase Plan

### Phase 0 — Immediate safety: trusted forum chat allowlist

Status: completed, configured, reloaded, and active in Eddie's live runtime.

Problem:

- `forum_topic_closed` and other service messages may be from-less.
- Current code allows from-less forum service messages so close lifecycle works.
- Without chat allowlist, a bot added to another forum group could process from-less service events there.

Decision:

```text
Forum-native / topic-binding lifecycle must be restricted to trusted forum chats.
```

Eddie local intent:

```text
This bot should only respond to the whitelisted forum group(s).
```

Maintainer-friendly design:

```json
{
  "concurrentTabs": {
    "topicBinding": {
      "trustedChatIds": [-1003961592045]
    }
  }
}
```

or equivalent naming such as:

```json
{
  "telegram": {
    "allowedForumChatIds": [-1003961592045]
  }
}
```

Config name chosen for Phase 0:

```text
concurrentTabs.topicBinding.trustedChatIds
```

Implemented behavior:

1. Normal user messages remain subject to existing authorized user checks.
2. When `trustedChatIds` is set, ordinary non-private chat messages outside the trusted forum list are ignored by routing.
3. Private DM behavior is not blocked by `trustedChatIds`.
4. Forum service messages without `from` require trusted chat match before routing to topic lifecycle.
5. Forum service messages with `from` are also gated by trusted chat before topic lifecycle side effects.
6. Callback queries and reaction updates from non-private untrusted chats are ignored.
7. Destructive lifecycle actions require trusted chat match inside tab-manager too, as a defense-in-depth guard:

   ```text
   close local topic record
   deleteForumTopic
   auto-create topic record from service event
   title update from service event
   reopen handling
   ```

8. If chat is not trusted:

   ```text
   ignore lifecycle action
   log debug/runtime event without secrets
   do not delete topic
   do not create local record
   do not enqueue prompt work
   ```

Recommended default for upstream safety:

```text
If trustedChatIds is unset:
  - keep existing non-native behavior as compatible as possible
  - but in forum-native/destructive mode, require explicit trustedChatIds before processing from-less/destructive service lifecycle
```

Policy chosen for Phase 0:

```text
trustedChatIds gates non-private/forum-native chat routing and lifecycle.
Private DM remains available through existing user authorization.
```

This matches Eddie's local requirement that the bot only responds to the whitelisted forum group for forum behavior, while keeping upstream-compatible DM behavior.

Phase 0 tests added/updated:

- `trustedChatIds` config normalizes to a de-duplicated safe integer list.
- from-less `forum_topic_closed` in trusted chat still routes correctly.
- from-less `forum_topic_closed` in untrusted chat is ignored and does not call `deleteForumTopic`.
- `forum_topic_created` in untrusted chat does not create a record.
- ordinary messages in untrusted non-private chats are ignored.
- ordinary private DM messages are not blocked by `trustedChatIds`.
- tab-manager defense-in-depth ignores untrusted service lifecycle even if called directly.

### Phase 1 — Forum-native policy and `/tab` lifecycle disable

Status: implemented in code/tests and configured in Eddie's persisted/live runtime config. Needs `/reload` before the running extension uses the new native-mode guard code.

Goal:

```text
Make forum-native behavior explicit and stop exposing manual /tab lifecycle as normal Telegram UX.
```

#### Config

Implemented explicit policy flag under topic binding:

```json
{
  "concurrentTabs": {
    "topicBinding": {
      "enabled": true,
      "native": true,
      "trustedChatIds": [-1003961592045]
    }
  }
}
```

Normalized default:

```text
native=false
```

Reason:

- Upstream users who only enabled topic binding should not suddenly lose manual `/tab` commands.
- Eddie's local config can opt into `native=true`.
- Later, if forum-native becomes the recommended design, docs can recommend `native=true` without making it a breaking default.

#### Semantics of `native=true`

```text
forum topics are the canonical user-facing workspaces
Telegram topic list is the workspace switcher
Telegram Close topic is the workspace close lifecycle
manual /tab lifecycle commands are disabled
/tab may temporarily remain as a read-only diagnostics/dashboard surface
activeTab is legacy/internal and not user-facing
```

#### Commands to disable in native mode

Disable lifecycle/state-changing `/tab` subcommands:

```text
/tab new
/tab switch
/tab close
/tab rename
```

Also disable equivalent callback buttons/actions in the interactive tab dashboard:

```text
new tab button
switch/select tab button if it mutates activeTab
close selected/current tab buttons
rename action if present
```

Allow read-only `/tab` views for now:

```text
/tab
/tab status/list-style dashboard
filter/search if it is read-only
```

If a disabled action is attempted, reply:

```text
Forum-native mode is enabled. Use Telegram topics to create, switch, and close workspaces.
```

Chinese-friendly variant for Eddie local UI:

```text
Forum-native 模式已啟用。請用 Telegram topic 建立、切換、關閉 workspace。
```

#### Dashboard wording

Keep command name `/tab` for compatibility in Phase 1, but change user-facing wording where safe:

```text
Tabs             -> Forum topics / Workspaces
Active tab       -> Current topic / Current workspace
Default tab      -> General (display-only where easy; full migration is Phase 2/7)
Started tab X    -> Started topic workspace X
```

Do not overdo wording changes in this phase if they require risky broad refactors. Prioritize disabling unsafe lifecycle actions.

#### Implemented behavior

1. Config types/normalization now include:

   ```text
   TelegramConcurrentTabTopicBindingConfig.native?: boolean
   TelegramNormalizedConcurrentTabTopicBindingConfig.native: boolean
   default false
   ```

2. Tab-manager has a `isForumNativeMode()` policy helper.

3. In native mode, state-changing `/tab` subcommands are blocked:

   ```text
   /tab new
   /tab switch
   /tab close
   /tab rename
   ```

4. In native mode, `/tab <name>` no longer implicitly switches tabs; it remains a read-only dashboard/filter query.

5. `/tab` dashboard still works in native mode, but its heading changes to `Forum topics` and `Current` instead of `Tabs`/`Active`.

6. Native dashboard hides switch/close controls:

   ```text
   no tab:switch buttons
   no Manage 🗑 button
   no Close button
   ```

7. Old/stale dashboard callback actions for switch/close are blocked with the native-mode guidance message and refresh back to the read-only dashboard.

8. Topic lifecycle behavior is unchanged:

   ```text
   Create topic -> create/update record
   Close topic  -> close/remove record -> deleteForumTopic when configured
   ```

9. Eddie's local persisted/live config has been updated with:

   ```json
   "native": true
   ```

#### Tests for Phase 1

Added/updated tests:

- Config normalization defaults `native=false`.
- Config normalization preserves `native=true`.
- With `native=false`, existing `/tab new/switch/close/rename` behavior remains unchanged.
- With `native=true`, `/tab new` replies with native-mode guidance and does not create a record.
- With `native=true`, `/tab switch` does not mutate `activeTab`.
- With `native=true`, `/tab close` does not close/remove records.
- With `native=true`, `/tab rename` does not mutate record names.
- With `native=true`, `/tab <name>` filters instead of switching.
- `/tab` dashboard/read-only view still works in native mode.
- Dashboard callback close/switch actions are blocked or hidden in native mode.
- Topic service lifecycle still works in native mode.

#### Validation result

```text
targeted tests: 61 pass
npm run typecheck: pass
full npm test: 693 pass
npm run pack:check: pass
git diff --check: pass
```

#### Phase 1 non-goals

Do not implement yet:

- `/topic cleanup`
- `/topic orphans`
- `/topic new`
- internal `default -> general` migration
- complete internal tab-to-topic rename
- sticky one-to-one topic worker policy polish
- session single-owner enforcement
- late worker event guard

Those are later phases.

### Phase 2 — General UX and thread normalization

Status: implemented in code/tests/docs and loaded in the live runtime after `/reload`.

Implemented behavior:

- Legacy internal `default` remains unchanged in persisted/runtime state.
- User-facing formatters and dashboard controls display `default` as:

  ```text
  General
  ```

- Central thread normalization helper added in `lib/thread-context.ts`:

  ```text
  normalizeTelegramForumThread(message)
  normalizeForumThread(message)
  -> { kind: "general" }
  -> { kind: "topic", messageThreadId }
  ```

- Initial normalization behavior:

  ```text
  missing/undefined message_thread_id -> General
  number -> non-General topic
  ```

- Helper leaves room for a future known `generalThreadId`:

  ```text
  normalizeTelegramForumThread(message, { generalThreadId })
  ```

- Thread normalization is now used by ambient update scope, prompt-turn building, command targets, button callbacks, media/text grouping keys, debug metadata, and topic service lifecycle.

- Docs updated in `README.md` and `docs/architecture.md`.

Validation result:

```text
npm run typecheck: pass
node --experimental-strip-types --test tests/thread-context.test.ts tests/tabs.test.ts tests/tab-manager.test.ts tests/updates.test.ts tests/turns.test.ts tests/commands.test.ts tests/media.test.ts tests/text-groups.test.ts: pass, 145 pass
full npm test: pass, 694 pass
npm run pack:check: pass
git diff --check: pass
```

### Phase 3 — Session ownership and close-running-worker correctness

Status: implemented in code/tests and loaded in the live runtime after `/reload`.

Implemented behavior:

- One session can be attached to only one open workspace at a time.
- Session conflicts are detected by canonical `sessionFile`:

  ```text
  resolve(path), then realpath when the file exists
  ```

- `sessionId` is used as a fallback when both records/states do not have comparable session files.
- Before `/resume` applies a worker session switch, the tab-manager refreshes other live worker states and blocks if another open workspace already owns that session.
- Before prompt dispatch into a topic/workspace, the tab-manager refreshes the selected worker and checks other live workers so live state conflicts are caught even if persisted records are stale.
- Closing a forum topic now performs a closing dispose path:

  ```text
  mark closing
  stop typing
  clear stream/thinking/tool buffers and pending flush timers
  unregister backend listener
  dispose/abort backend
  remove topic-bound record
  ignore late worker events
  preserve session JSONL
  ```

- The single-owner conflict message tells the user which workspace owns the session and suggests closing that workspace or branching/cloning.

Tests added/covered:

- Cannot resume the same real session file into two open topics, including a symlink/canonical-path case.
- Prompt dispatch is blocked when live worker state shows another open topic already owns the session.
- Closing a running topic stops typing/disposes the worker and ignores late stream/final/tool events.
- Closing/deleting a topic preserves the session JSONL.

Validation result:

```text
npm run typecheck: pass
node --experimental-strip-types --test tests/tab-manager.test.ts: pass, 48 pass
PI_TELEGRAM_DEBUG=0 PI_TELEGRAM_DELIVERY_GLOBAL_MESSAGES_PER_SECOND=0 PI_TELEGRAM_DELIVERY_GROUP_MESSAGES_PER_MINUTE=0 node --experimental-strip-types --test --test-concurrency=1 tests/*.test.ts: pass, 708 pass
live /reload validation: maxTabs 20 persisted after polling, 14 tab records, capacity remaining 6, duplicate open session keys 0
```

Related config persistence fix:

- `telegram.json` persistence now merges runtime-mutated fields such as `lastUpdateId` with the latest on-disk config instead of overwriting unrelated disk edits from stale memory.
- The in-memory config object is updated in place after persist so long-lived polling references do not later rewrite stale values.
- This was live-validated by setting `concurrentTabs.maxTabs` to 20, reloading, waiting for polling persistence, and confirming it stayed 20.

### Phase 3.5 — Topic title → session-name sync

Status: implemented and live-smoke confirmed after `/reload`.

Behavior:

```text
forum_topic_created / forum_topic_edited
-> update source.topicTitle
-> seed/update topic-bound record.sessionName
```

When a topic worker is hot, the title is also applied through RPC:

```text
backend.setSessionName(topicTitle)
```

Session lifecycle hooks:

```text
/new inside topic    -> create fresh session, then name it from current topic title
/resume inside topic -> switch session, then name it from current topic title
worker start         -> if worker session name differs from topic title, sync it
```

Repair/backfill:

```text
/tab sync-names
```

reapplies current topic titles to topic-bound records and live workers. This is
operator/repair UI only, not the primary topic workflow.

Important constraints:

- Title/name sync is one-way for now:

  ```text
  Telegram topic title -> session display name
  ```

- Do not automatically do the reverse yet:

  ```text
  /name -> edit Telegram forum topic title
  ```

  because that needs Bot API `editForumTopic` permission/error handling and may
  be surprising UX.

- Topic identity remains only:

  ```text
  chatId + messageThreadId
  ```

- Duplicate topic titles remain valid; title/name is never identity.
- Manual `/name` can still set a different session display name, but topic
  rename, worker start, `/new`, `/resume`, or `/tab sync-names` can reapply the
  topic title.

Validation for this implementation:

```text
npm run typecheck: pass
node --experimental-strip-types --test tests/tab-manager.test.ts tests/tabs.test.ts: pass
npm test: 691 pass, 0 fail
git diff --check: pass
```

### Phase 4 — Level 1 orphan cleanup and `/topic` repair commands

Status: implemented and live-validated for clear Bot API missing-topic proofs.

Implemented:

- `/topic orphans` hidden diagnostic command lists:
  - proven topic orphans from clear Bot API `message thread not found` / `topic not found` delivery failures,
  - errored topic records currently in `error` state with `lastError`,
  - suspected no-proof topic records with no current worker.
- Bot API send/edit/upload/delete-style outbound calls record orphan proofs when the call has `chat_id + message_thread_id` and fails with a conservative missing-topic message.
- `/topic cleanup` removes only records with recorded missing-topic proofs, disposes any worker, preserves session JSONL, clears the proof, and leaves no-proof suspected records untouched.
- `/topic` is intentionally not in the visible Bot Commands menu and does not create, switch, or close topics.

Live validation after `8a96d38` reload:

```text
OpenClaw Telethon user API created/deleted a temporary topic in the trusted Pi forum.
Bot API missing-topic delivery recorded a proof for topic 8419 with method sendMessage.
/topic orphans showed Proven orphans: 1 for topic 8419.
/topic cleanup replied: Cleaned 1 proven topic orphan. Session files are kept.
telegram-tabs.json no longer contained topic 8419 after cleanup.
The preserved session JSONL still existed on disk.
/topic orphans then showed Proven orphans: 0.
Cold/no-proof deleted test records remained suspected-only and were not removed.
Temporary Telegram test topics were deleted after the smoke test.
```

Remaining possible polish:

- Expand the conservative missing-topic matcher only after more live Bot API evidence.
- Surface proof timestamps/last error detail more compactly if needed.

No MTProto reconciler in this phase.

### Phase 5 — User-facing tab concept retirement

Goal:

```text
Telegram forum-native UX should no longer expose independent tabs.
```

Status: implemented and validated for the bounded forum-native UX cleanup; broad internal refactor intentionally deferred.

Implemented:

- In `topicBinding.native` mode, `/tab` is hidden from the visible Bot Commands menu registered by `/start`.
- In `topicBinding.native` mode, `/start` help omits `/tab` and uses current-topic wording for scoped controls such as `/compact`, `/new`, `/session`, `/abort`, and `/stop`.
- In `topicBinding.native` mode, prompt start/follow-up/busy/failure/empty-prompt/abort replies and inactive-completion notices use topic/workspace wording instead of exposing internal tab names.
- In `topicBinding.native` mode, `/compact`, `/new`, `/clone`, and less-common worker lifecycle errors describe the current topic/workspace session instead of a generic hidden tab-backed session.
- `/tab` remains routable as a hidden operator/debug dashboard; this preserves diagnostics and avoids removing emergency tooling.

Final audit:

- Remaining `Tab` / `/tab` / `default` wording is limited to non-native/manual tab mode, the hidden `/tab` operator/debug dashboard, debug/runtime event names, internal types/filenames, tests, or docs that describe compatibility internals.
- No further broad wording sweep is needed for Phase 5.

Validation after `8a96d38 feat: use topic wording for native completion notices`:

```text
npm run typecheck: pass
PI_TELEGRAM_DEBUG=0 PI_TELEGRAM_DELIVERY_GLOBAL_MESSAGES_PER_SECOND=0 PI_TELEGRAM_DELIVERY_GROUP_MESSAGES_PER_MINUTE=0 node --experimental-strip-types --test tests/commands.test.ts tests/tab-manager.test.ts tests/config.test.ts tests/routing.test.ts tests/invariants.test.ts: pass, 132 pass
git diff --check: pass
live runtime reloaded through 8a96d38 after /reload
```

Deferred to later phases:

```text
TelegramTabRecord -> TelegramTopicRecord / WorkspaceRecord
tab-manager -> topic-runtime-manager
RuntimeTab -> TopicRuntime / WorkspaceRuntime
internal default -> general migration
optional deeper /session, /tree, and /resume wording pass
```

Do not start broad internal refactor yet.

### Phase 6 — Sticky one-to-one topic workers

Status: direction reset by operator decision after live forum-native validation. Forum-native mode now targets a strict one-to-one topic-worker plan.

Goal:

```text
one Telegram forum topic = one workspace = one sticky worker once the topic is used
```

Chosen startup policy: Option A, first prompt spawn.

```text
topic create/edit/reopen -> create/update the durable topic record only
first prompt or worker-scoped command in that topic -> spawn that topic's worker
subsequent prompts in that topic -> reuse the same worker
topic close -> dispose the worker, remove the local topic record, preserve session JSONL, optionally delete the Telegram topic
bot reload -> all workers naturally disappear; next prompt lazily restarts that topic's worker from its session file
```

Explicit non-goals for forum-native mode:

```text
No topic record / worker separation as a product model.
No many-records/few-workers capacity UX.
No background capacity lifecycle.
No worker reuse across topics.
No delivery-lease design; worker-owned-topic identity is enough for future attachment relay.
```

Capacity policy:

```text
maxTabs is the intuitive open topic/workspace cap.
maxWorkers should equal maxTabs in Eddie's forum-native config.
maxWorkers remains only a compatibility/internal guard until runtime/docs are simplified.
If the sticky worker cap is reached, prefer a clear capacity refusal over stopping another open topic's worker.
```

Current implementation notes:

- Workers are still launched with `pi --mode rpc --no-extensions`; this remains the safety boundary that prevents workers from loading pi-telegram and starting competing Bot API pollers or `/start` menus.
- Current code still contains the previous `maxWorkers` capacity guard. Do not build new features around capacity sharing. Future runtime polish should make sticky one-to-one the only forum-native policy.
- Current dashboard capacity wording came from earlier diagnostics. Future UX polish should rename this to topic-owned states such as `worker idle`, `worker running`, `not started after reload`, or `error`.

Validation history kept for reference only:

```text
Earlier worker-cap experiments passed tests and live reload validation when maxWorkers == maxTabs, but the product plan for forum-native mode is now sticky one-to-one topic workers.
```

### Phase 7 — Internal `default -> general` migration

Later migration:

```text
internal default record -> general record
legacy alias default -> general
```

Only after display rename and topic-native routing are stable.

## Security / Safety Rules

- Never expose bot tokens or credential values in logs/docs/tests.
- From-less forum service messages require trusted chat protection before lifecycle side effects.
- Destructive Bot API calls such as `deleteForumTopic` must be scoped to trusted forum chats.
- `deleteTopicOnClose=true` should remain opt-in upstream.
- Missing permissions should warn in General/default, not in the closed topic.
- Bot must have Manage Topics permission for `deleteForumTopic`.
- Direct Telegram UI Delete topic is not a reliable Bot API signal.

## Maintainer / PR Considerations

Eddie local deployment can be single trusted forum group.

For upstream maintainability:

- Do not hard-code a single chat globally.
- Store identity as `chatId + messageThreadId` everywhere.
- Add trusted chat configuration as a list, even if local config has one item.
- Document that polished forum-native UX is intended for one primary trusted operator-controlled forum group first.
- Multi-forum support can be made safe later, but General/default semantics need more design:

  ```text
  Group A / General
  Group B / General
  ```

Possible future multi-forum model:

```text
single trusted forum:
  General -> legacy default/internal general

multiple trusted forums:
  each chat gets its own General record, e.g. tg-<chatHash>-general
```

Do not block Phase 0 on full multi-forum UX. Just keep data model and config shape compatible.

## Open Questions to Carry Forward

These should not block Phase 0.

1. Exact config name/location for trusted forum chat allowlist:

   ```text
   concurrentTabs.topicBinding.trustedChatIds
   vs telegram.allowedForumChatIds
   vs authorization.allowedChatIds
   ```

2. Should forum-native mode ignore all ordinary messages outside trusted forum chats, including owner messages?

   Eddie local preference: likely yes for forum behavior.

   Maintainer-compatible option: gate forum-native topic lifecycle/routing by trusted chats while preserving DM behavior.

3. Should service messages with `from` require both authorized user and trusted chat, or trusted chat alone?

   Safer lifecycle policy: trusted chat required for all forum service lifecycle side effects.

4. What exact Telegram error strings should trigger Level 1 orphan cleanup?

   Need conservative tests.

5. Does General topic always arrive without `message_thread_id` in Eddie's group, or can Telegram use a stable id?

   Add normalization now; verify behavior over time.

6. How should `/tab` be hidden/retired without breaking existing users?

   Defer to Phase 5.

7. Should `lastUpdateId` remain in `telegram.json`?

   Current mitigation implemented and live: config persistence now merges runtime-mutated fields such as `lastUpdateId` with the latest on-disk config, and updates the long-lived in-memory config object in place. This prevented `concurrentTabs.maxTabs` / `maxWorkers` operator edits from being overwritten during polling persistence.

   Eddie preference: avoid adding a new settings file for now. Revisit later only if offset persistence continues to create operational friction.

## Review Checklist

Before implementing each phase, review against these five passes:

1. **Security pass**
   - Are from-less service messages scoped to trusted chats?
   - Can an untrusted chat trigger create/close/delete side effects?
   - Are secrets avoided in logs and docs?

2. **Lifecycle pass**
   - Does Create topic create/update only the intended local record?
   - Does Close topic close/remove local state and optionally delete Telegram topic?
   - Are sessions preserved?
   - Are late worker events ignored after close?

3. **UX pass**
   - Does user-facing wording say topic/workspace/General rather than tab where possible?
   - Are manual tab lifecycle commands disabled in native mode?
   - Are repair commands clearly secondary?

4. **Compatibility pass**
   - Does legacy non-native tab behavior still work when native mode is off?
   - Are config defaults safe for upstream?
   - Is single-forum local usage supported without blocking future multi-forum data identity?

5. **Testability pass**
   - Are each behavior's boundaries covered by unit tests?
   - Are destructive calls mocked/asserted?
   - Are untrusted chat cases tested?
   - Are error/orphan paths conservative and deterministic?

## Validation Baseline

Current known validation from the latest implementation cut:

```bash
node --experimental-strip-types --test tests/updates.test.ts tests/routing.test.ts
npm run typecheck
npm test
npm run pack:check
git diff --check
```

Latest recorded results after Phase 4 live orphan-cleanup validation, Phase 5 final validation, and the Telegram preview fallback fix:

```text
npm run typecheck: pass
PI_TELEGRAM_DEBUG=0 PI_TELEGRAM_DELIVERY_GLOBAL_MESSAGES_PER_SECOND=0 PI_TELEGRAM_DELIVERY_GROUP_MESSAGES_PER_MINUTE=0 node --experimental-strip-types --test tests/commands.test.ts tests/tab-manager.test.ts tests/config.test.ts tests/routing.test.ts tests/invariants.test.ts: pass, 132 pass
PI_TELEGRAM_DEBUG=0 PI_TELEGRAM_DELIVERY_GLOBAL_MESSAGES_PER_SECOND=0 PI_TELEGRAM_DELIVERY_GROUP_MESSAGES_PER_MINUTE=0 node --experimental-strip-types --test tests/replies.test.ts tests/preview.test.ts tests/queue.test.ts tests/api.test.ts tests/tab-manager.test.ts tests/runtime.test.ts: pass, 212 pass
git diff --check: pass
live orphan cleanup smoke: pass; proven topic 8419 removed, session JSONL preserved, no-proof records untouched
live preview ordering smoke after 71d9876 reload: pass; temporary topic 10572 showed Started run -> bash tool preview -> final marker reply, then Close topic removed the local record and Bot API deletion made Telegram return ForumTopicDeleted
```

Previous full-suite result after the earlier Phase 6 worker-capacity implementation:

```text
npm run typecheck: pass
node --experimental-strip-types --test tests/tab-manager.test.ts tests/config.test.ts: pass, 69 pass
PI_TELEGRAM_DEBUG=0 PI_TELEGRAM_DELIVERY_GLOBAL_MESSAGES_PER_SECOND=0 PI_TELEGRAM_DELIVERY_GROUP_MESSAGES_PER_MINUTE=0 node --experimental-strip-types --test --test-concurrency=1 tests/*.test.ts: pass, 710 pass
git diff --check: pass
```

Previous Phase 0 baseline:

```text
targeted tests: 82 pass
npm run typecheck: pass
full npm test: 688 pass
npm run pack:check: pass
git diff --check: pass
```

Deployment note:

```text
Persisted/live config now includes:
- concurrentTabs.enabled: true
- concurrentTabs.maxTabs: 20
- concurrentTabs.maxWorkers: 20
- concurrentTabs.topicBinding.enabled: true
- concurrentTabs.topicBinding.native: true
- concurrentTabs.topicBinding.deleteTopicOnClose: true
- concurrentTabs.topicBinding.trustedChatIds: [-1003961592045]

Live runtime has loaded through commit 71d9876 after /reload.
```
