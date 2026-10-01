import { describe, it, expect, vi } from "vitest";
import { createWireAssetAdapter } from "../../src/infrastructure/wire/WireAssetAdapter";

const remoteData = { otrKey: new Uint8Array([1]), sha256: new Uint8Array([2]), assetId: "asset-1", assetDomain: "example.com" };

describe("WireAssetAdapter contract", () => {
  it("downloads a Wire file through the SDK and returns the bytes", async () => {
    const downloadAsset = vi.fn().mockResolvedValue(new Uint8Array([7, 8, 9]));
    const adapter = createWireAssetAdapter({ current: { manager: { downloadAsset } as never } });
    expect(await adapter.download({ transport: "wire", data: remoteData })).toEqual(new Uint8Array([7, 8, 9]));
    expect(downloadAsset).toHaveBeenCalledWith(remoteData);
  });

  it("gives up on a download that hangs", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createWireAssetAdapter({ current: { manager: { downloadAsset: () => new Promise(() => {}) } as never } }, 1000);
      const pending = adapter.download({ transport: "wire", data: remoteData });
      const failed = expect(pending).rejects.toThrow("Download timed out");
      await vi.advanceTimersByTimeAsync(1000);
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails plainly without a connection or with a reference from elsewhere", async () => {
    await expect(createWireAssetAdapter({ current: null }).download({ transport: "wire", data: remoteData })).rejects.toThrow("Wire is not connected");
    const adapter = createWireAssetAdapter({ current: { manager: { downloadAsset: vi.fn() } as never } });
    await expect(adapter.download({ transport: "other" as never, data: remoteData })).rejects.toThrow("Not a Wire file reference");
  });
});
