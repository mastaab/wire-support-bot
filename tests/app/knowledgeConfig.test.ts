import { describe, expect, it } from "vitest";
import { resolveKnowledgeConfig } from "../../src/app/config";

describe("resolveKnowledgeConfig", () => {
  it("is off by default, without an embeddings endpoint or model, and never takes the model endpoint or its key", () => {
    expect(resolveKnowledgeConfig({})).toEqual({
      enabled: false,
      embedding: { baseUrl: "", apiKey: "", model: "", timeoutMs: 60_000 },
      results: 4,
      minScore: 0.5,
    });
    expect(resolveKnowledgeConfig({
      WIRE_SUPPORT_BOT_LLM_BASE_URL: "https://models.example.com/v1/", WIRE_SUPPORT_BOT_LLM_API_KEY: "llm-key", WIRE_SUPPORT_BOT_LLM_TIMEOUT_MS: "5000",
    }).embedding).toEqual({ baseUrl: "", apiKey: "", model: "", timeoutMs: 5000 });
  });

  it.each([
    [{ WIRE_SUPPORT_BOT_KNOWLEDGE: "on", WIRE_SUPPORT_BOT_EMBED_MODEL: "nomic-embed-text", WIRE_SUPPORT_BOT_LLM_BASE_URL: "http://chat.example.com/v1" }, "WIRE_SUPPORT_BOT_EMBED_BASE_URL must be set"],
    [{ WIRE_SUPPORT_BOT_KNOWLEDGE: "on", WIRE_SUPPORT_BOT_EMBED_BASE_URL: "http://embed.example.com/v1" }, "WIRE_SUPPORT_BOT_EMBED_MODEL must be set"],
  ])("needs the embeddings endpoint and model with knowledge on: %o", (env, message) => {
    expect(() => resolveKnowledgeConfig(env)).toThrow(message);
  });

  it("needs them for the ingestion even with knowledge off", () => {
    expect(() => resolveKnowledgeConfig({}, { requireEmbedding: true })).toThrow("WIRE_SUPPORT_BOT_EMBED_BASE_URL must be set");
  });

  it("reads every setting, in any case for on and off; blank values keep the defaults", () => {
    expect(resolveKnowledgeConfig({
      WIRE_SUPPORT_BOT_KNOWLEDGE: " ON ",
      WIRE_SUPPORT_BOT_LLM_BASE_URL: "http://chat.example.com/v1",
      WIRE_SUPPORT_BOT_LLM_API_KEY: "llm-key",
      WIRE_SUPPORT_BOT_EMBED_BASE_URL: "http://embed.example.com/v1",
      WIRE_SUPPORT_BOT_EMBED_API_KEY: "embed-key",
      WIRE_SUPPORT_BOT_EMBED_MODEL: "nomic-embed-text",
      WIRE_SUPPORT_BOT_KNOWLEDGE_RESULTS: "10",
      WIRE_SUPPORT_BOT_KNOWLEDGE_MIN_SCORE: "0.35",
    })).toEqual({
      enabled: true,
      embedding: { baseUrl: "http://embed.example.com/v1", apiKey: "embed-key", model: "nomic-embed-text", timeoutMs: 60_000 },
      results: 10,
      minScore: 0.35,
    });
    const blank = resolveKnowledgeConfig({
      WIRE_SUPPORT_BOT_KNOWLEDGE: "", WIRE_SUPPORT_BOT_EMBED_BASE_URL: " ", WIRE_SUPPORT_BOT_EMBED_API_KEY: "", WIRE_SUPPORT_BOT_LLM_API_KEY: "llm-key",
      WIRE_SUPPORT_BOT_EMBED_MODEL: "", WIRE_SUPPORT_BOT_KNOWLEDGE_RESULTS: "", WIRE_SUPPORT_BOT_KNOWLEDGE_MIN_SCORE: " ",
    });
    expect(blank).toMatchObject({ enabled: false, results: 4, minScore: 0.5, embedding: { baseUrl: "", apiKey: "", model: "" } });
    expect(resolveKnowledgeConfig({ WIRE_SUPPORT_BOT_KNOWLEDGE_MIN_SCORE: "0" }).minScore).toBe(0);
    expect(resolveKnowledgeConfig({ WIRE_SUPPORT_BOT_KNOWLEDGE_MIN_SCORE: "1" }).minScore).toBe(1);
    expect(resolveKnowledgeConfig({ WIRE_SUPPORT_BOT_KNOWLEDGE_MIN_SCORE: ".7" }).minScore).toBe(0.7);
    expect(resolveKnowledgeConfig({ WIRE_SUPPORT_BOT_KNOWLEDGE_RESULTS: "1" }).results).toBe(1);
  });

  it.each([
    [{ WIRE_SUPPORT_BOT_KNOWLEDGE: "yes" }, "WIRE_SUPPORT_BOT_KNOWLEDGE must be on or off"],
    [{ WIRE_SUPPORT_BOT_EMBED_BASE_URL: "not a url" }, "WIRE_SUPPORT_BOT_EMBED_BASE_URL must be an http or https URL"],
    [{ WIRE_SUPPORT_BOT_EMBED_BASE_URL: "ftp://embed.example.com" }, "WIRE_SUPPORT_BOT_EMBED_BASE_URL must be an http or https URL"],
    [{ WIRE_SUPPORT_BOT_EMBED_MODEL: "two words" }, "WIRE_SUPPORT_BOT_EMBED_MODEL must be a model name without spaces"],
    [{ WIRE_SUPPORT_BOT_KNOWLEDGE_RESULTS: "0" }, "WIRE_SUPPORT_BOT_KNOWLEDGE_RESULTS must be a whole number from 1 to 10"],
    [{ WIRE_SUPPORT_BOT_KNOWLEDGE_RESULTS: "11" }, "WIRE_SUPPORT_BOT_KNOWLEDGE_RESULTS must be a whole number from 1 to 10"],
    [{ WIRE_SUPPORT_BOT_KNOWLEDGE_RESULTS: "2.5" }, "WIRE_SUPPORT_BOT_KNOWLEDGE_RESULTS must be a whole number from 1 to 10"],
    [{ WIRE_SUPPORT_BOT_KNOWLEDGE_MIN_SCORE: "1.5" }, "WIRE_SUPPORT_BOT_KNOWLEDGE_MIN_SCORE must be a number from 0 to 1"],
    [{ WIRE_SUPPORT_BOT_KNOWLEDGE_MIN_SCORE: "-0.1" }, "WIRE_SUPPORT_BOT_KNOWLEDGE_MIN_SCORE must be a number from 0 to 1"],
    [{ WIRE_SUPPORT_BOT_KNOWLEDGE_MIN_SCORE: "half" }, "WIRE_SUPPORT_BOT_KNOWLEDGE_MIN_SCORE must be a number from 0 to 1"],
    [{ WIRE_SUPPORT_BOT_KNOWLEDGE_MIN_SCORE: "." }, "WIRE_SUPPORT_BOT_KNOWLEDGE_MIN_SCORE must be a number from 0 to 1"],
  ])("fails on %o, naming the setting, also with knowledge off", (env, message) => {
    expect(() => resolveKnowledgeConfig(env)).toThrow(message);
  });
});
