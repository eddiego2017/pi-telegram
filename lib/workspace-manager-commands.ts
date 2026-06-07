/**
 * Workspace command handlers installer: assembles commandHandlers from grouped builders
 * Zones: telegram controls, pi agent, process lifecycle
 */

import type { WsRuntimeContext } from "./workspace-manager-context.ts";
import type {
  TelegramWorkspaceManagerDeps,
} from "./workspace-manager-types.ts";
import { buildCommandsCore } from "./workspace-manager-commands-core.ts";
import { buildCommandsMaintenance } from "./workspace-manager-commands-maintenance.ts";

export function installCommands<TContext>(
  self: WsRuntimeContext<TContext>,
  deps: TelegramWorkspaceManagerDeps<TContext>,
): void {
  self.commandHandlers = {
    ...buildCommandsCore(self, deps),
    ...buildCommandsMaintenance(self, deps),
  };
}
