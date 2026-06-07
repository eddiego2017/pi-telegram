/**
 * Telegram topic workspace records, session-conflict checks, scoped runtime resolution
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import {
  getAmbientTelegramThreadContext,
} from "./thread-context.ts";
import {
  createWorkspaceRuntime,
} from "./workspace-manager-events.ts";
import {
  formatTelegramWorkspaceSessionOwner,
  getTelegramWorkspaceSessionIdentity,
  isSameTelegramWorkspaceSessionIdentity,
  normalizeTelegramWorkspaceSessionName,
} from "./workspace-manager-state.ts";
import type {
  TelegramWorkspaceForumTopicServiceMessage,
  TelegramWorkspaceManagerDeps,
  TelegramWorkspacePromptTurn,
  TelegramWorkspaceSessionIdentity,
  WorkspaceRuntime,
} from "./workspace-manager-types.ts";
import {
  TELEGRAM_DEFAULT_WORKSPACE_NAME,
  findTelegramWorkspaceByTopic,
  normalizeTelegramTopicWorkspaceName,
} from "./workspaces.ts";
import type {
  TelegramWorkspaceRecord,
  TelegramWorkspaceSourceTelegramTopic,
  TelegramWorkspacesState,
} from "./workspaces.ts";

export function installTopic<TContext>(
  self: WsRuntimeContext<TContext>,
  deps: TelegramWorkspaceManagerDeps<TContext>,
): void {
  self.getOpenSessionConflict = async (
    workspaceState: TelegramWorkspacesState,
    targetWorkspaceRuntime: WorkspaceRuntime,
    target: Pick<TelegramWorkspaceSessionIdentity, "sessionFile" | "sessionId">,
  ): Promise<TelegramWorkspaceRecord | undefined> => {
    const targetIdentity = getTelegramWorkspaceSessionIdentity(target);
    if (!targetIdentity.canonicalSessionFile && !targetIdentity.sessionId) {
      return undefined;
    }
    await Promise.all(
      Object.values(workspaceState.workspaces).map(async (record) => {
        if (record.name === targetWorkspaceRuntime.record.name) return;
        const runtime = self.getWorkspaceRuntime(workspaceState, record.name);
        if (runtime?.backend) await self.refreshRuntimeState(runtime);
      }),
    );
    return Object.values(workspaceState.workspaces).find((record) => {
      if (record.name === targetWorkspaceRuntime.record.name) return false;
      return isSameTelegramWorkspaceSessionIdentity(
        getTelegramWorkspaceSessionIdentity(record),
        targetIdentity,
      );
    });
  };
  self.assertNoOpenSessionConflict = async (
    workspaceState: TelegramWorkspacesState,
    targetWorkspaceRuntime: WorkspaceRuntime,
    target: Pick<TelegramWorkspaceSessionIdentity, "sessionFile" | "sessionId">,
  ): Promise<void> => {
    const conflict = await self.getOpenSessionConflict(workspaceState, targetWorkspaceRuntime, target);
    if (!conflict) return;
    throw new Error(
      `Session is already open in workspace ${formatTelegramWorkspaceSessionOwner(conflict)}. Close that workspace first or branch/clone the session.`,
    );
  };
  self.getTelegramTopicServiceKind = (
    message: TelegramWorkspaceForumTopicServiceMessage,
  ):
    | "created"
    | "edited"
    | "closed"
    | "reopened"
    | "general-hidden"
    | "general-unhidden"
    | undefined => {
    if (message.forum_topic_created) return "created";
    if (message.forum_topic_edited) return "edited";
    if (message.forum_topic_closed) return "closed";
    if (message.forum_topic_reopened) return "reopened";
    if (message.general_forum_topic_hidden) return "general-hidden";
    if (message.general_forum_topic_unhidden) return "general-unhidden";
    return undefined;
  };
  self.updateTelegramTopicRecordTitle = (
    record: TelegramWorkspaceRecord,
    topicTitle: string | undefined,
  ): boolean => {
    const sessionName = normalizeTelegramWorkspaceSessionName(topicTitle ?? "");
    if (!sessionName || record.source?.kind !== "telegram-topic") return false;
    let changed = false;
    if (record.source.topicTitle !== sessionName) {
      record.source = { ...record.source, topicTitle: sessionName };
      changed = true;
    }
    if (record.sessionName !== sessionName) {
      record.sessionName = sessionName;
      changed = true;
    }
    return changed;
  };
  self.createTelegramTopicWorkspaceRecord = (
    workspaceState: TelegramWorkspacesState,
    scope: { chatId: number; messageThreadId: number; topicTitle?: string },
    ctx: TContext,
  ): TelegramWorkspaceRecord => {
    const createdAt = self.now();
    let name = normalizeTelegramTopicWorkspaceName(scope.chatId, scope.messageThreadId);
    if (workspaceState.workspaces[name]) {
      let suffix = 2;
      const base = name.slice(0, Math.max(1, 29));
      while (workspaceState.workspaces[name]) {
        name = `${base}-${suffix}`.slice(0, 32);
        suffix += 1;
      }
    }
    const topicSessionName = normalizeTelegramWorkspaceSessionName(
      scope.topicTitle ?? "",
    );
    const source: TelegramWorkspaceSourceTelegramTopic = {
      kind: "telegram-topic",
      chatId: scope.chatId,
      messageThreadId: scope.messageThreadId,
      ...(topicSessionName ? { topicTitle: topicSessionName } : {}),
    };
    return {
      name,
      cwd: deps.getCwd(ctx),
      ...(topicSessionName ? { sessionName: topicSessionName } : {}),
      createdAt,
      lastUsedAt: createdAt,
      status: "idle",
      source,
    };
  };
  self.getOrCreateTopicRuntimeForTurn = async (
    workspaceState: TelegramWorkspacesState,
    turn: TelegramWorkspacePromptTurn,
    ctx: TContext,
  ): Promise<WorkspaceRuntime | undefined> => {
    const topicBinding = self.getTopicBindingConfig();
    if (!topicBinding?.enabled) return undefined;
    if (!self.isTrustedTopicBindingChat(turn.chatId)) {
      await self.sendTurnTextReply(
        turn,
        "This Telegram forum is not authorized for topic workspaces.",
      );
      return undefined;
    }
    if (turn.messageThreadId === undefined && topicBinding.generalIsDefault) {
      return self.getWorkspaceRuntime(workspaceState, TELEGRAM_DEFAULT_WORKSPACE_NAME);
    }
    if (turn.messageThreadId === undefined) return undefined;
    const existing = findTelegramWorkspaceByTopic(
      workspaceState.workspaces,
      turn.chatId,
      turn.messageThreadId,
    );
    if (existing) return self.getWorkspaceRuntime(workspaceState, existing.name);
    if (!topicBinding.autoCreate) return undefined;
    if (Object.keys(workspaceState.workspaces).length >= deps.getConfig().maxWorkspaces) {
      await self.sendTurnTextReply(
        turn,
        "Maximum workspace count reached. Close another topic/workspace first.",
      );
      return undefined;
    }
    const record = self.createTelegramTopicWorkspaceRecord(
      workspaceState,
      { chatId: turn.chatId, messageThreadId: turn.messageThreadId },
      ctx,
    );
    workspaceState.workspaces[record.name] = record;
    const runtime = createWorkspaceRuntime(record);
    self.workspaceRuntimes.set(record.name, runtime);
    await self.persist();
    return runtime;
  };
  self.getWorkspaceRuntimeForPromptTurn = async (
    workspaceState: TelegramWorkspacesState,
    turn: TelegramWorkspacePromptTurn,
    ctx: TContext,
  ): Promise<WorkspaceRuntime | undefined> => {
    if (!self.isTopicBindingEnabled()) return self.getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
    if (turn.messageThreadId !== undefined && !self.isTrustedTopicBindingChat(turn.chatId)) {
      await self.sendTurnTextReply(
        turn,
        "This Telegram forum is not authorized for topic workspaces.",
      );
      return undefined;
    }
    if (turn.messageThreadId === undefined) {
      return self.getTopicBindingConfig()?.generalIsDefault
        ? self.getWorkspaceRuntime(workspaceState, TELEGRAM_DEFAULT_WORKSPACE_NAME)
        : self.getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
    }
    const runtime = await self.getOrCreateTopicRuntimeForTurn(workspaceState, turn, ctx);
    if (runtime) return runtime;
    if (!self.getTopicBindingConfig()?.autoCreate) {
      await self.sendTurnTextReply(
        turn,
        self.isForumNativeMode()
          ? "No workspace is bound to this Telegram topic."
          : "No workspace is bound to this Telegram topic.",
      );
    }
    return undefined;
  };
  self.upsertTelegramTopicWorkspaceRecord = async (
    workspaceState: TelegramWorkspacesState,
    scope: { chatId: number; messageThreadId: number; topicTitle?: string },
    ctx: TContext,
    options: { enforceCapacity: boolean },
  ): Promise<TelegramWorkspaceRecord | undefined> => {
    const existing = findTelegramWorkspaceByTopic(
      workspaceState.workspaces,
      scope.chatId,
      scope.messageThreadId,
    );
    if (existing) {
      if (self.updateTelegramTopicRecordTitle(existing, scope.topicTitle)) {
        await self.persist();
      }
      return existing;
    }
    if (
      options.enforceCapacity &&
      Object.keys(workspaceState.workspaces).length >= deps.getConfig().maxWorkspaces
    ) {
      return undefined;
    }
    const record = self.createTelegramTopicWorkspaceRecord(workspaceState, scope, ctx);
    workspaceState.workspaces[record.name] = record;
    self.workspaceRuntimes.set(record.name, createWorkspaceRuntime(record));
    await self.persist();
    return record;
  };
  self.resolveScopedTopicRuntime = async (
    workspaceState: TelegramWorkspacesState,
    ctx: TContext,
  ): Promise<{ scoped: boolean; runtime?: WorkspaceRuntime }> => {
    if (!self.isTopicBindingEnabled()) return { scoped: false };
    const scope = getAmbientTelegramThreadContext();
    if (!scope) return { scoped: false };
    if (!self.isTrustedTopicBindingChat(scope.chatId)) {
      return scope.messageThreadId === undefined ? { scoped: false } : { scoped: true };
    }
    const topicBinding = self.getTopicBindingConfig();
    if (scope.messageThreadId === undefined) {
      return {
        scoped: true,
        runtime: topicBinding?.generalIsDefault
          ? self.getWorkspaceRuntime(workspaceState, TELEGRAM_DEFAULT_WORKSPACE_NAME)
          : undefined,
      };
    }
    const existing = findTelegramWorkspaceByTopic(
      workspaceState.workspaces,
      scope.chatId,
      scope.messageThreadId,
    );
    if (existing) return { scoped: true, runtime: self.getWorkspaceRuntime(workspaceState, existing.name) };
    if (!topicBinding?.autoCreate) return { scoped: true };
    const record = await self.upsertTelegramTopicWorkspaceRecord(
      workspaceState,
      { chatId: scope.chatId, messageThreadId: scope.messageThreadId },
      ctx,
      { enforceCapacity: true },
    );
    return {
      scoped: true,
      runtime: record ? self.getWorkspaceRuntime(workspaceState, record.name) : undefined,
    };
  };
  self.resolveScopedTopicRuntimeSync = (
    workspaceState: TelegramWorkspacesState,
    ctx: TContext,
  ): { scoped: boolean; runtime?: WorkspaceRuntime } => {
    if (!self.isTopicBindingEnabled()) return { scoped: false };
    const scope = getAmbientTelegramThreadContext();
    if (!scope) return { scoped: false };
    if (!self.isTrustedTopicBindingChat(scope.chatId)) {
      return scope.messageThreadId === undefined ? { scoped: false } : { scoped: true };
    }
    const topicBinding = self.getTopicBindingConfig();
    if (scope.messageThreadId === undefined) {
      return {
        scoped: true,
        runtime: topicBinding?.generalIsDefault
          ? self.getWorkspaceRuntime(workspaceState, TELEGRAM_DEFAULT_WORKSPACE_NAME)
          : undefined,
      };
    }
    const existing = findTelegramWorkspaceByTopic(
      workspaceState.workspaces,
      scope.chatId,
      scope.messageThreadId,
    );
    if (existing) return { scoped: true, runtime: self.getWorkspaceRuntime(workspaceState, existing.name) };
    if (!topicBinding?.autoCreate) return { scoped: true };
    if (Object.keys(workspaceState.workspaces).length >= deps.getConfig().maxWorkspaces) {
      return { scoped: true };
    }
    const record = self.createTelegramTopicWorkspaceRecord(
      workspaceState,
      { chatId: scope.chatId, messageThreadId: scope.messageThreadId },
      ctx,
    );
    workspaceState.workspaces[record.name] = record;
    const runtime = createWorkspaceRuntime(record);
    self.workspaceRuntimes.set(record.name, runtime);
    void self.persist();
    return { scoped: true, runtime };
  };
  self.getActiveRuntime = async (ctx: TContext): Promise<WorkspaceRuntime | undefined> => {
    const workspaceState = await self.ensureState(deps.getCwd(ctx));
    const scoped = await self.resolveScopedTopicRuntime(workspaceState, ctx);
    return scoped.scoped ? scoped.runtime : self.getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
  };
  self.getActiveRuntimeSync = (ctx: TContext): WorkspaceRuntime | undefined => {
    const workspaceState = self.ensureStateSync(deps.getCwd(ctx));
    const scoped = self.resolveScopedTopicRuntimeSync(workspaceState, ctx);
    return scoped.scoped ? scoped.runtime : self.getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
  };
}
