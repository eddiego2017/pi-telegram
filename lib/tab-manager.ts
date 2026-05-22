/**
 * Telegram concurrent tab runtime
 * Zones: telegram controls, pi agent, process lifecycle
 * Owns durable tab registry loading, per-tab RPC backend orchestration, and text-first Telegram delivery
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  extractRpcAssistantText,
  extractRpcTextDelta,
  RpcChildBackend,
  type RpcChildBackendEvent,
  type RpcChildBackendOptions,
  type RpcChildSessionState,
} from "./rpc-child.ts";
import {
  createDefaultTelegramTabsState,
  findTelegramTabNameCaseConflict,
  formatTelegramTabList,
  formatTelegramTabStatus,
  formatTelegramTabUsage,
  normalizeTelegramTabsState,
  parseTelegramTabCommand,
  TELEGRAM_DEFAULT_TAB_NAME,
  truncateTelegramTabText,
  validateTelegramTabName,
  type TelegramTabRecord,
  type TelegramTabsState,
} from "./tabs.ts";
import type { TelegramConcurrentTabsConfig } from "./config.ts";
import { getTelegramAgentDir } from "./config.ts";

export interface TelegramTabPromptContent {
  type: string;
  text?: string;
}

export interface TelegramTabPromptTurn {
  chatId: number;
  replyToMessageId: number;
  content: readonly TelegramTabPromptContent[];
  statusSummary?: string;
}

export interface TelegramTabBackend {
  start: () => Promise<RpcChildSessionState>;
  dispose: () => Promise<void>;
  onEvent: (listener: (event: RpcChildBackendEvent) => void) => () => void;
  prompt: (message: string) => Promise<void>;
  followUp: (message: string) => Promise<void>;
  abort: () => Promise<void>;
  getState: () => Promise<RpcChildSessionState>;
}

export interface TelegramTabManagerDeps<TContext> {
  getConfig: () => Required<TelegramConcurrentTabsConfig>;
  getCwd: (ctx: TContext) => string;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
  ) => Promise<number | undefined>;
  now?: () => number;
  agentDir?: string;
  statePath?: string;
  sessionRoot?: string;
  createBackend?: (options: RpcChildBackendOptions) => TelegramTabBackend;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

interface RuntimeTab {
  record: TelegramTabRecord;
  backend?: TelegramTabBackend;
  unreadEvents: number;
  activeBuffer: string;
  activeChatId?: number;
  activeReplyToMessageId?: number;
  unsubscribe?: () => void;
}

export interface TelegramTabManager<TContext> {
  isEnabled: () => boolean;
  handleCommand: (
    args: string,
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<boolean>;
  dispatchPrompt: (turn: TelegramTabPromptTurn, ctx: TContext) => Promise<boolean>;
  dispose: () => Promise<void>;
}

export function createTelegramTabManagerShutdownHook<TContext>(
  manager: TelegramTabManager<TContext>,
): () => Promise<void> {
  return manager.dispose;
}

function getTelegramTabsStatePath(agentDir: string): string {
  return join(agentDir, "telegram-tabs.json");
}

function getTelegramTabsSessionRoot(agentDir: string): string {
  return join(agentDir, "telegram-tabs", "sessions");
}

async function readTelegramTabsState(
  statePath: string,
  cwd: string,
  now: number,
): Promise<TelegramTabsState> {
  if (!existsSync(statePath)) return createDefaultTelegramTabsState(cwd, now);
  const raw = JSON.parse(await readFile(statePath, "utf8")) as unknown;
  return normalizeTelegramTabsState(raw, cwd, now);
}

async function writeTelegramTabsState(
  statePath: string,
  state: TelegramTabsState,
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, JSON.stringify(state, null, "\t") + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(tempPath, 0o600);
  await rename(tempPath, statePath);
  await chmod(statePath, 0o600);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildTelegramTabPromptText(turn: TelegramTabPromptTurn): string {
  return turn.content
    .map((content) =>
      content.type === "text" && typeof content.text === "string"
        ? content.text
        : "",
    )
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function applyRpcStateToRecord(
  record: TelegramTabRecord,
  state: RpcChildSessionState,
): void {
  if (state.sessionFile) record.sessionFile = state.sessionFile;
  if (state.sessionId) record.sessionId = state.sessionId;
  if (state.sessionName !== undefined) record.sessionName = state.sessionName;
  if (state.isStreaming === true) {
    record.status = "running";
  } else if (record.status === "starting" || record.status === "running") {
    record.status = "idle";
  }
}

function buildTelegramTabWorkerExtensionArgs(
  extensions: readonly string[],
): string[] {
  return extensions.flatMap((extensionPath) => ["--extension", extensionPath]);
}

export function createTelegramTabManager<TContext>(
  deps: TelegramTabManagerDeps<TContext>,
): TelegramTabManager<TContext> {
  const agentDir = deps.agentDir ?? getTelegramAgentDir();
  const statePath = deps.statePath ?? getTelegramTabsStatePath(agentDir);
  const sessionRoot = deps.sessionRoot ?? getTelegramTabsSessionRoot(agentDir);
  const runtimeTabs = new Map<string, RuntimeTab>();
  let state: TelegramTabsState | undefined;
  let persistChain: Promise<void> = Promise.resolve();

  const now = (): number => deps.now?.() ?? Date.now();
  const isEnabled = (): boolean => deps.getConfig().enabled;
  const persist = (): Promise<void> => {
    if (!state) return Promise.resolve();
    const snapshot = {
      ...state,
      tabs: Object.fromEntries(
        Object.entries(state.tabs).map(([name, record]) => [name, { ...record }]),
      ),
    };
    persistChain = persistChain.then(() =>
      writeTelegramTabsState(statePath, snapshot),
    );
    return persistChain;
  };
  const ensureState = async (cwd: string): Promise<TelegramTabsState> => {
    if (!state) {
      state = await readTelegramTabsState(statePath, cwd, now());
      for (const record of Object.values(state.tabs)) {
        runtimeTabs.set(record.name, {
          record,
          unreadEvents: 0,
          activeBuffer: "",
        });
      }
      await persist();
    }
    return state;
  };
  const getRuntime = (
    tabState: TelegramTabsState,
    name: string,
  ): RuntimeTab | undefined => {
    const record = tabState.tabs[name];
    if (!record) return undefined;
    let runtime = runtimeTabs.get(name);
    if (!runtime) {
      runtime = { record, unreadEvents: 0, activeBuffer: "" };
      runtimeTabs.set(name, runtime);
    }
    runtime.record = record;
    return runtime;
  };
  const sendTabReply = (
    chatId: number | undefined,
    replyToMessageId: number | undefined,
    text: string,
  ): Promise<number | undefined> => {
    if (chatId === undefined || replyToMessageId === undefined) {
      return Promise.resolve(undefined);
    }
    return deps.sendTextReply(chatId, replyToMessageId, text);
  };
  const handleChildEvent = (
    tabName: string,
    runtime: RuntimeTab,
    event: RpcChildBackendEvent,
  ): void => {
    const tabState = state;
    if (!tabState) return;
    const record = runtime.record;
    const eventNow = now();
    if (event.type === "agent_start") {
      runtime.activeBuffer = "";
      record.status = "running";
      record.lastError = undefined;
      record.lastAgentStartAt = eventNow;
      void persist();
      return;
    }
    const delta = extractRpcTextDelta(event);
    if (delta) runtime.activeBuffer += delta;
    const assistantText = extractRpcAssistantText(event);
    if (assistantText) record.lastAssistantText = assistantText;
    if (event.type === "agent_end") {
      record.status = "idle";
      record.lastAgentEndAt = eventNow;
      if (!record.lastAssistantText && runtime.activeBuffer) {
        record.lastAssistantText = runtime.activeBuffer;
      }
      const isActive = tabState.activeTab === tabName;
      if (isActive && record.lastAssistantText) {
        void sendTabReply(
          runtime.activeChatId,
          runtime.activeReplyToMessageId,
          record.lastAssistantText,
        );
      } else if (!isActive) {
        runtime.unreadEvents += 1;
        if (deps.getConfig().inactiveNotify) {
          const chatId = runtime.activeChatId;
          const replyToMessageId = runtime.activeReplyToMessageId;
          void sendTabReply(
            chatId,
            replyToMessageId,
            `Tab ${tabName} finished. Use /tab ${tabName} to view latest reply.`,
          );
        }
      }
      void persist();
      return;
    }
    if (event.type === "exit") {
      if (record.status === "running" || record.status === "starting") {
        record.status = "exited";
      }
      runtime.backend = undefined;
      runtime.unsubscribe?.();
      runtime.unsubscribe = undefined;
      void persist();
      return;
    }
    if (event.type === "error") {
      record.status = "error";
      record.lastError =
        typeof event.error === "string" ? event.error : "RPC child error";
      void persist();
    }
  };
  const ensureBackend = async (
    runtime: RuntimeTab,
    cwd: string,
  ): Promise<TelegramTabBackend> => {
    if (runtime.backend) return runtime.backend;
    runtime.record.status = "starting";
    runtime.record.lastError = undefined;
    await mkdir(join(sessionRoot, runtime.record.name), { recursive: true });
    const workerArgs = buildTelegramTabWorkerExtensionArgs(
      deps.getConfig().workerExtensions,
    );
    const backend = deps.createBackend?.({
      tabName: runtime.record.name,
      cwd: runtime.record.cwd || cwd,
      sessionDir: join(sessionRoot, runtime.record.name),
      sessionFile: runtime.record.sessionFile,
      args: workerArgs,
    }) ?? new RpcChildBackend({
      tabName: runtime.record.name,
      cwd: runtime.record.cwd || cwd,
      sessionDir: join(sessionRoot, runtime.record.name),
      sessionFile: runtime.record.sessionFile,
      args: workerArgs,
    });
    runtime.backend = backend;
    runtime.unsubscribe = backend.onEvent((event) => {
      handleChildEvent(runtime.record.name, runtime, event);
    });
    try {
      const childState = await backend.start();
      applyRpcStateToRecord(runtime.record, childState);
      await persist();
      return backend;
    } catch (error) {
      runtime.record.status = "error";
      runtime.record.lastError = getErrorMessage(error);
      runtime.backend = undefined;
      runtime.unsubscribe?.();
      runtime.unsubscribe = undefined;
      await persist();
      throw error;
    }
  };
  const replyDisabled = (
    chatId: number,
    replyToMessageId: number,
  ): Promise<number | undefined> =>
    deps.sendTextReply(
      chatId,
      replyToMessageId,
      "Concurrent tabs are disabled. Set concurrentTabs.enabled to true in telegram.json to use /tab.",
    );
  const commandHandlers = {
    list: async (
      tabState: TelegramTabsState,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const unread = Object.fromEntries(
        [...runtimeTabs.entries()].map(([name, runtime]) => [
          name,
          runtime.unreadEvents,
        ]),
      );
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        formatTelegramTabList(tabState, unread, now()),
      );
    },
    new: async (
      tabState: TelegramTabsState,
      name: string,
      chatId: number,
      replyToMessageId: number,
      ctx: TContext,
    ) => {
      const validationError = validateTelegramTabName(name);
      if (validationError) {
        await deps.sendTextReply(chatId, replyToMessageId, validationError);
        return;
      }
      if (tabState.tabs[name]) {
        await deps.sendTextReply(chatId, replyToMessageId, `Tab ${name} already exists.`);
        return;
      }
      const conflict = findTelegramTabNameCaseConflict(tabState.tabs, name);
      if (conflict) {
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Tab ${conflict} already exists with different case.`,
        );
        return;
      }
      if (Object.keys(tabState.tabs).length >= deps.getConfig().maxTabs) {
        await deps.sendTextReply(chatId, replyToMessageId, "Maximum tab count reached.");
        return;
      }
      const createdAt = now();
      const record: TelegramTabRecord = {
        name,
        cwd: deps.getCwd(ctx),
        createdAt,
        lastUsedAt: createdAt,
        status: "idle",
      };
      tabState.tabs[name] = record;
      tabState.activeTab = name;
      const runtime: RuntimeTab = {
        record,
        unreadEvents: 0,
        activeBuffer: "",
      };
      runtimeTabs.set(name, runtime);
      await persist();
      try {
        await ensureBackend(runtime, record.cwd);
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Created and switched to tab ${name}.`,
        );
      } catch (error) {
        deps.recordRuntimeEvent?.("tabs", error, { tab: name, action: "new" });
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Created tab ${name}, but worker failed: ${getErrorMessage(error)}`,
        );
      }
    },
    switch: async (
      tabState: TelegramTabsState,
      name: string,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const runtime = getRuntime(tabState, name);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown tab: ${name}`);
        return;
      }
      tabState.activeTab = name;
      runtime.record.lastUsedAt = now();
      runtime.unreadEvents = 0;
      await persist();
      const latest = runtime.record.lastAssistantText
        ? `\n\nLast reply:\n${truncateTelegramTabText(runtime.record.lastAssistantText)}`
        : "";
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        `Switched to tab ${name}.${latest}`,
      );
    },
    close: async (
      tabState: TelegramTabsState,
      name: string,
      force: boolean,
      chatId: number,
      replyToMessageId: number,
    ) => {
      if (name === TELEGRAM_DEFAULT_TAB_NAME) {
        await deps.sendTextReply(chatId, replyToMessageId, "Cannot close default tab.");
        return;
      }
      const runtime = getRuntime(tabState, name);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown tab: ${name}`);
        return;
      }
      if (runtime.record.status === "running" && !force) {
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Tab ${name} is running. Use /tab close ${name} --force to close it.`,
        );
        return;
      }
      await runtime.backend?.dispose();
      runtime.unsubscribe?.();
      runtimeTabs.delete(name);
      delete tabState.tabs[name];
      if (tabState.activeTab === name) tabState.activeTab = TELEGRAM_DEFAULT_TAB_NAME;
      await persist();
      await deps.sendTextReply(chatId, replyToMessageId, `Closed tab ${name}.`);
    },
    status: async (
      tabState: TelegramTabsState,
      name: string | undefined,
      chatId: number,
      replyToMessageId: number,
    ) => {
      if (!name) {
        await commandHandlers.list(tabState, chatId, replyToMessageId);
        return;
      }
      const runtime = getRuntime(tabState, name);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown tab: ${name}`);
        return;
      }
      if (runtime.backend) {
        await runtime.backend
          .getState()
          .then((childState) => applyRpcStateToRecord(runtime.record, childState))
          .catch((error) => {
            runtime.record.status = "error";
            runtime.record.lastError = getErrorMessage(error);
          });
        await persist();
      }
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        formatTelegramTabStatus(runtime.record, runtime.unreadEvents, now()),
      );
    },
    abort: async (
      tabState: TelegramTabsState,
      name: string | undefined,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const targetName = name ?? tabState.activeTab;
      const runtime = getRuntime(tabState, targetName);
      if (!runtime?.backend) {
        await deps.sendTextReply(chatId, replyToMessageId, `No active worker for tab ${targetName}.`);
        return;
      }
      await runtime.backend.abort();
      runtime.record.status = "idle";
      await persist();
      await deps.sendTextReply(chatId, replyToMessageId, `Aborted tab ${targetName}.`);
    },
    restart: async (
      tabState: TelegramTabsState,
      name: string,
      chatId: number,
      replyToMessageId: number,
      ctx: TContext,
    ) => {
      const runtime = getRuntime(tabState, name);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown tab: ${name}`);
        return;
      }
      await runtime.backend?.dispose();
      runtime.unsubscribe?.();
      runtime.backend = undefined;
      runtime.unsubscribe = undefined;
      try {
        await ensureBackend(runtime, deps.getCwd(ctx));
        await deps.sendTextReply(chatId, replyToMessageId, `Restarted tab ${name}.`);
      } catch (error) {
        deps.recordRuntimeEvent?.("tabs", error, { tab: name, action: "restart" });
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Tab ${name} restart failed: ${getErrorMessage(error)}`,
        );
      }
    },
  };
  return {
    isEnabled,
    handleCommand: async (args, chatId, replyToMessageId, ctx) => {
      if (!isEnabled()) {
        await replyDisabled(chatId, replyToMessageId);
        return true;
      }
      const tabState = await ensureState(deps.getCwd(ctx));
      const command = parseTelegramTabCommand(args);
      switch (command.kind) {
        case "list":
          await commandHandlers.list(tabState, chatId, replyToMessageId);
          return true;
        case "new":
          await commandHandlers.new(tabState, command.name, chatId, replyToMessageId, ctx);
          return true;
        case "switch":
          await commandHandlers.switch(tabState, command.name, chatId, replyToMessageId);
          return true;
        case "close":
          await commandHandlers.close(tabState, command.name, command.force, chatId, replyToMessageId);
          return true;
        case "status":
          await commandHandlers.status(tabState, command.name, chatId, replyToMessageId);
          return true;
        case "abort":
          await commandHandlers.abort(tabState, command.name, chatId, replyToMessageId);
          return true;
        case "restart":
          await commandHandlers.restart(tabState, command.name, chatId, replyToMessageId, ctx);
          return true;
        case "invalid":
          await deps.sendTextReply(chatId, replyToMessageId, command.message);
          return true;
        case "usage":
          await deps.sendTextReply(chatId, replyToMessageId, formatTelegramTabUsage());
          return true;
      }
    },
    dispatchPrompt: async (turn, ctx) => {
      if (!isEnabled()) return false;
      const tabState = await ensureState(deps.getCwd(ctx));
      const runtime = getRuntime(tabState, tabState.activeTab);
      if (!runtime) return false;
      const promptText = buildTelegramTabPromptText(turn);
      if (!promptText) {
        await deps.sendTextReply(
          turn.chatId,
          turn.replyToMessageId,
          "Tab prompt is empty.",
        );
        return true;
      }
      const wasRunning = runtime.record.status === "running";
      runtime.activeChatId = turn.chatId;
      runtime.activeReplyToMessageId = turn.replyToMessageId;
      runtime.record.lastUsedAt = now();
      try {
        const backend = await ensureBackend(runtime, deps.getCwd(ctx));
        if (wasRunning) {
          await backend.followUp(promptText);
        } else {
          await backend.prompt(promptText);
        }
        runtime.record.status = "running";
        await persist();
        await deps.sendTextReply(
          turn.chatId,
          turn.replyToMessageId,
          wasRunning
            ? `Queued follow-up in tab ${runtime.record.name}.`
            : `Started tab ${runtime.record.name}.`,
        );
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("tabs", error, {
          tab: runtime.record.name,
          action: "prompt",
        });
        await persist();
        await deps.sendTextReply(
          turn.chatId,
          turn.replyToMessageId,
          `Tab ${runtime.record.name} failed: ${getErrorMessage(error)}`,
        );
      }
      return true;
    },
    dispose: async () => {
      await Promise.all(
        [...runtimeTabs.values()].map(async (runtime) => {
          runtime.unsubscribe?.();
          await runtime.backend?.dispose();
          runtime.backend = undefined;
          if (runtime.record.status === "running" || runtime.record.status === "starting") {
            runtime.record.status = "exited";
          }
        }),
      );
      await persist();
    },
  };
}
