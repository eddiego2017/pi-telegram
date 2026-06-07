/**
 * Telegram workspace state and command helpers
 * Zones: telegram controls, concurrent workspaces, shared utils
 * Owns workspace-name validation, durable workspace records, command parsing, and compact status formatting.
 */

export type TelegramWorkspaceStatus =
  | "idle"
  | "starting"
  | "running"
  | "exited"
  | "error";

export interface TelegramWorkspacesState {
  version: 1;
  activeWorkspace: string;
  workspaces: Record<string, TelegramWorkspaceRecord>;
}

export interface TelegramWorkspaceSourceTelegramTopic {
  kind: "telegram-topic";
  chatId: number;
  messageThreadId?: number;
  topicTitle?: string;
}

export type TelegramWorkspaceSource = TelegramWorkspaceSourceTelegramTopic;

export interface TelegramWorkspaceRecord {
  name: string;
  cwd: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  currentModel?: { provider: string; id: string };
  currentThinkingLevel?: string;
  createdAt: number;
  lastUsedAt: number;
  status: TelegramWorkspaceStatus;
  lastError?: string;
  lastAgentStartAt?: number;
  lastAgentEndAt?: number;
  lastAssistantText?: string;
  lastMessageText?: string;
  lastMessageAt?: number;
  messageCount?: number;
  source?: TelegramWorkspaceSource;
}

export type TelegramWorkspaceCommand =
  | { kind: "list" }
  | { kind: "new"; name: string }
  | { kind: "rename"; oldName?: string; newName: string }
  | { kind: "syncNames" }
  | { kind: "query"; query: string; filters: string[] }
  | { kind: "switch"; name: string }
  | { kind: "close"; name?: string; force: boolean }
  | { kind: "status"; name?: string }
  | { kind: "abort"; name?: string }
  | { kind: "restart"; name: string }
  | { kind: "usage" }
  | { kind: "invalid"; message: string };

