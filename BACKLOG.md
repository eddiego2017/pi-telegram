# Project Backlog

## Open Work

- [ ] Smoke-test and polish Telegram forum topic tabs in a real forum supergroup.
  - Priority: Medium.
  - Idea: Validate Bot API service-message shapes, callback `message_thread_id`, General-topic behavior, topic typing actions, and dashboard labels against live Telegram before broadening the UX.
  - Exit: Real Telegram smoke test covers General plus two topics, create/edit/close/reopen lifecycle, command/menu scoping, and documents any operational caveats or config changes.
- [ ] Explore always-available outbound Telegram tools for queued artifacts and controls.
  - Priority: Low.
  - Idea: Provide tools such as `telegram_attach_file` and `telegram_attach_button` that can be called outside an active Telegram turn, using the paired chat/session as the delivery target when safe.
  - Exit: Design note defines active-turn versus ambient delivery semantics, safety constraints, failure modes, and whether the current `telegram_attach` contract should stay turn-scoped or gain an ambient companion.
- [ ] Add worker-safe attachment relay for concurrent tabs.
  - Priority: Medium.
  - Idea: Provide a tiny RPC-worker-safe extension that exposes `telegram_attach` without polling Telegram, writes spool requests, and lets the parent bridge deliver files.
  - Exit: Worker tabs can send generated files back through Telegram without loading the full pi-telegram extension.
