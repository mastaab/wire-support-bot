import { describe, expect, it } from "vitest";
import { decodeEmbedding, encodeEmbedding } from "../../src/infrastructure/persistence/postgres/embeddingBytes";

describe("embedding bytes", () => {
  it("stores float32 values little-endian and reads them back", () => {
    const vector = Float32Array.from([1, -2.5, 0.1]);
    const bytes = encodeEmbedding(vector);
    expect(bytes.byteLength).toBe(12);
    expect([...bytes.slice(0, 4)]).toEqual([0x00, 0x00, 0x80, 0x3f]);
    expect(decodeEmbedding(bytes, 3)).toEqual(vector);
  });

  it("reads from a view at an offset, and rejects a length that does not match the dimension", () => {
    const backing = new Uint8Array(16);
    backing.set(encodeEmbedding(Float32Array.from([3, 4])), 4);
    expect([...decodeEmbedding(backing.subarray(4, 12), 2)]).toEqual([3, 4]);
    expect(() => decodeEmbedding(new Uint8Array(7), 2)).toThrow("Stored embedding has 7 bytes, expected 8");
  });
});
