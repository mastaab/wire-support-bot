import { describe, it, expect, vi } from "vitest";
import { OpenAIClassifierAdapter } from "../../src/infrastructure/llm/OpenAIClassifierAdapter";
import type { LLMClientFactory } from "../../src/infrastructure/llm/LLMClientFactory";
import type { Logger } from "../../src/application/ports/Logger";

const logger: Logger = {
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
};

function makeLLM(content: string): LLMClientFactory {
  return {
    chatCompletion: vi.fn().mockResolvedValue({ content, model: "test-model", usedFallback: false }),
  } as unknown as LLMClientFactory;
}

const ctx = { channelId: "ch1" };
const sentMessages = (llm: LLMClientFactory) => (llm.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0];

describe("OpenAIClassifierAdapter", () => {
  it("parses the service-desk categories and the confidence", async () => {
    const llm = makeLLM(JSON.stringify({ categories: ["service_request", "request_status"], confidence: 0.9 }));
    const result = await new OpenAIClassifierAdapter(llm, logger).classify("Printer is broken, any news on SD-6?", ctx, []);
    expect(result).toEqual({ categories: ["service_request", "request_status"], confidence: 0.9 });
  });

  it("keeps update and blocker alongside a service request", async () => {
    const llm = makeLLM(JSON.stringify({ categories: ["service_request", "blocker"], confidence: 0.9 }));
    const result = await new OpenAIClassifierAdapter(llm, logger).classify("The build server is down and blocks the release", ctx, []);
    expect(result.categories).toEqual(["service_request", "blocker"]);
  });

  it("falls back to other on an LLM error", async () => {
    const llm = { chatCompletion: vi.fn().mockRejectedValue(new Error("timeout")) } as unknown as LLMClientFactory;
    const result = await new OpenAIClassifierAdapter(llm, logger).classify("some text", ctx, []);
    expect(result).toEqual({ categories: ["other"], confidence: 0 });
  });

  it("falls back to other on malformed JSON", async () => {
    const result = await new OpenAIClassifierAdapter(makeLLM("not json at all"), logger).classify("some text", ctx, []);
    expect(result).toEqual({ categories: ["other"], confidence: 0 });
  });

  it("filters invalid and team-record category values", async () => {
    const llm = makeLLM(JSON.stringify({ categories: ["decision", "INVALID_CAT", "update", "action"], confidence: 0.8 }));
    const result = await new OpenAIClassifierAdapter(llm, logger).classify("It happens on the new laptops too", ctx, []);
    expect(result.categories).toEqual(["update"]);
  });

  it("uses other when no valid category is left", async () => {
    const llm = makeLLM(JSON.stringify({ categories: ["decision"], confidence: 0.8 }));
    const result = await new OpenAIClassifierAdapter(llm, logger).classify("We use Postgres", ctx, []);
    expect(result.categories).toEqual(["other"]);
  });

  it("clamps the confidence and treats a missing one as zero", async () => {
    expect((await new OpenAIClassifierAdapter(makeLLM(JSON.stringify({ categories: ["other"], confidence: 3 })), logger).classify("x", ctx, [])).confidence).toBe(1);
    expect((await new OpenAIClassifierAdapter(makeLLM(JSON.stringify({ categories: ["other"] })), logger).classify("x", ctx, [])).confidence).toBe(0);
  });

  it("strips ```json markdown wrappers", async () => {
    const llm = makeLLM("```json\n" + JSON.stringify({ categories: ["blocker"], confidence: 0.8 }) + "\n```");
    const result = await new OpenAIClassifierAdapter(llm, logger).classify("build is broken", ctx, []);
    expect(result.categories).toContain("blocker");
  });

  it("offers only the service-desk categories and says so", async () => {
    const llm = makeLLM("{}");
    await new OpenAIClassifierAdapter(llm, logger).classify("Printer is broken", ctx, ["[Alice] hi"]);
    const system = sentMessages(llm)[1][0].content as string;
    for (const category of ["service_request", "request_status", "update", "blocker", "other"]) expect(system).toContain(`- ${category}: `);
    expect(system).toContain("whether a message is something for the service desk");
    expect(system).not.toMatch(/- (?:decision|action|question|discussion|reference|routine):/);
    expect(system).not.toContain("is_high_signal");
    const user = sentMessages(llm)[1][1].content as string;
    expect(user).toContain("[Alice] hi");
    expect(user).toContain('Message to classify: "Printer is broken"');
  });

  it("shows at most the last five recent messages", async () => {
    const llm = makeLLM("{}");
    await new OpenAIClassifierAdapter(llm, logger).classify("x", ctx, ["m1", "m2", "m3", "m4", "m5", "m6"]);
    const user = sentMessages(llm)[1][1].content as string;
    expect(user).not.toContain("m1");
    expect(user).toContain("m2\nm3\nm4\nm5\nm6");
  });

  describe("service scope", () => {
    const SCOPE = "questions about the printer, faults, breakdowns, damage, service and maintenance, and replacement part orders";
    const promptFor = async (options: { serviceScope?: string }) => {
      const llm = makeLLM("{}");
      await new OpenAIClassifierAdapter(llm, logger, options).classify("Printer 17 is due for its 60,000-page service", ctx, []);
      return sentMessages(llm)[1][0].content as string;
    };

    it("keeps the generic service_request line without a scope", async () => {
      for (const serviceScope of [undefined, "", "   "]) {
        const prompt = await promptFor({ serviceScope });
        expect(prompt).toContain("- service_request: someone describes a problem, fault or need that a service desk could handle, such as something broken, an error, or access they need, or adds information");
        expect(prompt).toContain("it now affects more places), or says a reported problem is solved or asks to close a request\n");
      }
    });

    it("describes service_request with the scope", async () => {
      const prompt = await promptFor({ serviceScope: ` ${SCOPE.replace(", damage", ",\n damage")}. ` });
      expect(prompt).toContain(
        `- service_request: someone brings the service desk something it handles (${SCOPE}): a question to the desk, a fault or need, a replacement part order or a scheduled service all count; or adds information to a problem already reported (a new detail, a change, it happened again, it now affects more places); or says a reported problem is solved or asks to close a request\n`,
      );
      expect(prompt).not.toContain("access they need");
      const generic = await promptFor({});
      const changed = prompt.split("\n").filter((line) => !generic.split("\n").includes(line));
      expect(changed).toHaveLength(1);
    });

    it("inserts the scope literally, even with replacement patterns in it", async () => {
      const prompt = await promptFor({ serviceScope: "printers $& parts $1" });
      expect(prompt).toContain("(printers $& parts $1)");
    });
  });
});
