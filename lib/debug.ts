/**
 * Structured debug logging for Loki/stdout observability.
 * Zones: telegram diagnostics, shared utils
 * Emits redacted JSON lines for turn, API, queue, and worker timelines without coupling to Loki APIs.
 */

export type TelegramDebugIncludeBodies = boolean | "redacted" | "raw";

export interface TelegramDebugConfig {
  enabled?: boolean;
  includeBodies?: TelegramDebugIncludeBodies;
  maxBodyChars?: number;
}

export interface TelegramDebugLogger {
  enabled: () => boolean;
  includeBodies: () => boolean;
  log: (
    event: string,
    details?: Record<string, unknown>,
    body?: unknown,
  ) => void;
}

export interface TelegramDebugLoggerDeps {
  getConfig?: () => TelegramDebugConfig | undefined;
  getBotToken?: () => string | undefined;
  now?: () => number;
  sink?: (line: string) => void;
  env?: Record<string, string | undefined>;
}

export interface TelegramRuntimeEventRecorderDeps {
  runtimeRecorder: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  debugLogger: TelegramDebugLogger;
}

const DEFAULT_MAX_BODY_CHARS = 20_000;
const MAX_REDACTION_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const SECRET_KEY_PATTERN = /^(?:authorization|cookie|set-cookie|password|secret|api[_-]?key|token|bot[_-]?token|access[_-]?token|refresh[_-]?token|thinking|thinking[_-]?signature|reasoning|reasoning[_-]?signature|encrypted[_-]?content)$/i;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;
const TELEGRAM_BOT_TOKEN_PATTERN = /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g;

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseIncludeBodies(
  env: Record<string, string | undefined>,
  config: TelegramDebugConfig | undefined,
): TelegramDebugIncludeBodies | undefined {
  if (parseBoolean(env.PI_TELEGRAM_DEBUG_BODY_RAW)) return "raw";
  const envValue = env.PI_TELEGRAM_DEBUG_BODIES;
  if (envValue !== undefined) {
    const normalized = envValue.trim().toLowerCase();
    if (normalized === "raw") return "raw";
    if (normalized === "redacted") return "redacted";
    return parseBoolean(envValue) ?? undefined;
  }
  return config?.includeBodies ?? "redacted";
}

function parseMaxBodyChars(
  env: Record<string, string | undefined>,
  config: TelegramDebugConfig | undefined,
): number {
  const raw = env.PI_TELEGRAM_DEBUG_MAX_BODY_CHARS;
  const parsed = raw === undefined ? undefined : Number.parseInt(raw, 10);
  const configured = Number.isFinite(parsed) ? parsed : config?.maxBodyChars;
  return typeof configured === "number" && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MAX_BODY_CHARS;
}

function isDebugEnabled(
  env: Record<string, string | undefined>,
  config: TelegramDebugConfig | undefined,
): boolean {
  return parseBoolean(env.PI_TELEGRAM_DEBUG) ?? config?.enabled ?? true;
}

function redactString(value: string, botToken: string | undefined): string {
  let next = value;
  if (botToken) next = next.split(botToken).join("<redacted-token>");
  next = next.replace(BEARER_PATTERN, "Bearer <redacted>");
  next = next.replace(TELEGRAM_BOT_TOKEN_PATTERN, "<redacted-telegram-token>");
  return next;
}

function redactValue(
  value: unknown,
  options: { botToken?: string; rawBodies: boolean; depth?: number; key?: string },
): unknown {
  const depth = options.depth ?? 0;
  if (options.key && SECRET_KEY_PATTERN.test(options.key)) {
    return "<redacted>";
  }
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return options.rawBodies ? redactString(value, options.botToken) : redactString(value, options.botToken);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "<function>";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message, options.botToken),
      stack: value.stack ? redactString(value.stack, options.botToken) : undefined,
    };
  }
  if (depth >= MAX_REDACTION_DEPTH) return "<max-depth>";
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactValue(item, { ...options, depth: depth + 1 }));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`<truncated ${value.length - MAX_ARRAY_ITEMS} items>`);
    return items;
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactValue(child, {
        ...options,
        key,
        depth: depth + 1,
      });
    }
    return output;
  }
  return String(value);
}

function stringifyWithLimit(value: unknown, maxChars: number): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    text = JSON.stringify({ unserializable: error instanceof Error ? error.message : String(error) });
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…<truncated ${text.length - maxChars} chars>`;
}

export function createTelegramRuntimeEventRecorder(
  deps: TelegramRuntimeEventRecorderDeps,
): (
  category: string,
  error: unknown,
  details?: Record<string, unknown>,
) => void {
  return (category, error, details) => {
    deps.runtimeRecorder(category, error, details);
    deps.debugLogger.log(
      "telegram.runtime.event",
      {
        category,
        message: error instanceof Error ? error.message : String(error),
        ...details,
      },
      error,
    );
  };
}

export function createTelegramDebugLogger(
  deps: TelegramDebugLoggerDeps = {},
): TelegramDebugLogger {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const sink = deps.sink ?? ((line: string) => console.log(line));
  const getConfig = deps.getConfig ?? (() => undefined);
  const getBotToken = deps.getBotToken ?? (() => undefined);
  const getIncludeBodies = (): TelegramDebugIncludeBodies | undefined =>
    parseIncludeBodies(env, getConfig());
  return {
    enabled: () => isDebugEnabled(env, getConfig()),
    includeBodies: () => !!getIncludeBodies(),
    log: (event, details = {}, body) => {
      const config = getConfig();
      if (!isDebugEnabled(env, config)) return;
      const includeBodies = parseIncludeBodies(env, config);
      const botToken = getBotToken();
      const rawBodies = includeBodies === "raw";
      const redactedDetails = redactValue(details, {
        botToken,
        rawBodies,
      }) as Record<string, unknown>;
      const payload: Record<string, unknown> = {
        ts: new Date(now()).toISOString(),
        level: "debug",
        component: "pi-telegram",
        event,
        pid: process.pid,
        ...redactedDetails,
      };
      if (body !== undefined && includeBodies) {
        payload.body = redactValue(body, { botToken, rawBodies });
      }
      sink(stringifyWithLimit(payload, parseMaxBodyChars(env, config)));
    },
  };
}
