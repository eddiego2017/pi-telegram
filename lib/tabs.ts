/**
 * Telegram tab state and command helpers
 * Zones: telegram controls, concurrent tabs, shared utils
 * Owns tab-name validation, durable tab records, command parsing, and compact status formatting
 */

export type TelegramTabStatus =
  | "idle"
  | "starting"
  | "running"
  | "exited"
  | "error";

export interface TelegramTabsState {
  version: 1;
  activeTab: string;
  tabs: Record<string, TelegramTabRecord>;
}

export interface TelegramTabRecord {
  name: string;
  cwd: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  currentModel?: { provider: string; id: string };
  currentThinkingLevel?: string;
  createdAt: number;
  lastUsedAt: number;
  status: TelegramTabStatus;
  lastError?: string;
  lastAgentStartAt?: number;
  lastAgentEndAt?: number;
  lastAssistantText?: string;
  lastMessageText?: string;
  lastMessageAt?: number;
  messageCount?: number;
}

export type TelegramTabCommand =
  | { kind: "list" }
  | { kind: "new"; name: string }
  | { kind: "rename"; oldName?: string; newName: string }
  | { kind: "query"; query: string; filters: string[] }
  | { kind: "switch"; name: string }
  | { kind: "close"; name?: string; force: boolean }
  | { kind: "status"; name?: string }
  | { kind: "abort"; name?: string }
  | { kind: "restart"; name: string }
  | { kind: "usage" }
  | { kind: "invalid"; message: string };

export const TELEGRAM_DEFAULT_TAB_NAME = "default";
export const TELEGRAM_TAB_NAME_PATTERN = /^[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*$/;
export const TELEGRAM_TAB_NAME_MAX_LENGTH = 32;

export interface TelegramTabFilterTraceItem {
  filter: string;
  before: number;
  after: number;
}

const TELEGRAM_TAB_COMMAND_WORDS = new Set([
  "abort",
  "close",
  "list",
  "new",
  "rename",
  "restart",
  "status",
  "switch",
]);

function cleanTelegramTabText(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function normalizeTelegramTabFilterText(s: string): string {
  return cleanTelegramTabText(s.normalize("NFKC")).toLowerCase();
}

export function normalizeTelegramTabName(name: string): string {
  return cleanTelegramTabText(name);
}

export function isValidTelegramTabName(name: string): boolean {
  const normalized = normalizeTelegramTabName(name);
  return (
    normalized.length > 0 &&
    normalized.length <= TELEGRAM_TAB_NAME_MAX_LENGTH &&
    TELEGRAM_TAB_NAME_PATTERN.test(normalized)
  );
}

export function validateTelegramTabName(name: string): string | undefined {
  const normalized = normalizeTelegramTabName(name);
  if (!normalized) return "Tab name is required.";
  if (normalized.length > TELEGRAM_TAB_NAME_MAX_LENGTH) {
    return `Tab names may be up to ${TELEGRAM_TAB_NAME_MAX_LENGTH} characters.`;
  }
  if (!isValidTelegramTabName(normalized)) {
    return "Tab names may use only A-Z, a-z, 0-9, _, -, and single spaces between words.";
  }
  return undefined;
}

export function findTelegramTabNameCaseConflict(
  tabs: Record<string, TelegramTabRecord>,
  name: string,
): string | undefined {
  const normalizedName = normalizeTelegramTabName(name);
  const lowerName = normalizedName.toLowerCase();
  return Object.keys(tabs).find(
    (existing) => existing !== normalizedName && existing.toLowerCase() === lowerName,
  );
}

export function createTelegramDefaultTabRecord(
  cwd: string,
  now: number,
): TelegramTabRecord {
  return {
    name: TELEGRAM_DEFAULT_TAB_NAME,
    cwd,
    createdAt: now,
    lastUsedAt: now,
    status: "idle",
  };
}

export function createDefaultTelegramTabsState(
  cwd: string,
  now: number,
): TelegramTabsState {
  return {
    version: 1,
    activeTab: TELEGRAM_DEFAULT_TAB_NAME,
    tabs: {
      [TELEGRAM_DEFAULT_TAB_NAME]: createTelegramDefaultTabRecord(cwd, now),
    },
  };
}

function isTelegramTabRecord(value: unknown): value is TelegramTabRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.cwd === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.lastUsedAt === "number"
  );
}

