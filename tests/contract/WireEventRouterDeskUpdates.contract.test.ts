/**
 * Contract tests for the questions after a desk update: the router with the real offer store, the
 * real ConfirmOffer and the real DeskUpdateQuestions, with mocked support use cases and ports.
 * No DB, network or SDK.
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
import { sweepEndedOfferPrompts } from "../../src/application/services/offerPromptClosing";
import type { OfferCommand } from "../../src/application/ports/PendingOfferPort";
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

const REPLY_QUESTION = "Alice, would you like to reply to the service desk about **SD-6**, or is it solved so I can close it?";
const RESOLVED_QUESTION = "Alice, is **SD-6** solved for you, or is it still broken?";
const ASK_TEXT = "What shall I send to the service desk? Your next message here becomes the reply to **SD-6**; I'll ask before sending it.";
const ASK_WRONG = "What is still wrong? Your next message here becomes the reply to **SD-6**; I'll ask before sending it.";

function setup() {
  const pendingOffers = new InMemoryPendingOfferStore();
  const memberCache = new InMemoryMemberCache();
  memberCache.setMembers(convId, [
    { userId: alice, role: "member", name: "Alice" },
    { userId: bob, role: "member", name: "Bob" },
  ]);
  const handlers = {
    raiseSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
    replyToServiceDesk: { execute: vi.fn().mockResolvedValue(true) },
    resolveSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
  };
  let sentCount = 0;
  /** Every button question: its message ID, text and buttons, in order. */
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
  const confirmOffer = new ConfirmOffer(pendingOffers, handlers as unknown as ConfirmOfferHandlers, wireOutbound, undefined, undefined, [], logger);
  const questions = new DeskUpdateQuestions({ offers: pendingOffers, wireOutbound, lifetimeMs: HOURS_4, logger });
  const getIssueStatus = { execute: vi.fn().mockResolvedValue(undefined), projectKey: "SD" };
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
    getIssueStatus,
    pendingOffers,
    confirmOffer,
    supportWelcome: { projectKey: "SD", passive: false, watching: true },
  } as unknown as WireEventRouterDeps;
  const router = new WireEventRouter(deps);

  /** Asks as the watch does after posting an update; returns the question's message ID and button IDs. */
  const askAfter = async (kind: DeskUpdateKind): Promise<{ messageId: string; buttons: string[] }> => {
    expect(await questions.ask(REQUEST, kind)).toBe(true);
    const prompt = prompts.at(-1)!;
    return { messageId: prompt.messageId, buttons: prompt.buttons.map((b) => b.id) };
  };
  const texts = (): string[] => wireOutbound.sendPlainText.mock.calls.map((call) => (call as unknown[])[1] as string);
  const closes = (): Array<[string, string]> => wireOutbound.closeButtonPrompt.mock.calls.map((call) => [call[1] as string, call[2] as string]);
  /** Nothing reached Jira: no reply, resolve or raise ran. */
  const nothingWritten = (): void => {
    expect(handlers.replyToServiceDesk.execute).not.toHaveBeenCalled();
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
    expect(handlers.raiseSupportRequest.execute).not.toHaveBeenCalled();
  };
  return { router, pendingOffers, handlers, wireOutbound, prompts, askAfter, texts, closes, nothingWritten, getIssueStatus, deps };
}

let eventCount = 0;
function click(sender: QualifiedId, buttonId: string, referenceMessageId: string): CompositeButtonAction {
  eventCount += 1;
  return { type: "composite_button_action", id: `click-${eventCount}`, conversationId: convId, sender, buttonId, referenceMessageId };
}

function text(sender: QualifiedId, body: string): TextMessage {
  eventCount += 1;
  return { type: "text", id: `text-${eventCount}`, text: body, conversationId: convId, sender, timestamp: new Date() };
}

