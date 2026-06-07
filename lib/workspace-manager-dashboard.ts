/**
 * Telegram workspace dashboard formatters and inline keyboard builders
 * Zones: telegram ui, workspace controls, callback routing
 */

import {
  formatTelegramWorkspaceDisplayName,
  formatTelegramWorkspaceFilterSummary,
  formatTelegramWorkspaceRecordDisplayName,
  formatTelegramWorkspaceStatusLabel,
  truncateTelegramWorkspaceText,
  TELEGRAM_DEFAULT_WORKSPACE_NAME,
  type TelegramWorkspaceFilterTraceItem,
  type TelegramWorkspaceRecord,
  type TelegramWorkspacesState,
} from "./workspaces.ts";
import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import type { TelegramTopicOrphanProof } from "./topic-orphans.ts";
import { getSortedTelegramWorkspaceRecords } from "./workspace-manager-state.ts";
import {
  normalizeTelegramWorkspaceSessionName,
} from "./workspace-manager-state.ts";
import type {
  TelegramWorkspaceDashboardMode,
  TelegramWorkspaceDashboardWorkerState,
} from "./workspace-manager-types.ts";

export function formatTelegramWorkspaceDashboardAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export function formatTelegramWorkspaceDashboardName(record: TelegramWorkspaceRecord): string {
  const name = record.sessionName?.trim();
  return name ? truncateTelegramWorkspaceText(name.replace(/\s+/g, " "), 36) : "unset";
}

export function formatTelegramWorkspaceDashboardLastMessage(record: TelegramWorkspaceRecord): string {
  const text = (record.lastMessageText ?? record.lastAssistantText)?.replace(/\s+/g, " ").trim();
  return text ? truncateTelegramWorkspaceText(text, 96) : "No messages yet.";
}

