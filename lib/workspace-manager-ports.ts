/**
 * Telegram workspace-aware menu/session port factories
 * Zones: telegram ui, workspace controls, menu composition
 */

import type { ThinkingLevel } from "./model.ts";
import type {
  TelegramWorkspaceManager,
  TelegramWorkspaceMarkdownMessageEditorDeps,
  TelegramWorkspaceModelSelection,
  TelegramWorkspaceResumeSessionScope,
  TelegramWorkspaceSessionReference,
  TelegramWorkspaceTreeBranchResult,
} from "./workspace-manager-types.ts";

export function createTelegramWorkspaceMarkdownMessageEditor(
  deps: TelegramWorkspaceMarkdownMessageEditorDeps,
): (chatId: number, messageId: number, markdown: string) => Promise<number | undefined> {
  return (chatId, messageId, markdown) =>
    deps.editRenderedMessage(
      chatId,
      messageId,
      deps.renderTelegramMessage(markdown, { mode: "markdown" }),
      { disableLinkPreview: true },
    );
}

export interface TelegramWorkspaceAwareModelMenuPorts<
  TContext,
  TModel extends TelegramWorkspaceModelSelection,
> {
  getActiveModel: (ctx: TContext) => Promise<TModel | undefined>;
  canSwitchModel: (ctx: TContext) => Promise<boolean> | boolean;
  canOfferInFlightModelSwitch: (ctx: TContext) => boolean;
}

export interface TelegramWorkspaceAwareModelMenuPortDeps<
  TContext,
  TModel extends TelegramWorkspaceModelSelection,
> {
  workspaceManager: TelegramWorkspaceManager<TContext>;
  getParentModel: (ctx: TContext) => TModel | undefined;
  findModel: (
    identity: TelegramWorkspaceModelSelection,
    ctx: TContext,
  ) => TModel | undefined;
  isParentIdle: (ctx: TContext) => boolean;
  canOfferParentInFlightModelSwitch: (ctx: TContext) => boolean;
}

export interface TelegramWorkspaceAwareSessionSnapshotPorts<TContext, TSnapshot> {
  getSnapshot: (ctx: TContext) => TSnapshot;
  canDeleteCurrent: (snapshot: unknown, ctx: TContext) => boolean;
  isReadOnly: (snapshot: unknown, ctx: TContext) => boolean;
}

export interface TelegramWorkspaceAwareSessionSnapshotPortDeps<TContext, TSnapshot> {
  workspaceManager: TelegramWorkspaceManager<TContext>;
  getParentSnapshot: (ctx: TContext) => TSnapshot;
  getWorkspaceSnapshot: (
    reference: TelegramWorkspaceSessionReference,
    ctx: TContext,
  ) => TSnapshot;
}

export function createTelegramWorkspaceAwareSessionSnapshotPorts<TContext, TSnapshot>(
  deps: TelegramWorkspaceAwareSessionSnapshotPortDeps<TContext, TSnapshot>,
): TelegramWorkspaceAwareSessionSnapshotPorts<TContext, TSnapshot> {
  const isActiveWorkspaceSession = (ctx: TContext): boolean =>
    deps.workspaceManager.getActiveSessionReference(ctx) !== undefined;
  const hasSessionFile = (snapshot: unknown): boolean =>
    typeof (snapshot as { sessionFile?: unknown }).sessionFile === "string" &&
    ((snapshot as { sessionFile?: string }).sessionFile?.length ?? 0) > 0;
  return {
    getSnapshot: (ctx) => {
      const reference = deps.workspaceManager.getActiveSessionReference(ctx);
      return reference
        ? deps.getWorkspaceSnapshot(reference, ctx)
        : deps.getParentSnapshot(ctx);
    },
    canDeleteCurrent: (snapshot, _ctx) => hasSessionFile(snapshot),
    isReadOnly: (_snapshot, ctx) => isActiveWorkspaceSession(ctx),
  };
}

export interface TelegramWorkspaceAwareSessionNamePorts<TContext> {
  getSessionName: (ctx: TContext) => string | undefined;
  setSessionName: (name: string, ctx: TContext) => void | Promise<void>;
}

