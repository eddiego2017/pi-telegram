/**
 * Telegram reply delivery helpers
 * Zones: telegram outbound, rendering transport
 * Owns rendered-message delivery, reply transport wiring, and plain or markdown final replies
 */

import type { TelegramReplyParameters, TelegramSentMessage } from "./api.ts";
import type { TelegramPromptCacheUsageSnapshot } from "./context-usage.ts";
import {
  renderTelegramMessage,
  type TelegramRenderedChunk,
  type TelegramRenderMode,
} from "./rendering.ts";

export {
  renderTelegramMessage,
  type TelegramRenderedChunk,
  type TelegramRenderMode,
};

// --- Reply Dedup ---

/** Non-persistent reply deduplication for a single agent turn.
 *  First reply to a prompt gets `reply_parameters.reply_to_message_id`;
 *  subsequent replies in the same turn skip it to avoid stacking
 *  duplicate reply headers in the chat viewport. */
export interface ReplyDedupRuntime {
  /** Returns true if this is the first reply for the given prompt
   *  message id in the current turn. Side-effect: marks it replied. */
  shouldReply(promptMessageId: number): boolean;
  /** Reset the tracker when a new prompt enters the queue. */
  reset(): void;
}

export function createReplyDedupRuntime(): ReplyDedupRuntime {
  const replied = new Map<number, boolean>();
  return {
    shouldReply(promptMessageId: number): boolean {
      if (replied.has(promptMessageId)) return false;
      replied.set(promptMessageId, true);
      return true;
    },
    reset(): void {
      replied.clear();
    },
  };
}

// --- Transport-level dedup ---

let lastRepliedToMessageId: number | undefined;

export function resetTransportReplyDedup(): void {
  lastRepliedToMessageId = undefined;
}

export function buildTelegramReplyParameters(
  messageId: number | undefined,
): TelegramReplyParameters | undefined {
  if (messageId === undefined) return undefined;
  if (messageId === lastRepliedToMessageId) return undefined;
  lastRepliedToMessageId = messageId;
  return { message_id: messageId, allow_sending_without_reply: true };
}

export function buildTelegramMultipartReplyParameters(
  messageId: number | undefined,
): string | undefined {
  const parameters = buildTelegramReplyParameters(messageId);
  return parameters ? JSON.stringify(parameters) : undefined;
}

function getAgentMessageField(message: unknown, field: string): unknown {
  if (typeof message !== "object" || message === null || !(field in message)) {
    return undefined;
  }
  return Reflect.get(message, field);
}

export function isAssistantAgentMessage(message: unknown): boolean {
  return getAgentMessageField(message, "role") === "assistant";
}

const TELEGRAM_TOOL_CALL_ARGS_HEAD_LINES = 3;
const TELEGRAM_TOOL_CALL_ARGS_TAIL_LINES = 2;
const TELEGRAM_TOOL_CALL_ARGS_LINE_LIMIT = 240;
const TELEGRAM_TOOL_CALL_ARGS_PREVIEW_LIMIT = 400;
const TELEGRAM_TOOL_CALL_ARGS_OMISSION = "   ......";

function formatAgentToolCallArguments(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function expandEscapedNewlinesForTelegramToolPreview(text: string): string {
  return text.replace(/\\n/g, "\n");
}

function truncateTelegramToolPreviewLine(line: string): string {
  if (line.length <= TELEGRAM_TOOL_CALL_ARGS_LINE_LIMIT) return line;
  return `${line.slice(0, TELEGRAM_TOOL_CALL_ARGS_LINE_LIMIT)}…`;
}

function isTelegramToolPreviewJsonSuffixLine(line: string): boolean {
  const trimmed = line.trim();
  if (/^[}\]],?$/.test(trimmed)) return true;
  return /^"[^"\\]+"\s*:\s*(?:-?\d+(?:\.\d+)?|true|false|null|"[^"\\]*"|\{.*\}|\[.*\]),?$/.test(
    trimmed,
  );
}