export function normalizeTelegramTabsState(
  value: unknown,
  cwd: string,
  now: number,
): TelegramTabsState {
  if (typeof value !== "object" || value === null) {
    return createDefaultTelegramTabsState(cwd, now);
  }
  const raw = value as {
    version?: unknown;
    activeTab?: unknown;
    tabs?: unknown;
  };
  const tabs: Record<string, TelegramTabRecord> = {};
  if (raw.tabs && typeof raw.tabs === "object") {
    for (const [name, record] of Object.entries(raw.tabs)) {
      const normalizedName = normalizeTelegramTabName(name);
      if (
        name !== normalizedName ||
        !isValidTelegramTabName(name) ||
        !isTelegramTabRecord(record)
      ) {
        continue;
      }
      tabs[name] = {
        ...record,
        name,
        status: record.status === "running" ? "exited" : record.status,
      };
    }
  }
  if (!tabs[TELEGRAM_DEFAULT_TAB_NAME]) {
    tabs[TELEGRAM_DEFAULT_TAB_NAME] = createTelegramDefaultTabRecord(cwd, now);
  }
  const activeTab =
    typeof raw.activeTab === "string" && tabs[raw.activeTab]
      ? raw.activeTab
      : TELEGRAM_DEFAULT_TAB_NAME;
  return {
    version: 1,
    activeTab,
    tabs,
  };
}

export function parseTelegramTabFilterTokens(args: string): string[] {
  return args
    .split(/\s+/)
    .map((token) => cleanTelegramTabText(token))
    .filter((token) => normalizeTelegramTabFilterText(token).length > 0);
}