export interface TelegramWorkspaceAwareSessionNamePortDeps<TContext> {
  workspaceManager: TelegramWorkspaceManager<TContext>;
  getParentSessionName: (ctx: TContext) => string | undefined;
  setParentSessionName: (
    name: string,
    ctx: TContext,
  ) => void | Promise<void>;
}

export function createTelegramWorkspaceAwareSessionNamePorts<TContext>(
  deps: TelegramWorkspaceAwareSessionNamePortDeps<TContext>,
): TelegramWorkspaceAwareSessionNamePorts<TContext> {
  return {
    getSessionName: (ctx) => {
      const reference = deps.workspaceManager.getActiveSessionReference(ctx);
      return reference
        ? reference.sessionName
        : deps.getParentSessionName(ctx);
    },
    setSessionName: async (name, ctx) => {
      const reference = deps.workspaceManager.getActiveSessionReference(ctx);
      if (reference) {
        const handled = await deps.workspaceManager.setActiveSessionName(name, ctx);
        if (handled) return;
      }
      await deps.setParentSessionName(name, ctx);
    },
  };
}

export interface TelegramWorkspaceAwareCompactPorts<TContext> {
  compact: (
    ctx: TContext,
    callbacks: { onComplete: () => void; onError: (error: unknown) => void },
  ) => void;
}

export interface TelegramWorkspaceAwareCompactPortDeps<TContext> {
  workspaceManager: TelegramWorkspaceManager<TContext>;
  compactParent: (
    ctx: TContext,
    callbacks: { onComplete: () => void; onError: (error: unknown) => void },
  ) => void;
}

export function createTelegramWorkspaceAwareCompactPorts<TContext>(
  deps: TelegramWorkspaceAwareCompactPortDeps<TContext>,
): TelegramWorkspaceAwareCompactPorts<TContext> {
  return {
    compact: (ctx, callbacks) => {
      const handled = deps.workspaceManager.compactActive(ctx, callbacks);
      if (!handled) deps.compactParent(ctx, callbacks);
    },
  };
}

export interface TelegramWorkspaceAwareNewSessionPorts<TContext> {
  injectNewSession: (ctx: TContext) => Promise<boolean>;
}

export interface TelegramWorkspaceAwareNewSessionPortDeps<TContext> {
  workspaceManager: TelegramWorkspaceManager<TContext>;
  injectParentNewSession: () => Promise<void>;
}

export function createTelegramWorkspaceAwareNewSessionPorts<TContext>(
  deps: TelegramWorkspaceAwareNewSessionPortDeps<TContext>,
): TelegramWorkspaceAwareNewSessionPorts<TContext> {
  return {
    injectNewSession: async (ctx) => {
      const result = await deps.workspaceManager.newActiveSession(ctx);
      if (result !== undefined) return !result.cancelled;
      await deps.injectParentNewSession();
      return true;
    },
  };
}

export interface TelegramWorkspaceAwareSessionDeletePorts<TContext> {
  injectDeleteCurrentSession: (
    expectedSessionPath: string,
    ctx: TContext,
  ) => Promise<void>;
}

export interface TelegramWorkspaceAwareSessionDeletePortDeps<TContext> {
  workspaceManager: TelegramWorkspaceManager<TContext>;
  injectParentDeleteCurrentSession: (expectedSessionPath: string) => Promise<void>;
}

export function createTelegramWorkspaceAwareSessionDeletePorts<TContext>(
  deps: TelegramWorkspaceAwareSessionDeletePortDeps<TContext>,
): TelegramWorkspaceAwareSessionDeletePorts<TContext> {
  return {
    injectDeleteCurrentSession: async (expectedSessionPath, ctx) => {
      const handled = await deps.workspaceManager.deleteActiveSession(
        expectedSessionPath,
        ctx,
      );
      if (handled) return;
      await deps.injectParentDeleteCurrentSession(expectedSessionPath);
    },
  };
}

