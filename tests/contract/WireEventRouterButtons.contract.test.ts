/**
 * Contract tests for button clicks on offer questions: the router with the real offer store and
 * the real ConfirmOffer, with mocked support use cases and ports. No DB, network or SDK.
 */
import { describe, it, expect, vi } from "vitest";
import type { CompositeButtonAction, TextMessage } from "@wireapp/wire-apps-js-sdk";
import { WireEventRouter } from "../../src/infrastructure/wire/WireEventRouter";
import type { WireEventRouterDeps } from "../../src/infrastructure/wire/WireEventRouter";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import { InMemoryMemberCache } from "../../src/infrastructure/services/InMemoryMemberCache";
import { ConfirmOffer } from "../../src/application/usecases/jira/ConfirmOffer";
import type { ConfirmOfferHandlers } from "../../src/application/usecases/jira/ConfirmOffer";
import { cancelChoice, keyChoice } from "../../src/application/services/offerButtons";
import type { OfferCommand, PendingOffer } from "../../src/application/ports/PendingOfferPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const convId: QualifiedId = { id: "conv-1", domain: "example.com" };
const alice: QualifiedId = { id: "user-1", domain: "example.com" };
const bob: QualifiedId = { id: "user-2", domain: "example.com" };
const carol: QualifiedId = { id: "user-3", domain: "example.com" };
const botId: QualifiedId = { id: "bot-1", domain: "example.com" };

const RESOLVE: OfferCommand = { kind: "resolve", issueKey: "SD-6" };
const OFFER_ID = "offer-1234";
const PROMPT_ID = "prompt-msg-1";

const ANSWERED = "This question has already been answered.";
const EXPIRED = "This question has expired; ask me again.";

