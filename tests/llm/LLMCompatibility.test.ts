import { afterEach, it, expect, vi } from "vitest";
import { LLMClientFactory } from "../../src/infrastructure/llm/LLMClientFactory";
import type { LLMConfig } from "../../src/app/config";
const config: LLMConfig = { baseUrl: "http://model.test", apiKey: "synthetic", timeoutMs: 1000, slots: { respond: { model: "test", fallback: "test" }, classify: { model: "test", fallback: "test" } } };
afterEach(() => vi.unstubAllGlobals());
it("retries a deprecated temperature exactly once and does not log response bodies", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "temperature is deprecated for this model" } }), {status:400}))
    .mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:'OK'}}]})));
  vi.stubGlobal("fetch", fetch);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const result = await new LLMClientFactory(config,logger as never).chatCompletion("respond",[{role:"user",content:"marker"}],{temperature:0});
  expect(result.content).toBe("OK");
  expect(JSON.parse(fetch.mock.calls[1][1].body)).not.toHaveProperty("temperature");
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("does not retry an unrelated bad request or expose its body", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "PRIVATE_CONTEXT_MARKER" } }), {status:400}));
  vi.stubGlobal("fetch", fetch);
  await expect(new LLMClientFactory(config,{} as never).chatCompletion("respond",[],{temperature:0})).rejects.toThrow("LLM request failed (400)");
  expect(fetch).toHaveBeenCalledOnce();
});
const ok = () => new Response(JSON.stringify({choices:[{message:{content:'OK'}}]}));
const rejectsTemperature = () => new Response(JSON.stringify({ error: { message: "`temperature` is deprecated for this model." } }), {status:400});
const twoModels: LLMConfig = { ...config, slots: { respond: { model: "rejects", fallback: "rejects" }, classify: { model: "accepts", fallback: "accepts" } } };
it("omits temperature on later requests once a model has rejected it", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(rejectsTemperature()).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
  vi.stubGlobal("fetch", fetch);
  const factory = new LLMClientFactory(config,{ info: vi.fn(), warn: vi.fn() } as never);
  await factory.chatCompletion("respond",[{role:"user",content:"first"}],{temperature:0});
  await factory.chatCompletion("respond",[{role:"user",content:"second"}],{temperature:0});
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(JSON.parse(fetch.mock.calls[2][1].body)).not.toHaveProperty("temperature");
});
it("keeps sending temperature to models that have not rejected it", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(rejectsTemperature()).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
  vi.stubGlobal("fetch", fetch);
  const factory = new LLMClientFactory(twoModels,{ info: vi.fn(), warn: vi.fn() } as never);
  await factory.chatCompletion("respond",[],{temperature:0});
  await factory.chatCompletion("classify",[],{temperature:0.7});
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({ model: "accepts", temperature: 0.7 });
});
it("logs each learned model once rather than on every request", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(rejectsTemperature()).mockImplementation(async () => ok());
  vi.stubGlobal("fetch", fetch);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const factory = new LLMClientFactory(config,logger as never);
  for (let i = 0; i < 3; i++) await factory.chatCompletion("respond",[],{temperature:0});
  expect(logger.info).toHaveBeenCalledOnce();
  expect(logger.info).toHaveBeenCalledWith("Model rejected temperature; omitting it for this model", { model: "test" });
});
it("does not loop when a remembered model rejects a request again", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(rejectsTemperature()).mockResolvedValueOnce(ok()).mockImplementation(async () => rejectsTemperature());
  vi.stubGlobal("fetch", fetch);
  const factory = new LLMClientFactory(config,{ info: vi.fn(), warn: vi.fn() } as never);
  await factory.chatCompletion("respond",[],{temperature:0});
  await expect(factory.chatCompletion("respond",[],{temperature:0})).rejects.toThrow("LLM request failed (400)");
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("sends reasoning_effort only when it is configured", async () => {
  const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], model: "m" }), { status: 200 });
  const fetch = vi.fn().mockImplementation(async () => ok());
  vi.stubGlobal("fetch", fetch);
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  await new LLMClientFactory({ ...config, reasoningEffort: "none" }, quiet as never).chatCompletion("respond", [], {});
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ reasoning_effort: "none" });
  await new LLMClientFactory(config, quiet as never).chatCompletion("respond", [], {});
  expect(JSON.parse(fetch.mock.calls[1][1].body)).not.toHaveProperty("reasoning_effort");
});
