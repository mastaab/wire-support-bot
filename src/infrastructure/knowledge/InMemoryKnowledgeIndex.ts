/**
 * RetrievalPort on the document index, searched exactly in memory: every chunk embedded with the
 * configured model is loaded once, normalized, and compared with the question's embedding by
 * cosine similarity. This suits curated manuals and FAQs (thousands of chunks); the vector size is
 * whatever the model produces.
 *
 * The stored index is checked for changes (the counts and the latest ingest time) at most once per
 * `checkIntervalMs`, lazily on a question, and reloaded when it changed, so an ingestion run by
 * another process is picked up within a minute without a restart. A failed reload keeps the
 * loaded chunks. A failing embedding call throws, so the answer path logs it and answers without
 * knowledge. No question or chunk text is logged.
 */

import type { RetrievalPort, RetrievalQuery, RetrievalResult } from "../../application/ports/RetrievalPort";
import type { EmbeddingPort } from "../../application/ports/EmbeddingPort";
import { EmbeddingError } from "../../application/ports/EmbeddingPort";
import type { Logger } from "../../application/ports/Logger";
import { NO_METRICS, type MetricsPort } from "../../application/ports/MetricsPort";
import { chunkSource } from "../../application/services/knowledgeChunks";
import type { KnowledgeRepository, KnowledgeVersion, StoredKnowledgeChunk } from "../../domain/repositories/KnowledgeRepository";

export interface KnowledgeIndexOptions {
  /** Most results per question. */
  results: number;
  /** Lowest cosine similarity of a result, 0 to 1. */
  minScore: number;
  /** Shortest time between checks of the stored index for changes; default one minute. */
  checkIntervalMs?: number;
  now?: () => number;
}

/** What a load found, for the start-up line. */
export interface KnowledgeIndexStats {
  model: string;
  documents: number;
  chunks: number;
  /** Dimension of the loaded vectors; absent when nothing is loaded. */
  dimension?: number;
}

/** Thrown when the index cannot answer: never loaded, or the question's vector does not fit the stored ones. */
export class KnowledgeIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeIndexError";
  }
}

interface LoadedIndex {
  version: string;
  chunks: StoredKnowledgeChunk[];
  /** Normalized vectors, one row of `dimension` values per chunk. */
  matrix: Float32Array;
  dimension: number;
  documents: number;
}

const DEFAULT_CHECK_INTERVAL_MS = 60_000;

const versionKey = (v: KnowledgeVersion) => `${v.documents}:${v.chunks}:${v.latestIngestedAt?.getTime() ?? 0}`;

/** `vector` scaled to length 1 into `target` at `offset`; a zero vector stays zero. */
function normalizeInto(vector: Float32Array, target: Float32Array, offset: number): void {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!;
  const scale = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  for (let i = 0; i < vector.length; i++) target[offset + i] = vector[i]! * scale;
}

