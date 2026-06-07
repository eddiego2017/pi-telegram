/**
 * Telegram workspace runtime shared types
 * Zones: telegram controls, pi agent, shared structure
 */

import type {
  RpcChildBackendEvent,
  RpcChildBackendOptions,
  RpcChildSessionState,
} from "./rpc-child.ts";
import type {
  TelegramRenderedChunk,
  TelegramRenderMode,
} from "./replies.ts";
import type {
  TelegramWorkspaceRecord,
} from "./workspaces.ts";
import type { TelegramNormalizedConcurrentWorkspacesConfig } from "./config.ts";
import type { ThinkingLevel } from "./model.ts";
import type { TelegramDebugLogger } from "./debug.ts";
import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import type { TelegramTopicOrphanProofStore } from "./topic-orphans.ts";

export interface TelegramWorkspacePromptContent {
  type: string;
  text?: string;
}

export interface TelegramWorkspacePromptTurn {
  chatId: number;
  messageThreadId?: number;
  replyToMessageId: number;
  content: readonly TelegramWorkspacePromptContent[];
  statusSummary?: string;
}

export interface TelegramWorkspaceForumTopicServiceMessage {
  chat: { id?: number };
  message_id?: number;
  message_thread_id?: number;
  forum_topic_created?: { name: string };
  forum_topic_edited?: { name?: string };
  forum_topic_closed?: Record<string, never>;
  forum_topic_reopened?: Record<string, never>;
  general_forum_topic_hidden?: Record<string, never>;
  general_forum_topic_unhidden?: Record<string, never>;
}

export interface TelegramWorkspaceBackend {
  start: () => Promise<RpcChildSessionState>;
  dispose: () => Promise<void>;
  onEvent: (listener: (event: RpcChildBackendEvent) => void) => () => void;
  prompt: (message: string) => Promise<void>;
  followUp: (message: string) => Promise<void>;
  abort: () => Promise<void>;
  compact: () => Promise<void>;
  newSession: (parentSession?: string) => Promise<{ cancelled: boolean }>;
  switchSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
  getState: () => Promise<RpcChildSessionState>;
  setModel: (provider: string, modelId: string) => Promise<void>;
  setThinkingLevel: (level: string) => Promise<void>;
  setSessionName: (name: string) => Promise<void>;
}

export interface TelegramWorkspaceModelSelection {
  provider: string;
  id: string;
}

export interface TelegramWorkspaceSessionReference {
  workspaceName: string;
  cwd: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  currentModel?: TelegramWorkspaceModelSelection;
}

export interface TelegramWorkspaceResumeSessionScope {
  kind: "workspace";
  workspaceName: string;
  cwd: string;
  sessionDir?: string;
  currentSessionFile?: string;
}

export interface TelegramWorkspaceAbortResult {
  workspaceName: string;
  aborted: boolean;
  message: string;
}

export interface TelegramWorkspaceTreeBranchResult {
  text?: string;
  cancelled: boolean;
  markerId?: string;
}

