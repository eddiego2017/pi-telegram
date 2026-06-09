/**
 * Telegram workspace RPC event extraction and runtime buffer helpers
 * Zones: telegram controls, pi agent, streaming preview
 */

import {
  type RpcChildBackendEvent,
} from "./rpc-child.ts";
import {
  extractLatestAssistantMessageText,
  formatAgentThinkingBlock,
  formatAgentToolCallBlock,
  getAgentMessagePreviewText,
  isAssistantAgentMessage,
  summarizeAgentToolCall,
} from "./replies.ts";
import type { TelegramWorkspaceRecord } from "./workspaces.ts";
import {
  TELEGRAM_WORKSPACE_TOOL_STATUS_MAX_ENTRIES,
  truncateTelegramWorkspaceStreamMarkdown,
} from "./workspace-manager-constants.ts";
import type {
  TelegramWorkspacePostRunMessage,
  TelegramWorkspacePostRunMessageKind,
  TelegramWorkspaceStreamState,
  TelegramWorkspaceToolStatusEntry,
  TelegramWorkspaceToolStatusKind,
  WorkspaceRuntime,
} from "./workspace-manager-types.ts";

export function createWorkspaceRuntime(record: TelegramWorkspaceRecord): WorkspaceRuntime {
  return {
    record,
    unreadEvents: 0,
    activeBuffer: "",
    thinkingBuffers: new Map(),
    thinkingStreams: new Map(),
    toolCallStreams: new Map(),
    toolCallStatuses: new Map(),
    sentThinkingTexts: new Set(),
    sentToolCallMessages: new Set(),
    postRunMessages: [],
  };
}

export function clearTelegramWorkspaceStreamState(stream: TelegramWorkspaceStreamState): void {
  if (stream.flushTimer) {
    clearTimeout(stream.flushTimer);
    stream.flushTimer = undefined;
  }
}

export function clearRuntimePostRunPreviewStreams(runtime: WorkspaceRuntime): void {
  for (const stream of runtime.thinkingStreams.values()) {
    clearTelegramWorkspaceStreamState(stream);
  }
  for (const stream of runtime.toolCallStreams.values()) {
    clearTelegramWorkspaceStreamState(stream);
  }
  if (runtime.toolCallStatusStream) {
    clearTelegramWorkspaceStreamState(runtime.toolCallStatusStream);
    runtime.toolCallStatusStream = undefined;
  }
  runtime.thinkingStreams.clear();
  runtime.toolCallStreams.clear();
  runtime.toolCallStatuses.clear();
}

export function resetRuntimeTurnBuffers(runtime: WorkspaceRuntime): void {
  runtime.activeBuffer = "";
  runtime.activeAssistantText = undefined;
  runtime.activeErrorDelivered = false;
  runtime.streamDeliveryFailureCount = undefined;
  runtime.streamDeliveryBlockedUntil = undefined;
  runtime.lastStreamFlushAt = undefined;
  if (runtime.textStream) {
    clearTelegramWorkspaceStreamState(runtime.textStream);
    runtime.textStream = undefined;
  }
  runtime.thinkingBuffers.clear();
  clearRuntimePostRunPreviewStreams(runtime);
  runtime.sentThinkingTexts.clear();
  runtime.sentToolCallMessages.clear();
  runtime.postRunMessages = [];
}

export function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function getRpcAssistantMessageEvent(
  event: RpcChildBackendEvent,
): Record<string, unknown> | undefined {
  return getRecord(event.assistantMessageEvent);
}

export function getRpcAssistantEventContentIndex(
  assistantEvent: Record<string, unknown>,
): number {
  const index = assistantEvent.contentIndex;
  return typeof index === "number" && Number.isInteger(index) && index >= 0
    ? index
    : 0;
}

export function getRpcAssistantThinkingDelta(
  event: RpcChildBackendEvent,
): { index: number; delta: string } | undefined {
  if (event.type !== "message_update") return undefined;
  const assistantEvent = getRpcAssistantMessageEvent(event);
  if (!assistantEvent || assistantEvent.type !== "thinking_delta") {
    return undefined;
  }
  return typeof assistantEvent.delta === "string"
    ? {
        index: getRpcAssistantEventContentIndex(assistantEvent),
        delta: assistantEvent.delta,
      }
    : undefined;
}

