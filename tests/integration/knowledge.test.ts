/**
 * Integration tests for the document index against Postgres: the Prisma repository, the ingestion
 * and the in-memory index loading from the database. Require DATABASE_URL and a running Postgres
 * with the migrations applied, on a throwaway database: the ingestion treats its files as the full
 * set and removes every other stored document. Skip when INTEGRATION_TESTS is not "1".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaKnowledgeRepository } from "../../src/infrastructure/persistence/postgres/PrismaKnowledgeRepository";
import { getPrismaClient } from "../../src/infrastructure/persistence/postgres/PrismaClient";
import { IngestKnowledge } from "../../src/application/usecases/knowledge/IngestKnowledge";
import { InMemoryKnowledgeIndex } from "../../src/infrastructure/knowledge/InMemoryKnowledgeIndex";
import { fakeEmbeddings, silentLogger } from "../knowledge/fakeKnowledge";

const at = (day: number) => new Date(Date.UTC(2026, 9, day, 8, 0));
const chunk = (position: number, headingPath: string, content: string, vector: number[]) => ({
  position, headingPath, content, embedding: Float32Array.from(vector),
});

describe.skipIf(process.env.INTEGRATION_TESTS !== "1")("Knowledge repository and index integration", () => {
  const repo = new PrismaKnowledgeRepository();
  const db = getPrismaClient();

  beforeAll(async () => {
    await db.knowledgeDocument.deleteMany({});
  });

  afterAll(async () => {
    await db.knowledgeDocument.deleteMany({});
    await db.$disconnect();
  });

  it("stores a document with its chunks, embeddings as little-endian float32 bytes, and lists it", async () => {
    expect(await repo.version()).toEqual({ documents: 0, chunks: 0, latestIngestedAt: null });
    const stored = await repo.replaceDocument({
      sourcePath: "lights.md", title: "Dashboard lights", contentHash: "a".repeat(64), embeddingModel: "test-embed", ingestedAt: at(1),
      chunks: [chunk(0, "Engine light", "Drive to a workshop.", [1, -2.5, 0.1]), chunk(1, "", "Overview.", [0, 1, 0])],
    });
    expect(stored).toMatchObject({ sourcePath: "lights.md", title: "Dashboard lights", embeddingModel: "test-embed", ingestedAt: at(1) });
    expect(await repo.listDocuments()).toEqual([stored]);

    const rows = await db.$queryRaw<Array<{ embedding: Uint8Array; dimension: number }>>`
      SELECT c.embedding, c.dimension FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
      WHERE d.source_path = 'lights.md' AND c.position = 0`;
    expect(rows[0]!.dimension).toBe(3);
    expect([...rows[0]!.embedding.slice(0, 4)]).toEqual([0x00, 0x00, 0x80, 0x3f]);

    const { chunks, otherModelChunks } = await repo.loadChunks("test-embed");
    expect(otherModelChunks).toBe(0);
    expect(chunks.map((c) => ({ ...c, embedding: [...c.embedding] }))).toEqual([
      { documentId: stored.id, title: "Dashboard lights", position: 0, headingPath: "Engine light", content: "Drive to a workshop.", embedding: [1, -2.5, Math.fround(0.1)], ingestedAt: at(1) },
      { documentId: stored.id, title: "Dashboard lights", position: 1, headingPath: "", content: "Overview.", embedding: [0, 1, 0], ingestedAt: at(1) },
    ]);
    expect(await repo.version()).toEqual({ documents: 1, chunks: 2, latestIngestedAt: at(1) });
  });

  it("replaces a document by source path with its chunks, counts other models' chunks, and deletes with cascade", async () => {
    const replaced = await repo.replaceDocument({
      sourcePath: "lights.md", title: "Lights", contentHash: "b".repeat(64), embeddingModel: "test-embed", ingestedAt: at(2),
      chunks: [chunk(0, "", "Only one chunk now.", [1, 1, 1])],
    });
    await repo.replaceDocument({
      sourcePath: "old.md", title: "Old", contentHash: "c".repeat(64), embeddingModel: "old-embed", ingestedAt: at(1),
      chunks: [chunk(0, "", "Old model.", [1, 0]), chunk(1, "", "Old model too.", [0, 1])],
    });
    expect(await db.knowledgeChunk.count({ where: { documentId: replaced.id } })).toBe(1);
    const loaded = await repo.loadChunks("test-embed");
    expect(loaded.chunks.map((c) => c.content)).toEqual(["Only one chunk now."]);
    expect(loaded.otherModelChunks).toBe(2);
    expect(await repo.version()).toEqual({ documents: 2, chunks: 3, latestIngestedAt: at(2) });

    expect(await repo.deleteDocuments(["old.md", "missing.md"])).toBe(1);
    expect(await repo.deleteDocuments([])).toBe(0);
    expect(await db.knowledgeChunk.count()).toBe(1);
  });

  it("ingests a directory's documents idempotently and serves them from the in-memory index", async () => {
    const embeddings = fakeEmbeddings(["engine", "light", "tire", "pressure"]);
    const files = [
      { sourcePath: "lights.md", text: "# Dashboard lights\n## Engine light\nA yellow engine light means: drive to a workshop soon." },
      { sourcePath: "tires/pressure.md", text: "# Tires\n## Pressure\nCheck the tire pressure every week." },
    ];
    const ingest = new IngestKnowledge(repo, embeddings.port, () => at(3));
    expect(await ingest.execute(files)).toEqual({ added: 1, updated: 1, unchanged: 0, removed: 0, chunksWritten: 2, chunksTotal: 2 });
    expect(await ingest.execute(files)).toEqual({ added: 0, updated: 0, unchanged: 2, removed: 0, chunksWritten: 0, chunksTotal: 2 });

    const index = new InMemoryKnowledgeIndex(repo, embeddings.port, silentLogger(), { results: 4, minScore: 0.5 });
    expect(await index.load()).toEqual({ model: "test-embed", documents: 2, chunks: 2, dimension: 4 });
    const results = await index.retrieve({ question: "the yellow engine light is on", conversationId: { id: "c", domain: "wire.test" } });
    expect(results.map((r) => ({ source: r.source, content: r.content, sourceDate: r.sourceDate }))).toEqual([
      { source: "Dashboard lights, Engine light", content: "A yellow engine light means: drive to a workshop soon.", sourceDate: at(3) },
    ]);
    expect(results[0]!.id).toMatch(/^[a-z0-9]+:0$/);

    expect(await ingest.execute([files[1]!])).toMatchObject({ removed: 1, unchanged: 1 });
    expect((await repo.listDocuments()).map((d) => d.sourcePath)).toEqual(["tires/pressure.md"]);
  });
});
