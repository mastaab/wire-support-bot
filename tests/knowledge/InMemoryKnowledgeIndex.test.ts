import { describe, expect, it, vi } from "vitest";
import { InMemoryKnowledgeIndex, KnowledgeIndexError } from "../../src/infrastructure/knowledge/InMemoryKnowledgeIndex";
import { EmbeddingError } from "../../src/application/ports/EmbeddingPort";
import type { NewKnowledgeDocument } from "../../src/domain/repositories/KnowledgeRepository";
import { fakeEmbeddings, fakeKnowledgeRepository, silentLogger } from "./fakeKnowledge";
import { fakeMetrics } from "../metrics/fakeMetrics";

const conversationId = { id: "conv", domain: "wire.test" };
const vocabulary = ["engine", "light", "tire", "pressure", "def"];
const at = new Date("2026-10-03T08:00:00Z");

function doc(sourcePath: string, title: string, chunks: Array<[string, string, number[]]>, model = "test-embed", ingestedAt = at): NewKnowledgeDocument {
  return {
    sourcePath, title, contentHash: "h", embeddingModel: model, ingestedAt,
    chunks: chunks.map(([headingPath, content, vector], position) => ({ position, headingPath, content, embedding: Float32Array.from(vector) })),
  };
}

async function setup(options: { results?: number; minScore?: number } = {}) {
  const repo = fakeKnowledgeRepository();
  await repo.repository.replaceDocument(doc("lights.md", "Dashboard lights", [
    ["Engine light", "Yellow engine light: drive to a workshop.", [3, 3, 0, 0, 0]],
    ["", "Overview of all lights.", [0, 2, 0, 0, 0]],
  ]));
  await repo.repository.replaceDocument(doc("tires.md", "Tires", [["Pressure", "Check the pressure weekly.", [0, 0, 2, 2, 0]]]));
  await repo.repository.replaceDocument(doc("old.md", "Old", [["", "Embedded with another model.", [0, 0, 0, 0, 1]]], "old-embed"));
  const embeddings = fakeEmbeddings(vocabulary);
  const logger = silentLogger();
  const fake = fakeMetrics();
  let clock = 0;
  const index = new InMemoryKnowledgeIndex(
    repo.repository, embeddings.port, logger, { results: options.results ?? 4, minScore: options.minScore ?? 0.5, now: () => clock }, fake.metrics,
  );
  return { repo, embeddings, logger, index, ...fake, advance: (ms: number) => { clock += ms; } };
}

