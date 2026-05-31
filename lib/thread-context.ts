/**
 * Telegram message_thread_id ambient context
 * Zones: telegram inbound, telegram outbound, async scoping
 * Owns the AsyncLocalStorage that lets inbound handlers stamp the current
 * (chatId, threadId) pair so outbound API calls during the same async scope
 * can inject `message_thread_id` automatically — but only when the outbound
 * target chat matches the ambient chat.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface TelegramThreadContextScope {
  chatId: number;
  messageThreadId?: number;
}

export interface TelegramForumThreadMessage {
  message_thread_id?: unknown;
}

export interface TelegramForumThreadNormalizationOptions {
  generalThreadId?: number;
}

export type TelegramForumThread =
  | { kind: "general"; messageThreadId?: number }
  | { kind: "topic"; messageThreadId: number };

export function normalizeTelegramForumThread(
  message: TelegramForumThreadMessage | undefined,
  options: TelegramForumThreadNormalizationOptions = {},
): TelegramForumThread {
  const messageThreadId = message?.message_thread_id;
  if (typeof messageThreadId !== "number") {
    return { kind: "general" };
  }
  if (options.generalThreadId !== undefined && messageThreadId === options.generalThreadId) {
    return { kind: "general", messageThreadId };
  }
  return { kind: "topic", messageThreadId };
}

export const normalizeForumThread = normalizeTelegramForumThread;

export function formatTelegramForumThreadKey(
  thread: TelegramForumThread,
): string {
  return thread.kind === "topic" ? String(thread.messageThreadId) : "general";
}

export function getTelegramForumThreadMessageThreadId(
  thread: TelegramForumThread,
): number | undefined {
  return thread.messageThreadId;
}

export function getTelegramForumTopicMessageThreadId(
  thread: TelegramForumThread,
): number | undefined {
  return thread.kind === "topic" ? thread.messageThreadId : undefined;
}

const threadContextStorage =
  new AsyncLocalStorage<TelegramThreadContextScope | undefined>();

export function runWithTelegramThreadContext<T>(
  scope: TelegramThreadContextScope | undefined,
  fn: () => T,
): T {
  return threadContextStorage.run(scope, fn);
}

export function getAmbientTelegramThreadContext():
  | TelegramThreadContextScope
  | undefined {
  return threadContextStorage.getStore();
}

export interface TelegramMessageThreadIdResolverDeps {
  /** Fallback when no ambient scope is active (e.g. proactive push from
   *  agent lifecycle hooks). Returns the active turn's chat/thread pair. */
  getActiveTurnThreadContext?: () => TelegramThreadContextScope | undefined;
}

export function createTelegramMessageThreadIdResolver(
  deps: TelegramMessageThreadIdResolverDeps,
): (chatId: number) => number | undefined {
  function resolveTelegramMessageThreadId(
    chatId: number,
  ): number | undefined {
    const ambient = threadContextStorage.getStore();
    const scope = ambient ?? deps.getActiveTurnThreadContext?.();
    if (!scope) return undefined;
    if (scope.chatId !== chatId) return undefined;
    return scope.messageThreadId;
  }
  return resolveTelegramMessageThreadId;
}

export interface TelegramActiveTurnThreadContextGetterDeps {
  getChatId: () => number | undefined;
  getMessageThreadId: () => number | undefined;
}

export function createTelegramActiveTurnThreadContextGetter(
  deps: TelegramActiveTurnThreadContextGetterDeps,
): () => TelegramThreadContextScope | undefined {
  function getTelegramActiveTurnThreadContext():
    | TelegramThreadContextScope
    | undefined {
    const chatId = deps.getChatId();
    if (typeof chatId !== "number") return undefined;
    return { chatId, messageThreadId: deps.getMessageThreadId() };
  }
  return getTelegramActiveTurnThreadContext;
}
