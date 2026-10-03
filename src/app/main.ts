import dotenv from "dotenv";
import { loadConfig, type Config } from "./config";
import { initLogging, getLogger } from "./logging";
import { createContainer } from "./container";
import { logSdkLogContentNotice } from "../infrastructure/wire/SdkLoggerBridge";

dotenv.config();

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    // Configuration messages name the setting, never a secret value.
    getLogger().error("Invalid configuration", { reason: error instanceof Error ? error.message : undefined });
    process.exit(1);
  }
  // Log lines go to stdout: collectors such as GKE's Cloud Logging class every stderr line as an
  // error unless it is parsed. Anything logged before this point (a configuration error) goes to stderr.
  const logger = initLogging(config.app.logLevel, { format: config.app.logFormat, stream: "stdout" });
  const { logLevel, logFormat, sdkLogLevel, sdkLogContent } = config.app;
  logger.info("Wire Support Bot starting", { logLevel, logFormat, sdkLogLevel, sdkLogContent });
  logSdkLogContentNotice(logger, { level: sdkLogLevel, content: sdkLogContent });

  const container = createContainer(config, logger);
  let sdk: Awaited<ReturnType<typeof container.getWireClient>> | null = null;

  const shutdown = async (signal: string): Promise<void> => {
    // Exit even if a cleanup step hangs, so Ctrl+C or a stop signal always ends the process.
    setTimeout(() => process.exit(0), 5_000).unref();
    logger.info("Shutdown requested", { signal });
    await container.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", () => {
    getLogger().error("Unhandled rejection");
  });

  try {
    sdk = await container.getWireClient();
    logger.info("Wire client connected, listening for events");
    await sdk.startListening();
  } catch {
    getLogger().error("Failed to start; verify configuration and service availability");
    process.exit(1);
  }
}

void main().catch(() => {
  getLogger().error("Startup failed; verify configuration and service availability");
  process.exit(1);
});