describe("InMemoryKnowledgeIndex", () => {
  it("loads the chunks of its model, warns once about others, and reports what it loaded", async () => {
    const { index, logger, readers } = await setup();
    expect(await index.load()).toEqual({ model: "test-embed", documents: 2, chunks: 3, dimension: 5 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![1]).toEqual({ model: "test-embed", skippedChunks: 1 });
    expect(readers.get("knowledge_chunks")!()).toBe(3);
  });

  it("ranks by cosine similarity and returns knowledge articles above the minimum score with id, source and date", async () => {
    const { index, of } = await setup();
    const results = await index.retrieve({ question: "the yellow engine light is on", conversationId });
    expect(results).toEqual([
      { id: "doc1:0", type: "knowledge_article", content: "Yellow engine light: drive to a workshop.", source: "Dashboard lights, Engine light", sourceDate: at },
      { id: "doc1:1", type: "knowledge_article", content: "Overview of all lights.", source: "Dashboard lights", sourceDate: at },
    ]);
    expect(of("knowledgeRetrieval")).toEqual([["hit"]]);
  });

  it("logs the best score, the minimum and the number of results at debug, without the question", async () => {
    const { index, logger } = await setup({ results: 1 });
    await index.retrieve({ question: "engine light", conversationId });
    await index.retrieve({ question: "something unrelated", conversationId });
    const lines = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.filter(([msg]) => msg === "Knowledge search");
    expect(lines).toHaveLength(2);
    expect(lines[0]![1]).toMatchObject({ minScore: 0.5, results: 1 });
    expect(lines[0]![1].bestScore).toBeGreaterThanOrEqual(0.5);
    expect(lines[1]![1]).toMatchObject({ minScore: 0.5, results: 0 });
    expect(lines[1]![1].bestScore).toBeLessThan(0.5);
    expect(JSON.stringify(lines)).not.toMatch(/engine|unrelated/);
  });

  it("limits the number of results, and counts a miss when nothing scores high enough", async () => {
    const { index, of } = await setup({ results: 1 });
    expect((await index.retrieve({ question: "engine light", conversationId })).map((r) => r.id)).toEqual(["doc1:0"]);
    expect(await index.retrieve({ question: "something unrelated", conversationId })).toEqual([]);
    expect(of("knowledgeRetrieval")).toEqual([["hit"], ["miss"]]);
  });

  it("makes no embedding call when the index is empty", async () => {
    const repo = fakeKnowledgeRepository();
    const embeddings = fakeEmbeddings(vocabulary);
    const index = new InMemoryKnowledgeIndex(repo.repository, embeddings.port, silentLogger(), { results: 4, minScore: 0.5 });
    expect(await index.retrieve({ question: "engine light", conversationId })).toEqual([]);
    expect(embeddings.port.embed).not.toHaveBeenCalled();
  });

  it("throws on a failing embedding call, logging only names and counting an error", async () => {
    const { index, embeddings, logger, of } = await setup();
    await index.load();
    embeddings.state.fail = new EmbeddingError("http", 503);
    await expect(index.retrieve({ question: "engine light", conversationId })).rejects.toThrow(EmbeddingError);
    expect(logger.warn).toHaveBeenLastCalledWith("Knowledge search failed", { err: "EmbeddingError", failure: "http", status: 503 });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("engine light");
    expect(of("knowledgeRetrieval")).toEqual([["error"]]);
  });

  it("throws when the question's dimension does not fit the stored vectors", async () => {
    const { repo, logger } = await setup();
    const index = new InMemoryKnowledgeIndex(repo.repository, fakeEmbeddings(["engine", "light"]).port, logger, { results: 4, minScore: 0 });
    await expect(index.retrieve({ question: "engine", conversationId })).rejects.toThrow(KnowledgeIndexError);
  });

  it("checks for changes at most once per interval, lazily, and reloads only on a change", async () => {
    const { repo, index, advance } = await setup();
    await index.load();
    expect(repo.repository.loadChunks).toHaveBeenCalledTimes(1);
    await index.retrieve({ question: "tire pressure", conversationId });
    expect(repo.repository.version).toHaveBeenCalledTimes(1);

    await repo.repository.replaceDocument(doc("def.md", "DEF", [["", "DEF warning: refill soon.", [0, 0, 0, 0, 1]]], "test-embed", new Date("2026-10-04T08:00:00Z")));
    advance(30_000);
    expect(await index.retrieve({ question: "def", conversationId })).toEqual([]);
    advance(30_000);
    expect((await index.retrieve({ question: "def", conversationId })).map((r) => r.source)).toEqual(["DEF"]);
    expect(repo.repository.loadChunks).toHaveBeenCalledTimes(2);
    advance(60_000);
    await index.retrieve({ question: "def", conversationId });
    expect(repo.repository.version).toHaveBeenCalledTimes(3);
    expect(repo.repository.loadChunks).toHaveBeenCalledTimes(2);
  });

  it("keeps the loaded chunks when a reload fails, and fails questions while nothing could be loaded", async () => {
    const { repo, index, logger, advance } = await setup();
    await index.load();
    repo.repository.version.mockRejectedValueOnce(Object.assign(new Error("db down"), { name: "PrismaClientInitializationError" }));
    advance(60_000);
    expect(await index.retrieve({ question: "tire pressure", conversationId })).toHaveLength(1);
    expect(logger.warn).toHaveBeenLastCalledWith("Knowledge index could not be read; keeping the loaded chunks", {
      err: "PrismaClientInitializationError", loadedChunks: 3,
    });

    const broken = fakeKnowledgeRepository();
    broken.repository.version.mockRejectedValue(new Error("db down"));
    const empty = new InMemoryKnowledgeIndex(broken.repository, fakeEmbeddings(vocabulary).port, silentLogger(), { results: 4, minScore: 0.5 });
    await expect(empty.load()).rejects.toThrow("db down");
    await expect(empty.retrieve({ question: "tire", conversationId })).rejects.toThrow(KnowledgeIndexError);
  });
});
