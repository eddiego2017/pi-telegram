/**
 * Telegram transcript dump export helpers
 * Zones: session transcript, export files, gist publishing
 * Owns active-branch User/Agent transcript extraction, TXT file generation, Telegram document sending, and secret Gist publishing.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { buildTelegramMultipartReplyParameters } from "./replies.ts";

export interface TelegramDumpContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
}

export interface TelegramDumpMessage {
  role?: string;
  content?: string | TelegramDumpContentBlock[];
}

export interface TelegramDumpSessionEntry {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  message?: TelegramDumpMessage;
}

export interface TelegramDumpSnapshot {
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  branch: TelegramDumpSessionEntry[];
}

export interface TelegramDumpScope {
  turnLimit?: number;
}

export type TelegramDumpTranscriptRole = "user" | "agent";

export interface TelegramDumpTranscriptRow {
  entryId: string;
  timestamp?: string;
  role: TelegramDumpTranscriptRole;
  text: string;
}

export interface TelegramDumpTranscriptStats {
  totalTurns: number;
  selectedTurns: number;
  totalMessages: number;
  selectedMessages: number;
  chars: number;
}

export interface TelegramDumpTranscript {
  rows: TelegramDumpTranscriptRow[];
  text: string;
  stats: TelegramDumpTranscriptStats;
  scopeLabel: string;
  fileBaseName: string;
}

export interface TelegramDumpExportFileSet {
  txtPath: string;
  fileBaseName: string;
  messageCount: number;
  turnCount: number;
  chars: number;
}

export interface TelegramDumpGistPublishResult {
  gistId: string;
  htmlUrl: string;
  rawUrl: string;
  fileName: string;
}

export interface TelegramDumpExportFileSenderDeps {
  sendMultipart: <TResponse>(
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
  ) => Promise<TResponse>;
}

function getTelegramAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
}

function getTelegramDumpExportTempDir(): string {
  return join(getTelegramAgentDir(), "tmp", "telegram-dump");
}

function getTelegramDumpGistTokenPath(): string {
  return process.env.PI_TELEGRAM_GIST_PAT_PATH?.trim()
    || join(homedir(), ".pi", "credentials", "github-gist-pat");
}

function sanitizeFileSegment(value: string | undefined, fallback: string): string {
  const safe = (value ?? "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return safe || fallback;
}

function escapeGistDescription(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 140);
}

function contentText(content: string | TelegramDumpContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function cleanUserText(text: string): string {
  return text
    .replace(/^\[telegram[^\]]*\]\s*/i, "")
    .replace(/\n\[(?:reply|attachments|outputs)[^\n]*\][\s\S]*$/i, "")
    .trim();
}

function collectAllTranscriptRows(
  snapshot: TelegramDumpSnapshot,
): TelegramDumpTranscriptRow[] {
  const rows: TelegramDumpTranscriptRow[] = [];
  for (const entry of snapshot.branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message) continue;
    if (message.role === "user") {
      const text = cleanUserText(contentText(message.content));
      rows.push({
        entryId: entry.id,
        timestamp: entry.timestamp,
        role: "user",
        text: text || "(empty user message)",
      });
      continue;
    }
    if (message.role === "assistant") {
      const text = contentText(message.content).trim();
      if (!text) continue;
      rows.push({
        entryId: entry.id,
        timestamp: entry.timestamp,
        role: "agent",
        text,
      });
    }
  }
  return rows;
}

function countUserTurns(rows: readonly TelegramDumpTranscriptRow[]): number {
  return rows.filter((row) => row.role === "user").length;
}

function selectRowsForScope(
  rows: readonly TelegramDumpTranscriptRow[],
  scope: TelegramDumpScope,
): TelegramDumpTranscriptRow[] {
  const limit = scope.turnLimit;
  if (!limit || limit <= 0) return [...rows];
  let seenTurns = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.role !== "user") continue;
    seenTurns += 1;
    if (seenTurns === limit) return rows.slice(index);
  }
  return [...rows];
}

function formatIsoTimestamp(value = Date.now()): string {
  return new Date(value).toISOString();
}