export const TELEGRAM_DEFAULT_WORKSPACE_NAME = "general";
export const TELEGRAM_GENERAL_WORKSPACE_DISPLAY_NAME = "General";
export const TELEGRAM_WORKSPACE_NAME_PATTERN = /^[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*$/;
export const TELEGRAM_WORKSPACE_NAME_MAX_LENGTH = 32;
const TELEGRAM_TOPIC_WORKSPACE_HASH_MODULUS = 36 ** 6;

export interface TelegramWorkspaceFilterTraceItem {
  filter: string;
  before: number;
  after: number;
}

const TELEGRAM_WORKSPACE_COMMAND_WORDS = new Set([
  "abort",
  "close",
  "list",
  "new",
  "rename",
  "restart",
  "status",
  "sync-names",
  "switch",
]);

function cleanTelegramWorkspaceText(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function normalizeTelegramWorkspaceFilterText(s: string): string {
  return cleanTelegramWorkspaceText(s.normalize("NFKC")).toLowerCase();
}

export function normalizeTelegramWorkspaceName(name: string): string {
  return cleanTelegramWorkspaceText(name);
}

export function formatTelegramWorkspaceDisplayName(name: string): string {
  return name === TELEGRAM_DEFAULT_WORKSPACE_NAME
    ? TELEGRAM_GENERAL_WORKSPACE_DISPLAY_NAME
    : name;
}

export function formatTelegramWorkspaceRecordDisplayName(
  workspace: Pick<TelegramWorkspaceRecord, "name">,
): string {
  return formatTelegramWorkspaceDisplayName(workspace.name);
}

export function isValidTelegramWorkspaceName(name: string): boolean {
  const normalized = normalizeTelegramWorkspaceName(name);
  return (
    normalized.length > 0 &&
    normalized.length <= TELEGRAM_WORKSPACE_NAME_MAX_LENGTH &&
    TELEGRAM_WORKSPACE_NAME_PATTERN.test(normalized)
  );
}

export function validateTelegramWorkspaceName(name: string): string | undefined {
  const normalized = normalizeTelegramWorkspaceName(name);
  if (!normalized) return "Workspace name is required.";
  if (normalized.length > TELEGRAM_WORKSPACE_NAME_MAX_LENGTH) {
    return `Workspace names may be up to ${TELEGRAM_WORKSPACE_NAME_MAX_LENGTH} characters.`;
  }
  if (!isValidTelegramWorkspaceName(normalized)) {
    return "Workspace names may use only A-Z, a-z, 0-9, _, -, and single spaces between words.";
  }
  return undefined;
}

export function findTelegramWorkspaceNameCaseConflict(
  workspaces: Record<string, TelegramWorkspaceRecord>,
  name: string,
): string | undefined {
  const normalizedName = normalizeTelegramWorkspaceName(name);
  const lowerName = normalizedName.toLowerCase();
  return Object.keys(workspaces).find(
    (existing) => existing !== normalizedName && existing.toLowerCase() === lowerName,
  );
}

function hashTelegramTopicChatId(chatId: number): string {
  let hash = 2166136261;
  const input = String(chatId);
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash % TELEGRAM_TOPIC_WORKSPACE_HASH_MODULUS)
    .toString(36)
    .padStart(6, "0");
}

export function normalizeTelegramTopicWorkspaceName(
  chatId: number,
  messageThreadId: number,
): string {
  return `tg-${hashTelegramTopicChatId(chatId)}-${messageThreadId.toString(36)}`;
}

export function findTelegramWorkspaceByTopic(
  workspaces: Record<string, TelegramWorkspaceRecord>,
  chatId: number,
  messageThreadId: number,
): TelegramWorkspaceRecord | undefined {
  return Object.values(workspaces).find(
    (workspace) =>
      workspace.source?.kind === "telegram-topic" &&
      workspace.source.chatId === chatId &&
      workspace.source.messageThreadId === messageThreadId,
  );
}

export function isTelegramTopicWorkspaceRecord(
  workspace: TelegramWorkspaceRecord,
): boolean {
  return workspace.source?.kind === "telegram-topic";
}

export function formatTelegramWorkspaceTopicLabel(
  workspace: TelegramWorkspaceRecord,
): string | undefined {
  if (workspace.source?.kind !== "telegram-topic") return undefined;
  const title = workspace.source.topicTitle?.trim();
  const topic = workspace.source.messageThreadId === undefined
    ? "General"
    : `topic #${workspace.source.messageThreadId}`;
  return title ? `${title} · ${topic}` : topic;
}

export function createTelegramDefaultWorkspaceRecord(
  cwd: string,
  now: number,
): TelegramWorkspaceRecord {
  return {
    name: TELEGRAM_DEFAULT_WORKSPACE_NAME,
    cwd,
    createdAt: now,
    lastUsedAt: now,
    status: "idle",
  };
}

export function createDefaultTelegramWorkspacesState(
  cwd: string,
  now: number,
): TelegramWorkspacesState {
  return {
    version: 1,
    activeWorkspace: TELEGRAM_DEFAULT_WORKSPACE_NAME,
    workspaces: {
      [TELEGRAM_DEFAULT_WORKSPACE_NAME]: createTelegramDefaultWorkspaceRecord(cwd, now),
    },
  };
}

function isTelegramWorkspaceSource(value: unknown): value is TelegramWorkspaceSource {
  if (typeof value !== "object" || value === null) return false;
  const source = value as Record<string, unknown>;
  return (
    source.kind === "telegram-topic" &&
    typeof source.chatId === "number" &&
    (source.messageThreadId === undefined ||
      typeof source.messageThreadId === "number") &&
    (source.topicTitle === undefined || typeof source.topicTitle === "string")
  );
}

function normalizeTelegramWorkspaceSource(
  source: unknown,
): TelegramWorkspaceSource | undefined {
  if (!isTelegramWorkspaceSource(source)) return undefined;
  return {
    kind: "telegram-topic",
    chatId: source.chatId,
    ...(source.messageThreadId !== undefined
      ? { messageThreadId: source.messageThreadId }
      : {}),
    ...(source.topicTitle ? { topicTitle: source.topicTitle } : {}),
  };
}

function isTelegramWorkspaceRecord(value: unknown): value is TelegramWorkspaceRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.cwd === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.lastUsedAt === "number"
  );
}

export function normalizeTelegramWorkspacesState(
  value: unknown,
  cwd: string,
  now: number,
): TelegramWorkspacesState {
  if (typeof value !== "object" || value === null) {
    return createDefaultTelegramWorkspacesState(cwd, now);
  }
  const raw = value as {
    version?: unknown;
    activeWorkspace?: unknown;
    workspaces?: unknown;
  };
  const rawWorkspaces = raw.workspaces;
  const rawActiveWorkspace = raw.activeWorkspace;
  const workspaces: Record<string, TelegramWorkspaceRecord> = {};
  if (rawWorkspaces && typeof rawWorkspaces === "object") {
    for (const [name, record] of Object.entries(rawWorkspaces)) {
      const normalizedName = normalizeTelegramWorkspaceName(name);
      if (
        name !== normalizedName ||
        !isValidTelegramWorkspaceName(name) ||
        !isTelegramWorkspaceRecord(record)
      ) {
        continue;
      }
      const source = normalizeTelegramWorkspaceSource(record.source);
      const { source: _discardedSource, ...rest } = record;
      workspaces[name] = {
        ...rest,
        name,
        status: record.status === "running" ? "exited" : record.status,
        ...(source ? { source } : {}),
      };
    }
  }
  if (!workspaces[TELEGRAM_DEFAULT_WORKSPACE_NAME]) {
    workspaces[TELEGRAM_DEFAULT_WORKSPACE_NAME] = createTelegramDefaultWorkspaceRecord(cwd, now);
  }
  const activeWorkspace =
    typeof rawActiveWorkspace === "string" && workspaces[rawActiveWorkspace]
      ? rawActiveWorkspace
      : TELEGRAM_DEFAULT_WORKSPACE_NAME;
  return {
    version: 1,
    activeWorkspace,
    workspaces,
  };
}

