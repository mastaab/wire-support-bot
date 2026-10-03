/**
 * The document index for first-level help, built for the bot and the CLI when
 * WIRE_SUPPORT_BOT_KNOWLEDGE is on. With it off nothing here runs and no embedding call is made.
 */

import type { KnowledgeConfig } from "./config";
import type { Logger } from "./logging";
import type { RetrievalPort } from "../application/ports/RetrievalPort";
import { EmbeddingError, type EmbeddingPort } from "../application/ports/EmbeddingPort";
import { NO_METRICS, type MetricsPort } from "../application/ports/MetricsPort";
import { OpenAIEmbeddingAdapter } from "../infrastructure/llm/OpenAIEmbeddingAdapter";
import { InMemoryKnowledgeIndex, type KnowledgeIndexStats } from "../infrastructure/knowledge/InMemoryKnowledgeIndex";
import { PrismaKnowledgeRepository } from "../infrastructure/persistence/postgres/PrismaKnowledgeRepository";

/** A short neutral text embedded at start-up to check the endpoint and the model's dimension. */
const PROBE_TEXT = "Knowledge index start-up check";

/**
 * The retrieval source for `AnswerQuestion`, or undefined when knowledge is off. The index loads
 * in the background (see `startKnowledgeIndex`); a question before it is loaded waits for the load.
 */
export function createKnowledgeRetrieval(config: KnowledgeConfig, logger: Logger, metrics: MetricsPort = NO_METRICS): RetrievalPort | undefined {
  if (!config.enabled) return undefined;
  const embeddings = new OpenAIEmbeddingAdapter(config.embedding, metrics);
  const index = new InMemoryKnowledgeIndex(
    new PrismaKnowledgeRepository(), embeddings, logger, { results: config.results, minScore: config.minScore }, metrics,
  );
  void startKnowledgeIndex(index, embeddings, logger);
  return index;
}

/**
 * Loads the index and checks the embedding endpoint once. Logs one info line with the model, the
 * documents, the chunks and the dimension; a store that cannot be read, an empty index, an
 * unreachable endpoint or a dimension that does not match the stored vectors is logged as a
 * warning, and the bot keeps running (answers then come without knowledge). Never throws.
 */
export async function startKnowledgeIndex(
  index: Pick<InMemoryKnowledgeIndex, "load">, embeddings: EmbeddingPort, logger: Logger,
): Promise<void> {
  let stats: KnowledgeIndexStats | undefined;
  try {
    stats = await index.load();
    logger.info("Knowledge index loaded", { ...stats });
    if (stats.chunks === 0) logger.warn("Knowledge index is empty; ingest documents with npm run knowledge:ingest -- <directory>", { model: stats.model });
  } catch (err) {
    logger.warn("Knowledge index could not be loaded; answers come without knowledge until it can", { err: errorName(err) });
  }
  try {
    const probe = await embeddings.embed(PROBE_TEXT);
    if (stats?.dimension !== undefined && probe.length !== stats.dimension) {
      logger.warn("Embedding model dimension differs from the stored chunks; run the ingestion again", {
        model: embeddings.model, dimension: probe.length, storedDimension: stats.dimension,
      });
    }
  } catch (err) {
    logger.warn("Embedding endpoint not reachable; answers come without knowledge until it is", {
      model: embeddings.model, err: errorName(err), ...(err instanceof EmbeddingError ? { failure: err.failure, status: err.status } : {}),
    });
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
