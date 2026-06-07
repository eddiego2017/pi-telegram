/**
 * Telegram session center UI helpers
 * Zones: telegram controls, session history, menu composition
 * Owns the Telegram-native /session dashboard, active-branch history pager, and session callback dispatching.
 */

import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";

const TELEGRAM_SESSION_STATE_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_SESSION_HISTORY_PAGE_SIZE = 10;
const TELEGRAM_SESSION_SUMMARY_LEN = 54;
const TELEGRAM_SESSION_HISTORY_TABLE_WIDTH = 37;
const TELEGRAM_SESSION_HISTORY_ROLE_WIDTH = 9;
const TELEGRAM_SESSION_DETAIL_TEXT_LEN = 3000;
const TELEGRAM_SESSION_REPLAY_FULL_MESSAGE_CAP = 80;
const TELEGRAM_SESSION_GRAPHEME_SEGMENTER =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

export type TelegramSessionReplyMarkup = TelegramInlineKeyboardMarkup;
export type TelegramSessionView = "main" | "history" | "detail" | "deleteConfirm";

export interface TelegramSessionContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface TelegramSessionUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

export interface TelegramSessionContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  arguments?: Record<string, unknown>;
  data?: string;
  mimeType?: string;
  path?: string;
  source?: string;
  url?: string;
}

export interface TelegramSessionMessage {
  role?: string;
  content?: string | TelegramSessionContentBlock[];
  timestamp?: number;
  usage?: TelegramSessionUsage;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  errorMessage?: string;
  stopReason?: string;
  provider?: string;
  model?: string;
}

export interface TelegramSessionEntry {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  message?: TelegramSessionMessage;
  name?: string;
  customType?: string;
  content?: string | TelegramSessionContentBlock[];
  display?: boolean;
}

export interface TelegramSessionSnapshot {
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  entries: TelegramSessionEntry[];
  branch: TelegramSessionEntry[];
  contextUsage?: TelegramSessionContextUsage;
}

export interface TelegramSessionHistoryItem {
  entryId: string;
  globalIndex: number;
  timestamp?: string;
  role: "user" | "assistant" | "tool" | "custom";
  title: string;
  summary: string;
  detail: string;
  toolCallCount: number;
  tokenOutput?: number;
}

export type TelegramSessionReplayMode = "last5" | "full";
export type TelegramSessionReplayRole = "user" | "agent" | "tool" | "custom" | "system";

export interface TelegramSessionReplayAttachment {
  path: string;
  fileName: string;
  mimeType?: string;
}

export interface TelegramSessionReplayMessage {
  entryId: string;
  timestamp?: string;
  role: TelegramSessionReplayRole;
  text: string;
  attachments: TelegramSessionReplayAttachment[];
}

export interface TelegramSessionReplayTurn {
  user: TelegramSessionReplayMessage;
  messages: TelegramSessionReplayMessage[];
}

export interface TelegramSessionReplayPlan {
  mode: TelegramSessionReplayMode;
  turns: TelegramSessionReplayTurn[];
  messages: TelegramSessionReplayMessage[];
  totalTurns: number;
  totalMessages: number;
  capped: boolean;
  cap: number;
}

export interface TelegramSessionStats {
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  toolCalls: number;
  totalMessages: number;
  totalEntries: number;
  branchEntries: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCost: number;
}

export interface TelegramSessionMenuState {
  chatId: number;
  messageId: number;
  view: TelegramSessionView;
  page: number;
  detailIndex?: number;
  updatedAt: number;
}

export interface TelegramSessionMenuStore {
  get(messageId: number | undefined): TelegramSessionMenuState | undefined;
  set(state: TelegramSessionMenuState): void;
  clear(): void;
}

