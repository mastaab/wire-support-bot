import { describe, expect, it, vi } from "vitest";
import { createKnowledgeRetrieval, startKnowledgeIndex } from "../../src/app/knowledge";
import { resolveKnowledgeConfig } from "../../src/app/config";
import { EmbeddingError } from "../../src/application/ports/EmbeddingPort";
import { fakeEmbeddings, silentLogger } from "../knowledge/fakeKnowledge";

const stats = { model: "test-embed", documents: 2, chunks: 5, dimension: 3 };

describe("startKnowledgeIndex", () => {
  it("logs one info line with the model, documents, chunks and dimension", async () => {
    const logger = silentLogger();
    await startKnowledgeIndex({ load: async () => stats }, fakeEmbeddings(["a", "b", "c"]).port, logger as never);
    expect(logger.info).toHaveBeenCalledWith("Knowledge index loaded", stats);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns and keeps going when the endpoint is unreachable, the dimension differs, the index is empty or cannot be read", async () => {
    const logger = silentLogger();
    const down = fakeEmbeddings(["a", "b", "c"]);
    down.state.fail = new EmbeddingError("unreachable");
    await startKnowledgeIndex({ load: async () => stats }, down.port, logger as never);
    expect(logger.warn).toHaveBeenCalledWith("Embedding endpoint not reachable; answers come without knowledge until it is", {
      model: "test-embed", err: "EmbeddingError", failure: "unreachable", status: undefined,
    });

    logger.warn.mockClear();
    await startKnowledgeIndex({ load: async () => stats }, fakeEmbeddings(["a", "b"]).port, logger as never);
    expect(logger.warn).toHaveBeenCalledWith("Embedding model dimension differs from the stored chunks; run the ingestion again", {
      model: "test-embed", dimension: 2, storedDimension: 3,
    });

    logger.warn.mockClear();
    await startKnowledgeIndex({ load: async () => ({ model: "test-embed", documents: 0, chunks: 0 }) }, fakeEmbeddings(["a"]).port, logger as never);
    expect(logger.warn.mock.calls.map(([msg]) => msg)).toEqual(["Knowledge index is empty; ingest documents with npm run knowledge:ingest -- <directory>"]);

    logger.warn.mockClear();
    await startKnowledgeIndex({ load: async () => { throw new Error("db down"); } }, fakeEmbeddings(["a"]).port, logger as never);
    expect(logger.warn).toHaveBeenCalledWith("Knowledge index could not be loaded; answers come without knowledge until it can", { err: "Error" });
  });
});

describe("createKnowledgeRetrieval", () => {
  it("builds nothing and makes no call when knowledge is off", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(createKnowledgeRetrieval(resolveKnowledgeConfig({}), silentLogger() as never)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
