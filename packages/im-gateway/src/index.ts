export { ImGateway } from "./gateway.js";
export { GatewayStore } from "./store.js";
export { SparkwrightBridge } from "./sparkwright-bridge.js";
export { TelegramAdapter } from "./adapters/telegram.js";
export {
  defaultConfigPath,
  defaultDataDir,
  legacyConfigPath,
  legacyDataDir,
  loadConfig,
  migrateLegacyPaths,
  resolveConfigPathForRead,
  writeConfig,
  type ImGatewayConfig,
  type ImGatewayMigrationOptions,
  type ImGatewayMigrationResult,
  type TelegramGatewayConfig,
} from "./config.js";
export {
  buildSessionKey,
  type SessionRoutingOptions,
} from "./session-router.js";
export type {
  ApprovalPrompt,
  GatewayLogger,
  InboundMessage,
  OutboundMessage,
  OutboundTarget,
  PlatformAdapter,
  PlatformHandlers,
} from "./types.js";
