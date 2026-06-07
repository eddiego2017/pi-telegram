/**
 * Telegram inbound routing composition
 * Zones: telegram inbound, orchestration, queue/menu/command composition
 * Wires authorized updates into menus, commands, media grouping, and prompt queueing
 */

import { readFile } from "node:fs/promises";
import * as Commands from "./commands.ts";
import {
  isTelegramForumNativeModeEnabled,
  isTelegramTrustedChat,
  type TelegramConfigStore,
} from "./config.ts";
import type { TelegramDebugLogger } from "./debug.ts";
import type { TelegramSectionRegistry } from "./extension-sections.ts";
import type { TelegramInboundHandlerRuntime } from "./inbound-handlers.ts";
import * as Media from "./media.ts";
import * as Menu from "./menu.ts";
import * as MenuDump from "./menu-dump.ts";
import * as MenuSession from "./menu-session.ts";
import * as MenuTree from "./menu-tree.ts";
import * as Model from "./model.ts";
import * as OutboundHandlers from "./outbound-handlers.ts";
import * as PromptTemplates from "./prompt-templates.ts";
import * as Queue from "./queue.ts";
import type { TelegramBridgeRuntime } from "./runtime.ts";
import type {
  TelegramWorkspaceCallbackQuery,
  TelegramWorkspaceManager,
} from "./workspace-manager.ts";
import * as TextGroups from "./text-groups.ts";
import * as Turns from "./turns.ts";
import {
  getTelegramForumThreadMessageThreadId,
  normalizeTelegramForumThread,
} from "./thread-context.ts";
import type { TelegramUser } from "./updates.ts";
import * as Updates from "./updates.ts";

export type TelegramRoutedMessage = Updates.TelegramUpdateMessage &
  Media.TelegramMediaMessage &
  Media.TelegramMediaGroupMessage &
  Commands.TelegramCommandRuntimeMessage &
  Turns.TelegramTurnMessage;

export type TelegramRoutedCallbackQuery = Updates.TelegramCallbackQuery &
  Menu.MenuCallbackQuery &
  MenuDump.TelegramDumpMenuCallbackQuery &
  MenuSession.TelegramSessionMenuCallbackQuery &
  TelegramWorkspaceCallbackQuery &
  MenuTree.TelegramTreeMenuCallbackQuery;

export interface TelegramInboundRouteRuntimeDeps<
  TMessage extends TelegramRoutedMessage,
  TCallbackQuery extends TelegramRoutedCallbackQuery,
  TContext,
  TModel extends Model.MenuModel,