export interface TelegramWorkspaceManagerDeps<TContext> {
  getConfig: () => TelegramNormalizedConcurrentWorkspacesConfig;
  getCwd: (ctx: TContext) => string;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
  ) => Promise<number | undefined>;
  sendMarkdownReply?: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
  ) => Promise<number | undefined>;
  sendStreamMarkdownReply?: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
  ) => Promise<number | undefined>;
  editStreamMarkdownMessage?: (
    chatId: number,
    messageId: number,
    markdown: string,
  ) => Promise<number | undefined>;
  deleteMessage?: (chatId: number, messageId: number) => Promise<unknown>;
  sendInteractiveMessage?: (
    chatId: number,
    text: string,
    mode: "html" | "plain",
    replyMarkup: TelegramInlineKeyboardMarkup,
  ) => Promise<number | undefined>;
  editInteractiveMessage?: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "html" | "plain",
    replyMarkup: TelegramInlineKeyboardMarkup,
  ) => Promise<void>;
  answerCallbackQuery?: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  sendLastTurnsOnSwitch?: (
    reference: TelegramWorkspaceSessionReference,
    chatId: number,
    replyToMessageId: number,
  ) => Promise<void>;
  streamEditThrottleMs?: number;
  streamFailureBaseRetryMs?: number;
  streamFailureMaxRetryMs?: number;
  sendTypingAction?: (chatId: number) => Promise<unknown>;
  typingIntervalMs?: number;
  now?: () => number;
  agentDir?: string;
  statePath?: string;
  sessionDir?: string;
  getSessionDir?: (ctx: TContext) => string | undefined;
  createBackend?: (options: RpcChildBackendOptions) => TelegramWorkspaceBackend;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  debugLogger?: TelegramDebugLogger;
  createTreeBranch?: (
    reference: TelegramWorkspaceSessionReference,
    entryId: string,
  ) => Promise<TelegramWorkspaceTreeBranchResult> | TelegramWorkspaceTreeBranchResult;
  deleteSessionFile?: (sessionPath: string) => Promise<void>;
  deleteForumTopic?: (
    chatId: number,
    messageThreadId: number,
  ) => Promise<boolean>;
  topicOrphanProofStore?: TelegramTopicOrphanProofStore;
}

export interface WorkspaceRuntime {
  record: TelegramWorkspaceRecord;
  backend?: TelegramWorkspaceBackend;
  closing?: boolean;
  unreadEvents: number;
  activeBuffer: string;
  activeAssistantText?: string;
  activeErrorDelivered?: boolean;
  streamDeliveryFailureCount?: number;
  streamDeliveryBlockedUntil?: number;
  lastStreamFlushAt?: number;
  textStream?: TelegramWorkspaceStreamState;
  thinkingBuffers: Map<number, string>;
  thinkingStreams: Map<number, TelegramWorkspaceStreamState>;
  toolCallStreams: Map<number, TelegramWorkspaceStreamState>;
  toolCallStatusStream?: TelegramWorkspaceStreamState;
  toolCallStatuses: Map<string, TelegramWorkspaceToolStatusEntry>;
  sentThinkingTexts: Set<string>;
  sentToolCallMessages: Set<string>;
  postRunMessages: TelegramWorkspacePostRunMessage[];
  typingChatId?: number;
  typingMessageThreadId?: number;
  typingInterval?: ReturnType<typeof setInterval>;
  activeChatId?: number;
  activeMessageThreadId?: number;
  activeReplyToMessageId?: number;
  activeTopicDelivery?: boolean;
  activeTurnId?: string;
  promptStartedAt?: number;
  promptSentAt?: number;
  agentStartedAt?: number;
  firstOutputAt?: number;
  firstOutputLogged?: boolean;
  pendingCompactionTurns?: TelegramWorkspacePromptTurn[];
  unsubscribe?: () => void;
}

export type TelegramWorkspaceToolStatusKind = "queued" | "running" | "done" | "failed";

export type TelegramWorkspacePostRunMessageKind = "thinking" | "tool" | "text";

export interface TelegramWorkspacePostRunMessage {
  kind: TelegramWorkspacePostRunMessageKind;
  markdown: string;
  stream?: TelegramWorkspaceStreamState;
}

export interface TelegramWorkspaceToolStatusEntry {
  key: string;
  markdown: string;
  status: TelegramWorkspaceToolStatusKind;
  updatedAt: number;
}

export type TelegramWorkspaceDashboardMode = "open" | "close";

export interface TelegramWorkspaceDashboardState {
  chatId: number;
  messageId: number;
  mode: TelegramWorkspaceDashboardMode;
  selectedCloseWorkspaces: string[];
  updatedAt: number;
}

