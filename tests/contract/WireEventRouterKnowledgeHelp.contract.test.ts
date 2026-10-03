/**
 * Contract tests for "Did this help?" after an answer from the document index: the router with the
 * real offer store, the real ConfirmOffer, the real AnswerQuestion and the real question, with a
 * mocked answer model, retrieval source, triage, tracker and ports. No DB, network or SDK.
 */
import { describe, it, expect, vi } from "vitest";
import type { CompositeButtonAction, TextMessage } from "@wireapp/wire-apps-js-sdk";
import { WireEventRouter } from "../../src/infrastructure/wire/WireEventRouter";
import type { WireEventRouterDeps } from "../../src/infrastructure/wire/WireEventRouter";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import { InMemoryMemberCache } from "../../src/infrastructure/services/InMemoryMemberCache";
import { ConfirmOffer } from "../../src/application/usecases/jira/ConfirmOffer";
import type { ConfirmOfferHandlers } from "../../src/application/usecases/jira/ConfirmOffer";
import { AnswerQuestion } from "../../src/application/usecases/general/AnswerQuestion";
import { KnowledgeHelpQuestions } from "../../src/application/services/knowledgeHelpQuestions";
import { DeskUpdateQuestions } from "../../src/application/services/deskUpdateQuestions";
import { sweepEndedOfferPrompts } from "../../src/application/services/offerPromptClosing";
import type { SupportDraft } from "../../src/application/ports/SupportTriagePort";
import type { RetrievalResult } from "../../src/application/ports/RetrievalPort";
import type { CompositeButton, SentMessageRef } from "../../src/application/ports/WireOutboundPort";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import { fakeMetrics } from "../metrics/fakeMetrics";

const convId: QualifiedId = { id: "conv-1", domain: "example.com" };
const alice: QualifiedId = { id: "user-1", domain: "example.com" };
const bob: QualifiedId = { id: "user-2", domain: "example.com" };
const botId: QualifiedId = { id: "bot-1", domain: "example.com" };
const HOURS_4 = 4 * 60 * 60 * 1000;

const PROBLEM = "The engine check light is on and the truck loses power";
const ANSWER = "Stop safely and check the coolant level (Dashboard warning lights, Engine check light).";
const HELP_QUESTION = "Alice, did this help?";
const DRAFT: SupportDraft = {
  requestKind: "fault", summary: "Engine check light on, truck loses power", description: "The engine check light is on and the truck loses power.",
  duplicateOf: null, addition: null, resolves: null, closingComment: null,
};
const RAISE_QUESTION = "Shall I report this to the service desk?\n> **Engine check light on, truck loses power**\n> The engine check light is on and the truck loses power.";
const ARTICLE: RetrievalResult = {
  id: "chunk-1", type: "knowledge_article", content: "Engine check light: stop safely and check the coolant.",
  source: "Dashboard warning lights, Engine check light", sourceDate: new Date(),
};

