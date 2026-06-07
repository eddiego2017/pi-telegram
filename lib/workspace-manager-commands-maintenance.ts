/**
 * Workspace command handlers: abort/sync/restart/topic maintenance
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import {
  isSameTelegramTopicOrphanTarget,
} from "./topic-orphans.ts";
import type {
  TelegramTopicOrphanProof,
} from "./topic-orphans.ts";
import {
  formatTelegramWorkspaceOrphanDetail,
} from "./workspace-manager-dashboard.ts";
import {
  getErrorMessage,
  getSortedTelegramWorkspaceRecords,
} from "./workspace-manager-state.ts";
import type {
  TelegramWorkspaceAbortResult,
  TelegramWorkspaceManagerDeps,
} from "./workspace-manager-types.ts";
import {
  TELEGRAM_DEFAULT_WORKSPACE_NAME,
  formatTelegramWorkspaceDisplayName,
} from "./workspaces.ts";
import type {
  TelegramWorkspaceRecord,
  TelegramWorkspacesState,
} from "./workspaces.ts";

type WsCommandHandlers<TContext> = WsRuntimeContext<TContext>["commandHandlers"];

export function buildCommandsMaintenance<TContext>(
  self: WsRuntimeContext<TContext>,
  deps: TelegramWorkspaceManagerDeps<TContext>,
): Pick<WsCommandHandlers<TContext>, "abortRuntime" | "abort" | "syncNames" | "restart" | "topicOrphans" | "topicCleanup"> {
  return {
    abortRuntime: async (
      workspaceState: TelegramWorkspacesState,
      name: string | undefined,
    ): Promise<TelegramWorkspaceAbortResult> => {
      const targetName = name ?? workspaceState.activeWorkspace;
      const runtime = self.getWorkspaceRuntime(workspaceState, targetName);
      if (runtime) {
        const droppedTurns = runtime.pendingCompactionTurns ?? [];
        runtime.pendingCompactionTurns = undefined;
        for (const droppedTurn of droppedTurns) {
          await self.sendTurnTextReply(
            droppedTurn,
            "Aborted; this queued prompt was dropped.",
          ).catch(() => undefined);
        }
      }
      if (!runtime?.backend) {
        return {
          workspaceName: targetName,
          aborted: false,
          message: runtime
            ? `No active worker for ${self.formatRuntimeUserScopeTarget(runtime)}.`
            : `No active worker for workspace ${formatTelegramWorkspaceDisplayName(targetName)}.`,
        };
      }
      let abortError: unknown;
      try {
        await runtime.backend.abort();
      } catch (error) {
        abortError = error;
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: targetName,
          action: "abort",
        });
        await self.disposeRuntimeBackend(runtime).catch((disposeError) => {
          deps.recordRuntimeEvent?.("workspaces", disposeError, {
            workspace: targetName,
            action: "abort_dispose",
          });
        });
      }
      self.stopWorkspaceTyping(runtime);
      await self.markActiveWorkspaceTextStreamAborted(runtime).catch((error) => {
        deps.recordRuntimeEvent?.("workspaces", error, {
          workspace: targetName,
          action: "stream_abort_mark",
          turnId: runtime.activeTurnId,
        });
      });
      runtime.record.status = "idle";
      runtime.record.lastError = undefined;
      await self.persist();
      return {
        workspaceName: targetName,
        aborted: true,
        message: abortError
          ? `Aborted ${self.formatRuntimeUserScopeTarget(runtime)} after worker stopped responding.`
          : `Aborted ${self.formatRuntimeUserScopeTarget(runtime)}.`,
      };
    },
    abort: async (
      workspaceState: TelegramWorkspacesState,
      name: string | undefined,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const result = await self.commandHandlers.abortRuntime(workspaceState, name);
      await deps.sendTextReply(chatId, replyToMessageId, result.message);
    },
    syncNames: async (
      workspaceState: TelegramWorkspacesState,
      chatId: number,
      replyToMessageId: number,
    ) => {
      let changed = 0;
      for (const record of Object.values(workspaceState.workspaces)) {
        if (record.source?.kind !== "telegram-topic") continue;
        const runtime = self.getWorkspaceRuntime(workspaceState, record.name);
        if (!runtime) continue;
        const didSync = await self.syncTopicSessionNameToWorker(runtime, {
          forceWorker: true,
        });
        if (didSync) changed += 1;
      }
      if (changed > 0) await self.persist();
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        `Synced ${changed} topic session name${changed === 1 ? "" : "s"}.`,
      );
    },
    restart: async (
      workspaceState: TelegramWorkspacesState,
      name: string,
      chatId: number,
      replyToMessageId: number,
      ctx: TContext,
    ) => {
      const runtime = self.getWorkspaceRuntime(workspaceState, name);
      if (!runtime) {
        await deps.sendTextReply(chatId, replyToMessageId, `Unknown workspace: ${formatTelegramWorkspaceDisplayName(name)}`);
        return;
      }
      await self.disposeRuntimeBackend(runtime);
      try {
        await self.ensureBackend(runtime, ctx);
        await deps.sendTextReply(chatId, replyToMessageId, `Restarted workspace ${formatTelegramWorkspaceDisplayName(name)}.`);
      } catch (error) {
        deps.recordRuntimeEvent?.("workspaces", error, { workspace: name, action: "restart" });
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          `Workspace ${formatTelegramWorkspaceDisplayName(name)} restart failed: ${getErrorMessage(error)}`,
        );
      }
    },
    topicOrphans: async (
      workspaceState: TelegramWorkspacesState,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const proofs = deps.topicOrphanProofStore?.getProofs() ?? [];
      const provenOrphans: Array<{
        record: TelegramWorkspaceRecord;
        proof: TelegramTopicOrphanProof;
      }> = [];
      const errored: TelegramWorkspaceRecord[] = [];
      const suspected: TelegramWorkspaceRecord[] = [];
      for (const record of getSortedTelegramWorkspaceRecords(workspaceState)) {
        if (record.source?.kind !== "telegram-topic") continue;
        const runtime = self.getWorkspaceRuntime(workspaceState, record.name);
        const proof = proofs.find((item) =>
          isSameTelegramTopicOrphanTarget(item, record.source!)
        );
        if (proof) {
          provenOrphans.push({ record, proof });
        } else if (record.status === "error" && record.lastError) {
          errored.push(record);
        } else if (!self.hasLiveWorker(runtime)) {
          suspected.push(record);
        }
      }
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        [
          "Topic orphan diagnostics:",
          `Proven orphans: ${provenOrphans.length}`,
          ...(provenOrphans.length > 0
            ? provenOrphans.map(({ record, proof }) =>
                formatTelegramWorkspaceOrphanDetail(record, proof)
              )
            : ["- none"]),
          "",
          `Errored topic records: ${errored.length}`,
          ...(errored.length > 0
            ? errored.slice(0, 10).map((record) =>
                formatTelegramWorkspaceOrphanDetail(record)
              )
            : ["- none"]),
          ...(errored.length > 10
            ? [`- ...and ${errored.length - 10} more`]
            : []),
          "",
          `Suspected topic records without workers: ${suspected.length}`,
          ...(suspected.length > 0
            ? suspected.slice(0, 10).map((record) =>
                formatTelegramWorkspaceOrphanDetail(record)
              )
            : ["- none"]),
          ...(suspected.length > 10
            ? [`- ...and ${suspected.length - 10} more`]
            : []),
        ].join("\n"),
      );
    },
    topicCleanup: async (
      workspaceState: TelegramWorkspacesState,
      chatId: number,
      replyToMessageId: number,
    ) => {
      const proofs = deps.topicOrphanProofStore?.getProofs() ?? [];
      const provenOrphans = getSortedTelegramWorkspaceRecords(workspaceState).filter(
        (record) =>
          record.source?.kind === "telegram-topic" &&
          proofs.some((proof) =>
            isSameTelegramTopicOrphanTarget(proof, record.source!)
          ),
      );
      if (provenOrphans.length === 0) {
        await deps.sendTextReply(
          chatId,
          replyToMessageId,
          "No proven topic orphans to clean.",
        );
        return;
      }
      for (const record of provenOrphans) {
        const runtime = self.getWorkspaceRuntime(workspaceState, record.name);
        if (runtime) await self.disposeClosingRuntimeBackend(runtime);
        self.workspaceRuntimes.delete(record.name);
        delete workspaceState.workspaces[record.name];
        if (record.source?.kind === "telegram-topic") {
          deps.topicOrphanProofStore?.clearProofsFor(
            record.source.chatId,
            record.source.messageThreadId!,
          );
        }
      }
      if (!workspaceState.workspaces[workspaceState.activeWorkspace]) {
        workspaceState.activeWorkspace = TELEGRAM_DEFAULT_WORKSPACE_NAME;
      }
      deps.debugLogger?.log("telegram.topic.orphan.cleanup", {
        count: provenOrphans.length,
        records: provenOrphans.map((record) => ({
          workspace: record.name,
          chatId: record.source?.chatId,
          messageThreadId: record.source?.messageThreadId,
        })),
      });
      deps.recordRuntimeEvent?.("workspaces", "topic orphan cleanup", {
        action: "topic_cleanup",
        count: provenOrphans.length,
      });
      await self.persist();
      await deps.sendTextReply(
        chatId,
        replyToMessageId,
        `Cleaned ${provenOrphans.length} proven topic orphan${provenOrphans.length === 1 ? "" : "s"}. Session files are kept.`,
      );
    },
  };
}
