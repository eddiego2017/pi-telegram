# Project Backlog

## Open Work

- [ ] Smoke-test Telegram forum orphan-proof cleanup in a real forum supergroup.
  - Priority: Medium.
  - Idea: Validate the Bot API error strings produced after a Telegram topic is manually deleted, confirm they create conservative orphan proofs, and verify `/topic cleanup` removes only proven local records while preserving session JSONL.
  - Exit: A deleted topic produces a proven `/topic orphans` row with proof method/error evidence, `/topic cleanup` removes only that proven record, and cold/errored no-proof records remain untouched.
- [ ] Explore a Phase 6+ topic/workspace internal rename after forum-native UX stays stable.
  - Priority: Low.
  - Idea: De-tab internal names gradually without breaking non-native/manual tab compatibility: `TelegramTabRecord -> TelegramTopicRecord / WorkspaceRecord`, `tab-manager -> topic-runtime-manager`, `RuntimeTab -> TopicRuntime / WorkspaceRuntime`, plus the later internal `default -> general` migration.
  - Exit: Design note and staged migration plan cover persisted state compatibility, tests, docs, and rollback before any broad rename lands.
- [ ] Explore always-available outbound Telegram tools for queued artifacts and controls.
  - Priority: Low.
  - Idea: Provide tools such as `telegram_attach_file` and `telegram_attach_button` that can be called outside an active Telegram turn, using the paired chat/session as the delivery target when safe.
  - Exit: Design note defines active-turn versus ambient delivery semantics, safety constraints, failure modes, and whether the current `telegram_attach` contract should stay turn-scoped or gain an ambient companion.
- [ ] Add worker-safe attachment relay for concurrent tabs.
  - Priority: Medium.
  - Idea: Provide a tiny RPC-worker-safe extension that exposes `telegram_attach` without polling Telegram, writes spool requests, and lets the parent bridge deliver files.
  - Exit: Worker tabs can send generated files back through Telegram without loading the full pi-telegram extension.
