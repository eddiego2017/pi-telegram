/**
 * pi SDK adapter boundary
 * Zones: pi agent sdk boundary, shared adapters
 * Owns direct pi SDK imports and exposes narrow bridge-facing helpers/types for the extension composition layer
 */

import {
  type AgentEndEvent,
  type AgentStartEvent,
  type BeforeAgentStartEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type SlashCommandInfo,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
  formatTelegramContextUsageFooter,
  type TelegramPromptCacheUsageSnapshot,
} from "./context-usage.ts";

export type {
  AgentEndEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  SlashCommandInfo,
};

export interface PiSettingsManager {
  reload: () => Promise<void>;
  flush: () => Promise<void>;
  getEnabledModels: () => string[] | undefined;
  setEnabledModels: (patterns: string[] | undefined) => void;
}

export type PiSlashCommandInfo = SlashCommandInfo;

export interface PiExtensionApiRuntimePorts {
  sendUserMessage: ExtensionAPI["sendUserMessage"];
  exec: ExtensionAPI["exec"];
  getCommands: ExtensionAPI["getCommands"];
  getThinkingLevel: ExtensionAPI["getThinkingLevel"];
  setThinkingLevel: ExtensionAPI["setThinkingLevel"];
  setModel: ExtensionAPI["setModel"];
}

export function createExtensionApiRuntimePorts(
  api: Pick<
    ExtensionAPI,
    | "sendUserMessage"
    | "exec"
    | "getCommands"
    | "getThinkingLevel"
    | "setThinkingLevel"
    | "setModel"
  >,
): PiExtensionApiRuntimePorts {
  return {
    sendUserMessage: (content) => api.sendUserMessage(content),
    exec: (command, args, options) => api.exec(command, args, options),
    getCommands: () => api.getCommands(),
    getThinkingLevel: () => api.getThinkingLevel(),
    setThinkingLevel: (level) => api.setThinkingLevel(level),
    setModel: (model) => api.setModel(model),
  };
}

export function createSettingsManager(cwd: string): PiSettingsManager {
  return SettingsManager.create(cwd);
}

export function createScopedModelPatternPersister(deps: {
  createSettingsManager: (cwd: string) => PiSettingsManager;
  clearCachedModelMenuInputs: () => void;
}): (patterns: string[], ctx: ExtensionContext) => Promise<void> {
  return async function persistScopedModelPatterns(patterns, ctx) {
    const settingsManager = deps.createSettingsManager(ctx.cwd);
    settingsManager.setEnabledModels(
      patterns.length > 0 ? patterns : undefined,
    );
    await settingsManager.flush();
    deps.clearCachedModelMenuInputs();
  };
}

export function getExtensionContextModel(
  ctx: ExtensionContext,
): ExtensionContext["model"] {
  return ctx.model;
}

export function listExtensionContextAvailableModels(
  ctx: ExtensionContext,
): readonly { provider: string; id: string }[] {
  return ctx.modelRegistry.getAvailable().map((model) => ({
    provider: model.provider,
    id: model.id,
  }));
}

export function findExtensionContextAvailableModel(
  identity: { provider: string; id: string },
  ctx: ExtensionContext,
): NonNullable<ExtensionContext["model"]> | undefined {
  return ctx.modelRegistry
    .getAvailable()
    .find(
      (model) =>
        model.provider === identity.provider && model.id === identity.id,
    ) as NonNullable<ExtensionContext["model"]> | undefined;
}

export function getExtensionContextCwd(ctx: ExtensionContext): string {
  return ctx.cwd;
}

export function isExtensionContextIdle(ctx: ExtensionContext): boolean {
  return ctx.isIdle();
}

export function hasExtensionContextPendingMessages(
  ctx: ExtensionContext,
): boolean {
  return ctx.hasPendingMessages();
}

export function getExtensionContextUsageFooter(
  ctx: ExtensionContext,
  promptCacheUsage?: TelegramPromptCacheUsageSnapshot,
): string | undefined {
  return typeof ctx.getContextUsage === "function"
    ? formatTelegramContextUsageFooter(ctx.getContextUsage(), promptCacheUsage)
    : undefined;
}

