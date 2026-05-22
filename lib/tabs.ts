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
}

export type TelegramTabCommand =
  | { kind: "list" }
  | { kind: "new"; name: string }
  | { kind: "rename"; oldName?: string; newName: string }
  | { kind: "switch"; name: string }
  | { kind: "close"; name: string; force: boolean }
  | { kind: "status"; name?: string }
  | { kind: "abort"; name?: string }
  | { kind: "restart"; name: string }
  | { kind: "usage" }
  | { kind: "invalid"; message: string };

export const TELEGRAM_DEFAULT_TAB_NAME = "default";
export const TELEGRAM_TAB_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

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

export function isValidTelegramTabName(name: string): boolean {
  return TELEGRAM_TAB_NAME_PATTERN.test(name);
}

export function validateTelegramTabName(name: string): string | undefined {
  if (!name) return "Tab name is required.";
  if (!isValidTelegramTabName(name)) {
    return "Tab names may use only A-Z, a-z, 0-9, _ and -, up to 32 characters.";
  }
  return undefined;
}

export function findTelegramTabNameCaseConflict(
  tabs: Record<string, TelegramTabRecord>,
  name: string,
): string | undefined {
  const lowerName = name.toLowerCase();
  return Object.keys(tabs).find(
    (existing) => existing !== name && existing.toLowerCase() === lowerName,
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
      if (!isValidTelegramTabName(name) || !isTelegramTabRecord(record)) {
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

export function parseTelegramTabCommand(args: string): TelegramTabCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const [head, ...tail] = tokens;
  if (!head) return { kind: "list" };
  if (!TELEGRAM_TAB_COMMAND_WORDS.has(head)) {
    return { kind: "switch", name: head };
  }
  switch (head) {
    case "list":
      return { kind: "list" };
    case "new": {
      const [name] = tail;
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
      return {
        kind: "invalid",
        message: "Usage: /tab rename [old-name] <new-name>",
      };
    }
    case "switch": {
      const [name] = tail;
      if (!name) {
        return { kind: "invalid", message: "Usage: /tab switch <name>" };
      }
      return { kind: "switch", name };
    }
    case "close": {
      const [name] = tail;
      if (!name) {
        return { kind: "invalid", message: "Usage: /tab close <name>" };
      }
      return { kind: "close", name, force: tail.includes("--force") };
    }
    case "status": {
      const [name] = tail;
      return name ? { kind: "status", name } : { kind: "status" };
    }
    case "abort": {
      const [name] = tail;
      return name ? { kind: "abort", name } : { kind: "abort" };
    }
    case "restart": {
      const [name] = tail;
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
    "/tab <name>",
    "/tab close <name> [--force]",
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

export function formatTelegramTabList(
  state: TelegramTabsState,
  unreadByTab: Record<string, number>,
  now: number,
): string {
  const rows = Object.values(state.tabs)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((tab) => {
      const active = tab.name === state.activeTab ? " *" : "";
      const unread = unreadByTab[tab.name] ? " unread" : "";
      const age = tab.lastAgentStartAt
        ? ` ${formatTelegramTabAge(now - tab.lastAgentStartAt)}`
        : "";
      const error = tab.lastError ? ` (${tab.lastError})` : "";
      return `- ${tab.name}${active} ${tab.status}${age}${unread}${error}`;
    });
  return ["Tabs:", ...rows].join("\n");
}

export function formatTelegramTabStatus(
  tab: TelegramTabRecord,
  unreadCount: number,
  now: number,
): string {
  const lines = [
    `Tab: ${tab.name}`,
    `Status: ${tab.status}`,
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