describe("WireEventRouter contract: the question after a desk reply", () => {
  it("[Reply] asks for the text, the next message becomes the reply offer, and only its [Yes] sends the reply", async () => {
    const { router, askAfter, prompts, handlers, wireOutbound, texts, closes, nothingWritten } = setup();
    const { messageId, buttons } = await askAfter("reply");
    expect(prompts[0]!.text).toBe(REPLY_QUESTION);

    await router.onButtonClicked(click(alice, buttons[0]!, messageId));
    expect(wireOutbound.sendButtonConfirmation).toHaveBeenCalledWith(convId, messageId, buttons[0]);
    expect(closes()).toEqual([[messageId, `${REPLY_QUESTION}\n\nAnswered by Alice: Reply`]]);
    expect(texts()).toEqual([ASK_TEXT]);
    nothingWritten();

    await router.onTextMessageReceived(text(alice, "Restarting did not help, it still drops."));
    const offer = prompts.at(-1)!;
    expect(offer.text).toBe('Shall I add this to **SD-6** "VPN drops every ten minutes"?\n> Restarting did not help, it still drops.');
    expect(offer.buttons.map((b) => b.label)).toEqual(["Yes", "No"]);
    nothingWritten();

    await router.onButtonClicked(click(alice, offer.buttons[0]!.id, offer.messageId));
    expect(handlers.replyToServiceDesk.execute).toHaveBeenCalledOnce();
    expect(handlers.replyToServiceDesk.execute).toHaveBeenCalledWith(expect.objectContaining({
      reference: "SD-6", body: "Restarting did not help, it still drops.", conversationId: convId, actorId: alice,
    }));
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
  });

  it("takes the text answer 'reply' like the button, and a [No] on the reply offer sends nothing", async () => {
    const { router, askAfter, prompts, texts, closes, nothingWritten } = setup();
    const { messageId } = await askAfter("reply");

    await router.onTextMessageReceived(text(alice, "reply"));
    expect(closes()).toEqual([[messageId, `${REPLY_QUESTION}\n\nAnswered by Alice: Reply`]]);
    expect(texts()).toEqual([ASK_TEXT]);

    await router.onTextMessageReceived(text(alice, "It still drops."));
    const offer = prompts.at(-1)!;
    await router.onButtonClicked(click(alice, offer.buttons[1]!.id, offer.messageId));
    expect(texts().at(-1)).toBe("Understood, I won't.");
    nothingWritten();
  });

  it("[Solved, close it] resolves the request through the existing resolve, once", async () => {
    const { router, askAfter, handlers, closes } = setup();
    const { messageId, buttons } = await askAfter("reply");

    await router.onButtonClicked(click(alice, buttons[1]!, messageId));
    await router.onButtonClicked(click(alice, buttons[1]!, messageId));

    expect(closes()).toEqual([[messageId, `${REPLY_QUESTION}\n\nAnswered by Alice: Solved, close it`]]);
    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledOnce();
    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "SD-6", conversationId: convId, actorId: alice }));
    expect(handlers.replyToServiceDesk.execute).not.toHaveBeenCalled();
  });

  it("takes the text answer 'solved' as [Solved, close it]", async () => {
    const { router, askAfter, handlers, closes } = setup();
    const { messageId } = await askAfter("reply");
    await router.onTextMessageReceived(text(alice, "Solved, thanks!"));
    expect(closes()).toEqual([[messageId, `${REPLY_QUESTION}\n\nAnswered by Alice: Solved, close it`]]);
    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledOnce();
  });

  it("takes 'no' as ending the question without anything else", async () => {
    const { router, askAfter, texts, closes, nothingWritten, pendingOffers } = setup();
    const { messageId } = await askAfter("reply");
    await router.onTextMessageReceived(text(alice, "no"));
    expect(closes()).toEqual([[messageId, `${REPLY_QUESTION}\n\nAnswered by Alice: No`]]);
    expect(texts()).toEqual([]);
    expect(pendingOffers.has(convId, alice)).toBe(false);
    nothingWritten();
  });

  it("closes the question when the requester's next message is not an answer, also a 'thanks', and that message is handled as usual", async () => {
    const { router, askAfter, texts, closes, nothingWritten, pendingOffers, deps } = setup();
    const { messageId } = await askAfter("reply");
    await router.onTextMessageReceived(text(alice, "thanks"));
    expect(closes()).toEqual([[messageId, `${REPLY_QUESTION}\n\nClosed, as the next message was not an answer.`]]);
    expect(texts()).toEqual([]);
    expect(pendingOffers.has(convId, alice)).toBe(false);
    expect(deps.messageBuffer.push).toHaveBeenCalledWith(convId, expect.objectContaining({ text: "thanks" }));
    nothingWritten();
  });

  it("answers another member's click once with who may answer, and keeps the question open for the requester", async () => {
    const { router, askAfter, handlers, wireOutbound, texts, closes } = setup();
    const { messageId, buttons } = await askAfter("reply");

    await router.onButtonClicked(click(bob, buttons[1]!, messageId));
    await router.onButtonClicked(click(bob, buttons[0]!, messageId));
    expect(texts()).toEqual(["Only Alice can answer this."]);
    expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
    expect(closes()).toEqual([]);
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();

    // Bob's text answer is no answer to Alice's question either.
    await router.onTextMessageReceived(text(bob, "solved"));
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();

    await router.onButtonClicked(click(alice, buttons[1]!, messageId));
    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledOnce();
  });

  it("ignores a late click after the question expired, and the sweep closes it", async () => {
    const { router, askAfter, wireOutbound, closes, nothingWritten, pendingOffers } = setup();
    const { messageId, buttons } = await askAfter("reply");
    const later = new Date(Date.now() + HOURS_4 + 1000);
    await sweepEndedOfferPrompts({ offers: pendingOffers, wireOutbound }, later);
    expect(closes()).toEqual([[messageId, `${REPLY_QUESTION}\n\nThis question has expired.`]]);

    await router.onButtonClicked(click(alice, buttons[1]!, messageId));
    expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
    expect(wireOutbound.sendPlainText).not.toHaveBeenCalled();
    nothingWritten();
  });
});