export function compactExtensionContext(
  ctx: ExtensionContext,
  callbacks: Parameters<ExtensionContext["compact"]>[0],
): ReturnType<ExtensionContext["compact"]> {
  return ctx.compact(callbacks);
}

/**
 * Fork-local workaround: inject a slash command into the host tmux pane that
 * runs the π REPL. π's `/new` (and `/resume`, etc.) is handled by the
 * interactive editor layer, not the extension command system, and
 * `pi.sendUserMessage` deliberately skips slash-command handling. The only
 * reliable way to trigger those built-ins from an extension context is to
 * send keystrokes to the host shell.
 *
 * The injection runs through `nohup bash -c 'sleep 1 && tmux send-keys ...'`
 * so it detaches from the current turn: the Telegram reply delivers first
 * and π swallows the keypress while idle. Failures are recorded as runtime
 * events; callers still see them as exceptions so the Telegram reply can
 * surface a clear error message.
 */
export interface TmuxSlashCommandInjectorOptions {
  exec: PiExtensionApiRuntimePorts["exec"];
  target: string;
  command: string;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export function createTmuxSlashCommandInjector(
  options: TmuxSlashCommandInjectorOptions,
): () => Promise<void> {
  const { exec, target, command, recordRuntimeEvent } = options;
  return async function injectTmuxSlashCommand(): Promise<void> {
    const script = `sleep 1 && tmux send-keys -t ${target} ${JSON.stringify(command)} Enter`;
    const result = await exec("nohup", ["bash", "-c", script]);
    if (result.code !== 0) {
      const error = new Error(
        `tmux send-keys failed (code ${result.code}): ${result.stderr || result.stdout || "unknown"}`,
      );
      recordRuntimeEvent?.("tmux_inject", error, { target, command });
      throw error;
    }
  };
}

export interface TmuxDynamicSlashCommandInjectorOptions {
  exec: PiExtensionApiRuntimePorts["exec"];
  target: string;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

/**
 * Variant of createTmuxSlashCommandInjector whose command + arg are decided
 * at call time. Used when the bridge needs to invoke an internal slash command
 * with a dynamic payload (e.g. /resume picking a specific session path).
 */
export function createTelegramResumeExecInjector(
  options: TmuxDynamicSlashCommandInjectorOptions,
): (sessionPath: string) => Promise<void> {
  const dynamic = createTmuxDynamicSlashCommandInjector(options);
  return function injectTelegramResumeExec(sessionPath: string) {
    return dynamic("/telegram-resume-exec", sessionPath);
  };
}

export function getExtensionContextSessionFile(
  ctx: ExtensionContext,
): string | undefined {
  return ctx.sessionManager.getSessionFile();
}

export function getExtensionContextSessionName(
  ctx: ExtensionContext,
): string | undefined {
  return ctx.sessionManager.getSessionName();
}

type WritableSessionInfoManager = ExtensionContext["sessionManager"] & {
  appendSessionInfo(name: string): string;
};

export function setExtensionContextSessionName(
  name: string,
  ctx: ExtensionContext,
): void {
  (ctx.sessionManager as WritableSessionInfoManager).appendSessionInfo(name);
}

export function createTmuxDynamicSlashCommandInjector(
  options: TmuxDynamicSlashCommandInjectorOptions,
): (command: string, arg?: string) => Promise<void> {
  const { exec, target, recordRuntimeEvent } = options;
  return async function injectTmuxSlashCommand(
    command: string,
    arg?: string,
  ): Promise<void> {
    const fullCommand = arg ? `${command} ${arg}` : command;
    const script = `sleep 1 && tmux send-keys -t ${target} ${JSON.stringify(fullCommand)} Enter`;
    const result = await exec("nohup", ["bash", "-c", script]);
    if (result.code !== 0) {
      const error = new Error(
        `tmux send-keys failed (code ${result.code}): ${result.stderr || result.stdout || "unknown"}`,
      );
      recordRuntimeEvent?.("tmux_inject", error, {
        target,
        command: fullCommand,
      });
      throw error;
    }
  };
}
