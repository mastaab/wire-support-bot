import type { WireEventsHandler } from "@wireapp/wire-apps-js-sdk";
import { WireAppSdk } from "@wireapp/wire-apps-js-sdk";
import type { Config } from "../../app/config";
import type { Logger } from "../../application/ports/Logger";
import { NO_METRICS, type MetricsPort } from "../../application/ports/MetricsPort";
import { makeSdkLoggerBridge } from "./SdkLoggerBridge";
import type { WireConnectionObserver } from "./WireConnectionWatchdog";

/**
 * Creates the Wire SDK instance with app-token authentication and verifies the
 * backend-reported application identity matches WIRE_SDK_APP_ID / WIRE_SDK_APP_DOMAIN.
 *
 * The SDK stores its SQLite database and CoreCrypto keystore under ./storage
 * relative to process.cwd(); this is not configurable through the public API.
 *
 * `sdkLogger` must let every severity through: the bridge applies WIRE_SUPPORT_BOT_SDK_LOG_LEVEL.
 * `metrics` counts the SDK's warnings and errors and follows the WebSocket connection through the
 * SDK's backend connection listener. `connection` (the watchdog) gets the same events: the SDK
 * accepts only one listener.
 */
export async function createWireClient(
  config: Config,
  handler: WireEventsHandler,
  sdkLogger: Logger,
  metrics: MetricsPort = NO_METRICS,
  connection?: WireConnectionObserver,
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

  listenForConnection(sdk, metrics, connection);
  return sdk;
}

/** Sets the SDK's one backend connection listener, which feeds the metrics and the optional observer. */
export function listenForConnection(
  sdk: Pick<WireAppSdk, "setBackendConnectionListener">,
  metrics: MetricsPort,
  connection?: WireConnectionObserver,
): void {
  sdk.setBackendConnectionListener({
    onConnected: () => {
      metrics.wireConnection("connected");
      connection?.onConnected();
    },
    onDisconnected: () => {
      metrics.wireConnection("disconnected");
      connection?.onDisconnected();
    },
  });
}