export function formatTelegramWorkspaceOrphanDetail(
  record: TelegramWorkspaceRecord,
  proof?: TelegramTopicOrphanProof,
): string {
  const details = [
    formatTelegramWorkspaceRecordDisplayName(record),
    record.source?.kind === "telegram-topic"
      ? `chat ${record.source.chatId}`
      : undefined,
    record.source?.kind === "telegram-topic" &&
      record.source.messageThreadId !== undefined
      ? `topic ${record.source.messageThreadId}`
      : undefined,
    record.source?.kind === "telegram-topic" && record.source.topicTitle
      ? `title ${record.source.topicTitle}`
      : undefined,
    record.sessionName ? `session ${record.sessionName}` : undefined,
    proof ? `proof ${proof.method}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return `- ${details.join(" · ")}`;
}

export function formatTelegramTopicRepairUsage(): string {
  return [
    "Usage:",
    "/topic orphans",
    "/topic cleanup",
    "",
    "Level 1 cleanup records only proven topic orphans from Bot API failures.",
  ].join("\n");
}

export function formatTelegramWorkspaceDashboardWorkerLabel(
  workerState: TelegramWorkspaceDashboardWorkerState | undefined,
): string | undefined {
  if (!workerState) return undefined;
  if (workerState === "running") return "worker running";
  if (workerState === "idle") return "worker idle";
  return "worker not started";
}

export function formatTelegramWorkspaceDashboardMeta(
  record: TelegramWorkspaceRecord,
  nowMs: number,
  workerState?: TelegramWorkspaceDashboardWorkerState,
): string {
  const age = formatTelegramWorkspaceDashboardAge(nowMs - record.createdAt);
  const messageCount = Math.max(0, record.messageCount ?? 0);
  return [
    formatTelegramWorkspaceRecordDisplayName(record),
    formatTelegramWorkspaceStatusLabel(record.status),
    formatTelegramWorkspaceDashboardWorkerLabel(workerState),
    age,
    `${messageCount}msg`,
    formatTelegramWorkspaceDashboardName(record),
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

export function getTelegramWorkspaceCloseableNames(state: TelegramWorkspacesState): string[] {
  return getSortedTelegramWorkspaceRecords(state)
    .filter((workspace) => workspace.name !== TELEGRAM_DEFAULT_WORKSPACE_NAME)
    .map((workspace) => workspace.name);
}

export function normalizeTelegramWorkspaceCloseSelection(
  state: TelegramWorkspacesState,
  selectedCloseWorkspaces: readonly string[],
): string[] {
  const closeable = new Set(getTelegramWorkspaceCloseableNames(state));
  const selected = new Set<string>();
  for (const name of selectedCloseWorkspaces) {
    if (closeable.has(name)) selected.add(name);
  }
  return [...selected];
}

export function formatTelegramWorkspaceDashboardSummary(
  state: TelegramWorkspacesState,
  unreadByWorkspace: Record<string, number>,
  maxWorkspaces: number,
  nowMs: number,
  mode: TelegramWorkspaceDashboardMode = "open",
  selectedCloseWorkspaces: readonly string[] = [],
  visibleWorkspaces?: readonly TelegramWorkspaceRecord[],
  filterTrace: readonly TelegramWorkspaceFilterTraceItem[] = [],
  forumNativeMode = false,
  workerCapacity?: { live: number; max: number },
  workerStateByWorkspace: Readonly<Record<string, TelegramWorkspaceDashboardWorkerState>> = {},
): string {
  const allWorkspaces = getSortedTelegramWorkspaceRecords(state);
  const workspaces = mode === "open" && visibleWorkspaces ? [...visibleWorkspaces] : allWorkspaces;
  const active = state.workspaces[state.activeWorkspace];
  const safeSelectedCloseWorkspaces = normalizeTelegramWorkspaceCloseSelection(
    state,
    selectedCloseWorkspaces,
  );
  const selectedSet = new Set(safeSelectedCloseWorkspaces);
  const unreadWorkspaces = allWorkspaces
    .filter((workspace) => (unreadByWorkspace[workspace.name] ?? 0) > 0)
    .map((workspace) =>
      `${formatTelegramWorkspaceRecordDisplayName(workspace)} ${unreadByWorkspace[workspace.name]}`
    );
  const filterSummary = mode === "open"
    ? formatTelegramWorkspaceFilterSummary(filterTrace)
    : undefined;
  const title = forumNativeMode ? "Forum topics" : "Workspaces";
  const currentLabel = forumNativeMode ? "Current" : "Active";
  const lines = [
    filterSummary
      ? `${title} ${workspaces.length}/${allWorkspaces.length} filtered (${allWorkspaces.length}/${maxWorkspaces} total)`
      : `${title} ${allWorkspaces.length}/${maxWorkspaces}`,
  ];
  if (workerCapacity) {
    lines.push(`Workers: ${workerCapacity.live}/${workerCapacity.max}`);
  }
  lines.push(
    active
      ? [
          `${currentLabel}: ${formatTelegramWorkspaceRecordDisplayName(active)}`,
          formatTelegramWorkspaceStatusLabel(active.status),
          `${Math.max(0, active.messageCount ?? 0)}msg`,
          formatTelegramWorkspaceDashboardName(active),
        ].join(" · ")
      : `${currentLabel}: ${formatTelegramWorkspaceDisplayName(state.activeWorkspace)}`,
  );
  if (active?.currentThinkingLevel) {
    lines.push(`Thinking: ${active.currentThinkingLevel}`);
  }
  if (filterSummary) lines.push(filterSummary);
  lines.push(`Unread: ${unreadWorkspaces.length > 0 ? unreadWorkspaces.join(", ") : "none"}`);
  if (mode === "close") {
    const runningSelected = workspaces
      .filter((workspace) =>
        selectedSet.has(workspace.name) &&
        (workspace.status === "running" || workspace.status === "starting")
      )
      .map((workspace) => formatTelegramWorkspaceRecordDisplayName(workspace));
    lines.push("Close mode: select workspaces to close.");
    lines.push(`Selected: ${safeSelectedCloseWorkspaces.length}`);
    lines.push("General is protected. Session files are kept.");
    if (runningSelected.length > 0) {
      lines.push(`Running selected: ${runningSelected.join(", ")} will be stopped.`);
    }
  }
  lines.push("");
  if (workspaces.length === 0) {
    lines.push("No workspaces match filters.");
  }
  for (const workspace of workspaces) {
    const marker = workspace.name === state.activeWorkspace ? "●" : "○";
    const unread = unreadByWorkspace[workspace.name] ? ` · unread ${unreadByWorkspace[workspace.name]}` : "";
    const closePrefix =
      mode === "close" && workspace.name !== TELEGRAM_DEFAULT_WORKSPACE_NAME
        ? `${selectedSet.has(workspace.name) ? "☑" : "☐"} `
        : "";
    const protectedLabel =
      mode === "close" && workspace.name === TELEGRAM_DEFAULT_WORKSPACE_NAME
        ? " · protected"
        : "";
    lines.push(
      `${closePrefix}${marker} ${formatTelegramWorkspaceDashboardMeta(workspace, nowMs, workerStateByWorkspace[workspace.name])}${unread}${protectedLabel}`,
      `  ↳ ${formatTelegramWorkspaceDashboardLastMessage(workspace)}`,
    );
  }
  return lines.join("\n");
}

export function formatTelegramWorkspaceButtonLabel(
  record: TelegramWorkspaceRecord,
  activeWorkspace: string,
  unreadCount: number,
): string {
  const active = record.name === activeWorkspace ? "● " : "";
  const unread = unreadCount > 0 ? ` ${unreadCount}` : "";
  const running = record.status === "running" || record.status === "starting"
    ? " ▶"
    : record.status === "error"
      ? " !"
      : "";
  return `${active}${formatTelegramWorkspaceRecordDisplayName(record)}${unread}${running}`;
}

export function encodeTelegramWorkspaceCallbackName(name: string): string {
  return encodeURIComponent(name).replace(/%20/g, "+");
}

export function decodeTelegramWorkspaceCallbackName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  try {
    return decodeURIComponent(name.replace(/\+/g, "%20"));
  } catch {
    return undefined;
  }
}

export function buildTelegramWorkspaceDashboardReplyMarkup(
  state: TelegramWorkspacesState,
  unreadByWorkspace: Record<string, number>,
  mode: TelegramWorkspaceDashboardMode = "open",
  selectedCloseWorkspaces: readonly string[] = [],
  visibleWorkspaces?: readonly TelegramWorkspaceRecord[],
  forumNativeMode = false,
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];
  const workspaces = mode === "open" && visibleWorkspaces
    ? [...visibleWorkspaces]
    : getSortedTelegramWorkspaceRecords(state);
  if (mode === "close") {
    const safeSelectedCloseWorkspaces = normalizeTelegramWorkspaceCloseSelection(
      state,
      selectedCloseWorkspaces,
    );
    const selectedSet = new Set(safeSelectedCloseWorkspaces);
    if (safeSelectedCloseWorkspaces.length > 0) {
      rows.push([
        {
          text: `Close ${safeSelectedCloseWorkspaces.length} selected`,
          callback_data: "workspace:close-selected",
        },
      ]);
    }
    const closeableNames = getTelegramWorkspaceCloseableNames(state);
    if (closeableNames.length > 0) {
      const controls = [
        { text: "Select all", callback_data: "workspace:close-select-all" },
      ];
      if (safeSelectedCloseWorkspaces.length > 0) {
        controls.push({ text: "Clear selection", callback_data: "workspace:close-clear" });
      }
      rows.push(controls);
    }
    for (let index = 0; index < workspaces.length; index += 2) {
      const row = workspaces.slice(index, index + 2).map((workspace) => {
        if (workspace.name === TELEGRAM_DEFAULT_WORKSPACE_NAME) {
          return {
            text: `${formatTelegramWorkspaceRecordDisplayName(workspace)} protected`,
            callback_data: "workspace:noop",
          };
        }
        const selected = selectedSet.has(workspace.name);
        return {
          text: `${selected ? "☑" : "☐"} ${formatTelegramWorkspaceRecordDisplayName(workspace)}`,
          callback_data: `workspace:close-toggle:${encodeTelegramWorkspaceCallbackName(workspace.name)}`,
        };
      });
      rows.push(row);
    }
    rows.push([{ text: "Done", callback_data: "workspace:close-done" }]);
    return { inline_keyboard: rows };
  }
  for (let index = 0; index < workspaces.length; index += 2) {
    const row = workspaces.slice(index, index + 2).map((workspace) => ({
      text: formatTelegramWorkspaceButtonLabel(
        workspace,
        state.activeWorkspace,
        unreadByWorkspace[workspace.name] ?? 0,
      ),
      callback_data:
        forumNativeMode || workspace.name === state.activeWorkspace
          ? "workspace:noop"
          : `workspace:switch:${encodeTelegramWorkspaceCallbackName(workspace.name)}`,
    }));
    rows.push(row);
  }
  if (visibleWorkspaces) {
    rows.push([{ text: "All workspaces", callback_data: "workspace:refresh" }]);
  }
  if (!forumNativeMode && getTelegramWorkspaceCloseableNames(state).length > 0) {
    rows.push([{ text: "Manage 🗑", callback_data: "workspace:close-manage" }]);
  }
  if (!forumNativeMode) {
    rows.push([
      {
        text: "Close",
        callback_data: `workspace:close:${encodeTelegramWorkspaceCallbackName(state.activeWorkspace)}`,
      },
    ]);
  }
  return { inline_keyboard: rows };
}

export function buildTelegramWorkspaceMultiCloseConfirmationText(
  state: TelegramWorkspacesState,
  selectedCloseWorkspaces: readonly string[],
): string {
  const selected = normalizeTelegramWorkspaceCloseSelection(state, selectedCloseWorkspaces);
  const workspaces = selected
    .map((name) => state.workspaces[name])
    .filter((workspace): workspace is TelegramWorkspaceRecord => workspace !== undefined);
  const shown = workspaces.slice(0, 5).map((workspace) =>
    `- ${formatTelegramWorkspaceRecordDisplayName(workspace)} · ${formatTelegramWorkspaceStatusLabel(workspace.status)}`
  );
  const more = workspaces.length > shown.length
    ? [`- ...and ${workspaces.length - shown.length} more`]
    : [];
  const hasRunning = workspaces.some((workspace) =>
    workspace.status === "running" || workspace.status === "starting"
  );
  return [
    `Close ${workspaces.length} selected workspace${workspaces.length === 1 ? "" : "s"}?`,
    "",
    ...shown,
    ...more,
    "",
    "Session files are kept.",
    ...(hasRunning ? ["Running workspaces will be stopped."] : []),
  ].join("\n");
}

export function buildTelegramWorkspaceMultiCloseConfirmationReplyMarkup(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "No", callback_data: "workspace:close-cancel" },
        { text: "Close selected", callback_data: "workspace:close-confirm" },
      ],
    ],
  };
}

export function buildTelegramWorkspaceConfirmReplyMarkup(
  action: "abort" | "close",
  workspaceName: string,
): TelegramInlineKeyboardMarkup {
  const encoded = encodeTelegramWorkspaceCallbackName(workspaceName);
  return {
    inline_keyboard: [
      [
        { text: action === "abort" ? "Confirm Abort" : "Confirm Close", callback_data: `workspace:${action}:do:${encoded}` },
      ],
      [{ text: "Cancel", callback_data: "workspace:refresh" }],
    ],
  };
}