export function getRpcAssistantThinkingEnd(
  event: RpcChildBackendEvent,
): { index: number; content?: string } | undefined {
  if (event.type !== "message_update") return undefined;
  const assistantEvent = getRpcAssistantMessageEvent(event);
  if (!assistantEvent || assistantEvent.type !== "thinking_end") {
    return undefined;
  }
  const content = assistantEvent.content;
  return {
    index: getRpcAssistantEventContentIndex(assistantEvent),
    ...(typeof content === "string" ? { content } : {}),
  };
}

export function getAgentMessageContent(message: unknown): unknown[] {
  const raw = getRecord(message)?.content;
  return Array.isArray(raw) ? raw : [];
}

export function extractAgentThinkingBlocks(
  message: unknown,
): Array<{ index: number; text: string }> {
  return getAgentMessageContent(message)
    .map((block, index) => {
      const raw = getRecord(block);
      if (!raw || raw.type !== "thinking") return undefined;
      const text = typeof raw.thinking === "string" ? raw.thinking.trim() : "";
      return text ? { index, text } : undefined;
    })
    .filter((block): block is { index: number; text: string } => !!block);
}

export function agentMessageHasToolCall(message: unknown): boolean {
  return getAgentMessageContent(message).some(
    (block) => getRecord(block)?.type === "toolCall",
  );
}

export function getAgentMessageContentBlock(
  message: unknown,
  index: number,
): unknown | undefined {
  return getAgentMessageContent(message)[index];
}

export function pushTelegramWorkspacePostRunMessage(
  runtime: WorkspaceRuntime,
  kind: TelegramWorkspacePostRunMessageKind,
  markdown: string,
  stream?: TelegramWorkspaceStreamState,
): void {
  const trimmed = markdown.trim();
  if (!trimmed) return;
  const existing = runtime.postRunMessages.find(
    (message) => message.markdown === trimmed,
  );
  if (existing) {
    existing.stream ??= stream;
    return;
  }
  runtime.postRunMessages.push({ kind, markdown: trimmed, stream });
}

export function removeTelegramWorkspacePostRunMessage(
  runtime: WorkspaceRuntime,
  markdown: string,
): void {
  const trimmed = markdown.trim();
  if (!trimmed) return;
  runtime.postRunMessages = runtime.postRunMessages.filter(
    (message) => message.markdown !== trimmed,
  );
}

export function isTelegramWorkspacePostRunTextMessage(
  message: TelegramWorkspacePostRunMessage,
): boolean {
  return message.kind === "text";
}

export function formatTelegramWorkspaceToolCallPreview(block: unknown): string {
  const raw = getRecord(block);
  if (!raw) return "";
  const partialJson = raw.partialJson;
  return formatAgentToolCallBlock({
    name: raw.name,
    arguments:
      typeof partialJson === "string" && partialJson.trim()
        ? partialJson
        : raw.arguments,
  });
}

export function getRpcAssistantToolCallPreview(
  event: RpcChildBackendEvent,
): {
  index: number;
  key: string;
  markdown: string;
  name?: string;
  summary?: string;
  final: boolean;
} | undefined {
  if (event.type !== "message_update") return undefined;
  const assistantEvent = getRpcAssistantMessageEvent(event);
  if (!assistantEvent) return undefined;
  const eventType = assistantEvent.type;
  if (eventType !== "toolcall_end") return undefined;
  const index = getRpcAssistantEventContentIndex(assistantEvent);
  const block = assistantEvent.toolCall;
  const rawBlock = getRecord(block);
  const markdown = formatTelegramWorkspaceToolCallPreview(block);
  const name =
    typeof rawBlock?.name === "string" && rawBlock.name ? rawBlock.name : undefined;
  const summary = name
    ? summarizeAgentToolCall(name, rawBlock?.arguments ?? rawBlock?.partialJson)
    : "";
  return markdown
    ? {
        index,
        key:
          typeof rawBlock?.id === "string" && rawBlock.id
            ? rawBlock.id
            : `tool:${index}`,
        markdown,
        ...(name ? { name } : {}),
        ...(summary ? { summary } : {}),
        final: eventType === "toolcall_end",
      }
    : undefined;
}

