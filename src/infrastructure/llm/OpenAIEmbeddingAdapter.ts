/**
 * EmbeddingPort on an OpenAI-compatible `/embeddings` endpoint (Ollama, vLLM, LiteLLM, a hosted
 * provider), which can differ from the chat endpoint. A list of texts is sent in requests of at
 * most `EMBED_BATCH_SIZE` texts. Each request has the timeout of the config and is recorded in the
 * metrics as a model call of slot `embed`, and a successful one with its input tokens from `usage`
 * (or that the usage was missing), once per request. Failures are thrown as `EmbeddingError` with the reason
 * and status only: no text is logged, and the provider's response body is never read into an error.
 */

import type { EmbeddingConfig } from "../../app/config";
import { EmbeddingError, type EmbeddingPort } from "../../application/ports/EmbeddingPort";
import { NO_METRICS, secondsSince, type MetricsPort, type ModelCallOutcome } from "../../application/ports/MetricsPort";
import { embeddingUsage, recordUsage } from "./tokenUsage";

/** Most texts per request; keeps a request well inside the usual provider limits. */
export const EMBED_BATCH_SIZE = 32;
/** Largest dimension accepted; anything bigger is treated as an invalid response. */
export const EMBED_MAX_DIMENSION = 16_384;

export class OpenAIEmbeddingAdapter implements EmbeddingPort {
  readonly model: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(
    private readonly config: EmbeddingConfig,
    private readonly metrics: MetricsPort = NO_METRICS,
  ) {
    this.model = config.model;
    this.url = `${config.baseUrl.replace(/\/+$/, "")}/embeddings`;
    this.headers = { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` };
  }

  async embed(text: string): Promise<Float32Array> {
    const [vector] = await this.request([text]);
    return vector!;
  }

  async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
      vectors.push(...await this.request(texts.slice(start, start + EMBED_BATCH_SIZE)));
      if (vectors[0]!.length !== vectors[vectors.length - 1]!.length) throw new EmbeddingError("invalid_response");
    }
    return vectors;
  }

  /** One request, recorded once in the metrics with its outcome and duration. */
  private async request(inputs: readonly string[]): Promise<Float32Array[]> {
    const started = performance.now();
    let outcome: ModelCallOutcome = "error";
    try {
      const vectors = await this.attempt(inputs);
      outcome = "ok";
      return vectors;
    } catch (err) {
      if (err instanceof EmbeddingError && err.failure === "timeout") outcome = "timeout";
      throw err;
    } finally {
      this.metrics.modelCall("embed", outcome, secondsSince(started));
    }
  }

  private async attempt(inputs: readonly string[]): Promise<Float32Array[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(this.url, {
          method: "POST", headers: this.headers, body: JSON.stringify({ model: this.model, input: inputs }), signal: controller.signal,
        });
      } catch (err) {
        throw new EmbeddingError(err instanceof Error && err.name === "AbortError" ? "timeout" : "unreachable");
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new EmbeddingError("http", res.status);
      }
      let data: unknown;
      try {
        data = await res.json();
      } catch (err) {
        throw new EmbeddingError(err instanceof Error && err.name === "AbortError" ? "timeout" : "invalid_response");
      }
      const vectors = parseVectors(data, inputs.length);
      recordUsage(this.metrics, "embed", this.model, embeddingUsage(data));
      return vectors;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The vectors of an OpenAI-style response (`data[].embedding`, ordered by `index` when given):
 * exactly `count` vectors of one dimension from 1 to `EMBED_MAX_DIMENSION`, all values finite.
 */
export function parseVectors(data: unknown, count: number): Float32Array[] {
  const items = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(items) || items.length !== count) throw new EmbeddingError("invalid_response");
  const ordered = items.every((item) => typeof (item as { index?: unknown })?.index === "number")
    ? [...items].sort((a, b) => (a as { index: number }).index - (b as { index: number }).index)
    : items;
  const vectors = ordered.map((item) => {
    const embedding = (item as { embedding?: unknown })?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0 || embedding.length > EMBED_MAX_DIMENSION
        || !embedding.every((v) => typeof v === "number" && Number.isFinite(v))) {
      throw new EmbeddingError("invalid_response");
    }
    return Float32Array.from(embedding as number[]);
  });
  if (vectors.some((v) => v.length !== vectors[0]!.length)) throw new EmbeddingError("invalid_response");
  return vectors;
}
