import { describe, expect, it } from "vitest";
import { IngestKnowledge, KnowledgeIngestError } from "../../src/application/usecases/knowledge/IngestKnowledge";
import { EmbeddingError } from "../../src/application/ports/EmbeddingPort";
import { fakeEmbeddings, fakeKnowledgeRepository } from "./fakeKnowledge";

const brakes = { sourcePath: "brakes.md", text: "# Brakes\n## Lights\nA red light means stop.\n## Pads\nReplace worn pads." };
const tires = { sourcePath: "sub/tires.txt", text: "Check the tire pressure weekly." };
const times = [new Date("2026-10-01T08:00:00Z"), new Date("2026-10-02T08:00:00Z"), new Date("2026-10-03T08:00:00Z")];

function setup() {
  const repo = fakeKnowledgeRepository();
  const embeddings = fakeEmbeddings(["brake", "light", "tire", "pad"]);
  let run = 0;
  const ingest = (model?: string) => new IngestKnowledge(repo.repository, model ? { ...embeddings.port, model } : embeddings.port, () => times[run]!);
  return { repo, embeddings, ingest, nextRun: () => { run++; } };
}

describe("IngestKnowledge", () => {
  it("adds new documents with their chunks, titles, hashes, model and embeddings of title, path and text", async () => {
    const { repo, embeddings, ingest } = setup();
    expect(await ingest().execute([tires, brakes])).toEqual({ added: 2, updated: 0, unchanged: 0, removed: 0, chunksWritten: 3, chunksTotal: 3 });
    const stored = repo.documents.get("brakes.md")!;
    expect(stored).toMatchObject({ title: "Brakes", embeddingModel: "test-embed", ingestedAt: times[0], contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(stored.chunks.map((c) => [c.position, c.headingPath, c.content])).toEqual([[0, "Lights", "A red light means stop."], [1, "Pads", "Replace worn pads."]]);
    expect([...stored.chunks[0]!.embedding]).toEqual([1, 2, 0, 0]);
    expect(repo.documents.get("sub/tires.txt")).toMatchObject({ title: "tires" });
    expect(embeddings.port.embedBatch).toHaveBeenCalledWith(["Brakes > Lights\n\nA red light means stop.", "Brakes > Pads\n\nReplace worn pads."]);
  });

  it("skips unchanged documents, replaces changed ones and removes the ones gone from the directory", async () => {
    const { repo, embeddings, ingest, nextRun } = setup();
    await ingest().execute([brakes, tires]);
    nextRun();
    embeddings.port.embedBatch.mockClear();
    expect(await ingest().execute([brakes, tires])).toEqual({ added: 0, updated: 0, unchanged: 2, removed: 0, chunksWritten: 0, chunksTotal: 3 });
    expect(embeddings.port.embedBatch).not.toHaveBeenCalled();
    expect(repo.repository.replaceDocument).toHaveBeenCalledTimes(2);

    const changed = { ...brakes, text: `${brakes.text}\n## Fluid\nTop up the fluid.` };
    const faq = { sourcePath: "faq.md", text: "# FAQ\nCall the desk." };
    expect(await ingest().execute([changed, faq])).toEqual({ added: 1, updated: 1, unchanged: 0, removed: 1, chunksWritten: 4, chunksTotal: 4 });
    expect([...repo.documents.keys()].sort()).toEqual(["brakes.md", "faq.md"]);
    expect(repo.documents.get("brakes.md")).toMatchObject({ ingestedAt: times[1] });
    expect(repo.repository.deleteDocuments).toHaveBeenLastCalledWith(["sub/tires.txt"]);
  });

  it("re-embeds every document when the embedding model changed", async () => {
    const { repo, ingest } = setup();
    await ingest().execute([brakes, tires]);
    expect(await ingest("other-embed").execute([brakes, tires])).toMatchObject({ added: 0, updated: 2, unchanged: 0 });
    expect(repo.documents.get("brakes.md")).toMatchObject({ embeddingModel: "other-embed" });
  });

  it("stores a document without text with no chunks and counts it unchanged next time", async () => {
    const { repo, ingest } = setup();
    const empty = { sourcePath: "empty.md", text: "# Nothing yet\n" };
    expect(await ingest().execute([empty])).toMatchObject({ added: 1, chunksWritten: 0, chunksTotal: 0 });
    expect(repo.documents.get("empty.md")!.chunks).toEqual([]);
    expect(await ingest().execute([empty])).toMatchObject({ unchanged: 1 });
  });

  it("refuses an empty set and a repeated path, and stops on an embedding failure without removing anything", async () => {
    const { repo, embeddings, ingest } = setup();
    await expect(ingest().execute([])).rejects.toThrow(KnowledgeIngestError);
    await expect(ingest().execute([brakes, { ...brakes }])).rejects.toThrow("Document path given twice: brakes.md");
    await ingest().execute([brakes, tires]);
    embeddings.state.fail = new EmbeddingError("unreachable");
    await expect(ingest().execute([{ ...brakes, text: "# Brakes\nNew." }])).rejects.toThrow(EmbeddingError);
    expect([...repo.documents.keys()].sort()).toEqual(["brakes.md", "sub/tires.txt"]);
    expect(repo.documents.get("brakes.md")!.chunks).toHaveLength(2);
  });
});
