import type { AssetMessage } from "@wireapp/wire-apps-js-sdk";
import type { InboundAssetRef, WireAssetPort } from "../../application/ports/WireAssetPort";
import type { HandlerManagerRef } from "./WireOutboundAdapter";

/** The SDK exports the download data only as part of an asset message. */
type AssetRemoteData = NonNullable<AssetMessage["remoteData"]>;

/** The manager call the asset adapter needs; kept narrow so tests need no SDK. */
export interface AssetManagerHandle {
  downloadAsset(remoteData: AssetRemoteData): Promise<Uint8Array>;
}

/** Wire has no connection yet, or the reference did not come from Wire. */
export class AssetDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetDownloadError";
  }
}

/**
 * Downloads and decrypts files posted in Wire through the SDK. The bytes are returned in memory
 * and never logged or stored here.
 */
/**
 * How long a download may take. The SDK has no timeout of its own, and a confirmed attach runs in
 * the channel's message order, so a hung download would hold every later message.
 */
export const ASSET_DOWNLOAD_TIMEOUT_MS = 30_000;

export function createWireAssetAdapter(handlerRef: HandlerManagerRef, timeoutMs = ASSET_DOWNLOAD_TIMEOUT_MS): WireAssetPort {
  return {
    async download(ref: InboundAssetRef): Promise<Uint8Array> {
      const manager = handlerRef.current?.manager as Partial<AssetManagerHandle> | undefined;
      if (ref.transport !== "wire" || !ref.data) throw new AssetDownloadError("Not a Wire file reference");
      if (!manager?.downloadAsset) throw new AssetDownloadError("Wire is not connected");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AssetDownloadError("Download timed out")), timeoutMs);
      });
      try {
        return await Promise.race([manager.downloadAsset(ref.data as AssetRemoteData), timedOut]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
