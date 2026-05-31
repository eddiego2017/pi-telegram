/**
 * Telegram API transport helpers
 * Zones: telegram transport, filesystem, runtime diagnostics
 * Wraps bot API calls, file downloads, runtime transport binding, and Telegram temp-file cleanup
 */

import { randomUUID } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { TelegramDebugLogger } from "./debug.ts";
import type { TelegramTopicOrphanProofStore } from "./topic-orphans.ts";

export const TELEGRAM_API_BASE = "https://api.telegram.org";

export const TELEGRAM_FILE_MAX_BYTES = 50 * 1024 * 1024;

export function getTelegramInboundFileByteLimitFromEnv(
  env: NodeJS.ProcessEnv,
  names: string[],
  defaultValue = TELEGRAM_FILE_MAX_BYTES,
): number {
  for (const name of names) {
    const rawValue = env[name]?.trim();
    if (!rawValue) continue;
    const parsed = Number(rawValue);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return defaultValue;
}

function getTelegramApiTempDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
  return join(agentDir, "tmp", "telegram");
}
const TELEGRAM_TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TELEGRAM_MAX_RETRY_AFTER_SECONDS = 30;
const TELEGRAM_INBOUND_FILE_MAX_BYTES = getTelegramInboundFileByteLimitFromEnv(
  process.env,
  ["PI_TELEGRAM_INBOUND_FILE_MAX_BYTES", "TELEGRAM_MAX_FILE_SIZE_BYTES"],
  TELEGRAM_FILE_MAX_BYTES,
);

