/**
 * Regression tests for Telegram command helpers
 * Covers slash-command normalization, bot suffix stripping, arguments, and non-command input
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramAppMenuHtml,
  buildTelegramCommandAction,
  isTelegramReservedCommandName,
  formatTelegramCommandEmojiPrefix,
  createTelegramAppMenuHtmlBuilder,
  createTelegramBotCommandRegistrar,
  createTelegramCommandControlEnqueueAdapter,
  createTelegramCommandControlQueueRuntime,
  createTelegramCommandHandler,
  createTelegramCommandHandlerTargetRuntime,
  createTelegramCommandOrPromptRuntime,
  createTelegramCommandTargetQueueRuntime,
  createTelegramCommandTargetRuntime,
  executeTelegramCommandAction,
  getTelegramCommandExecutionMode,
  getTelegramCommandMessageTarget,
  handleTelegramCompactCommand,
  handleTelegramLlmCommand,
  handleTelegramReloadCommand,
  handleTelegramNewSessionCommand,
  handleTelegramCloneSessionCommand,
  handleTelegramSessionNameCommand,
  handleTelegramModelCommand,
  formatTelegramLlmListReply,
  parseTelegramLlmFilterTokens,
  filterTelegramLlmModels,
  handleTelegramStatusCommand,
  handleTelegramStopCommand,
  parseTelegramCommand,
  registerTelegramBotCommands,
  registerTelegramBridgeCommands,
  TELEGRAM_APP_MENU_INTRO_HTML,
  TELEGRAM_BOT_COMMANDS,
  TELEGRAM_COMMAND_ACTIONS,
  TELEGRAM_COMMAND_EMOJI,
  TELEGRAM_RESERVED_COMMAND_NAMES,
} from "../lib/commands.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../lib/pi.ts";

type RegisteredBridgeCommand = {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

function createCommandRegistrationApiHarness() {
  const commands = new Map<string, RegisteredBridgeCommand>();
  const api = {
    registerCommand: (name: string, definition: RegisteredBridgeCommand) => {
      commands.set(name, definition);
    },
  } as unknown as ExtensionAPI;
  return { api, commands };
}

function getRequiredCommand(
  commands: Map<string, RegisteredBridgeCommand>,
  name: string,
): RegisteredBridgeCommand {
  const command = commands.get(name);
  assert.ok(command, `Expected command ${name}`);
  return command;
}

function createBridgeCommandContext(
  notify: (message: string) => void = () => {},
  confirm: () => Promise<boolean> | boolean = () => false,
  select?: (title: string, items: string[]) => Promise<string | undefined>,
  reload: () => Promise<void> = async () => {},
): ExtensionCommandContext {
  return {
    cwd: "/repo",
    ui: {
      notify,
      confirm,
      select,
      theme: {
        fg: (_color: string, value: string) => value,
      },
    },
    reload,
  } as unknown as ExtensionCommandContext;
}

test("Command helpers expose Telegram bot command definitions", () => {
  assert.deepEqual(TELEGRAM_COMMAND_EMOJI.model, "🤖");
  assert.deepEqual(TELEGRAM_COMMAND_EMOJI.thinking, "🧠");
  assert.deepEqual(TELEGRAM_COMMAND_EMOJI.name, "🏷️");
  assert.deepEqual(TELEGRAM_COMMAND_EMOJI.session, "🧭");
  assert.deepEqual(TELEGRAM_COMMAND_EMOJI.tree, "🌳");
  assert.deepEqual(TELEGRAM_COMMAND_EMOJI.reload, "🔄");
  assert.equal(formatTelegramCommandEmojiPrefix("model"), "🤖 ");
  const expectedBuiltins = [
    {
      command: "start",
      description: "🟢 Open menu / Pair bridge",
    },
    { command: "compact", description: "🗜 Compact current session" },
    { command: "reload", description: "🔄 Reload π runtime" },
    { command: "new", description: "🆕 Start a new session" },
    {
      command: "clone",
      description: "📑 Clone current session at current position",
    },
    { command: "resume", description: "📂 Resume/manage sessions" },
    { command: "session", description: "🧭 Show current session" },
    { command: "tree", description: "🌳 Rewind current session tree" },
    { command: "name", description: "🏷️ Set current session name" },
    { command: "llm", description: "🧬 List available LLM models" },
    {
      command: "next",
      description: "⏩ Force next turn",
    },
    {
      command: "continue",
      description: "▶️ Queue continue prompt",
    },
    {
      command: "abort",
      description: "⏹️ Abort π",
    },
    {
      command: "stop",
      description: "🟥 Abort π & Clear queue",
    },
  ];
  assert.deepEqual(TELEGRAM_BOT_COMMANDS, expectedBuiltins);
});

test("Command helpers register Telegram bot commands through deps", async () => {
  const calls: unknown[] = [];
  await registerTelegramBotCommands({
    setMyCommands: async (commands) => {
      calls.push(commands);
    },
  });
  await createTelegramBotCommandRegistrar({
    setMyCommands: async (commands) => {
      calls.push(commands);
    },
  })();
  assert.deepEqual(calls, [TELEGRAM_BOT_COMMANDS, TELEGRAM_BOT_COMMANDS]);
});

test("Command helpers register pi setup, status, and reload commands", async () => {
  const harness = createCommandRegistrationApiHarness();
  const events: string[] = [];
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => {
      events.push("setup");
    },
    getStatusLines: () => ["bot: @demo", "polling: stopped"],
    reloadConfig: async () => {
      events.push("reload");
    },
    hasBotToken: () => false,
    startPolling: async () => {
      events.push("start");
    },
    stopPolling: async () => {
      events.push("stop");
    },
    updateStatus: () => {
      events.push("update-status");
    },
  });
  const notifications: string[] = [];
  const ctx = createBridgeCommandContext(
    (message) => {
      notifications.push(message);
    },
    undefined,
    undefined,
    async () => {
      events.push("runtime-reload");
    },
  );
  await getRequiredCommand(harness.commands, "telegram-setup").handler("", ctx);
  await getRequiredCommand(harness.commands, "telegram-status").handler(
    "",
    ctx,
  );
  await getRequiredCommand(harness.commands, "telegram-reload-runtime").handler(
    "",
    ctx,
  );
  assert.deepEqual(events, ["setup", "runtime-reload"]);
  assert.deepEqual(notifications, ["bot: @demo\npolling: stopped"]);
});

test("Command helpers register resume exec command and confirms after replacement", async () => {
  const harness = createCommandRegistrationApiHarness();
  const outcomes: unknown[] = [];
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => undefined,
    getStatusLines: () => [],
    reloadConfig: async () => undefined,
    hasBotToken: () => true,
    startPolling: async () => undefined,
    stopPolling: async () => undefined,
    updateStatus: () => undefined,
    notifyResumeOutcome: async (outcome) => {
      outcomes.push(outcome);
    },
  });
  const events: string[] = [];
  const freshCtx = {
    ui: {
      notify: (message: string, level: string) => {
        events.push(`fresh-notify:${level}:${message}`);
      },
    },
  };
  const ctx = {
    ui: {
      notify: (message: string, level?: string) => {
        events.push(`old-notify:${level ?? "info"}:${message}`);
      },
    },
    switchSession: async (
      sessionPath: string,
      options: { withSession?: (ctx: typeof freshCtx) => Promise<void> },
    ) => {
      events.push(`switch:${sessionPath}`);
      await options.withSession?.(freshCtx);
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;

  await getRequiredCommand(harness.commands, "telegram-resume-exec").handler(
    "/sessions/demo.jsonl",
    ctx,
  );

  assert.deepEqual(events, [
    "switch:/sessions/demo.jsonl",
    "fresh-notify:info:Resumed session",
  ]);
  assert.deepEqual(outcomes, [
    { ok: true, sessionPath: "/sessions/demo.jsonl" },
  ]);
});

test("Command helpers register delete-current-session exec and confirms after replacement", async () => {
  const harness = createCommandRegistrationApiHarness();
  const outcomes: unknown[] = [];
  const events: string[] = [];
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => undefined,
    getStatusLines: () => [],
    reloadConfig: async () => undefined,
    hasBotToken: () => true,
    startPolling: async () => undefined,
    stopPolling: async () => undefined,
    updateStatus: () => undefined,
    notifySessionDeleteOutcome: async (outcome) => {
      outcomes.push(outcome);
    },
    deleteSessionFile: async (sessionPath) => {
      events.push(`delete:${sessionPath}`);
    },
  });
  const freshCtx = {
    ui: {
      notify: (message: string, level: string) => {
        events.push(`fresh-notify:${level}:${message}`);
      },
    },
  };
  const ctx = {
    waitForIdle: async () => {
      events.push("wait");
    },
    sessionManager: {
      getSessionFile: () => "/sessions/current.jsonl",
    },
    newSession: async (
      options: {
        parentSession?: string;
        withSession?: (ctx: typeof freshCtx) => Promise<void>;
      },
    ) => {
      events.push(`new:${options.parentSession}`);
      await options.withSession?.(freshCtx);
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;

  await getRequiredCommand(
    harness.commands,
    "telegram-delete-current-session-exec",
  ).handler("/sessions/current.jsonl", ctx);

  assert.deepEqual(events, [
    "wait",
    "new:/sessions/current.jsonl",
    "delete:/sessions/current.jsonl",
    "fresh-notify:info:Deleted previous session",
  ]);
  assert.deepEqual(outcomes, [
    { ok: true, sessionPath: "/sessions/current.jsonl" },
  ]);
});

test("Command helpers register tree exec command and prefill selected prompt", async () => {
  const harness = createCommandRegistrationApiHarness();
  const outcomes: unknown[] = [];
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => undefined,
    getStatusLines: () => [],
    reloadConfig: async () => undefined,
    hasBotToken: () => true,
    startPolling: async () => undefined,
    stopPolling: async () => undefined,
    updateStatus: () => undefined,
    notifyTreeOutcome: async (outcome) => {
      outcomes.push(outcome);
    },
  });
  const events: string[] = [];
  let editorText = "";
  const ctx = {
    sessionManager: {
      getEntry: (entryId: string) => ({
        type: "message",
        id: entryId,
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "[telegram] full prompt body" }],
        },
      }),
    },
    navigateTree: async (entryId: string, options: { summarize?: boolean }) => {
      events.push(`navigate:${entryId}:${options.summarize ?? false}`);
      return { cancelled: false };
    },
    ui: {
      notify: () => undefined,
      getEditorText: () => editorText,
      setEditorText: (text: string) => {
        editorText = text;
        events.push(`editor:${text}`);
      },
    },
  } as unknown as ExtensionCommandContext;
  await getRequiredCommand(harness.commands, "telegram-tree-exec").handler(
    "u1 none",
    ctx,
  );
  assert.deepEqual(events, [
    "navigate:u1:false",
    "editor:[telegram] full prompt body",
  ]);
  assert.equal(editorText, "[telegram] full prompt body");
  assert.deepEqual(outcomes, [
    {
      ok: true,
      entryId: "u1",
      summarize: false,
      editorText: "[telegram] full prompt body",
    },
  ]);
});

test("Command helpers register pi connect and disconnect commands", async () => {
  const harness = createCommandRegistrationApiHarness();
  const events: string[] = [];
  let hasToken = false;
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => {
      events.push("setup");
    },
    getStatusLines: () => [],
    reloadConfig: async () => {
      events.push("reload");
    },
    hasBotToken: () => hasToken,
    startPolling: async () => {
      events.push("start");
    },
    stopPolling: async () => {
      events.push("stop");
    },
    updateStatus: () => {
      events.push("update-status");
    },
  });
  const ctx = createBridgeCommandContext();
  await getRequiredCommand(harness.commands, "telegram-connect").handler(
    "",
    ctx,
  );
  hasToken = true;
  await getRequiredCommand(harness.commands, "telegram-connect").handler(
    "",
    ctx,
  );
  await getRequiredCommand(harness.commands, "telegram-disconnect").handler(
    "",
    ctx,
  );
  assert.deepEqual(events, [
    "reload",
    "setup",
    "reload",
    "start",
    "update-status",
    "stop",
    "update-status",
  ]);
});

test("Command helpers move pi polling ownership after confirmation", async () => {
  const harness = createCommandRegistrationApiHarness();
  const events: string[] = [];
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => undefined,
    getStatusLines: () => [],
    reloadConfig: async () => {
      events.push("reload");
    },
    hasBotToken: () => true,
    startPolling: async (_ctx, options) => {
      events.push(options?.force ? "start-force" : "start");
      return options?.force
        ? { ok: true, message: "connected" }
        : { ok: false, canTakeover: true, message: "active elsewhere" };
    },
    stopPolling: async () => undefined,
    updateStatus: () => {
      events.push("update-status");
    },
  });
  const notifications: string[] = [];
  const ctx = createBridgeCommandContext(
    (message) => {
      notifications.push(message);
    },
    () => {
      events.push("confirm");
      return true;
    },
  );
  await getRequiredCommand(harness.commands, "telegram-connect").handler(
    "",
    ctx,
  );
  assert.deepEqual(events, [
    "reload",
    "start",
    "confirm",
    "start-force",
    "update-status",
  ]);
  assert.deepEqual(notifications, ["connected"]);
});

test("Command helpers parse slash commands with args", () => {
  assert.deepEqual(parseTelegramCommand(" /Model@DemoBot  claude opus "), {
    name: "model",
    args: "claude opus",
  });
  assert.deepEqual(parseTelegramCommand("/status"), {
    name: "status",
    args: "",
  });
});

test("Command helpers ignore non-command input and empty names", () => {
  assert.equal(parseTelegramCommand("hello /status"), undefined);
  assert.equal(parseTelegramCommand("/"), undefined);
});

test("Command helpers resolve message reply targets", () => {
  assert.deepEqual(
    getTelegramCommandMessageTarget({ chat: { id: 1 }, message_id: 2 }),
    { chatId: 1, replyToMessageId: 2 },
  );
});

test("Command control enqueue adapter builds and enqueues control items", async () => {
  const calls: string[] = [];
  const enqueueControlItem = createTelegramCommandControlEnqueueAdapter<string>(
    {
      createControlItem: (options) => ({
        kind: "control",
        queueLane: "control",
        queueOrder: 0,
        laneOrder: 0,
        chatId: options.chatId,
        replyToMessageId: options.replyToMessageId,
        controlType: options.controlType,
        statusSummary: options.statusSummary,
        execute: options.execute,
      }),
      enqueueControlItem: (item, ctx) => {
        calls.push(`${item.controlType}:${item.statusSummary}:${ctx}`);
        void item.execute(ctx);
      },
    },
  );
  enqueueControlItem(
    { chatId: 7, replyToMessageId: 11 },
    "ctx",
    "status",
    "⚡ status",
    async (ctx) => {
      calls.push(`execute:${ctx}`);
    },
  );
  assert.deepEqual(calls, ["status:⚡ status:ctx", "execute:ctx"]);
});

test("Command control queue runtime builds, enqueues, and dispatches control items", async () => {
  const calls: string[] = [];
  const enqueueControlItem = createTelegramCommandControlQueueRuntime<string>({
    createControlItem: (options) => ({
      kind: "control",
      queueLane: "control",
      queueOrder: 0,
      laneOrder: 0,
      chatId: options.chatId,
      replyToMessageId: options.replyToMessageId,
      controlType: options.controlType,
      statusSummary: options.statusSummary,
      execute: options.execute,
    }),
    appendControlItem: (item, ctx) => {
      calls.push(`append:${item.controlType}:${ctx}`);
      void item.execute(ctx);
    },
    dispatchNextQueuedTelegramTurn: (ctx) => {
      calls.push(`dispatch:${ctx}`);
    },
  });
  enqueueControlItem(
    { chatId: 7, replyToMessageId: 11 },
    "ctx",
    "model",
    "⚙ model",
    async (ctx) => {
      calls.push(`execute:${ctx}`);
    },
  );
  assert.deepEqual(calls, ["append:model:ctx", "execute:ctx", "dispatch:ctx"]);
});

test("Command target queue runtime binds control queue and chat targets", async () => {
  const calls: string[] = [];
  const runtime = createTelegramCommandTargetQueueRuntime<
    { chat: { id: number }; message_id: number },
    string
  >({
    createControlItem: (options) => ({
      kind: "control",
      queueLane: "control",
      queueOrder: 0,
      laneOrder: 0,
      chatId: options.chatId,
      replyToMessageId: options.replyToMessageId,
      controlType: options.controlType,
      statusSummary: options.statusSummary,
      execute: options.execute,
    }),
    appendControlItem: (item, ctx) => {
      calls.push(`append:${item.chatId}:${item.replyToMessageId}:${ctx}`);
      void item.execute(ctx);
    },
    dispatchNextQueuedTelegramTurn: (ctx) => {
      calls.push(`dispatch:${ctx}`);
    },
    showStatus: async () => {},
    openModelMenu: async () => {},
    openSessionMenu: async () => {},
    sendTextReply: async () => {},
  });
  runtime.enqueueControlItem(
    { chat: { id: 7 }, message_id: 11 },
    "ctx",
    "status",
    "⚡ status",
    async (ctx) => {
      calls.push(`execute:${ctx}`);
    },
  );
  assert.deepEqual(calls, ["append:7:11:ctx", "execute:ctx", "dispatch:ctx"]);
});

test("Command target runtime binds chat reply targets to command ports", async () => {
  const calls: string[] = [];
  const runtime = createTelegramCommandTargetRuntime<
    { chat: { id: number }; message_id: number },
    string
  >({
    enqueueControlItem: (target, ctx, controlType, statusSummary, execute) => {
      calls.push(
        `enqueue:${target.chatId}:${target.replyToMessageId}:${ctx}:${controlType}:${statusSummary}`,
      );
      void execute(ctx);
    },
    showStatus: async (chatId, replyToMessageId, ctx) => {
      calls.push(`status:${chatId}:${replyToMessageId}:${ctx}`);
    },
    openModelMenu: async (chatId, replyToMessageId, ctx) => {
      calls.push(`model:${chatId}:${replyToMessageId}:${ctx}`);
    },
    openSessionMenu: async (chatId, replyToMessageId, ctx) => {
      calls.push(`session:${chatId}:${replyToMessageId}:${ctx}`);
    },
    sendTextReply: async (chatId, replyToMessageId, text) => {
      calls.push(`reply:${chatId}:${replyToMessageId}:${text}`);
    },
  });
  const message = { chat: { id: 7 }, message_id: 11 };
  runtime.enqueueControlItem(
    message,
    "ctx",
    "status",
    "⚡ status",
    async () => {
      calls.push("execute");
    },
  );
  await runtime.showStatus(message, "ctx");
  await runtime.openModelMenu(message, "ctx");
  await runtime.openSessionMenu(message, "ctx");
  await runtime.sendTextReply(message, "hello");
  assert.deepEqual(calls, [
    "enqueue:7:11:ctx:status:⚡ status",
    "execute",
    "status:7:11:ctx",
    "model:7:11:ctx",
    "session:7:11:ctx",
    "reply:7:11:hello",
  ]);
});

test("Command helpers build command actions", () => {
  assert.deepEqual(buildTelegramCommandAction("stop"), {
    kind: "stop",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("compact"), {
    kind: "compact",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("reload"), {
    kind: "reload",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("status"), {
    kind: "status",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("model"), {
    kind: "model",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("continue"), {
    kind: "continue",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("help"), {
    kind: "help",
    commandName: "help",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("start"), {
    kind: "help",
    commandName: "start",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("name", "work label"), {
    kind: "name",
    args: "work label",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("session"), {
    kind: "session",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("resume", "apple cat"), {
    kind: "resume",
    args: "apple cat",
    executionMode: "immediate",
  });
  assert.deepEqual(Object.keys(TELEGRAM_COMMAND_ACTIONS), [
    ...TELEGRAM_RESERVED_COMMAND_NAMES,
  ]);
  assert.equal(isTelegramReservedCommandName("start"), true);
  assert.equal(isTelegramReservedCommandName("unknown"), false);
  assert.deepEqual(buildTelegramCommandAction("unknown"), {
    kind: "ignore",
    executionMode: "ignored",
  });
  assert.deepEqual(buildTelegramCommandAction(undefined), {
    kind: "ignore",
    executionMode: "ignored",
  });
});

test("Command execution mode contract keeps Telegram controls immediate", () => {
  const cases: Array<[string | undefined, string]> = [
    ["stop", "immediate"],
    ["compact", "immediate"],
    ["reload", "immediate"],
    ["help", "immediate"],
    ["start", "immediate"],
    ["continue", "immediate"],
    ["status", "immediate"],
    ["model", "immediate"],
    ["name", "immediate"],
    ["session", "immediate"],
    ["unknown", "ignored"],
    [undefined, "ignored"],
  ];
  assert.deepEqual(
    cases.map(([commandName, _mode]) => [
      commandName,
      getTelegramCommandExecutionMode(buildTelegramCommandAction(commandName)),
    ]),
    cases,
  );
});

test("Command helpers run stop command side effects", async () => {
  const events: string[] = [];
  await handleTelegramStopCommand({
    hasAbortHandler: () => false,
    clearPendingModelSwitch: () => {
      events.push("clear");
    },
    clearQueuedTelegramItems: () => {
      events.push("clear-queue:2");
      return 2;
    },
    setPreserveQueuedTurnsAsHistory: (preserve) => {
      events.push(`preserve:${preserve}`);
    },
    abortCurrentTurn: () => {
      events.push("unexpected:abort");
    },
    updateStatus: () => {
      events.push("status");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });
  await handleTelegramStopCommand({
    hasAbortHandler: () => true,
    clearPendingModelSwitch: () => {
      events.push("clear");
    },
    clearQueuedTelegramItems: () => {
      events.push("clear-queue:1");
      return 1;
    },
    setPreserveQueuedTurnsAsHistory: (preserve) => {
      events.push(`preserve:${preserve}`);
    },
    abortCurrentTurn: () => {
      events.push("abort");
    },
    updateStatus: () => {
      events.push("status");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });
  assert.deepEqual(events, [
    "clear",
    "clear-queue:2",
    "preserve:false",
    "status",
    "reply:No active turn. Cleared 2 queued turns.",
    "clear",
    "clear-queue:1",
    "preserve:false",
    "abort",
    "status",
    "reply:Aborted current turn. Cleared 1 queued turn.",
  ]);
});

test("Command helpers guard and complete compact command flow", async () => {
  const events: string[] = [];
  await handleTelegramCompactCommand({
    isIdle: () => false,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: (inProgress) => {
      events.push(`set:${inProgress}`);
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    compact: () => {
      events.push("unexpected:compact");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });
  let complete: (() => void) | undefined;
  await handleTelegramCompactCommand({
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: (inProgress) => {
      events.push(`set:${inProgress}`);
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    compact: (callbacks) => {
      events.push("compact");
      complete = callbacks.onComplete;
    },
    startTypingLoop: () => {
      events.push("typing:start");
    },
    stopTypingLoop: () => {
      events.push("typing:stop");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });
  complete?.();
  assert.deepEqual(events, [
    "reply:Cannot compact while π or the Telegram queue is busy. Wait for queued turns to finish or send /abort first.",
    "set:true",
    "status",
    "compact",
    "reply:Compaction started.",
    "typing:start",
    "typing:stop",
    "set:false",
    "status",
    "dispatch",
    "reply:Compaction completed.",
  ]);
});

test("Command helpers defer compact-complete queue dispatch", async () => {
  const events: string[] = [];
  let complete: (() => void) | undefined;
  let deferredDispatch: (() => void) | undefined;
  await handleTelegramCompactCommand({
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: (inProgress) => {
      events.push(`set:${inProgress}`);
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    requestDeferredDispatchNextQueuedTelegramTurn: (dispatch) => {
      events.push("defer");
      deferredDispatch = dispatch;
    },
    compact: (callbacks) => {
      events.push("compact");
      complete = callbacks.onComplete;
    },
    startTypingLoop: () => {
      events.push("typing:start");
    },
    stopTypingLoop: () => {
      events.push("typing:stop");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });
  complete?.();
  assert.deepEqual(events, [
    "set:true",
    "status",
    "compact",
    "reply:Compaction started.",
    "typing:start",
    "typing:stop",
    "set:false",
    "status",
    "defer",
    "reply:Compaction completed.",
  ]);
  deferredDispatch?.();
  assert.deepEqual(events.at(-1), "dispatch");
});

test("Command helpers report compact errors", async () => {
  const events: string[] = [];
  const recordRuntimeEvent = (category: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    events.push(`event:${category}:${message}`);
  };
  let fail: ((error: unknown) => void) | undefined;
  await handleTelegramCompactCommand({
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: (inProgress) => {
      events.push(`set:${inProgress}`);
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    compact: (callbacks) => {
      events.push("compact");
      fail = callbacks.onError;
    },
    startTypingLoop: () => {
      events.push("typing:start");
    },
    stopTypingLoop: () => {
      events.push("typing:stop");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
    recordRuntimeEvent,
  });
  fail?.(new Error("boom"));
  await handleTelegramCompactCommand({
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: (inProgress) => {
      events.push(`throw-set:${inProgress}`);
    },
    updateStatus: () => {
      events.push("throw-status");
    },
    dispatchNextQueuedTelegramTurn: () => {},
    compact: () => {
      throw new Error("sync boom");
    },
    startTypingLoop: () => {
      events.push("throw-typing:start");
    },
    stopTypingLoop: () => {
      events.push("throw-typing:stop");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
    recordRuntimeEvent,
  });
  assert.deepEqual(events, [
    "set:true",
    "status",
    "compact",
    "reply:Compaction started.",
    "typing:start",
    "typing:stop",
    "set:false",
    "status",
    "dispatch",
    "event:compact:boom",
    "reply:Compaction failed: boom",
    "throw-set:true",
    "throw-status",
    "throw-typing:stop",
    "throw-set:false",
    "throw-status",
    "event:compact:sync boom",
    "reply:Compaction failed: sync boom",
  ]);
});

test("Command helpers acknowledge and queue reload commands", async () => {
  const events: string[] = [];
  await handleTelegramReloadCommand({
    queueReloadRuntimeCommand: () => {
      events.push("queue");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });
  await handleTelegramReloadCommand({
    queueReloadRuntimeCommand: () => {
      throw new Error("cannot enqueue");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
    recordRuntimeEvent: (category, error) => {
      const message = error instanceof Error ? error.message : String(error);
      events.push(`event:${category}:${message}`);
    },
  });
  assert.deepEqual(events, [
    "reply:Reload queued.",
    "queue",
    "reply:Reload queued.",
    "event:reload:cannot enqueue",
    "reply:Reload queue failed: cannot enqueue",
  ]);
});

test("Command helpers execute status and model controls immediately", async () => {
  const events: string[] = [];
  await handleTelegramStatusCommand({
    ctx: "ctx",
    showStatus: async (ctx) => {
      events.push(`show:${ctx}`);
    },
  });
  await handleTelegramModelCommand({
    ctx: "ctx",
    openModelMenu: async (ctx) => {
      events.push(`model:${ctx}`);
    },
  });
  assert.deepEqual(events, ["show:ctx", "model:ctx"]);
});

test("Command menu controls swallow only stale context errors", async () => {
  await handleTelegramStatusCommand({
    ctx: "ctx",
    showStatus: async () => {
      throw new Error("ctx is stale after session reload");
    },
  });
  await assert.rejects(
    () =>
      handleTelegramModelCommand({
        ctx: "ctx",
        openModelMenu: async () => {
          throw new Error("menu broke");
        },
      }),
    /menu broke/,
  );
});

test("Command helpers build the unified app menu from commands and status", () => {
  assert.equal(
    buildTelegramAppMenuHtml(
      "<b>Status:</b> <code>idle</code>\n<b>Context:</b> <code>1%</code>",
    ),
    `${TELEGRAM_APP_MENU_INTRO_HTML}\n\n<b>Status:</b> <code>idle</code>\n<b>Context:</b> <code>1%</code>`,
  );
  assert.equal(
    buildTelegramAppMenuHtml("<b>Status:</b> <code>idle</code>", [
      { command: "review", description: "Review <changes>\nWith details" },
    ]),
    `${TELEGRAM_APP_MENU_INTRO_HTML}\n\n🧩 /review\n\n<b>Status:</b> <code>idle</code>`,
  );
  const buildAppMenuHtml = createTelegramAppMenuHtmlBuilder({
    buildStatusHtml: (ctx: string) => `<b>Status ${ctx}</b>`,
  });
  assert.equal(
    buildAppMenuHtml("ctx"),
    `${TELEGRAM_APP_MENU_INTRO_HTML}\n\n<b>Status ctx</b>`,
  );
});

test("Command handler target runtime binds command targets into command handling", async () => {
  const calls: string[] = [];
  const handleCommand = createTelegramCommandHandlerTargetRuntime<
    { chat: { id: number }; message_id: number },
    string
  >({
    hasAbortHandler: () => false,
    clearPendingModelSwitch: () => {},
    hasQueuedTelegramItems: () => false,
    clearQueuedTelegramItems: () => 0,
    setPreserveQueuedTurnsAsHistory: () => {},
    abortCurrentTurn: () => {},
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: () => {},
    updateStatus: () => {},
    dispatchNextQueuedTelegramTurn: (ctx) => {
      calls.push(`dispatch:${ctx}`);
    },
    enqueueContinueTurn: async (_message, ctx) => {
      calls.push(`continue:${ctx}`);
    },
    compact: () => {},
    queueReloadRuntimeCommand: () => {
      calls.push("reload");
    },
    injectNewSession: async () => undefined,
    injectClone: async () => undefined,
    getSessionName: () => undefined,
    setSessionName: () => undefined,
    allocateItemOrder: () => 0,
    allocateControlOrder: () => 0,
    appendControlItem: (item, ctx) => {
      calls.push(
        `append:${item.chatId}:${item.replyToMessageId}:${item.controlType}:${ctx}`,
      );
    },
    showStatus: async (_chatId, _replyToMessageId, ctx) => {
      calls.push(`show:${ctx}`);
    },
    openModelMenu: async () => {},
    listAvailableModels: () => [],
    isModelSwitchAllowed: () => true,
    selectLlmModel: async () => true,
    openThinkingMenu: async () => {},
    openQueueMenu: async () => {},
    openResumeMenu: async () => {},
    openSessionMenu: async () => {},
    getAllowedUserId: () => undefined,
    setAllowedUserId: () => {},
    setMyCommands: async () => {},
    persistConfig: async () => {},
    sendTextReply: async () => {},
  });
  assert.equal(
    await handleCommand(
      "status",
      "",
      { chat: { id: 7 }, message_id: 11 },
      "ctx",
    ),
    true,
  );
  assert.deepEqual(calls, ["show:ctx"]);
});

test("Command runtime routes commands through runtime ports", async () => {
  const events: string[] = [];
  const message = { chat: { id: 42 }, message_id: 99, from: { id: 7 } };
  let allowedUserId: number | undefined;
  let compactComplete: (() => void) | undefined;
  const deps = {
    hasAbortHandler: () => true,
    clearPendingModelSwitch: () => {
      events.push("clear-switch");
    },
    hasQueuedTelegramItems: () => false,
    clearQueuedTelegramItems: () => {
      events.push("clear-queue");
      return 0;
    },
    setPreserveQueuedTurnsAsHistory: (preserve: boolean) => {
      events.push(`preserve:${preserve}`);
    },
    abortCurrentTurn: () => {
      events.push("abort");
    },
    isIdle: (ctx: { idle: boolean }) => ctx.idle,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: (inProgress: boolean) => {
      events.push(`compact:${inProgress}`);
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    compact: (
      _ctx: { idle: boolean },
      callbacks: { onComplete: () => void },
    ) => {
      events.push("compact:start");
      compactComplete = callbacks.onComplete;
    },
    queueReloadRuntimeCommand: () => {
      events.push("reload:queue");
    },
    startTypingLoop: (_ctx: { idle: boolean }, chatId?: number) => {
      events.push(`typing:start:${chatId ?? "default"}`);
    },
    stopTypingLoop: () => {
      events.push("typing:stop");
    },
    injectNewSession: async () => {
      events.push("inject-new");
    },
    injectClone: async () => {
      events.push("inject-clone");
    },
    getSessionName: () => "old name",
    setSessionName: (name: string) => {
      events.push(`session-name:${name}`);
    },
    enqueueControlItem: async (
      nextMessage: typeof message,
      _ctx: { idle: boolean },
      controlType: "status" | "model",
      statusSummary: string,
      execute: (ctx: { idle: boolean }) => Promise<void>,
    ) => {
      events.push(
        `enqueue:${nextMessage.message_id}:${controlType}:${statusSummary}`,
      );
      await execute({ idle: true });
    },
    enqueueContinueTurn: async (nextMessage: typeof message) => {
      events.push(`continue:${nextMessage.message_id}`);
    },
    showStatus: async (nextMessage: typeof message) => {
      events.push(`show:${nextMessage.chat.id}`);
    },
    openModelMenu: async (nextMessage: typeof message) => {
      events.push(`model:${nextMessage.chat.id}`);
    },
    listAvailableModels: () => [
      { provider: "anthropic", id: "claude-sonnet-4-5" },
    ],
    isModelSwitchAllowed: () => true,
    selectLlmModel: async () => true,
    openThinkingMenu: async (nextMessage: typeof message) => {
      events.push(`thinking:${nextMessage.chat.id}`);
    },
    openQueueMenu: async (nextMessage: typeof message) => {
      events.push(`queue:${nextMessage.chat.id}`);
    },
    openResumeMenu: async (nextMessage: typeof message) => {
      events.push(`resume:${nextMessage.chat.id}`);
    },
    openSessionMenu: async (nextMessage: typeof message) => {
      events.push(`session:${nextMessage.chat.id}`);
    },
    openTreeMenu: async (nextMessage: typeof message) => {
      events.push(`tree:${nextMessage.chat.id}`);
    },
    getAllowedUserId: () => allowedUserId,
    setAllowedUserId: (userId: number) => {
      allowedUserId = userId;
      events.push(`pair:${userId}`);
    },
    registerBotCommands: async () => {
      events.push("register");
    },
    persistConfig: async () => {
      events.push("persist");
    },
    sendTextReply: async (nextMessage: typeof message, text: string) => {
      events.push(`reply:${nextMessage.message_id}:${text}`);
    },
  };
  const handleCommand = createTelegramCommandHandler(deps);
  assert.equal(
    await handleCommand("status", "", message, { idle: true }),
    true,
  );
  assert.equal(
    await handleCommand("model", "", message, { idle: true }),
    true,
  );
  assert.equal(
    await handleCommand("thinking", "", message, { idle: true }),
    true,
  );
  assert.equal(
    await handleCommand("debug", "", message, { idle: true }),
    false,
  );
  assert.equal(
    await handleCommand("start", "", message, { idle: true }),
    true,
  );
  assert.equal(
    await handleCommand("help", "", message, { idle: true }),
    true,
  );
  assert.equal(
    await handleCommand("continue", "", message, { idle: true }),
    true,
  );
  assert.equal(
    await handleCommand("continue", "", message, { idle: false }),
    true,
  );
  assert.equal(
    await handleCommand("compact", "", message, { idle: true }),
    true,
  );
  compactComplete?.();
  assert.equal(
    await handleCommand("reload", "", message, { idle: true }),
    true,
  );
  assert.equal(
    await handleCommand("tree", "", message, { idle: true }),
    true,
  );
  assert.equal(
    await handleCommand("delete", "", message, { idle: true }),
    false,
  );
  assert.equal(
    await handleCommand("name", "mobile task", message, { idle: true }),
    true,
  );
  assert.equal(
    await handleCommand("stop", "", message, { idle: true }),
    true,
  );
  assert.equal(
    await handleCommand("unknown", "", message, { idle: true }),
    false,
  );
  assert.equal(allowedUserId, 7);
  assert.deepEqual(events, [
    "show:42",
    "model:42",
    "thinking:42",
    "register",
    "pair:7",
    "persist",
    "status",
    "show:42",
    "register",
    "show:42",
    "continue:99",
    "continue:99",
    "compact:true",
    "status",
    "compact:start",
    "reply:99:Compaction started.",
    "typing:start:42",
    "typing:stop",
    "compact:false",
    "status",
    "dispatch",
    "reply:99:Compaction completed.",
    "reply:99:Reload queued.",
    "reload:queue",
    "tree:42",
    "session-name:mobile task",
    "status",
    "reply:99:Session name set:\nmobile task",
    "clear-switch",
    "clear-queue",
    "preserve:false",
    "abort",
    "status",
    "reply:99:Aborted current turn.",
  ]);
});

test("Command or prompt runtime routes commands before enqueue fallback", async () => {
  const events: string[] = [];
  const runtime = createTelegramCommandOrPromptRuntime<
    { text: string },
    { id: string }
  >({
    extractRawText: (messages) =>
      messages.map((message) => message.text).join(" "),
    handleCommand: async (commandName, args, message, ctx) => {
      events.push(
        `command:${commandName ?? "none"}:${args}:${message.text}:${ctx.id}`,
      );
      return commandName === "status";
    },
    expandPromptTemplateCommand: (commandName, args) =>
      commandName === "review" ? `expanded:${args}` : undefined,
    replaceMessageText: (message, text) => ({ ...message, text }),
    enqueueTurn: async (messages, ctx) => {
      events.push(`enqueue:${messages.length}:${messages[0]?.text}:${ctx.id}`);
    },
  });
  await runtime.dispatchMessages([{ text: "/status" }], { id: "ctx" });
  await runtime.dispatchMessages([{ text: "/review staged" }], { id: "ctx" });
  await runtime.dispatchMessages([{ text: "hello" }], { id: "ctx" });
  await runtime.dispatchMessages([], { id: "ctx" });
  assert.deepEqual(events, [
    "command:status::/status:ctx",
    "command:review:staged:/review staged:ctx",
    "enqueue:1:expanded:staged:ctx",
    "command:none::hello:ctx",
    "enqueue:1:hello:ctx",
  ]);
});

test("Command helpers execute command actions through provided handlers", async () => {
  const events: string[] = [];
  const deps = {
    handleStop: async () => {
      events.push("stop");
    },
    handleCompact: async () => {
      events.push("compact");
    },
    handleReload: async () => {
      events.push("reload");
    },
    handleStatus: async () => {
      events.push("status");
    },
    handleModel: async () => {
      events.push("model");
    },
    handleLlm: async () => {
      events.push("llm");
    },
    handleThinking: async () => {
      events.push("thinking");
    },
    handleHelp: async (_message: unknown, commandName: "help" | "start") => {
      events.push(`help:${commandName}`);
    },
    handleAbort: async () => {
      events.push("abort");
    },
    handleNext: async () => {
      events.push("next");
    },
    handleContinue: async () => {
      events.push("continue");
    },
    handleQueue: async () => {
      events.push("queue");
    },
    handleNew: async () => {
      events.push("new");
    },
    handleClone: async () => {
      events.push("clone");
    },
    handleResume: async (_message: unknown, args: string) => {
      events.push(`resume:${args}`);
    },
    handleSession: async () => {
      events.push("session");
    },
    handleTree: async () => {
      events.push("tree");
    },
    handleName: async (_message: unknown, args: string) => {
      events.push(`name:${args}`);
    },
  };
  assert.equal(
    await executeTelegramCommandAction(
      { kind: "ignore", executionMode: "ignored" },
      {},
      {},
      deps,
    ),
    false,
  );
  assert.equal(
    await executeTelegramCommandAction(
      { kind: "stop", executionMode: "immediate" },
      {},
      {},
      deps,
    ),
    true,
  );
  assert.equal(
    await executeTelegramCommandAction(
      { kind: "help", commandName: "start", executionMode: "immediate" },
      {},
      {},
      deps,
    ),
    true,
  );
  assert.equal(
    await executeTelegramCommandAction(
      { kind: "reload", executionMode: "immediate" },
      {},
      {},
      deps,
    ),
    true,
  );
  assert.equal(
    await executeTelegramCommandAction(
      { kind: "name", args: "label", executionMode: "immediate" },
      {},
      {},
      deps,
    ),
    true,
  );
  assert.equal(
    await executeTelegramCommandAction(
      { kind: "resume", args: "apple cat", executionMode: "immediate" },
      {},
      {},
      deps,
    ),
    true,
  );
  assert.deepEqual(events, [
    "stop",
    "help:start",
    "reload",
    "name:label",
    "resume:apple cat",
  ]);
});

test("Command helpers guard and complete /new session flow", async () => {
  const events: string[] = [];

  // Busy: not idle
  await handleTelegramNewSessionCommand({
    isIdle: () => false,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    injectNewSession: async () => {
      events.push("unexpected:inject");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });

  // Busy: queue not empty
  await handleTelegramNewSessionCommand({
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => true,
    isCompactionInProgress: () => false,
    injectNewSession: async () => {
      events.push("unexpected:inject");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });

  // Success
  await handleTelegramNewSessionCommand({
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    injectNewSession: async () => {
      events.push("inject");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });

  // Injection failure
  await handleTelegramNewSessionCommand({
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    injectNewSession: async () => {
      throw new Error("tmux not running");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
    recordRuntimeEvent: (category, error) => {
      const message = error instanceof Error ? error.message : String(error);
      events.push(`event:${category}:${message}`);
    },
  });

  assert.deepEqual(events, [
    "reply:Cannot start a new session while π or the Telegram queue is busy. Wait for queued turns to finish or send /stop first.",
    "reply:Cannot start a new session while π or the Telegram queue is busy. Wait for queued turns to finish or send /stop first.",
    "inject",
    "reply:New session started.",
    "event:new_session:tmux not running",
    "reply:New session failed: tmux not running",
  ]);
});

test("Command helpers guard and complete /clone session flow", async () => {
  const events: string[] = [];

  // Busy: not idle
  await handleTelegramCloneSessionCommand({
    isIdle: () => false,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    injectClone: async () => {
      events.push("unexpected:inject");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });

  // Busy: queue not empty
  await handleTelegramCloneSessionCommand({
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => true,
    isCompactionInProgress: () => false,
    injectClone: async () => {
      events.push("unexpected:inject");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });

  // Success
  await handleTelegramCloneSessionCommand({
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    injectClone: async () => {
      events.push("inject");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });

  // Injection failure
  await handleTelegramCloneSessionCommand({
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    injectClone: async () => {
      throw new Error("tmux not running");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
    recordRuntimeEvent: (category, error) => {
      const message = error instanceof Error ? error.message : String(error);
      events.push(`event:${category}:${message}`);
    },
  });

  assert.deepEqual(events, [
    "reply:Cannot clone the session while π or the Telegram queue is busy. Wait for queued turns to finish or send /stop first.",
    "reply:Cannot clone the session while π or the Telegram queue is busy. Wait for queued turns to finish or send /stop first.",
    "inject",
    "reply:Cloned to new session.",
    "event:clone_session:tmux not running",
    "reply:Clone failed: tmux not running",
  ]);
});

test("buildTelegramCommandAction recognizes /clone as reserved", () => {
  assert.equal(isTelegramReservedCommandName("clone"), true);
  assert.deepEqual(buildTelegramCommandAction("clone"), {
    kind: "clone",
    executionMode: "immediate",
  });
});

test("/name command shows, sets, and clears the current session name", async () => {
  const replies: string[] = [];
  const events: string[] = [];
  let sessionName: string | undefined = "existing label";
  const runName = (args: string) =>
    handleTelegramSessionNameCommand({
      ctx: "ctx",
      args,
      getSessionName: () => sessionName,
      setSessionName: (name) => {
        sessionName = name.trim() || undefined;
        events.push(`set:${name}`);
      },
      updateStatus: () => {
        events.push("status");
      },
      sendTextReply: async (text) => {
        replies.push(text);
      },
    });

  await runName("");
  await runName("  mobile debug thread  ");
  await runName("--clear");
  await runName("");

  assert.deepEqual(replies, [
    "Current name:\nexisting label\n\nUsage:\n/name <new name>\n/name --clear",
    "Session name set:\nmobile debug thread",
    "Session name cleared.",
    "No session name set.\n\nUsage:\n/name <new name>\n/name --clear",
  ]);
  assert.deepEqual(events, [
    "set:mobile debug thread",
    "status",
    "set:",
    "status",
  ]);
});

test("/llm command lists available models", async () => {
  assert.deepEqual(buildTelegramCommandAction("llm"), {
    kind: "llm",
    args: "",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("llm", "v4 flash"), {
    kind: "llm",
    args: "v4 flash",
    executionMode: "immediate",
  });
  assert.equal(isTelegramReservedCommandName("llm"), true);
  assert.equal(
    formatTelegramLlmListReply([]),
    "No available LLM models.",
  );
  assert.equal(
    formatTelegramLlmListReply([
      { provider: "anthropic", id: "claude-sonnet-4-5" },
      { provider: "openai", id: "gpt-5" },
    ]),
    "Available LLM models:\n• anthropic/claude-sonnet-4-5\n• openai/gpt-5",
  );

  const sampleModels = [
    { provider: "deepseek", id: "deepseek-v4-flash" },
    { provider: "deepseek", id: "deepseek-v4-pro" },
    { provider: "anthropic", id: "claude-opus-4-7" },
  ];
  type Ctx = { tag: string };
  const runLlm = async (
    args: string,
    overrides: {
      isModelSwitchAllowed?: (ctx: Ctx) => boolean;
      selectLlmModel?: (model: { provider: string; id: string }) => boolean;
    } = {},
  ): Promise<string[]> => {
    const replies: string[] = [];
    await handleTelegramLlmCommand<Ctx>({
      ctx: { tag: "ctx" },
      args,
      listAvailableModels: () => sampleModels,
      isModelSwitchAllowed: overrides.isModelSwitchAllowed ?? (() => true),
      selectLlmModel: async (model) =>
        overrides.selectLlmModel ? overrides.selectLlmModel(model) : true,
      sendTextReply: async (text) => {
        replies.push(text);
      },
    });
    return replies;
  };

  assert.deepEqual(parseTelegramLlmFilterTokens("  v4   Flash  "), [
    "v4",
    "flash",
  ]);
  assert.deepEqual(
    filterTelegramLlmModels(sampleModels, ["v4"]).map((m) => m.id),
    ["deepseek-v4-flash", "deepseek-v4-pro"],
  );

  assert.deepEqual(await runLlm(""), [
    "Available LLM models:\n• deepseek/deepseek-v4-flash\n• deepseek/deepseek-v4-pro\n• anthropic/claude-opus-4-7",
  ]);
  assert.deepEqual(await runLlm("v4"), [
    "Available LLM models:\n• deepseek/deepseek-v4-flash\n• deepseek/deepseek-v4-pro",
  ]);
  assert.deepEqual(await runLlm("v4 flash"), [
    "Model switched to deepseek/deepseek-v4-flash",
  ]);
  assert.deepEqual(await runLlm("nope"), ["No models match: nope"]);
  assert.deepEqual(
    await runLlm("flash", { isModelSwitchAllowed: () => false }),
    [
      "Cannot switch model while π is busy. Send /abort, /next, or /stop.",
    ],
  );
  assert.deepEqual(
    await runLlm("flash", { selectLlmModel: () => false }),
    ["Model deepseek/deepseek-v4-flash is not available."],
  );
});
