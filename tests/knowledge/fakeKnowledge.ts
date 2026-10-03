import { vi } from "vitest";
import type {
  KnowledgeDocumentRecord, KnowledgeRepository, NewKnowledgeDocument, StoredKnowledgeChunk,
} from "../../src/domain/repositories/KnowledgeRepository";
import type { EmbeddingPort } from "../../src/application/ports/EmbeddingPort";

/** An in-memory KnowledgeRepository with the Prisma repository's semantics, for unit tests. */
export function fakeKnowledgeRepository() {
  const documents = new Map<string, NewKnowledgeDocument & { id: string }>();
  let nextId = 1;
  const record = ({ chunks: _chunks, ...doc }: NewKnowledgeDocument & { id: string }): KnowledgeDocumentRecord => doc;
  const repository = {
    listDocuments: vi.fn(async () => [...documents.values()].map(record)),
    replaceDocument: vi.fn(async (doc: NewKnowledgeDocument) => {
      const stored = { ...doc, id: `doc${nextId++}` };
      documents.set(doc.sourcePath, stored);
      return record(stored);
    }),
    deleteDocuments: vi.fn(async (paths: readonly string[]) => paths.filter((p) => documents.delete(p)).length),
    version: vi.fn(async () => {
      const all = [...documents.values()];
      const latest = all.reduce<Date | null>((max, d) => (!max || d.ingestedAt > max ? d.ingestedAt : max), null);
      return { documents: all.length, chunks: all.reduce((n, d) => n + d.chunks.length, 0), latestIngestedAt: latest };
    }),
    loadChunks: vi.fn(async (model: string) => {
      const chunks: StoredKnowledgeChunk[] = [];
      let otherModelChunks = 0;
      for (const doc of documents.values()) {
        if (doc.embeddingModel !== model) {
          otherModelChunks += doc.chunks.length;
          continue;
        }
        for (const c of doc.chunks) {
          chunks.push({ documentId: doc.id, title: doc.title, position: c.position, headingPath: c.headingPath, content: c.content, embedding: c.embedding, ingestedAt: doc.ingestedAt });
        }
      }
      return { chunks, otherModelChunks };
    }),
  } satisfies KnowledgeRepository;
  return { repository, documents };
}

/**
 * Embeddings from a fixed vocabulary: each dimension counts one keyword, so texts sharing words
 * are similar. `fail` makes the next calls throw the given error.
 */
export function fakeEmbeddings(vocabulary: string[], model = "test-embed") {
  const state: { fail?: Error } = {};
  const vector = (text: string) => {
    const lower = text.toLowerCase();
    return Float32Array.from(vocabulary.map((word) => lower.split(word).length - 1));
  };
  const port = {
    model,
    embed: vi.fn(async (text: string) => {
      if (state.fail) throw state.fail;
      return vector(text);
    }),
    embedBatch: vi.fn(async (texts: readonly string[]) => {
      if (state.fail) throw state.fail;
      return texts.map(vector);
    }),
  } satisfies EmbeddingPort;
  return { port, state };
}

export function silentLogger() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger);
  return logger;
}
