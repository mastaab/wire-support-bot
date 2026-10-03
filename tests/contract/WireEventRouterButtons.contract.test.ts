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
import { addToChoice, cancelChoice, keyChoice, raiseNewChoice } from "../../src/application/services/offerButtons";
import { sweepEndedOfferPrompts } from "../../src/application/services/offerPromptClosing";
import type { OfferCommand, PendingOffer } from "../../src/application/ports/PendingOfferPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { MetricsPort } from "../../src/application/ports/MetricsPort";
import { fakeMetrics } from "../metrics/fakeMetrics";

const convId: QualifiedId = { id: "conv-1", domain: "example.com" };
const alice: QualifiedId = { id: "user-1", domain: "example.com" };
const bob: QualifiedId = { id: "user-2", domain: "example.com" };
const carol: QualifiedId = { id: "user-3", domain: "example.com" };
const botId: QualifiedId = { id: "bot-1", domain: "example.com" };

const RESOLVE: OfferCommand = { kind: "resolve", issueKey: "SD-6" };
const OFFER_ID = "offer-1234";
const PROMPT_ID = "prompt-msg-1";

const QUESTION = "Shall I resolve **SD-6**?";
/** The closed message of the question, with its closing line. */
const closed = (line: string): string => `${QUESTION}\n\n${line}`;

