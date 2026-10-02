/**
 * Contract tests for the satisfaction rating after a solved request: the router with the real offer
 * store, the real ConfirmOffer, the real desk-update and rating questions, the real resolve and the
 * real SubmitFeedback, with a mocked tracker, repository and ports. No DB, network or SDK.
 */
import { describe, it, expect, vi } from "vitest";
import type { CompositeButtonAction, TextMessage } from "@wireapp/wire-apps-js-sdk";
import { WireEventRouter } from "../../src/infrastructure/wire/WireEventRouter";
import type { WireEventRouterDeps } from "../../src/infrastructure/wire/WireEventRouter";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import { InMemoryMemberCache } from "../../src/infrastructure/services/InMemoryMemberCache";
import { ConfirmOffer } from "../../src/application/usecases/jira/ConfirmOffer";
import type { ConfirmOfferHandlers } from "../../src/application/usecases/jira/ConfirmOffer";
import { DeskUpdateQuestions, type DeskUpdateKind } from "../../src/application/services/deskUpdateQuestions";
import { FeedbackQuestions } from "../../src/application/services/feedbackQuestions";
import { FEEDBACK_FAILED, SubmitFeedback } from "../../src/application/usecases/jira/SubmitFeedback";
import { ResolveSupportRequest } from "../../src/application/usecases/jira/ResolveSupportRequest";
import { SupportRequestWrites } from "../../src/application/services/SupportRequestWrites";
import { AnswerQuestion } from "../../src/application/usecases/general/AnswerQuestion";
import { OfferSupportFromConversation } from "../../src/application/usecases/jira/OfferSupportFromConversation";
import type { GetIssueStatus } from "../../src/application/usecases/jira/GetIssueStatus";
import type { SupportDraft } from "../../src/application/ports/SupportTriagePort";
import { IssueTrackerError } from "../../src/application/ports/IssueTrackerPort";
import type { IssueSnapshot } from "../../src/application/ports/IssueTrackerPort";
import type { CompositeButton, SentMessageRef } from "../../src/application/ports/WireOutboundPort";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const convId: QualifiedId = { id: "conv-1", domain: "example.com" };
const alice: QualifiedId = { id: "user-1", domain: "example.com" };
const bob: QualifiedId = { id: "user-2", domain: "example.com" };
const botId: QualifiedId = { id: "bot-1", domain: "example.com" };
const HOURS_4 = 4 * 60 * 60 * 1000;

const REQUEST: SupportRequest = {
  key: "SD-6", conversationId: convId, requesterId: alice, requesterName: "Alice", summary: "VPN drops every ten minutes",
  kind: "fault", statusCategory: "in_progress", createdAt: new Date("2026-10-01T09:00:00Z"), updatedAt: new Date("2026-10-01T09:00:00Z"),
  deleted: false, version: 1,
};

const RESOLVED_QUESTION = "Alice, is **SD-6** solved for you, or is it still broken?";
const REPLY_QUESTION = "Alice, would you like to reply to the service desk about **SD-6**, or is it solved so I can close it?";
const RATING_QUESTION = "Alice, how did the service desk do on **SD-6**? 1 is poor, 5 is great.";
const DONE: IssueSnapshot = { key: "SD-6", url: "https://jira.test/browse/SD-6", summary: REQUEST.summary, statusCategory: "done", slas: [] };

