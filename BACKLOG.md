# Project Backlog

## Open Work

- [ ] Explore a Phase 6+ topic/workspace internal rename after forum-native UX stays stable.
  - Priority: Low.
  - Idea: De-tab internal names gradually without breaking non-native/manual tab compatibility: `TelegramTabRecord -> TelegramTopicRecord / WorkspaceRecord`, `tab-manager -> topic-runtime-manager`, `RuntimeTab -> TopicRuntime / WorkspaceRuntime`, plus the later internal `default -> general` migration.
  - Exit: Design note and staged migration plan cover persisted state compatibility, tests, docs, and rollback before any broad rename lands.
- [ ] Polish forum-native topic-worker internals.
  - Priority: Low.
  - Idea: Forum-native mode now treats each topic/workspace as owning one sticky worker after first use. Keep `maxWorkers == maxTabs` for Eddie's config and continue removing legacy tab/capacity naming internally when it clearly helps.
  - Exit: Runtime/tests/docs keep sticky one-to-one semantics as the forum-native product plan; any remaining tab-oriented internals are documented compatibility shims rather than UX concepts.
- [ ] Add topic-bound worker attachment relay if generated-file delivery becomes important.
  - Priority: Low.
  - Idea: With sticky one-to-one topic workers, a small worker-side tool can request attachment delivery from the parent bridge for its owning topic without loading full pi-telegram, polling Telegram, or joining `/start` Extensions.
  - Exit: Worker tabs/topics can send generated files back through their owning Telegram topic while the parent remains the only Bot API/menu/callback owner.
