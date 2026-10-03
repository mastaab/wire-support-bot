import type { WireEventsHandler } from "@wireapp/wire-apps-js-sdk";
import { WireAppSdk } from "@wireapp/wire-apps-js-sdk";
import type { Config } from "../../app/config";
import type { Logger } from "../../application/ports/Logger";
import { NO_METRICS, type MetricsPort } from "../../application/ports/MetricsPort";
import { makeSdkLoggerBridge } from "./SdkLoggerBridge";

/**
 * Creates the Wire SDK instance with app-token authentication and verifies the
 * backend-reported application identity matches WIRE_SDK_APP_ID / WIRE_SDK_APP_DOMAIN.
 *
 * The SDK stores its SQLite database and CoreCrypto keystore under ./storage
 * relative to process.cwd(); this is not configurable through the public API.
 *
 * `sdkLogger` must let every severity through: the bridge applies WIRE_SUPPORT_BOT_SDK_LOG_LEVEL.
 * `metrics` counts the SDK's warnings and errors and follows the WebSocket connection through the
 * SDK's backend connection listener.
 */
export async function createWireClient(
  config: Config,
  handler: WireEventsHandler,
  sdkLogger: Logger,
  metrics: MetricsPort = NO_METRICS,
): Promise<WireAppSdk> {
  const sdk = await WireAppSdk.create(
    config.wire.apiToken,
    config.wire.apiHost,
    config.wire.cryptoKey,
    handler,
    makeSdkLoggerBridge(sdkLogger, { level: config.app.sdkLogLevel, content: config.app.sdkLogContent, metrics }),
  );

  const actual = sdk.getApplicationManager().getApplicationQualifiedId();
  if (actual.id !== config.wire.appId || actual.domain !== config.wire.appDomain) {
    await sdk.close().catch(() => undefined);
    throw new Error(
      "WIRE_SDK_APP_ID / WIRE_SDK_APP_DOMAIN do not match the application identity the backend returned for WIRE_SDK_API_TOKEN",
    );
  }

  sdk.setBackendConnectionListener({
    onConnected: () => metrics.wireConnection("connected"),
    onDisconnected: () => metrics.wireConnection("disconnected"),
  });
  return sdk;
}
