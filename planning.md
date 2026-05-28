# Forum Topics as Concurrent Tabs — Feasibility Plan

## Goal

Map Telegram forum topics onto pi-telegram concurrent tabs:

1. Creating or first using a Telegram forum topic creates a tab.
2. Messages inside that topic use the topic-bound tab/session, isolated like `/tab`.
3. Closing the Telegram forum topic closes the tab worker while keeping the session file.
4. The forum General topic maps to the existing `default` tab.

This should feel native in Telegram: Telegram's topic list becomes the tab selector, while pi-telegram's existing RPC worker/tab machinery remains the execution layer.

## Current Baseline

The repository is already close to supporting this.

Existing pieces:

- `lib/tab-manager.ts` owns durable tab state, RPC child workers, `/tab` commands, tab close/switch/restart, worker event delivery, inactive completion notices, `/new`, `/resume`, `/session`, `/tree`, model/thinking selection, and active-tab prompt dispatch.
- `lib/tabs.ts` owns tab record shape, validation, command parsing, state normalization, and status formatting.
- `lib/turns.ts` already captures `messageThreadId` from the first Telegram message into prompt turns.
- `lib/queue.ts` already carries `messageThreadId` on `PendingTelegramTurn` and active-turn state.
- `lib/thread-context.ts` provides an `AsyncLocalStorage` scope for `(chatId, messageThreadId)` and `lib/api.ts` injects `message_thread_id` for outbound API calls when the outbound `chat_id` matches the ambient or active-turn scope.
- `lib/updates.ts` already stamps ambient thread context for messages, edited messages, and callback queries.
- `lib/polling.ts` already asks for `message` updates, so service messages such as forum topic create/close can arrive through the existing update lane if the bot is allowed to receive them.

Main mismatch:

- Concurrent tabs currently route normal prompts to `state.activeTab`.
- Forum-topic semantics need routing by `(chatId, message_thread_id)` rather than the last manually selected tab.

## Product Semantics

### Topic-to-tab mapping

- General topic → `default` tab.
- Any non-General `message_thread_id` → one dedicated tab.
- Topic title is display metadata, not the stable identity.
- Stable identity should be based on chat id and topic id, not topic title, because topic titles can be duplicated, renamed, localized, or contain characters outside current tab-name validation.

Recommended internal identity:

```text
source.kind = "telegram-topic"
source.chatId = -100...
source.messageThreadId = 123
source.topicTitle = "Deploy Debug"
```

Recommended internal tab name:

```text
topic-123
```

However, because authorization is user-based rather than chat-allowlist-based, the same operator can already address the bot from multiple forum supergroups. Use a collision-safe compact variant from day one, while keeping the source object as the real stable identity:

```text
tg-<chat-hash>-<thread-base36>
```

Avoid raw `topic--1001234567890-123` if it risks the current 32-character tab-name limit. The source object should store full `chatId` and `messageThreadId` from day one so we do not paint ourselves into a single-chat corner.

### Lazy creation versus explicit creation

We should support both:

1. Explicit creation: `forum_topic_created` service message creates the tab and records the title.
2. Lazy creation: the first ordinary message seen in an unknown topic creates the tab.

Lazy creation is important because the bot may miss service updates due to previous offsets, downtime, permission gaps, or because a topic already existed before enabling the feature.

Fact check: Telegram documents that bots receive service messages regardless of privacy mode. However, ordinary non-command topic messages in groups are only delivered when the bot is an admin, privacy mode is disabled and the bot was re-added, or the message is otherwise addressed to the bot (command/mention/reply). Lazy creation from ordinary messages is therefore reliable only under those deployment conditions.

### Topic closure

- `forum_topic_closed` should force-close the bound non-default tab.
- Closing a tab should dispose the worker and remove the tab record, but preserve the session JSONL file.
- If a worker is running, topic closure should behave like forced close, not like `/tab close` without `--force`, because Telegram topic close is an external lifecycle event.
- General/default should not be closable through topic events.
- MVP session continuity after close must be explicit: if we remove the tab record, reopening the topic later creates a new tab session even though the old JSONL file remains on disk. If we want reopen to restore the old session, we need a tombstone/closed-mapping design instead of deleting the record.