function findTelegramToolPreviewRollingEnd(lines: string[]): number {
  let end = lines.length;
  while (
    end > TELEGRAM_TOOL_CALL_ARGS_HEAD_LINES &&
    isTelegramToolPreviewJsonSuffixLine(lines[end - 1] ?? "")
  ) {
    end -= 1;
  }
  return end;
}

export function formatTelegramToolCallArgumentsPreview(argsText: string): string {
  const displayText = expandEscapedNewlinesForTelegramToolPreview(argsText);
  const lines = displayText.split("\n");
  const rollingEnd = findTelegramToolPreviewRollingEnd(lines);
  const rollingLines = lines.slice(0, rollingEnd);
  const suffixLines = lines.slice(rollingEnd);
  const shouldRoll =
    rollingLines.length >
      TELEGRAM_TOOL_CALL_ARGS_HEAD_LINES + TELEGRAM_TOOL_CALL_ARGS_TAIL_LINES ||
    displayText.length > TELEGRAM_TOOL_CALL_ARGS_PREVIEW_LIMIT;
  if (!shouldRoll) return displayText;
  const head = rollingLines.slice(0, TELEGRAM_TOOL_CALL_ARGS_HEAD_LINES);
  const tailStart = Math.max(
    TELEGRAM_TOOL_CALL_ARGS_HEAD_LINES,
    rollingLines.length - TELEGRAM_TOOL_CALL_ARGS_TAIL_LINES,
  );
  const tail = rollingLines.slice(tailStart);
  return [...head, TELEGRAM_TOOL_CALL_ARGS_OMISSION, ...tail, ...suffixLines]
    .map(truncateTelegramToolPreviewLine)
    .join("\n");
}

export function formatAgentToolCallBlock(block: {
  name?: unknown;
  arguments?: unknown;
}): string {
  const name =
    typeof block.name === "string" && block.name.length > 0
      ? block.name
      : "tool";
  const argsText = formatAgentToolCallArguments(block.arguments);
  if (argsText.length === 0) return `\u{1F527} \`${name}\``;
  const preview = formatTelegramToolCallArgumentsPreview(argsText);
  return `\u{1F527} \`${name}\`\n\`\`\`json\n${preview}\n\`\`\``;
}

function extractAgentTextContent(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [];
  let result = "";
  const appendBlock = (rendered: string): void => {
    if (rendered.length === 0) return;
    if (result.length === 0) {
      result = rendered;
      return;
    }
    const separator = result.endsWith("\n\n")
      ? ""
      : result.endsWith("\n")
        ? "\n"
        : "\n\n";
    result = `${result}${separator}${rendered}`;
  };
  for (const block of blocks) {
    if (typeof block !== "object" || block === null || !("type" in block)) {
      continue;
    }
    const type = (block as { type: unknown }).type;
    if (type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") result += text;
      continue;
    }
    if (type === "toolCall") {
      appendBlock(
        formatAgentToolCallBlock(
          block as { name?: unknown; arguments?: unknown },
        ),
      );
    }
  }
  return result.trim();
}

export function getAgentMessageText(message: unknown): string {
  return extractAgentTextContent(getAgentMessageField(message, "content"));
}

function getNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function extractAgentPromptCacheUsage(
  message: unknown,
): TelegramPromptCacheUsageSnapshot | undefined {
  const rawUsage = getAgentMessageField(message, "usage");
  if (typeof rawUsage !== "object" || rawUsage === null) return undefined;
  const input = getNonNegativeNumber(Reflect.get(rawUsage, "input"));
  const cacheRead = getNonNegativeNumber(Reflect.get(rawUsage, "cacheRead"));
  const cacheWrite = getNonNegativeNumber(Reflect.get(rawUsage, "cacheWrite"));
  if (input === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return undefined;
  }
  return { input, cacheRead, cacheWrite };
}

