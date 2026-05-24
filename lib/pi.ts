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
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
  formatTelegramContextUsageFooter,
  type TelegramContextUsageSnapshot,
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

export interface PiTelegramTreeBranchMutators<TContext> {
  setBranchName(entryId: string, name: string | undefined, ctx: TContext): void;
  deleteBranch(entryId: string, ctx: TContext): void;
}

export const TELEGRAM_TREE_BRANCH_CURSOR_CUSTOM_TYPE = "pi-telegram:tree-branch-cursor";

export interface PiTelegramTreeBranchCursorResult {
  cancelled: false;
  markerId: string;
  text?: string;
}

export interface PiSessionSnapshotReference {
  cwd: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  currentModel?: { provider: string; id: string };
}

export interface PiSessionSnapshotReferenceOptions {
  contextWindow?: number;
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
    sendUserMessage: (content, options) => api.sendUserMessage(content, options),
    exec: (command, args, options) => api.exec(command, args, options),
    getCommands: () => api.getCommands(),
    getThinkingLevel: () => api.getThinkingLevel(),
    setThinkingLevel: (level) => api.setThinkingLevel(level),
    setModel: (model) => api.setModel(model),
  };
}

export function createTelegramTreeBranchMutators<TContext>(
  api: Pick<ExtensionAPI, "setLabel" | "appendEntry">,
  customType: string,
): PiTelegramTreeBranchMutators<TContext> {
  return {
    setBranchName(entryId, name) {
      api.setLabel(entryId, name);
    },
    deleteBranch(entryId) {
      api.appendEntry(customType, { leafId: entryId, deleted: true });
    },
  };
}

function textFromTreeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const raw = block as { type?: unknown; text?: unknown };
      return raw.type === "text" && typeof raw.text === "string"
        ? raw.text
        : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function getSessionEntryEditorText(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const raw = entry as {
    type?: unknown;
    message?: { role?: unknown; content?: unknown };
    content?: unknown;
  };
  if (raw.type === "message" && raw.message?.role === "user") {
    return textFromTreeContent(raw.message.content);
  }
  if (raw.type === "custom_message") return textFromTreeContent(raw.content);
  return undefined;
}

function getBranchCursorParentId(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const raw = entry as {
    id?: unknown;
    type?: unknown;
    parentId?: unknown;
    message?: { role?: unknown };
  };
  if (
    (raw.type === "message" && raw.message?.role === "user") ||
    raw.type === "custom_message"
  ) {
    return typeof raw.parentId === "string" ? raw.parentId : null;
  }
  return typeof raw.id === "string" ? raw.id : null;
}