describe("WireEventRouter contract: the question after a resolve", () => {
  it("[Solved] closes the question and does nothing else", async () => {
    const { router, askAfter, prompts, texts, closes, nothingWritten, pendingOffers } = setup();
    const { messageId, buttons } = await askAfter("resolved");
    expect(prompts[0]!.text).toBe(RESOLVED_QUESTION);
    expect(prompts[0]!.buttons.map((b) => b.label)).toEqual(["Solved", "Still broken"]);

    await router.onButtonClicked(click(alice, buttons[0]!, messageId));

    expect(closes()).toEqual([[messageId, `${RESOLVED_QUESTION}\n\nAnswered by Alice: Solved`]]);
    expect(texts()).toEqual([]);
    expect(pendingOffers.has(convId, alice)).toBe(false);
    nothingWritten();
  });

  it("takes the text answer 'solved' like the button", async () => {
    const { router, askAfter, texts, closes, nothingWritten } = setup();
    const { messageId } = await askAfter("resolved");
    await router.onTextMessageReceived(text(alice, "solved"));
    expect(closes()).toEqual([[messageId, `${RESOLVED_QUESTION}\n\nAnswered by Alice: Solved`]]);
    expect(texts()).toEqual([]);
    nothingWritten();
  });

  it("[Still broken] asks what is still wrong and offers the next message as a reply; [Yes] sends it", async () => {
    const { router, askAfter, prompts, handlers, texts, closes, nothingWritten } = setup();
    const { messageId, buttons } = await askAfter("resolved");

    await router.onButtonClicked(click(alice, buttons[1]!, messageId));
    expect(closes()).toEqual([[messageId, `${RESOLVED_QUESTION}\n\nAnswered by Alice: Still broken`]]);
    expect(texts()).toEqual([ASK_WRONG]);

    await router.onTextMessageReceived(text(alice, "It drops again after an hour."));
    const offer = prompts.at(-1)!;
    expect(offer.text).toBe('Shall I add this to **SD-6** "VPN drops every ten minutes"?\n> It drops again after an hour.');
    nothingWritten();

    await router.onTextMessageReceived(text(alice, "yes"));
    expect(handlers.replyToServiceDesk.execute).toHaveBeenCalledWith(expect.objectContaining({ reference: "SD-6", body: "It drops again after an hour." }));
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
  });

  it("takes the text answer 'still broken' like the button, and 'no' instead of the text cancels", async () => {
    const { router, askAfter, texts, nothingWritten, pendingOffers } = setup();
    await askAfter("resolved");
    await router.onTextMessageReceived(text(alice, "still broken"));
    expect(texts()).toEqual([ASK_WRONG]);
    await router.onTextMessageReceived(text(alice, "cancel"));
    expect(texts().at(-1)).toBe("Understood, I won't send anything.");
    expect(pendingOffers.has(convId, alice)).toBe(false);
    nothingWritten();
  });

  it("refuses a text too long for Jira and keeps waiting for a shorter one", async () => {
    const { router, askAfter, prompts, texts, nothingWritten } = setup();
    await askAfter("resolved");
    await router.onTextMessageReceived(text(alice, "still broken"));
    await router.onTextMessageReceived(text(alice, "x".repeat(2001)));
    expect(texts().at(-1)).toBe("I'm afraid that is too long for Jira; please keep it under 2000 characters and send it again.");
    await router.onTextMessageReceived(text(alice, "Short version."));
    expect(prompts.at(-1)!.text).toContain("> Short version.");
    nothingWritten();
  });

  it("runs a command addressed to the bot instead of taking it as the reply text", async () => {
    const { router, askAfter, prompts, getIssueStatus, nothingWritten, pendingOffers } = setup();
    await askAfter("resolved");
    await router.onTextMessageReceived(text(alice, "still broken"));
    const before = prompts.length;
    await router.onTextMessageReceived(text(alice, "Wire Support Bot status of SD-6"));
    expect(getIssueStatus.execute).toHaveBeenCalledOnce();
    expect(prompts).toHaveLength(before);
    expect(pendingOffers.has(convId, alice)).toBe(false);
    nothingWritten();
  });
});