export function createTelegramSessionMenuStore(
  now: () => number = Date.now,
): TelegramSessionMenuStore {
  const states = new Map<number, TelegramSessionMenuState>();
  function pruneExpired(): void {
    const cutoff = now() - TELEGRAM_SESSION_STATE_TTL_MS;
    for (const [messageId, state] of states.entries()) {
      if (state.updatedAt < cutoff) states.delete(messageId);
    }
  }
  return {
    get(messageId) {
      if (typeof messageId !== "number") return undefined;
      pruneExpired();
      return states.get(messageId);
    },
    set(state) {
      pruneExpired();
      states.set(state.messageId, state);
    },
    clear() {
      states.clear();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cleanText(s: string): string {
  return s
    .replace(/^\[telegram\]\s*/i, "")
    .replace(/\n\[reply\][\s\S]*$/i, "")
    .replace(/\n\[attachments\][\s\S]*$/i, "")
    .replace(/\n\[outputs\][\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, n: number): string {
  const clean = cleanText(s);
  if (clean.length <= n) return clean;
  return clean.slice(0, Math.max(0, n - 1)) + "…";
}

function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(n));
}

function formatMoney(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatContextUsage(usage: TelegramSessionContextUsage | undefined): string {
  if (!usage) return "unknown";
  const total = formatCount(usage.contextWindow);
  const used = usage.tokens === null ? "?" : formatCount(usage.tokens);
  const pct = usage.percent === null ? "?" : `${usage.percent.toFixed(1)}%`;
  return `${used}/${total} · ${pct}`;
}

function shortSessionFile(file: string | undefined): string {
  if (!file) return "In-memory";
  const home = process.env.HOME;
  if (home && file.startsWith(`${home}/`)) return `~/${file.slice(home.length + 1)}`;
  return file;
}

function contentText(content: TelegramSessionMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/[?#].*$/, "");
  return normalized.split("/").filter(Boolean).pop() || "image";
}

function joinAttachmentPath(baseDir: string | undefined, itemPath: string): string {
  const trimmed = itemPath.trim();
  if (baseDir) {
    return `${baseDir.replace(/[\\/]+$/, "")}/${trimmed.replace(/^[\\/]+/, "")}`;
  }
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed;
  }
  return trimmed;
}

function isReplayImagePath(path: string): boolean {
  const normalized = path.replace(/[?#].*$/, "").toLowerCase();
  return (
    normalized.endsWith(".jpg") ||
    normalized.endsWith(".jpeg") ||
    normalized.endsWith(".png") ||
    normalized.endsWith(".webp") ||
    normalized.endsWith(".gif")
  );
}

function normalizeReplayFileUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith("file://")) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return undefined;
    return value;
  }
  try {
    return decodeURIComponent(value.slice("file://".length));
  } catch {
    return value.slice("file://".length);
  }
}

function splitReplayShellWords(command: string): string[] {
  const words: string[] = [];
  const normalized = command.replace(/\\\r?\n/g, " ");
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (quote === '"' && char === "\\") {
        const next = normalized[i + 1];
        if (next !== undefined) {
          current += next;
          i += 1;
        }
        continue;
      }
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\") {
      const next = normalized[i + 1];
      if (next !== undefined) {
        current += next;
        i += 1;
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function stripCurlFormFileOptions(path: string): string {
  const optionIndex = path.search(/;(?=(?:type|filename|headers|encoder)=)/i);
  return (optionIndex === -1 ? path : path.slice(0, optionIndex)).trim();
}

function parseReplaySendPhotoCommand(command: string): TelegramSessionReplayAttachment[] {
  const attachments: TelegramSessionReplayAttachment[] = [];
  if (!command.includes("sendPhoto")) return attachments;
  const words = splitReplayShellWords(command);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    let formValue: string | undefined;
    if (word === "-F" || word === "--form" || word === "--form-string") {
      formValue = words[i + 1];
      i += 1;
    } else if (word.startsWith("-F") && word.length > 2) {
      formValue = word.slice(2);
    } else if (word.startsWith("--form=")) {
      formValue = word.slice("--form=".length);
    }
    const photoPath = formValue?.match(/^photo=@(.+)$/)?.[1];
    if (!photoPath) continue;
    const path = stripCurlFormFileOptions(photoPath);
    if (!path || !isReplayImagePath(path)) continue;
    attachments.push({ path, fileName: fileNameFromPath(path) });
  }
  return attachments;
}

function parseReplayAttachmentSection(text: string): TelegramSessionReplayAttachment[] {
  const attachments: TelegramSessionReplayAttachment[] = [];
  let readingAttachments = false;
  let attachmentDir: string | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const attachmentMatch = trimmed.match(/^\[attachments\](?:\s+(.+))?$/i);
    if (attachmentMatch) {
      readingAttachments = true;
      attachmentDir = attachmentMatch[1]?.trim();
      continue;
    }
    if (readingAttachments && /^\[[^\]]+\](?:\s+.*)?$/i.test(trimmed)) break;
    if (!readingAttachments) continue;
    const itemPath = trimmed.match(/^- (.+)$/)?.[1]?.trim();
    if (!itemPath) continue;
    const path = joinAttachmentPath(attachmentDir, itemPath);
    if (!isReplayImagePath(path)) continue;
    attachments.push({ path, fileName: fileNameFromPath(path) });
  }
  return attachments;
}

function replayAttachmentFromImageBlock(
  block: TelegramSessionContentBlock,
): TelegramSessionReplayAttachment | undefined {
  if (block.type !== "image") return undefined;
  const path =
    block.path ??
    normalizeReplayFileUrl(block.url) ??
    normalizeReplayFileUrl(block.source);
  if (!path) return undefined;
  const isImageMime = block.mimeType?.toLowerCase().startsWith("image/") ?? false;
  if (!isImageMime && !isReplayImagePath(path)) return undefined;
  return { path, fileName: fileNameFromPath(path), mimeType: block.mimeType };
}

function replayAttachmentsFromContent(
  content: TelegramSessionMessage["content"],
): TelegramSessionReplayAttachment[] {
  const attachments: TelegramSessionReplayAttachment[] = [];
  const seen = new Set<string>();
  const add = (attachment: TelegramSessionReplayAttachment) => {
    if (seen.has(attachment.path)) return;
    seen.add(attachment.path);
    attachments.push(attachment);
  };
  if (typeof content === "string") {
    parseReplayAttachmentSection(content).forEach(add);
    return attachments;
  }
  if (!Array.isArray(content)) return attachments;
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      parseReplayAttachmentSection(block.text).forEach(add);
      continue;
    }
    if (block?.type === "toolCall" && typeof block.arguments?.command === "string") {
      parseReplaySendPhotoCommand(block.arguments.command).forEach(add);
      continue;
    }
    const imageAttachment = replayAttachmentFromImageBlock(block);
    if (imageAttachment) add(imageAttachment);
  }
  return attachments;
}

function appendReplayAttachments(
  target: TelegramSessionReplayAttachment[],
  attachments: readonly TelegramSessionReplayAttachment[],
): void {
  const seen = new Set(target.map((attachment) => attachment.path));
  for (const attachment of attachments) {
    if (seen.has(attachment.path)) continue;
    seen.add(attachment.path);
    target.push(attachment);
  }
}

function countToolCalls(message: TelegramSessionMessage | undefined): number {
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((block) => block?.type === "toolCall").length;
}

function usageValue(value: number | undefined): number {
  return Number.isFinite(value) ? value ?? 0 : 0;
}

export function buildTelegramSessionStats(
  snapshot: TelegramSessionSnapshot,
): TelegramSessionStats {
  const stats: TelegramSessionStats = {
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    toolCalls: 0,
    totalMessages: 0,
    totalEntries: snapshot.entries.length,
    branchEntries: snapshot.branch.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
  for (const entry of snapshot.entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message) continue;
    if (message.role === "user") stats.userMessages += 1;
    else if (message.role === "assistant") stats.assistantMessages += 1;
    else if (message.role === "toolResult") stats.toolResults += 1;
    else continue;
    stats.totalMessages += 1;
    stats.toolCalls += countToolCalls(message);
    if (message.role === "assistant" && message.usage) {
      stats.inputTokens += usageValue(message.usage.input);
      stats.outputTokens += usageValue(message.usage.output);
      stats.cacheReadTokens += usageValue(message.usage.cacheRead);
      stats.cacheWriteTokens += usageValue(message.usage.cacheWrite);
      stats.totalTokens += usageValue(message.usage.totalTokens);
      stats.totalCost += usageValue(message.usage.cost?.total);
    }
  }
  if (stats.totalTokens === 0) {
    stats.totalTokens =
      stats.inputTokens +
      stats.outputTokens +
      stats.cacheReadTokens +
      stats.cacheWriteTokens;
  }
  return stats;
}