export function parseTelegramWorkspaceFilterTokens(args: string): string[] {
  return args
    .split(/\s+/)
    .map((token) => cleanTelegramWorkspaceText(token))
    .filter((token) => normalizeTelegramWorkspaceFilterText(token).length > 0);
}

function buildTelegramWorkspaceRecordSearchText(workspace: TelegramWorkspaceRecord): string {
  return normalizeTelegramWorkspaceFilterText(
    [
      workspace.name,
      workspace.sessionName,
      workspace.status,
      workspace.currentModel ? `${workspace.currentModel.provider}/${workspace.currentModel.id}` : undefined,
      workspace.lastMessageText,
      workspace.lastAssistantText,
      workspace.source?.kind === "telegram-topic"
        ? [
            "telegram-topic",
            String(workspace.source.chatId),
            workspace.source.messageThreadId === undefined
              ? "general"
              : String(workspace.source.messageThreadId),
            workspace.source.topicTitle,
          ]
            .filter(Boolean)
            .join(" ")
        : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export function filterTelegramWorkspaceRecords(
  workspaces: readonly TelegramWorkspaceRecord[],
  filters: readonly string[],
): { workspaces: TelegramWorkspaceRecord[]; trace: TelegramWorkspaceFilterTraceItem[] } {
  let filtered = [...workspaces];
  const trace: TelegramWorkspaceFilterTraceItem[] = [];
  for (const rawFilter of filters) {
    const normalizedFilter = normalizeTelegramWorkspaceFilterText(rawFilter);
    if (!normalizedFilter) continue;
    const before = filtered.length;
    filtered = filtered.filter((workspace) =>
      buildTelegramWorkspaceRecordSearchText(workspace).includes(normalizedFilter)
    );
    trace.push({ filter: cleanTelegramWorkspaceText(rawFilter), before, after: filtered.length });
  }
  return { workspaces: filtered, trace };
}

export function parseTelegramWorkspaceCommand(
  args: string,
  commandName = "/workspace",
): TelegramWorkspaceCommand {
  const cleanedArgs = cleanTelegramWorkspaceText(args);
  const tokens = cleanedArgs.split(/\s+/).filter(Boolean);
  const [head, ...tail] = tokens;
  if (!head) return { kind: "list" };
  if (!TELEGRAM_WORKSPACE_COMMAND_WORDS.has(head)) {
    return {
      kind: "query",
      query: cleanedArgs,
      filters: parseTelegramWorkspaceFilterTokens(cleanedArgs),
    };
  }
  switch (head) {
    case "list":
      return { kind: "list" };
    case "new": {
      const name = normalizeTelegramWorkspaceName(tail.join(" "));
      if (!name) return { kind: "invalid", message: `Usage: ${commandName} new <name>` };
      return { kind: "new", name };
    }
    case "rename": {
      if (tail.length === 1) {
        return { kind: "rename", newName: tail[0]! };
      }
      if (tail.length === 2) {
        return { kind: "rename", oldName: tail[0]!, newName: tail[1]! };
      }
      if (tail.length > 2) {
        return { kind: "rename", newName: normalizeTelegramWorkspaceName(tail.join(" ")) };
      }
      return {
        kind: "invalid",
        message: `Usage: ${commandName} rename [old-name] <new-name>`,
      };
    }
    case "switch": {
      const name = normalizeTelegramWorkspaceName(tail.join(" "));
      if (!name) {
        return { kind: "invalid", message: `Usage: ${commandName} switch <name>` };
      }
      return { kind: "switch", name };
    }
    case "close": {
      const force = tail.includes("--force");
      const name = normalizeTelegramWorkspaceName(
        tail.filter((token) => token !== "--force").join(" "),
      );
      return name ? { kind: "close", name, force } : { kind: "close", force };
    }
    case "status": {
      const name = normalizeTelegramWorkspaceName(tail.join(" "));
      return name ? { kind: "status", name } : { kind: "status" };
    }
    case "abort": {
      const name = normalizeTelegramWorkspaceName(tail.join(" "));
      return name ? { kind: "abort", name } : { kind: "abort" };
    }
    case "restart": {
      const name = normalizeTelegramWorkspaceName(tail.join(" "));
      if (!name) {
        return { kind: "invalid", message: `Usage: ${commandName} restart <name>` };
      }
      return { kind: "restart", name };
    }
    case "sync-names":
      return { kind: "syncNames" };
  }
  return { kind: "usage" };
}

export function formatTelegramWorkspaceUsage(commandName = "/workspace"): string {
  return [
    "Usage:",
    commandName,
    `${commandName} new <name>`,
    `${commandName} rename [old-name] <new-name>`,
    `${commandName} <name-or-filter...>`,
    `${commandName} close [name] [--force]`,
    `${commandName} status [name]`,
    `${commandName} abort [name]`,
    `${commandName} restart <name>`,
    `${commandName} sync-names`,
  ].join("\n");
}

export function truncateTelegramWorkspaceText(text: string, limit = 1200): string {
  if (text.length <= limit) return text;
  const bodyLimit = Math.max(0, limit - 1);
  let body = "";
  for (const char of text) {
    if (body.length + char.length > bodyLimit) break;
    body += char;
  }
  return `${body.trimEnd()}…`;
}

function formatTelegramWorkspaceAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export function formatTelegramWorkspaceStatusLabel(status: TelegramWorkspaceStatus): string {
  return status === "exited" ? "stopped" : status;
}

export function formatTelegramWorkspaceFilterSummary(
  filterTrace: readonly TelegramWorkspaceFilterTraceItem[],
): string | undefined {
  if (filterTrace.length === 0) return undefined;
  return `Filters: ${filterTrace
    .map((item) => `${item.filter} ${item.before}→${item.after}`)
    .join(", ")}`;
}

export function formatTelegramWorkspaceList(
  state: TelegramWorkspacesState,
  unreadByWorkspace: Record<string, number>,
  now: number,
  options: {
    workspaces?: readonly TelegramWorkspaceRecord[];
    filterTrace?: readonly TelegramWorkspaceFilterTraceItem[];
    title?: string;
    emptyText?: string;
  } = {},
): string {
  const allWorkspaces = Object.values(state.workspaces).sort((a, b) => a.createdAt - b.createdAt);
  const visibleWorkspaces = options.workspaces ? [...options.workspaces] : allWorkspaces;
  const filterSummary = formatTelegramWorkspaceFilterSummary(options.filterTrace ?? []);
  const rows = visibleWorkspaces.map((workspace) => {
    const displayName = formatTelegramWorkspaceRecordDisplayName(workspace);
    const active = workspace.name === state.activeWorkspace ? " *" : "";
    const unread = unreadByWorkspace[workspace.name] ? " unread" : "";
    const topic = formatTelegramWorkspaceTopicLabel(workspace);
    const topicSuffix = topic ? ` · ${topic}` : "";
    const age = workspace.lastAgentStartAt
      ? ` ${formatTelegramWorkspaceAge(now - workspace.lastAgentStartAt)}`
      : "";
    const error = workspace.lastError ? ` (${workspace.lastError})` : "";
    return `- ${displayName}${active}${topicSuffix} ${formatTelegramWorkspaceStatusLabel(workspace.status)}${age}${unread}${error}`;
  });
  const baseTitle = options.title ?? "Workspaces";
  const title = filterSummary
    ? `${baseTitle} (${visibleWorkspaces.length}/${allWorkspaces.length}):`
    : `${baseTitle}:`;
  return [
    title,
    ...(filterSummary ? [filterSummary] : []),
    ...(rows.length > 0 ? rows : [options.emptyText ?? "No workspaces match filters."]),
  ].join("\n");
}

export function formatTelegramWorkspaceStatus(
  workspace: TelegramWorkspaceRecord,
  unreadCount: number,
  now: number,
  options: { label?: string } = {},
): string {
  const label = options.label ?? "Workspace";
  const lines = [
    `${label}: ${formatTelegramWorkspaceRecordDisplayName(workspace)}`,
    `Status: ${formatTelegramWorkspaceStatusLabel(workspace.status)}`,
    `Cwd: ${workspace.cwd}`,
    `Unread events: ${unreadCount}`,
  ];
  const topic = formatTelegramWorkspaceTopicLabel(workspace);
  if (topic) lines.push(`Topic: ${topic}`);
  if (workspace.sessionFile) lines.push(`Session: ${workspace.sessionFile}`);
  if (workspace.sessionName) lines.push(`Name: ${workspace.sessionName}`);
  if (workspace.lastAgentStartAt) {
    lines.push(`Last start: ${formatTelegramWorkspaceAge(now - workspace.lastAgentStartAt)} ago`);
  }
  if (workspace.lastAgentEndAt) {
    lines.push(`Last end: ${formatTelegramWorkspaceAge(now - workspace.lastAgentEndAt)} ago`);
  }
  if (workspace.lastError) lines.push(`Error: ${workspace.lastError}`);
  if (workspace.lastAssistantText) {
    lines.push("", "Last reply:", truncateTelegramWorkspaceText(workspace.lastAssistantText));
  }
  return lines.join("\n");
}
