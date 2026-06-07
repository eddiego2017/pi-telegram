/**
 * Pi RPC child process backend
 * Zones: pi agent, concurrent workspaces, process lifecycle
 * Owns JSONL RPC child supervision, command response correlation, and child event extraction helpers
 */

import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface RpcChildSessionState {
  model?: unknown;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  pendingMessageCount?: number;
}

export interface RpcChildBackendOptions {
  workspaceName: string;
  cwd: string;
  sessionDir?: string;
  sessionFile?: string;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  spawnProcess?: typeof spawn;
}

export interface RpcChildBackendEvent {
  type?: string;
  [key: string]: unknown;
}

export interface RpcChildResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export type RpcChildEventListener = (event: RpcChildBackendEvent) => void;

type PendingRpcRequest = {
  resolve: (response: RpcChildResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RPC_COMPACT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_RPC_DISPOSE_ABORT_GRACE_MS = 1_000;

export function createJsonlLineSplitter(
  onLine: (line: string) => void,
): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  return (chunk) => {
    buffered += typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (;;) {
      const newlineIndex = buffered.indexOf("\n");
      if (newlineIndex === -1) return;
      let line = buffered.slice(0, newlineIndex);
      buffered = buffered.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  };
}

function isRpcChildResponse(value: unknown): value is RpcChildResponse {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  return raw.type === "response" && typeof raw.command === "string";
}

function appendRingBuffer(current: string, next: string, limit: number): string {
  const combined = `${current}${next}`;
  if (combined.length <= limit) return combined;
  return combined.slice(combined.length - limit);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildRpcChildArgs(options: {
  sessionDir?: string;
  sessionFile?: string;
  extraArgs?: string[];
}): string[] {
  const args = ["--mode", "rpc", "--no-extensions"];
  if (options.sessionFile) {
    args.push("--session", options.sessionFile);
  } else if (options.sessionDir) {
    args.push("--session-dir", options.sessionDir);
  }
  args.push(...(options.extraArgs ?? []));
  return args;
}

export class RpcChildBackend {
  readonly kind = "rpc-child" as const;
  readonly workspaceName: string;

  private options: RpcChildBackendOptions;
  private process?: ChildProcessWithoutNullStreams;
  private listeners = new Set<RpcChildEventListener>();
  private pendingRequests = new Map<string, PendingRpcRequest>();
  private nextRequestId = 0;
  private stderr = "";
  private disposed = false;
  private lastState: RpcChildSessionState | undefined;

  constructor(options: RpcChildBackendOptions) {
    this.options = options;
    this.workspaceName = options.workspaceName;
  }

  async start(): Promise<RpcChildSessionState> {
    if (this.process) return this.getState();
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const args = buildRpcChildArgs({
      sessionDir: this.options.sessionDir,
      sessionFile: this.options.sessionFile,
      extraArgs: this.options.args,
    });
    const spawnOptions: SpawnOptionsWithoutStdio = {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.env,
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEGRAM_CHILD: "1",
        PI_TELEGRAM_WORKSPACE: this.workspaceName,
        PI_TELEGRAM_PARENT_PID: String(process.pid),
      },
      stdio: "pipe",
    };
    this.disposed = false;
    this.process = spawnProcess(this.options.command ?? "pi", args, spawnOptions);
    this.process.stdout.on("data", createJsonlLineSplitter((line) => {
      this.handleLine(line);
    }));
    this.process.stderr.on("data", (data) => {
      this.stderr = appendRingBuffer(this.stderr, data.toString(), 20_000);
    });
    this.process.once("error", (error) => {
      this.rejectPending(new Error(`RPC child error: ${getErrorMessage(error)}`));
      this.emit({ type: "error", error: getErrorMessage(error) });
    });
    this.process.once("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.rejectPending(new Error(`RPC child exited with ${reason}`));
      this.emit({ type: "exit", code, signal });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (this.process.exitCode !== null) {
      throw new Error(
        `RPC child exited immediately with code ${this.process.exitCode}: ${this.stderr}`,
      );
    }
    const state = await this.getState();
    this.lastState = state;
    return state;
  }

  async dispose(): Promise<void> {
    const child = this.process;
    if (!child) {
      this.disposed = true;
      return;
    }
    if (child.exitCode === null) {
      await Promise.race([
        this.abort().catch(() => undefined),
        new Promise<void>((resolve) =>
          setTimeout(resolve, DEFAULT_RPC_DISPOSE_ABORT_GRACE_MS),
        ),
      ]);
      this.disposed = true;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } else {
      this.disposed = true;
    }
    this.process = undefined;
    this.rejectPending(new Error("RPC child disposed"));
  }

  onEvent(listener: RpcChildEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStderr(): string {
    return this.stderr;
  }

  getCachedState(): RpcChildSessionState | undefined {
    return this.lastState;
  }

  async prompt(message: string): Promise<void> {
    const state = this.lastState;
    const command =
      state?.isStreaming === true
        ? { type: "prompt" as const, message, streamingBehavior: "followUp" as const }
        : { type: "prompt" as const, message };
    await this.send(command);
  }

  async steer(message: string): Promise<void> {
    await this.send({ type: "steer", message });
  }

  async followUp(message: string): Promise<void> {
    await this.send({
      type: "prompt",
      message,
      streamingBehavior: "followUp",
    });
  }

  async abort(): Promise<void> {
    if (!this.process || this.process.exitCode !== null || this.disposed) return;
    await this.send({ type: "abort" });
  }

  async compact(): Promise<void> {
    await this.send(
      { type: "compact" },
      this.options.requestTimeoutMs ?? DEFAULT_RPC_COMPACT_TIMEOUT_MS,
    );
  }

  async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
    const response = await this.send({ type: "new_session", parentSession });
    return getRpcResponseData<{ cancelled: boolean }>(response);
  }

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    const response = await this.send({ type: "switch_session", sessionPath });
    const result = getRpcResponseData<{ cancelled: boolean }>(response);
    if (!result.cancelled) {
      this.options.sessionFile = sessionPath;
      if (this.lastState) this.lastState.sessionFile = sessionPath;
    }
    return result;
  }

  async getState(): Promise<RpcChildSessionState> {
    const response = await this.send({ type: "get_state" });
    this.lastState = getRpcResponseData<RpcChildSessionState>(response);
    return this.lastState;
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.send({ type: "set_model", provider, modelId });
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.send({ type: "set_thinking_level", level });
  }

  async setSessionName(name: string): Promise<void> {
    await this.send({ type: "set_session_name", name });
  }

  private emit(event: RpcChildBackendEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (isRpcChildResponse(parsed) && parsed.id) {
      const pending = this.pendingRequests.get(parsed.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(parsed.id);
        pending.resolve(parsed);
        return;
      }
    }
    this.emit(parsed as RpcChildBackendEvent);
  }

  private async send(
    command: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS,
  ): Promise<RpcChildResponse> {
    if (!this.process?.stdin || this.process.exitCode !== null) {
      throw new Error("RPC child is not running");
    }
    const id = `tg_${this.workspaceName}_${++this.nextRequestId}`;
    const payload = `${JSON.stringify({ ...command, id })}\n`;
    return new Promise<RpcChildResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `Timeout waiting for RPC response to ${String(command.type)}. ${this.stderr}`,
          ),
        );
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.process?.stdin.write(payload, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error);
      });
    }).then((response: RpcChildResponse) => {
      if (!response.success) {
        throw new Error(response.error ?? `RPC ${response.command} failed`);
      }
      return response;
    });
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }
}