export function extractLatestAssistantMessageText(
  messages: readonly unknown[],
): {
  text?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: TelegramPromptCacheUsageSnapshot;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || !isAssistantAgentMessage(message)) continue;
    const rawStopReason = getAgentMessageField(message, "stopReason");
    const rawErrorMessage = getAgentMessageField(message, "errorMessage");
    const stopReason =
      typeof rawStopReason === "string" ? rawStopReason : undefined;
    const errorMessage =
      typeof rawErrorMessage === "string" ? rawErrorMessage : undefined;
    const text = getAgentMessageText(message);
    const usage = extractAgentPromptCacheUsage(message);
    return {
      text: text || undefined,
      stopReason,
      errorMessage,
      ...(usage ? { usage } : {}),
    };
  }
  return {};
}

export interface TelegramReplyDeliveryDeps<TReplyMarkup> {
  sendMessage: (body: {
    chat_id: number;
    text: string;
    parse_mode?: "HTML";
    reply_markup?: TReplyMarkup;
    reply_parameters?: TelegramReplyParameters;
    link_preview_options?: { is_disabled: true };
  }) => Promise<TelegramSentMessage>;
  editMessage: (body: {
    chat_id: number;
    message_id: number;
    text: string;
    parse_mode?: "HTML";
    reply_markup?: TReplyMarkup;
    link_preview_options?: { is_disabled: true };
  }) => Promise<unknown>;
}

export interface TelegramReplyTransport<TReplyMarkup> {
  sendRenderedChunks: (
    chatId: number,
    chunks: TelegramRenderedChunk[],
    options?: {
      replyMarkup?: TReplyMarkup;
      replyToMessageId?: number;
      disableLinkPreview?: boolean;
    },
  ) => Promise<number | undefined>;
  editRenderedMessage: (
    chatId: number,
    messageId: number,
    chunks: TelegramRenderedChunk[],
    options?: { replyMarkup?: TReplyMarkup; disableLinkPreview?: boolean },
  ) => Promise<number | undefined>;
}

export function buildTelegramReplyTransport<TReplyMarkup>(
  deps: TelegramReplyDeliveryDeps<TReplyMarkup>,
): TelegramReplyTransport<TReplyMarkup> {
  return {
    sendRenderedChunks: async (chatId, chunks, options) => {
      return sendTelegramRenderedChunks(chatId, chunks, deps, options);
    },
    editRenderedMessage: async (chatId, messageId, chunks, options) => {
      return editTelegramRenderedMessage(
        chatId,
        messageId,
        chunks,
        deps,
        options,
      );
    },
  };
}

export async function sendTelegramRenderedChunks<TReplyMarkup>(
  chatId: number,
  chunks: TelegramRenderedChunk[],
  deps: TelegramReplyDeliveryDeps<TReplyMarkup>,
  options?: {
    replyMarkup?: TReplyMarkup;
    replyToMessageId?: number;
    disableLinkPreview?: boolean;
  },
): Promise<number | undefined> {
  let lastMessageId: number | undefined;
  for (const [index, chunk] of chunks.entries()) {
    const replyParameters =
      index === 0
        ? buildTelegramReplyParameters(options?.replyToMessageId)
        : undefined;
    const sent = await deps.sendMessage({
      chat_id: chatId,
      text: chunk.text,
      parse_mode: chunk.parseMode,
      reply_markup:
        index === chunks.length - 1 ? options?.replyMarkup : undefined,
      ...(replyParameters ? { reply_parameters: replyParameters } : {}),
      ...(options?.disableLinkPreview
        ? { link_preview_options: { is_disabled: true as const } }
        : {}),
    });
    lastMessageId = sent.message_id;
  }
  return lastMessageId;
}

