/**
 * Workspace RPC backend lifecycle: ensure/dispose, session-name sync, state refresh
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import {
  RpcChildBackend,
} from "./rpc-child.ts";
import type {
  RpcChildSessionState,
} from "./rpc-child.ts";
import {
  resetRuntimeTurnBuffers,
} from "./workspace-manager-events.ts";
import {
  applyRpcStateToRecord,
  buildTelegramWorkspaceWorkerExtensionArgs,
  getErrorMessage,
  getTelegramTopicSessionName,
  normalizeTelegramWorkspaceSessionName,
} from "./workspace-manager-state.ts";
import type {
  TelegramWorkspaceBackend,
  TelegramWorkspaceManagerDeps,
  WorkspaceRuntime,
} from "./workspace-manager-types.ts";
import type {
  TelegramWorkspacesState,
} from "./workspaces.ts";

export function installBackend<TContext>(
  self: WsRuntimeContext<TContext>,
  deps: TelegramWorkspaceManagerDeps<TContext>,
): void {
  self.ensureBackend = async (
    runtime: WorkspaceRuntime,
    ctx: TContext,
  ): Promise<TelegramWorkspaceBackend> => {
    if (runtime.backend) return runtime.backend;
    await self.ensureWorkerCapacity(runtime);
    runtime.record.status = "starting";
    runtime.record.lastError = undefined;
    const cwd = runtime.record.cwd || deps.getCwd(ctx);
    const sessionDir = deps.getSessionDir?.(ctx) ?? self.configuredSessionDir;
    const config = deps.getConfig();
    const workerArgs = buildTelegramWorkspaceWorkerExtensionArgs(
      config.workerExtensions,
    );
    const defaultModel = config.topicBinding?.defaultModel;
    if (defaultModel) {
      workerArgs.push("--model", defaultModel);
    }
    deps.debugLogger?.log(
      "telegram.workspace.worker.start",
      {
        workspace: runtime.record.name,
        cwd,
        sessionDir,
        sessionFile: runtime.record.sessionFile,
        workerExtensionCount: deps.getConfig().workerExtensions.length,
      },
      workerArgs,
    );
    runtime.closing = false;
    const workerStartedAt = Date.now();
    const backend = deps.createBackend?.({
      workspaceName: runtime.record.name,
      cwd,
      sessionDir,
      sessionFile: runtime.record.sessionFile,
      args: workerArgs,
    }) ?? new RpcChildBackend({
      workspaceName: runtime.record.name,
      cwd,
      sessionDir,
      sessionFile: runtime.record.sessionFile,
      args: workerArgs,
    });
    runtime.backend = backend;
    runtime.unsubscribe = backend.onEvent((event) => {
      self.handleChildEvent(runtime.record.name, runtime, event);
    });
    try {
      const childState = await backend.start();
      deps.debugLogger?.log(
        "telegram.workspace.worker.ready",
        { workspace: runtime.record.name, elapsedMs: Date.now() - workerStartedAt },
        childState,
      );
      applyRpcStateToRecord(runtime.record, childState);
      await self.syncTopicSessionNameToWorker(runtime, {
        workerSessionName: childState.sessionName,
      });
      await self.persist();
      return backend;
    } catch (error) {
      deps.debugLogger?.log("telegram.workspace.worker.start_error", {
        workspace: runtime.record.name,
        elapsedMs: Date.now() - workerStartedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      runtime.record.status = "error";
      runtime.record.lastError = getErrorMessage(error);
      runtime.backend = undefined;
      runtime.unsubscribe?.();
      runtime.unsubscribe = undefined;
      await self.persist();
      throw error;
    }
  };
  self.disposeRuntimeBackend = async (runtime: WorkspaceRuntime): Promise<void> => {
    self.stopWorkspaceTyping(runtime);
    const backend = runtime.backend;
    runtime.backend = undefined;
    runtime.unsubscribe?.();
    runtime.unsubscribe = undefined;
    await backend?.dispose();
  };
  self.disposeClosingRuntimeBackend = async (
    runtime: WorkspaceRuntime,
  ): Promise<void> => {
    runtime.closing = true;
    self.stopWorkspaceTyping(runtime);
    resetRuntimeTurnBuffers(runtime);
    const backend = runtime.backend;
    runtime.backend = undefined;
    runtime.unsubscribe?.();
    runtime.unsubscribe = undefined;
    await backend?.dispose();
  };
  self.syncTopicSessionNameToWorker = async (
    runtime: WorkspaceRuntime,
    options: { workerSessionName?: string; forceWorker?: boolean } = {},
  ): Promise<boolean> => {
    const topicSessionName = getTelegramTopicSessionName(runtime.record);
    if (!topicSessionName) return false;
    let changed = false;
    if (runtime.record.sessionName !== topicSessionName) {
      runtime.record.sessionName = topicSessionName;
      changed = true;
    }
    const workerSessionName = normalizeTelegramWorkspaceSessionName(
      options.workerSessionName ?? "",
    );
    const hasWorkerSessionName = Object.hasOwn(options, "workerSessionName");
    const shouldSyncWorker = Boolean(
      runtime.backend &&
        (options.forceWorker ||
          (hasWorkerSessionName && workerSessionName !== topicSessionName)),
    );
    if (shouldSyncWorker && runtime.backend) {
      try {
        await runtime.backend.setSessionName(topicSessionName);
        changed = true;
      } catch (error) {
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: runtime.record.name,
          action: "sync_topic_session_name",
        });
      }
    }
    return changed;
  };
  self.refreshRuntimeState = async (
    runtime: WorkspaceRuntime,
  ): Promise<RpcChildSessionState | undefined> => {
    if (!runtime.backend) return undefined;
    let childState: RpcChildSessionState | undefined;
    try {
      childState = await runtime.backend.getState();
      applyRpcStateToRecord(runtime.record, childState);
    } catch (error) {
      runtime.record.status = "error";
      runtime.record.lastError = getErrorMessage(error);
    }
    await self.persist();
    return childState;
  };
  self.refreshDashboardWorkspaceRecords = async (
    workspaceState: TelegramWorkspacesState,
  ): Promise<void> => {
    await Promise.all(
      Object.keys(workspaceState.workspaces).map(async (name) => {
        const runtime = self.getWorkspaceRuntime(workspaceState, name);
        if (runtime?.backend) await self.refreshRuntimeState(runtime);
      }),
    );
  };
}