function formatFileTimestamp(value = Date.now()): string {
  const iso = new Date(value).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 16).replace(":", "")}`;
}

function formatScopeLabel(scope: TelegramDumpScope): string {
  return scope.turnLimit && scope.turnLimit > 0
    ? `last ${scope.turnLimit} turns`
    : "all turns";
}

function formatRoleLabel(role: TelegramDumpTranscriptRole): string {
  return role === "user" ? "User" : "Agent";
}

function formatTranscriptRow(row: TelegramDumpTranscriptRow): string {
  return `${formatRoleLabel(row.role)}: ${row.text}`;
}

function buildTranscriptFileBaseName(
  snapshot: TelegramDumpSnapshot,
  scope: TelegramDumpScope,
  now = Date.now,
): string {
  const session = sanitizeFileSegment(snapshot.sessionName || snapshot.sessionId, "session");
  const range = scope.turnLimit && scope.turnLimit > 0 ? `last${scope.turnLimit}` : "all";
  return `pi-dump-${session}-${range}-${formatFileTimestamp(now())}`;
}

export function buildTelegramDumpTranscript(
  snapshot: TelegramDumpSnapshot,
  scope: TelegramDumpScope = {},
  options?: { now?: () => number },
): TelegramDumpTranscript {
  const now = options?.now ?? Date.now;
  const allRows = collectAllTranscriptRows(snapshot);
  const rows = selectRowsForScope(allRows, scope);
  const scopeLabel = formatScopeLabel(scope);
  const stats: TelegramDumpTranscriptStats = {
    totalTurns: countUserTurns(allRows),
    selectedTurns: countUserTurns(rows),
    totalMessages: allRows.length,
    selectedMessages: rows.length,
    chars: rows.reduce((sum, row) => sum + row.text.length, 0),
  };
  const name = snapshot.sessionName?.trim();
  const header = [
    "# π transcript",
    "",
    `Session: ${name || snapshot.sessionId}`,
    `Session ID: ${snapshot.sessionId}`,
    snapshot.sessionFile ? `File: ${snapshot.sessionFile}` : undefined,
    `CWD: ${snapshot.cwd}`,
    `Scope: active branch, ${scopeLabel}`,
    `Generated: ${formatIsoTimestamp(now())}`,
    "",
  ].filter((line): line is string => typeof line === "string");
  const body = rows.length > 0
    ? rows.map(formatTranscriptRow).join("\n\n")
    : "(no visible User/Agent messages)";
  const text = `${header.join("\n")}${body}\n`;
  return {
    rows,
    text,
    stats,
    scopeLabel,
    fileBaseName: buildTranscriptFileBaseName(snapshot, scope, now),
  };
}

export async function renderTelegramDumpExportFiles(
  snapshot: TelegramDumpSnapshot,
  scope: TelegramDumpScope = {},
  options?: { outputDir?: string; now?: () => number },
): Promise<TelegramDumpExportFileSet> {
  const outputDir = options?.outputDir ?? getTelegramDumpExportTempDir();
  await mkdir(outputDir, { recursive: true });
  const transcript = buildTelegramDumpTranscript(snapshot, scope, { now: options?.now });
  const fileBaseName = `${transcript.fileBaseName}-${randomUUID().slice(0, 8)}`;
  const txtPath = join(outputDir, `${fileBaseName}.txt`);
  await writeFile(txtPath, transcript.text, "utf8");
  return {
    txtPath,
    fileBaseName,
    messageCount: transcript.stats.selectedMessages,
    turnCount: transcript.stats.selectedTurns,
    chars: transcript.stats.chars,
  };
}

export function createTelegramDumpExportFileSender(
  deps: TelegramDumpExportFileSenderDeps,
): (
  chatId: number,
  replyToMessageId: number,
  files: TelegramDumpExportFileSet,
) => Promise<void> {
  return async function sendTelegramDumpExportFiles(chatId, replyToMessageId, files) {
    const replyParameters = buildTelegramMultipartReplyParameters(replyToMessageId);
    const caption = `Transcript TXT (${files.turnCount} turns, ${files.messageCount} messages)`;
    await deps.sendMultipart(
      "sendDocument",
      {
        chat_id: String(chatId),
        caption,
        ...(replyParameters ? { reply_parameters: replyParameters } : {}),
      },
      "document",
      files.txtPath,
      `${files.fileBaseName}.txt`,
    );
  };
}

function sanitizeGistFileName(snapshot: TelegramDumpSnapshot, scope: TelegramDumpScope): string {
  const session = sanitizeFileSegment(snapshot.sessionName || snapshot.sessionId, "session");
  const range = scope.turnLimit && scope.turnLimit > 0 ? `last${scope.turnLimit}` : "all";
  return `pi-dump-${session}-${range}.txt`;
}

interface GitHubGistApiResponse {
  id?: string;
  html_url?: string;
  files?: Record<string, { raw_url?: string }>;
  message?: string;
}

async function readTelegramDumpGistToken(tokenPath: string): Promise<string> {
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!token) throw new Error("GitHub Gist token file is empty.");
  return token;
}

export async function publishTelegramDumpGist(
  snapshot: TelegramDumpSnapshot,
  scope: TelegramDumpScope = {},
  options?: { tokenPath?: string; public?: boolean; now?: () => number },
): Promise<TelegramDumpGistPublishResult> {
  const tokenPath = options?.tokenPath ?? getTelegramDumpGistTokenPath();
  const token = await readTelegramDumpGistToken(tokenPath);
  const fileName = sanitizeGistFileName(snapshot, scope);
  const transcript = buildTelegramDumpTranscript(snapshot, scope, { now: options?.now });
  const response = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "pi-telegram-dump-export",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      description: escapeGistDescription(`pi transcript: ${snapshot.sessionId}`),
      public: options?.public ?? false,
      files: {
        [fileName]: { content: transcript.text },
      },
    }),
  });
  const body = await response.json().catch(() => ({})) as GitHubGistApiResponse;
  if (!response.ok) {
    throw new Error(body.message || `GitHub Gist API failed (${response.status}).`);
  }
  const gistId = body.id;
  const htmlUrl = body.html_url;
  const rawUrl = body.files?.[fileName]?.raw_url
    ?? Object.values(body.files ?? {}).find((file) => file.raw_url)?.raw_url;
  if (!gistId || !htmlUrl || !rawUrl) {
    throw new Error("GitHub Gist API response did not include expected URLs.");
  }
  return { gistId, htmlUrl, rawUrl, fileName };
}

export async function deleteTelegramDumpGist(
  gistId: string,
  options?: { tokenPath?: string },
): Promise<void> {
  const safeGistId = gistId.trim();
  if (!/^[a-f0-9]+$/i.test(safeGistId)) throw new Error("Invalid Gist id.");
  const tokenPath = options?.tokenPath ?? getTelegramDumpGistTokenPath();
  const token = await readTelegramDumpGistToken(tokenPath);
  const response = await fetch(`https://api.github.com/gists/${safeGistId}`, {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "pi-telegram-dump-export",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 204 || response.status === 404) return;
  const body = await response.json().catch(() => ({})) as { message?: string };
  throw new Error(body.message || `GitHub Gist delete failed (${response.status}).`);
}
