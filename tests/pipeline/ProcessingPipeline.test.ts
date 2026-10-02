/**
 * Unit tests for ProcessingPipeline (passive service-desk help).
 * All dependencies are mocked: no DB, no network.
 */
import { describe, it, expect, vi } from "vitest";
import { ProcessingPipeline } from "../../src/infrastructure/pipeline/ProcessingPipeline";
import type { PipelineDeps, MessageJob } from "../../src/infrastructure/pipeline/ProcessingPipeline";
import type { ClassifyResult } from "../../src/application/ports/ClassifierPort";

const convId = { id: "conv-1", domain: "example.com" };
const senderId = { id: "user-1", domain: "example.com" };
const botUserId = { id: "bot-1", domain: "example.com" };

function baseJob(): MessageJob {
  return {
    messageId: "msg-1",
    channelId: "conv-1@example.com",
    conversationId: convId,
    senderId,
    senderName: "Alice",
    text: "The printer jams",
    timestamp: new Date("2026-03-20T10:00:00Z"),
  };
}

const serviceRequest: ClassifyResult = { categories: ["service_request"], confidence: 0.9 };
const other: ClassifyResult = { categories: ["other"], confidence: 0.7 };

function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    classifier: { classify: vi.fn().mockResolvedValue(other) },
    supportHelp: { execute: vi.fn().mockResolvedValue(false) },
    channelConfig: { get: vi.fn().mockResolvedValue({ timezone: "Europe/Berlin" }), upsert: vi.fn(), setTimezone: vi.fn() },
    messageBuffer: { push: vi.fn(), clear: vi.fn(), getLastN: vi.fn().mockReturnValue([]) },
    botUserId,
    wireOutbound: {
      sendPlainText: vi.fn().mockResolvedValue(undefined),
      sendCompositePrompt: vi.fn(),
      sendButtonConfirmation: vi.fn(),
      closeButtonPrompt: vi.fn(),
      sendReaction: vi.fn(),
      sendFile: vi.fn(),
      withTyping: vi.fn((_conversationId: unknown, work: () => Promise<unknown>) => work()),
      getUserProfile: vi.fn(),
    },
    logger: { child: vi.fn().mockReturnThis(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  } as unknown as PipelineDeps;
}