export function buildTelegramSessionHistoryItems(
  snapshot: TelegramSessionSnapshot,
): TelegramSessionHistoryItem[] {
  const items: TelegramSessionHistoryItem[] = [];
  snapshot.branch.forEach((entry) => {
    if (entry.type === "message") {
      const message = entry.message;
      if (!message) return;
      if (message.role === "user") {
        const detail = contentText(message.content) || "(empty user message)";
        items.push({
          entryId: entry.id,
          globalIndex: items.length + 1,
          timestamp: entry.timestamp,
          role: "user",
          title: "👤 User",
          summary: truncate(detail, TELEGRAM_SESSION_SUMMARY_LEN),
          detail,
          toolCallCount: 0,
        });
        return;
      }
      if (message.role === "assistant") {
        const text = contentText(message.content);
        if (!text) return;
        const toolCallCount = countToolCalls(message);
        items.push({
          entryId: entry.id,
          globalIndex: items.length + 1,
          timestamp: entry.timestamp,
          role: "assistant",
          title: "🤖 Assistant",
          summary: truncate(text, TELEGRAM_SESSION_SUMMARY_LEN),
          detail: text,
          toolCallCount,
          tokenOutput: message.usage?.output,
        });
        return;
      }
      return;
    }
    if (entry.type === "custom_message" && entry.display !== false) {
      const detail = contentText(entry.content) || `custom: ${entry.customType ?? "message"}`;
      items.push({
        entryId: entry.id,
        globalIndex: items.length + 1,
        timestamp: entry.timestamp,
        role: "custom",
        title: "🧩 Custom",
        summary: truncate(detail, TELEGRAM_SESSION_SUMMARY_LEN),
        detail,
        toolCallCount: 0,
      });
    }
  });
  return items;
}

function stripTelegramPromptPrefix(text: string): string {
  return text.replace(/^\[telegram\]\s*/i, "").trim();
}

function cleanReplayUserText(text: string): string {
  return stripTelegramPromptPrefix(text)
    .replace(/\n\[(?:reply|attachments|outputs)\][\s\S]*$/i, "")
    .trim();
}

function fencedReplayBlock(text: string, language = ""): string {
  const fence = text.includes("```") ? "````" : "```";
  const suffix = text.endsWith("\n") ? "" : "\n";
  return `${fence}${language}\n${text}${suffix}${fence}`;
}

function stringifyReplayValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderReplayToolCallBlock(block: TelegramSessionContentBlock): string {
  const name = block.name?.trim() || "tool";
  const argsText = stringifyReplayValue(block.arguments);
  if (!argsText) return `🔧 Tool call: ${name}`;
  return `🔧 Tool call: ${name}\n${fencedReplayBlock(argsText, "json")}`;
}

function renderReplayContentBlock(block: TelegramSessionContentBlock): string {
  const type = block.type ?? "block";
  if (type === "text") return block.text ?? "";
  if (type === "thinking") {
    const text = block.thinking ?? block.text ?? "";
    return text ? `💭 Thinking\n${fencedReplayBlock(text)}` : "";
  }
  if (type === "toolCall") return renderReplayToolCallBlock(block);
  if (type === "toolResult" || type === "tool_result") {
    const text = block.text ?? block.data ?? stringifyReplayValue(block);
    return text ? `🧰 Tool result\n${fencedReplayBlock(text)}` : "🧰 Tool result";
  }
  if (type === "image" || type === "file") {
    const target = block.path ?? block.url ?? block.source ?? block.mimeType ?? "attached content";
    return `[${type}: ${target}]`;
  }
  const text = block.text ?? block.thinking ?? block.data;
  if (text) return `[${type}]\n${String(text)}`;
  return `[${type}]\n${fencedReplayBlock(stringifyReplayValue(block), "json")}`;
}

function fullReplayContentText(content: TelegramSessionMessage["content"]): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map(renderReplayContentBlock)
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function fullReplayMessageRole(role: string | undefined): TelegramSessionReplayRole {
  if (role === "user") return "user";
  if (role === "assistant") return "agent";
  if (role === "tool" || role === "toolResult") return "tool";
  if (role === "system") return "system";
  return "custom";
}

function replayMessageFromEntry(
  entry: TelegramSessionEntry,
): TelegramSessionReplayMessage | undefined {
  if (entry.type === "message") {
    const message = entry.message;
    if (!message) return undefined;
    if (message.role === "user") {
      const text = cleanReplayUserText(contentText(message.content));
      return {
        entryId: entry.id,
        timestamp: entry.timestamp,
        role: "user",
        text: text || "(empty user message)",
        attachments: replayAttachmentsFromContent(message.content),
      };
    }
    if (message.role === "assistant") {
      const text = contentText(message.content).trim();
      if (!text) return undefined;
      return {
        entryId: entry.id,
        timestamp: entry.timestamp,
        role: "agent",
        text,
        attachments: replayAttachmentsFromContent(message.content),
      };
    }
    return undefined;
  }
  if (entry.type === "custom_message" && entry.display !== false) {
    const text =
      contentText(entry.content).trim() || `custom: ${entry.customType ?? "message"}`;
    return {
      entryId: entry.id,
      timestamp: entry.timestamp,
      role: "custom",
      text,
      attachments: replayAttachmentsFromContent(entry.content),
    };
  }
  return undefined;
}

function fullReplayMessageFromEntry(
  entry: TelegramSessionEntry,
): TelegramSessionReplayMessage | undefined {
  if (entry.type === "message") {
    const message = entry.message;
    if (!message) return undefined;
    const rawText = fullReplayContentText(message.content);
    const text = message.role === "user" ? cleanReplayUserText(rawText) : rawText;
    return {
      entryId: entry.id,
      timestamp: entry.timestamp,
      role: fullReplayMessageRole(message.role),
      text: text || `(empty ${message.role ?? "message"})`,
      attachments: replayAttachmentsFromContent(message.content),
    };
  }
  if (entry.type === "custom_message" && entry.display !== false) {
    const text =
      fullReplayContentText(entry.content) || `custom: ${entry.customType ?? "message"}`;
    return {
      entryId: entry.id,
      timestamp: entry.timestamp,
      role: "custom",
      text,
      attachments: replayAttachmentsFromContent(entry.content),
    };
  }
  return undefined;
}

