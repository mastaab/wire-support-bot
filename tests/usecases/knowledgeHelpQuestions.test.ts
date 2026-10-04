import { describe, it, expect, vi } from "vitest";
import { AnswerQuestion } from "../../src/application/usecases/general/AnswerQuestion";
import {
  KnowledgeHelpQuestions, faultCommand, knowledgeHelpChoices, knowledgeHelpQuestion,
} from "../../src/application/services/knowledgeHelpQuestions";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import { matchChoice, withoutAnswerHint } from "../../src/application/services/offerButtons";
import type { SupportDraft } from "../../src/application/ports/SupportTriagePort";
import type { RetrievalResult } from "../../src/application/ports/RetrievalPort";
import type { CompositeButton, SentMessageRef } from "../../src/application/ports/WireOutboundPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const conversationId: QualifiedId = { id: "channel", domain: "wire.test" };
const bob: QualifiedId = { id: "bob", domain: "wire.test" };
const requester = { ...bob, name: "Bob" };
const HOURS_4 = 4 * 60 * 60 * 1000;
const FAULT: SupportDraft = {
  requestKind: "fault", summary: "Truck 12 will not start", description: "Truck 12 will not start after refueling.",
  duplicateOf: null, addition: null, resolves: null, closingComment: null,
};
const ARTICLE: RetrievalResult = { id: "chunk-1", type: "knowledge_article", content: "Check the fuel filter.", source: "Engine manual, Starting", sourceDate: new Date() };
const STORED: RetrievalResult = { id: "SD-1", type: "support_request", content: "SD-1 | Summary: VPN", sourceDate: new Date() };

function wire() {
  let count = 0;
  return {
    sendPlainText: vi.fn(async (): Promise<SentMessageRef> => ({ messageId: `text-${++count}`, sha256: "a".repeat(64) })),
    sendCompositePrompt: vi.fn(async (_c: QualifiedId, _t: string, _b: CompositeButton[]): Promise<SentMessageRef> => ({ messageId: `prompt-${++count}`, sha256: "b".repeat(64) })),
    closeButtonPrompt: vi.fn().mockResolvedValue(undefined),
  };
}

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
}

describe("knowledgeHelpQuestion and its options", () => {
  it("names the member and loses its text answer hint when sent with buttons", () => {
    expect(withoutAnswerHint(knowledgeHelpQuestion("Bob"))).toBe("Bob, did this help?");
    expect(withoutAnswerHint(knowledgeHelpQuestion())).toBe("Did this help?");
  });

  it("[Solved] runs nothing; [Raise a ticket] offers the drafted request, never raises it directly", () => {
    const command = faultCommand(FAULT)!;
    const [solved, ticket] = knowledgeHelpChoices(command);
    expect(solved).toEqual(expect.objectContaining({ label: "Solved", command: null }));
    expect(solved!.then).toBeUndefined();
    expect(ticket).toEqual(expect.objectContaining({ label: "Raise a ticket", command: null, then: { kind: "offerRaise", command } }));
  });

  it.each([
    ["solved", 0], ["yes", 0], ["it helped", 0], ["thanks", 0], ["Thank you!", 0], ["1", 0],
    ["raise a ticket", 1], ["ticket", 1], ["no", 1], ["still broken", 1], ["2", 1],
    ["maybe later", null], ["ok", null],
  ])("the text answer %j picks %s", (answer, index) => {
    expect(matchChoice(knowledgeHelpChoices(faultCommand(FAULT)!), answer)).toBe(index);
  });
});

describe("faultCommand", () => {
  it("turns a fault draft into a support offer", () => {
    expect(faultCommand(FAULT)).toEqual({ kind: "support", requestKind: "fault", summary: FAULT.summary, description: FAULT.description });
  });

  it.each([
    ["no draft", null],
    ["a question to the desk", { ...FAULT, requestKind: "question" as const }],
    ["a part order", { ...FAULT, requestKind: "part" as const }],
    ["a resolve", { ...FAULT, resolves: "SD-1" }],
    ["an empty summary", { ...FAULT, summary: " " }],
    ["a summary over 120 characters", { ...FAULT, summary: "x".repeat(121) }],
    ["a description over 1,000 characters", { ...FAULT, description: "x".repeat(1001) }],
  ])("is null for %s", (_label, draft) => {
    expect(faultCommand(draft as SupportDraft | null)).toBeNull();
  });
});

