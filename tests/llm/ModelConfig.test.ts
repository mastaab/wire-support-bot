import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, optionalReasoningEffort, resolvePositiveInt } from "../../src/app/config";

afterEach(() => vi.unstubAllEnvs());

const REQUIRED_ENV = {
    WIRE_SDK_API_TOKEN: "synthetic-token", WIRE_SDK_API_HOST: "https://wire.invalid",
    WIRE_SDK_APP_ID: "test-bot", WIRE_SDK_APP_DOMAIN: "test.invalid", WIRE_SDK_CRYPTO_KEY: "01".repeat(32),
    DATABASE_URL: "postgres://synthetic.invalid/db",
    WIRE_SUPPORT_BOT_JIRA_BASE_URL: "https://jira.invalid", WIRE_SUPPORT_BOT_JIRA_SITE_URL: "https://jira.invalid",
    WIRE_SUPPORT_BOT_JIRA_API_TOKEN: "synthetic-token", WIRE_SUPPORT_BOT_JIRA_PROJECT_KEY: "SD",
    WIRE_SUPPORT_BOT_JIRA_SERVICE_DESK_ID: "1", WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES: "fault=1",
};

it("loads model settings and fallbacks from the canonical environment prefix", () => {
  for (const [key, value] of Object.entries({
    WIRE_SDK_API_TOKEN: "synthetic-token", WIRE_SDK_API_HOST: "https://wire.invalid",
    WIRE_SDK_APP_ID: "test-bot", WIRE_SDK_APP_DOMAIN: "test.invalid", WIRE_SDK_CRYPTO_KEY: "01".repeat(32),
    WIRE_SUPPORT_BOT_LLM_BASE_URL: "https://model.invalid/v1/", WIRE_SUPPORT_BOT_LLM_API_KEY: "synthetic-key",
    WIRE_SUPPORT_BOT_LLM_TIMEOUT_MS: "12345", DATABASE_URL: "postgres://synthetic.invalid/db",
    WIRE_SUPPORT_BOT_JIRA_BASE_URL: "https://jira.invalid", WIRE_SUPPORT_BOT_JIRA_SITE_URL: "https://jira.invalid",
    WIRE_SUPPORT_BOT_JIRA_API_TOKEN: "synthetic-token", WIRE_SUPPORT_BOT_JIRA_PROJECT_KEY: "SD",
    WIRE_SUPPORT_BOT_JIRA_SERVICE_DESK_ID: "1", WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES: "fault=1",
  })) vi.stubEnv(key, value);
  const slots = { classify: "CLASSIFY", respond: "RESPOND" } as const;
  for (const suffix of Object.values(slots)) {
    vi.stubEnv(`WIRE_SUPPORT_BOT_MODEL_${suffix}`, `primary-${suffix}`);
    vi.stubEnv(`WIRE_SUPPORT_BOT_FALLBACK_${suffix}`, `fallback-${suffix}`);
  }
  const config = loadConfig().llm;
  expect(config.baseUrl).toBe("https://model.invalid/v1");
  expect(config.apiKey).toBe("synthetic-key");
  expect(config.timeoutMs).toBe(12345);
  expect(Object.keys(config.slots).sort()).toEqual(["classify", "respond"]);
  for (const [key, suffix] of Object.entries(slots)) {
    expect(config.slots[key as keyof typeof slots]).toEqual({ model: `primary-${suffix}`, fallback: `fallback-${suffix}` });
  }
});

describe("WIRE_SUPPORT_BOT_LLM_REASONING_EFFORT", () => {
  it("is absent by default, accepts the four levels in any case and rejects others", () => {
    expect(optionalReasoningEffort(undefined)).toEqual({});
    expect(optionalReasoningEffort(" None ")).toEqual({ reasoningEffort: "none" });
    expect(optionalReasoningEffort("high")).toEqual({ reasoningEffort: "high" });
    expect(() => optionalReasoningEffort("off")).toThrow(/none, low, medium or high/);
  });
});

describe("numeric settings", () => {
  it("use the default when unset or blank and accept a positive whole number", () => {
    expect(resolvePositiveInt({}, "MESSAGE_BUFFER_SIZE", 50)).toBe(50);
    expect(resolvePositiveInt({ MESSAGE_BUFFER_SIZE: "  " }, "MESSAGE_BUFFER_SIZE", 50)).toBe(50);
    expect(resolvePositiveInt({ MESSAGE_BUFFER_SIZE: " 20 " }, "MESSAGE_BUFFER_SIZE", 50)).toBe(20);
  });

  it("reject non-numeric, fractional, zero and negative values, naming the setting", () => {
    for (const raw of ["abc", "12abc", "1.5", "0", "-3", "1e3"]) {
      expect(() => resolvePositiveInt({ MESSAGE_BUFFER_SIZE: raw }, "MESSAGE_BUFFER_SIZE", 50))
        .toThrow(`MESSAGE_BUFFER_SIZE must be a positive whole number, got "${raw}"`);
    }
  });

  it("fail at startup for a bad MESSAGE_BUFFER_SIZE or timeout instead of loading NaN", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) vi.stubEnv(key, value);
    vi.stubEnv("MESSAGE_BUFFER_SIZE", "lots");
    expect(() => loadConfig()).toThrow(/MESSAGE_BUFFER_SIZE must be a positive whole number/);
    vi.stubEnv("MESSAGE_BUFFER_SIZE", "0");
    expect(() => loadConfig()).toThrow(/MESSAGE_BUFFER_SIZE must be a positive whole number/);
    vi.stubEnv("MESSAGE_BUFFER_SIZE", "");
    vi.stubEnv("WIRE_SUPPORT_BOT_LLM_TIMEOUT_MS", "soon");
    expect(() => loadConfig()).toThrow(/WIRE_SUPPORT_BOT_LLM_TIMEOUT_MS must be a positive whole number/);
    vi.stubEnv("WIRE_SUPPORT_BOT_LLM_TIMEOUT_MS", "");
    vi.stubEnv("WIRE_SUPPORT_BOT_JIRA_TIMEOUT_MS", "-1");
    expect(() => loadConfig()).toThrow(/WIRE_SUPPORT_BOT_JIRA_TIMEOUT_MS must be a positive whole number/);
  });

  it("fail at startup on an unknown LOG_FORMAT, naming the setting", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) vi.stubEnv(key, value);
    vi.stubEnv("LOG_FORMAT", "text");
    expect(() => loadConfig()).toThrow(/LOG_FORMAT must be json or ecs/);
    vi.stubEnv("LOG_FORMAT", "ecs");
    expect(loadConfig().app).toMatchObject({ logFormat: "ecs", sdkLogLevel: "warn", sdkLogContent: "messages" });
  });

  it("cap MESSAGE_BUFFER_SIZE at 500", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) vi.stubEnv(key, value);
    vi.stubEnv("MESSAGE_BUFFER_SIZE", "50");
    expect(loadConfig().app.messageBufferSize).toBe(50);
    vi.stubEnv("MESSAGE_BUFFER_SIZE", "9999");
    expect(loadConfig().app.messageBufferSize).toBe(500);
  });
});