function setup(options: { aliceName?: string } = {}) {
  const pendingOffers = new InMemoryPendingOfferStore();
  /** Conversations the typing indicator was shown in. */
  const typing: QualifiedId[] = [];
  const memberCache = new InMemoryMemberCache();
  memberCache.setMembers(convId, [
    { userId: alice, role: "member", ...(options.aliceName === "" ? {} : { name: options.aliceName ?? "Alice" }) },
    { userId: bob, role: "member", name: "Bob" },
  ]);
  const handlers = {
    raiseSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
    replyToServiceDesk: { execute: vi.fn().mockResolvedValue(true) },
    resolveSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
  };
  const wireOutbound = {
    sendPlainText: vi.fn().mockResolvedValue(undefined),
    sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
    sendButtonConfirmation: vi.fn().mockResolvedValue(undefined),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    getUserProfile: vi.fn().mockResolvedValue(null),
    withTyping: <T>(c: QualifiedId, work: () => Promise<T>): Promise<T> => { typing.push(c); return work(); },
  };
  const confirmOffer = new ConfirmOffer(pendingOffers, handlers as unknown as ConfirmOfferHandlers, wireOutbound);
  const messageBuffer = { clear: vi.fn(), push: vi.fn(), getLastN: vi.fn().mockReturnValue([]) };
  const deps = {
    logger: { child: vi.fn().mockReturnThis(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    answerQuestion: { execute: vi.fn().mockResolvedValue("") },
    botUserId: botId,
    wireOutbound,
    messageBuffer,
    memberCache,
    channelConfig: { get: vi.fn().mockResolvedValue(null), upsert: vi.fn(), setTimezone: vi.fn() },
    raiseSupportRequest: handlers.raiseSupportRequest,
    completePartOrder: { execute: vi.fn().mockResolvedValue(false) },
    listSupportRequests: { execute: vi.fn() },
    resolveSupportRequest: handlers.resolveSupportRequest,
    replyToServiceDesk: handlers.replyToServiceDesk,
    getIssueStatus: { execute: vi.fn(), projectKey: "SD" },
    pendingOffers,
    confirmOffer,
    supportWelcome: { projectKey: "SD", passive: false, watching: false },
  } as unknown as WireEventRouterDeps;
  const router = new WireEventRouter(deps);
  /** Stores an offer asked of Alice with buttons, as the use cases do after sending the question. */
  const ask = (overrides: Partial<PendingOffer> = {}): PendingOffer => {
    const now = new Date();
    const offer: PendingOffer = {
      command: RESOLVE, conversationId: convId, requesterId: alice, createdAt: now, expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      id: OFFER_ID, messageId: PROMPT_ID, ...overrides,
    };
    pendingOffers.put(offer);
    return offer;
  };
  const texts = (): string[] => wireOutbound.sendPlainText.mock.calls.map((call) => call[1] as string);
  return { router, deps, pendingOffers, handlers, wireOutbound, messageBuffer, ask, texts, typing };
}

let clickCount = 0;
function click(sender: QualifiedId, buttonId: string, referenceMessageId = PROMPT_ID): CompositeButtonAction {
  clickCount += 1;
  return { type: "composite_button_action", id: `click-${clickCount}`, conversationId: convId, sender, buttonId, referenceMessageId };
}

function text(sender: QualifiedId, body: string, id = `text-${++clickCount}`): TextMessage {
  return { type: "text", id, text: body, conversationId: convId, sender, timestamp: new Date() };
}

describe("WireEventRouter contract: button clicks on offers", () => {
  it("runs the asked person's first click through ConfirmOffer and confirms only that click", async () => {
    const { router, ask, handlers, wireOutbound, pendingOffers, texts, typing } = setup();
    ask();

    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));

    expect(wireOutbound.sendButtonConfirmation).toHaveBeenCalledOnce();
    expect(wireOutbound.sendButtonConfirmation).toHaveBeenCalledWith(convId, PROMPT_ID, `${OFFER_ID}:0`);
    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledOnce();
    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "SD-6", conversationId: convId, actorId: alice }));
    // A write the requester waits for shows the typing indicator.
    expect(typing).toEqual([convId]);
    expect(pendingOffers.has(convId, alice)).toBe(false);
    expect(texts()).toEqual([]);
  });

  it("confirms the asked person's [No] and posts the result as text", async () => {
    const { router, ask, handlers, wireOutbound, texts } = setup();
    ask();
    await router.onButtonClicked(click(alice, `${OFFER_ID}:1`));
    expect(wireOutbound.sendButtonConfirmation).toHaveBeenCalledWith(convId, PROMPT_ID, `${OFFER_ID}:1`);
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
    expect(texts()).toEqual(["Understood, I won't."]);
  });

  it("ignores the same person's later clicks on the message: no action, no confirmation, one short answer, then silence", async () => {
    const { router, ask, handlers, wireOutbound, texts } = setup();
    ask();
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
    await router.onButtonClicked(click(alice, `${OFFER_ID}:1`));
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));

    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledOnce();
    expect(wireOutbound.sendButtonConfirmation).toHaveBeenCalledOnce();
    expect(texts()).toEqual([ANSWERED]);
  });

  it("answers another member's click once with who may answer, changes nothing, and still accepts the asked person's click", async () => {
    const { router, ask, handlers, wireOutbound, pendingOffers, texts } = setup();
    ask();

    await router.onButtonClicked(click(bob, `${OFFER_ID}:0`));
    await router.onButtonClicked(click(bob, `${OFFER_ID}:1`));
    await router.onButtonClicked(click(carol, `${OFFER_ID}:0`));

    expect(texts()).toEqual(["Only Alice can answer this."]);
    expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
    expect(pendingOffers.find(convId, alice)?.id).toBe(OFFER_ID);

    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledOnce();
    expect(wireOutbound.sendButtonConfirmation).toHaveBeenCalledOnce();
  });

  it("names the person who was asked generically when their display name is unknown", async () => {
    const { router, ask, texts } = setup({ aliceName: "" });
    ask();
    await router.onButtonClicked(click(bob, `${OFFER_ID}:0`));
    expect(texts()).toEqual(["Only the person who was asked can answer this."]);
  });

  it("answers a click on an expired question once, without a write or a confirmation", async () => {
    const { router, ask, handlers, wireOutbound, texts } = setup();
    ask({ expiresAt: new Date(Date.now() - 1) });
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
    await router.onButtonClicked(click(bob, `${OFFER_ID}:0`));
    expect(texts()).toEqual([EXPIRED]);
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
    expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
  });

  it("answers a click on an unknown message once, as after a restart", async () => {
    const { router, wireOutbound, texts } = setup();
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`, "lost-msg"));
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`, "lost-msg"));
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`, "other-lost-msg"));
    expect(texts()).toEqual([EXPIRED, EXPIRED]);
    expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
  });

  it("answers a click on a question replaced by a newer offer as expired", async () => {
    const { router, ask, handlers, wireOutbound, texts } = setup();
    ask();
    ask({ id: "offer-5678", messageId: "prompt-msg-2" });
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
    expect(texts()).toEqual([EXPIRED]);
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
    expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
  });

  it("ignores a button that does not belong to the offer of the clicked message, silently", async () => {
    const { router, ask, handlers, wireOutbound, pendingOffers, texts } = setup();
    ask();
    for (const buttonId of ["offer-5678:0", `${OFFER_ID}:2`, "SD-6", "yes"]) await router.onButtonClicked(click(alice, buttonId));
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
    expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
    expect(texts()).toEqual([]);
    expect(pendingOffers.has(convId, alice)).toBe(true);
  });

  it("ignores clicks from the bot itself", async () => {
    const { router, ask, wireOutbound, texts } = setup();
    ask();
    await router.onButtonClicked(click(botId, `${OFFER_ID}:0`));
    expect(texts()).toEqual([]);
    expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
  });

  it("runs the chosen request of a choice offer, never a key from the click", async () => {
    const { router, ask, handlers, wireOutbound } = setup();
    ask({ choices: [keyChoice("SD-40", { kind: "resolve", issueKey: "SD-40" }), keyChoice("SD-41", { kind: "resolve", issueKey: "SD-41" }), cancelChoice()] });
    await router.onButtonClicked(click(alice, `${OFFER_ID}:1`));
    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledOnce();
    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "SD-41" }));
    expect(wireOutbound.sendButtonConfirmation).toHaveBeenCalledWith(convId, PROMPT_ID, `${OFFER_ID}:1`);
  });

  it("treats a click as the requester's next interaction: the offer closes for the answer model", async () => {
    const { router, ask, messageBuffer } = setup();
    ask();
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
    expect(messageBuffer.push).toHaveBeenCalledWith(convId, expect.objectContaining({ senderId: alice, text: '(Chose "Yes".)' }));
    expect(messageBuffer.push).toHaveBeenLastCalledWith(convId, expect.objectContaining({ senderId: botId, text: "(Answered the offer above.)" }));
  });

  describe("clicks and text answers together", () => {
    it("after a click, a text yes runs nothing again", async () => {
      const { router, ask, handlers } = setup();
      ask();
      await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
      await router.onTextMessageReceived(text(alice, "yes"));
      expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledOnce();
    });

    it("after a text yes, a click runs nothing, gets no confirmation and one short answer", async () => {
      const { router, ask, handlers, wireOutbound, texts } = setup();
      ask();
      await router.onTextMessageReceived(text(alice, "yes"));
      expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledOnce();

      await router.onButtonClicked(click(alice, `${OFFER_ID}:1`));
      await router.onButtonClicked(click(bob, `${OFFER_ID}:0`));
      expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledOnce();
      expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
      expect(texts()).toEqual([ANSWERED]);
    });

    it("after a text no, a click on [Yes] writes nothing", async () => {
      const { router, ask, handlers, wireOutbound, texts } = setup();
      ask();
      await router.onTextMessageReceived(text(alice, "no"));
      await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
      expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
      expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
      expect(texts()).toEqual(["Understood, I won't.", ANSWERED]);
    });

    it("after the requester moved on with another message, a click finds the question expired", async () => {
      const { router, ask, handlers, texts } = setup();
      ask();
      await router.onTextMessageReceived(text(alice, "lunch at noon?"));
      await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
      expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
      expect(texts()).toEqual([EXPIRED]);
    });

    it("a text answer by number picks the option of a choice", async () => {
      const { router, ask, handlers } = setup();
      ask({ choices: [keyChoice("SD-40", { kind: "resolve", issueKey: "SD-40" }), keyChoice("SD-41", { kind: "resolve", issueKey: "SD-41" }), cancelChoice()] });
      await router.onTextMessageReceived(text(alice, "2"));
      expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "SD-41" }));
    });

    it("a dropped choice is not passed on as an offer to amend", async () => {
      const { router, ask, deps } = setup();
      ask({ choices: [keyChoice("SD-40", { kind: "resolve", issueKey: "SD-40" }), keyChoice("SD-41", { kind: "resolve", issueKey: "SD-41" }), cancelChoice()] });
      await router.onTextMessageReceived(text(alice, "the printer on floor 2 is fine now"));
      expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
    });
  });
});