function buildTelegramTabRecordSearchText(tab: TelegramTabRecord): string {
  return normalizeTelegramTabFilterText(
    [
      tab.name,
      tab.sessionName,
      tab.status,
      tab.currentModel ? `${tab.currentModel.provider}/${tab.currentModel.id}` : undefined,
      tab.lastMessageText,
      tab.lastAssistantText,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export function filterTelegramTabRecords(
  tabs: readonly TelegramTabRecord[],
  filters: readonly string[],
): { tabs: TelegramTabRecord[]; trace: TelegramTabFilterTraceItem[] } {
  let filtered = [...tabs];
  const trace: TelegramTabFilterTraceItem[] = [];
  for (const rawFilter of filters) {
    const normalizedFilter = normalizeTelegramTabFilterText(rawFilter);
    if (!normalizedFilter) continue;
    const before = filtered.length;
    filtered = filtered.filter((tab) =>
      buildTelegramTabRecordSearchText(tab).includes(normalizedFilter)
    );
    trace.push({ filter: cleanTelegramTabText(rawFilter), before, after: filtered.length });
  }
  return { tabs: filtered, trace };
}

export function parseTelegramTabCommand(args: string): TelegramTabCommand {
  const cleanedArgs = cleanTelegramTabText(args);
  const tokens = cleanedArgs.split(/\s+/).filter(Boolean);
  const [head, ...tail] = tokens;
  if (!head) return { kind: "list" };
  if (!TELEGRAM_TAB_COMMAND_WORDS.has(head)) {
    return {
      kind: "query",
      query: cleanedArgs,
      filters: parseTelegramTabFilterTokens(cleanedArgs),
    };
  }
  switch (head) {
    case "list":
      return { kind: "list" };
    case "new": {
      const name = normalizeTelegramTabName(tail.join(" "));
      if (!name) return { kind: "invalid", message: "Usage: /tab new <name>" };
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
        return { kind: "rename", newName: normalizeTelegramTabName(tail.join(" ")) };
      }
      return {
        kind: "invalid",
        message: "Usage: /tab rename [old-name] <new-name>",
      };
    }
    case "switch": {
      const name = normalizeTelegramTabName(tail.join(" "));
      if (!name) {
        return { kind: "invalid", message: "Usage: /tab switch <name>" };
      }
      return { kind: "switch", name };
    }
    case "close": {
      const force = tail.includes("--force");
      const name = normalizeTelegramTabName(
        tail.filter((token) => token !== "--force").join(" "),
      );
      return name ? { kind: "close", name, force } : { kind: "close", force };
    }
    case "status": {
      const name = normalizeTelegramTabName(tail.join(" "));
      return name ? { kind: "status", name } : { kind: "status" };
    }
    case "abort": {
      const name = normalizeTelegramTabName(tail.join(" "));
      return name ? { kind: "abort", name } : { kind: "abort" };
    }
    case "restart": {
      const name = normalizeTelegramTabName(tail.join(" "));
      if (!name) {
        return { kind: "invalid", message: "Usage: /tab restart <name>" };
      }
      return { kind: "restart", name };
    }
  }
  return { kind: "usage" };
}

export function formatTelegramTabUsage(): string {
  return [
    "Usage:",
    "/tab",
    "/tab new <name>",
    "/tab rename [old-name] <new-name>",
    "/tab <name-or-filter...>",
    "/tab close [name] [--force]",
    "/tab status [name]",
    "/tab abort [name]",
    "/tab restart <name>",
  ].join("\n");
}

export function truncateTelegramTabText(text: string, limit = 1200): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function formatTelegramTabAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export function formatTelegramTabStatusLabel(status: TelegramTabStatus): string {
  return status === "exited" ? "stopped" : status;
}

export function formatTelegramTabFilterSummary(
  filterTrace: readonly TelegramTabFilterTraceItem[],
): string | undefined {
  if (filterTrace.length === 0) return undefined;
  return `Filters: ${filterTrace
    .map((item) => `${item.filter} ${item.before}→${item.after}`)
    .join(", ")}`;
}

export function formatTelegramTabList(
  state: TelegramTabsState,
  unreadByTab: Record<string, number>,
  now: number,
  options: {
    tabs?: readonly TelegramTabRecord[];
    filterTrace?: readonly TelegramTabFilterTraceItem[];
  } = {},
): string {
  const allTabs = Object.values(state.tabs).sort((a, b) => a.createdAt - b.createdAt);
  const visibleTabs = options.tabs ? [...options.tabs] : allTabs;
  const filterSummary = formatTelegramTabFilterSummary(options.filterTrace ?? []);
  const rows = visibleTabs.map((tab) => {
    const active = tab.name === state.activeTab ? " *" : "";
    const unread = unreadByTab[tab.name] ? " unread" : "";
    const age = tab.lastAgentStartAt
      ? ` ${formatTelegramTabAge(now - tab.lastAgentStartAt)}`
      : "";
    const error = tab.lastError ? ` (${tab.lastError})` : "";
    return `- ${tab.name}${active} ${formatTelegramTabStatusLabel(tab.status)}${age}${unread}${error}`;
  });
  const title = filterSummary
    ? `Tabs (${visibleTabs.length}/${allTabs.length}):`
    : "Tabs:";
  return [
    title,
    ...(filterSummary ? [filterSummary] : []),
    ...(rows.length > 0 ? rows : ["No tabs match filters."]),
  ].join("\n");
}

export function formatTelegramTabStatus(
  tab: TelegramTabRecord,
  unreadCount: number,
  now: number,
): string {
  const lines = [
    `Tab: ${tab.name}`,
    `Status: ${formatTelegramTabStatusLabel(tab.status)}`,
    `Cwd: ${tab.cwd}`,
    `Unread events: ${unreadCount}`,
  ];
  if (tab.sessionFile) lines.push(`Session: ${tab.sessionFile}`);
  if (tab.sessionName) lines.push(`Name: ${tab.sessionName}`);
  if (tab.lastAgentStartAt) {
    lines.push(`Last start: ${formatTelegramTabAge(now - tab.lastAgentStartAt)} ago`);
  }
  if (tab.lastAgentEndAt) {
    lines.push(`Last end: ${formatTelegramTabAge(now - tab.lastAgentEndAt)} ago`);
  }
  if (tab.lastError) lines.push(`Error: ${tab.lastError}`);
  if (tab.lastAssistantText) {
    lines.push("", "Last reply:", truncateTelegramTabText(tab.lastAssistantText));
  }
  return lines.join("\n");
}
