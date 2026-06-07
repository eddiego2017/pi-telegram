# Project Backlog

## Open Work

- [x] Execute the Phase 7 `tab -> workspace` internal rename migration.
  - Priority: Medium.
  - Outcome: Full deletion of the legacy `tab` vocabulary. Types/helpers, runtime modules, persisted state (`telegram-workspaces.json` only, no legacy fallback), commands (`/workspace`), callbacks (`workspace:`), config (`concurrentWorkspaces`/`maxWorkspaces`), env (`PI_TELEGRAM_WORKSPACE`), tests, and docs now use workspace/topic/worker. Legacy `lib/tabs.ts` / `lib/tab-manager.ts` shims and tab-named public APIs were removed.
- [ ] Polish forum-native topic-worker internals.
  - Priority: Low.
  - Idea: Forum-native mode treats each topic/workspace as owning one sticky worker after first use. Keep `maxWorkers == maxWorkspaces` for Eddie's config.
  - Exit: Runtime/tests/docs keep sticky one-to-one semantics as the forum-native product plan.
- [ ] Add topic-bound worker attachment relay if generated-file delivery becomes important.
  - Priority: Low.
  - Idea: With sticky one-to-one topic workers, a small worker-side tool can request attachment delivery from the parent bridge for its owning topic without loading full pi-telegram, polling Telegram, or joining `/start` Extensions.
  - Exit: Worker topics/workspaces can send generated files back through their owning Telegram topic while the parent remains the only Bot API/menu/callback owner.