export interface TelegramWorkspaceAwareResumeMenuPorts<TContext> {
  getSessionScope: (
    ctx: TContext,
  ) => TelegramWorkspaceResumeSessionScope | undefined;
  injectResumeExec: (
    sessionPath: string,
    ctx: TContext,
    sessionScope?: { kind?: string; workspaceName?: string },
  ) => Promise<void>;
}

export interface TelegramWorkspaceAwareResumeMenuPortDeps<TContext> {
  workspaceManager: TelegramWorkspaceManager<TContext>;
  injectParentResumeExec: (sessionPath: string) => Promise<void>;
}

export function createTelegramWorkspaceAwareResumeMenuPorts<TContext>(
  deps: TelegramWorkspaceAwareResumeMenuPortDeps<TContext>,
): TelegramWorkspaceAwareResumeMenuPorts<TContext> {
  return {
    getSessionScope: (ctx) =>
      deps.workspaceManager.isEnabled()
        ? deps.workspaceManager.getActiveResumeSessionScope(ctx)
        : undefined,
    injectResumeExec: async (sessionPath, ctx, sessionScope) => {
      if (!deps.workspaceManager.isEnabled()) {
        await deps.injectParentResumeExec(sessionPath);
        return;
      }
      const activeScope =
        sessionScope?.kind === "workspace" && sessionScope.workspaceName
          ? sessionScope
          : deps.workspaceManager.getActiveResumeSessionScope(ctx);
      if (!activeScope) {
        throw new Error("No active workspace session scope for /resume.");
      }
      const handled = await deps.workspaceManager.switchSession(
        sessionPath,
        ctx,
        activeScope,
      );
      if (!handled) {
        throw new Error("Active workspace did not handle /resume.");
      }
    },
  };
}

export interface TelegramWorkspaceAwareTreeMenuPorts<TContext> {
  isReadOnly: (snapshot: unknown, ctx: TContext) => boolean;
  canForkTree: (snapshot: unknown, ctx: TContext) => boolean;
  injectTreeExec: (
    entryId: string,
    summarize: boolean,
    ctx: TContext,
  ) => Promise<void>;
  forkTreeEntry: (
    entryId: string,
    ctx: TContext,
  ) => Promise<TelegramWorkspaceTreeBranchResult>;
}

export interface TelegramWorkspaceAwareTreeMenuPortDeps<TContext> {
  workspaceManager: TelegramWorkspaceManager<TContext>;
  injectParentTreeExec: (entryId: string, summarize: boolean) => Promise<void>;
}

export function createTelegramWorkspaceAwareTreeMenuPorts<TContext>(
  deps: TelegramWorkspaceAwareTreeMenuPortDeps<TContext>,
): TelegramWorkspaceAwareTreeMenuPorts<TContext> {
  const isActiveWorkspaceSession = (ctx: TContext): boolean =>
    deps.workspaceManager.getActiveSessionReference(ctx) !== undefined;
  return {
    isReadOnly: (_snapshot, ctx) => isActiveWorkspaceSession(ctx),
    canForkTree: (_snapshot, ctx) => isActiveWorkspaceSession(ctx),
    injectTreeExec: async (entryId, summarize, ctx) => {
      if (isActiveWorkspaceSession(ctx)) {
        throw new Error("Active workspace tree navigation uses Create branch.");
      }
      await deps.injectParentTreeExec(entryId, summarize);
    },
    forkTreeEntry: async (entryId, ctx) => {
      const result = await deps.workspaceManager.createActiveTreeBranch(entryId, ctx);
      if (!result) throw new Error("No active workspace session for tree branch.");
      return result;
    },
  };
}

export interface TelegramWorkspaceAwareTreeBranchMutators<TContext> {
  setBranchName: (
    entryId: string,
    name: string | undefined,
    ctx: TContext,
  ) => Promise<void> | void;
  deleteBranch: (entryId: string, ctx: TContext) => Promise<void> | void;
}

