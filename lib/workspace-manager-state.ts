/**
 * Telegram workspace state persistence and session identity helpers
 * Zones: telegram controls, filesystem, pi agent
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { RpcChildSessionState } from "./rpc-child.ts";
import {
  createDefaultTelegramWorkspacesState,
  formatTelegramWorkspaceRecordDisplayName,
  normalizeTelegramWorkspacesState,
  type TelegramWorkspaceRecord,
  type TelegramWorkspacesState,
} from "./workspaces.ts";
import type {
  TelegramWorkspaceModelSelection,
  TelegramWorkspacePromptTurn,
  TelegramWorkspaceSessionIdentity,
  TelegramWorkspaceSessionReference,
} from "./workspace-manager-types.ts";

export function getTelegramWorkspacesStatePath(agentDir: string): string {
  return join(agentDir, "telegram-workspaces.json");
}

export async function readTelegramWorkspacesState(
  statePath: string,
  cwd: string,
  now: number,
): Promise<TelegramWorkspacesState> {
  if (!existsSync(statePath)) return createDefaultTelegramWorkspacesState(cwd, now);
  const raw = JSON.parse(await readFile(statePath, "utf8")) as unknown;
  return normalizeTelegramWorkspacesState(raw, cwd, now);
}

export function readTelegramWorkspacesStateSync(
  statePath: string,
  cwd: string,
  now: number,
): TelegramWorkspacesState {
  if (!existsSync(statePath)) return createDefaultTelegramWorkspacesState(cwd, now);
  const raw = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
  return normalizeTelegramWorkspacesState(raw, cwd, now);
}

export function serializeTelegramWorkspacesState(state: TelegramWorkspacesState): {
  version: 1;
  activeWorkspace: string;
  workspaces: Record<string, TelegramWorkspaceRecord>;
} {
  return {
    version: 1,
    activeWorkspace: state.activeWorkspace,
    workspaces: Object.fromEntries(
      Object.entries(state.workspaces).map(([name, record]) => [name, { ...record }]),
    ),
  };
}

export async function writeTelegramWorkspacesState(
  statePath: string,
  state: TelegramWorkspacesState,
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, JSON.stringify(serializeTelegramWorkspacesState(state), null, "\t") + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(tempPath, 0o600);
  await rename(tempPath, statePath);
  await chmod(statePath, 0o600);
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildTelegramWorkspacePromptText(turn: TelegramWorkspacePromptTurn): string {
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

export function parseTelegramWorkspaceModelSelection(
  value: unknown,
): TelegramWorkspaceModelSelection | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  return typeof raw.provider === "string" && typeof raw.id === "string"
    ? { provider: raw.provider, id: raw.id }
    : undefined;
}

export function applyRpcStateToRecord(
  record: TelegramWorkspaceRecord,
  state: RpcChildSessionState,
): void {
  const model = parseTelegramWorkspaceModelSelection(state.model);
  if (model) record.currentModel = model;
  if (typeof state.thinkingLevel === "string") {
    record.currentThinkingLevel = state.thinkingLevel;
  }
  if (state.sessionFile) record.sessionFile = state.sessionFile;
  if (state.sessionId) record.sessionId = state.sessionId;
  if (typeof state.messageCount === "number") {
    record.messageCount = Math.max(0, state.messageCount);
  }
  const sessionName =
    typeof state.sessionName === "string"
      ? state.sessionName.trim()
      : undefined;
  if (sessionName) {
    record.sessionName = sessionName;
  } else {
    delete record.sessionName;
  }
  if (state.isStreaming === true || state.isCompacting === true) {
    record.status = "running";
  } else if (record.status === "starting" || record.status === "running") {
    record.status = "idle";
  }
}

export function canonicalizeTelegramWorkspaceSessionFile(
  sessionFile: string | undefined,
): string | undefined {
  if (!sessionFile) return undefined;
  const resolved = resolve(sessionFile);
  if (!existsSync(resolved)) return resolved;
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function getTelegramWorkspaceSessionIdentity(
  value: Pick<TelegramWorkspaceSessionIdentity, "sessionFile" | "sessionId">,
): TelegramWorkspaceSessionIdentity {
  const sessionFile =
    typeof value.sessionFile === "string" && value.sessionFile
      ? value.sessionFile
      : undefined;
  const sessionId =
    typeof value.sessionId === "string" && value.sessionId
      ? value.sessionId
      : undefined;
  return {
    ...(sessionFile
      ? {
          sessionFile,
          canonicalSessionFile: canonicalizeTelegramWorkspaceSessionFile(sessionFile),
        }
      : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

export function isSameTelegramWorkspaceSessionIdentity(
  left: TelegramWorkspaceSessionIdentity,
  right: TelegramWorkspaceSessionIdentity,
): boolean {
  if (left.canonicalSessionFile && right.canonicalSessionFile) {
    return left.canonicalSessionFile === right.canonicalSessionFile;
  }
  if (left.sessionId && right.sessionId) {
    return left.sessionId === right.sessionId;
  }
  return false;
}

export function isSameTelegramWorkspaceSessionFile(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left || !right) return false;
  return isSameTelegramWorkspaceSessionIdentity(
    getTelegramWorkspaceSessionIdentity({ sessionFile: left }),
    getTelegramWorkspaceSessionIdentity({ sessionFile: right }),
  );
}

export function formatTelegramWorkspaceSessionOwner(record: TelegramWorkspaceRecord): string {
  const displayName = formatTelegramWorkspaceRecordDisplayName(record);
  const topicTitle = record.source?.kind === "telegram-topic"
    ? normalizeTelegramWorkspaceSessionName(record.source.topicTitle ?? "")
    : undefined;
  if (topicTitle && topicTitle !== displayName) return `${topicTitle} (${displayName})`;
  return displayName;
}

export function normalizeTelegramWorkspaceSessionName(name: string): string | undefined {
  const trimmed = name.trim();
  return trimmed ? trimmed : undefined;
}

export function getTelegramTopicSessionName(
  record: TelegramWorkspaceRecord,
): string | undefined {
  if (record.source?.kind !== "telegram-topic") return undefined;
  return normalizeTelegramWorkspaceSessionName(record.source.topicTitle ?? "");
}

export function canSwitchTelegramWorkspaceModel(record: TelegramWorkspaceRecord): boolean {
  return record.status !== "running" && record.status !== "starting";
}

export function getTelegramWorkspaceSessionReference(
  record: TelegramWorkspaceRecord,
  fallbackCwd?: string,
): TelegramWorkspaceSessionReference {
  const reference: TelegramWorkspaceSessionReference = {
    workspaceName: record.name,
    cwd: record.cwd || fallbackCwd || "",
    sessionFile: record.sessionFile,
    sessionId: record.sessionId,
    sessionName: record.sessionName,
  };
  if (record.currentModel) reference.currentModel = record.currentModel;
  return reference;
}

export function buildTelegramWorkspaceWorkerExtensionArgs(
  extensions: readonly string[],
): string[] {
  return extensions.flatMap((extensionPath) => ["--extension", extensionPath]);
}

export function getSortedTelegramWorkspaceRecords(
  state: TelegramWorkspacesState,
): TelegramWorkspaceRecord[] {
  return Object.values(state.workspaces).sort((a, b) => a.createdAt - b.createdAt);
}