export function getRpcResponseData<T>(response: RpcChildResponse): T {
  return response.data as T;
}

export function extractRpcTextDelta(event: RpcChildBackendEvent): string {
  if (event.type !== "message_update") return "";
  const assistantMessageEvent = event.assistantMessageEvent;
  if (
    typeof assistantMessageEvent === "object" &&
    assistantMessageEvent !== null &&
    (assistantMessageEvent as { type?: unknown }).type === "text_delta"
  ) {
    const delta = (assistantMessageEvent as { delta?: unknown }).delta;
    return typeof delta === "string" ? delta : "";
  }
  return "";
}

function extractTextBlocksFromMessage(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const raw = block as { type?: unknown; text?: unknown };
      return raw.type === "text" && typeof raw.text === "string" ? raw.text : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function extractRpcAssistantText(event: RpcChildBackendEvent): string {
  if (event.type === "message_end") {
    return extractTextBlocksFromMessage(event.message);
  }
  if (event.type !== "agent_end") return "";
  const messages = event.messages;
  if (!Array.isArray(messages)) return "";
  for (const message of messages.slice().reverse()) {
    const role =
      typeof message === "object" && message !== null
        ? (message as { role?: unknown }).role
        : undefined;
    if (role === "assistant") {
      return extractTextBlocksFromMessage(message);
    }
  }
  return "";
}
