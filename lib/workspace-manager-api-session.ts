/**
 * Workspace manager public API: model/thinking/session controls
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import {
  isThinkingLevel,
} from "./model.ts";
import type {
  ThinkingLevel,
} from "./model.ts";
import {
  resetRuntimeTurnBuffers,
} from "./workspace-manager-events.ts";
import {
  applyRpcStateToRecord,
  canSwitchTelegramWorkspaceModel,
  getErrorMessage,
  getTelegramTopicSessionName,
  getTelegramWorkspaceSessionReference,
  isSameTelegramWorkspaceSessionFile,
  normalizeTelegramWorkspaceSessionName,
} from "./workspace-manager-state.ts";
import type {
  TelegramWorkspaceManager,
  TelegramWorkspaceManagerDeps,
} from "./workspace-manager-types.ts";
import {
  formatTelegramWorkspaceDisplayName,
} from "./workspaces.ts";
import {
  unlink,
} from "node:fs/promises";

export function buildApiSession<TContext>(
  self: WsRuntimeContext<TContext>,
  deps: TelegramWorkspaceManagerDeps<TContext>,
): Pick<TelegramWorkspaceManager<TContext>, "isEnabled" | "getActiveModel" | "getActiveThinkingLevel" | "getActiveSessionReference" | "getActiveResumeSessionScope" | "getActiveSessionName" | "canSwitchActiveModel" | "selectActiveModel" | "setActiveThinkingLevel" | "setActiveSessionName" | "compactActive" | "newActiveSession" | "deleteActiveSession" | "abortActive" | "switchSession" | "createActiveTreeBranch"> {
  return {
    isEnabled: self.isEnabled,
    getActiveModel: async (ctx) => {
      if (!self.isEnabled()) return undefined;
      const runtime = await self.getActiveRuntime(ctx);
      if (!runtime) return undefined;
      await self.refreshRuntimeState(runtime);
      return runtime.record.currentModel;
    },
    getActiveThinkingLevel: async (ctx) => {
      if (!self.isEnabled()) return undefined;
      const runtime = await self.getActiveRuntime(ctx);
      if (!runtime) return undefined;
      await self.refreshRuntimeState(runtime);
      const currentThinkingLevel = runtime.record.currentThinkingLevel;
      if (!isThinkingLevel(currentThinkingLevel ?? "")) return undefined;
      return currentThinkingLevel as ThinkingLevel;
    },
    getActiveSessionReference: (ctx) => {
      if (!self.isEnabled()) return undefined;
      const runtime = self.getActiveRuntimeSync(ctx);
      if (!runtime) return undefined;
      return getTelegramWorkspaceSessionReference(runtime.record, deps.getCwd(ctx));
    },
    getActiveResumeSessionScope: (ctx) => {
      if (!self.isEnabled()) return undefined;
      const runtime = self.getActiveRuntimeSync(ctx);
      if (!runtime) return undefined;
      const cwd = runtime.record.cwd || deps.getCwd(ctx);
      return {
        kind: "workspace",
        workspaceName: runtime.record.name,
        cwd,
        sessionDir: deps.getSessionDir?.(ctx) ?? self.configuredSessionDir,
        currentSessionFile: runtime.record.sessionFile,
      };
    },
    getActiveSessionName: (ctx) => {
      if (!self.isEnabled()) return undefined;
      const runtime = self.getActiveRuntimeSync(ctx);
      return runtime?.record.sessionName;
    },
    canSwitchActiveModel: async (ctx) => {
      if (!self.isEnabled()) return false;
      const runtime = await self.getActiveRuntime(ctx);
      if (!runtime) return false;
      await self.refreshRuntimeState(runtime);
      return canSwitchTelegramWorkspaceModel(runtime.record);
    },
    selectActiveModel: async (model, ctx) => {
      if (!self.isEnabled()) return false;
      const runtime = await self.getActiveRuntime(ctx);
      if (!runtime) return false;
      await self.refreshRuntimeState(runtime);
      if (!canSwitchTelegramWorkspaceModel(runtime.record)) return false;
      try {
        const backend = await self.ensureBackend(runtime, ctx);
        await backend.setModel(model.provider, model.id);
        runtime.record.currentModel = {
          provider: model.provider,
          id: model.id,
        };
        await self.refreshRuntimeState(runtime);
        return true;
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "set_model",
        });
        await self.persist();
        return false;
      }
    },
    setActiveThinkingLevel: async (level, ctx) => {
      if (!self.isEnabled()) return undefined;
      const runtime = await self.getActiveRuntime(ctx);
      if (!runtime) return undefined;
      await self.refreshRuntimeState(runtime);
      if (!canSwitchTelegramWorkspaceModel(runtime.record)) return undefined;
      try {
        const backend = await self.ensureBackend(runtime, ctx);
        await backend.setThinkingLevel(level);
        const childState = await backend.getState();
        applyRpcStateToRecord(runtime.record, childState);
        if (!runtime.record.currentThinkingLevel) {
          runtime.record.currentThinkingLevel = level;
        }
        await self.persist();
        return isThinkingLevel(runtime.record.currentThinkingLevel)
          ? runtime.record.currentThinkingLevel
          : undefined;
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "set_thinking_level",
        });
        await self.persist();
        return undefined;
      }
    },
    setActiveSessionName: async (name, ctx) => {
      if (!self.isEnabled()) return false;
      const runtime = await self.getActiveRuntime(ctx);
      if (!runtime) return false;
      const normalizedName = normalizeTelegramWorkspaceSessionName(name);
      if (normalizedName === undefined) {
        delete runtime.record.sessionName;
      } else {
        runtime.record.sessionName = normalizedName;
      }
      await self.persist();
      try {
        const backend = await self.ensureBackend(runtime, ctx);
        await backend.setSessionName(name);
        const childState = await backend.getState();
        applyRpcStateToRecord(runtime.record, childState);
        if (
          normalizedName === undefined &&
          childState.sessionName === undefined
        ) {
          delete runtime.record.sessionName;
        }
        await self.persist();
      } catch (error) {
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "set_session_name",
        });
      }
      return true;
    },
    compactActive: (ctx, callbacks) => {
      if (!self.isEnabled()) return false;
      const runtime = self.getActiveRuntimeSync(ctx);
      if (!runtime) return false;
      if (
        runtime.record.status === "running" ||
        runtime.record.status === "starting"
      ) {
        throw new Error(self.formatRuntimeBusyMessage(runtime));
      }
      void (async () => {
        try {
          runtime.record.status = "starting";
          runtime.record.lastError = undefined;
          runtime.record.lastUsedAt = self.now();
          await self.persist();
          const backend = await self.ensureBackend(runtime, ctx);
          await backend.compact();
          const childState = await backend.getState();
          applyRpcStateToRecord(runtime.record, childState);
          runtime.record.status =
            childState.isStreaming === true || childState.isCompacting === true
              ? "running"
              : "idle";
          runtime.record.lastUsedAt = self.now();
          await self.persist();
          callbacks.onComplete();
          await self.flushPendingCompactionTurns(runtime, ctx);
        } catch (error) {
          runtime.record.status = "error";
          runtime.record.lastError = getErrorMessage(error);
          deps.recordRuntimeEvent?.("workspaces", error, {
            workspace: runtime.record.name,
            action: "compact",
          });
          await self.persist();
          callbacks.onError(error);
          const droppedTurns = runtime.pendingCompactionTurns ?? [];
          self.clearPendingCompactionTurns(runtime);
          for (const droppedTurn of droppedTurns) {
            await self.sendTurnTextReply(
              droppedTurn,
              "Compaction failed; this queued prompt was dropped. Resend after the worker recovers.",
            ).catch(() => undefined);
          }
        }
      })();
      return true;
    },
    newActiveSession: async (ctx) => {
      if (!self.isEnabled()) return undefined;
      const runtime = await self.getActiveRuntime(ctx);
      if (!runtime) return undefined;
      await self.refreshRuntimeState(runtime);
      if (
        runtime.record.status === "running" ||
        runtime.record.status === "starting"
      ) {
        throw new Error(self.formatRuntimeBusyMessage(runtime));
      }
      try {
        const backend = await self.ensureBackend(runtime, ctx);
        const result = await backend.newSession();
        if (result.cancelled) return { cancelled: true };
        const topicSessionName = getTelegramTopicSessionName(runtime.record);
        if (topicSessionName) {
          await self.syncTopicSessionNameToWorker(runtime, { forceWorker: true });
        }
        const childState = await backend.getState();
        applyRpcStateToRecord(runtime.record, childState);
        if (topicSessionName) {
          runtime.record.sessionName = topicSessionName;
        } else {
          const sessionName =
            typeof childState.sessionName === "string"
              ? childState.sessionName.trim()
              : undefined;
          if (sessionName) {
            runtime.record.sessionName = sessionName;
          } else {
            delete runtime.record.sessionName;
          }
        }
        runtime.record.lastAssistantText = undefined;
        runtime.record.lastMessageText = undefined;
        runtime.record.lastMessageAt = undefined;
        runtime.record.lastAgentStartAt = undefined;
        runtime.record.lastAgentEndAt = undefined;
        runtime.record.lastError = undefined;
        runtime.record.status = childState.isStreaming === true ? "running" : "idle";
        runtime.record.lastUsedAt = self.now();
        resetRuntimeTurnBuffers(runtime);
        await self.persist();
        return { cancelled: false };
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "new_session",
        });
        await self.persist();
        throw error;
      }
    },
    deleteActiveSession: async (expectedSessionPath, ctx) => {
      if (!self.isEnabled()) return undefined;
      const workspaceState = await self.ensureState(deps.getCwd(ctx));
      const scoped = await self.resolveScopedTopicRuntime(workspaceState, ctx);
      const runtime = scoped.scoped
        ? scoped.runtime
        : self.getWorkspaceRuntime(workspaceState, workspaceState.activeWorkspace);
      if (!runtime) return undefined;
      await self.refreshRuntimeState(runtime);
      if (!canSwitchTelegramWorkspaceModel(runtime.record)) {
        throw new Error(self.formatRuntimeStopFirstMessage(runtime));
      }
      const sessionPath = runtime.record.sessionFile;
      if (!sessionPath) {
        throw new Error("current session is not persisted");
      }
      if (
        expectedSessionPath &&
        !isSameTelegramWorkspaceSessionFile(expectedSessionPath, sessionPath)
      ) {
        throw new Error("current session changed before deletion");
      }
      await self.assertNoOpenSessionConflict(workspaceState, runtime, runtime.record);
      try {
        const backend = await self.ensureBackend(runtime, ctx);
        const result = await backend.newSession(sessionPath);
        if (result.cancelled) {
          throw new Error("newSession cancelled");
        }
        const childState = await backend.getState();
        applyRpcStateToRecord(runtime.record, childState);
        if (
          !runtime.record.sessionFile ||
          isSameTelegramWorkspaceSessionFile(runtime.record.sessionFile, sessionPath)
        ) {
          throw new Error("new session did not replace current session");
        }
        runtime.record.lastAssistantText = undefined;
        runtime.record.lastMessageText = undefined;
        runtime.record.lastMessageAt = undefined;
        runtime.record.lastAgentStartAt = undefined;
        runtime.record.lastAgentEndAt = undefined;
        runtime.record.lastError = undefined;
        runtime.record.status = childState.isStreaming === true ? "running" : "idle";
        runtime.record.lastUsedAt = self.now();
        resetRuntimeTurnBuffers(runtime);
        await self.persist();
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "delete_session",
        });
        await self.persist();
        throw error;
      }
      try {
        await (deps.deleteSessionFile ?? unlink)(sessionPath);
      } catch (error) {
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "delete_session_file",
        });
        throw error;
      }
      return true;
    },
    abortActive: async (ctx) => {
      if (!self.isEnabled()) return undefined;
      const workspaceState = await self.ensureState(deps.getCwd(ctx));
      const scoped = await self.resolveScopedTopicRuntime(workspaceState, ctx);
      return self.commandHandlers.abortRuntime(workspaceState, scoped.runtime?.record.name);
    },
    switchSession: async (sessionPath, ctx, scope) => {
      if (!self.isEnabled() || scope?.kind !== "workspace" || !scope.workspaceName) {
        return false;
      }
      const workspaceState = await self.ensureState(deps.getCwd(ctx));
      const runtime = self.getWorkspaceRuntime(workspaceState, scope.workspaceName);
      if (!runtime) {
        throw new Error(`Unknown workspace: ${formatTelegramWorkspaceDisplayName(scope.workspaceName)}`);
      }
      await self.refreshRuntimeState(runtime);
      if (!canSwitchTelegramWorkspaceModel(runtime.record)) {
        throw new Error(self.formatScopedWorkspaceBusyMessage(scope.workspaceName));
      }
      await self.assertNoOpenSessionConflict(workspaceState, runtime, {
        sessionFile: sessionPath,
      });
      try {
        const backend = await self.ensureBackend(runtime, ctx);
        const result = await backend.switchSession(sessionPath);
        if (result.cancelled) {
          throw new Error("switchSession cancelled");
        }
        const topicSessionName = getTelegramTopicSessionName(runtime.record);
        if (topicSessionName) {
          await self.syncTopicSessionNameToWorker(runtime, { forceWorker: true });
        }
        self.stopWorkspaceTyping(runtime);
        resetRuntimeTurnBuffers(runtime);
        delete runtime.record.lastAssistantText;
        delete runtime.record.lastMessageText;
        delete runtime.record.lastMessageAt;
        runtime.record.sessionFile = sessionPath;
        runtime.record.lastError = undefined;
        const childState = await self.refreshRuntimeState(runtime);
        if (!isSameTelegramWorkspaceSessionFile(childState?.sessionFile, sessionPath)) {
          const reported = childState?.sessionFile ?? "(none)";
          deps.recordRuntimeEvent?.(
            "workspaces",
            new Error(
              `RPC worker reported ${reported} after switch_session ${sessionPath}; restarting worker on target session.`,
            ),
            {
              workspace: runtime.record.name,
              action: "switch_session_rebind",
            },
          );
          await self.disposeRuntimeBackend(runtime);
          runtime.record.sessionFile = sessionPath;
          runtime.record.status = "starting";
          runtime.record.lastError = undefined;
          delete runtime.record.sessionId;
          delete runtime.record.sessionName;
          await self.persist();
          await self.ensureBackend(runtime, ctx);
          if (!isSameTelegramWorkspaceSessionFile(runtime.record.sessionFile, sessionPath)) {
            throw new Error(
              self.formatRuntimeSessionBindFailureMessage(scope.workspaceName, sessionPath),
            );
          }
          const topicSessionNameAfterRestart = getTelegramTopicSessionName(
            runtime.record,
          );
          if (topicSessionNameAfterRestart && runtime.backend) {
            await self.syncTopicSessionNameToWorker(runtime, { forceWorker: true });
          }
        }
        const topicSessionNameAfterSwitch = getTelegramTopicSessionName(
          runtime.record,
        );
        if (topicSessionNameAfterSwitch) {
          runtime.record.sessionName = topicSessionNameAfterSwitch;
        }
        runtime.record.lastUsedAt = self.now();
        await self.persist();
        return true;
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "switch_session",
        });
        await self.persist();
        throw error;
      }
    },
    createActiveTreeBranch: async (entryId, ctx) => {
      if (!self.isEnabled()) return undefined;
      const runtime = await self.getActiveRuntime(ctx);
      if (!runtime) return undefined;
      await self.refreshRuntimeState(runtime);
      if (!canSwitchTelegramWorkspaceModel(runtime.record)) {
        throw new Error(self.formatRuntimeAbortFirstMessage(runtime));
      }
      try {
        if (!deps.createTreeBranch) {
          throw new Error(self.formatRuntimeTreeBranchUnavailableMessage());
        }
        const result = await deps.createTreeBranch(
          getTelegramWorkspaceSessionReference(runtime.record, deps.getCwd(ctx)),
          entryId,
        );
        if (result.cancelled) return result;
        await self.disposeRuntimeBackend(runtime);
        resetRuntimeTurnBuffers(runtime);
        delete runtime.record.lastAssistantText;
        delete runtime.record.lastMessageText;
        delete runtime.record.lastMessageAt;
        delete runtime.record.lastAgentStartAt;
        delete runtime.record.lastAgentEndAt;
        runtime.record.lastError = undefined;
        runtime.record.status = "idle";
        runtime.record.lastUsedAt = self.now();
        await self.persist();
        return result;
      } catch (error) {
        runtime.record.status = "error";
        runtime.record.lastError = getErrorMessage(error);
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "create_tree_branch",
        });
        await self.persist();
        throw error;
      }
    },
  };
}