export function createTelegramSessionFileTreeBranchCursor(
  reference: PiSessionSnapshotReference,
  entryId: string,
  customType = TELEGRAM_TREE_BRANCH_CURSOR_CUSTOM_TYPE,
): PiTelegramTreeBranchCursorResult {
  if (!reference.sessionFile) {
    throw new Error("Active tab has no session file.");
  }
  const sessionManager = SessionManager.open(
    reference.sessionFile,
    undefined,
    reference.cwd,
  );
  const entry = sessionManager.getEntry(entryId);
  if (!entry) throw new Error(`Entry ${entryId} not found.`);
  const branchFromId = getBranchCursorParentId(entry);
  if (branchFromId) sessionManager.branch(branchFromId);
  else sessionManager.resetLeaf();
  const markerId = sessionManager.appendCustomEntry(customType, {
    targetId: entryId,
    branchFromId,
    createdAt: new Date().toISOString(),
  });
  return {
    cancelled: false,
    markerId,
    text: getSessionEntryEditorText(entry),
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
    const script = `sleep 1 && tmux send-keys -t ${target} C-u ${JSON.stringify(command)} Enter`;
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

export function createTelegramTreeExecInjector(
  options: TmuxDynamicSlashCommandInjectorOptions,
): (entryId: string, summarize: boolean) => Promise<void> {
  const dynamic = createTmuxDynamicSlashCommandInjector(options);
  return function injectTelegramTreeExec(entryId: string, summarize: boolean) {
    return dynamic(
      "/telegram-tree-exec",
      `${entryId} ${summarize ? "summary" : "none"}`,
    );
  };
}

export function createTelegramDeleteCurrentSessionExecInjector(
  options: TmuxDynamicSlashCommandInjectorOptions,
): (expectedSessionPath: string) => Promise<void> {
  const dynamic = createTmuxDynamicSlashCommandInjector(options);
  return function injectTelegramDeleteCurrentSessionExec(expectedSessionPath: string) {
    return dynamic("/telegram-delete-current-session-exec", expectedSessionPath);
  };
}

export function getExtensionContextSessionFile(
  ctx: ExtensionContext,
): string | undefined {
  return ctx.sessionManager.getSessionFile();
}

export function getExtensionContextSessionDir(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionDir();
}

export function getExtensionContextSessionName(
  ctx: ExtensionContext,
): string | undefined {
  return ctx.sessionManager.getSessionName();
}

export function getExtensionContextSessionSnapshot(ctx: ExtensionContext) {
  return {
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionName: ctx.sessionManager.getSessionName(),
    leafId: ctx.sessionManager.getLeafId(),
    entries: ctx.sessionManager.getEntries(),
    branch: ctx.sessionManager.getBranch(),
    contextUsage: ctx.getContextUsage(),
  };
}

function getFiniteUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined;
}

function getLatestAssistantUsageTokens(entries: readonly unknown[]): number | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null) continue;
    if (Reflect.get(entry, "type") !== "message") continue;
    const message = Reflect.get(entry, "message");
    if (typeof message !== "object" || message === null) continue;
    if (Reflect.get(message, "role") !== "assistant") continue;
    const usage = Reflect.get(message, "usage");
    if (typeof usage !== "object" || usage === null) continue;
    const totalTokens = getFiniteUsageNumber(
      Reflect.get(usage, "totalTokens"),
    );
    if (totalTokens !== undefined && totalTokens > 0) return totalTokens;
    const parts = ["input", "output", "cacheRead", "cacheWrite"].map((key) =>
      getFiniteUsageNumber(Reflect.get(usage, key)) ?? 0,
    );
    const sum = parts.reduce((total, value) => total + value, 0);
    if (sum > 0) return sum;
  }
  return null;
}

export function deriveSessionContextUsageFromEntries(
  entries: readonly unknown[],
  contextWindow: number | undefined,
): TelegramContextUsageSnapshot | undefined {
  if (
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return undefined;
  }
  const tokens = getLatestAssistantUsageTokens(entries) ?? 0;
  return {
    tokens,
    contextWindow,
    percent: (tokens / contextWindow) * 100,
  };
}

export function getSessionSnapshotFromReference(
  reference: PiSessionSnapshotReference,
  options: PiSessionSnapshotReferenceOptions = {},
) {
  if (reference.sessionFile) {
    try {
      const sessionManager = SessionManager.open(
        reference.sessionFile,
        undefined,
        reference.cwd,
      );
      const entries = sessionManager.getEntries();
      const branch = sessionManager.getBranch();
      return {
        cwd: sessionManager.getCwd(),
        sessionId: sessionManager.getSessionId(),
        sessionFile: sessionManager.getSessionFile(),
        sessionName:
          reference.sessionName !== undefined
            ? reference.sessionName
            : sessionManager.getSessionName(),
        leafId: sessionManager.getLeafId(),
        entries,
        branch,
        contextUsage: deriveSessionContextUsageFromEntries(
          branch.length > 0 ? branch : entries,
          options.contextWindow,
        ),
      };
    } catch {
      // Fall through to a minimal snapshot so tab-owned menus do not drift
      // back to the parent session when a worker file is temporarily missing.
    }
  }
  return {
    cwd: reference.cwd,
    sessionId: reference.sessionId ?? "unknown",
    sessionFile: reference.sessionFile,
    sessionName: reference.sessionName,
    leafId: null,
    entries: [],
    branch: [],
    contextUsage: deriveSessionContextUsageFromEntries(
      [],
      options.contextWindow,
    ),
  };
}

export function createSessionSnapshotFromReferenceGetter<
  TContext,
  TReference extends PiSessionSnapshotReference = PiSessionSnapshotReference,
>(deps: {
  getContextWindow: (
    reference: TReference,
    ctx: TContext,
  ) => number | undefined;
}): (
  reference: TReference,
  ctx: TContext,
) => ReturnType<typeof getSessionSnapshotFromReference> {
  return (reference, ctx) =>
    getSessionSnapshotFromReference(reference, {
      contextWindow: deps.getContextWindow(reference, ctx),
    });
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
    const script = `sleep 1 && tmux send-keys -t ${target} C-u ${JSON.stringify(fullCommand)} Enter`;
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