function getTelegramPositiveNumberFromEnv(
  env: NodeJS.ProcessEnv,
  names: string[],
  defaultValue = 0,
): number {
  for (const name of names) {
    const rawValue = env[name]?.trim();
    if (!rawValue) continue;
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return defaultValue;
}

function getTelegramBooleanFromEnv(
  env: NodeJS.ProcessEnv,
  names: string[],
  defaultValue: boolean,
): boolean {
  for (const name of names) {
    const rawValue = env[name]?.trim().toLowerCase();
    if (!rawValue) continue;
    if (["1", "true", "yes", "on"].includes(rawValue)) return true;
    if (["0", "false", "no", "off"].includes(rawValue)) return false;
  }
  return defaultValue;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAnimation {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramSticker {
  file_id: string;
  emoji?: string;
}

export interface TelegramForumTopicCreated {
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
  is_name_implicit?: true;
}

export interface TelegramForumTopicEdited {
  name?: string;
  icon_custom_emoji_id?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  media_group_id?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramVideo;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  animation?: TelegramAnimation;
  sticker?: TelegramSticker;
  forum_topic_created?: TelegramForumTopicCreated;
  forum_topic_edited?: TelegramForumTopicEdited;
  forum_topic_closed?: Record<string, never>;
  forum_topic_reopened?: Record<string, never>;
  general_forum_topic_hidden?: Record<string, never>;
  general_forum_topic_unhidden?: Record<string, never>;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramReactionTypeEmoji {
  type: "emoji";
  emoji: string;
}

export interface TelegramReactionTypeCustomEmoji {
  type: "custom_emoji";
  custom_emoji_id: string;
}

export interface TelegramReactionTypePaid {
  type: "paid";
}

export type TelegramReactionType =
  | TelegramReactionTypeEmoji
  | TelegramReactionTypeCustomEmoji
  | TelegramReactionTypePaid;

export interface TelegramMessageReactionUpdated {
  chat: TelegramChat;
  message_id: number;
  user?: TelegramUser;
  actor_chat?: TelegramChat;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
  date: number;
}

export interface TelegramGuestMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  guest_query_id: string;
  guest_bot_caller_user?: TelegramUser;
  guest_bot_caller_chat?: TelegramChat;
  reply_to_message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  message_reaction?: TelegramMessageReactionUpdated;
  guest_message?: TelegramGuestMessage;
  deleted_business_messages?: { message_ids?: unknown };
}

export interface TelegramSentMessage {
  message_id: number;
}

export interface TelegramReplyParameters {
  message_id: number;
  allow_sending_without_reply: true;
}

export type TelegramSendMessageBody = Record<string, unknown> & {
  chat_id: number;
  text: string;
  parse_mode?: "HTML";
  reply_markup?: unknown;
  reply_parameters?: TelegramReplyParameters;
  message_thread_id?: number;
  link_preview_options?: { is_disabled: true };
};

export type TelegramEditMessageTextBody = Record<string, unknown> & {
  chat_id: number;
  message_id: number;
  text: string;
  parse_mode?: "HTML";
  link_preview_options?: { is_disabled: true };
};

export type TelegramSendMessageDraftBody = Record<string, unknown> & {
  chat_id: number;
  draft_id: number;
  text?: string;
  parse_mode?: string;
  entities?: unknown[];
  message_thread_id?: number;
};

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface TelegramApiCallOptions {
  signal?: AbortSignal;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface TelegramGetFileResult {
  file_path: string;
  file_size?: number;
}

export interface TelegramFileDownloadOptions {
  signal?: AbortSignal;
  maxFileSizeBytes?: number;
}

export interface TelegramApiClient {
  call: <TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramApiCallOptions,
  ) => Promise<TResponse>;
  callMultipart: <TResponse>(
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
    options?: TelegramApiCallOptions,
  ) => Promise<TResponse>;
  downloadFile: (
    fileId: string,
    suggestedName: string,
    tempDir: string,
    options?: TelegramFileDownloadOptions,
  ) => Promise<string>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  answerGuestQuery?: (
    guestQueryId: string,
    text?: string,
    options?: { parseMode?: string },
  ) => Promise<void>;
}

export interface TelegramBridgeApiRuntimeDeps {
  client: TelegramApiClient;
  tempDir: string;
  maxFileSizeBytes: number;
  tempFileMaxAgeMs: number;
  recordRuntimeEvent: (
    kind: "api" | "multipart" | "download",
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  debugLogger?: TelegramDebugLogger;
  topicOrphanProofStore?: TelegramTopicOrphanProofStore;
  /** Resolve the ambient forum-topic id for outbound calls that did not
   *  explicitly specify one. Receives the target chat id so multi-chat
   *  scenarios don't leak threads across chats. Returns undefined for
   *  regular (non-forum) chats. */
  getDefaultMessageThreadId?: (chatId: number) => number | undefined;
}

export interface TelegramBridgeApiRuntime {
  call: <TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramApiCallOptions,
  ) => Promise<TResponse>;
  callMultipart: <TResponse>(
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
    options?: TelegramApiCallOptions,
  ) => Promise<TResponse>;
  downloadFile: (fileId: string, suggestedName: string) => Promise<string>;
  deleteWebhook: (signal?: AbortSignal) => Promise<boolean>;
  getUpdates: (
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<TelegramUpdate[]>;
  setMyCommands: (
    commands: readonly { command: string; description: string }[],
  ) => Promise<boolean>;
  sendChatAction: (chatId: number, action: "typing") => Promise<boolean>;
  sendTypingAction: (chatId: number) => Promise<unknown>;
  sendMessageDraft: (
    chatId: number,
    draftId: number,
    text?: string,
    options?: {
      parse_mode?: string;
      entities?: unknown[];
      message_thread_id?: number;
    },
  ) => Promise<boolean>;
  sendMessage: (body: TelegramSendMessageBody) => Promise<TelegramSentMessage>;
  editMessageText: (
    body: TelegramEditMessageTextBody,
  ) => Promise<"edited" | "unchanged">;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  answerGuestQuery: (
    guestQueryId: string,
    text?: string,
    options?: { parseMode?: string },
  ) => Promise<void>;
  deleteMessage: (chatId: number, messageId: number) => Promise<void>;
  deleteForumTopic: (
    chatId: number,
    messageThreadId: number,
  ) => Promise<boolean>;
  prepareTempDir: () => Promise<number>;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

class TelegramApiHttpError extends Error {
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;
  constructor(
    message: string,
    status: number | undefined,
    retryAfterSeconds: number | undefined,
  ) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isTelegramMessageNotModifiedError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("message is not modified")
  );
}

function isRetryableTelegramApiError(error: unknown): boolean {
  if (!(error instanceof TelegramApiHttpError)) return false;
  if (
    error.status === 429 &&
    error.retryAfterSeconds !== undefined &&
    error.retryAfterSeconds > TELEGRAM_MAX_RETRY_AFTER_SECONDS
  ) {
    return false;
  }
  return error.status === 429 || (error.status !== undefined && error.status >= 500);
}

function getTelegramRetryDelayMs(
  error: unknown,
  attempt: number,
  baseDelayMs: number,
): number {
  if (
    error instanceof TelegramApiHttpError &&
    error.retryAfterSeconds !== undefined
  ) {
    return Math.max(0, error.retryAfterSeconds * 1000);
  }
  return Math.max(0, baseDelayMs * 2 ** attempt);
}

function sleepTelegramRetry(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTelegramApiRetryAfterSeconds(error: unknown): number | undefined {
  if (error instanceof TelegramApiHttpError) return error.retryAfterSeconds;
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isTelegramOutboundApiMethod(method: string): boolean {
  return (
    method.startsWith("send") ||
    method.startsWith("edit") ||
    method === "deleteMessage" ||
    method === "deleteForumTopic"
  );
}

function getTelegramOutboundChatId(
  body: Record<string, unknown>,
): number | undefined {
  const chatId = body.chat_id;
  if (typeof chatId === "number" && Number.isFinite(chatId)) return chatId;
  if (typeof chatId === "string") {
    const parsed = Number(chatId);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function getTelegramOutboundMessageThreadId(
  body: Record<string, unknown>,
): number | undefined {
  const threadId = body.message_thread_id;
  if (typeof threadId === "number" && Number.isFinite(threadId)) return threadId;
  if (typeof threadId === "string") {
    const parsed = Number(threadId);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function getTelegramRateMinIntervalMs(rate: number, periodMs: number): number {
  return rate > 0 ? Math.ceil(periodMs / rate) : 0;
}

interface TelegramDeliveryLimiterState {
  notBefore: number;
  lastSendAt: number;
  tail: Promise<void>;
}

function createTelegramDeliveryLimiterState(): TelegramDeliveryLimiterState {
  return {
    notBefore: 0,
    lastSendAt: 0,
    tail: Promise.resolve(),
  };
}

function isTelegramPreviewDelivery(
  method: string,
  body: Record<string, unknown>,
): boolean {
  if (method !== "sendMessage" && method !== "editMessageText") return false;
  const text = body.text;
  if (typeof text !== "string") return false;
  return text.startsWith("\u{1F4A1} Thinking") || text.startsWith("\u{1F527} ");
}

function isTelegramDroppableDelivery(
  method: string,
  body: Record<string, unknown>,
  options: {
    dropChatActionWhenLimited: boolean;
    dropPreviewsWhenLimited: boolean;
  },
): boolean {
  if (method === "sendChatAction") {
    return options.dropChatActionWhenLimited;
  }
  return options.dropPreviewsWhenLimited && isTelegramPreviewDelivery(method, body);
}

function getDroppedTelegramDeliveryResult<TResponse>(
  method: string,
): TResponse {
  if (method === "sendChatAction") return true as TResponse;
  if (method === "editMessageText") return "unchanged" as TResponse;
  return undefined as TResponse;
}

function assertTelegramFileSizeWithinLimit(
  size: number | undefined,
  maxFileSizeBytes: number | undefined,
): void {
  if (size === undefined || maxFileSizeBytes === undefined) return;
  if (size <= maxFileSizeBytes) return;
  throw new Error(
    `Telegram file exceeds size limit (${size} bytes > ${maxFileSizeBytes} bytes)`,
  );
}

function createTelegramDownloadLimitTransform(
  maxFileSizeBytes: number | undefined,
): Transform {
  let downloadedBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloadedBytes += chunk.byteLength;
      try {
        assertTelegramFileSizeWithinLimit(downloadedBytes, maxFileSizeBytes);
        callback(undefined, chunk);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

async function writeTelegramDownloadResponse(
  response: Response,
  targetPath: string,
  maxFileSizeBytes: number | undefined,
): Promise<void> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    assertTelegramFileSizeWithinLimit(buffer.byteLength, maxFileSizeBytes);
    await writeFile(targetPath, buffer);
    return;
  }
  await pipeline(
    Readable.from(response.body, { objectMode: false }),
    createTelegramDownloadLimitTransform(maxFileSizeBytes),
    createWriteStream(targetPath),
  );
}

async function removeTelegramPartialDownload(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}

async function parseTelegramApiResponse<TResponse>(
  response: Response,
  method: string,
): Promise<TelegramApiResponse<TResponse>> {
  let data: TelegramApiResponse<TResponse> | undefined;
  try {
    if (typeof response.text === "function") {
      const text = await response.text();
      data = text
        ? (JSON.parse(text) as TelegramApiResponse<TResponse>)
        : undefined;
    } else {
      data = (await response.json()) as TelegramApiResponse<TResponse>;
    }
  } catch {
    data = undefined;
  }
  if (response.ok === false) {
    const status = `HTTP ${response.status}`;
    const description = data?.description ? `: ${data.description}` : "";
    const retryAfterHeader = response.headers?.get("retry-after");
    const retryAfterSeconds =
      data?.parameters?.retry_after ??
      (retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined);
    throw new TelegramApiHttpError(
      `Telegram API ${method} failed: ${status}${description}`,
      response.status,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    );
  }
  return (
    data ?? {
      ok: false,
      description: `Telegram API ${method} returned invalid JSON`,
    }
  );
}

function unwrapTelegramApiResult<TResponse>(
  method: string,
  data: TelegramApiResponse<TResponse>,
): TResponse {
  if (!data.ok || data.result === undefined) {
    throw new Error(data.description || `Telegram API ${method} failed`);
  }
  return data.result;
}

async function callTelegramWithRetry<TResponse>(
  method: string,
  request: () => Promise<Response>,
  options: TelegramApiCallOptions | undefined,
): Promise<TResponse> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
  const retryBaseDelayMs = options?.retryBaseDelayMs ?? 500;
  const sleep = options?.sleep ?? sleepTelegramRetry;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return unwrapTelegramApiResult(
        method,
        await parseTelegramApiResponse<TResponse>(await request(), method),
      );
    } catch (error) {
      if (attempt >= maxAttempts - 1 || !isRetryableTelegramApiError(error)) {
        throw error;
      }
      await sleep(getTelegramRetryDelayMs(error, attempt, retryBaseDelayMs));
    }
  }
}

export async function cleanupTelegramTempFiles(
  tempDir: string,
  maxAgeMs: number,
  now = Date.now(),
): Promise<number> {
  let removedCount = 0;
  let entries: Array<{ isFile(): boolean; name: string }>;
  try {
    entries = await readdir(tempDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(tempDir, entry.name);
    try {
      const stats = await stat(path);
      if (now - stats.mtimeMs <= maxAgeMs) continue;
      await unlink(path);
      removedCount += 1;
    } catch {
      // ignore
    }
  }
  return removedCount;
}

export async function prepareTelegramTempDir(
  tempDir: string,
  maxAgeMs: number,
): Promise<number> {
  await mkdir(tempDir, { recursive: true });
  return cleanupTelegramTempFiles(tempDir, maxAgeMs);
}

function assertTelegramBotTokenConfigured(
  botToken: string | undefined,
): string {
  if (!botToken) throw new Error("Telegram bot token is not configured");
  return botToken;
}

export async function callTelegram<TResponse>(
  botToken: string | undefined,
  method: string,
  body: Record<string, unknown>,
  options?: TelegramApiCallOptions,
): Promise<TResponse> {
  const configuredBotToken = assertTelegramBotTokenConfigured(botToken);
  return callTelegramWithRetry(
    method,
    async () =>
      fetch(`${TELEGRAM_API_BASE}/bot${configuredBotToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: options?.signal,
      }),
    options,
  );
}

export type TelegramBotIdentityResponse = Pick<
  TelegramApiResponse<TelegramUser>,
  "ok" | "result" | "description"
>;

export async function fetchTelegramBotIdentity(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramBotIdentityResponse> {
  const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${botToken}/getMe`);
  return response.json() as Promise<TelegramBotIdentityResponse>;
}

export async function callTelegramMultipart<TResponse>(
  botToken: string | undefined,
  method: string,
  fields: Record<string, string>,
  fileField: string,
  filePath: string,
  fileName: string,
  options?: TelegramApiCallOptions,
): Promise<TResponse> {
  const configuredBotToken = assertTelegramBotTokenConfigured(botToken);
  const fileBlob = await openAsBlob(filePath);
  return callTelegramWithRetry(
    method,
    async () => {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) {
        form.set(key, value);
      }
      form.set(fileField, fileBlob, fileName);
      return fetch(`${TELEGRAM_API_BASE}/bot${configuredBotToken}/${method}`, {
        method: "POST",
        body: form,
        signal: options?.signal,
      });
    },
    options,
  );
}

export async function downloadTelegramFile(
  botToken: string | undefined,
  fileId: string,
  suggestedName: string,
  tempDir: string,
  options?: TelegramFileDownloadOptions,
): Promise<string> {
  const configuredBotToken = assertTelegramBotTokenConfigured(botToken);
  const file = await callTelegram<TelegramGetFileResult>(
    configuredBotToken,
    "getFile",
    { file_id: fileId },
    { signal: options?.signal },
  );
  assertTelegramFileSizeWithinLimit(file.file_size, options?.maxFileSizeBytes);
  await mkdir(tempDir, { recursive: true });
  const targetPath = join(
    tempDir,
    `${randomUUID()}-${sanitizeFileName(suggestedName)}`,
  );
  const response = await fetch(
    `${TELEGRAM_API_BASE}/file/bot${configuredBotToken}/${file.file_path}`,
    { signal: options?.signal },
  );
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status}`);
  }
  const contentLength = response.headers?.get("content-length");
  assertTelegramFileSizeWithinLimit(
    contentLength ? Number.parseInt(contentLength, 10) : undefined,
    options?.maxFileSizeBytes,
  );
  try {
    await writeTelegramDownloadResponse(
      response,
      targetPath,
      options?.maxFileSizeBytes,
    );
  } catch (error) {
    await removeTelegramPartialDownload(targetPath);
    throw error;
  }
  return targetPath;
}

export async function answerTelegramCallbackQuery(
  botToken: string | undefined,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  try {
    await callTelegram<boolean>(
      botToken,
      "answerCallbackQuery",
      text
        ? { callback_query_id: callbackQueryId, text }
        : { callback_query_id: callbackQueryId },
    );
  } catch {
    // ignore
  }
}

export async function deleteTelegramMessage(
  botToken: string | undefined,
  chatId: number,
  messageId: number,
): Promise<void> {
  try {
    await callTelegram<boolean>(botToken, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch {
    // ignore
  }
}

export function isTelegramForumTopicPermissionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("not enough rights") ||
    message.includes("not enough privileges") ||
    message.includes("need administrator") ||
    message.includes("administrator rights") ||
    message.includes("not an administrator") ||
    message.includes("chat_admin_required") ||
    message.includes("can't delete") ||
    message.includes("cannot delete") ||
    message.includes("can't manage") ||
    message.includes("cannot manage") ||
    message.includes("manage topics") ||
    message.includes("can_manage_topics")
  );
}

export function isTelegramForumTopicMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("message thread not found") ||
    message.includes("topic not found") ||
    message.includes("forum topic not found")
  );
}

export function createTelegramChatActionSender<TAction extends string>(
  sendChatAction: (chatId: number, action: TAction) => Promise<unknown>,
  action: TAction,
): (chatId: number) => Promise<unknown> {
  return (chatId) => sendChatAction(chatId, action);
}

export function createDefaultTelegramBridgeApiRuntime(deps: {
  getBotToken: () => string | undefined;
  recordRuntimeEvent: TelegramBridgeApiRuntimeDeps["recordRuntimeEvent"];
  getDefaultMessageThreadId?: (chatId: number) => number | undefined;
  debugLogger?: TelegramDebugLogger;
  topicOrphanProofStore?: TelegramTopicOrphanProofStore;
}): TelegramBridgeApiRuntime {
  return createTelegramBridgeApiRuntime({
    client: createTelegramApiClient(deps.getBotToken),
    tempDir: getTelegramApiTempDir(),
    maxFileSizeBytes: TELEGRAM_INBOUND_FILE_MAX_BYTES,
    tempFileMaxAgeMs: TELEGRAM_TEMP_FILE_MAX_AGE_MS,
    recordRuntimeEvent: deps.recordRuntimeEvent,
    getDefaultMessageThreadId: deps.getDefaultMessageThreadId,
    debugLogger: deps.debugLogger,
    topicOrphanProofStore: deps.topicOrphanProofStore,
  });
}

export function createTelegramBridgeApiRuntime(
  deps: TelegramBridgeApiRuntimeDeps,
): TelegramBridgeApiRuntime {
  const globalDeliveryLimiter = createTelegramDeliveryLimiterState();
  const chatDeliveryLimiters = new Map<number, TelegramDeliveryLimiterState>();
  const deliveryGroupMessagesPerMinute = getTelegramPositiveNumberFromEnv(
    process.env,
    [
      "PI_TELEGRAM_DELIVERY_GROUP_MESSAGES_PER_MINUTE",
      "TELEGRAM_DELIVERY_GROUP_MESSAGES_PER_MINUTE",
    ],
  );
  const deliveryGlobalMessagesPerSecond = getTelegramPositiveNumberFromEnv(
    process.env,
    [
      "PI_TELEGRAM_DELIVERY_GLOBAL_MESSAGES_PER_SECOND",
      "TELEGRAM_DELIVERY_GLOBAL_MESSAGES_PER_SECOND",
    ],
  );
  const dropChatActionWhenLimited = getTelegramBooleanFromEnv(
    process.env,
    ["PI_TELEGRAM_DROP_CHAT_ACTION_WHEN_LIMITED"],
    true,
  );
  const dropPreviewsWhenLimited = getTelegramBooleanFromEnv(
    process.env,
    ["PI_TELEGRAM_DROP_PREVIEWS_WHEN_LIMITED"],
    true,
  );
  const globalMinIntervalMs = getTelegramRateMinIntervalMs(
    deliveryGlobalMessagesPerSecond,
    1000,
  );
  const groupMinIntervalMs = getTelegramRateMinIntervalMs(
    deliveryGroupMessagesPerMinute,
    60_000,
  );
  const resolveDefaultThreadId =
    deps.getDefaultMessageThreadId ?? ((_chatId: number) => undefined);
  const withDefaultThreadId = <T extends Record<string, unknown>>(body: T): T => {
    if (body.message_thread_id !== undefined) return body;
    const chatId = body.chat_id;
    if (typeof chatId !== "number") return body;
    const threadId = resolveDefaultThreadId(chatId);
    if (threadId === undefined) return body;
    return { ...body, message_thread_id: threadId };
  };
  const getChatDeliveryLimiter = (
    chatId: number,
  ): TelegramDeliveryLimiterState => {
    let limiter = chatDeliveryLimiters.get(chatId);
    if (!limiter) {
      limiter = createTelegramDeliveryLimiterState();
      chatDeliveryLimiters.set(chatId, limiter);
    }
    return limiter;
  };
  const getChatMinIntervalMs = (chatId: number | undefined): number =>
    chatId !== undefined && chatId < 0 ? groupMinIntervalMs : 0;
  const getDeliveryWaitMs = (
    chatId: number | undefined,
    chatLimiter: TelegramDeliveryLimiterState | undefined,
  ): number => {
    const nowMs = Date.now();
    let waitUntil = globalDeliveryLimiter.notBefore;
    if (globalMinIntervalMs > 0) {
      waitUntil = Math.max(
        waitUntil,
        globalDeliveryLimiter.lastSendAt + globalMinIntervalMs,
      );
    }
    if (chatLimiter) {
      waitUntil = Math.max(waitUntil, chatLimiter.notBefore);
      const chatMinIntervalMs = getChatMinIntervalMs(chatId);
      if (chatMinIntervalMs > 0) {
        waitUntil = Math.max(waitUntil, chatLimiter.lastSendAt + chatMinIntervalMs);
      }
    }
    return Math.max(0, waitUntil - nowMs);
  };
  const setDeliveryBackoff = (
    method: string,
    body: Record<string, unknown>,
    retryAfterSeconds: number,
  ): void => {
    const chatId = getTelegramOutboundChatId(body);
    const messageThreadId = getTelegramOutboundMessageThreadId(body);
    const notBefore = Date.now() + retryAfterSeconds * 1000;
    globalDeliveryLimiter.notBefore = Math.max(
      globalDeliveryLimiter.notBefore,
      notBefore,
    );
    if (chatId !== undefined) {
      const chatLimiter = getChatDeliveryLimiter(chatId);
      chatLimiter.notBefore = Math.max(chatLimiter.notBefore, notBefore);
    }
    deps.debugLogger?.log("telegram.api.rate_limited", {
      method,
      chatId,
      messageThreadId,
      waitSeconds: retryAfterSeconds,
    });
    deps.debugLogger?.log("telegram.delivery.backoff.set", {
      method,
      chatId,
      messageThreadId,
      retryAfterSeconds,
      notBefore,
    });
  };
  const recordTopicOrphanProofFromError = (
    method: string,
    body: Record<string, unknown>,
    error: unknown,
  ): void => {
    const chatId = getTelegramOutboundChatId(body);
    const messageThreadId = getTelegramOutboundMessageThreadId(body);
    if (
      deps.topicOrphanProofStore &&
      chatId !== undefined &&
      messageThreadId !== undefined &&
      isTelegramForumTopicMissingError(error)
    ) {
      deps.topicOrphanProofStore.record({
        chatId,
        messageThreadId,
        method,
        message: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      });
      deps.debugLogger?.log("telegram.topic.orphan.proof", {
        method,
        chatId,
        messageThreadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const updateDeliveryBackoffFromError = (
    method: string,
    body: Record<string, unknown>,
    error: unknown,
  ): void => {
    recordTopicOrphanProofFromError(method, body, error);
    const retryAfterSeconds = getTelegramApiRetryAfterSeconds(error);
    if (
      isTelegramOutboundApiMethod(method) &&
      retryAfterSeconds !== undefined &&
      retryAfterSeconds > 0
    ) {
      setDeliveryBackoff(method, body, retryAfterSeconds);
    }
  };
  const runQueuedDelivery = async <TResponse>(
    method: string,
    body: Record<string, unknown>,
    run: () => Promise<TResponse>,
  ): Promise<TResponse> => {
    if (!isTelegramOutboundApiMethod(method)) return run();
    const chatId = getTelegramOutboundChatId(body);
    const messageThreadId = getTelegramOutboundMessageThreadId(body);
    const chatLimiter =
      chatId === undefined ? undefined : getChatDeliveryLimiter(chatId);
    const sendNow = async (): Promise<TResponse> => {
      deps.debugLogger?.log("telegram.delivery.send.start", {
        method,
        chatId,
        messageThreadId,
      });
      const result = await run();
      if (method !== "sendChatAction") {
        const sentAt = Date.now();
        globalDeliveryLimiter.lastSendAt = sentAt;
        if (chatLimiter) chatLimiter.lastSendAt = sentAt;
      }
      deps.debugLogger?.log("telegram.delivery.send.result", {
        method,
        chatId,
        messageThreadId,
      });
      return result;
    };
    if (globalMinIntervalMs === 0 && groupMinIntervalMs === 0) {
      const waitMs = getDeliveryWaitMs(chatId, chatLimiter);
      if (waitMs <= 0) return sendNow();
      if (
        isTelegramDroppableDelivery(method, body, {
          dropChatActionWhenLimited,
          dropPreviewsWhenLimited,
        })
      ) {
        deps.debugLogger?.log("telegram.delivery.drop_stale", {
          method,
          chatId,
          messageThreadId,
          waitMs,
          dropReason: "limited-droppable",
        });
        return getDroppedTelegramDeliveryResult<TResponse>(method);
      }
    }
    deps.debugLogger?.log("telegram.delivery.enqueue", {
      method,
      chatId,
      messageThreadId,
    });
    const previousGlobal = globalDeliveryLimiter.tail.catch(() => undefined);
    const previousChat = chatLimiter?.tail.catch(() => undefined);
    const task = Promise.all(
      previousChat ? [previousGlobal, previousChat] : [previousGlobal],
    ).then(async () => {
      const waitMs = getDeliveryWaitMs(chatId, chatLimiter);
      if (
        waitMs > 0 &&
        isTelegramDroppableDelivery(method, body, {
          dropChatActionWhenLimited,
          dropPreviewsWhenLimited,
        })
      ) {
        deps.debugLogger?.log("telegram.delivery.drop_stale", {
          method,
          chatId,
          messageThreadId,
          waitMs,
          dropReason: "limited-droppable",
        });
        return getDroppedTelegramDeliveryResult<TResponse>(method);
      }
      if (waitMs > 0) {
        deps.debugLogger?.log("telegram.delivery.wait", {
          method,
          chatId,
          messageThreadId,
          waitMs,
        });
        await sleepTelegramRetry(waitMs);
      }
      return sendNow();
    });
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    globalDeliveryLimiter.tail = settled;
    if (chatLimiter) chatLimiter.tail = settled;
    return task;
  };
  const callRecorded = async <TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramApiCallOptions,
  ): Promise<TResponse> => {
    return runQueuedDelivery(method, body, async () => {
      const startedAt = Date.now();
      deps.debugLogger?.log("telegram.api.request", { method }, body);
      try {
        const result = await deps.client.call<TResponse>(method, body, options);
        deps.debugLogger?.log(
          "telegram.api.response",
          { method, elapsedMs: Date.now() - startedAt },
          result,
        );
        return result;
      } catch (error) {
        updateDeliveryBackoffFromError(method, body, error);
        deps.debugLogger?.log("telegram.api.error", {
          method,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        deps.recordRuntimeEvent("api", error, { method });
        throw error;
      }
    });
  };
  return {
    call: callRecorded,
    callMultipart: async <TResponse>(
      method: string,
      fields: Record<string, string>,
      fileField: string,
      filePath: string,
      fileName: string,
      options?: TelegramApiCallOptions,
    ): Promise<TResponse> => {
      let effectiveFields = fields;
      if (
        effectiveFields.message_thread_id === undefined &&
        typeof effectiveFields.chat_id === "string"
      ) {
        const chatId = Number(effectiveFields.chat_id);
        if (Number.isFinite(chatId)) {
          const threadId = resolveDefaultThreadId(chatId);
          if (threadId !== undefined) {
            effectiveFields = {
              ...effectiveFields,
              message_thread_id: String(threadId),
            };
          }
        }
      }
      return runQueuedDelivery(method, effectiveFields, async () => {
        const startedAt = Date.now();
        deps.debugLogger?.log(
          "telegram.api.multipart.request",
          { method, fileField, filePath, fileName },
          effectiveFields,
        );
        try {
          const result = await deps.client.callMultipart<TResponse>(
            method,
            effectiveFields,
            fileField,
            filePath,
            fileName,
            options,
          );
          deps.debugLogger?.log(
            "telegram.api.multipart.response",
            { method, fileName, elapsedMs: Date.now() - startedAt },
            result,
          );
          return result;
        } catch (error) {
          updateDeliveryBackoffFromError(method, effectiveFields, error);
          deps.debugLogger?.log("telegram.api.multipart.error", {
            method,
            fileName,
            elapsedMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
          deps.recordRuntimeEvent("multipart", error, { method, fileName });
          throw error;
        }
      });
    },
    downloadFile: async (fileId, suggestedName) => {
      const startedAt = Date.now();
      deps.debugLogger?.log("telegram.api.download.request", {
        fileId,
        suggestedName,
      });
      try {
        const targetPath = await deps.client.downloadFile(
          fileId,
          suggestedName,
          deps.tempDir,
          {
            maxFileSizeBytes: deps.maxFileSizeBytes,
          },
        );
        deps.debugLogger?.log("telegram.api.download.response", {
          fileId,
          suggestedName,
          targetPath,
          elapsedMs: Date.now() - startedAt,
        });
        return targetPath;
      } catch (error) {
        deps.debugLogger?.log("telegram.api.download.error", {
          fileId,
          suggestedName,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        deps.recordRuntimeEvent("download", error, { suggestedName });
        throw error;
      }
    },
    deleteWebhook: (signal) =>
      callRecorded<boolean>(
        "deleteWebhook",
        { drop_pending_updates: false },
        { signal },
      ),
    getUpdates: (body, signal) =>
      callRecorded<TelegramUpdate[]>("getUpdates", body, { signal }),
    setMyCommands: (commands) =>
      callRecorded<boolean>("setMyCommands", { commands }),
    sendChatAction: (chatId, action) =>
      callRecorded<boolean>(
        "sendChatAction",
        withDefaultThreadId({ chat_id: chatId, action }),
      ),
    sendTypingAction: createTelegramChatActionSender(
      (chatId, action) =>
        callRecorded<boolean>(
          "sendChatAction",
          withDefaultThreadId({ chat_id: chatId, action }),
        ),
      "typing",
    ),
    sendMessageDraft: (chatId, draftId, text, options) => {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        draft_id: draftId,
      };
      if (text !== undefined) body.text = text;
      if (options?.parse_mode !== undefined)
        body.parse_mode = options.parse_mode;
      if (options?.entities !== undefined) body.entities = options.entities;
      if (options?.message_thread_id !== undefined) {
        body.message_thread_id = options.message_thread_id;
      }
      return callRecorded<boolean>("sendMessageDraft", withDefaultThreadId(body));
    },
    sendMessage: (body) =>
      callRecorded<TelegramSentMessage>(
        "sendMessage",
        withDefaultThreadId(body),
      ),
    editMessageText: async (body) => {
      const effectiveBody = withDefaultThreadId(body);
      return runQueuedDelivery("editMessageText", effectiveBody, async () => {
        const startedAt = Date.now();
        deps.debugLogger?.log(
          "telegram.api.request",
          { method: "editMessageText" },
          effectiveBody,
        );
        try {
          await deps.client.call("editMessageText", effectiveBody);
          deps.debugLogger?.log("telegram.api.response", {
            method: "editMessageText",
            elapsedMs: Date.now() - startedAt,
            result: "edited",
          });
          return "edited";
        } catch (error) {
          if (isTelegramMessageNotModifiedError(error)) {
            deps.debugLogger?.log("telegram.api.response", {
              method: "editMessageText",
              elapsedMs: Date.now() - startedAt,
              result: "unchanged",
            });
            return "unchanged";
          }
          updateDeliveryBackoffFromError("editMessageText", effectiveBody, error);
          deps.debugLogger?.log("telegram.api.error", {
            method: "editMessageText",
            elapsedMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
          deps.recordRuntimeEvent("api", error, { method: "editMessageText" });
          throw error;
        }
      });
    },
    answerCallbackQuery: async (callbackQueryId, text) => {
      const startedAt = Date.now();
      const body = text
        ? { callback_query_id: callbackQueryId, text }
        : { callback_query_id: callbackQueryId };
      deps.debugLogger?.log("telegram.api.request", { method: "answerCallbackQuery" }, body);
      try {
        await deps.client.answerCallbackQuery(callbackQueryId, text);
        deps.debugLogger?.log("telegram.api.response", {
          method: "answerCallbackQuery",
          elapsedMs: Date.now() - startedAt,
        });
      } catch (error) {
        deps.debugLogger?.log("telegram.api.error", {
          method: "answerCallbackQuery",
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        deps.recordRuntimeEvent("api", error, { method: "answerCallbackQuery" });
        throw error;
      }
    },
    answerGuestQuery: (
      guestQueryId: string,
      text: string | undefined,
      options: { parseMode?: string } | undefined,
    ) => {
      const body: Record<string, unknown> = { guest_query_id: guestQueryId };
      if (text !== undefined) {
        const inputContent: Record<string, unknown> = {
          message_text: text,
        };
        if (options?.parseMode) {
          inputContent.parse_mode = options.parseMode;
        }
        body.result = {
          type: "article",
          id: "1",
          title: "Response",
          input_message_content: inputContent,
        };
      }
      return callRecorded<void>("answerGuestQuery", body);
    },
    prepareTempDir: () =>
      prepareTelegramTempDir(deps.tempDir, deps.tempFileMaxAgeMs),
    deleteMessage: (chatId, messageId) =>
      callRecorded<boolean>("deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      }).then(() => {}),
    deleteForumTopic: (chatId, messageThreadId) =>
      callRecorded<boolean>("deleteForumTopic", {
        chat_id: chatId,
        message_thread_id: messageThreadId,
      }),
  };
}

export function createTelegramApiClient(
  getBotToken: () => string | undefined,
): TelegramApiClient {
  return {
    call: async (method, body, options) => {
      return callTelegram(getBotToken(), method, body, options);
    },
    callMultipart: async (
      method,
      fields,
      fileField,
      filePath,
      fileName,
      options,
    ) => {
      return callTelegramMultipart(
        getBotToken(),
        method,
        fields,
        fileField,
        filePath,
        fileName,
        options,
      );
    },
    downloadFile: async (fileId, suggestedName, tempDir, options) => {
      return downloadTelegramFile(
        getBotToken(),
        fileId,
        suggestedName,
        tempDir,
        options,
      );
    },
    answerCallbackQuery: async (callbackQueryId, text) => {
      await answerTelegramCallbackQuery(getBotToken(), callbackQueryId, text);
    },
  };
}
