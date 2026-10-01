/**
 * A file posted in Wire, as the transport needs it to fetch the bytes later (asset ID, token,
 * domain and key material). Opaque to the application; never logged or stored.
 */
export interface InboundAssetRef {
  readonly transport: "wire";
  readonly data: unknown;
}

/** Downloads files posted in Wire. The bytes are decrypted by the transport and returned in memory only. */
export interface WireAssetPort {
  download(ref: InboundAssetRef): Promise<Uint8Array>;
}