function setup(options: { feedback?: boolean } = {}) {
  const pendingOffers = new InMemoryPendingOfferStore();
  const memberCache = new InMemoryMemberCache();
  memberCache.setMembers(convId, [
    { userId: alice, role: "member", name: "Alice" },
    { userId: bob, role: "member", name: "Bob" },
  ]);
  let sentCount = 0;
  const prompts: Array<{ messageId: string; text: string; buttons: CompositeButton[] }> = [];
  const wireOutbound = {
    sendPlainText: vi.fn(async (): Promise<SentMessageRef> => ({ messageId: `text-msg-${++sentCount}`, sha256: "a".repeat(64) })),
    sendCompositePrompt: vi.fn(async (_c: QualifiedId, text: string, buttons: CompositeButton[]): Promise<SentMessageRef> => {
      const messageId = `prompt-msg-${++sentCount}`;
      prompts.push({ messageId, text, buttons });
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
  const requests = {
    findByKey: vi.fn(async (key: string) => (key === REQUEST.key ? { ...REQUEST } : null)),
    updateStatusCategory: vi.fn(async (key: string, statusCategory: SupportRequest["statusCategory"]) => (key === REQUEST.key ? { ...REQUEST, statusCategory } : null)),
    setLastMessage: vi.fn().mockResolvedValue(undefined),
    listByConversation: vi.fn(async () => [{ ...REQUEST }]),
  };
  const tracker = {
    projectKey: "SD",
    submitFeedback: vi.fn().mockResolvedValue(undefined),
    resolveIssue: vi.fn(async (): Promise<IssueSnapshot> => DONE),
    getIssue: vi.fn(async (): Promise<IssueSnapshot | null> => DONE),
    addCustomerReply: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const feedback = options.feedback === false ? undefined : {
    questions: new FeedbackQuestions({ offers: pendingOffers, wireOutbound, lifetimeMs: HOURS_4, logger }),
    submit: new SubmitFeedback(requests as never, tracker as never, wireOutbound, audit, logger),
  };
  const resolveSupportRequest = new ResolveSupportRequest(
    requests as never, tracker as never, wireOutbound, audit, logger, new SupportRequestWrites(), feedback?.questions,
  );
  vi.spyOn(resolveSupportRequest, "execute");
  const handlers = {
    raiseSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
    replyToServiceDesk: { execute: vi.fn().mockResolvedValue(true) },
    resolveSupportRequest: resolveSupportRequest as ResolveSupportRequest & { execute: ReturnType<typeof vi.fn> },
    ...(feedback ? { feedback } : {}),
  };
  const confirmOffer = new ConfirmOffer(pendingOffers, handlers as unknown as ConfirmOfferHandlers, wireOutbound, undefined, undefined, [], logger);
  const questions = new DeskUpdateQuestions({ offers: pendingOffers, wireOutbound, lifetimeMs: HOURS_4, logger });
  const deps = {
    logger,
    answerQuestion: { execute: vi.fn().mockResolvedValue("") },
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
    supportWelcome: { projectKey: "SD", passive: false, watching: true },
  } as unknown as WireEventRouterDeps;
  const router = new WireEventRouter(deps);

  const askAfter = async (kind: DeskUpdateKind): Promise<{ messageId: string; buttons: string[] }> => {
    expect(await questions.ask(REQUEST, kind)).toBe(true);
    const prompt = prompts.at(-1)!;
    return { messageId: prompt.messageId, buttons: prompt.buttons.map((b) => b.id) };
  };
  const texts = (): string[] => wireOutbound.sendPlainText.mock.calls.map((call) => (call as unknown[])[1] as string);
  const closes = (): Array<[string, string]> => wireOutbound.closeButtonPrompt.mock.calls.map((call) => [call[1] as string, call[2] as string]);
  /** The real answer path, its model proposing to resolve SD-6; stores the offer for `sender`. */
  const answerPathOffer = async (sender: QualifiedId, name: string): Promise<void> => {
    const general = { answer: vi.fn().mockResolvedValue('OFFER: {"kind":"resolve","issueKey":"SD-6"}') };
    const answerQuestion = new AnswerQuestion(general, wireOutbound, {
      tracker: tracker as never, requests: requests as never, auditLog: audit, offers: pendingOffers, shareWithModel: false,
    }, undefined, logger);
    await answerQuestion.execute({
      question: "The VPN works again, please close the request", conversationContext: [], conversationId: convId, replyToMessageId: "q-1",
      requester: { ...sender, name }, members: [{ ...sender, name }],
    });
  };
  /** Real passive help, its triage naming SD-6 as resolved; stores the offer for `sender`. */
  const passiveOffer = async (sender: QualifiedId, name: string): Promise<void> => {
    const draft: SupportDraft = {
      requestKind: "fault", summary: "", description: "", duplicateOf: null, addition: null, resolves: "SD-6", closingComment: null,
    };
    const triage = { draftRequest: vi.fn().mockResolvedValue(draft), matchStatusQuestion: vi.fn().mockResolvedValue(null), extractPartDetails: vi.fn() };
    const getIssueStatus = { projectKey: "SD", execute: vi.fn().mockResolvedValue(null) } as unknown as GetIssueStatus;
    const offerSupport = new OfferSupportFromConversation(requests as never, triage, getIssueStatus, pendingOffers, wireOutbound, logger);
    expect(await offerSupport.execute({
      text: "The VPN works again", messageId: "p-1", conversationId: convId, senderId: sender, senderName: name,
      categories: ["service_request"], confidence: 0.9,
    })).toBe(true);
  };
  return {
    router, pendingOffers, handlers, wireOutbound, prompts, askAfter, texts, closes, tracker, audit, logger, requests, answerPathOffer, passiveOffer,
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

/** Answers [Solved] after a resolve and returns the rating question. */
async function ratingAfterSolved(ctx: ReturnType<typeof setup>) {
  const { messageId, buttons } = await ctx.askAfter("resolved");
  await ctx.router.onButtonClicked(click(alice, buttons[0]!, messageId));
  const rating = ctx.prompts.at(-1)!;
  expect(rating.text).toBe(RATING_QUESTION);
  return { messageId: rating.messageId, buttons: rating.buttons.map((b) => b.id) };
}

describe("WireEventRouter contract: the satisfaction rating", () => {
  it("[Solved] closes the question and asks for a rating [1] to [5]", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ctx.askAfter("resolved");
    await ctx.router.onButtonClicked(click(alice, buttons[0]!, messageId));
    expect(ctx.closes()).toEqual([[messageId, `${RESOLVED_QUESTION}\n\nAnswered by Alice: Solved`]]);
    expect(ctx.prompts.at(-1)!.text).toBe(RATING_QUESTION);
    expect(ctx.prompts.at(-1)!.buttons.map((b) => b.label)).toEqual(["1", "2", "3", "4", "5"]);
    expect(ctx.texts()).toEqual([]);
    expect(ctx.tracker.submitFeedback).not.toHaveBeenCalled();
  });

  it("the text answer 'solved' asks for a rating too", async () => {
    const ctx = setup();
    await ctx.askAfter("resolved");
    await ctx.router.onTextMessageReceived(text(alice, "solved"));
    expect(ctx.prompts.at(-1)!.text).toBe(RATING_QUESTION);
  });

  it("[Solved, close it] asks for a rating after the request was resolved", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ctx.askAfter("reply");
    await ctx.router.onButtonClicked(click(alice, buttons[1]!, messageId));
    expect(ctx.closes()).toEqual([[messageId, `${REPLY_QUESTION}\n\nAnswered by Alice: Solved, close it`]]);
    expect(ctx.handlers.resolveSupportRequest.execute).toHaveBeenCalledOnce();
    expect(ctx.prompts.at(-1)!.text).toBe(RATING_QUESTION);
    expect(ctx.handlers.resolveSupportRequest.execute.mock.invocationCallOrder[0])
      .toBeLessThan(ctx.wireOutbound.sendCompositePrompt.mock.invocationCallOrder.at(-1)!);
  });

  it.each([
    ["nothing was resolved", "fail"],
    ["the request is not done after the resolve", "short"],
  ])("[Solved, close it] asks no rating when %s", async (_label, outcome) => {
    const ctx = setup();
    if (outcome === "fail") ctx.tracker.resolveIssue.mockRejectedValue(new IssueTrackerError("Jira request failed (409)", 409));
    else ctx.tracker.resolveIssue.mockResolvedValue({ ...DONE, statusCategory: "in_progress" });
    const { messageId, buttons } = await ctx.askAfter("reply");
    await ctx.router.onButtonClicked(click(alice, buttons[1]!, messageId));
    expect(ctx.prompts).toHaveLength(1);
  });

  it("asks no rating after [Still broken], [Reply] or 'no'", async () => {
    for (const answer of ["still broken", "no"]) {
      const ctx = setup();
      await ctx.askAfter("resolved");
      await ctx.router.onTextMessageReceived(text(alice, answer));
      expect(ctx.prompts).toHaveLength(1);
    }
    const ctx = setup();
    const { messageId, buttons } = await ctx.askAfter("reply");
    await ctx.router.onButtonClicked(click(alice, buttons[0]!, messageId));
    expect(ctx.prompts).toHaveLength(1);
  });

  it("asks no rating with the setting off", async () => {
    const ctx = setup({ feedback: false });
    const resolved = await ctx.askAfter("resolved");
    await ctx.router.onButtonClicked(click(alice, resolved.buttons[0]!, resolved.messageId));
    const reply = await ctx.askAfter("reply");
    await ctx.router.onButtonClicked(click(alice, reply.buttons[1]!, reply.messageId));
    expect(ctx.prompts.map((p) => p.text)).toEqual([RESOLVED_QUESTION, REPLY_QUESTION]);
    expect(ctx.tracker.submitFeedback).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3, 4, 5])("a click on [%s] sends that rating, audited, and closes the question with it", async (rating) => {
    const ctx = setup();
    const { messageId, buttons } = await ratingAfterSolved(ctx);
    await ctx.router.onButtonClicked(click(alice, buttons[rating - 1]!, messageId));
    expect(ctx.tracker.submitFeedback).toHaveBeenCalledExactlyOnceWith("SD-6", rating);
    expect(ctx.wireOutbound.sendButtonConfirmation).toHaveBeenLastCalledWith(convId, messageId, buttons[rating - 1]);
    expect(ctx.closes().at(-1)).toEqual([messageId, `${RATING_QUESTION}\n\nAnswered by Alice: ${rating}`]);
    expect(ctx.audit.append).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      action: "entity_created", entityType: "JiraFeedback", entityId: "SD-6", actorId: alice, details: { rating },
    }));
    expect(JSON.stringify(ctx.audit.append.mock.calls)).not.toContain("Alice");
    expect(ctx.texts()).toEqual([]);
  });

  it("takes a typed rating, and sends it once", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ratingAfterSolved(ctx);
    await ctx.router.onTextMessageReceived(text(alice, "4"));
    await ctx.router.onButtonClicked(click(alice, buttons[0]!, messageId));
    expect(ctx.tracker.submitFeedback).toHaveBeenCalledExactlyOnceWith("SD-6", 4);
    expect(ctx.closes().at(-1)).toEqual([messageId, `${RATING_QUESTION}\n\nAnswered by Alice: 4`]);
  });

  it("'no' ends the rating question without sending anything", async () => {
    const ctx = setup();
    const { messageId } = await ratingAfterSolved(ctx);
    await ctx.router.onTextMessageReceived(text(alice, "no"));
    expect(ctx.closes().at(-1)).toEqual([messageId, `${RATING_QUESTION}\n\nAnswered by Alice: No`]);
    expect(ctx.tracker.submitFeedback).not.toHaveBeenCalled();
    expect(ctx.texts()).toEqual([]);
  });

  it("another member's click sends nothing and gets one notice", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ratingAfterSolved(ctx);
    await ctx.router.onButtonClicked(click(bob, buttons[0]!, messageId));
    await ctx.router.onButtonClicked(click(bob, buttons[4]!, messageId));
    expect(ctx.tracker.submitFeedback).not.toHaveBeenCalled();
    expect(ctx.texts()).toEqual(["Only Alice can answer this."]);
    await ctx.router.onButtonClicked(click(alice, buttons[4]!, messageId));
    expect(ctx.tracker.submitFeedback).toHaveBeenCalledExactlyOnceWith("SD-6", 5);
  });

  it("a refused rating gets one short text, logged by error name and status, and nothing else changes", async () => {
    const ctx = setup();
    ctx.tracker.submitFeedback.mockRejectedValue(new IssueTrackerError("Jira request failed (404)", 404));
    const { messageId, buttons } = await ratingAfterSolved(ctx);
    await ctx.router.onButtonClicked(click(alice, buttons[2]!, messageId));
    expect(ctx.texts()).toEqual([FEEDBACK_FAILED]);
    expect(ctx.closes().at(-1)).toEqual([messageId, `${RATING_QUESTION}\n\nAnswered by Alice: 3`]);
    expect(ctx.logger.warn).toHaveBeenCalledWith("SubmitFeedback: submitFeedback failed", { key: "SD-6", err: "IssueTrackerError", status: 404 });
    expect(ctx.audit.append).not.toHaveBeenCalled();
    expect(ctx.pendingOffers.has(convId, alice)).toBe(false);
  });
});