function setup(options: { aliceName?: string; metrics?: MetricsPort } = {}) {
  const pendingOffers = new InMemoryPendingOfferStore(options.metrics);
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
    closeButtonPrompt: vi.fn().mockResolvedValue(undefined),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    getUserProfile: vi.fn().mockResolvedValue(null),
    withTyping: <T>(c: QualifiedId, work: () => Promise<T>): Promise<T> => { typing.push(c); return work(); },
  };
  const logger = { child: vi.fn().mockReturnThis(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const confirmOffer = new ConfirmOffer(pendingOffers, handlers as unknown as ConfirmOfferHandlers, wireOutbound, undefined, undefined, [], logger, options.metrics);
  const messageBuffer = { clear: vi.fn(), push: vi.fn(), getLastN: vi.fn().mockReturnValue([]) };
  const deps = {
    logger,
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
    metrics: options.metrics,
  } as unknown as WireEventRouterDeps;
  const router = new WireEventRouter(deps);
  /** Stores an offer asked of Alice with buttons, as the use cases do after sending the question. */
  const ask = (overrides: Partial<PendingOffer> = {}): PendingOffer => {
    const now = new Date();
    const offer: PendingOffer = {
      command: RESOLVE, conversationId: convId, requesterId: alice, createdAt: now, expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      id: OFFER_ID, messageId: PROMPT_ID, question: QUESTION, ...overrides,
    };
    pendingOffers.put(offer);
    return offer;
  };
  const texts = (): string[] => wireOutbound.sendPlainText.mock.calls.map((call) => call[1] as string);
  /** Every close: the message and its new text, in order. */
  const closes = (): Array<[string, string]> => wireOutbound.closeButtonPrompt.mock.calls.map((call) => [call[1] as string, call[2] as string]);
  return { router, deps, pendingOffers, handlers, wireOutbound, messageBuffer, ask, texts, closes, typing };
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
    const { router, ask, handlers, wireOutbound, pendingOffers, texts, closes, typing } = setup();
    ask();

    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
    expect(closes()).toEqual([[PROMPT_ID, closed("Answered by Alice: Yes")]]);

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
    const { router, ask, handlers, wireOutbound, texts, closes } = setup();
    ask();
    await router.onButtonClicked(click(alice, `${OFFER_ID}:1`));
    expect(wireOutbound.sendButtonConfirmation).toHaveBeenCalledWith(convId, PROMPT_ID, `${OFFER_ID}:1`);
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
    expect(texts()).toEqual(["Understood, I won't."]);
    expect(closes()).toEqual([[PROMPT_ID, closed("Answered by Alice: No")]]);
  });

  it("ignores late clicks on the closed message silently: no action, no confirmation, no text, no second close", async () => {
    const { router, ask, handlers, wireOutbound, texts, closes } = setup();
    ask();
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
    await router.onButtonClicked(click(alice, `${OFFER_ID}:1`));
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
    await router.onButtonClicked(click(bob, `${OFFER_ID}:1`));

    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledOnce();
    expect(wireOutbound.sendButtonConfirmation).toHaveBeenCalledOnce();
    expect(texts()).toEqual([]);
    expect(closes()).toHaveLength(1);
  });

  it("closes the message with a generic answer line when the requester's name is unknown", async () => {
    const { router, ask, closes } = setup({ aliceName: "" });
    ask();
    await router.onButtonClicked(click(alice, `${OFFER_ID}:1`));
    expect(closes()).toEqual([[PROMPT_ID, closed("Answered: No")]]);
  });

  it("goes on when closing the message fails: the result still runs and is posted, and the failure is logged by name", async () => {
    const { router, ask, handlers, wireOutbound, deps, texts } = setup();
    wireOutbound.closeButtonPrompt.mockRejectedValueOnce(new TypeError("edit failed"));
    ask();
    await router.onButtonClicked(click(alice, `${OFFER_ID}:1`));
    expect(texts()).toEqual(["Understood, I won't."]);
    expect(deps.logger.warn).toHaveBeenCalledWith("Closing a button question failed", { err: "TypeError" });
    expect(deps.logger.error).not.toHaveBeenCalled();

    // The message counts as closed: a late click stays silent and nothing is retried.
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
    expect(wireOutbound.closeButtonPrompt).toHaveBeenCalledOnce();
    expect(texts()).toEqual(["Understood, I won't."]);
  });

  it("answers another member's click once with who may answer, changes nothing, and still accepts the asked person's click", async () => {
    const { router, ask, handlers, wireOutbound, pendingOffers, texts, closes } = setup();
    ask();

    await router.onButtonClicked(click(bob, `${OFFER_ID}:0`));
    await router.onButtonClicked(click(bob, `${OFFER_ID}:1`));
    await router.onButtonClicked(click(carol, `${OFFER_ID}:0`));

    expect(texts()).toEqual(["Only Alice can answer this."]);
    expect(closes()).toEqual([]);
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

  it("closes an expired question when a click finds it expired, and ignores the click silently", async () => {
    const { router, ask, handlers, wireOutbound, texts, closes } = setup();
    ask({ expiresAt: new Date(Date.now() - 1) });
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
    await router.onButtonClicked(click(bob, `${OFFER_ID}:0`));
    expect(texts()).toEqual([]);
    expect(closes()).toEqual([[PROMPT_ID, closed("This question has expired.")]]);
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
    expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
  });

  it("closes an expired question on the requester's next message, which is then handled as usual", async () => {
    const { router, ask, deps, texts, closes } = setup();
    ask({ expiresAt: new Date(Date.now() - 1) });
    await router.onTextMessageReceived(text(alice, "lunch at noon?"));
    expect(closes()).toEqual([[PROMPT_ID, closed("This question has expired.")]]);
    expect(texts()).toEqual([]);
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  });

  it("closes an expired question in a quiet conversation on the sweep, and a later click is silent", async () => {
    const { router, ask, pendingOffers, wireOutbound, deps, texts, closes } = setup();
    const offer = ask();
    await sweepEndedOfferPrompts({ offers: pendingOffers, wireOutbound, logger: deps.logger }, new Date(offer.expiresAt.getTime() - 1));
    expect(closes()).toEqual([]);
    await sweepEndedOfferPrompts({ offers: pendingOffers, wireOutbound, logger: deps.logger }, offer.expiresAt);
    expect(closes()).toEqual([[PROMPT_ID, closed("This question has expired.")]]);

    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
    expect(texts()).toEqual([]);
    expect(closes()).toHaveLength(1);
    expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
  });

  it("ignores a click on an unknown message silently, as after a restart", async () => {
    const { router, wireOutbound, texts, closes } = setup();
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`, "lost-msg"));
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`, "other-lost-msg"));
    expect(texts()).toEqual([]);
    expect(closes()).toEqual([]);
    expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
  });

  it("closes a question replaced by a newer one to the same requester, and ignores a click on it silently", async () => {
    const { router, ask, handlers, wireOutbound, texts, closes } = setup();
    ask();
    ask({ id: "offer-5678", messageId: "prompt-msg-2", question: "Shall I add this to **SD-7**?" });
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
    expect(closes()).toEqual([[PROMPT_ID, closed("This question was replaced by a newer one.")]]);
    expect(texts()).toEqual([]);
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
    const { router, ask, handlers, wireOutbound, closes } = setup();
    ask({ choices: [keyChoice("SD-40", { kind: "resolve", issueKey: "SD-40" }), keyChoice("SD-41", { kind: "resolve", issueKey: "SD-41" }), cancelChoice()] });
    await router.onButtonClicked(click(alice, `${OFFER_ID}:1`));
    expect(closes()).toEqual([[PROMPT_ID, closed("Answered by Alice: SD-41")]]);
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

    it("a text yes closes the message as answered; a later click runs nothing and gets no confirmation or text", async () => {
      const { router, ask, handlers, wireOutbound, texts, closes } = setup();
      ask();
      await router.onTextMessageReceived(text(alice, "yes"));
      expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledOnce();
      expect(closes()).toEqual([[PROMPT_ID, closed("Answered by Alice: Yes")]]);

      await router.onButtonClicked(click(alice, `${OFFER_ID}:1`));
      await router.onButtonClicked(click(bob, `${OFFER_ID}:0`));
      expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledOnce();
      expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
      expect(texts()).toEqual([]);
      expect(closes()).toHaveLength(1);
    });

    it("a text no closes the message as answered, and a click on [Yes] writes nothing", async () => {
      const { router, ask, handlers, wireOutbound, texts, closes } = setup();
      ask();
      await router.onTextMessageReceived(text(alice, "no thanks"));
      await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
      expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
      expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
      expect(texts()).toEqual(["Understood, I won't."]);
      expect(closes()).toEqual([[PROMPT_ID, closed("Answered by Alice: No")]]);
    });

    it("an acknowledgment keeps the question open: no close, and the asked person's click still counts", async () => {
      const { router, ask, handlers, closes } = setup();
      ask();
      await router.onTextMessageReceived(text(alice, "ok"));
      expect(closes()).toEqual([]);
      await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
      expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledOnce();
      expect(closes()).toEqual([[PROMPT_ID, closed("Answered by Alice: Yes")]]);
    });

    it("closes the question when the requester's next message is not an answer, and a later click is silent", async () => {
      const { router, ask, handlers, texts, closes } = setup();
      ask();
      await router.onTextMessageReceived(text(alice, "lunch at noon?"));
      expect(closes()).toEqual([[PROMPT_ID, closed("Closed, as the next message was not an answer.")]]);
      await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
      expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
      expect(texts()).toEqual([]);
      expect(closes()).toHaveLength(1);
    });

    it("another member's message leaves the question open", async () => {
      const { router, ask, closes } = setup();
      ask();
      await router.onTextMessageReceived(text(bob, "lunch at noon?"));
      expect(closes()).toEqual([]);
    });

    it("closes a choice answered by text with the chosen option's label", async () => {
      const choices = [keyChoice("SD-40", { kind: "resolve", issueKey: "SD-40" }), keyChoice("SD-41", { kind: "resolve", issueKey: "SD-41" }), cancelChoice()];
      for (const [answer, label] of [["2", "SD-41"], ["sd-40", "SD-40"], ["no", "Cancel"], ["cancel", "Cancel"]] as const) {
        const { router, ask, closes } = setup();
        ask({ choices });
        await router.onTextMessageReceived(text(alice, answer));
        expect(closes()).toEqual([[PROMPT_ID, closed(`Answered by Alice: ${label}`)]]);
      }
    });

    it("closes a new-or-existing choice answered by text with its label", async () => {
      const add: OfferCommand = { kind: "reply", issueKey: "SD-38", body: "The printer jams again." };
      const raise: OfferCommand = { kind: "support", requestKind: "fault", summary: "Printer jams", description: "The printer jams." };
      const choices = [addToChoice("SD-38", add), raiseNewChoice(raise), cancelChoice()];
      for (const [answer, label] of [["SD-38", "Add to SD-38"], ["new", "Raise new request"], ["cancel", "Cancel"]] as const) {
        const { router, ask, closes } = setup();
        ask({ command: raise, choices });
        await router.onTextMessageReceived(text(alice, answer));
        expect(closes()).toEqual([[PROMPT_ID, closed(`Answered by Alice: ${label}`)]]);
      }
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

describe("WireEventRouter contract: metrics of button clicks", () => {
  it("counts each click by outcome, every click as a message received, and the offer as made and accepted", async () => {
    const { metrics, of } = fakeMetrics();
    const { router, ask } = setup({ metrics });
    ask();

    await router.onButtonClicked(click(bob, `${OFFER_ID}:0`));
    await router.onButtonClicked(click(alice, "offer-other:0"));
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
    await router.onButtonClicked(click(alice, `${OFFER_ID}:1`));
    await router.onButtonClicked(click(bob, `${OFFER_ID}:0`, "unknown-msg"));

    expect(of("buttonClick")).toEqual([["not_asked"], ["invalid"], ["accepted"], ["late"], ["late"]]);
    expect(of("wireMessageReceived")).toEqual(Array(5).fill(["button_click"]));
    expect(of("offer")).toEqual([["made"], ["accepted"]]);
  });

  it("counts a declining click as declined, and texts and other events by kind", async () => {
    const { metrics, of } = fakeMetrics();
    const { router, ask } = setup({ metrics });
    ask();
    await router.onButtonClicked(click(alice, `${OFFER_ID}:1`));
    await router.onTextMessageReceived(text(bob, "hello"));
    await router.onTextMessageEdited({} as never);
    await router.onPingReceived({} as never);
    await router.onMessageReactionReceived({} as never);
    expect(of("offer")).toEqual([["made"], ["declined"]]);
    expect(of("wireMessageReceived")).toEqual([["button_click"], ["text"], ["other"], ["other"], ["other"]]);
  });
});

describe("WireEventRouter contract: the Message handled line for clicks", () => {
  it("logs each click's outcome at debug, with no names, and none of the old click lines at info", async () => {
    const { router, ask, deps } = setup();
    ask();
    await router.onButtonClicked(click(bob, `${OFFER_ID}:0`));
    await router.onButtonClicked(click(alice, "offer-other:0"));
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
    await router.onButtonClicked(click(alice, `${OFFER_ID}:1`));
    await router.onButtonClicked(click(botId, `${OFFER_ID}:0`));

    const lines = vi.mocked(deps.logger.debug).mock.calls.filter((call) => call[0] === "Message handled").map((call) => call[1]!);
    expect(lines).toEqual([
      { kind: "button_click", route: "not_asked", durationMs: expect.any(Number) },
      { kind: "button_click", route: "invalid", durationMs: expect.any(Number) },
      { kind: "button_click", route: "accepted", durationMs: expect.any(Number), chosen: true },
      { kind: "button_click", route: "late", durationMs: expect.any(Number), known: true, answered: true },
      { kind: "button_click", route: "ignored", durationMs: expect.any(Number) },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/Alice|Bob/);
    expect(vi.mocked(deps.logger.info).mock.calls.map((call) => call[0] as string).filter((msg) => /^Button: |^Message handled/.test(msg))).toEqual([]);
  });

  it("logs a failing click as failed with its outcome, next to the error line", async () => {
    const { router, ask, deps } = setup();
    ask();
    vi.spyOn(deps.confirmOffer, "choose").mockRejectedValue(new TypeError("offline"));
    await router.onButtonClicked(click(alice, `${OFFER_ID}:0`));
    expect(deps.logger.error).toHaveBeenCalledWith("Button handler failed", { err: "TypeError" });
    const lines = vi.mocked(deps.logger.debug).mock.calls.filter((call) => call[0] === "Message handled").map((call) => call[1]!);
    expect(lines).toEqual([{ kind: "button_click", route: "accepted", durationMs: expect.any(Number), failed: true }]);
  });
});