export function buildTelegramSessionReplayTurns(
  snapshot: TelegramSessionSnapshot,
): TelegramSessionReplayTurn[] {
  const turns: TelegramSessionReplayTurn[] = [];
  let current: TelegramSessionReplayTurn | undefined;
  let pendingAssistantAttachments: TelegramSessionReplayAttachment[] = [];
  for (const entry of snapshot.branch) {
    const message = replayMessageFromEntry(entry);
    if (!message) {
      if (entry.type === "message" && entry.message?.role === "assistant") {
        appendReplayAttachments(
          pendingAssistantAttachments,
          replayAttachmentsFromContent(entry.message.content),
        );
      }
      continue;
    }
    if (message.role === "user") {
      pendingAssistantAttachments = [];
      current = { user: message, messages: [message] };
      turns.push(current);
      continue;
    }
    if (message.role === "agent" && pendingAssistantAttachments.length > 0) {
      appendReplayAttachments(message.attachments, pendingAssistantAttachments);
      pendingAssistantAttachments = [];
    }
    if (current) current.messages.push(message);
  }
  return turns;
}

function flattenReplayTurns(
  turns: readonly TelegramSessionReplayTurn[],
): TelegramSessionReplayMessage[] {
  return turns.flatMap((turn) => turn.messages);
}

export function buildTelegramSessionReplayPlan(
  snapshot: TelegramSessionSnapshot,
  mode: TelegramSessionReplayMode,
): TelegramSessionReplayPlan {
  const allTurns = buildTelegramSessionReplayTurns(snapshot);
  const totalMessages = flattenReplayTurns(allTurns).length;
  let turns = mode === "last5" ? allTurns.slice(-5) : allTurns.slice();
  let messages = flattenReplayTurns(turns);
  let capped = false;
  if (mode === "full" && messages.length > TELEGRAM_SESSION_REPLAY_FULL_MESSAGE_CAP) {
    capped = true;
    while (turns.length > 1 && messages.length > TELEGRAM_SESSION_REPLAY_FULL_MESSAGE_CAP) {
      turns = turns.slice(1);
      messages = flattenReplayTurns(turns);
    }
    if (messages.length > TELEGRAM_SESSION_REPLAY_FULL_MESSAGE_CAP) {
      messages = messages.slice(-TELEGRAM_SESSION_REPLAY_FULL_MESSAGE_CAP);
    }
  }
  return {
    mode,
    turns,
    messages,
    totalTurns: allTurns.length,
    totalMessages,
    capped,
    cap: TELEGRAM_SESSION_REPLAY_FULL_MESSAGE_CAP,
  };
}

export function buildTelegramSessionLatestFullReplayMessages(
  snapshot: TelegramSessionSnapshot,
  limit = 5,
): TelegramSessionReplayMessage[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  return snapshot.branch
    .map(fullReplayMessageFromEntry)
    .filter((message): message is TelegramSessionReplayMessage => Boolean(message))
    .slice(-safeLimit);
}

export function buildTelegramSessionLatestFullTurnReplayMessages(
  snapshot: TelegramSessionSnapshot,
): TelegramSessionReplayMessage[] {
  const branch = snapshot.branch;
  let start = -1;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message?.role === "user") {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  let end = branch.length;
  for (let i = start + 1; i < branch.length; i += 1) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message?.role === "user") {
      end = i;
      break;
    }
  }
  return branch
    .slice(start, end)
    .map(fullReplayMessageFromEntry)
    .filter((message): message is TelegramSessionReplayMessage => Boolean(message));
}

function countReplayAttachments(
  messages: readonly TelegramSessionReplayMessage[],
): number {
  return messages.reduce((sum, message) => sum + message.attachments.length, 0);
}

function formatReplayAnswerText(plan: TelegramSessionReplayPlan): string {
  const messageCount = plan.messages.length;
  const attachmentCount = countReplayAttachments(plan.messages);
  const messageText = `${messageCount} message${messageCount === 1 ? "" : "s"}`;
  if (attachmentCount === 0) return `Replaying ${messageText}.`;
  return `Replaying ${messageText} and ${attachmentCount} image${attachmentCount === 1 ? "" : "s"}.`;
}

function formatReplayTimestamp(timestamp: string | undefined): string {
  if (!timestamp) return "unknown";
  const parsed = Date.parse(timestamp);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString().slice(0, 16).replace("T", " ");
  }
  return timestamp.slice(0, 16).replace("T", " ");
}

export function formatTelegramSessionReplayMessage(
  message: TelegramSessionReplayMessage,
): string {
  return `Replay msg ${formatReplayTimestamp(message.timestamp)} ${message.role}\n${message.text || "(empty)"}`;
}

function pageCount(total: number): number {
  return total <= 0 ? 1 : Math.ceil(total / TELEGRAM_SESSION_HISTORY_PAGE_SIZE);
}

function clampPage(page: number, total: number): number {
  const count = pageCount(total);
  if (!Number.isInteger(page) || page < 0) return 0;
  if (page >= count) return count - 1;
  return page;
}

function pageSlice<T>(items: readonly T[], page: number): readonly T[] {
  const start = page * TELEGRAM_SESSION_HISTORY_PAGE_SIZE;
  return items.slice(start, start + TELEGRAM_SESSION_HISTORY_PAGE_SIZE);
}

function getGraphemes(text: string): string[] {
  if (TELEGRAM_SESSION_GRAPHEME_SEGMENTER) {
    return Array.from(
      TELEGRAM_SESSION_GRAPHEME_SEGMENTER.segment(text),
      (segment) => segment.segment,
    );
  }
  return Array.from(text);
}

function codePointWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (
    codePoint === 0 ||
    codePoint < 32 ||
    (codePoint >= 0x300 && codePoint <= 0x36f)
  ) {
    return 0;
  }
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6))
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(text: string): number {
  return getGraphemes(text).reduce(
    (sum, grapheme) =>
      sum + Array.from(grapheme).reduce((n, char) => n + codePointWidth(char), 0),
    0,
  );
}

function truncateDisplay(s: string, width: number): string {
  const clean = cleanText(s);
  if (displayWidth(clean) <= width) return clean;
  let result = "";
  let used = 0;
  for (const grapheme of getGraphemes(clean)) {
    const nextWidth = displayWidth(grapheme);
    if (used + nextWidth > Math.max(0, width - 1)) break;
    result += grapheme;
    used += nextWidth;
  }
  return `${result}…`;
}

function padRight(s: string, width: number): string {
  const padding = width - displayWidth(s);
  return padding > 0 ? s + " ".repeat(padding) : s;
}

function historyTableTextWidth(indexWidth: number): number {
  return Math.max(
    12,
    TELEGRAM_SESSION_HISTORY_TABLE_WIDTH -
      indexWidth -
      2 -
      TELEGRAM_SESSION_HISTORY_ROLE_WIDTH -
      1,
  );
}