export class InMemoryKnowledgeIndex implements RetrievalPort {
  private index: LoadedIndex | null = null;
  private lastCheck = -Infinity;
  private pending: Promise<boolean> | null = null;
  private readonly checkIntervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly embeddings: EmbeddingPort,
    private readonly logger: Logger,
    private readonly options: KnowledgeIndexOptions,
    private readonly metrics: MetricsPort = NO_METRICS,
  ) {
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    metrics.collect("knowledge_chunks", () => this.index?.chunks.length ?? 0);
  }

  /** Loads the stored chunks now (or waits for a load under way); throws when the store cannot be read. */
  async load(): Promise<KnowledgeIndexStats> {
    await this.check(true);
    return this.stats();
  }

  stats(): KnowledgeIndexStats {
    const index = this.index;
    return {
      model: this.embeddings.model,
      documents: index?.documents ?? 0,
      chunks: index?.chunks.length ?? 0,
      ...(index && index.chunks.length > 0 ? { dimension: index.dimension } : {}),
    };
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievalResult[]> {
    try {
      const results = await this.search(query.question);
      this.metrics.knowledgeRetrieval(results.length > 0 ? "hit" : "miss");
      return results;
    } catch (err) {
      this.metrics.knowledgeRetrieval("error");
      this.logger.warn("Knowledge search failed", {
        err: err instanceof Error ? err.name : "UnknownError",
        ...(err instanceof EmbeddingError ? { failure: err.failure, ...(err.status !== undefined ? { status: err.status } : {}) } : {}),
      });
      throw err;
    }
  }

  private async search(question: string): Promise<RetrievalResult[]> {
    await this.refresh();
    const index = this.index;
    if (!index) throw new KnowledgeIndexError("The knowledge index could not be loaded");
    if (index.chunks.length === 0) return [];

    const raw = await this.embeddings.embed(question);
    if (raw.length !== index.dimension) {
      throw new KnowledgeIndexError(`The question's embedding has ${raw.length} dimensions, the index ${index.dimension}; run the ingestion again`);
    }
    const q = new Float32Array(raw.length);
    normalizeInto(raw, q, 0);

    const scored: Array<{ i: number; score: number }> = [];
    let best = -1;
    for (let i = 0; i < index.chunks.length; i++) {
      let dot = 0;
      const offset = i * index.dimension;
      for (let d = 0; d < index.dimension; d++) dot += q[d]! * index.matrix[offset + d]!;
      if (dot > best) best = dot;
      if (dot >= this.options.minScore) scored.push({ i, score: dot });
    }
    scored.sort((a, b) => b.score - a.score);
    const found = scored.slice(0, this.options.results);
    // Scores only, never text: tells why a question did or did not get document excerpts.
    this.logger.debug("Knowledge search", {
      bestScore: Math.round(best * 1000) / 1000,
      minScore: this.options.minScore,
      results: found.length,
    });
    return found.map(({ i }) => {
      const chunk = index.chunks[i]!;
      return {
        id: `${chunk.documentId}:${chunk.position}`,
        type: "knowledge_article" as const,
        content: chunk.content,
        source: chunkSource(chunk.title, chunk.headingPath),
        sourceDate: chunk.ingestedAt,
      };
    });
  }

  /** Checks for changes when due; a failure is logged and the loaded chunks stay. */
  private async refresh(): Promise<void> {
    const before = this.index;
    try {
      if (await this.check(false)) this.logger.info(before ? "Knowledge index reloaded" : "Knowledge index loaded", { ...this.stats() });
    } catch (err) {
      this.logger.warn("Knowledge index could not be read; keeping the loaded chunks", {
        err: err instanceof Error ? err.name : "UnknownError", loadedChunks: this.index?.chunks.length ?? 0,
      });
    }
  }

  /**
   * Reads the stored version when forced or when the interval has passed, and reloads on a change;
   * resolves to whether it reloaded. Concurrent callers share one check.
   */
  private check(force: boolean): Promise<boolean> {
    if (this.pending) return this.pending;
    if (!force && this.now() - this.lastCheck < this.checkIntervalMs) return Promise.resolve(false);
    this.lastCheck = this.now();
    this.pending = (async () => {
      const version = versionKey(await this.repository.version());
      if (this.index?.version === version) return false;
      await this.loadVersion(version);
      return true;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async loadVersion(version: string): Promise<void> {
    const { chunks, otherModelChunks } = await this.repository.loadChunks(this.embeddings.model);
    if (otherModelChunks > 0) {
      this.logger.warn("Knowledge chunks of another embedding model skipped; run the ingestion again with this model", {
        model: this.embeddings.model, skippedChunks: otherModelChunks,
      });
    }
    // One dimension per index: the most common one, in case a model changed its output size.
    const counts = new Map<number, number>();
    for (const chunk of chunks) counts.set(chunk.embedding.length, (counts.get(chunk.embedding.length) ?? 0) + 1);
    const dimension = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    const usable = chunks.filter((chunk) => chunk.embedding.length === dimension);
    if (usable.length < chunks.length) {
      this.logger.warn("Knowledge chunks of another dimension skipped; run the ingestion again", {
        model: this.embeddings.model, dimension, skippedChunks: chunks.length - usable.length,
      });
    }
    const matrix = new Float32Array(usable.length * dimension);
    usable.forEach((chunk, i) => normalizeInto(chunk.embedding, matrix, i * dimension));
    // The raw vectors are not needed after normalizing.
    const kept = usable.map((chunk) => ({ ...chunk, embedding: new Float32Array(0) }));
    this.index = { version, chunks: kept, matrix, dimension, documents: new Set(kept.map((c) => c.documentId)).size };
  }
}