export interface TelegramWorkspaceStreamState {
  markdown: string;
  sentMarkdown: string;
  lastFlushAt: number;
  failedFlushCount?: number;
  nextFlushAt?: number;
  messageId?: number;
  turnId?: string;
  chatId?: number;
  messageThreadId?: number;
  replyToMessageId?: number;
  flushTimer?: ReturnType<typeof setTimeout>;
  flushPromise?: Promise<TelegramWorkspaceStreamDeliveryResult>;
  flushRequested?: boolean;
  suppressRetryOnFailure?: boolean;
}

export type TelegramWorkspaceStreamDeliveryResult =
  | {
      status: "delivered";
      sentMarkdown: string;
      messageId?: number;
      stale: boolean;
    }
  | { status: "scheduled"; reason: string; retryAt?: number; stale: boolean }
  | { status: "skipped"; reason: string; stale: boolean }
  | { status: "failed"; error?: string; stale: boolean };

export type TelegramWorkspaceDashboardWorkerState = "running" | "idle" | "not-started";

export interface TelegramWorkspaceSessionIdentity {
  sessionFile?: string;
  canonicalSessionFile?: string;
  sessionId?: string;
}

export interface TelegramWorkspaceMarkdownMessageEditorDeps {
  renderTelegramMessage: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
  editRenderedMessage: (
    chatId: number,
    messageId: number,
    chunks: TelegramRenderedChunk[],
    options?: { disableLinkPreview?: boolean },
  ) => Promise<number | undefined>;
}

export interface TelegramWorkspaceCallbackQuery {
  id: string;
  data?: string;
  message?: { chat?: { id?: number }; message_id?: number };
}

export interface TelegramWorkspaceManager<TContext> {
  isEnabled: () => boolean;
  getActiveModel: (
    ctx: TContext,
  ) => Promise<TelegramWorkspaceModelSelection | undefined>;
  getActiveThinkingLevel: (ctx: TContext) => Promise<ThinkingLevel | undefined>;
  getActiveSessionReference: (
    ctx: TContext,
  ) => TelegramWorkspaceSessionReference | undefined;
  getActiveResumeSessionScope: (
    ctx: TContext,
  ) => TelegramWorkspaceResumeSessionScope | undefined;
  getActiveSessionName: (ctx: TContext) => string | undefined;
  canSwitchActiveModel: (ctx: TContext) => Promise<boolean>;
  selectActiveModel: (
    model: TelegramWorkspaceModelSelection,
    ctx: TContext,
  ) => Promise<boolean>;
  setActiveThinkingLevel: (
    level: ThinkingLevel,
    ctx: TContext,
  ) => Promise<ThinkingLevel | undefined>;
  setActiveSessionName: (name: string, ctx: TContext) => Promise<boolean>;
  compactActive: (
    ctx: TContext,
    callbacks: { onComplete: () => void; onError: (error: unknown) => void },
  ) => boolean;
  newActiveSession: (
    ctx: TContext,
  ) => Promise<{ cancelled: boolean } | undefined>;
  deleteActiveSession: (
    expectedSessionPath: string,
    ctx: TContext,
  ) => Promise<boolean | undefined>;
  abortActive: (ctx: TContext) => Promise<TelegramWorkspaceAbortResult | undefined>;
  switchSession: (
    sessionPath: string,
    ctx: TContext,
    scope?: { kind?: string; workspaceName?: string },
  ) => Promise<boolean>;
  createActiveTreeBranch: (
    entryId: string,
    ctx: TContext,
  ) => Promise<TelegramWorkspaceTreeBranchResult | undefined>;
  handleCommand: (
    args: string,
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<boolean>;
  handleTopicCommand?: (
    args: string,
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<boolean>;
  handleCallbackQuery: (
    query: TelegramWorkspaceCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
  handleTopicServiceMessage: (
    message: TelegramWorkspaceForumTopicServiceMessage,
    ctx: TContext,
  ) => Promise<boolean>;
  dispatchPrompt: (turn: TelegramWorkspacePromptTurn, ctx: TContext) => Promise<boolean>;
  dispose: () => Promise<void>;
}
