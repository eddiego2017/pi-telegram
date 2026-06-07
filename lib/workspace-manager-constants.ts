/**
 * Telegram workspace runtime constants and environment helpers
 * Zones: telegram controls, configuration
 */

export const TELEGRAM_WORKSPACE_STREAM_EDIT_THROTTLE_MS = 10_000;
export const TELEGRAM_WORKSPACE_STREAM_FAILURE_BASE_RETRY_MS = 30_000;
export const TELEGRAM_WORKSPACE_STREAM_FAILURE_MAX_RETRY_MS = 10 * 60 * 1000;
export const TELEGRAM_WORKSPACE_STREAM_MARKDOWN_LIMIT = 3600;
export const TELEGRAM_WORKSPACE_TYPING_ACTION_INTERVAL_MS = 8_000;
export const TELEGRAM_WORKSPACE_DASHBOARD_STATE_TTL_MS = 10 * 60 * 1000;
export const TELEGRAM_WORKSPACE_TOOL_STATUS_MAX_ENTRIES = 6;
export const TELEGRAM_FORUM_NATIVE_WORKSPACE_LIFECYCLE_DISABLED_MESSAGE =
  "Forum-native mode is enabled. Use Telegram topics to create, switch, and close workspaces.";

export function getTelegramWorkspaceBooleanEnv(
  name: string,
  defaultValue: boolean,
): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return defaultValue;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return defaultValue;
}

export type TelegramWorkspaceToolPreviewMode = "off" | "stream" | "compact";

export function getTelegramWorkspaceToolPreviewMode(): TelegramWorkspaceToolPreviewMode {
  const value = process.env.PI_TELEGRAM_TOOL_PREVIEW_MODE?.trim().toLowerCase();
  if (value === "compact" || value === "summary") return "compact";
  if (value === "stream" || value === "full" || value === "on") return "stream";
  if (value === "off" || value === "0" || value === "false") return "off";
  return getTelegramWorkspaceBooleanEnv("PI_TELEGRAM_TOOL_PREVIEWS", true)
    ? "stream"
    : "off";
}

export function truncateTelegramWorkspaceStreamMarkdown(markdown: string): string {
  const trimmed = markdown.trim();
  if (trimmed.length <= TELEGRAM_WORKSPACE_STREAM_MARKDOWN_LIMIT) return trimmed;
  return trimmed.slice(trimmed.length - TELEGRAM_WORKSPACE_STREAM_MARKDOWN_LIMIT);
}