### Reopen and rename

Telegram has service events for reopen/edit. MVP can be conservative:

- `forum_topic_reopened`: for MVP, if the tab record was removed on close, lazy-create a fresh tab/session on first message; optionally recreate immediately if the event has thread id. Later, a tombstone/closed-mapping design can restore the previous session file.
- `forum_topic_edited`: update display title/session name metadata if present.

Do not block MVP on full rename/reopen support.

## Configuration

Add this as an opt-in layer under concurrent tabs.

Minimal config:

```json
{
  "concurrentTabs": {
    "enabled": true,
    "maxTabs": 10,
    "inactiveNotify": true,
    "topicBinding": {
      "enabled": true,
      "generalIsDefault": true,
      "autoCreate": true,
      "closeOnTopicClose": true
    }
  }
}
```

Type shape:

```ts
export interface TelegramConcurrentTabTopicBindingConfig {
  enabled?: boolean;
  generalIsDefault?: boolean;
  autoCreate?: boolean;
  closeOnTopicClose?: boolean;
}

export interface TelegramConcurrentTabsConfig {
  enabled?: boolean;
  maxTabs?: number;
  inactiveNotify?: boolean;
  workerExtensions?: string[];
  topicBinding?: TelegramConcurrentTabTopicBindingConfig;
}
```

Normalization defaults:

- `topicBinding.enabled`: false
- `generalIsDefault`: true
- `autoCreate`: true
- `closeOnTopicClose`: true

Reason: topic binding changes routing semantics significantly, so it must not turn on merely because concurrent tabs are enabled.

## Data Model Changes

Extend `TelegramTabRecord` in `lib/tabs.ts`:

```ts
export interface TelegramTabSourceTelegramTopic {
  kind: "telegram-topic";
  chatId: number;
  messageThreadId?: number;
  topicTitle?: string;
}

export type TelegramTabSource = TelegramTabSourceTelegramTopic;

export interface TelegramTabRecord {
  name: string;
  // existing fields...
  source?: TelegramTabSource;
}
```

General/default record can either omit `source` or carry:

```ts
source: { kind: "telegram-topic", chatId, messageThreadId: undefined, topicTitle: "General" }
```

Recommendation: keep `default` source optional initially and resolve General by absence of `message_thread_id`; this avoids mutating the default tab record every time a message arrives from a chat.

Do not include `closedAt` in the MVP source if topic close deletes the tab record. If reopen/session continuity becomes a requirement, add a separate tombstone/closed mapping that preserves `source + sessionFile + closedAt` without counting as an open tab.

Add helpers in `lib/tabs.ts`:

```ts
normalizeTelegramTopicTabName(chatId: number, messageThreadId: number): string
findTelegramTabByTopic(tabs, chatId, messageThreadId): TelegramTabRecord | undefined
isTelegramGeneralTopicMessage(message): boolean
```

Be explicit that `messageThreadId === undefined` means General/default. Do not use `0` as a synthetic thread id unless Telegram Bot API proves General sends a stable id in this project. Some Telegram APIs represent General as no `message_thread_id`; treating undefined as General is safest.

## Update Types Needed

`lib/api.ts` and `lib/updates.ts` message interfaces currently include text/media fields and `message_thread_id`, but not forum service payloads. Add optional fields:

```ts
forum_topic_created?: { name: string; icon_color?: number; icon_custom_emoji_id?: string; is_name_implicit?: true };
forum_topic_edited?: { name?: string; icon_custom_emoji_id?: string };
forum_topic_closed?: Record<string, never>;
forum_topic_reopened?: Record<string, never>;
general_forum_topic_hidden?: Record<string, never>;
general_forum_topic_unhidden?: Record<string, never>;
```

Only `forum_topic_created` and `forum_topic_closed` are required for MVP.

Important routing detail:

- Service messages often have `from`, so current `getAuthorizedTelegramMessage()` should pass them.
- If any service message lacks `from`, current authorization would ignore it. That is acceptable for MVP because lazy creation from the first user message covers missed create events, but close events without `from` would not close the tab. We should verify Bot API behavior in tests or runtime logs before relying on close events.
- If close events lack `from`, we need a separate authorization policy using chat allowlist or previously known paired chat. That is beyond minimal MVP and should be designed separately.
- Known forum service messages should be swallowed and never forwarded as prompts, even when `topicBinding.enabled` is false. If topic binding is disabled, ignore them after logging/debug handling.

## Routing Design

### New tab-manager APIs

Add thread-aware APIs rather than overloading every current active-tab method ad hoc.

Suggested interface additions:

```ts
export interface TelegramTabRouteScope {
  chatId: number;
  messageThreadId?: number;
  topicTitle?: string;
}

resolveRouteScopeTab(scope, ctx): Promise<RuntimeTab | undefined>
handleForumTopicEvent(event, ctx): Promise<boolean>
dispatchPrompt(turn, ctx): Promise<boolean> // internally route by turn.messageThreadId when topic binding enabled
```

Better public surface:

```ts
handleTopicServiceMessage(message, ctx): Promise<boolean>
```

where tab-manager owns create/close/rename policy and routing stays clean in `routing.ts`.

### Prompt dispatch

`TelegramTabPromptTurn` must first grow the thread id that `PendingTelegramTurn` already carries:

```ts
export interface TelegramTabPromptTurn {
  chatId: number;
  messageThreadId?: number;
  replyToMessageId: number;
  content: readonly TelegramTabPromptContent[];
  statusSummary?: string;
}
```

Current flow in `lib/routing.ts`:

1. Build turn via `promptTurnBuilder(messages, [], ctx)`.
2. If concurrent tabs enabled, call `tabManager.dispatchPrompt(turn, ctx)`.
3. `dispatchPrompt` sends to `state.activeTab`.

Change only tab-manager's selection logic:

```ts
const runtime = topicBinding.enabled
  ? await getRuntimeForTurnTopic(tabState, turn, ctx)
  : getRuntime(tabState, tabState.activeTab)
```

`getRuntimeForTurnTopic` behavior:

- If `turn.messageThreadId` is undefined and `generalIsDefault`, return default runtime.
- If `turn.messageThreadId` is a number:
  - find existing source mapping for `(turn.chatId, turn.messageThreadId)`.
  - if missing and `autoCreate`, create a tab record with source metadata and persist.
  - if missing and not auto-create, reply with a short error and return handled.
- Do not update `state.activeTab` merely because a topic received a prompt. Topic routing should not have global side effects.
- Treat the selected topic runtime as delivery-active for its own worker output, independent of global `state.activeTab`.

This is the key semantic shift: when topic binding is enabled, `activeTab` becomes mainly a manual `/tab` dashboard concept, while normal topic prompts use topic scope.

Important implementation detail: current tab-manager streaming/final delivery is gated by checks like `tabState.activeTab === tabName` in helpers such as `streamActiveTabMarkdown()`, `streamActiveTabText()`, `sendActiveTabToolCallMessage()`, and `agent_end` final-reply logic. Topic-bound tabs must bypass or replace this gate, otherwise a topic tab that does not mutate `activeTab` will only produce inactive completion notices instead of the actual answer.

### Commands in topics

Commands are trickier than normal prompts because many command handlers currently ask for the active tab:

- `/llm`
- `/model`
- `/thinking`
- `/new`
- `/resume`
- `/session`
- `/tree`
- `/name`
- `/compact`
- `/abort`
- `/stop`

Desired behavior: when invoked inside a forum topic, these commands target the topic-bound tab, not the global `activeTab`.

Minimum viable approach:

- Extend tab-manager's existing "active" resolver to prefer ambient thread context when topic binding is enabled.
- All existing APIs named `getActive*`, `newActiveSession`, `abortActive`, `selectActiveModel`, etc. can internally do:

```ts
const scoped = getAmbientTelegramThreadContext();
if (topicBinding.enabled && scoped?.chatId !== undefined) {
  return getOrCreateRuntimeForTopic(scoped.chatId, scoped.messageThreadId, ctx);
}
return getRuntime(tabState, tabState.activeTab);
```

