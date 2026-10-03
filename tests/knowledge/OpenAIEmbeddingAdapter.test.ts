import { afterEach, describe, expect, it, vi } from "vitest";
import { EMBED_BATCH_SIZE, OpenAIEmbeddingAdapter, parseVectors } from "../../src/infrastructure/llm/OpenAIEmbeddingAdapter";
import { EmbeddingError } from "../../src/application/ports/EmbeddingPort";
import { fakeMetrics } from "../metrics/fakeMetrics";

afterEach(() => vi.unstubAllGlobals());

const config = { baseUrl: "http://embed.test/v1/", apiKey: "synthetic-key", model: "test-embed", timeoutMs: 1000 };
const respond = (inputs: string[], dimension = 3) => new Response(JSON.stringify({
  data: inputs.map((_, index) => ({ index, embedding: Array.from({ length: dimension }, (_, d) => index + d / 10) })).reverse(),
}));

function setup(handler: (inputs: string[]) => Response | Promise<Response>) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => handler(JSON.parse(String(init.body)).input as string[]));
  vi.stubGlobal("fetch", fetch);
  const fake = fakeMetrics();
  return { adapter: new OpenAIEmbeddingAdapter(config, fake.metrics), fetch, ...fake };
}

describe("OpenAIEmbeddingAdapter", () => {
  it("posts the model and the input to /embeddings with the key, and returns vectors in input order", async () => {
    const { adapter, fetch, of } = setup((inputs) => respond(inputs));
    const vector = await adapter.embed("hello");
    expect([...vector].map((v) => Math.round(v * 10) / 10)).toEqual([0, 0.1, 0.2]);
    expect(fetch).toHaveBeenCalledWith("http://embed.test/v1/embeddings", expect.objectContaining({
      method: "POST", body: JSON.stringify({ model: "test-embed", input: ["hello"] }),
      headers: expect.objectContaining({ Authorization: "Bearer synthetic-key" }),
    }));
    const batch = await adapter.embedBatch(["a", "b"]);
    expect(batch.map((v) => Math.round(v[0]!))).toEqual([0, 1]);
    expect(of("modelCall")).toEqual([["embed", "ok"], ["embed", "ok"]]);
    expect(adapter.model).toBe("test-embed");
  });

  it("splits a long list into requests of the batch size, and makes none for an empty list", async () => {
    const { adapter, fetch } = setup((inputs) => respond(inputs));
    const texts = Array.from({ length: EMBED_BATCH_SIZE * 2 + 1 }, (_, i) => `t${i}`);
    expect(await adapter.embedBatch(texts)).toHaveLength(texts.length);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)).input.length)).toEqual([EMBED_BATCH_SIZE, EMBED_BATCH_SIZE, 1]);
    fetch.mockClear();
    expect(await adapter.embedBatch([])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["an HTTP error", () => new Response("model not found: secret detail", { status: 404 }), "http", "error", 404],
    ["no response", () => { throw new TypeError("fetch failed"); }, "unreachable", "error", undefined],
    ["a timeout", () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }, "timeout", "timeout", undefined],
    ["a body that is not JSON", () => new Response("not json"), "invalid_response", "error", undefined],
  ])("throws an EmbeddingError on %s, without the body, and records the call", async (_label, handler, failure, outcome, status) => {
    const { adapter, of } = setup(handler as () => Response);
    const error = await adapter.embed("hello").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect(error).toMatchObject({ failure, status });
    expect((error as Error).message).not.toContain("secret");
    expect(of("modelCall")).toEqual([["embed", outcome]]);
  });

  it("throws when the dimension changes between requests of one batch", async () => {
    let call = 0;
    const { adapter } = setup((inputs) => respond(inputs, call++ === 0 ? 3 : 4));
    await expect(adapter.embedBatch(Array.from({ length: EMBED_BATCH_SIZE + 1 }, () => "t"))).rejects.toMatchObject({ failure: "invalid_response" });
  });
});

describe("parseVectors", () => {
  it.each([
    ["a missing data array", {}],
    ["the wrong number of vectors", { data: [{ embedding: [1] }, { embedding: [2] }] }],
    ["an empty vector", { data: [{ embedding: [] }] }],
    ["a value that is not a finite number", { data: [{ embedding: [1, null] }] }],
  ])("rejects %s", (_label, data) => {
    expect(() => parseVectors(data, 1)).toThrow(EmbeddingError);
  });

  it("rejects vectors of different dimensions and orders by index when every item has one", () => {
    expect(() => parseVectors({ data: [{ embedding: [1] }, { embedding: [1, 2] }] }, 2)).toThrow(EmbeddingError);
    expect(parseVectors({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }, 2).map((v) => v[0])).toEqual([1, 2]);
  });
});