function buildHistoryTable(items: readonly TelegramSessionHistoryItem[]): string {
  const maxIndex = Math.max(...items.map((item) => item.globalIndex), 1);
  const indexWidth = Math.max(1, String(maxIndex).length);
  const textWidth = historyTableTextWidth(indexWidth);
  const rows = [
    `<code>${escapeHtml(padRight("#", indexWidth))}</code> <code>${escapeHtml(padRight("role", TELEGRAM_SESSION_HISTORY_ROLE_WIDTH))}</code> msg`,
  ];
  for (const item of items) {
    rows.push(
      `<code>${escapeHtml(padRight(String(item.globalIndex), indexWidth))}</code> <code>${escapeHtml(padRight(item.role, TELEGRAM_SESSION_HISTORY_ROLE_WIDTH))}</code> ${escapeHtml(truncateDisplay(item.detail, textWidth) || "(empty)")}`,
    );
  }
  return rows.join("\n");
}

function buildLatestPreview(items: TelegramSessionHistoryItem[]): string {
  const latest = items
    .filter((item) => item.role !== "tool")
    .slice(-2)
    .map((item) => `${item.title}: ${escapeHtml(truncate(item.detail, 72))}`);
  if (latest.length === 0) return "Latest: <i>No chat messages yet.</i>";
  return ["Latest:", ...latest].join("\n");
}

export function buildTelegramSessionMainText(
  snapshot: TelegramSessionSnapshot,
): string {
  const stats = buildTelegramSessionStats(snapshot);
  const history = buildTelegramSessionHistoryItems(snapshot);
  const name = snapshot.sessionName?.trim();
  const lines = [
    "<b>🧭 Session</b>",
    "",
    `Name: ${name ? escapeHtml(name) : "<i>unset</i>"}`,
    `ID: <code>${escapeHtml(snapshot.sessionId)}</code>`,
    `File: <code>${escapeHtml(shortSessionFile(snapshot.sessionFile))}</code>`,
    "",
    `Msgs: ${stats.userMessages} user · ${stats.assistantMessages} assistant · ${stats.toolResults} tools`,
    `Tools: ${stats.toolCalls} calls`,
    `Ctx: ${escapeHtml(formatContextUsage(snapshot.contextUsage))}`,
    `Tokens: ${formatCount(stats.inputTokens)} in · ${formatCount(stats.outputTokens)} out · ${formatCount(stats.totalTokens)} total`,
  ];
  if (stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0) {
    lines.push(
      `Cache: ${formatCount(stats.cacheReadTokens)} read · ${formatCount(stats.cacheWriteTokens)} write`,
    );
  }
  if (stats.totalCost > 0) lines.push(`Cost: ${formatMoney(stats.totalCost)}`);
  if (stats.totalEntries !== stats.branchEntries) {
    lines.push(`Branch: ${stats.branchEntries}/${stats.totalEntries} entries`);
  }
  lines.push("", buildLatestPreview(history));
  return lines.join("\n");
}

export function buildTelegramSessionMainReplyMarkup(
  hasHistory: boolean,
  canDeleteCurrent = false,
): TelegramSessionReplyMarkup {
  const rows: TelegramSessionReplyMarkup["inline_keyboard"] = [];
  rows.push([
    {
      text: hasHistory ? "📜 Last 5 turns" : "📜 Last 5 (empty)",
      callback_data: hasHistory ? "session:replay:last5" : "session:noop",
    },
    {
      text: hasHistory ? "📜 Full replay" : "📜 Full (empty)",
      callback_data: hasHistory ? "session:replay:full" : "session:noop",
    },
  ]);
  rows.push([
    {
      text: hasHistory ? "📜 History" : "📜 History (empty)",
      callback_data: hasHistory ? "session:history" : "session:noop",
    },
  ]);
  if (canDeleteCurrent) {
    rows.push([
      {
        text: "🗑 Delete this session",
        callback_data: "session:delete-current",
      },
    ]);
  }
  return { inline_keyboard: rows };
}

export function buildTelegramSessionDeleteConfirmText(
  snapshot: TelegramSessionSnapshot,
): string {
  return [
    "<b>⚠️ Delete current session?</b>",
    "",
    "This will start a new session first, then delete this session file.",
    `File: <code>${escapeHtml(shortSessionFile(snapshot.sessionFile))}</code>`,
  ].join("\n");
}

export function buildTelegramSessionDeleteConfirmReplyMarkup(): TelegramSessionReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "✅ Delete & start new", callback_data: "session:delete-current:confirm" }],
      [{ text: "Cancel", callback_data: "session:delete-current:cancel" }],
    ],
  };
}

export function buildTelegramSessionHistoryText(
  snapshot: TelegramSessionSnapshot,
  page: number,
): string {
  const items = buildTelegramSessionHistoryItems(snapshot);
  if (items.length === 0) return "<b>📜 History</b>\n\nNo chat history yet.";
  const safePage = clampPage(page, items.length);
  const count = pageCount(items.length);
  const start = safePage * TELEGRAM_SESSION_HISTORY_PAGE_SIZE;
  const end = Math.min(items.length, start + TELEGRAM_SESSION_HISTORY_PAGE_SIZE);
  const stats = buildTelegramSessionStats(snapshot);
  const lines = [
    "<b>📜 History</b>",
    `Chat rows · ${start + 1}–${end} / ${items.length}`,
  ];
  if (stats.toolCalls > 0 || stats.toolResults > 0) {
    lines.push(`Tools hidden · ${stats.toolCalls} calls · ${stats.toolResults} results`);
  }
  lines.push("", buildHistoryTable(pageSlice(items, safePage)));
  if (count > 1) lines.push("", `Page ${safePage + 1}/${count}`);
  return lines.join("\n");
}

export function buildTelegramSessionHistoryReplyMarkup(
  snapshot: TelegramSessionSnapshot,
  page: number,
): TelegramSessionReplyMarkup {
  const items = buildTelegramSessionHistoryItems(snapshot);
  const safePage = clampPage(page, items.length);
  const rows: TelegramSessionReplyMarkup["inline_keyboard"] = [
    [{ text: "⬅️ Back to session", callback_data: "session:back:main" }],
  ];
  const count = pageCount(items.length);
  if (count > 1) {
    const prev = safePage - 1;
    const next = safePage + 1;
    rows.push([
      {
        text: prev >= 0 ? "⬅️ Older" : "·",
        callback_data: prev >= 0 ? `session:page:${prev}` : "session:noop",
      },
      { text: `${safePage + 1}/${count}`, callback_data: "session:noop" },
      {
        text: next < count ? "Newer ➡️" : "·",
        callback_data: next < count ? `session:page:${next}` : "session:noop",
      },
    ]);
  }
  return { inline_keyboard: rows };
}