describe("KnowledgeHelpQuestions", () => {
  function setup(draft: SupportDraft | null = FAULT) {
    const offers = new InMemoryPendingOfferStore();
    const wireOutbound = wire();
    const triage = { draftRequest: vi.fn().mockResolvedValue(draft) };
    const log = logger();
    const now = new Date("2026-10-03T10:00:00Z");
    const questions = new KnowledgeHelpQuestions({ offers, wireOutbound: wireOutbound as never, triage, lifetimeMs: HOURS_4, logger: log, now: () => now });
    const ask = () => questions.ask({ message: "Truck 12 will not start", conversationId, requesterId: bob, requesterName: "Bob", replyToMessageId: "m-1" });
    return { offers, wireOutbound, triage, log, now, ask };
  }

  it("asks for a fault, as a reply to the member's message, and stores the question for the member's question slot", async () => {
    const { offers, wireOutbound, triage, now, ask } = setup();
    expect(await ask()).toBe(true);
    expect(triage.draftRequest).toHaveBeenCalledExactlyOnceWith("Truck 12 will not start", []);
    expect(wireOutbound.sendCompositePrompt).toHaveBeenCalledExactlyOnceWith(
      conversationId, "Bob, did this help?", [expect.objectContaining({ label: "Solved" }), expect.objectContaining({ label: "Raise a ticket" })],
      { replyToMessageId: "m-1" },
    );
    const stored = offers.find(conversationId, bob, now)!;
    expect(stored).toEqual(expect.objectContaining({
      knowledgeHelp: true, command: faultCommand(FAULT), messageId: "prompt-1", question: "Bob, did this help?",
      expiresAt: new Date(now.getTime() + HOURS_4),
    }));
    expect(stored.deskUpdate).toBeUndefined();
  });

  it.each([
    ["the triage drafts nothing", null],
    ["the message asks the desk a question", { ...FAULT, requestKind: "question" as const }],
    ["the message orders a part", { ...FAULT, requestKind: "part" as const }],
  ])("asks nothing when %s", async (_label, draft) => {
    const { wireOutbound, offers, now, ask } = setup(draft);
    expect(await ask()).toBe(false);
    expect(wireOutbound.sendCompositePrompt).not.toHaveBeenCalled();
    expect(offers.has(conversationId, bob, now)).toBe(false);
  });

  it("asks nothing when the triage fails, logging the error name only", async () => {
    const { triage, wireOutbound, log, ask } = setup();
    triage.draftRequest.mockRejectedValue(new TypeError("PRIVATE_MARKER"));
    expect(await ask()).toBe(false);
    expect(wireOutbound.sendCompositePrompt).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("KnowledgeHelpQuestions: draftRequest failed", { err: "TypeError" });
  });

  it("asks nothing over the member's other open question, without a model call", async () => {
    const { offers, triage, wireOutbound, now, ask } = setup();
    offers.put({ command: { kind: "resolve", issueKey: "SD-1" }, conversationId, requesterId: bob, createdAt: now, expiresAt: new Date(now.getTime() + 600_000) });
    expect(await ask()).toBe(false);
    expect(triage.draftRequest).not.toHaveBeenCalled();
    expect(wireOutbound.sendCompositePrompt).not.toHaveBeenCalled();
    expect(offers.find(conversationId, bob, now)?.command).toEqual({ kind: "resolve", issueKey: "SD-1" });
  });

  it("replaces a question after a desk update, closing it as replaced", async () => {
    const { offers, wireOutbound, now, ask } = setup();
    offers.put({
      command: { kind: "resolve", issueKey: "SD-1" }, conversationId, requesterId: bob, createdAt: now, expiresAt: new Date(now.getTime() + HOURS_4),
      id: "desk-1", messageId: "desk-msg", question: "Bob, is **SD-1** solved for you, or is it still broken?", choices: [],
      deskUpdate: { issueKey: "SD-1", summary: "VPN" },
    });
    expect(await ask()).toBe(true);
    expect(wireOutbound.closeButtonPrompt).toHaveBeenCalledWith(
      conversationId, "desk-msg", "Bob, is **SD-1** solved for you, or is it still broken?\n\nThis question was replaced by a newer one.",
    );
    expect(offers.find(conversationId, bob, now)?.knowledgeHelp).toBe(true);
  });

  it("closes its own message at once when another question was asked while it was sent", async () => {
    const { offers, wireOutbound, now, ask } = setup();
    wireOutbound.sendCompositePrompt.mockImplementationOnce(async () => {
      offers.put({ command: { kind: "resolve", issueKey: "SD-1" }, conversationId, requesterId: bob, createdAt: now, expiresAt: new Date(now.getTime() + 600_000) });
      return { messageId: "prompt-x", sha256: "b".repeat(64) };
    });
    expect(await ask()).toBe(false);
    expect(wireOutbound.closeButtonPrompt).toHaveBeenCalledWith(conversationId, "prompt-x", "Bob, did this help?\n\nThis question was replaced by a newer one.");
    expect(offers.find(conversationId, bob, now)?.command).toEqual({ kind: "resolve", issueKey: "SD-1" });
  });

  it("logs no message text and no names", async () => {
    const { log, ask } = setup({ ...FAULT, requestKind: "question" });
    await ask();
    const logged = JSON.stringify([log.debug.mock.calls, log.warn.mock.calls]);
    expect(logged).not.toContain("Truck");
    expect(logged).not.toContain("Bob");
  });
});