export function getRpcToolExecutionPreview(
  event: RpcChildBackendEvent,
): {
  key: string;
  markdown: string;
  name?: string;
  summary?: string;
  status: TelegramWorkspaceToolStatusKind;
} | undefined {
  if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") {
    return undefined;
  }
  const toolCallId =
    typeof event.toolCallId === "string" && event.toolCallId
      ? event.toolCallId
      : undefined;
  const toolName =
    typeof event.toolName === "string" && event.toolName ? event.toolName : "tool";
  const result = getRecord(event.result);
  const isError =
    event.type === "tool_execution_end" &&
    (event.isError === true || result?.isError === true);
  const summary = summarizeAgentToolCall(toolName, event.args);
  return {
    key: toolCallId ?? `${toolName}:${event.type}`,
    markdown: formatAgentToolCallBlock({
      name: toolName,
      arguments: event.args,
    }),
    name: toolName,
    ...(summary ? { summary } : {}),
    status:
      event.type === "tool_execution_start"
        ? "running"
        : isError
          ? "failed"
          : "done",
  };
}

export function formatTelegramWorkspaceToolStatusKind(
  status: TelegramWorkspaceToolStatusKind,
): string {
  if (status === "running") return "\u23F3";
  if (status === "done") return "\u2705";
  if (status === "failed") return "\u274C";
  return "\u231B";
}

function getTelegramWorkspaceToolStatusTitle(
  entry: TelegramWorkspaceToolStatusEntry,
): string {
  if (entry.name) {
    const summary = entry.summary ? ` · ${entry.summary}` : "";
    return `\`${entry.name}\`${summary}`;
  }
  const firstLine = entry.markdown.trim().split("\n")[0] ?? "";
  return firstLine.replace(/^\u{1F527}\s*/u, "") || "`tool`";
}

export function formatTelegramWorkspaceCompactToolStatusMarkdown(
  entries: TelegramWorkspaceToolStatusEntry[],
  totalCount: number,
): string {
  const visibleEntries = entries.slice(-TELEGRAM_WORKSPACE_TOOL_STATUS_MAX_ENTRIES);
  const lines = ["\u{1F527} Tools"];
  if (totalCount > visibleEntries.length) {
    lines.push(`Showing latest ${visibleEntries.length} of ${totalCount}.`);
  }
  for (const entry of visibleEntries) {
    lines.push(
      `${formatTelegramWorkspaceToolStatusKind(entry.status)} ${getTelegramWorkspaceToolStatusTitle(entry)}`,
    );
  }
  return truncateTelegramWorkspaceStreamMarkdown(lines.join("\n"));
}

export function getLatestAssistantMessage(messages: unknown): unknown | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages.slice().reverse()) {
    if (isAssistantAgentMessage(message)) return message;
  }
  return undefined;
}

export function extractRpcAssistantText(event: RpcChildBackendEvent): string {
  if (event.type === "message_end") {
    return getAgentMessagePreviewText(event.message);
  }
  if (event.type !== "agent_end") return "";
  const latestAssistant = getLatestAssistantMessage(event.messages);
  return latestAssistant ? getAgentMessagePreviewText(latestAssistant) : "";
}

export function extractRpcAssistantError(event: RpcChildBackendEvent): string | undefined {
  if (event.type !== "agent_end") return undefined;
  const assistant = extractLatestAssistantMessageText(
    Array.isArray(event.messages) ? event.messages : [],
  );
  if (assistant.stopReason !== "error" && !assistant.errorMessage) {
    return undefined;
  }
  return (
    assistant.errorMessage ||
    "Telegram workspace failed while processing the request."
  );
}

export function formatTelegramWorkspaceThinkingMarkdown(text: string): string {
  return formatAgentThinkingBlock({ thinking: text });
}