describe("WireEventRouter contract: desk-update questions and the requester's other questions", () => {
  const RESOLVE_SD7: OfferCommand = { kind: "resolve", issueKey: "SD-7" };

  it("is replaced by a newer question to the requester, which closes it as replaced", async () => {
    const { router, askAfter, pendingOffers, closes } = setup();
    const { messageId } = await askAfter("reply");
    const now = new Date();
    pendingOffers.put({
      command: RESOLVE_SD7, conversationId: convId, requesterId: alice, createdAt: now, expiresAt: new Date(now.getTime() + 600_000),
      id: "offer-newer", messageId: "prompt-newer", question: "Shall I resolve **SD-7**?",
    });
    // The router closes ended questions after each event it handles.
    await router.onTextMessageReceived(text(bob, "hello"));
    expect(closes()).toEqual([[messageId, `${REPLY_QUESTION}\n\nThis question was replaced by a newer one.`]]);
  });

  it("is not asked over the requester's open question, which stays answerable", async () => {
    const { router, pendingOffers, wireOutbound, handlers } = setup();
    const questions = new DeskUpdateQuestions({ offers: pendingOffers, wireOutbound, lifetimeMs: HOURS_4 });
    const now = new Date();
    pendingOffers.put({ command: RESOLVE_SD7, conversationId: convId, requesterId: alice, createdAt: now, expiresAt: new Date(now.getTime() + 600_000) });

    expect(await questions.ask(REQUEST, "reply")).toBe(false);
    expect(wireOutbound.sendCompositePrompt).not.toHaveBeenCalled();

    await router.onTextMessageReceived(text(alice, "yes"));
    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "SD-7" }));
  });

  it("does not block another member's question: Bob's open offer and Alice's desk question are answered separately", async () => {
    const { router, askAfter, pendingOffers, handlers } = setup();
    const now = new Date();
    pendingOffers.put({ command: RESOLVE_SD7, conversationId: convId, requesterId: bob, createdAt: now, expiresAt: new Date(now.getTime() + 600_000) });
    const { messageId, buttons } = await askAfter("reply");

    await router.onTextMessageReceived(text(bob, "yes"));
    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "SD-7", actorId: bob }));
    await router.onButtonClicked(click(alice, buttons[0]!, messageId));
    expect(pendingOffers.find(convId, alice)?.awaitsReplyText?.issueKey).toBe("SD-6");
  });
});
