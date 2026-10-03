import dotenv from "dotenv";
import type { WireAppSdk } from "@wireapp/wire-apps-js-sdk";
import { loadConfig, type Config } from "./config";
import { initLogging, getLogger } from "./logging";
import { createContainer } from "./container";
import { logSdkLogContentNotice } from "../infrastructure/wire/SdkLoggerBridge";
import { NO_METRICS, type MetricsPort } from "../application/ports/MetricsPort";
import { createPrometheusMetrics } from "../infrastructure/metrics/PrometheusMetrics";
import { startMetricsServer, type MetricsServer } from "../infrastructure/metrics/MetricsServer";
import { WireConnectionWatchdog } from "../infrastructure/wire/WireConnectionWatchdog";

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
  logger.info("Wire Support Bot starting", { logLevel, logFormat, sdkLogLevel, sdkLogContent, wireWatchdogMinutes: config.wire.watchdogMinutes });
  logSdkLogContentNotice(logger, { level: sdkLogLevel, content: sdkLogContent });

  // The metrics and health endpoint starts before Wire, so the liveness probe answers during start-up.
  let metrics: MetricsPort = NO_METRICS;
  let metricsServer: MetricsServer | undefined;
  if (config.metrics) {
    const prometheus = createPrometheusMetrics();
    try {
      metricsServer = await startMetricsServer({ ...config.metrics, source: prometheus, logger });
    } catch (error) {
      logger.error("Metrics server could not listen", {
        port: config.metrics.port, err: (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.name : "UnknownError"),
      });
      process.exit(1);
    }
    metrics = prometheus.metrics;
    logger.info("Metrics server listening", { host: config.metrics.host, port: metricsServer.port });
  }

  let sdk: WireAppSdk | null = null;
  // Restarts the SDK's WebSocket loop, which gives up after 10 failed reconnects, and exits with
  // code 1 when that does not help, so Docker Compose or Kubernetes starts the bot again.
  const watchdog = new WireConnectionWatchdog({
    minutes: config.wire.watchdogMinutes,
    restart: async () => { await sdk?.startListening(); },
    exit: () => void shutdown(1),
    logger,
    metrics,
  });
  const container = createContainer(config, logger, metrics, watchdog);

  /** `signal` is absent when the bot ends itself (the watchdog, with exit code 1). */
  const shutdown = async (exitCode: number, signal?: string): Promise<void> => {
    // Exit even if a cleanup step hangs, so Ctrl+C or a stop signal always ends the process.
    setTimeout(() => process.exit(exitCode), 5_000).unref();
    logger.info("Shutdown requested", signal ? { signal, exitCode } : { exitCode });
    watchdog.stop();
    await Promise.allSettled([container.shutdown(), metricsServer?.close()]);
    process.exit(exitCode);
  };

  process.on("SIGINT", () => void shutdown(0, "SIGINT"));
  process.on("SIGTERM", () => void shutdown(0, "SIGTERM"));
  process.on("unhandledRejection", () => {
    getLogger().error("Unhandled rejection");
  });

  try {
    sdk = await container.getWireClient();
    logger.info("Wire client connected, listening for events");
    // A failed first connect reports no event, so the watchdog counts from here.
    watchdog.start();
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
