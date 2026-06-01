# Project Backlog

## Open Work

- [ ] Execute the Phase 7 `tab -> workspace` internal rename migration.
  - Priority: Medium.
  - Idea: The plan is now recorded in `planning.md`: use `workspace` for the durable logical unit, keep `topic` for Telegram forum source/UI scope, and keep `worker` for live RPC children. Rename internals gradually without breaking non-native/manual tab compatibility.
  - Progress: Workspace-named state/helper exports now exist in `lib/tabs.ts`, with legacy tab-named aliases preserved.
  - Exit: Types/helpers, modules/tests, persisted state, commands/callbacks, config, docs, and compatibility shims are migrated according to Phase 7.
- [ ] Polish forum-native topic-worker internals.
  - Priority: Low.
  - Idea: Forum-native mode now treats each topic/workspace as owning one sticky worker after first use. Keep `maxWorkers == maxTabs` for Eddie's config and continue removing legacy tab/capacity naming internally when it clearly helps.
  - Exit: Runtime/tests/docs keep sticky one-to-one semantics as the forum-native product plan; any remaining tab-oriented internals are documented compatibility shims rather than UX concepts.
- [ ] Add topic-bound worker attachment relay if generated-file delivery becomes important.
  - Priority: Low.
  - Idea: With sticky one-to-one topic workers, a small worker-side tool can request attachment delivery from the parent bridge for its owning topic without loading full pi-telegram, polling Telegram, or joining `/start` Extensions.
  - Exit: Worker tabs/topics can send generated files back through their owning Telegram topic while the parent remains the only Bot API/menu/callback owner.