This works because `lib/updates.ts` already wraps message/callback handling in `runWithTelegramThreadContext()`. Callback queries from inline menus inside a topic should therefore target the same topic if the callback message carries `message_thread_id`.

Sync getter caveat: several tab-aware APIs are synchronous today (`getActiveSessionReference()`, `getActiveResumeSessionScope()`, `getActiveSessionName()`, and `compactActive()`'s boolean return path). They cannot safely lazy-create a missing topic tab or report async max-tab errors. MVP should either pre-resolve/create the topic runtime in command handlers before these getters are used, or make sync getters resolve only existing scoped tabs and avoid silently falling back to the parent/global session.

Caveat: `/tab` itself should probably remain a global/manual dashboard command. Topic binding can still allow `/tab status`, but using `/tab switch` inside a topic should not change where that topic's normal messages go. Document this distinction.

### Service message handling

Add early handling in `routing.ts` before tree handler and text/media dispatch. It should run for known forum service messages regardless of whether topic binding is enabled, so those service messages are swallowed instead of forwarded to π as empty prompts.

```ts
const handledByTopic = await deps.tabManager?.handleTopicServiceMessage?.(message, ctx);
if (handledByTopic) return;
```

Service handlers:

- `forum_topic_created`: create mapping if not present, without starting the backend worker; maybe send a short confirmation into the topic: `Created tab for topic <name>.`
- `forum_topic_closed`: close mapping if present; maybe no reply because closed topics may reject sends.
- `forum_topic_edited`: update topic title metadata.

Avoid forwarding service messages as prompts.

## Outbound Delivery and Thread Safety

This is the highest-risk implementation area.

Ambient thread context works while processing the inbound message, but tab worker output arrives later from RPC event listeners, outside that original async call chain. Therefore topic-bound tabs must persist delivery thread context on the runtime tab.

Extend `RuntimeTab`:

```ts
activeChatId?: number;
activeMessageThreadId?: number;
activeReplyToMessageId?: number;
```

`dispatchPrompt(turn, ctx)` must set:

```ts
runtime.activeChatId = turn.chatId;
runtime.activeMessageThreadId = turn.messageThreadId;
runtime.activeReplyToMessageId = turn.replyToMessageId;
```

Before wrapping sends, fix the current active-tab delivery gate. Topic-bound worker output should be sent to the topic that started the prompt even when `state.activeTab` points elsewhere. Inactive completion notices are useful for manual `/tab` use, but they are not a substitute for the actual topic reply.

Every tab-manager outbound call triggered by worker events should either:

1. pass `message_thread_id` explicitly through the API abstraction, or
2. wrap delivery with `runWithTelegramThreadContext({ chatId, messageThreadId }, () => send...)`.

Option 2 is less invasive because the existing API runtime already injects thread ids for `sendMessage`, `sendChatAction`, `editMessageText` where applicable, and multipart. Add a small helper in tab-manager:

```ts
function runInTabThreadContext<T>(runtime: RuntimeTab, fn: () => T): T {
  if (runtime.activeChatId === undefined) return fn();
  return runWithTelegramThreadContext(
    { chatId: runtime.activeChatId, messageThreadId: runtime.activeMessageThreadId },
    fn,
  );
}
```

Then use it around:

- streaming markdown send/edit
- final markdown replies
- inactive completion notices
- error replies
- typing actions
- switch replay messages if the switch came from topic context

Typing loop note: `startTabTyping()` currently stops typing for every other runtime via `stopOtherTabTyping(tabName)`. That is reasonable for manual active-tab UX but wrong for concurrent topic tabs. When topic binding is enabled, typing should be scoped by runtime/chat/thread and should not stop unrelated topic workers. The `sendTypingAction` call must also run under the tab thread context.

`editMessageText` does not need `message_thread_id` for an existing message, but wrapping is harmless and keeps send paths safe.

## Queue and Grouping Edge Cases

### Text split coalescing

`lib/text-groups.ts` currently groups by `chat.id + from.id`, not `message_thread_id`. In a forum supergroup, two long split messages from the same user in two topics could collide.

Update key to include thread id:

```ts
return `${message.chat.id}:${message.message_thread_id ?? "general"}:${message.from.id}`;
```

Need to add `message_thread_id?: number` to `TelegramTextGroupMessage`.

### Media group coalescing

Need to inspect `Media.createTelegramMediaGroupController` keying. If it keys only by `media_group_id`, Telegram's media group ids are probably unique enough, but safer keying should include chat id and thread id. Add `message_thread_id?: number` to `TelegramMediaGroupMessage` if needed.

### Queue reactions and edits

Reactions/removals are currently by message id only. In a supergroup, message ids are chat-scoped, and the bridge is one bot/chat stream, so this is likely okay. If future multi-chat support is real, removal should include chat id.

Edited queued turns already carry `messageThreadId` from turn creation; no major change needed.

### Non-tab queued turn delivery

The existing non-tab queue path also needs attention if forum topics should work outside topic-bound tabs. `PendingTelegramTurn` already stores `messageThreadId`, but `agent_end` currently resets active-turn state before final delivery. Final replies, previews, outbound button artifacts, and `telegram_attach` multipart sends should either wrap delivery in `runWithTelegramThreadContext({ chatId: turn.chatId, messageThreadId: turn.messageThreadId })` or pass `message_thread_id` explicitly.

Control items and button prompts should preserve thread scope too:

- `PendingTelegramControlItem` should include `messageThreadId` when built from a topic command.
- `createTelegramButtonPromptTurn()` should copy `query.message.message_thread_id` into the queued prompt.
- Queue dispatch typing should use the queued item's thread id, not only `chatId`.

## Capacity and Limits

Forum topic auto-creation can hit `maxTabs`. Behavior should be explicit:

- If `maxTabs` reached and a new topic receives a prompt, reply in that topic: `Maximum tab count reached. Close another topic/tab first.`
- Do not silently route to default.
- General/default should always be available and should count as one tab, as today.

Topic title changes should not create a new tab.

`forum_topic_created` should create/update the durable tab record only. Do not start a backend worker merely because a topic was created; first prompt/use should start the worker. If `maxTabs` is reached on a create service event, prefer debug log/no-op and report the capacity problem only when the first ordinary prompt arrives in that topic.

## Authorization and Chat Scope

Current authorization is user-id based. This means the owner can talk to the bot from a forum supergroup and pi-telegram will accept messages from that user; other users are denied/ignored.

This is acceptable for a personal bot but has implications:

- Other members in the forum will see bot replies unless the group/topic is private enough.
- The bot does not currently enforce a chat allowlist.
- If the owner posts in multiple forum supergroups, topic tab state can mix all those chats unless tab source includes chat id and naming avoids collisions.
- With privacy mode enabled, the bot still receives service messages, but ordinary non-command topic messages require admin status, privacy-disabled/re-added setup, or direct addressing to the bot. This should be documented as an operational prerequisite for native-feeling topic tabs.

Recommendation for MVP:

- Keep existing user-id authorization.
- Store `chatId` in topic source.
- Document that topic binding is intended for operator-controlled private forum supergroups.
- Consider a later `allowedChatIds` config if this becomes multi-chat production behavior.

## UX Decisions

### Should topic messages switch active tab?

Recommendation: no.

Topic binding should route by topic and leave `state.activeTab` alone. Otherwise concurrent messages in topics would constantly race the global active tab and make `/tab` dashboard state confusing.

### What does `/tab` show?

Keep existing dashboard. Add topic labels later:

```text
🗂 Deploy Debug · topic #123 · running
```

MVP can show internal names like `topic-123` and session/latest preview. That is acceptable but less polished.

### What does `/tab close topic-123` do?

It should close the tab but cannot close the Telegram topic. The reverse mapping is one-way for MVP: Telegram close closes tab; tab close does not modify Telegram forum topics.

### Should creating a topic send confirmation?

Optional. Too much bot noise in topic lists can be annoying. Prefer debug log plus no message, or a very short confirmation only on first ordinary prompt:

```text
Started topic tab Deploy Debug.
```

Existing prompt dispatch already replies `Started tab X.`; that may be enough.

## Implementation Phases

### Phase 0 — Tests/design only

- Write this plan.
- No runtime behavior changes.

### Phase 1 — Data/config foundation

Files:

- `lib/config.ts`
- `lib/tabs.ts`
- `tests/config.test.ts` or existing config suite
- `tests/tabs.test.ts`

Tasks:

- Add `topicBinding` config type and defaults.
- Add tab source types and state normalization preservation.
- Add helper to build/find topic tab records.
- Ensure old `telegram-tabs.json` still loads.

Validation:

```bash
node --experimental-strip-types --test tests/tabs.test.ts tests/config.test.ts
```

### Phase 2 — Thread-aware tab routing for prompts

Files:

- `lib/tab-manager.ts`
- `tests/tab-manager.test.ts`

Tasks:

- Add route-scope helpers.
- Add `messageThreadId?: number` to `TelegramTabPromptTurn`.
- In `dispatchPrompt`, choose topic-bound runtime when topic binding is enabled.
- Lazy-create topic tabs.
- Route General/undefined thread id to default.
- Do not mutate `activeTab` on topic prompt.
- Make topic-bound worker output delivery independent of `state.activeTab`.
- Store `activeMessageThreadId` on runtime.
- Wrap worker event outbound sends and typing actions in thread context.
- Avoid stopping unrelated topic typing loops.

Validation cases:

- Two topic ids dispatch to two different fake backends.
- General dispatch uses default backend.
- Existing active-tab routing remains unchanged when topic binding disabled.
- Max-tab limit returns a clear reply.
- Worker final/stream output sends under the correct `message_thread_id` via a fake thread resolver or captured API body.

### Phase 3 — Topic service messages

Files:

- `lib/api.ts`
- `lib/updates.ts`
- `lib/routing.ts`
- `lib/tab-manager.ts`
- `tests/updates.test.ts`
- `tests/routing.test.ts`
- `tests/tab-manager.test.ts`

Tasks:

- Add forum service payload fields to message interfaces.
- Add `handleTopicServiceMessage()` in tab manager.
- Call service handler before tree/menu/prompt routing.
- Known forum service messages should be ignored/swallowed even when topic binding is disabled.
- `forum_topic_created`: create/update topic tab metadata without starting the backend worker.
- `forum_topic_closed`: force close tab if mapped.
- `forum_topic_edited`: update title metadata if easy.
- Ensure service messages are not forwarded to π as prompts.

Validation cases:

- Create event creates mapping.
- Close event disposes backend and removes mapping.
- Default cannot be closed by service event.
- Unknown close is harmless.

### Phase 4 — Commands target topic scope

Files:

- `lib/tab-manager.ts`
- possibly `lib/routing.ts`
- `tests/routing.test.ts`
- `tests/tab-manager.test.ts`
- model/menu/session/tree tests as needed

Tasks:

- Make active runtime resolution prefer ambient topic scope when topic binding is enabled.
- Handle synchronous tab-aware getters deliberately: pre-resolve/create the scoped runtime before command/menu code calls them, or make them return only existing scoped tabs without parent fallback.
- Ensure `/llm`, `/model`, `/thinking`, `/new`, `/resume`, `/session`, `/tree`, `/name`, `/compact`, `/abort`, `/stop` target the topic tab when invoked from a topic.
- Preserve topic scope in queued control items and outbound button prompt turns.
- Decide and test `/tab` as global/manual management.

Validation cases:

- `/abort` in topic A aborts topic A backend, not topic B or manual active tab.
- `/new` in topic A updates topic A session pointer.
- `/session` in topic A reads topic A session reference.
- Callback from a menu message in topic A keeps targeting topic A through ambient callback thread context.

### Phase 5 — Grouping and edge hardening

Files:

- `lib/text-groups.ts`
- `lib/media.ts`
- associated tests

Tasks:

- Include `message_thread_id` in long-text group key.
- Review media group keying and include thread id if needed.
- Add tests for same user sending split messages in two topics.

### Phase 6 — Docs and changelog

Files:

- `README.md`
- `docs/architecture.md`
- `CHANGELOG.md`
- maybe `BACKLOG.md` if any limitations remain

Tasks:

- Document config and behavior.
- Document General/default mapping.
- Document privacy/user-id authorization caveat and the admin/privacy-disabled requirement for native ordinary topic messages.
- Document limitations: topic close does not delete session, `/tab close` does not close Telegram topic, worker `telegram_attach` still future work.

## Feasibility Assessment

### Technically feasible

Yes. The architecture already has the two hardest primitives:

1. isolated concurrent tab workers, and
2. Telegram topic thread id propagation for outbound replies.

Most work is selection/routing, state metadata, and tests.

### Main risks

1. **Active-tab-gated worker delivery**
   - Existing tab-manager worker output is often sent only when `tabState.activeTab === tabName`.
   - Mitigation: topic-bound runtimes must be delivery-active for their own chat/thread, independent of global `activeTab`.

2. **Async outbound context loss**
   - Worker events happen after the inbound update scope.
   - Mitigation: store `activeMessageThreadId` on `RuntimeTab` and wrap tab-manager sends with `runWithTelegramThreadContext()`.

3. **Command active-tab semantics**
   - Many features call `getActive*` and assume one global active tab.
   - Mitigation: centralize active runtime resolution in tab-manager so commands automatically become topic-scoped when ambient thread context exists.

4. **Telegram service message variability**
   - Create/close service updates may be missed due to offsets/downtime or may have authorization wrinkles if `from` is absent.
   - Mitigation: lazy-create on first ordinary topic message; treat service events as optimization/lifecycle sync.

5. **Long text/media grouping across topics**
   - Existing text group key lacks thread id.
   - Mitigation: include thread id in grouping keys.

6. **UX confusion between `/tab` active tab and topic-bound tabs**
   - Mitigation: document that topic messages route by topic; `/tab` remains a management dashboard/manual fallback.

7. **Privacy and delivery mode in supergroups**
   - Replies are visible in the topic, and ordinary topic messages may not be delivered under default bot privacy mode.
   - Mitigation: document intended use as a private/operator-controlled forum group where the bot is admin or privacy mode is disabled/re-added; later consider chat allowlist.

### Complexity estimate

- Phase 1–2 prompt-only MVP: moderate, likely contained in `config`, `tabs`, `tab-manager`, tests.
- Full command scoping and service lifecycle: medium-high because many menu/session/model paths rely on active-tab assumptions.
- Biggest regression surface: `tab-manager.ts`, `routing.ts`, and menu callback behavior.

## Recommended MVP Cut

Do first:

1. Config + tab source metadata.
2. Lazy topic tab creation on first prompt.
3. Topic prompt routing by `message_thread_id`.
4. General → default.
5. Make topic-bound worker output delivery independent of global `activeTab`.
6. Store/wrap outbound thread context for tab worker replies and typing actions.
7. Text-group key includes thread id.

Defer until after smoke test:

1. `forum_topic_created` confirmation behavior.
2. `forum_topic_edited` title sync.
3. Full `/tab` dashboard polish for topic labels.
4. Chat allowlist.
5. Telegram API calls to create/close topics from `/tab` actions.

Reason: prompt routing plus correct outbound delivery proves the core idea. Service-message lifecycle and UI polish can be added safely once the core routing works in a real Telegram forum.

## OpenClaw Telegram User API Discovery

Runtime discovery on 2026-05-27 found a usable OpenClaw Telethon user-session path for read-only Telegram forum inspection. Keep this section secret-safe: record paths and procedures only, never token/API/session values.

### Secret-safe locations

OpenClaw runs in Kubernetes namespace `openclaw`, pod `openclaw-0`.

Observed paths inside the OpenClaw container:

```text
~/.openclaw/credentials/                              # plural; singular credential was not present
~/.openclaw/credentials/telegram-default-allowFrom.json
~/.openclaw/credentials/telegram-pairing.json
~/.openclaw/openclaw.json                            # Telegram bot tokens live under channels.telegram.accounts.*.botToken
~/.openclaw/telegram/                                # bot-info, command hashes, update offsets, ingress spool
~/.openclaw/skills/telegram-digest/SKILL.md          # Telethon User API app credential reference; do not echo values
~/.openclaw/skills/telegram-digest/sessions/telegram_digest.session
~/.openclaw/workspace/*/skills/telegram-digest/sessions/telegram_digest.session
```

The Telethon scripts are:

```text
~/.openclaw/skills/telegram-digest/scripts/setup_session.py
~/.openclaw/skills/telegram-digest/scripts/fetch_channels.py
~/.openclaw/skills/telegram-digest/scripts/list_topics.py
```

Security rules for this discovery:

- Never print or paste bot tokens, API hash, session strings, phone numbers, or `.session` file contents.
- Prefer redacted key/path scans (`key name`, type, length) over `cat`/full file output.
- `.session` files grant full Telegram account access. Treat them as high-sensitivity credentials.
- Do not copy OpenClaw credentials into pi's canonical `/home/pi/.pi/credentials/` unless explicitly requested.
- Any Telegram side effect through the user account, such as creating a group/topic, adding a bot, or sending messages, needs explicit operator confirmation.

### Verification results

Read-only checks performed:

- The OpenClaw `telegram-digest` Telethon session is authorized.
- That user account can see 2 Telegram forum groups.
- `@eddie_pi_bot` was not present in those 2 forum groups at discovery time, so they were not immediately usable for pi end-to-end topic smoke testing.
- pi's `~/.pi/agent/telegram.json` had `concurrentTabs.enabled: true`, but `concurrentTabs.topicBinding` was not yet configured at discovery time.

### Smoke-test plan using the user session

After the prompt-routing MVP is installed in the running pi extension:

1. Enable topic binding in pi's config:

   ```json
   {
     "concurrentTabs": {
       "enabled": true,
       "maxTabs": 10,
       "inactiveNotify": true,
       "topicBinding": {
         "enabled": true,
         "generalIsDefault": true,
         "autoCreate": true,
         "closeOnTopicClose": true
       }
     }
   }
   ```

2. Ask the operator to reload/restart pi as needed. Do not run `/reload` from the agent harness.
3. Use the OpenClaw Telethon user session to perform only explicitly approved Telegram actions:
   - create or choose an operator-controlled private forum supergroup,
   - add `@eddie_pi_bot`,
   - ensure bot permissions/privacy settings allow ordinary topic messages or address the bot explicitly,
   - create Topic A and Topic B,
   - send test prompts in General, Topic A, and Topic B.
4. Validate:
   - General/no `message_thread_id` routes to `default`,
   - Topic A and Topic B lazily create distinct `tg-...` tabs,
   - output, streaming edits, errors, and typing return to the originating topic,
   - global `/tab` active selection does not change because topic prompts arrive,
   - max-tab exhaustion replies in the originating topic without fallback.

## Open Questions to Verify in Telegram

- Does `forum_topic_closed` include `from` for Bot API polling updates in this bot's configuration?
- Does General topic send no `message_thread_id`, or a stable id such as `1`? Bot API marks the field optional but does not guarantee General is always absent.
- Does callback query `message` include `message_thread_id` for inline keyboards posted inside a topic? Existing tests assume yes, but real Telegram should be smoke-tested.
- Does `sendChatAction` with injected `message_thread_id` show typing in the correct topic consistently?
- Under this bot's actual deployment, are ordinary non-command topic messages delivered? Verify admin/privacy-disabled/re-added behavior.
- What update, if any, is delivered when a Telegram topic is deleted rather than merely closed? Bot API exposes close/reopen/edit service fields but not a `forum_topic_deleted` message field.

## Test Command Baseline

Targeted tests during implementation:

```bash
node --experimental-strip-types --test tests/tabs.test.ts tests/config.test.ts tests/thread-context.test.ts tests/updates.test.ts tests/tab-manager.test.ts tests/routing.test.ts
```

Before finalizing behavior:

```bash
npm test
```