export async function editTelegramRenderedMessage<TReplyMarkup>(
  chatId: number,
  messageId: number,
  chunks: TelegramRenderedChunk[],
  deps: TelegramReplyDeliveryDeps<TReplyMarkup>,
  options?: { replyMarkup?: TReplyMarkup; disableLinkPreview?: boolean },
): Promise<number | undefined> {
  if (chunks.length === 0) return messageId;
  const [firstChunk, ...remainingChunks] = chunks;
  await deps.editMessage({
    chat_id: chatId,
    message_id: messageId,
    text: firstChunk.text,
    parse_mode: firstChunk.parseMode,
    reply_markup:
      remainingChunks.length === 0 ? options?.replyMarkup : undefined,
    ...(options?.disableLinkPreview
      ? { link_preview_options: { is_disabled: true as const } }
      : {}),
  });
  if (remainingChunks.length > 0) {
    return sendTelegramRenderedChunks(chatId, remainingChunks, deps, {
      replyMarkup: options?.replyMarkup,
      disableLinkPreview: options?.disableLinkPreview,
    });
  }
  return messageId;
}

export interface TelegramReplyRuntimeDeps<TReplyMarkup = unknown> {
  renderTelegramMessage: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
  sendRenderedChunks: (
    chunks: TelegramRenderedChunk[],
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<number | undefined>;
}

export async function sendTelegramPlainReply(
  text: string,
  deps: TelegramReplyRuntimeDeps,
  options?: { parseMode?: "HTML" },
): Promise<number | undefined> {
  const chunks = deps.renderTelegramMessage(text, {
    mode: options?.parseMode === "HTML" ? "html" : "plain",
  });
  return deps.sendRenderedChunks(chunks);
}

export async function sendTelegramMarkdownReply<TReplyMarkup = unknown>(
  markdown: string,
  deps: TelegramReplyRuntimeDeps,
  options?: { replyMarkup?: TReplyMarkup },
): Promise<number | undefined> {
  const chunks = deps.renderTelegramMessage(markdown, { mode: "markdown" });
  if (chunks.length === 0) {
    return sendTelegramPlainReply(markdown, deps);
  }
  return deps.sendRenderedChunks(chunks, options);
}

export interface TelegramRenderedMessageRuntimeDeps<TReplyMarkup> {
  renderTelegramMessage: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
  replyTransport: TelegramReplyTransport<TReplyMarkup>;
}

export interface TelegramRenderedMessageRuntime<TReplyMarkup> {
  sendTextReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
    options?: { parseMode?: "HTML" },
  ) => Promise<number | undefined>;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: { replyMarkup?: unknown },
  ) => Promise<number | undefined>;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: TelegramRenderMode,
    replyMarkup: TReplyMarkup,
  ) => Promise<void>;
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: TelegramRenderMode,
    replyMarkup: TReplyMarkup,
  ) => Promise<number | undefined>;
}

export interface TelegramRenderedMessageDeliveryRuntime<
  TReplyMarkup,
> extends TelegramRenderedMessageRuntime<TReplyMarkup> {
  replyTransport: TelegramReplyTransport<TReplyMarkup>;
}

export interface TelegramRenderedMessageDeliveryRuntimeDeps<
  TReplyMarkup,
> extends TelegramReplyDeliveryDeps<TReplyMarkup> {
  renderTelegramMessage?: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
}

export function createTelegramRenderedMessageDeliveryRuntime<TReplyMarkup>(
  deps: TelegramRenderedMessageDeliveryRuntimeDeps<TReplyMarkup>,
): TelegramRenderedMessageDeliveryRuntime<TReplyMarkup> {
  const replyTransport = buildTelegramReplyTransport({
    sendMessage: deps.sendMessage,
    editMessage: deps.editMessage,
  });
  return {
    replyTransport,
    ...createTelegramRenderedMessageRuntime({
      renderTelegramMessage:
        deps.renderTelegramMessage ?? renderTelegramMessage,
      replyTransport,
    }),
  };
}

