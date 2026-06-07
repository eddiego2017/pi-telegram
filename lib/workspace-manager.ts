/**
 * Telegram workspace runtime entry: assembles the self-context via installers and exposes the public manager API
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import type {
  TelegramWorkspaceManager,
  TelegramWorkspaceManagerDeps,
} from "./workspace-manager-types.ts";
import { installRuntimeCore } from "./workspace-manager-runtime-core.ts";
import { installMessages } from "./workspace-manager-messages.ts";
import { installStream } from "./workspace-manager-stream.ts";
import { installStreamActive } from "./workspace-manager-stream-active.ts";
import { installChildEvent } from "./workspace-manager-child-event.ts";
import { installBackend } from "./workspace-manager-backend.ts";
import { installTopic } from "./workspace-manager-topic.ts";
import { installDashboardRuntime } from "./workspace-manager-dashboard-runtime.ts";
import { installPrompt } from "./workspace-manager-prompt.ts";
import { installCommands } from "./workspace-manager-commands.ts";
import { buildApiSession } from "./workspace-manager-api-session.ts";
import { buildApiCallback } from "./workspace-manager-api-callback.ts";
import { buildApiCommand } from "./workspace-manager-api-command.ts";

export * from "./workspace-manager-context.ts";
export * from "./workspace-manager-constants.ts";
export * from "./workspace-manager-types.ts";
export * from "./workspace-manager-state.ts";
export * from "./workspace-manager-events.ts";
export * from "./workspace-manager-dashboard.ts";
export * from "./workspace-manager-ports.ts";

export function createTelegramWorkspaceManager<TContext>(
  deps: TelegramWorkspaceManagerDeps<TContext>,
): TelegramWorkspaceManager<TContext> {
  const self = {} as WsRuntimeContext<TContext>;
  installRuntimeCore(self, deps);
  installMessages(self, deps);
  installStream(self, deps);
  installStreamActive(self, deps);
  installChildEvent(self, deps);
  installBackend(self, deps);
  installTopic(self, deps);
  installDashboardRuntime(self, deps);
  installPrompt(self, deps);
  installCommands(self, deps);
  return {
    ...buildApiSession(self, deps),
    ...buildApiCallback(self, deps),
    ...buildApiCommand(self, deps),
  };
}