function setup() {
  const fake = fakeMetrics();
  const pendingOffers = new InMemoryPendingOfferStore(fake.metrics);
  const memberCache = new InMemoryMemberCache();
  memberCache.setMembers(convId, [
    { userId: alice, role: "member", name: "Alice" },
    { userId: bob, role: "member", name: "Bob" },
  ]);
  let sentCount = 0;
  const prompts: Array<{ messageId: string; text: string; buttons: CompositeButton[]; replyTo?: string }> = [];
  const wireOutbound = {
    sendPlainText: vi.fn(async (): Promise<SentMessageRef> => ({ messageId: `text-msg-${++sentCount}`, sha256: "a".repeat(64) })),
    sendCompositePrompt: vi.fn(async (_c: QualifiedId, text: string, buttons: CompositeButton[], options?: { replyToMessageId?: string }): Promise<SentMessageRef> => {
      const messageId = `prompt-msg-${++sentCount}`;
      prompts.push({ messageId, text, buttons, ...(options?.replyToMessageId ? { replyTo: options.replyToMessageId } : {}) });
      return { messageId, sha256: "b".repeat(64) };
    }),
    sendButtonConfirmation: vi.fn().mockResolvedValue(undefined),
    closeButtonPrompt: vi.fn().mockResolvedValue(undefined),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    getUserProfile: vi.fn().mockResolvedValue(null),
    withTyping: <T>(_c: QualifiedId, work: () => Promise<T>): Promise<T> => work(),
  };
  const logger = { child: vi.fn().mockReturnThis(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const tracker = {
    projectKey: "SD", createIssue: vi.fn(), getIssue: vi.fn(), resolveIssue: vi.fn(), listCustomerReplies: vi.fn(), addCustomerReply: vi.fn(),
  };
  const requests = {
    findByKey: vi.fn(async () => null), listByConversation: vi.fn(async () => []), setLastMessage: vi.fn(), updateStatusCategory: vi.fn(),
  };
  const audit = { append: vi.fn() };
  const general = { answer: vi.fn().mockResolvedValue(ANSWER) };
  const retrieval = { retrieve: vi.fn().mockResolvedValue([ARTICLE]) };
  const triage = { draftRequest: vi.fn().mockResolvedValue(DRAFT), matchStatusQuestion: vi.fn(), extractPartDetails: vi.fn() };
  const knowledgeHelp = new KnowledgeHelpQuestions({ offers: pendingOffers, wireOutbound, triage, lifetimeMs: HOURS_4, logger });
  const answerQuestion = new AnswerQuestion(general, wireOutbound, {
    tracker: tracker as never, requests: requests as never, auditLog: audit, offers: pendingOffers, shareWithModel: false, knowledgeHelp,
  }, retrieval, logger);
  const handlers = {
    raiseSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
    replyToServiceDesk: { execute: vi.fn().mockResolvedValue(true) },
    resolveSupportRequest: { execute: vi.fn().mockResolvedValue(undefined) },
  };
  const confirmOffer = new ConfirmOffer(
    pendingOffers, handlers as unknown as ConfirmOfferHandlers, wireOutbound, undefined, undefined, [], logger, fake.metrics,
  );
  const deps = {
    logger,
    answerQuestion,
    botUserId: botId,
    wireOutbound,
    messageBuffer: { clear: vi.fn(), push: vi.fn(), getLastN: vi.fn().mockReturnValue([]) },
    memberCache,
    channelConfig: { get: vi.fn().mockResolvedValue(null), upsert: vi.fn(), setTimezone: vi.fn() },
    raiseSupportRequest: handlers.raiseSupportRequest,
    completePartOrder: { execute: vi.fn().mockResolvedValue(false) },
    listSupportRequests: { execute: vi.fn() },
    resolveSupportRequest: handlers.resolveSupportRequest,
    replyToServiceDesk: handlers.replyToServiceDesk,
    getIssueStatus: { execute: vi.fn().mockResolvedValue(undefined), projectKey: "SD" },
    pendingOffers,
    confirmOffer,
    supportWelcome: { projectKey: "SD", passive: false, watching: false },
  } as unknown as WireEventRouterDeps;
  const router = new WireEventRouter(deps);

  /** Alice describes a problem to the bot; returns the question's message and button IDs. */
  const askHelp = async (): Promise<{ messageId: string; buttons: string[] }> => {
    await router.onTextMessageReceived(command(alice, PROBLEM));
    const prompt = prompts.at(-1)!;
    expect(prompt.text).toBe(HELP_QUESTION);
    return { messageId: prompt.messageId, buttons: prompt.buttons.map((b) => b.id) };
  };
  const texts = (): string[] => wireOutbound.sendPlainText.mock.calls.map((call) => (call as unknown[])[1] as string);
  const closes = (): Array<[string, string]> => wireOutbound.closeButtonPrompt.mock.calls.map((call) => [call[1] as string, call[2] as string]);
  /** Nothing was raised or written to Jira. */
  const nothingWritten = (): void => {
    expect(handlers.raiseSupportRequest.execute).not.toHaveBeenCalled();
    expect(tracker.createIssue).not.toHaveBeenCalled();
  };
  const helpOutcomes = () => fake.of("knowledgeHelpAnswer").map((args) => args[0]);
  const handledRoutes = () => logger.debug.mock.calls.filter((call) => call[0] === "Message handled").map((call) => (call[1] as { route?: string }).route);
  return {
    router, pendingOffers, handlers, wireOutbound, prompts, askHelp, texts, closes, nothingWritten, helpOutcomes, handledRoutes, logger,
    triage, general, tracker,
  };
}

let eventCount = 0;
function click(sender: QualifiedId, buttonId: string, referenceMessageId: string): CompositeButtonAction {
  eventCount += 1;
  return { type: "composite_button_action", id: `click-${eventCount}`, conversationId: convId, sender, buttonId, referenceMessageId };
}

/** A text addressed to the bot by a leading mention. */
function command(sender: QualifiedId, body: string): TextMessage {
  eventCount += 1;
  const label = "@Wire Support Bot";
  return {
    type: "text", id: `command-${eventCount}`, text: `${label} ${body}`, conversationId: convId, sender, timestamp: new Date(),
    mentions: [{ userId: botId, offset: 0, length: label.length }],
  } as TextMessage;
}

function text(sender: QualifiedId, body: string): TextMessage {
  eventCount += 1;
  return { type: "text", id: `text-${eventCount}`, text: body, conversationId: convId, sender, timestamp: new Date() };
}

describe("WireEventRouter contract: \"Did this help?\" after an answer from the document index", () => {
  it("asks the member under the answer, as a reply to their message, with [Solved] [Raise a ticket]", async () => {
    const ctx = setup();
    await ctx.askHelp();
    expect(ctx.texts()).toEqual([ANSWER]);
    expect(ctx.prompts).toHaveLength(1);
    expect(ctx.prompts[0]!.buttons.map((b) => b.label)).toEqual(["Solved", "Raise a ticket"]);
    expect(ctx.prompts[0]!.replyTo).toMatch(/^command-/);
    expect(ctx.wireOutbound.sendPlainText.mock.invocationCallOrder[0]!).toBeLessThan(ctx.wireOutbound.sendCompositePrompt.mock.invocationCallOrder[0]!);
    expect(ctx.triage.draftRequest).toHaveBeenCalledExactlyOnceWith(PROBLEM, []);
    expect(ctx.pendingOffers.find(convId, alice)?.knowledgeHelp).toBe(true);
  });

  it("[Solved] closes the question, confirms the click and does nothing else", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ctx.askHelp();
    await ctx.router.onButtonClicked(click(alice, buttons[0]!, messageId));
    expect(ctx.wireOutbound.sendButtonConfirmation).toHaveBeenCalledExactlyOnceWith(convId, messageId, buttons[0]);
    expect(ctx.closes()).toEqual([[messageId, `${HELP_QUESTION}\n\nAnswered by Alice: Solved`]]);
    expect(ctx.texts()).toEqual([ANSWER]);
    expect(ctx.prompts).toHaveLength(1);
    expect(ctx.pendingOffers.has(convId, alice)).toBe(false);
    expect(ctx.helpOutcomes()).toEqual(["solved"]);
    ctx.nothingWritten();
  });

  it("[Raise a ticket] closes the question and offers the problem with [Yes] [No]; nothing is raised before the yes", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ctx.askHelp();
    await ctx.router.onButtonClicked(click(alice, buttons[1]!, messageId));
    expect(ctx.closes()).toEqual([[messageId, `${HELP_QUESTION}\n\nAnswered by Alice: Raise a ticket`]]);
    const offer = ctx.prompts.at(-1)!;
    expect(offer.text).toBe(RAISE_QUESTION);
    expect(offer.buttons.map((b) => b.label)).toEqual(["Yes", "No"]);
    expect(ctx.helpOutcomes()).toEqual(["ticket"]);
    ctx.nothingWritten();

    await ctx.router.onButtonClicked(click(alice, offer.buttons[0]!.id, offer.messageId));
    expect(ctx.handlers.raiseSupportRequest.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      summary: DRAFT.summary, description: DRAFT.description, requestKind: "fault", conversationId: convId, requesterId: alice, requesterName: "Alice",
    }));
    expect(ctx.closes().at(-1)).toEqual([offer.messageId, `${RAISE_QUESTION}\n\nAnswered by Alice: Yes`]);
  });

  it("a no to the raise offer after [Raise a ticket] raises nothing", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ctx.askHelp();
    await ctx.router.onButtonClicked(click(alice, buttons[1]!, messageId));
    await ctx.router.onTextMessageReceived(text(alice, "no"));
    expect(ctx.texts().at(-1)).toBe("Understood, I won't.");
    ctx.nothingWritten();
  });

  it("another member's click changes nothing and gets one notice; Alice still decides", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ctx.askHelp();
    await ctx.router.onButtonClicked(click(bob, buttons[1]!, messageId));
    await ctx.router.onButtonClicked(click(bob, buttons[0]!, messageId));
    expect(ctx.texts()).toEqual([ANSWER, "Only Alice can answer this."]);
    expect(ctx.wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
    expect(ctx.closes()).toEqual([]);
    expect(ctx.prompts).toHaveLength(1);

    await ctx.router.onButtonClicked(click(alice, buttons[0]!, messageId));
    expect(ctx.closes()).toEqual([[messageId, `${HELP_QUESTION}\n\nAnswered by Alice: Solved`]]);
    ctx.nothingWritten();
  });

  it("the first click decides: a repeated or changed click and a late click by anyone change nothing and get no answer", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ctx.askHelp();
    await ctx.router.onButtonClicked(click(alice, buttons[0]!, messageId));
    await ctx.router.onButtonClicked(click(alice, buttons[0]!, messageId));
    await ctx.router.onButtonClicked(click(alice, buttons[1]!, messageId));
    await ctx.router.onButtonClicked(click(bob, buttons[1]!, messageId));
    expect(ctx.wireOutbound.sendButtonConfirmation).toHaveBeenCalledOnce();
    expect(ctx.closes()).toHaveLength(1);
    expect(ctx.texts()).toEqual([ANSWER]);
    expect(ctx.prompts).toHaveLength(1);
    ctx.nothingWritten();
  });

  it.each(["solved", "yes", "it helped", "thanks", "Thanks!"])("the text answer %j closes it as solved", async (answer) => {
    const ctx = setup();
    const { messageId } = await ctx.askHelp();
    await ctx.router.onTextMessageReceived(text(alice, answer));
    expect(ctx.closes()).toEqual([[messageId, `${HELP_QUESTION}\n\nAnswered by Alice: Solved`]]);
    expect(ctx.texts()).toEqual([ANSWER]);
    expect(ctx.prompts).toHaveLength(1);
    expect(ctx.helpOutcomes()).toEqual(["solved"]);
    expect(ctx.handledRoutes().at(-1)).toBe("knowledge_help_answer");
    ctx.nothingWritten();
  });

  it.each(["raise a ticket", "ticket", "no", "still broken"])("the text answer %j chooses a ticket and leads to the raise offer", async (answer) => {
    const ctx = setup();
    const { messageId } = await ctx.askHelp();
    await ctx.router.onTextMessageReceived(text(alice, answer));
    expect(ctx.closes()).toEqual([[messageId, `${HELP_QUESTION}\n\nAnswered by Alice: Raise a ticket`]]);
    expect(ctx.prompts.at(-1)!.text).toBe(RAISE_QUESTION);
    expect(ctx.helpOutcomes()).toEqual(["ticket"]);
    expect(ctx.handledRoutes().at(-1)).toBe("knowledge_help_answer");
    ctx.nothingWritten();

    await ctx.router.onTextMessageReceived(text(alice, "yes"));
    expect(ctx.handlers.raiseSupportRequest.execute).toHaveBeenCalledOnce();
  });

  it("another member's text answer is not an answer to Alice's question", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ctx.askHelp();
    await ctx.router.onTextMessageReceived(text(bob, "ticket"));
    expect(ctx.closes()).toEqual([]);
    await ctx.router.onButtonClicked(click(alice, buttons[0]!, messageId));
    expect(ctx.closes()).toEqual([[messageId, `${HELP_QUESTION}\n\nAnswered by Alice: Solved`]]);
  });

  it("a text answer decides, so a click after it changes nothing", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ctx.askHelp();
    await ctx.router.onTextMessageReceived(text(alice, "solved"));
    await ctx.router.onButtonClicked(click(alice, buttons[1]!, messageId));
    expect(ctx.wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
    expect(ctx.closes()).toHaveLength(1);
    expect(ctx.prompts).toHaveLength(1);
    ctx.nothingWritten();
  });

  it("a click decides, so a text answer after it is an ordinary message", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ctx.askHelp();
    await ctx.router.onButtonClicked(click(alice, buttons[0]!, messageId));
    await ctx.router.onTextMessageReceived(text(alice, "ticket"));
    expect(ctx.closes()).toHaveLength(1);
    expect(ctx.prompts).toHaveLength(1);
    expect(ctx.helpOutcomes()).toEqual(["solved"]);
    ctx.nothingWritten();
  });

  it("any other message from the member ends the question without a decision", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ctx.askHelp();
    await ctx.router.onTextMessageReceived(text(alice, "let me check the coolant first"));
    expect(ctx.closes()).toEqual([[messageId, `${HELP_QUESTION}\n\nClosed, as the next message was not an answer.`]]);
    expect(ctx.pendingOffers.has(convId, alice)).toBe(false);
    expect(ctx.helpOutcomes()).toEqual(["ended"]);
    await ctx.router.onButtonClicked(click(alice, buttons[1]!, messageId));
    expect(ctx.wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
    expect(ctx.prompts).toHaveLength(1);
    ctx.nothingWritten();
  });

  it("expires after its lifetime: the sweep closes it, and a late click changes nothing", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ctx.askHelp();
    await sweepEndedOfferPrompts({ offers: ctx.pendingOffers, wireOutbound: ctx.wireOutbound }, new Date(Date.now() + HOURS_4 + 1000));
    expect(ctx.closes()).toEqual([[messageId, `${HELP_QUESTION}\n\nThis question has expired.`]]);
    expect(ctx.helpOutcomes()).toEqual(["expired"]);
    await ctx.router.onButtonClicked(click(alice, buttons[1]!, messageId));
    expect(ctx.wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
    expect(ctx.texts()).toEqual([ANSWER]);
    ctx.nothingWritten();
  });

  it("is replaced by a newer question to the member, such as one after a desk update", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ctx.askHelp();
    const request: SupportRequest = {
      key: "SD-6", conversationId: convId, requesterId: alice, requesterName: "Alice", summary: "VPN drops", kind: "fault",
      statusCategory: "in_progress", createdAt: new Date(), updatedAt: new Date(), deleted: false, version: 1,
    };
    const questions = new DeskUpdateQuestions({ offers: ctx.pendingOffers, wireOutbound: ctx.wireOutbound, lifetimeMs: HOURS_4 });
    expect(await questions.ask(request, "reply")).toBe(true);
    expect(ctx.closes()).toEqual([[messageId, `${HELP_QUESTION}\n\nThis question was replaced by a newer one.`]]);
    expect(ctx.helpOutcomes()).toEqual(["ended"]);
    await ctx.router.onButtonClicked(click(alice, buttons[1]!, messageId));
    expect(ctx.wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
    ctx.nothingWritten();
  });

  it("logs no text and no names", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ctx.askHelp();
    await ctx.router.onButtonClicked(click(alice, buttons[1]!, messageId));
    const logged = JSON.stringify([ctx.logger.debug.mock.calls, ctx.logger.info.mock.calls, ctx.logger.warn.mock.calls]);
    for (const secret of ["Alice", "engine", "Engine", "coolant"]) expect(logged).not.toContain(secret);
    const click_ = ctx.logger.debug.mock.calls.find((call) => call[0] === "Message handled" && (call[1] as { kind?: string }).kind === "button_click");
    expect(click_?.[1]).toEqual(expect.objectContaining({ route: "accepted", question: "knowledge_help" }));
  });
});
