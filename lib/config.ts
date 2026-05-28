/**
 * Telegram bridge config and pairing helpers
 * Zones: telegram config, pairing, filesystem
 * Owns persisted bot/session pairing state, local config storage, authorization policy, and first-user pairing side effects
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { TelegramInboundHandlerConfig } from "./inbound-handlers.ts";
import type { CommandTemplateObjectConfig } from "./command-templates.ts";

export interface TelegramConcurrentTabTopicBindingConfig {
  enabled?: boolean;
  generalIsDefault?: boolean;
  autoCreate?: boolean;
  closeOnTopicClose?: boolean;
  deleteTopicOnClose?: boolean;
  trustedChatIds?: number[];
}

export interface TelegramNormalizedConcurrentTabTopicBindingConfig {
  enabled: boolean;
  generalIsDefault: boolean;
  autoCreate: boolean;
  closeOnTopicClose: boolean;
  deleteTopicOnClose: boolean;
  trustedChatIds: number[];
}

export interface TelegramConcurrentTabsConfig {
  enabled?: boolean;
  maxTabs?: number;
  inactiveNotify?: boolean;
  workerExtensions?: string[];
  topicBinding?: TelegramConcurrentTabTopicBindingConfig;
}

export interface TelegramNormalizedConcurrentTabsConfig
  extends Required<Omit<TelegramConcurrentTabsConfig, "topicBinding">> {
  topicBinding?: TelegramNormalizedConcurrentTabTopicBindingConfig;
}

export interface TelegramDebugConfig {
  enabled?: boolean;
  includeBodies?: boolean | "redacted" | "raw";
  maxBodyChars?: number;
}

export function getTelegramAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
}

function getConfigPath(): string {
  return join(getTelegramAgentDir(), "telegram.json");
}

export type TelegramOutboundCommandTemplateConfig =
  | string
  | CommandTemplateObjectConfig;
export interface TelegramOutboundHandlerConfig extends CommandTemplateObjectConfig {
  type?: string;
  match?: string | string[];
  pipe?: TelegramOutboundCommandTemplateConfig[];
  output?: string;
  timeout?: number;
}

export interface TelegramConfig {
  botToken?: string;
  botUsername?: string;
  botId?: number;
  allowedUserId?: number;
  lastUpdateId?: number;
  inboundHandlers?: TelegramInboundHandlerConfig[];
  attachmentHandlers?: TelegramInboundHandlerConfig[];
  outboundHandlers?: TelegramOutboundHandlerConfig[];
  proactivePush?: boolean;
  concurrentTabs?: TelegramConcurrentTabsConfig;
  debug?: TelegramDebugConfig;
}

export interface TelegramConfigStore {
  get: () => TelegramConfig;
  set: (config: TelegramConfig) => void;
  update: (mutate: (config: TelegramConfig) => void) => void;
  getBotToken: () => string | undefined;
  hasBotToken: () => boolean;
  getAllowedUserId: () => number | undefined;
  getInboundHandlers: () => TelegramInboundHandlerConfig[] | undefined;
  getAttachmentHandlers: () => TelegramInboundHandlerConfig[] | undefined;
  getOutboundHandlers: () => TelegramOutboundHandlerConfig[] | undefined;
  getConcurrentTabsConfig: () => TelegramNormalizedConcurrentTabsConfig;
  setAllowedUserId: (userId: number) => void;
  load: () => Promise<void>;
  persist: (config?: TelegramConfig) => Promise<void>;
}

export interface TelegramConfigStoreOptions {
  initialConfig?: TelegramConfig;
  agentDir?: string;
  configPath?: string;
}

const GLOBAL_TELEGRAM_CONFIG_STORE_KEY = "__piTelegramConfigStore__" as const;

type GlobalTelegramConfigStore = Pick<
  TelegramConfigStore,
  "get" | "set" | "persist" | "load"
>;

declare global {
  // eslint-disable-next-line no-var
  var __piTelegramConfigStore__: GlobalTelegramConfigStore | undefined;
}

export function setGlobalTelegramConfigStore(
  store: GlobalTelegramConfigStore,
): void {
  globalThis[GLOBAL_TELEGRAM_CONFIG_STORE_KEY] = store;
}

export function getGlobalTelegramConfig(): TelegramConfig | undefined {
  return globalThis[GLOBAL_TELEGRAM_CONFIG_STORE_KEY]?.get();
}

export async function updateGlobalTelegramConfig(
  mutate: (config: TelegramConfig) => void,
): Promise<boolean> {
  const store = globalThis[GLOBAL_TELEGRAM_CONFIG_STORE_KEY];
  if (!store) return false;
  const nextConfig = JSON.parse(JSON.stringify(store.get())) as TelegramConfig;
  mutate(nextConfig);
  store.set(nextConfig);
  await store.persist(nextConfig);
  return true;
}

export async function readTelegramConfig(
  configPath: string,
): Promise<TelegramConfig> {
  if (!existsSync(configPath)) return {};
  const content = await readFile(configPath, "utf8");
  return JSON.parse(content) as TelegramConfig;
}

export async function writeTelegramConfig(
  agentDir: string,
  configPath: string,
  config: TelegramConfig,
): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  const tempConfigPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempConfigPath, JSON.stringify(config, null, "\t") + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(tempConfigPath, 0o600);
  await rename(tempConfigPath, configPath);
  await chmod(configPath, 0o600);
}

export function createTelegramConfigStore(
  options: TelegramConfigStoreOptions = {},
): TelegramConfigStore {
  let config: TelegramConfig = options.initialConfig ?? {};
  const agentDir = options.agentDir ?? getTelegramAgentDir();
  const configPath = options.configPath ?? getConfigPath();
  return {
    get: () => config,
    set: (nextConfig) => {
      config = nextConfig;
    },
    update: (mutate) => {
      mutate(config);
    },
    getBotToken: () => config.botToken,
    hasBotToken: () => !!config.botToken,
    getAllowedUserId: () => config.allowedUserId,
    getInboundHandlers: () => [
      ...(config.inboundHandlers ?? []),
      ...(config.attachmentHandlers ?? []),
    ],
    getAttachmentHandlers: () => config.attachmentHandlers,
    getOutboundHandlers: () => config.outboundHandlers,
    getConcurrentTabsConfig: () => normalizeTelegramConcurrentTabsConfig(
      config.concurrentTabs,
    ),
    setAllowedUserId: (userId) => {
      config.allowedUserId = userId;
    },
    load: async () => {
      config = await readTelegramConfig(configPath);
    },
    persist: async (nextConfig = config) => {
      await writeTelegramConfig(agentDir, configPath, nextConfig);
    },
  };
}

export function normalizeTelegramTrustedChatIds(
  trustedChatIds: unknown,
): number[] {
  if (!Array.isArray(trustedChatIds)) return [];
  return [...new Set(
    trustedChatIds.filter(
      (chatId): chatId is number => Number.isSafeInteger(chatId),
    ),
  )];
}

export function isTelegramTrustedChat(
  trustedChatIds: readonly number[] | undefined,
  chatId: unknown,
): boolean {
  if (!trustedChatIds || trustedChatIds.length === 0) return true;
  return typeof chatId === "number" && trustedChatIds.includes(chatId);
}

export function normalizeTelegramConcurrentTabTopicBindingConfig(
  config?: TelegramConcurrentTabTopicBindingConfig,
): TelegramNormalizedConcurrentTabTopicBindingConfig {
  return {
    enabled: config?.enabled ?? false,
    generalIsDefault: config?.generalIsDefault ?? true,
    autoCreate: config?.autoCreate ?? true,
    closeOnTopicClose: config?.closeOnTopicClose ?? true,
    deleteTopicOnClose: config?.deleteTopicOnClose ?? false,
    trustedChatIds: normalizeTelegramTrustedChatIds(config?.trustedChatIds),
  };
}

export function normalizeTelegramConcurrentTabsConfig(
  config?: TelegramConcurrentTabsConfig,
): TelegramNormalizedConcurrentTabsConfig {
  const maxTabs =
    typeof config?.maxTabs === "number" &&
    Number.isInteger(config.maxTabs) &&
    config.maxTabs > 0
      ? config.maxTabs
      : 10;
  return {
    enabled: config?.enabled ?? false,
    maxTabs,
    inactiveNotify: config?.inactiveNotify ?? true,
    workerExtensions: Array.isArray(config?.workerExtensions)
      ? config.workerExtensions.filter(
          (path): path is string => typeof path === "string" && path.length > 0,
        )
      : [],
    topicBinding: normalizeTelegramConcurrentTabTopicBindingConfig(
      config?.topicBinding,
    ),
  };
}

export function createTelegramConcurrentTabsConfigGetter(
  configStore: Pick<TelegramConfigStore, "getConcurrentTabsConfig">,
): () => TelegramNormalizedConcurrentTabsConfig {
  return () => configStore.getConcurrentTabsConfig();
}

export function createTelegramDebugConfigGetter(
  configStore: Pick<TelegramConfigStore, "get">,
): () => TelegramDebugConfig | undefined {
  return () => configStore.get().debug;
}

export function createTelegramProactivePushChecker(
  configStore: Pick<TelegramConfigStore, "get">,
): () => boolean {
  return () => configStore.get().proactivePush ?? false;
}

export function createTelegramProactivePushSetter(
  configStore: Pick<TelegramConfigStore, "get" | "set" | "persist">,
): (enabled: boolean) => Promise<void> {
  return async (enabled) => {
    const config = { ...configStore.get(), proactivePush: enabled };
    configStore.set(config);
    await configStore.persist(config);
  };
}

export function createTelegramProactivePushChatIdGetter(deps: {
  getActiveTurnChatId: () => number | undefined;
  getAllowedUserId: () => number | undefined;
}): () => number | undefined {
  return () => deps.getActiveTurnChatId() ?? deps.getAllowedUserId();
}

export type TelegramAuthorizationState =
  | { kind: "pair"; userId: number }
  | { kind: "allow" }
  | { kind: "deny" };

export interface TelegramUserPairingDeps<TContext> {
  allowedUserId?: number;
  ctx: TContext;
  setAllowedUserId: (userId: number) => void;
  persistConfig: () => Promise<void>;
  updateStatus: (ctx: TContext) => void;
}

export interface TelegramUserPairingRuntimeDeps<TContext> {
  getAllowedUserId: () => number | undefined;
  setAllowedUserId: (userId: number) => void;
  persistConfig: () => Promise<void>;
  updateStatus: (ctx: TContext) => void;
}

export interface TelegramUserPairingRuntime<TContext> {
  pairIfNeeded: (userId: number, ctx: TContext) => Promise<boolean>;
}

export function getTelegramAuthorizationState(
  userId: number,
  allowedUserId?: number,
): TelegramAuthorizationState {
  if (allowedUserId === undefined) {
    return { kind: "pair", userId };
  }
  if (userId === allowedUserId) {
    return { kind: "allow" };
  }
  return { kind: "deny" };
}

function isTelegramStaleContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("stale after session") ||
      error.message.includes("stale ctx"))
  );
}

export async function pairTelegramUserIfNeeded<TContext>(
  userId: number,
  deps: TelegramUserPairingDeps<TContext>,
): Promise<boolean> {
  const authorization = getTelegramAuthorizationState(
    userId,
    deps.allowedUserId,
  );
  if (authorization.kind !== "pair") return false;
  deps.setAllowedUserId(authorization.userId);
  await deps.persistConfig();
  try {
    deps.updateStatus(deps.ctx);
  } catch (error) {
    if (!isTelegramStaleContextError(error)) throw error;
  }
  return true;
}

export function createTelegramUserPairingRuntime<TContext>(
  deps: TelegramUserPairingRuntimeDeps<TContext>,
): TelegramUserPairingRuntime<TContext> {
  return {
    pairIfNeeded: (userId, ctx) =>
      pairTelegramUserIfNeeded(userId, {
        allowedUserId: deps.getAllowedUserId(),
        ctx,
        setAllowedUserId: deps.setAllowedUserId,
        persistConfig: deps.persistConfig,
        updateStatus: deps.updateStatus,
      }),
  };
}
