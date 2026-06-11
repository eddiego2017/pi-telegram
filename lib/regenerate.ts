/**
 * Telegram /regenerate pure logic
 * Zones: orchestration
 *
 * Implements the "regenerate last turn" mechanism used by the Telegram bridge:
 * locate the last user-message entry on the current session branch, extract its
 * original prompt content (text + images), and decide whether regeneration is
 * allowed. The actual tree navigation + re-dispatch is wired by callers; this
 * module only computes targets and guard decisions so it stays easy to test.
 */

export interface TelegramRegenerateTextBlock {
  type: "text";
  text: string;
}

export interface TelegramRegenerateImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export type TelegramRegeneratePromptBlock =
  | TelegramRegenerateTextBlock
  | TelegramRegenerateImageBlock;

/** Minimal shape of a session entry as seen on the current branch. */
export interface TelegramRegenerateSessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  message?: {
    role?: unknown;
    content?: unknown;
  };
}

export interface TelegramRegenerateTarget {
  entryId: string;
  content: TelegramRegeneratePromptBlock[];
}

function isTelegramRegenerateUserMessageEntry(
  entry: TelegramRegenerateSessionEntry,
): boolean {
  return entry.type === "message" && entry.message?.role === "user";
}

/**
 * Convert a session user-message content value into prompt blocks suitable for
 * re-dispatch. Strings become a single text block; arrays keep text and image
 * blocks and drop anything else (thinking, tool calls, etc.).
 */
export function normalizeTelegramRegenerateContent(
  content: unknown,
): TelegramRegeneratePromptBlock[] {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: TelegramRegeneratePromptBlock[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const raw = block as {
      type?: unknown;
      text?: unknown;
      data?: unknown;
      mimeType?: unknown;
    };
    if (raw.type === "text" && typeof raw.text === "string") {
      blocks.push({ type: "text", text: raw.text });
    } else if (
      raw.type === "image" &&
      typeof raw.data === "string" &&
      typeof raw.mimeType === "string"
    ) {
      blocks.push({ type: "image", data: raw.data, mimeType: raw.mimeType });
    }
  }
  return blocks;
}

/**
 * Find the most recent user-message entry on the current branch. The branch is
 * ordered root-first, so the last matching entry is the prompt that produced
 * the latest agent reply.
 */
export function findTelegramRegenerateTarget(
  branch: readonly TelegramRegenerateSessionEntry[],
): TelegramRegenerateTarget | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!entry || !isTelegramRegenerateUserMessageEntry(entry)) continue;
    const content = normalizeTelegramRegenerateContent(entry.message?.content);
    if (content.length === 0) return undefined;
    return { entryId: entry.id, content };
  }
  return undefined;
}

/**
 * Single-slot record of an in-flight /regenerate: the queued turn's message id
 * plus the context it was queued against. Regeneration is serialized (the guard
 * requires an idle bridge with an empty queue), so one slot is sufficient. The
 * router sets it before injecting the rewind; the outcome notifier takes it to
 * either dispatch the queued turn (success) or remove the stranded turn
 * (failure).
 */
export interface TelegramRegeneratePending<TContext> {
  entryId: string;
  messageId: number;
  ctx: TContext;
}

export interface TelegramRegeneratePendingStore<TContext> {
  set: (pending: TelegramRegeneratePending<TContext>) => void;
  take: () => TelegramRegeneratePending<TContext> | undefined;
}

export function createTelegramRegeneratePendingStore<
  TContext,
>(): TelegramRegeneratePendingStore<TContext> {
  let pending: TelegramRegeneratePending<TContext> | undefined;
  return {
    set: (next) => {
      pending = next;
    },
    take: () => {
      const current = pending;
      pending = undefined;
      return current;
    },
  };
}

export interface TelegramRegenerateOutcomeNotifierDeps<TContext> {
  pendingStore: TelegramRegeneratePendingStore<TContext>;
  getAllowedUserId: () => number | undefined;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
  ) => Promise<unknown>;
  /** Dispatch the queued regenerate turn after a successful rewind. */
  dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
  /** Remove the stranded regenerate turn when the rewind fails. */
  removeQueuedTurnsByMessageIds: (
    messageIds: number[],
    ctx: TContext,
  ) => void;
}

export type TelegramRegenerateOutcome =
  | { ok: true; entryId: string }
  | { ok: false; entryId: string; error: string };

/**
 * Build the /regenerate outcome handler. On a successful tree rewind it
 * dispatches the queued regenerate turn (which sets the active turn so the
 * regenerated reply routes back to the originating chat). On failure it removes
 * the stranded queued turn and notifies the user.
 */
export function createTelegramRegenerateOutcomeNotifier<TContext>(
  deps: TelegramRegenerateOutcomeNotifierDeps<TContext>,
): (outcome: TelegramRegenerateOutcome) => Promise<void> {
  return async function notifyTelegramRegenerateOutcome(outcome) {
    const pending = deps.pendingStore.take();
    if (outcome.ok) {
      if (pending) deps.dispatchNextQueuedTelegramTurn(pending.ctx);
      return;
    }
    if (pending) {
      deps.removeQueuedTurnsByMessageIds([pending.messageId], pending.ctx);
    }
    const chatId = deps.getAllowedUserId();
    if (typeof chatId !== "number") return;
    try {
      await deps.sendTextReply(
        chatId,
        pending?.messageId ?? 0,
        `⚠️ Regenerate failed: ${outcome.error}`,
      );
    } catch {
      // best-effort notification only
    }
  };
}

export interface TelegramRegenerateGuardState {
  isIdle: boolean;
  hasPendingMessages: boolean;
  hasActiveTurn: boolean;
  hasDispatchPending: boolean;
  hasQueuedItems: boolean;
  isCompactionInProgress: boolean;
}

export type TelegramRegenerateDecision =
  | { ok: true; target: TelegramRegenerateTarget }
  | { ok: false; reason: "busy" | "no-target" };

/**
 * Decide whether a /regenerate request can proceed. Regeneration rewinds the
 * session tree and re-dispatches, so it must only run while the bridge is fully
 * idle (mirrors the /compact guard) and a regenerable user turn exists.
 */
export function decideTelegramRegenerate(
  state: TelegramRegenerateGuardState,
  branch: readonly TelegramRegenerateSessionEntry[],
): TelegramRegenerateDecision {
  if (
    !state.isIdle ||
    state.hasPendingMessages ||
    state.hasActiveTurn ||
    state.hasDispatchPending ||
    state.hasQueuedItems ||
    state.isCompactionInProgress
  ) {
    return { ok: false, reason: "busy" };
  }
  const target = findTelegramRegenerateTarget(branch);
  if (!target) return { ok: false, reason: "no-target" };
  return { ok: true, target };
}