export interface TelegramWorkspaceAwareTreeBranchMutatorDeps<TContext> {
  workspaceManager: Pick<TelegramWorkspaceManager<TContext>, "getActiveSessionReference">;
  setParentBranchName: (
    entryId: string,
    name: string | undefined,
    ctx: TContext,
  ) => Promise<void> | void;
  deleteParentBranch: (entryId: string, ctx: TContext) => Promise<void> | void;
  setWorkspaceBranchName: (
    reference: TelegramWorkspaceSessionReference,
    entryId: string,
    name: string | undefined,
  ) => Promise<void> | void;
  deleteWorkspaceBranch: (
    reference: TelegramWorkspaceSessionReference,
    entryId: string,
    customType: string,
  ) => Promise<void> | void;
  branchMetadataCustomType: string;
}

export function createTelegramWorkspaceAwareTreeBranchMutators<TContext>(
  deps: TelegramWorkspaceAwareTreeBranchMutatorDeps<TContext>,
): TelegramWorkspaceAwareTreeBranchMutators<TContext> {
  return {
    setBranchName: function setBranchName(entryId, name, ctx) {
      const reference = deps.workspaceManager.getActiveSessionReference(ctx);
      if (reference) {
        return deps.setWorkspaceBranchName(reference, entryId, name);
      }
      return deps.setParentBranchName(entryId, name, ctx);
    },
    deleteBranch: function deleteBranch(entryId, ctx) {
      const reference = deps.workspaceManager.getActiveSessionReference(ctx);
      if (reference) {
        return deps.deleteWorkspaceBranch(
          reference,
          entryId,
          deps.branchMetadataCustomType,
        );
      }
      return deps.deleteParentBranch(entryId, ctx);
    },
  };
}

export function createTelegramWorkspaceAwareModelMenuPorts<
  TContext,
  TModel extends TelegramWorkspaceModelSelection,
>(
  deps: TelegramWorkspaceAwareModelMenuPortDeps<TContext, TModel>,
): TelegramWorkspaceAwareModelMenuPorts<TContext, TModel> {
  return {
    getActiveModel: async (ctx) => {
      if (!deps.workspaceManager.isEnabled()) return deps.getParentModel(ctx);
      const workspaceModel = await deps.workspaceManager.getActiveModel(ctx);
      if (!workspaceModel) return undefined;
      return deps.findModel(workspaceModel, ctx) ?? ({ ...workspaceModel } as TModel);
    },
    canSwitchModel: (ctx) =>
      deps.workspaceManager.isEnabled()
        ? deps.workspaceManager.canSwitchActiveModel(ctx)
        : deps.isParentIdle(ctx),
    canOfferInFlightModelSwitch: (ctx) =>
      deps.workspaceManager.isEnabled()
        ? false
        : deps.canOfferParentInFlightModelSwitch(ctx),
  };
}

export function createTelegramWorkspaceAwareThinkingLevelGetter<TContext>(deps: {
  workspaceManager: Pick<
    TelegramWorkspaceManager<TContext>,
    "isEnabled" | "getActiveThinkingLevel"
  >;
  getParentThinkingLevel: () => ThinkingLevel;
}): (ctx: TContext) => Promise<ThinkingLevel> | ThinkingLevel {
  return async (ctx) => {
    if (!deps.workspaceManager.isEnabled()) return deps.getParentThinkingLevel();
    return (
      (await deps.workspaceManager.getActiveThinkingLevel(ctx)) ??
      deps.getParentThinkingLevel()
    );
  };
}

export function createTelegramWorkspaceReferenceContextWindowGetter<
  TContext,
  TModel extends { contextWindow?: number },
>(deps: {
  getParentModel: (ctx: TContext) => TModel | undefined;
  findModel: (
    identity: TelegramWorkspaceModelSelection,
    ctx: TContext,
  ) => TModel | undefined;
}): (
  reference: TelegramWorkspaceSessionReference,
  ctx: TContext,
) => number | undefined {
  return (reference, ctx) =>
    reference.currentModel
      ? deps.findModel(reference.currentModel, ctx)?.contextWindow
      : deps.getParentModel(ctx)?.contextWindow;
}

export function createTelegramWorkspaceManagerShutdownHook<TContext>(
  manager: TelegramWorkspaceManager<TContext>,
): () => Promise<void> {
  return manager.dispose;
}