> {
  configStore: Pick<
    TelegramConfigStore,
    | "getAllowedUserId"
    | "setAllowedUserId"
    | "persist"
    | "getConcurrentWorkspacesConfig"
  >;
  bridgeRuntime: TelegramBridgeRuntime;
  activeTurnRuntime: Queue.TelegramActiveTurnStore;
  mediaGroupRuntime: Media.TelegramMediaGroupController<TMessage, TContext>;
  textGroupRuntime: TextGroups.TelegramTextGroupController<TMessage, TContext>;
  telegramQueueStore: Queue.TelegramQueueStateStore<TContext>;
  queueMutationRuntime: Queue.TelegramQueueMutationController<TContext>;
  modelMenuRuntime: Menu.TelegramModelMenuRuntime<TModel>;
  currentModelRuntime: Model.CurrentModelRuntime<TContext, TModel>;
  modelSwitchController: Model.TelegramModelSwitchController<
    TContext,
    Model.ScopedTelegramModel<TModel>
  >;
  menuActions: Menu.TelegramMenuActionRuntime<TContext, TModel>;
  updateSettingsMenuMessage?: (
    state: Menu.TelegramModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  openQueueMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  openSettingsMenu?: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  settingsMenuCallbackHandler?: (
    query: TCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
  queueMenuCallbackHandler: (
    query: TCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
  resumeMenuCallbackHandler?: (
    query: TCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
  sessionMenuCallbackHandler?: (
    query: TCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
  treeMenuCallbackHandler?: (
    query: TCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
  dumpMenuCallbackHandler?: (
    query: TCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
  treeMenuMessageHandler?: (
    message: TMessage,
    ctx: TContext,
  ) => Promise<boolean>;
  workspaceManager?: TelegramWorkspaceManager<TContext>;
  openResumeMenu?: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
    filters?: readonly string[],
  ) => Promise<void>;
  openSessionMenu?: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  openTreeMenu?: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  openDumpMenu?: MenuDump.TelegramDumpMenuRuntime<TContext>["openDumpMenu"];
  buttonActionStore?: OutboundHandlers.TelegramButtonActionStore;
  inboundHandlerRuntime: TelegramInboundHandlerRuntime<TContext>;
  updateStatus: (ctx: TContext, error?: string) => void;
  dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
  requestDeferredDispatchNextQueuedTelegramTurn?: (
    dispatch: (ctx: TContext) => void,
  ) => void;
  startTypingLoop?: (ctx: TContext, chatId?: number) => void;
  stopTypingLoop?: () => void;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  editInteractiveMessage?: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "html" | "plain",
    replyMarkup: Menu.TelegramReplyMarkup,
  ) => Promise<void>;
  sendInteractiveMessage?: (
    chatId: number,
    text: string,
    mode: "html" | "plain",
    replyMarkup: Menu.TelegramReplyMarkup,
  ) => Promise<number | undefined>;
  deleteMessage?: (chatId: number, messageId: number) => Promise<void>;
  answerGuestQuery: (guestQueryId: string, text?: string) => Promise<void>;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
  ) => Promise<number | undefined>;
  setMyCommands: Commands.TelegramBotCommandRegistrationDeps["setMyCommands"];
  getCommands: () => Parameters<
    typeof PromptTemplates.getTelegramPromptTemplateCommands
  >[0];
  downloadFile: Media.DownloadTelegramMessageFilesDeps["downloadFile"];
  getThinkingLevel: (ctx: TContext) => Model.ThinkingLevel | Promise<Model.ThinkingLevel>;
  setThinkingLevel: (level: Model.ThinkingLevel) => Model.ThinkingLevel | void;
  persistScopedModelPatterns?: (
    patterns: string[],
    ctx: TContext,
  ) => Promise<void>;
  setModel: (model: TModel) => Promise<boolean>;
  listAvailableModels: (
    ctx: TContext,
  ) => readonly Commands.TelegramAvailableLlmModel[];
  findActiveModelByIdentity: (
    identity: Commands.TelegramAvailableLlmModel,
    ctx: TContext,
  ) => TModel | undefined;
  sendUserMessage?: (
    message: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ) => void;
  isIdle: (ctx: TContext) => boolean;
  hasPendingMessages: (ctx: TContext) => boolean;
  compact: (
    ctx: TContext,
    callbacks: { onComplete: () => void; onError: (error: unknown) => void },
  ) => void;
  injectNewSession: (ctx: TContext) => Promise<boolean>;
  injectClone: () => Promise<void>;
  injectReloadRuntime?: () => Promise<void>;
  getSessionName: (ctx: TContext) => string | undefined;
  setSessionName: (name: string, ctx: TContext) => void | Promise<void>;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  debugLogger?: TelegramDebugLogger;
  sectionRegistry?: TelegramSectionRegistry;
}

const TELEGRAM_OWNED_CALLBACK_PREFIXES = [
  "menu:",
  "model:",
  "queue:",
  "resume:",
  "delete:",
  "dump:",
  "section:",
  "session:",
  "settings:",
  "status:",
  "workspace:",
  "tgbtn:",
  "thinking:",
  "tree:",
] as const;

function isTelegramOwnedCallbackData(data: string): boolean {
  return TELEGRAM_OWNED_CALLBACK_PREFIXES.some((prefix) =>
    data.startsWith(prefix),
  );
}

function getTelegramTurnId(chatId: unknown, messageId: unknown): string | undefined {
  return typeof chatId === "number" && typeof messageId === "number"
    ? `tg:${chatId}:${messageId}`
    : undefined;
}

function getTelegramTopicBindingTrustedChatIds(
  configStore: Pick<TelegramConfigStore, "getConcurrentWorkspacesConfig">,
): readonly number[] {
  return configStore.getConcurrentWorkspacesConfig().topicBinding?.trustedChatIds ?? [];
}

function isTelegramTrustedTopicBindingChat(
  configStore: Pick<TelegramConfigStore, "getConcurrentWorkspacesConfig">,
  chatId: unknown,
): boolean {
  return isTelegramTrustedChat(
    getTelegramTopicBindingTrustedChatIds(configStore),
    chatId,
  );
}

function shouldIgnoreTelegramUntrustedForumChat(
  configStore: Pick<TelegramConfigStore, "getConcurrentWorkspacesConfig">,
  message: Updates.TelegramUpdateMessage | undefined,
): boolean {
  const trustedChatIds = getTelegramTopicBindingTrustedChatIds(configStore);
  if (trustedChatIds.length === 0) return false;
  if (!message || message.chat?.type === "private") return false;
  return !isTelegramTrustedChat(trustedChatIds, message.chat?.id);
}

function isTelegramChatAllowedForTopicBinding(
  configStore: Pick<TelegramConfigStore, "getConcurrentWorkspacesConfig">,
  chat: Updates.TelegramChat | undefined,
): boolean {
  return !shouldIgnoreTelegramUntrustedForumChat(
    configStore,
    chat ? { chat } : undefined,
  );
}


export function createTelegramInboundRouteRuntime<
  TUpdate extends Updates.TelegramUpdateFlow & {
    message?: TMessage;
    edited_message?: TMessage;
    callback_query?: TCallbackQuery;
  },
  TMessage extends TelegramRoutedMessage,
  TCallbackQuery extends TelegramRoutedCallbackQuery,
  TContext,
  TModel extends Model.MenuModel,
>(
  deps: TelegramInboundRouteRuntimeDeps<
    TMessage,
    TCallbackQuery,
    TContext,
    TModel
  >,
): Updates.TelegramUpdateRuntimeController<TContext, TUpdate> {
  const getActiveMenuModel = async (
    ctx: TContext,
  ): Promise<TModel | undefined> => {
    if (!deps.workspaceManager?.isEnabled()) {
      return deps.currentModelRuntime.get(ctx);
    }
    const workspaceModel = await deps.workspaceManager.getActiveModel(ctx);
    if (!workspaceModel) return undefined;
    return (
      deps.findActiveModelByIdentity(workspaceModel, ctx) ?? (workspaceModel as TModel)
    );
  };
  const isMenuModelSwitchAllowed = (ctx: TContext): Promise<boolean> | boolean =>
    deps.workspaceManager?.isEnabled()
      ? deps.workspaceManager.canSwitchActiveModel(ctx)
      : deps.isIdle(ctx);
  const menuCallbackHandler = Menu.createTelegramMenuCallbackHandlerForContext<
    TCallbackQuery,
    TContext,
    TModel
  >({
    getStoredModelMenuState: deps.modelMenuRuntime.getState,
    getActiveModel: getActiveMenuModel,
    getThinkingLevel: deps.getThinkingLevel,
    setThinkingLevel: async (level, ctx) => {
      if (deps.workspaceManager?.isEnabled()) {
        const effectiveLevel = await deps.workspaceManager.setActiveThinkingLevel(
          level,
          ctx,
        );
        if (!effectiveLevel) {
          throw new Error("Thinking level is not available.");
        }
        return effectiveLevel;
      }
      return deps.setThinkingLevel(level) ?? deps.getThinkingLevel(ctx);
    },
    updateStatus: deps.updateStatus,
    updateModelMenuMessage: deps.menuActions.updateModelMenuMessage,
    updateThinkingMenuMessage: deps.menuActions.updateThinkingMenuMessage,
    updateStatusMessage: deps.menuActions.updateStatusMessage,
    updateSettingsMenuMessage: deps.updateSettingsMenuMessage,
    answerCallbackQuery: deps.answerCallbackQuery,
    isIdle: isMenuModelSwitchAllowed,
    hasActiveTelegramTurn: () =>
      !deps.workspaceManager?.isEnabled() && deps.activeTurnRuntime.has(),
    hasAbortHandler: () =>
      !deps.workspaceManager?.isEnabled() && deps.bridgeRuntime.abort.hasHandler(),
    getActiveToolExecutions: () =>
      deps.workspaceManager?.isEnabled()
        ? 0
        : deps.bridgeRuntime.lifecycle.getActiveToolExecutions(),
    persistScopedModelPatterns: deps.persistScopedModelPatterns,
    setModel: async (model, ctx) =>
      deps.workspaceManager?.isEnabled()
        ? deps.workspaceManager.selectActiveModel(model, ctx)
        : deps.setModel(model),
    setCurrentModel: (model, ctx) => {
      if (!deps.workspaceManager?.isEnabled()) {
        deps.currentModelRuntime.setCurrentModel(model, ctx);
      }
    },
    stagePendingModelSwitch: deps.modelSwitchController.stagePendingSwitch,
    restartInterruptedTelegramTurn:
      deps.modelSwitchController.restartInterruptedTurn,
    sectionRegistry: deps.sectionRegistry,
    editInteractiveMessage: deps.editInteractiveMessage,
    sendInteractiveMessage: deps.sendInteractiveMessage,
    deleteMessage: deps.deleteMessage,
    enqueueSectionPrompt: async (prompt: string, ctx: TContext) => {
      const chatId = deps.configStore.getAllowedUserId();
      if (typeof chatId !== "number") return;
      const order = deps.bridgeRuntime.queue.allocateItemOrder();
      const turn: Queue.PendingTelegramTurn = {
        kind: "prompt",
        chatId,
        replyToMessageId: 0,
        sourceMessageIds: [],
        queueOrder: order,
        queueLane: "default",
        laneOrder: order,
        queuedAttachments: [],
        content: [
          {
            type: "text",
            text: `[telegram] ${prompt}`,
          },
        ],
        historyText: Turns.truncateTelegramQueueSummary(prompt),
        statusSummary: Turns.truncateTelegramQueueSummary(prompt),
      };
      deps.queueMutationRuntime.append(turn, ctx);
      deps.updateStatus(ctx);
      deps.dispatchNextQueuedTelegramTurn(ctx);
    },
  });
  const callbackHandler = async (
    query: TCallbackQuery,
    ctx: TContext,
  ): Promise<void> => {
    const startedAt = Date.now();
    deps.debugLogger?.log(
      "telegram.route.callback.start",
      {
        callbackQueryId: query.id,
        turnId: getTelegramTurnId(query.message?.chat?.id, query.message?.message_id),
        fromUserId: query.from?.id,
        messageId: query.message?.message_id,
        chatId: query.message?.chat?.id,
      },
      query,
    );
    try {
    if (shouldIgnoreTelegramUntrustedForumChat(deps.configStore, query.message)) {
      deps.debugLogger?.log("telegram.route.callback.untrusted_chat", {
        callbackQueryId: query.id,
        chatId: query.message?.chat?.id,
        messageId: query.message?.message_id,
      });
      return;
    }
    if (deps.buttonActionStore) {
      const handled = await OutboundHandlers.handleTelegramButtonCallbackQuery(
        query,
        ctx,
        {
          resolveAction: deps.buttonActionStore.resolve,
          answerCallbackQuery: deps.answerCallbackQuery,
          enqueueButtonPrompt: (buttonQuery, action, context) => {
            const chatId = buttonQuery.message?.chat?.id;
            const messageId = buttonQuery.message?.message_id;
            if (typeof chatId !== "number" || typeof messageId !== "number")
              return;
            const queueOrder = deps.bridgeRuntime.queue.allocateItemOrder();
            deps.queueMutationRuntime.append(
              OutboundHandlers.createTelegramButtonPromptTurn({
                chatId,
                messageThreadId: getTelegramForumThreadMessageThreadId(
                  normalizeTelegramForumThread(buttonQuery.message),
                ),
                replyToMessageId: messageId,
                queueOrder,
                action,
              }),
              context,
            );
            deps.updateStatus(context);
            deps.dispatchNextQueuedTelegramTurn(context);
          },
        },
      );
      if (handled) return;
    }
    const handledByQueue = await deps.queueMenuCallbackHandler(query, ctx);
    if (handledByQueue) return;
    const handledBySettings = await deps.settingsMenuCallbackHandler?.(
      query,
      ctx,
    );
    if (handledBySettings) return;
    const handledByResume = await deps.resumeMenuCallbackHandler?.(query, ctx);
    if (handledByResume) return;
    const handledBySession = await deps.sessionMenuCallbackHandler?.(query, ctx);
    if (handledBySession) return;
    const handledByTree = await deps.treeMenuCallbackHandler?.(query, ctx);
    if (handledByTree) return;
    const handledByDump = await deps.dumpMenuCallbackHandler?.(query, ctx);
    if (handledByDump) return;
    const handledByWorkspace = await deps.workspaceManager?.handleCallbackQuery(query, ctx);
    if (handledByWorkspace) return;
    const callbackData = query.data;
    if (
      deps.sendUserMessage &&
      callbackData &&
      !isTelegramOwnedCallbackData(callbackData)
    ) {
      deps.sendUserMessage(`[callback] ${callbackData}`);
      await deps.answerCallbackQuery(query.id);
      return;
    }
    await menuCallbackHandler(query, ctx);
    } finally {
      deps.debugLogger?.log("telegram.route.callback.end", {
        callbackQueryId: query.id,
        turnId: getTelegramTurnId(query.message?.chat?.id, query.message?.message_id),
        elapsedMs: Date.now() - startedAt,
      });
    }
  };
  const promptTurnBuilder = Turns.createTelegramPromptTurnRuntimeBuilder<
    TMessage,
    TContext
  >({
    allocateQueueOrder: deps.bridgeRuntime.queue.allocateItemOrder,
    downloadFile: deps.downloadFile,
    processAttachments: deps.inboundHandlerRuntime.process,
  });
  const enqueueContinueTurn = async (
    message: TMessage,
    ctx: TContext,
  ): Promise<void> => {
    const enqueuePlan = Queue.planTelegramPromptEnqueue(
      deps.telegramQueueStore.getQueuedItems(),
      deps.bridgeRuntime.lifecycle.shouldPreserveQueuedTurnsAsHistory(),
    );
    deps.bridgeRuntime.lifecycle.setPreserveQueuedTurnsAsHistory(false);
    const continueMessage = {
      ...message,
      text: "continue",
      caption: undefined,
    } as TMessage;
    const turn = await promptTurnBuilder(
      [continueMessage],
      enqueuePlan.historyTurns,
      ctx,
    );
    const continueTurn = {
      ...turn,
      queueLane: "priority" as const,
      laneOrder: Number.MIN_SAFE_INTEGER + turn.queueOrder,
      statusSummary: "continue",
    };
    deps.telegramQueueStore.setQueuedItems(enqueuePlan.remainingItems);
    deps.queueMutationRuntime.append(continueTurn, ctx);
    deps.dispatchNextQueuedTelegramTurn(ctx);
  };
  const reservedCommandNames = new Set(
    Commands.TELEGRAM_RESERVED_COMMAND_NAMES,
  );
  const getPromptTemplateCommands = () =>
    PromptTemplates.getTelegramPromptTemplateCommands(
      deps.getCommands(),
      reservedCommandNames,
    );
  const commandHandler = Commands.createTelegramCommandHandlerTargetRuntime<
    TMessage,
    TContext
  >({
    hasAbortHandler: deps.bridgeRuntime.abort.hasHandler,
    clearPendingModelSwitch: deps.modelSwitchController.clearPendingSwitch,
    hasQueuedTelegramItems: deps.telegramQueueStore.hasQueuedItems,
    clearQueuedTelegramItems: deps.queueMutationRuntime.clear,
    setPreserveQueuedTurnsAsHistory:
      deps.bridgeRuntime.lifecycle.setPreserveQueuedTurnsAsHistory,
    abortCurrentTurn: deps.bridgeRuntime.abort.abortTurn,
    isIdle: deps.isIdle,
    hasPendingMessages: deps.hasPendingMessages,
    hasActiveTelegramTurn: deps.activeTurnRuntime.has,
    hasDispatchPending: deps.bridgeRuntime.lifecycle.hasDispatchPending,
    isCompactionInProgress: deps.bridgeRuntime.lifecycle.isCompactionInProgress,
    setCompactionInProgress:
      deps.bridgeRuntime.lifecycle.setCompactionInProgress,
    updateStatus: deps.updateStatus,
    dispatchNextQueuedTelegramTurn: deps.dispatchNextQueuedTelegramTurn,
    requestDeferredDispatchNextQueuedTelegramTurn:
      deps.requestDeferredDispatchNextQueuedTelegramTurn,
    startTypingLoop: deps.startTypingLoop,
    stopTypingLoop: deps.stopTypingLoop,
    enqueueContinueTurn,
    compact: deps.compact,
    compactActiveWorkspace: deps.workspaceManager
      ? (ctx, callbacks) => deps.workspaceManager?.compactActive(ctx, callbacks) ?? false
      : undefined,
    queueReloadRuntimeCommand: async () => {
      if (deps.injectReloadRuntime) {
        await deps.injectReloadRuntime();
        return;
      }
      if (!deps.sendUserMessage) {
        throw new Error("sendUserMessage is unavailable");
      }
      deps.sendUserMessage("/telegram-reload-runtime", {
        deliverAs: "followUp",
      });
    },
    injectNewSession: deps.injectNewSession,
    injectClone: deps.injectClone,
    abortActiveWorkspace: deps.workspaceManager
      ? async (ctx) => deps.workspaceManager?.abortActive(ctx)
      : undefined,
    getSessionName: deps.getSessionName,
    setSessionName: deps.setSessionName,
    allocateItemOrder: deps.bridgeRuntime.queue.allocateItemOrder,
    allocateControlOrder: deps.bridgeRuntime.queue.allocateControlOrder,
    appendControlItem: deps.queueMutationRuntime.append,
    showStatus: deps.menuActions.sendStatusMessage,
    openModelMenu: deps.menuActions.openModelMenu,
    listAvailableModels: deps.listAvailableModels,
    getActiveLlmModel: getActiveMenuModel,
    isModelSwitchAllowed: (ctx) =>
      deps.workspaceManager?.isEnabled()
        ? deps.workspaceManager.canSwitchActiveModel(ctx)
        : deps.isIdle(ctx) ||
          deps.modelSwitchController.canOfferInFlightSwitch(ctx),
    selectLlmModel: async (target, ctx) => {
      if (deps.workspaceManager?.isEnabled()) {
        return deps.workspaceManager.selectActiveModel(target, ctx);
      }
      const fullModel = deps.findActiveModelByIdentity(target, ctx);
      if (!fullModel) return false;
      const changed = await deps.setModel(fullModel);
      if (changed === false) return false;
      deps.currentModelRuntime.setCurrentModel(fullModel, ctx);
      return true;
    },
    openThinkingMenu: (message, ctx) => {
      const chatId = (message as { chat: { id: number } }).chat.id;
      return deps.menuActions.openThinkingMenu(chatId, message.message_id, ctx);
    },
    openQueueMenu: (message, ctx) => {
      const chatId = (message as { chat: { id: number } }).chat.id;
      return deps.openQueueMenu(chatId, message.message_id, ctx);
    },
    openSettingsMenu: deps.openSettingsMenu,
    openResumeMenu: deps.openResumeMenu,
    openSessionMenu: deps.openSessionMenu,
    openTreeMenu: deps.openTreeMenu,
    openDumpMenu: deps.openDumpMenu,
    handleWorkspaceCommand: deps.workspaceManager
      ? async (message, args, ctx) => {
          await deps.workspaceManager?.handleCommand(
            args,
            message.chat.id,
            message.message_id,
            ctx,
          );
        }
      : undefined,
    handleTopicCommand: deps.workspaceManager?.handleTopicCommand
      ? async (message, args, ctx) => {
          await deps.workspaceManager?.handleTopicCommand?.(
            args,
            message.chat.id,
            message.message_id,
            ctx,
          );
        }
      : undefined,
    getAllowedUserId: deps.configStore.getAllowedUserId,
    setAllowedUserId: deps.configStore.setAllowedUserId,
    setMyCommands: deps.setMyCommands,
    isForumNativeMode: () => isTelegramForumNativeModeEnabled(
      deps.configStore.getConcurrentWorkspacesConfig(),
    ),
    getPromptTemplateCommands,
    persistConfig: deps.configStore.persist,
    sendTextReply: deps.sendTextReply,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  const promptEnqueue = Queue.createTelegramPromptEnqueueController<
    TMessage,
    TContext
  >({
    ...deps.telegramQueueStore,
    getPreserveQueuedTurnsAsHistory:
      deps.bridgeRuntime.lifecycle.shouldPreserveQueuedTurnsAsHistory,
    setPreserveQueuedTurnsAsHistory:
      deps.bridgeRuntime.lifecycle.setPreserveQueuedTurnsAsHistory,
    createTurn: promptTurnBuilder,
    updateStatus: deps.updateStatus,
    dispatchNextQueuedTelegramTurn: deps.dispatchNextQueuedTelegramTurn,
  }).enqueue;
  const commandOrPrompt = Commands.createTelegramCommandOrPromptRuntime<
    TMessage,
    TContext
  >({
    extractRawText: Media.extractFirstTelegramMessageText,
    handleCommand: commandHandler,
    expandPromptTemplateCommand: (commandName, args) =>
      PromptTemplates.expandTelegramPromptTemplateCommand(
        commandName,
        args,
        getPromptTemplateCommands(),
      ),
    replaceMessageText: (message, text) =>
      ({ ...message, text, caption: undefined }) as TMessage,
    dispatchPrompt: deps.workspaceManager
      ? async (messages, ctx) => {
          if (!deps.workspaceManager?.isEnabled()) return false;
          const turn = await promptTurnBuilder(messages, [], ctx);
          return deps.workspaceManager.dispatchPrompt(turn, ctx);
        }
      : undefined,
    enqueueTurn: promptEnqueue,
  });
  const mediaDispatch = Media.createTelegramMediaGroupDispatchRuntime<
    TMessage,
    TContext
  >({
    mediaGroups: deps.mediaGroupRuntime,
    dispatchMessages: commandOrPrompt.dispatchMessages,
  });
  const textDispatch = TextGroups.createTelegramTextGroupDispatchRuntime<
    TMessage,
    TContext
  >({
    textGroups: deps.textGroupRuntime,
    dispatchMessages: commandOrPrompt.dispatchMessages,
    dispatchSingleMessage: mediaDispatch.handleMessage,
  });
  const editRuntime = Turns.createTelegramQueuedPromptEditRuntime<
    TMessage,
    TContext
  >({
    ...deps.telegramQueueStore,
    updateStatus: deps.updateStatus,
  });
  const handleAuthorizedTelegramGuestMessage = async (
    guestMessage: Updates.TelegramGuestMessage & { from: TelegramUser },
    ctx: TContext,
  ): Promise<void> => {
    const text = guestMessage.text ?? "";
    const gm = guestMessage as unknown as Record<string, unknown>;
    // Build telegram prefix with guest context
    const fromRaw = gm.from as Record<string, unknown> | undefined;
    const fromName =
      (fromRaw?.username as string) || (fromRaw?.first_name as string) || "";
    const chatRaw = gm.chat as Record<string, unknown>;
    const chatTitle = chatRaw?.title as string | undefined;
    const chatType = chatRaw?.type as string;
    const prefixParts = ["telegram"];
    if (fromName) prefixParts.push(`from:${fromName}`);
    if (chatType !== "private" && chatTitle) {
      prefixParts.push(`guest:${chatTitle}`);
    }
    const telegramPrefix = `[${prefixParts.join("|")}]`;
    // Extract reply context
    const replyMsg = gm.reply_to_message as Record<string, unknown> | undefined;
    const replyText = replyMsg
      ? ((replyMsg.text as string) || (replyMsg.caption as string) || "").trim()
      : "";
    const replyFrom = replyMsg
      ? ((replyMsg.from as Record<string, unknown> | undefined)?.username as
          | string
          | undefined)
      : undefined;
    // Download files, run inbound handlers
    const guestMsg = guestMessage as unknown as Media.TelegramMediaMessage;
    const files = await Media.downloadTelegramMessageFiles([guestMsg], {
      downloadFile: deps.downloadFile,
    });
    const processed = await deps.inboundHandlerRuntime.process(
      files,
      text,
      ctx,
    );
    let rawText = processed.rawText || text;
    // Append reply context after handler processing
    if (replyText) {
      const replyBlock = replyFrom
        ? `[reply|from:${replyFrom}] ${replyText}`
        : `[reply] ${replyText}`;
      rawText = `${rawText}\n\n${replyBlock}`;
    }
    const promptText = Turns.buildTelegramTurnPrompt({
      telegramPrefix,
      rawText,
      files,
      promptFiles: processed.promptFiles,
      handlerOutputs: processed.handlerOutputs,
    });
    const order = deps.bridgeRuntime.queue.allocateItemOrder();
    const content: Queue.TelegramPromptContent[] = [
      { type: "text", text: promptText },
    ];
    for (const file of processed.promptFiles) {
      if (file.isImage && file.mimeType) {
        try {
          const buffer = await readFile(file.path);
          content.push({
            type: "image",
            data: Buffer.from(buffer).toString("base64"),
            mimeType: file.mimeType,
          });
        } catch {
          // skip unreadable files
        }
      }
    }
    const guestTurn: Queue.PendingTelegramTurn = {
      kind: "prompt",
      chatId: 0,
      replyToMessageId: 0,
      guestQueryId: guestMessage.guest_query_id,
      sourceMessageIds: [],
      queueOrder: order,
      queueLane: "default",
      laneOrder: order,
      queuedAttachments: [],
      content,
      historyText: Turns.formatTelegramTurnStatusSummary(
        processed.rawText || text,
        processed.promptFiles,
        processed.handlerOutputs,
      ),
      statusSummary: Turns.truncateTelegramQueueSummary(
        processed.rawText || text,
      ),
    };
    const items = deps.telegramQueueStore.getQueuedItems();
    deps.telegramQueueStore.setQueuedItems(
      Queue.appendTelegramQueueItem(items, guestTurn),
    );
    deps.updateStatus(ctx);
    deps.dispatchNextQueuedTelegramTurn(ctx);
  };
  return Updates.createTelegramPairedUpdateRuntime<TContext, TUpdate>({
    getAllowedUserId: deps.configStore.getAllowedUserId,
    setAllowedUserId: deps.configStore.setAllowedUserId,
    persistConfig: deps.configStore.persist,
    updateStatus: deps.updateStatus,
    removePendingMediaGroupMessages: deps.mediaGroupRuntime.removeMessages,
    removeQueuedTelegramTurnsByMessageIds:
      deps.queueMutationRuntime.removeByMessageIds,
    clearQueuedTelegramTurnPriorityByMessageId:
      deps.queueMutationRuntime.clearPriorityByMessageId,
    prioritizeQueuedTelegramTurnByMessageId:
      deps.queueMutationRuntime.prioritizeByMessageId,
    answerCallbackQuery: deps.answerCallbackQuery,
    answerGuestQuery: deps.answerGuestQuery,
    handleAuthorizedTelegramCallbackQuery: callbackHandler,
    sendTextReply: deps.sendTextReply,
    handleAuthorizedTelegramMessage: async (message, ctx) => {
      const startedAt = Date.now();
      deps.debugLogger?.log(
        "telegram.route.message.start",
        {
          turnId: getTelegramTurnId(message.chat?.id, message.message_id),
          chatId: message.chat?.id,
          messageId: message.message_id,
          fromUserId: message.from?.id,
        },
        message,
      );
      try {
        if (shouldIgnoreTelegramUntrustedForumChat(deps.configStore, message)) {
          deps.debugLogger?.log("telegram.route.message.untrusted_chat", {
            turnId: getTelegramTurnId(message.chat?.id, message.message_id),
            chatId: message.chat?.id,
            messageId: message.message_id,
            messageThreadId: getTelegramForumThreadMessageThreadId(
              normalizeTelegramForumThread(message),
            ),
            fromUserId: message.from?.id,
          });
          return;
        }
        if (Updates.isTelegramForumTopicServiceMessage(message)) {
          if (!isTelegramTrustedTopicBindingChat(deps.configStore, message.chat?.id)) {
            deps.debugLogger?.log("telegram.route.topic_service.untrusted_chat", {
              chatId: message.chat?.id,
              messageId: message.message_id,
              messageThreadId: getTelegramForumThreadMessageThreadId(
                normalizeTelegramForumThread(message),
              ),
              hasFrom: !!message.from,
            });
            return;
          }
          const handledByTopic =
            await deps.workspaceManager?.handleTopicServiceMessage(message, ctx);
          if (handledByTopic !== false) return;
        }
        const handledByTree = await deps.treeMenuMessageHandler?.(message, ctx);
        if (handledByTree) return;
        await textDispatch.handleMessage(message, ctx);
      } finally {
        deps.debugLogger?.log("telegram.route.message.end", {
          turnId: getTelegramTurnId(message.chat?.id, message.message_id),
          chatId: message.chat?.id,
          messageId: message.message_id,
          elapsedMs: Date.now() - startedAt,
        });
      }
    },
    handleAuthorizedTelegramEditedMessage: (message, ctx) => {
      if (shouldIgnoreTelegramUntrustedForumChat(deps.configStore, message)) {
        deps.debugLogger?.log("telegram.route.edited_message.untrusted_chat", {
          turnId: getTelegramTurnId(message.chat?.id, message.message_id),
          chatId: message.chat?.id,
          messageId: message.message_id,
          messageThreadId: getTelegramForumThreadMessageThreadId(
            normalizeTelegramForumThread(message),
          ),
          fromUserId: message.from?.id,
        });
        return;
      }
      deps.debugLogger?.log(
        "telegram.route.edited_message",
        {
          turnId: getTelegramTurnId(message.chat?.id, message.message_id),
          chatId: message.chat?.id,
          messageId: message.message_id,
          fromUserId: message.from?.id,
        },
        message,
      );
      return editRuntime.updateFromEditedMessage(message, ctx);
    },
    isTelegramChatAllowed: (chat) =>
      isTelegramChatAllowedForTopicBinding(deps.configStore, chat),
    handleAuthorizedTelegramGuestMessage: async (message, ctx) => {
      const startedAt = Date.now();
      deps.debugLogger?.log(
        "telegram.route.guest.start",
        {
          guestQueryId: message.guest_query_id,
          turnId: getTelegramTurnId(message.chat?.id, message.message_id),
          chatId: message.chat?.id,
          messageId: message.message_id,
          fromUserId: message.from?.id,
        },
        message,
      );
      try {
        await handleAuthorizedTelegramGuestMessage(message, ctx);
      } finally {
        deps.debugLogger?.log("telegram.route.guest.end", {
          guestQueryId: message.guest_query_id,
          turnId: getTelegramTurnId(message.chat?.id, message.message_id),
          elapsedMs: Date.now() - startedAt,
        });
      }
    },
  });
}