export function buildTelegramSessionDetailText(
  item: TelegramSessionHistoryItem,
): string {
  const meta = [`Entry: <code>${escapeHtml(item.entryId)}</code>`];
  if (item.tokenOutput !== undefined) meta.push(`${formatCount(item.tokenOutput)} output tokens`);
  if (item.toolCallCount > 0) meta.push(`tools ×${item.toolCallCount}`);
  const rawDetail = item.detail || "(empty)";
  const truncated = rawDetail.length > TELEGRAM_SESSION_DETAIL_TEXT_LEN;
  const detail = truncated
    ? rawDetail.slice(0, TELEGRAM_SESSION_DETAIL_TEXT_LEN - 1) + "…"
    : rawDetail;
  return [
    `<b>${escapeHtml(item.title)}</b>`,
    meta.join(" · "),
    "",
    escapeHtml(detail),
    ...(truncated ? ["", "<i>Truncated. Use the session file for full content.</i>"] : []),
  ].join("\n");
}

export function buildTelegramSessionDetailReplyMarkup(
  snapshot: TelegramSessionSnapshot,
  detailIndex: number,
): TelegramSessionReplyMarkup {
  const items = buildTelegramSessionHistoryItems(snapshot);
  const rows: TelegramSessionReplyMarkup["inline_keyboard"] = [
    [{ text: "⬅️ History", callback_data: "session:back:history" }],
  ];
  rows.push([
    {
      text: detailIndex > 0 ? "⬅️ Prev" : "·",
      callback_data: detailIndex > 0 ? `session:turn:${detailIndex - 1}` : "session:noop",
    },
    {
      text: detailIndex + 1 < items.length ? "Next ➡️" : "·",
      callback_data:
        detailIndex + 1 < items.length
          ? `session:turn:${detailIndex + 1}`
          : "session:noop",
    },
  ]);
  return { inline_keyboard: rows };
}

function parseIndex(data: string, prefix: string, total: number): number | undefined {
  const raw = data.slice(prefix.length);
  const index = Number.parseInt(raw, 10);
  if (!Number.isInteger(index) || index < 0 || index >= total) return undefined;
  return index;
}

export interface TelegramSessionMenuOpenDeps {
  chatId: number;
  getSnapshot: () => TelegramSessionSnapshot;
  canDeleteCurrent?: (snapshot: TelegramSessionSnapshot) => boolean;
  sendSessionMenu: (
    text: string,
    replyMarkup: TelegramSessionReplyMarkup,
  ) => Promise<number | undefined>;
  storeState: (state: TelegramSessionMenuState) => void;
  now?: () => number;
}

export async function openTelegramSessionMenu(
  deps: TelegramSessionMenuOpenDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const snapshot = deps.getSnapshot();
  const history = buildTelegramSessionHistoryItems(snapshot);
  const canDeleteCurrent = deps.canDeleteCurrent
    ? deps.canDeleteCurrent(snapshot)
    : Boolean(snapshot.sessionFile);
  const messageId = await deps.sendSessionMenu(
    buildTelegramSessionMainText(snapshot),
    buildTelegramSessionMainReplyMarkup(history.length > 0, canDeleteCurrent),
  );
  if (messageId === undefined) return;
  deps.storeState({
    chatId: deps.chatId,
    messageId,
    view: "main",
    page: 0,
    updatedAt: now(),
  });
}

export interface TelegramSessionMenuCallbackQuery {
  id: string;
  data?: string;
  message?: { chat?: { id?: number }; message_id?: number };
}

export interface TelegramSessionReplayAttachmentSenderDeps {
  sendMultipart: (
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
  ) => Promise<unknown>;
  sendTextReply?: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
  ) => Promise<number | undefined>;
}

export function createTelegramSessionReplayAttachmentSender(
  deps: TelegramSessionReplayAttachmentSenderDeps,
): (
  chatId: number,
  replyToMessageId: number | undefined,
  attachment: TelegramSessionReplayAttachment,
) => Promise<number | undefined> {
  return async function sendTelegramSessionReplayAttachment(
    chatId,
    replyToMessageId,
    attachment,
  ) {
    const replyParameters =
      replyToMessageId === undefined
        ? undefined
        : JSON.stringify({
            message_id: replyToMessageId,
            allow_sending_without_reply: true,
          });
    try {
      await deps.sendMultipart(
        "sendPhoto",
        {
          chat_id: String(chatId),
          ...(replyParameters ? { reply_parameters: replyParameters } : {}),
        },
        "photo",
        attachment.path,
        attachment.fileName,
      );
      return undefined;
    } catch (error) {
      if (!deps.sendTextReply) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return deps.sendTextReply(
        chatId,
        replyToMessageId,
        `Failed to replay image ${attachment.fileName}: ${message}`,
      );
    }
  };
}

export interface TelegramSessionReferenceReplaySenderDeps<TReference> {
  getSnapshot: (reference: TReference) => TelegramSessionSnapshot;
  sendReplayMessage: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
  ) => Promise<number | undefined>;
  sendReplayAttachment?: (
    chatId: number,
    replyToMessageId: number | undefined,
    attachment: TelegramSessionReplayAttachment,
  ) => Promise<number | undefined>;
}

export function createTelegramWorkspaceSwitchReplaySender<TReference>(
  deps: TelegramSessionReferenceReplaySenderDeps<TReference>,
): (
  reference: TReference,
  chatId: number,
  replyToMessageId: number,
) => Promise<void> {
  return async function sendTelegramWorkspaceSwitchReplayFromReference(
    reference,
    chatId,
    _replyToMessageId,
  ) {
    const snapshot = deps.getSnapshot(reference);
    const latestTurnMessages = buildTelegramSessionLatestFullTurnReplayMessages(snapshot);
    const messages = (latestTurnMessages.length > 0
      ? latestTurnMessages
      : buildTelegramSessionLatestFullReplayMessages(snapshot, 5)
    ).slice(-5);
    for (const message of messages) {
      const replayMessageId = await deps.sendReplayMessage(
        chatId,
        undefined,
        formatTelegramSessionReplayMessage(message),
      );
      if (deps.sendReplayAttachment) {
        for (const attachment of message.attachments) {
          await deps.sendReplayAttachment(chatId, replayMessageId, attachment);
        }
      }
    }
  };
}