describe("WireEventRouter contract: the satisfaction rating after a resolve from Wire", () => {
  const ratingPrompts = (ctx: ReturnType<typeof setup>) => ctx.prompts.filter((p) => p.text === RATING_QUESTION);

  it.each([
    ["without a comment", "resolve SD-6", undefined],
    ["with a comment", "resolve SD-6: The VPN works again.", "The VPN works again."],
  ])("asks the requester after '@bot resolve SD-6' %s", async (_label, body, comment) => {
    const ctx = setup();
    await ctx.router.onTextMessageReceived(command(alice, body));
    expect(ctx.tracker.resolveIssue).toHaveBeenCalledExactlyOnceWith("SD-6");
    if (comment) expect(ctx.tracker.addCustomerReply).toHaveBeenCalledExactlyOnceWith("SD-6", `${comment}\n\nSent from Wire.`);
    else expect(ctx.tracker.addCustomerReply).not.toHaveBeenCalled();
    expect(ctx.texts()).toHaveLength(1);
    expect(ctx.texts()[0]).toMatch(/^Resolved \*\*SD-6\*\* with the service desk\./);
    expect(ratingPrompts(ctx)).toHaveLength(1);
    expect(ctx.prompts.at(-1)!.buttons.map((b) => b.label)).toEqual(["1", "2", "3", "4", "5"]);
    expect(ctx.wireOutbound.sendPlainText.mock.invocationCallOrder[0]!).toBeLessThan(ctx.wireOutbound.sendCompositePrompt.mock.invocationCallOrder.at(-1)!);
    expect(ctx.pendingOffers.has(convId, alice)).toBe(true);
  });

  it("asks the requester by name when another member resolved, and only the requester can answer", async () => {
    const ctx = setup();
    await ctx.router.onTextMessageReceived(command(bob, "resolve SD-6"));
    const rating = ctx.prompts.at(-1)!;
    expect(rating.text).toBe(RATING_QUESTION);
    expect(ctx.pendingOffers.has(convId, bob)).toBe(false);
    const buttons = rating.buttons.map((b) => b.id);
    await ctx.router.onButtonClicked(click(bob, buttons[1]!, rating.messageId));
    expect(ctx.tracker.submitFeedback).not.toHaveBeenCalled();
    expect(ctx.texts().at(-1)).toBe("Only Alice can answer this.");
    await ctx.router.onButtonClicked(click(alice, buttons[3]!, rating.messageId));
    expect(ctx.tracker.submitFeedback).toHaveBeenCalledExactlyOnceWith("SD-6", 4);
    expect(ctx.closes().at(-1)).toEqual([rating.messageId, `${RATING_QUESTION}\n\nAnswered by Alice: 4`]);
  });

  it("asks the requester after a yes to a resolve offer from the answer path, also when another member confirmed it", async () => {
    const ctx = setup();
    await ctx.answerPathOffer(bob, "Bob");
    expect(ctx.pendingOffers.has(convId, bob)).toBe(true);
    await ctx.router.onTextMessageReceived(text(bob, "yes"));
    expect(ctx.tracker.resolveIssue).toHaveBeenCalledExactlyOnceWith("SD-6");
    expect(ratingPrompts(ctx)).toHaveLength(1);
    expect(ctx.prompts.at(-1)!.text).toBe(RATING_QUESTION);
    expect(ctx.pendingOffers.has(convId, alice)).toBe(true);
  });

  it("asks the requester after [Yes] to a resolve offer from passive help", async () => {
    const ctx = setup();
    await ctx.passiveOffer(alice, "Alice");
    const offer = ctx.prompts.at(-1)!;
    expect(offer.text).toContain("Shall I resolve **SD-6**");
    await ctx.router.onButtonClicked(click(alice, offer.buttons[0]!.id, offer.messageId));
    expect(ctx.tracker.resolveIssue).toHaveBeenCalledExactlyOnceWith("SD-6");
    expect(ratingPrompts(ctx)).toHaveLength(1);
    expect(ctx.prompts.at(-1)!.text).toBe(RATING_QUESTION);
  });

  it("asks once for a resolving [Solved, close it]", async () => {
    const ctx = setup();
    const { messageId, buttons } = await ctx.askAfter("reply");
    await ctx.router.onButtonClicked(click(alice, buttons[1]!, messageId));
    expect(ctx.tracker.resolveIssue).toHaveBeenCalledOnce();
    expect(ratingPrompts(ctx)).toHaveLength(1);
    expect(ctx.prompts).toHaveLength(2);
  });

  it("asks nothing after a failed resolve, a refused comment or a request already resolved", async () => {
    const failed = setup();
    failed.tracker.resolveIssue.mockRejectedValue(new IssueTrackerError("Jira request failed (409)", 409));
    await failed.router.onTextMessageReceived(command(alice, "resolve SD-6"));
    expect(failed.texts()).toEqual(["I'm afraid I couldn't resolve **SD-6** with the service desk; please check the ticket."]);
    expect(failed.prompts).toEqual([]);

    const refused = setup();
    refused.tracker.addCustomerReply.mockRejectedValue(new IssueTrackerError("Jira request failed (400)", 400));
    await refused.router.onTextMessageReceived(command(alice, "resolve SD-6: Works again."));
    expect(refused.tracker.resolveIssue).not.toHaveBeenCalled();
    expect(refused.prompts).toEqual([]);

    const already = setup();
    already.requests.findByKey.mockResolvedValue({ ...REQUEST, statusCategory: "done" });
    await already.router.onTextMessageReceived(command(alice, "resolve SD-6"));
    expect(already.texts()).toEqual(["**SD-6** is already resolved."]);
    expect(already.tracker.resolveIssue).not.toHaveBeenCalled();
    expect(already.prompts).toEqual([]);

    const short = setup();
    short.tracker.resolveIssue.mockResolvedValue({ ...DONE, statusCategory: "in_progress" });
    await short.router.onTextMessageReceived(command(alice, "resolve SD-6"));
    expect(short.prompts).toEqual([]);
  });

  it("asks nothing with the setting off", async () => {
    const byCommand = setup({ feedback: false });
    await byCommand.router.onTextMessageReceived(command(bob, "resolve SD-6"));
    expect(byCommand.tracker.resolveIssue).toHaveBeenCalledOnce();
    expect(byCommand.prompts).toEqual([]);

    const byAnswerPath = setup({ feedback: false });
    await byAnswerPath.answerPathOffer(alice, "Alice");
    await byAnswerPath.router.onTextMessageReceived(text(alice, "yes"));
    expect(byAnswerPath.tracker.resolveIssue).toHaveBeenCalledOnce();
    expect(byAnswerPath.prompts).toHaveLength(1);

    const byPassive = setup({ feedback: false });
    await byPassive.passiveOffer(alice, "Alice");
    const offer = byPassive.prompts.at(-1)!;
    await byPassive.router.onButtonClicked(click(alice, offer.buttons[0]!.id, offer.messageId));
    expect(byPassive.tracker.resolveIssue).toHaveBeenCalledOnce();
    expect(byPassive.prompts).toHaveLength(1);
  });
});