describe("passive service-desk help", () => {
  it("calls the use case with the job, the channel timezone and the abort signal", async () => {
    const deps = makeDeps({ classifier: { classify: vi.fn().mockResolvedValue(serviceRequest) } });
    const controller = new AbortController();
    await new ProcessingPipeline(deps).process(baseJob(), controller.signal);
    expect(deps.supportHelp.execute).toHaveBeenCalledWith({
      text: "The printer jams", messageId: "msg-1", conversationId: convId, senderId, senderName: "Alice",
      categories: ["service_request"], confidence: 0.9, timezone: "Europe/Berlin", signal: controller.signal,
    });
  });

  it("gives the classifier the recent human messages of the conversation, without the bot's", async () => {
    const deps = makeDeps();
    vi.mocked(deps.messageBuffer.getLastN).mockReturnValue([
      { messageId: "a", senderId, senderName: "Alice", text: "hello", timestamp: new Date() },
      { messageId: "b", senderId: botUserId, senderName: "Wire Support Bot", text: "(Answered the offer above.)", timestamp: new Date() },
      { messageId: "msg-1", senderId: { id: "user-2", domain: "example.com" }, senderName: "", text: "The printer jams", timestamp: new Date() },
    ]);
    await new ProcessingPipeline(deps).process(baseJob());
    expect(deps.messageBuffer.getLastN).toHaveBeenCalledWith(convId, expect.any(Number));
    expect(deps.classifier.classify).toHaveBeenCalledWith("The printer jams", { channelId: "conv-1@example.com" }, ["[Alice] hello", "[user-2] The printer jams"]);
  });

  it("shows the app typing while it drafts help for a recognized service-desk matter", async () => {
    const deps = makeDeps({ classifier: { classify: vi.fn().mockResolvedValue(serviceRequest) } });
    let typing = false;
    vi.mocked(deps.wireOutbound.withTyping).mockImplementation(async (_conversationId, work) => {
      typing = true;
      try { return await work(); } finally { typing = false; }
    });
    vi.mocked(deps.supportHelp.execute).mockImplementation(async () => {
      expect(typing).toBe(true);
      return true;
    });
    await new ProcessingPipeline(deps).process(baseJob());
    expect(deps.wireOutbound.withTyping).toHaveBeenCalledWith(convId, expect.any(Function));
    expect(deps.supportHelp.execute).toHaveBeenCalledOnce();
  });

  it("shows nothing for an update or blocker that is only checked against open requests", async () => {
    const deps = makeDeps({ classifier: { classify: vi.fn().mockResolvedValue({ categories: ["update", "blocker"], confidence: 0.9 }) } });
    await new ProcessingPipeline(deps).process(baseJob());
    expect(deps.supportHelp.execute).toHaveBeenCalled();
    expect(deps.wireOutbound.withTyping).not.toHaveBeenCalled();
  });

  it("is not called without a service-desk, update or blocker category", async () => {
    const deps = makeDeps();
    await new ProcessingPipeline(deps).process(baseJob());
    expect(deps.supportHelp.execute).not.toHaveBeenCalled();
    expect(deps.channelConfig.get).not.toHaveBeenCalled();
  });

  it.each([["request_status"], ["update"], ["blocker"]] as const)("is called for %s", async (category) => {
    const deps = makeDeps({ classifier: { classify: vi.fn().mockResolvedValue({ categories: [category], confidence: 0.9 }) } });
    await new ProcessingPipeline(deps).process(baseJob());
    expect(deps.supportHelp.execute).toHaveBeenCalledWith(expect.objectContaining({ categories: [category] }));
  });

  it("answers without a timezone when the channel config cannot be read", async () => {
    const deps = makeDeps({ classifier: { classify: vi.fn().mockResolvedValue(serviceRequest) } });
    vi.mocked(deps.channelConfig.get).mockRejectedValue(new Error("db down"));
    await new ProcessingPipeline(deps).process(baseJob());
    expect(deps.supportHelp.execute).toHaveBeenCalledWith(expect.objectContaining({ timezone: undefined }));
  });

  it("logs a failure of the use case by error name and never throws", async () => {
    const deps = makeDeps({ classifier: { classify: vi.fn().mockResolvedValue(serviceRequest) } });
    vi.mocked(deps.supportHelp.execute).mockRejectedValue(new TypeError("PRIVATE_MARKER"));
    await expect(new ProcessingPipeline(deps).process(baseJob())).resolves.toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalledWith("Pipeline: passive service-desk help failed", { err: "TypeError" });
    expect(JSON.stringify(vi.mocked(deps.logger.warn).mock.calls)).not.toContain("PRIVATE_MARKER");
    expect(deps.logger.error).not.toHaveBeenCalled();
  });

  it("stops quietly when the classifier fails", async () => {
    const deps = makeDeps({ classifier: { classify: vi.fn().mockRejectedValue(new Error("timeout")) } });
    await new ProcessingPipeline(deps).process(baseJob());
    expect(deps.supportHelp.execute).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith("Pipeline: classify failed", { err: "Error" });
  });

  it("does nothing for a job canceled before it runs", async () => {
    const deps = makeDeps({ classifier: { classify: vi.fn().mockResolvedValue(serviceRequest) } });
    const controller = new AbortController();
    controller.abort();
    await new ProcessingPipeline(deps).process(baseJob(), controller.signal);
    expect(deps.classifier.classify).not.toHaveBeenCalled();
    expect(deps.supportHelp.execute).not.toHaveBeenCalled();
  });

  it("does not call the use case when the job is canceled during classification", async () => {
    const controller = new AbortController();
    const deps = makeDeps({ classifier: { classify: vi.fn(async () => { controller.abort(); return serviceRequest; }) } });
    await new ProcessingPipeline(deps).process(baseJob(), controller.signal);
    expect(deps.supportHelp.execute).not.toHaveBeenCalled();
  });

  it("stores nothing: it has no repository besides the channel timezone read", async () => {
    const deps = makeDeps({ classifier: { classify: vi.fn().mockResolvedValue(serviceRequest) } });
    await new ProcessingPipeline(deps).process(baseJob());
    expect(deps.channelConfig.upsert).not.toHaveBeenCalled();
    expect(deps.channelConfig.setTimezone).not.toHaveBeenCalled();
    expect(deps.messageBuffer.push).not.toHaveBeenCalled();
  });
});