export const createTelegramLastTurnsReplaySender = createTelegramWorkspaceSwitchReplaySender;

export interface TelegramSessionMenuCallbackDeps {
  getState: (messageId: number | undefined) => TelegramSessionMenuState | undefined;
  setState: (state: TelegramSessionMenuState) => void;
  getSnapshot: () => TelegramSessionSnapshot;
  canDeleteCurrent?: (snapshot: TelegramSessionSnapshot) => boolean;
  editSessionMessage: (
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup: TelegramSessionReplyMarkup,
  ) => Promise<void>;
  sendReplayMessage: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
  ) => Promise<number | undefined>;
  sendReplayAttachment?: (
    chatId: number,
    replyToMessageId: number | undefined,
    attachment: TelegramSessionReplayAttachment,
  ) => Promise<number | undefined>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  injectDeleteCurrentSession?: (expectedSessionPath: string) => Promise<void>;
  now?: () => number;
}

async function handleTelegramSessionMenuCallbackUnsafe(
  query: TelegramSessionMenuCallbackQuery,
  deps: TelegramSessionMenuCallbackDeps,
): Promise<boolean> {
  const data = query.data;
  if (!data?.startsWith("session:")) return false;
  if (data === "session:noop") {
    await deps.answerCallbackQuery(query.id);
    return true;
  }
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (typeof chatId !== "number" || typeof messageId !== "number") {
    await deps.answerCallbackQuery(query.id);
    return true;
  }
  const state = deps.getState(messageId);
  if (!state) {
    await deps.answerCallbackQuery(query.id, "Session menu expired.");
    return true;
  }
  const now = deps.now ?? Date.now;
  const snapshot = deps.getSnapshot();
  const history = buildTelegramSessionHistoryItems(snapshot);
  const canDeleteCurrent = deps.canDeleteCurrent
    ? deps.canDeleteCurrent(snapshot)
    : Boolean(snapshot.sessionFile);
  const updateState = (next: Partial<TelegramSessionMenuState>) => {
    deps.setState({ ...state, ...next, updatedAt: now() });
  };

  if (data === "session:refresh" || data === "session:back:main") {
    await deps.answerCallbackQuery(query.id, data === "session:refresh" ? "Refreshed." : undefined);
    await deps.editSessionMessage(
      chatId,
      messageId,
      buildTelegramSessionMainText(snapshot),
      buildTelegramSessionMainReplyMarkup(history.length > 0, canDeleteCurrent),
    );
    updateState({ view: "main", page: 0, detailIndex: undefined });
    return true;
  }

  if (data === "session:delete-current") {
    if (!canDeleteCurrent) {
      await deps.answerCallbackQuery(query.id, "Delete is not available for this session.");
      return true;
    }
    if (!snapshot.sessionFile) {
      await deps.answerCallbackQuery(query.id, "No session file to delete.");
      return true;
    }
    await deps.answerCallbackQuery(query.id);
    await deps.editSessionMessage(
      chatId,
      messageId,
      buildTelegramSessionDeleteConfirmText(snapshot),
      buildTelegramSessionDeleteConfirmReplyMarkup(),
    );
    updateState({ view: "deleteConfirm", page: 0, detailIndex: undefined });
    return true;
  }

  if (data === "session:delete-current:cancel") {
    await deps.answerCallbackQuery(query.id, "Cancelled.");
    await deps.editSessionMessage(
      chatId,
      messageId,
      buildTelegramSessionMainText(snapshot),
      buildTelegramSessionMainReplyMarkup(history.length > 0, canDeleteCurrent),
    );
    updateState({ view: "main", page: 0, detailIndex: undefined });
    return true;
  }

  if (data === "session:delete-current:confirm") {
    if (!canDeleteCurrent) {
      await deps.answerCallbackQuery(query.id, "Delete is not available for this session.");
      return true;
    }
    if (!snapshot.sessionFile) {
      await deps.answerCallbackQuery(query.id, "No session file to delete.");
      return true;
    }
    if (!deps.injectDeleteCurrentSession) {
      await deps.answerCallbackQuery(query.id, "Delete is not configured.");
      return true;
    }
    try {
      await deps.injectDeleteCurrentSession(snapshot.sessionFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const text = message.length > 160 ? message.slice(0, 159) + "…" : message;
      await deps.answerCallbackQuery(query.id, `Delete failed: ${text}`);
      return true;
    }
    await deps.answerCallbackQuery(query.id, "Delete queued.");
    return true;
  }

  if (data === "session:replay:last5" || data === "session:replay:full") {
    const mode: TelegramSessionReplayMode = data.endsWith(":full") ? "full" : "last5";
    const plan = buildTelegramSessionReplayPlan(snapshot, mode);
    if (plan.messages.length === 0) {
      await deps.answerCallbackQuery(query.id, "No visible turns to replay.");
      return true;
    }
    await deps.answerCallbackQuery(
      query.id,
      formatReplayAnswerText(plan),
    );
    if (plan.capped) {
      await deps.sendReplayMessage(
        chatId,
        undefined,
        `Full replay capped to the latest ${plan.messages.length} visible messages (${plan.totalMessages} total).`,
      );
    }
    for (const message of plan.messages) {
      const replayMessageId = await deps.sendReplayMessage(
        chatId,
        undefined,
        formatTelegramSessionReplayMessage(message),
      );
      if (deps.sendReplayAttachment) {
        for (const attachment of message.attachments) {
          await deps.sendReplayAttachment(chatId, replayMessageId, attachment);
        }
      }
    }
    return true;
  }

  if (data === "session:history" || data === "session:back:history") {
    if (history.length === 0) {
      await deps.answerCallbackQuery(query.id, "No history yet.");
      return true;
    }
    const page = clampPage(state.page, history.length);
    await deps.answerCallbackQuery(query.id);
    await deps.editSessionMessage(
      chatId,
      messageId,
      buildTelegramSessionHistoryText(snapshot, page),
      buildTelegramSessionHistoryReplyMarkup(snapshot, page),
    );
    updateState({ view: "history", page, detailIndex: undefined });
    return true;
  }

  if (data.startsWith("session:page:")) {
    if (history.length === 0) {
      await deps.answerCallbackQuery(query.id, "No history yet.");
      return true;
    }
    const requested = Number.parseInt(data.slice("session:page:".length), 10);
    const page = clampPage(requested, history.length);
    await deps.answerCallbackQuery(query.id);
    await deps.editSessionMessage(
      chatId,
      messageId,
      buildTelegramSessionHistoryText(snapshot, page),
      buildTelegramSessionHistoryReplyMarkup(snapshot, page),
    );
    updateState({ view: "history", page, detailIndex: undefined });
    return true;
  }

  if (data.startsWith("session:turn:")) {
    const index = parseIndex(data, "session:turn:", history.length);
    if (index === undefined) {
      await deps.answerCallbackQuery(query.id, "Message no longer exists.");
      return true;
    }
    const item = history[index];
    await deps.answerCallbackQuery(query.id);
    await deps.editSessionMessage(
      chatId,
      messageId,
      buildTelegramSessionDetailText(item),
      buildTelegramSessionDetailReplyMarkup(snapshot, index),
    );
    updateState({
      view: "detail",
      detailIndex: index,
      page: clampPage(Math.floor(index / TELEGRAM_SESSION_HISTORY_PAGE_SIZE), history.length),
    });
    return true;
  }

  await deps.answerCallbackQuery(query.id);
  return true;
}

export async function handleTelegramSessionMenuCallback(
  query: TelegramSessionMenuCallbackQuery,
  deps: TelegramSessionMenuCallbackDeps,
): Promise<boolean> {
  if (!query.data?.startsWith("session:")) return false;
  let answered = false;
  const safeDeps: TelegramSessionMenuCallbackDeps = {
    ...deps,
    answerCallbackQuery: async (callbackQueryId, text) => {
      await deps.answerCallbackQuery(callbackQueryId, text);
      answered = true;
    },
  };
  try {
    return await handleTelegramSessionMenuCallbackUnsafe(query, safeDeps);
  } catch {
    if (!answered) {
      try {
        await deps.answerCallbackQuery(
          query.id,
          "Session menu update failed. Try /session.",
        );
      } catch {
        // Keep polling alive even if the callback query has already expired.
      }
    }
    return true;
  }
}

export type TelegramSessionDeleteOutcome =
  | { ok: true; sessionPath: string }
  | { ok: false; sessionPath: string; error: string };

export interface TelegramSessionDeleteOutcomeNotifierDeps {
  getAllowedUserId: () => number | undefined;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
  ) => Promise<unknown>;
}

