# pi-telegram

![pi-telegram screenshot](screenshot.png)

**Telegram runtime adapter for π.**

`pi-telegram` turns a private Telegram DM into a session-local operator console for π. It admits work, preserves context, streams readable replies, keeps busy sessions usable through queues, lets other extensions share one bot, and turns assistant-authored intent into native Telegram artifacts.

This repository is an actively maintained fork of [`badlogic/pi-telegram`](https://github.com/badlogic/pi-telegram). It started from upstream commit [`cb34008`](https://github.com/badlogic/pi-telegram/commit/cb34008460b6c1ca036d92322f69d87f626be0fc) and has since diverged substantially.

## Install

From npm:

```bash
pi install npm:@llblab/pi-telegram
```

From git:

```bash
pi install git:github.com/llblab/pi-telegram
```

## Connect

### 1. Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather)
2. Run `/newbot`
3. Pick a name and username
4. Copy the bot token

### 2. Configure the bot token in π

Start π, then run:

```bash
/telegram-setup
```

Paste your bot token when prompted. If a bot token is already saved in `~/.pi/agent/telegram.json`, the setup prompt shows that stored value by default. Otherwise it prefills from the first configured environment variable in `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_KEY`, `TELEGRAM_TOKEN`, or `TELEGRAM_KEY`. The saved config file is written atomically with private `0600` permissions.

### 3. Connect this π session

```bash
/telegram-connect
```

The adapter is session-local: only one π instance polls Telegram at a time. `/telegram-connect` records polling ownership in `~/.pi/agent/locks.json`; live ownership moves require confirmation, while `/new` and same-`cwd` process restarts resume automatically.

### 4. Pair your Telegram account

1. Open the DM with your bot in Telegram
2. Send `/start`

The first user to message the bot becomes the exclusive owner of the adapter. Messages from other users are ignored.

### Environment-only configuration

Most day-to-day controls live in the Telegram menu or π commands. A few important runtime knobs intentionally stay in environment variables because they affect bootstrap, networking, or transport limits before a menu can help:

- **Bot token bootstrap**: `/telegram-setup` can prefill from `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_KEY`, `TELEGRAM_TOKEN`, or `TELEGRAM_KEY` when no token is already saved.
- **HTTP/HTTPS proxy**: native `fetch` can use `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` when Node's environment proxy mode is enabled. Use `NODE_USE_ENV_PROXY=1` or start Node with `--use-env-proxy`. SOCKS5 is not part of the zero-dependency core. If you need it, run a local HTTP-to-SOCKS bridge or system tunnel and point `HTTP_PROXY` / `HTTPS_PROXY` at the HTTP endpoint.
- **Agent data root / temp location**: `PI_CODING_AGENT_DIR` changes the base agent directory used for `telegram.json`, locks, generated outbound-handler artifacts, and Telegram temp files. When unset, the adapter uses `~/.pi/agent`, so inbound Telegram files land in `~/.pi/agent/tmp/telegram`.
- **Inbound file limit**: `PI_TELEGRAM_INBOUND_FILE_MAX_BYTES` or `TELEGRAM_MAX_FILE_SIZE_BYTES` changes the default 50 MiB Telegram download limit.
- **Outbound attachment limit**: `PI_TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES` or `TELEGRAM_MAX_ATTACHMENT_SIZE_BYTES` changes the default 50 MiB `telegram_attach` delivery limit.
- **Telegram delivery pacing**: `PI_TELEGRAM_DELIVERY_GLOBAL_MESSAGES_PER_SECOND` and `PI_TELEGRAM_DELIVERY_GROUP_MESSAGES_PER_MINUTE` serialize outbound Bot API sends/edits/uploads/deletes to stay under operator-chosen limits. `PI_TELEGRAM_DROP_CHAT_ACTION_WHEN_LIMITED` and `PI_TELEGRAM_DROP_PREVIEWS_WHEN_LIMITED` default on so stale typing actions and stream preview updates are dropped instead of queueing behind flood waits.
- **Structured debug logs**: pi-telegram emits redacted JSON lines to stdout for Loki/Alloy collection by default. Set `PI_TELEGRAM_DEBUG=0` or `telegram.json` `{ "debug": { "enabled": false } }` to disable it. Request/response bodies are included in redacted form by default; tune with `PI_TELEGRAM_DEBUG_BODIES=0|redacted|raw`, `debug.includeBodies`, `PI_TELEGRAM_DEBUG_MAX_BODY_CHARS`, or `debug.maxBodyChars` (default 20000). `includeBodies: "raw"` keeps user payloads as complete as the cap allows but still redacts credentials and bot tokens.

## Use

Once paired, chat with your bot in Telegram. Text, images, files, replies, edits, media groups, and configured handler output are forwarded into π as Telegram-originated turns.

What it feels like:

- Open `/start` and get a Telegram control panel for the running π session: status, prompt templates, model, thinking, settings, and queue.
- Fire off three tasks while π is busy. They become visible queue items instead of terminal noise.
- Open Queue from the menu, inspect waiting work, delete stale prompts, or move important work forward.
- Switch models from Telegram mid-run; the adapter schedules a safe continuation instead of tearing state apart.
- Send a voice note; an inbound handler transcribes it; π answers in the same chat.
- Drop a screenshot and ask, "what is broken here?" The image payload reaches π with the local file context.
- Ask for a generated file; when π calls `telegram_attach`, the artifact returns to Telegram with the next reply.

### Telegram controls

Use these inside the Telegram DM with your bot. The main entrypoint is `/start`: it opens the operator menu and exposes many of the important agent controls that normally live in the CLI, adapted for Telegram.

- **`/start`**: Pair the first Telegram user when needed, register bot commands, and open the inline application menu with command help, prompt-template commands, status rows, model controls, thinking controls, settings, and queue controls. In forum-native mode, the visible command menu and `/start` help omit `/tab` and use topic/current-topic wording for scoped controls.
- **`/compact`**: Start session compaction when the session is idle; Telegram shows the native typing indicator while compaction is running. In forum-native mode, compaction replies describe the current topic/workspace instead of a hidden tab-backed session.
- **`/reload`**: Queue a safe π runtime reload from Telegram. The bridge acknowledges first, then sends an internal `/telegram-reload-runtime` follow-up so `ctx.reload()` runs inside π's command context instead of the Telegram update handler.
- **`/new`**: Start a fresh π session when the session is idle and the Telegram queue is empty. When concurrent tabs are enabled, `/new` targets the active tab/topic worker via RPC `new_session` so the workspace session file advances with the command; otherwise it falls back to the host tmux pane (`pi:0`) where the main π REPL runs. In forum-native mode, `/new` and `/clone` replies describe the current topic/workspace session instead of the hidden worker/tab name.
- **`/resume`**: List previous π sessions for the current working directory with 20 mobile-friendly two-line items per page (`① age · Nmsg` followed by the summary) plus compact page-local numeric buttons. `Nmsg` counts visible user/assistant messages only, not hidden thinking or tool noise. Use `Manage 🗑` inside the same menu to enter multi-select deletion, toggle numeric rows, select the current page, and confirm with an explicit delete button. The current active session is shown but cannot be deleted; deletion uses the `trash` CLI when available and falls back to removing the session file. When concurrent tabs are enabled, `/resume` keeps this same global cwd session list and switches the selected session into the active tab worker through RPC `switch_session`; a session already attached to another open workspace is refused until that workspace is closed or the session is branched/cloned.
- **`/session`**: Open a Telegram-native session center for the current π session: compact name/file/id/message/token/cost/context stats, latest chat preview, direct `📜 Last 5 turns` / `📜 Full replay` buttons, and active-branch chat-history pagination. Replay resends visible user/assistant/custom chat rows from the current branch without an LLM call, hiding thinking/tool noise and adding a small `Replay msg …` header to each bubble. When replayed messages retain local image paths, replay also re-uploads those images to Telegram, including images referenced by Telegram `[attachments]`, file-backed image blocks, or hidden assistant `sendPhoto` tool calls. History rows render as a narrow HTML row table directly in the panel, show how much tool noise is hidden, and do not trigger Telegram link previews. When concurrent tabs are enabled, `/session` follows the active tab and reads that worker's session file, so `Last 5`, `Full replay`, and `History` move with `/tab <name>`.
- **`/tree`**: Open a Telegram-native active-path prompt history. It shows only user/custom prompts from the current branch; pick one, inspect it, then use `↩️ Rewind and replace this prompt`. The `🌿 Branches` button lists inactive branch leaves as compact compare cards: fork point, current-path next prompt, inactive-branch next prompt, distance, and leaf id, so branch position and difference are visible before switching. Branch keyboard buttons show the branch label when one exists, otherwise the short leaf id; branch detail supports `✏️ Rename branch` via a Telegram reply and `🗑 Delete branch` to hide an inactive branch from the Telegram list without rewriting the append-only session file. Rewind/switch is allowed only while π and the Telegram queue are idle. Telegram cannot prefill π's editor, so the bridge sends selected prompt text back for copy/edit/resend when native navigation returns editor text. When concurrent tabs are enabled, `/tree` shows the active tab's worker prompt history; prompt detail offers `🌱 Create branch from this prompt`, which moves the active tab's leaf inside the same session file and restarts the worker on that branch cursor. Worker-tab tree views still keep parent-style in-file rewind/switch, branch rename, and branch delete read-only.
- **`/dump [N]`**: Open a transcript export menu for the current active branch. `/dump` includes all visible User/Agent text; `/dump 20` includes the latest 20 user turns. The dump excludes tools, thinking, system metadata, compact summaries, and Telegram attachment/reply/output blocks, then offers `📄 Send TXT` or a privacy-confirmed secret GitHub Gist with delete support.
- **`/name [new name]`**: Show, set, or clear the current π session display name directly from Telegram. `/name <new name>` appends a session-info entry, `/name` shows the current name plus usage, and `/name --clear` clears it.
- **`/llm [tokens...]`**: List available LLM models (`provider/id`), marking the active model with `🟢`. With tokens, filter by case-insensitive AND substring match on the model id; if exactly one model matches, switch the active model and reply `Model switched to provider/id`. When concurrent tabs are enabled this switches the active tab's child worker; otherwise it switches the parent session. Multiple matches list the filtered subset; no match replies `No models match: <tokens>`.
- **`/tab`**: Manage the opt-in concurrent tab MVP. Enable it in `telegram.json` with `{"concurrentTabs":{"enabled":true,"maxTabs":10,"inactiveNotify":true}}`, then use `/tab` for the inline tab dashboard or text commands such as `/tab new A`, `/tab B`, `/tab rename A Work`, `/tab status`, `/tab abort`, `/tab close` for the active tab, and `/tab close A` for a named tab. The dashboard shows active/running/unread tabs with tab age, topic-owned worker state, message count, session name, and latest message preview instead of model ids; it switches tabs with buttons, keeps confirmed close controls, and includes `Manage 🗑` for multi-select tab close with an explicit confirmation. Each tab runs a separate `pi --mode rpc --no-extensions` worker and keeps its own active session pointer while sessions remain in the normal shared cwd session pool, so a long run in one tab does not block prompts sent to another tab. Switching with `/tab <name>` or a dashboard tab button automatically replays that tab's latest 5 session messages, including thinking blocks, tool calls, tool results, agent replies, and replayable image attachments. The parent bridge owns Telegram delivery and streams active-tab answer text, thinking previews, tool-call previews, final Markdown replies, and native Telegram `typing` chat actions from worker RPC activity. `/llm`, `/model`, `/new`, `/resume`, `/session`, and `/tree` follow the active tab, or the ambient forum-topic tab when topic binding is enabled and the command is invoked inside a topic. In forum-native mode, `/tab` is hidden from the bot command menu and `/start` help; it remains an operator/debug dashboard. Worker tabs still do not have `telegram_attach` yet, so generated files are saved locally and should be referenced by path.
- **`/next`**: Dispatch the next queued turn, aborting π first if needed.
- **`/continue`**: Enqueue a priority `continue` prompt.
- **`/abort`**: Abort the active run without touching the queue. When concurrent tabs are enabled, this targets the active tab worker, or the ambient forum-topic tab when topic binding is enabled.
- **`/stop`**: Abort the active run and clear waiting Telegram queue items. When concurrent tabs are enabled, this targets the active tab worker, or the ambient forum-topic tab when topic binding is enabled, and still clears the Telegram queue.

Hidden compatibility shortcuts: `/help` and `/status` open the main application menu, `/model` opens model controls, `/thinking` opens reasoning controls, `/queue` opens queue controls, `/settings` opens bridge settings, and `/topic orphans` / `/topic cleanup` expose forum-topic repair diagnostics without creating or switching topics. When concurrent tabs are enabled, `/model` opens the active tab's model picker and applies model picks to that tab's child worker while the tab is idle.

Prompt-template commands are discovered from π prompt templates, mapped to Telegram-safe aliases (`fix-tests.md` becomes `/fix_tests`), shown in `/start`, and expanded before queueing.

### π commands

Run these inside π, not Telegram:

- **`/telegram-setup`**: Configure or update the Telegram bot token.
- **`/telegram-connect`**: Start polling Telegram updates in the current π session and acquire the singleton lock.
- **`/telegram-disconnect`**: Stop polling in the current π session and release the singleton lock.
- **`/telegram-status`**: Inspect adapter status, connection, polling, execution, queue, and recent redacted runtime/API failure events.

### Files and artifacts

Send files or images directly to the bot. Inbound downloads are saved under `<agent-dir>/tmp/telegram` and default to a 50 MiB limit. The agent dir is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` overrides it.

If you ask π for a generated file, π can call the `telegram_attach` tool and the adapter sends the file with the next Telegram reply. Outbound attachments also default to a 50 MiB limit. Environment variables for both limits are listed in [Environment-only configuration](#environment-only-configuration).

## Core features

### Operator menu and controls

The inline application menu is the primary operator surface. It exposes status, prompt-template commands, model selection, thinking level selection, settings, queue inspection/mutation, session resume/delete flows, the `/session` session-center/history/replay view, `/tree` session-tree rewind, and `/dump` transcript export: a Telegram-shaped subset of the important handles normally available from the CLI. A typical control loop stays inside Telegram: open `/start`, inspect status, jump into Queue, inspect or replay current session history, export a clean User/Agent transcript, rewind or branch from a previous point, delete stale work, switch model, resume or prune old sessions, return to the main menu, and keep the π session running without touching the terminal.

### Queue runtime

Messages sent while π is busy enter the prompt queue and are processed in order. Control actions and model-switch continuation turns use higher-priority lanes so operational commands can resume before normal prompts.

The menu is the primary way to inspect and mutate the queue. Reactions are an extra shortcut when Telegram delivers `message_reaction` updates for the chat: `👍`, `⚡️`, `❤️`, `🕊`, and `🔥` promote waiting work; `👎`, `👻`, `💔`, `💩`, and `🗑` remove it. The same rules apply to text, voice, files, images, and media groups.

### Concurrent tabs MVP

Concurrent tabs are disabled by default. When `concurrentTabs.enabled` is true, normal Telegram prompts go to the active tab instead of the single-session queue. `/tab` commands stay parent-owned and responsive while workers run; bare `/tab` opens an inline dashboard for switching tabs, topic-owned worker state, tab age/message/name/latest-message summaries, confirmed close controls, and `Manage 🗑` multi-select close. `/tab close` closes the active non-default tab directly, while `/tab close <name>` still closes a named tab. `/tab rename [old-name] <new-name>` renames non-default tabs without discarding their session file, `/llm [tokens...]` plus `/model` switch the active tab's child model when that tab is idle, `/new` and `/resume` mutate the active tab's worker session, and `/session` plus `/tree` read the active tab's worker session/history after `/tab <name>` switches. This active-tab behavior has been smoke-tested in Telegram across isolated tabs. Each tab uses an isolated RPC child launched with `--no-extensions`, preventing a second Telegram poller from starting inside a worker. The parent bridge sends native Telegram `typing` actions for the active running tab and stops them when that tab finishes, is aborted, errors, exits, or is switched away. Inactive tabs collect output quietly and send a compact completion notice; switching back with `/tab <name>` or a dashboard tab button automatically replays the latest 5 session messages, including thinking, tool calls, tool results, agent replies, and replayable image attachments.

Forum topic binding is an additional opt-in layer for Telegram forum supergroups. Enable it with `concurrentTabs.topicBinding.enabled: true`; General/no `message_thread_id` routes to the existing internal `default` tab but is displayed as `General`, while each non-General topic lazily creates a compact `tg-…` tab keyed by chat id plus topic id. In forum-native mode the intended policy is sticky one-to-one topic workers: a topic create/edit/reopen service message records metadata only, the first prompt or worker-scoped command in that topic starts exactly one worker for that topic, subsequent prompts reuse it, and topic close disposes it while preserving the session file. Workers are not reused across topics; keep `maxWorkers` equal to `maxTabs` for this policy until the compatibility knob is retired. Topic-bound prompt output, streaming previews, errors, and `typing` actions are delivered back into that same topic without changing the manual `/tab` active selection; in forum-native mode, ordinary prompt acknowledgements, abort results, failures, inactive-completion notices, `/compact`/`/new`/`/clone` session lifecycle replies, and worker lifecycle errors say topic/workspace instead of exposing internal tab names. Topic create/edit/reopen service messages sync tab metadata, topic titles seed the bound session display name and are applied to new/resumed topic sessions. Topic close marks the runtime closing, stops typing/stream flushes, disposes the worker, removes the bound tab, ignores late child events, and preserves the session file. A session can be attached to only one open topic/workspace at a time; `/resume` canonicalizes the target session path and refuses conflicts with a message naming the owning workspace. In forum-native mode, visible Bot Commands and `/start` help hide `/tab` and describe scoped controls as current-topic operations; `/tab` still routes as a hidden operator/debug dashboard. `/topic orphans` lists proven topic orphans, errored topic records, and suspected topic records with no current worker; `/topic cleanup` removes only records proven orphan by clear Bot API missing-topic failures, preserves session files, and leaves no-proof records untouched. Service messages are swallowed rather than forwarded as prompts. Thread handling is normalized centrally: missing `message_thread_id` means General today, and a future known General thread id can be configured without changing callers. Tab-aware controls such as `/llm`, `/model`, `/new`, `/resume`, `/session`, `/tree`, `/name`, `/compact`, `/abort`, and `/stop` prefer the ambient topic tab; `/tab` itself remains the global/manual dashboard. For native ordinary topic messages in groups, keep using an operator-controlled private forum group where the bot is admin, privacy mode is disabled and the bot was re-added, or messages explicitly address the bot.

### Streaming and Telegram HTML rendering

Closed Markdown blocks stream back as rich Telegram HTML while π is generating. The growing tail stays conservative until the final rendered reply lands. Concurrent-tab stream finalization is verified before suppressing the normal full reply fallback, so if Telegram rejects or races the final preview edit the bridge sends the complete assistant reply as a normal message instead of leaving only a partial preview. Final Telegram-originated text replies include a display-only context-usage footer such as `—\n📊 ctx 25.6K/400K 6.4%` after outbound text handlers run, so translation/redaction handlers only see the assistant answer. Long replies are split below Telegram limits without intentionally breaking HTML structures, links, code blocks, blockquotes, lists, or code fences.

Rendering is phone-aware: tables and lists stay narrow, table padding accounts for emoji graphemes and wide Unicode display width, unsupported link forms degrade safely, and block spacing stays faithful to the original Markdown.

### Media, replies, edits, and split text

Telegram replies to earlier text or caption messages are forwarded as `[reply]` context for normal prompts, while slash commands still parse from the new message text only. Display-only context-usage footers previously added to assistant replies are stripped from quoted reply context before the next prompt is queued. If a Telegram message is edited while still waiting in the queue, the queued turn is updated instead of duplicated. Very long text messages that Telegram appears to split automatically are coalesced through a conservative debounce when the first chunk is near Telegram's text limit.

### Inbound handlers

`telegram.json` can define ordered `inboundHandlers` for Telegram → π preprocessing: text translation, voice transcription, OCR, PDF extraction, or any command-template pipeline. Matching handlers run before the turn enters the queue; failed handlers record diagnostics and fall back safely. Legacy `attachmentHandlers` still work as a deprecated compatibility alias appended after `inboundHandlers`.

A practical voice setup is simple: Telegram `.ogg` arrives, STT runs locally or through your chosen command, stdout is injected as `[outputs]`, and π receives the result as usable prompt context.

```json
{
  "inboundHandlers": [
    {
      "type": "text",
      "template": "/path/to/translate --lang {lang=en} --text \"{text}\""
    },
    {
      "type": "voice",
      "template": [
        "/path/to/stt --file {file} --lang {lang=ru}",
        "/path/to/translate-stdin --lang {lang=en}"
      ]
    },
    {
      "mime": "audio/*",
      "template": [
        "/path/to/stt-fallback --file {file} --lang {lang=ru}",
        "/path/to/translate-stdin --lang {lang=en}"
      ]
    }
  ]
}
```

### Outbound handlers, voice, and buttons

Assistant replies can include hidden outbound blocks. `telegram_voice` and `telegram_button` are not π tools; they are assistant-authored HTML comments that the adapter removes from Telegram text and handles after `agent_end`. Recognized blocks must start at column zero on a top-level line outside fenced code, quotes, and lists.

```md
Full technical answer stays readable as text.

<!-- telegram_voice lang=ru rate=+30%
Text to synthesize as a Telegram voice message.
-->

<!-- telegram_button label="Show risks"
List the main risks first.
-->
```

Outbound `type: "text"` handlers can transform final text/Markdown before Telegram rendering and delivery. Outbound `type: "voice"` handlers can translate, synthesize, and convert hidden `telegram_voice` text into Telegram-native OGG/Opus voice through the same command-template contract used by inbound handlers.

A composed voice pipeline can translate, synthesize, and convert in one pass:

```json
{
  "outboundHandlers": [
    {
      "type": "voice",
      "template": [
        "/path/to/translate-stdin --lang {lang=ru}",
        "/path/to/tts-from-stdin --lang {lang=ru} --rate {rate=+30%} --write-media {mp3}",
        "ffmpeg -y -i {mp3} -c:a libopus -b:a 32k -ar 16000 -ac 1 -vbr on {ogg}"
      ],
      "output": "ogg"
    }
  ]
}
```

The agent writes intent; the adapter owns transport. Text remains readable, voice becomes native Telegram media, and buttons route back as queued prompts.

### Extension interop

Unknown inline-button callbacks are forwarded to π as `[callback] <data>` when they do not belong to pi-telegram, so other extensions can namespace and handle Telegram buttons without polling the bot themselves. Layered extensions that need synchronous update handling can register a runtime interceptor on the shared update registry.

### Extension Sections

Ordinary pi extensions can register structured UI sections that appear in the main Telegram menu and Settings submenu without owning a second poller. Each section gets a narrow typed context with `edit`, `open`, `enqueuePrompt`, `answerCallback`, and `callbackData()` — enough to build interactive Telegram-native surfaces while `pi-telegram` owns transport, callback routing, navigation hierarchy, and diagnostics.

Import from `@llblab/pi-telegram`, call `registerTelegramSection()`, and return a disposer on shutdown. Sections can send interactive messages directly into the chat via `ctx.open()` — confirmation dialogs, approve/deny gates, and multi-step forms live outside the menu hierarchy while callbacks route through the same typed handler. See [`@llblab/pi-telegram-extension-demo`](https://github.com/llblab/pi-telegram-extension-demo) for a working reference and the [Extension Sections Standard](./docs/extension-sections.md) for the full contract.

### Proactive push

`telegram.json` can set `proactivePush: true` to send successful local non-Telegram final replies to the paired Telegram chat when no Telegram turn is active. Local prompt text is not mirrored because the bot does not own terminal user messages. The mode is off by default and can be toggled from settings.

## Docs

- [Project Context](./AGENTS.md): durable engineering conventions and architecture constraints.
- [Open Backlog](./BACKLOG.md): planned work and known follow-ups.
- [Changelog](./CHANGELOG.md): completed delivery history.
- [Documentation Index](./docs/README.md): technical docs hub.
- [Architecture](./docs/architecture.md): runtime and subsystem overview.
- [Inbound Handlers](./docs/inbound-handlers.md): Telegram → π preprocessing.
- [Outbound Handlers](./docs/outbound-handlers.md): final text, voice, and artifact pipelines.
- [Command Templates](./docs/command-templates.md): portable command-template contract.
- [Callback Namespaces](./docs/callback-namespaces.md): callback interop for layered extensions.
- [External Handlers](./docs/external-handlers.md): shared update interception.
- [Extension Sections](./docs/extension-sections.md): Telegram extension sections platform for loading extensions that register UI surfaces.
- [Locks](./docs/locks.md): singleton polling ownership.

## Notes

- The extension intentionally keeps rich visual/TUI configuration minimal for now. For advanced setup, ask an agent to read this README and the docs, then update `~/.pi/agent/telegram.json` for your workflow.
- Replies to Telegram prompts are sent as Telegram replies to the source message when possible; if the source message is unavailable, delivery falls back to a normal message.
- Temporary inbound Telegram files are cleaned up on later session starts.

## Companion Extensions

Third-party extensions that integrate with `pi-telegram`:

- [`pi-telegram-tool-status`](https://github.com/Timur00Kh/pi-telegram-tool-status) — Live-updating service messages that list tools used by the agent. It keeps one message per Telegram prompt and edits it in place as tools execute.

```bash
pi install npm:pi-telegram-tool-status
```

## License

MIT
