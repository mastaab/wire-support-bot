/**
 * Port for text embeddings, used by the document index: the ingestion embeds the excerpts of the
 * documents, the retrieval embeds the member's question. Both must use the same model, so every
 * vector is stored with the model's name.
 */
export interface EmbeddingPort {
  /** The embedding model's name, stored with every vector it made. */
  readonly model: string;
  /** One text as a vector. Throws an `EmbeddingError` when the endpoint fails. */
  embed(text: string): Promise<Float32Array>;
  /**
   * Several texts as vectors, in their order and all of one dimension. The adapter splits a long
   * list into requests of a bounded size. Throws an `EmbeddingError` when any request fails.
   */
  embedBatch(texts: readonly string[]): Promise<Float32Array[]>;
}

/**
 * Why an embedding call failed: `timeout`, `unreachable` (no response, such as a refused
 * connection), `http` (a status other than 2xx, in `status`), `invalid_response` (not the expected
 * number of finite vectors of one dimension).
 */
export type EmbeddingFailure = "timeout" | "unreachable" | "http" | "invalid_response";

/** A failed embedding call. The message holds the failure and the status, never a text or a response body. */
export class EmbeddingError extends Error {
  constructor(public readonly failure: EmbeddingFailure, public readonly status?: number) {
    super(`Embedding request failed: ${failure}${status !== undefined ? ` (HTTP ${status})` : ""}`);
    this.name = "EmbeddingError";
  }
}
