import { createHash } from "node:crypto";
import type { EmbeddingPort } from "../../ports/EmbeddingPort";
import type { KnowledgeRepository } from "../../../domain/repositories/KnowledgeRepository";
import { chunkDocument, embeddingText } from "../../services/knowledgeChunks";

/** A document file as read from the ingested directory. */
export interface KnowledgeSourceFile {
  /** Path relative to the directory, with forward slashes; identifies the document across runs. */
  sourcePath: string;
  text: string;
}

export interface IngestSummary {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  /** Chunks embedded and stored in this run. */
  chunksWritten: number;
  /** Chunks of the given files after the run (written or unchanged). */
  chunksTotal: number;
}

/** Thrown when the ingestion refuses to run, with a message naming the reason and no document content. */
export class KnowledgeIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeIngestError";
  }
}

/**
 * Brings the document index in line with a directory of documents, which is the full set: a new
 * document is chunked, embedded and stored; a stored one whose content hash and embedding model
 * are unchanged is skipped; a changed one is replaced; a stored one no longer in the set is
 * removed. Each document is stored in one transaction, so a failed run leaves complete documents
 * and a second run continues where it stopped. An empty set is refused rather than emptying the index.
 */
export class IngestKnowledge {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly embeddings: EmbeddingPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(files: readonly KnowledgeSourceFile[]): Promise<IngestSummary> {
    if (files.length === 0) throw new KnowledgeIngestError("No .md or .txt documents found; refusing to empty the index");
    const paths = new Set<string>();
    for (const file of files) {
      if (paths.has(file.sourcePath)) throw new KnowledgeIngestError(`Document path given twice: ${file.sourcePath}`);
      paths.add(file.sourcePath);
    }

    const stored = new Map((await this.repository.listDocuments()).map((doc) => [doc.sourcePath, doc]));
    const storedChunks = new Map<string, number>();
    const summary: IngestSummary = { added: 0, updated: 0, unchanged: 0, removed: 0, chunksWritten: 0, chunksTotal: 0 };

    for (const file of [...files].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))) {
      const contentHash = createHash("sha256").update(file.text, "utf8").digest("hex");
      const previous = stored.get(file.sourcePath);
      const { title, chunks } = chunkDocument(file.text, file.sourcePath);
      if (previous && previous.contentHash === contentHash && previous.embeddingModel === this.embeddings.model) {
        summary.unchanged++;
        storedChunks.set(file.sourcePath, chunks.length);
        continue;
      }
      const vectors = await this.embeddings.embedBatch(chunks.map((chunk) => embeddingText(title, chunk)));
      if (vectors.length !== chunks.length) throw new KnowledgeIngestError("The embedding endpoint returned the wrong number of vectors");
      await this.repository.replaceDocument({
        sourcePath: file.sourcePath, title, contentHash, embeddingModel: this.embeddings.model, ingestedAt: this.now(),
        chunks: chunks.map((chunk, i) => ({ ...chunk, embedding: vectors[i]! })),
      });
      if (previous) summary.updated++;
      else summary.added++;
      summary.chunksWritten += chunks.length;
      storedChunks.set(file.sourcePath, chunks.length);
    }

    const gone = [...stored.keys()].filter((sourcePath) => !paths.has(sourcePath));
    summary.removed = await this.repository.deleteDocuments(gone);
    summary.chunksTotal = [...storedChunks.values()].reduce((sum, n) => sum + n, 0);
    return summary;
  }
}
