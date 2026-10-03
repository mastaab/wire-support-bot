/**
 * The storage format of an embedding in `knowledge_chunks.embedding`: its float32 values in
 * little-endian byte order, 4 bytes each, whatever the host's byte order.
 */

const BYTES_PER_VALUE = 4;

export function encodeEmbedding(vector: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(vector.length * BYTES_PER_VALUE);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, i) => view.setFloat32(i * BYTES_PER_VALUE, value, true));
  return bytes;
}

/** Throws when the byte count does not match `dimension` values. */
export function decodeEmbedding(bytes: Uint8Array, dimension: number): Float32Array {
  if (bytes.byteLength !== dimension * BYTES_PER_VALUE) {
    throw new Error(`Stored embedding has ${bytes.byteLength} bytes, expected ${dimension * BYTES_PER_VALUE}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(dimension);
  for (let i = 0; i < dimension; i++) vector[i] = view.getFloat32(i * BYTES_PER_VALUE, true);
  return vector;
}