export function createTelegramRenderedMessageRuntime<TReplyMarkup>(
  deps: TelegramRenderedMessageRuntimeDeps<TReplyMarkup>,
): TelegramRenderedMessageRuntime<TReplyMarkup> {
  return {
    sendTextReply: async (chatId, replyToMessageId, text, options) => {
      return sendTelegramPlainReply(
        text,
        {
          renderTelegramMessage: deps.renderTelegramMessage,
          sendRenderedChunks: (chunks) =>
            deps.replyTransport.sendRenderedChunks(chatId, chunks, {
              replyToMessageId,
            }),
        },
        options,
      );
    },
    sendMarkdownReply: async (chatId, replyToMessageId, markdown, options) => {
      return sendTelegramMarkdownReply(
        markdown,
        {
          renderTelegramMessage: deps.renderTelegramMessage,
          sendRenderedChunks: (chunks, chunkOptions) =>
            deps.replyTransport.sendRenderedChunks(chatId, chunks, {
              replyToMessageId,
              replyMarkup: chunkOptions?.replyMarkup as
                | TReplyMarkup
                | undefined,
            }),
        },
        options,
      );
    },
    editInteractiveMessage: async (
      chatId,
      messageId,
      text,
      mode,
      replyMarkup,
    ) => {
      await deps.replyTransport.editRenderedMessage(
        chatId,
        messageId,
        deps.renderTelegramMessage(text, { mode }),
        { replyMarkup, disableLinkPreview: true },
      );
    },
    sendInteractiveMessage: async (chatId, text, mode, replyMarkup) => {
      return deps.replyTransport.sendRenderedChunks(
        chatId,
        deps.renderTelegramMessage(text, { mode }),
        { replyMarkup, disableLinkPreview: true },
      );
    },
  };
}

// --- Dedup-wrapped Reply Wrappers ---

/** Wrap a sendTextReply with reply dedup so only the first message
 *  in a turn carries `reply_to_message_id`. */
export function dedupSendTextReply(
  dedup: ReplyDedupRuntime,
  inner: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
    options?: { parseMode?: "HTML" },
  ) => Promise<number | undefined>,
): (
  chatId: number,
  replyToMessageId: number,
  text: string,
  options?: { parseMode?: "HTML" },
) => Promise<number | undefined> {
  return async (chatId, replyToMessageId, text, options) => {
    const effectiveReplyTo = dedup.shouldReply(replyToMessageId)
      ? replyToMessageId
      : undefined;
    return inner(chatId, effectiveReplyTo, text, options);
  };
}

/** Wrap a sendMarkdownReply with reply dedup. */
export function dedupSendMarkdownReply<TReplyMarkup = unknown>(
  dedup: ReplyDedupRuntime,
  inner: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<number | undefined>,
): (
  chatId: number,
  replyToMessageId: number,
  markdown: string,
  options?: { replyMarkup?: TReplyMarkup },
) => Promise<number | undefined> {
  return async (chatId, replyToMessageId, markdown, options) => {
    const effectiveReplyTo = dedup.shouldReply(replyToMessageId)
      ? replyToMessageId
      : undefined;
    return inner(chatId, effectiveReplyTo, markdown, options);
  };
}

/**
 * Guest reply sender: renders Markdown → HTML, sends via answerGuestQuery.
 * Keeps guest rendering inside the replies domain so the orchestration layer
 * (index.ts) does not import from rendering.ts directly. */
export function createGuestMarkdownReplySender(deps: {
  renderTelegramMessage: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
  answerGuestQuery: (
    guestQueryId: string,
    text?: string,
    options?: { parseMode?: string },
  ) => Promise<void>;
}) {
  return async (guestQueryId: string, markdown: string) => {
    const chunks = deps.renderTelegramMessage(markdown, { mode: "markdown" });
    const html = chunks.length > 0 ? chunks[0].text : markdown;
    await deps.answerGuestQuery(guestQueryId, html, { parseMode: "HTML" });
  };
}