describe("AnswerQuestion: when \"Did this help?\" is asked", () => {
  function desk(offers: InMemoryPendingOfferStore, knowledgeHelp?: { ask: ReturnType<typeof vi.fn> }) {
    return {
      tracker: { projectKey: "SD", createIssue: vi.fn(), getIssue: vi.fn(), resolveIssue: vi.fn(), listCustomerReplies: vi.fn(), addCustomerReply: vi.fn() },
      requests: { findByKey: vi.fn(async () => null), listByConversation: vi.fn(async () => []), setLastMessage: vi.fn(), updateStatusCategory: vi.fn() },
      auditLog: { append: vi.fn() },
      offers,
      shareWithModel: false,
      ...(knowledgeHelp ? { knowledgeHelp } : {}),
    } as never;
  }

  async function answer(options: {
    question?: string; reply?: string; results?: RetrievalResult[]; helpOn?: boolean; retrieval?: boolean; amendOnly?: boolean;
  } = {}) {
    const offers = new InMemoryPendingOfferStore();
    const help = { ask: vi.fn().mockResolvedValue(true) };
    const general = { answer: vi.fn().mockResolvedValue(options.reply ?? "Check the fuel filter (Engine manual, Starting).") };
    const wireOutbound = wire();
    const retrieval = options.retrieval === false ? undefined : { retrieve: vi.fn().mockResolvedValue(options.results ?? [ARTICLE]) };
    const result = await new AnswerQuestion(general, wireOutbound as never, desk(offers, options.helpOn === false ? undefined : help), retrieval, logger()).execute({
      question: options.question ?? "Truck 12 will not start after refueling", requester, conversationContext: [], conversationId,
      replyToMessageId: "m-1", members: [requester], ...(options.amendOnly ? { amendOnly: true } : {}),
    });
    return { help, offers, wireOutbound, result, general };
  }

  it("asks after an answer that used a knowledge article, for the member who asked, after the answer was sent", async () => {
    const { help, wireOutbound } = await answer();
    expect(help.ask).toHaveBeenCalledExactlyOnceWith({
      message: "Truck 12 will not start after refueling", conversationId, requesterId: bob, requesterName: "Bob", replyToMessageId: "m-1",
    });
    expect(wireOutbound.sendPlainText.mock.invocationCallOrder[0]!).toBeLessThan(help.ask.mock.invocationCallOrder[0]!);
  });

  it("does not ask when no knowledge article went into the answer", async () => {
    expect((await answer({ results: [] })).help.ask).not.toHaveBeenCalled();
    expect((await answer({ results: [STORED] })).help.ask).not.toHaveBeenCalled();
  });

  it("does not ask without a retrieval source or with the document index off", async () => {
    expect((await answer({ retrieval: false })).help.ask).not.toHaveBeenCalled();
    const off = await answer({ helpOn: false });
    expect(off.wireOutbound.sendCompositePrompt).not.toHaveBeenCalled();
    expect(off.offers.has(conversationId, bob)).toBe(false);
  });

  it.each([
    "How do I reset the engine check light?",
    "hi, how can I check the coolant level?",
    "Is SD-12 still open?",
  ])("does not ask for %j (a how-to question or a message about a named request)", async (question) => {
    expect((await answer({ question })).help.ask).not.toHaveBeenCalled();
  });

  it("does not ask when the answer made an offer", async () => {
    const reply = 'I can raise that.\nOFFER: {"kind":"support","requestKind":"fault","summary":"Truck 12 will not start","description":"Truck 12 will not start."}';
    const { help, wireOutbound } = await answer({ question: "Truck 12 will not start, please raise a ticket", reply });
    expect(wireOutbound.sendCompositePrompt).toHaveBeenCalledOnce();
    expect(help.ask).not.toHaveBeenCalled();
  });

  it("does not ask when the model proposed an offer that code dropped", async () => {
    const reply = 'Done.\nOFFER: {"kind":"resolve","issueKey":"SD-99"}';
    const { help } = await answer({ reply });
    expect(help.ask).not.toHaveBeenCalled();
  });

  it("does not ask while the member has another open question (the real question and store)", async () => {
    const offers = new InMemoryPendingOfferStore();
    const now = new Date();
    offers.put({ command: { kind: "resolve", issueKey: "SD-1" }, conversationId, requesterId: bob, createdAt: now, expiresAt: new Date(now.getTime() + 600_000) });
    const wireOutbound = wire();
    const triage = { draftRequest: vi.fn().mockResolvedValue(FAULT) };
    const knowledgeHelp = new KnowledgeHelpQuestions({ offers, wireOutbound: wireOutbound as never, triage, lifetimeMs: HOURS_4 });
    const general = { answer: vi.fn().mockResolvedValue("Check the fuel filter.") };
    const retrieval = { retrieve: vi.fn().mockResolvedValue([ARTICLE]) };
    await new AnswerQuestion(general, wireOutbound as never, { ...(desk(offers) as object), knowledgeHelp } as never, retrieval).execute({
      question: "Truck 12 will not start after refueling", requester, conversationContext: [], conversationId, replyToMessageId: "m-1",
    });
    expect(wireOutbound.sendPlainText).toHaveBeenCalledOnce();
    expect(wireOutbound.sendCompositePrompt).not.toHaveBeenCalled();
    expect(triage.draftRequest).not.toHaveBeenCalled();
  });

  it("keeps the answer when asking fails", async () => {
    const offers = new InMemoryPendingOfferStore();
    const help = { ask: vi.fn().mockRejectedValue(new TypeError("boom")) };
    const general = { answer: vi.fn().mockResolvedValue("Check the fuel filter.") };
    const result = await new AnswerQuestion(general, wire() as never, desk(offers, help), { retrieve: vi.fn().mockResolvedValue([ARTICLE]) }).execute({
      question: "Truck 12 will not start", requester, conversationContext: [], conversationId, replyToMessageId: "m-1",
    });
    expect(result).toBe("Check the fuel filter.\n\nSource: Engine manual, Starting");
  });
});