function formatTelegramSessionDeleteOutcomeText(
  outcome: TelegramSessionDeleteOutcome,
): string {
  const tail = outcome.sessionPath
    ? (outcome.sessionPath.split("/").pop() ?? outcome.sessionPath)
    : "(unknown)";
  if (outcome.ok) return `✅ Deleted session: ${tail}`;
  return `⚠️ Delete failed (${tail}): ${outcome.error}`;
}

export function createTelegramSessionDeleteOutcomeNotifier(
  deps: TelegramSessionDeleteOutcomeNotifierDeps,
): (outcome: TelegramSessionDeleteOutcome) => Promise<void> {
  return async function notifyTelegramSessionDeleteOutcome(outcome) {
    const chatId = deps.getAllowedUserId();
    if (typeof chatId !== "number") return;
    try {
      await deps.sendTextReply(
        chatId,
        0,
        formatTelegramSessionDeleteOutcomeText(outcome),
      );
    } catch {
      // best-effort notification only
    }
  };
}

export interface TelegramSessionMenuRuntime<TContext> {
  openSessionMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  handleCallbackQuery: (
    query: TelegramSessionMenuCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
}

export interface TelegramSessionMenuRuntimeDeps<TContext> {
  getSnapshot: (ctx: TContext) => TelegramSessionSnapshot;
  canDeleteCurrent?: (
    snapshot: TelegramSessionSnapshot,
    ctx: TContext,
  ) => boolean;
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "html",
    replyMarkup: TelegramSessionReplyMarkup,
  ) => Promise<number | undefined>;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "html",
    replyMarkup: TelegramSessionReplyMarkup,
  ) => Promise<void>;
  sendReplayMessage: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
  ) => Promise<number | undefined>;
  sendReplayAttachment?: (
    chatId: number,
    replyToMessageId: number | undefined,
    attachment: TelegramSessionReplayAttachment,
  ) => Promise<number | undefined>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  injectDeleteCurrentSession?: (
    expectedSessionPath: string,
    ctx: TContext,
  ) => Promise<void>;
  store?: TelegramSessionMenuStore;
}

export function createTelegramSessionMenuRuntime<TContext>(
  deps: TelegramSessionMenuRuntimeDeps<TContext>,
): TelegramSessionMenuRuntime<TContext> {
  const store = deps.store ?? createTelegramSessionMenuStore();
  return {
    openSessionMenu(chatId, _replyToMessageId, ctx) {
      return openTelegramSessionMenu({
        chatId,
        getSnapshot: () => deps.getSnapshot(ctx),
        canDeleteCurrent: deps.canDeleteCurrent
          ? (snapshot) => deps.canDeleteCurrent?.(snapshot, ctx) ?? false
          : undefined,
        sendSessionMenu: (text, replyMarkup) =>
          deps.sendInteractiveMessage(chatId, text, "html", replyMarkup),
        storeState: store.set,
      });
    },
    handleCallbackQuery(query, ctx) {
      return handleTelegramSessionMenuCallback(query, {
        getState: store.get,
        setState: store.set,
        getSnapshot: () => deps.getSnapshot(ctx),
        canDeleteCurrent: deps.canDeleteCurrent
          ? (snapshot) => deps.canDeleteCurrent?.(snapshot, ctx) ?? false
          : undefined,
        editSessionMessage: (chatId, messageId, text, replyMarkup) =>
          deps.editInteractiveMessage(chatId, messageId, text, "html", replyMarkup),
        sendReplayMessage: deps.sendReplayMessage,
        sendReplayAttachment: deps.sendReplayAttachment,
        answerCallbackQuery: deps.answerCallbackQuery,
        injectDeleteCurrentSession: deps.injectDeleteCurrentSession
          ? (expectedSessionPath) => deps.injectDeleteCurrentSession?.(
              expectedSessionPath,
              ctx,
            ) ?? Promise.resolve()
          : undefined,
      });
    },
  };
}
