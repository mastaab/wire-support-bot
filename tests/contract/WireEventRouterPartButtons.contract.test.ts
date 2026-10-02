/**
 * Contract tests for the button questions of a part order (the quantity and the delivery
 * location): the router with the real offer store, the real ConfirmOffer and the real
 * CompletePartOrder, with a mocked triage model, mocked support use cases and ports. No DB,
 * network or SDK.
 */
import { describe, it, expect, vi } from "vitest";
import type { CompositeButtonAction, TextMessage } from "@wireapp/wire-apps-js-sdk";
import { WireEventRouter } from "../../src/infrastructure/wire/WireEventRouter";
import type { WireEventRouterDeps } from "../../src/infrastructure/wire/WireEventRouter";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import { InMemoryMemberCache } from "../../src/infrastructure/services/InMemoryMemberCache";
import { ConfirmOffer } from "../../src/application/usecases/jira/ConfirmOffer";
import type { ConfirmOfferHandlers } from "../../src/application/usecases/jira/ConfirmOffer";
import { CompletePartOrder } from "../../src/application/usecases/jira/CompletePartOrder";
import { askPartOrderStep } from "../../src/application/services/partOrderSteps";
import { DEFAULT_PART_ASSET } from "../../src/domain/entities/SupportRequest";
import type { PartDetails } from "../../src/domain/entities/SupportRequest";
import type { OfferCommand } from "../../src/application/ports/PendingOfferPort";
import type { CompositeButton } from "../../src/application/ports/WireOutboundPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const convId: QualifiedId = { id: "conv-1", domain: "example.com" };
const alice: QualifiedId = { id: "user-1", domain: "example.com" };
const bob: QualifiedId = { id: "user-2", domain: "example.com" };
const botId: QualifiedId = { id: "bot-1", domain: "example.com" };

const LOCATIONS = ["Depot north", "Depot south"];

type PartOrder = Extract<OfferCommand, { kind: "support" }>;
const DRAFT: PartOrder = {
  kind: "support", requestKind: "part", summary: "Air filter for truck 12", description: "Truck 12 needs a new air filter.",
  part: { asset: "truck 12", part: "air filter" },
};

function setup(options: { locations?: string[]; extracted?: PartDetails } = {}) {
  const locations = options.locations ?? LOCATIONS;
  const pendingOffers = new InMemoryPendingOfferStore();
  const memberCache = new InMemoryMemberCache();
  memberCache.setMembers(convId, [{ userId: alice, role: "member", name: "Alice" }, { userId: bob, role: "member", name: "Bob" }]);
  const handlers = {
    raiseSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
    replyToServiceDesk: { execute: vi.fn().mockResolvedValue(true) },
    resolveSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
  };
  let sentCount = 0;
  /** Every question and notice, in order, with the buttons it carried. */
  const out: Array<{ text: string; buttons?: string[] }> = [];
  /** Every closed button message and its new text, in order. */
  const closes: Array<[string, string]> = [];
  const wireOutbound = {
    sendPlainText: vi.fn(async (_c: QualifiedId, text: string) => { out.push({ text }); return { messageId: `bot-${++sentCount}`, sha256: "" }; }),
    sendCompositePrompt: vi.fn(async (_c: QualifiedId, text: string, buttons: CompositeButton[]) => {
      out.push({ text, buttons: buttons.map((b) => b.label) });
      return { messageId: `bot-${++sentCount}`, sha256: "" };
    }),
    sendButtonConfirmation: vi.fn().mockResolvedValue(undefined),
    closeButtonPrompt: vi.fn(async (_c: QualifiedId, messageId: string, text: string) => { closes.push([messageId, text]); }),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    getUserProfile: vi.fn().mockResolvedValue(null),
    withTyping: <T>(_c: QualifiedId, work: () => Promise<T>): Promise<T> => work(),
  };
  const triage = { draftRequest: vi.fn(), matchStatusQuestion: vi.fn(), extractPartDetails: vi.fn().mockResolvedValue(options.extracted ?? {}) };
  const confirmOffer = new ConfirmOffer(pendingOffers, handlers as unknown as ConfirmOfferHandlers, wireOutbound, undefined, undefined, locations);
  const completePartOrder = new CompletePartOrder(triage, pendingOffers, wireOutbound, undefined, undefined, undefined, locations);
  const deps = {
    logger: { child: vi.fn().mockReturnThis(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    answerQuestion: { execute: vi.fn().mockResolvedValue("") },
    botUserId: botId,
    wireOutbound,
    messageBuffer: { clear: vi.fn(), push: vi.fn(), getLastN: vi.fn().mockReturnValue([]) },
    memberCache,
    channelConfig: { get: vi.fn().mockResolvedValue(null), upsert: vi.fn(), setTimezone: vi.fn() },
    raiseSupportRequest: handlers.raiseSupportRequest,
    completePartOrder,
    listSupportRequests: { execute: vi.fn() },
    resolveSupportRequest: handlers.resolveSupportRequest,
    replyToServiceDesk: handlers.replyToServiceDesk,
    getIssueStatus: { execute: vi.fn(), projectKey: "SD" },
    pendingOffers,
    confirmOffer,
    supportWelcome: { projectKey: "SD", passive: false, watching: false },
  } as unknown as WireEventRouterDeps;
  const router = new WireEventRouter(deps);
  /** Asks Alice the draft's next question, as the use cases do. */
  const ask = (command: PartOrder = DRAFT) => askPartOrderStep(
    { wireOutbound, offers: pendingOffers, now: () => new Date(), asset: DEFAULT_PART_ASSET, deliveryLocations: locations },
    { conversationId: convId, requesterId: alice, replyToMessageId: "msg-1" },
    command,
  );
  /** A click on button `label` of Alice's current question. */
  const clickLabel = (sender: QualifiedId, label: string): CompositeButtonAction => {
    const live = pendingOffers.find(convId, alice)!;
    const index = live.choices ? live.choices.findIndex((c) => c.label === label) : ["Yes", "No"].indexOf(label);
    return click(sender, `${live.id}:${index}`, live.messageId!);
  };
  return { router, pendingOffers, handlers, wireOutbound, triage, out, closes, ask, clickLabel };
}

let count = 0;
function click(sender: QualifiedId, buttonId: string, referenceMessageId: string): CompositeButtonAction {
  return { type: "composite_button_action", id: `click-${++count}`, conversationId: convId, sender, buttonId, referenceMessageId };
}

function text(sender: QualifiedId, body: string): TextMessage {
  return { type: "text", id: `text-${++count}`, text: body, conversationId: convId, sender, timestamp: new Date() };
}

describe("WireEventRouter contract: part-order button questions", () => {
  it("asks the quantity, then the delivery location, then the complete order, each decided by the requester's click", async () => {
    const { router, handlers, wireOutbound, out, closes, ask, clickLabel } = setup();
    await ask();
    expect(out).toEqual([{ text: "How many shall I order?", buttons: ["1", "2", "5", "Other"] }]);

    await router.onButtonClicked(clickLabel(alice, "2"));
    expect(wireOutbound.sendButtonConfirmation).toHaveBeenCalledTimes(1);
    expect(out[1]).toEqual({ text: "Where shall I deliver it?", buttons: ["Depot north", "Depot south", "Other"] });
    expect(closes).toEqual([["bot-1", "How many shall I order?\n\nAnswered by Alice: 2"]]);

    await router.onButtonClicked(clickLabel(alice, "Depot south"));
    expect(closes[1]).toEqual(["bot-2", "Where shall I deliver it?\n\nAnswered by Alice: Depot south"]);
    expect(wireOutbound.sendButtonConfirmation).toHaveBeenCalledTimes(2);
    expect(out[2]!.buttons).toEqual(["Yes", "No"]);
    expect(out[2]!.text).toContain("Shall I order this part?");
    expect(out[2]!.text).toContain("> Quantity: 2\n> Deliver to: Depot south");
    expect(out[2]!.text).not.toContain("(yes or no)");
    expect(handlers.raiseSupportRequest.execute).not.toHaveBeenCalled();

    await router.onButtonClicked(clickLabel(alice, "Yes"));
    expect(closes[2]![1]).toMatch(/^Shall I order this part\?\n[\s\S]*\n\nAnswered by Alice: Yes$/);
    expect(closes).toHaveLength(3);
    expect(handlers.raiseSupportRequest.execute).toHaveBeenCalledOnce();
    expect(handlers.raiseSupportRequest.execute).toHaveBeenCalledWith(expect.objectContaining({
      requestKind: "part", requesterId: alice, part: { asset: "truck 12", part: "air filter", quantity: "2", deliverTo: "Depot south" },
    }));
  });

  it("answers another member's click on the quantity once, changes nothing, and still accepts the requester's click", async () => {
    const { router, pendingOffers, wireOutbound, out, ask, clickLabel } = setup();
    await ask();
    const question = pendingOffers.find(convId, alice)!;

    await router.onButtonClicked(clickLabel(bob, "5"));
    await router.onButtonClicked(clickLabel(bob, "1"));
    expect(out.slice(1)).toEqual([{ text: "Only Alice can answer this." }]);
    expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
    expect(pendingOffers.find(convId, alice)?.id).toBe(question.id);

    await router.onButtonClicked(clickLabel(alice, "1"));
    expect(wireOutbound.sendButtonConfirmation).toHaveBeenCalledOnce();
    expect(pendingOffers.find(convId, alice)?.command).toMatchObject({ part: { quantity: "1" } });
  });

  it("ignores the requester's repeated click on an answered quantity question silently: no confirmation, no change", async () => {
    const { router, pendingOffers, wireOutbound, out, closes, ask } = setup();
    await ask();
    const question = pendingOffers.find(convId, alice)!;
    await router.onButtonClicked(click(alice, `${question.id}:1`, question.messageId!));
    await router.onButtonClicked(click(alice, `${question.id}:2`, question.messageId!));
    await router.onButtonClicked(click(alice, `${question.id}:0`, question.messageId!));

    expect(wireOutbound.sendButtonConfirmation).toHaveBeenCalledOnce();
    expect(out.map((o) => o.text)).toEqual(["How many shall I order?", "Where shall I deliver it?"]);
    expect(closes).toEqual([["bot-1", "How many shall I order?\n\nAnswered by Alice: 2"]]);
    expect(pendingOffers.find(convId, alice)?.command).toMatchObject({ part: { quantity: "2" } });
  });

  it("closes an expired location question when a click finds it, without a change, a confirmation or a text", async () => {
    const { router, pendingOffers, wireOutbound, out, closes, ask } = setup();
    await ask({ ...DRAFT, part: { ...DRAFT.part, quantity: "2" } });
    const question = pendingOffers.find(convId, alice)!;
    pendingOffers.put({ ...question, expiresAt: new Date(Date.now() - 1) });
    await router.onButtonClicked(click(alice, `${question.id}:0`, question.messageId!));
    await router.onButtonClicked(click(bob, `${question.id}:1`, question.messageId!));
    expect(out.map((o) => o.text)).toEqual(["Where shall I deliver it?"]);
    expect(closes).toEqual([["bot-1", "Where shall I deliver it?\n\nThis question has expired."]]);
    expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
  });

  it("asks for the quantity in text after [Other], and a typed number then leads to the location buttons", async () => {
    const { router, pendingOffers, triage, out, ask, clickLabel } = setup({ extracted: { quantity: "7" } });
    await ask();
    await router.onButtonClicked(clickLabel(alice, "Other"));
    expect(out[1]).toEqual({ text: "To order it I need the quantity. What is it?" });
    expect(pendingOffers.find(convId, alice)?.choices).toBeUndefined();

    await router.onTextMessageReceived(text(alice, "7"));
    expect(triage.extractPartDetails).toHaveBeenCalledWith("7");
    expect(out[2]).toEqual({ text: "Where shall I deliver it?", buttons: ["Depot north", "Depot south", "Other"] });
    expect(pendingOffers.find(convId, alice)?.command).toMatchObject({ part: { quantity: "7" } });
  });

  it("fills a typed number for the quantity in code and closes the question with it; a later click is silent", async () => {
    const { router, pendingOffers, triage, wireOutbound, out, closes, ask } = setup();
    await ask();
    const question = pendingOffers.find(convId, alice)!;
    await router.onTextMessageReceived(text(alice, "3"));
    expect(triage.extractPartDetails).not.toHaveBeenCalled();
    expect(out[1]).toEqual({ text: "Where shall I deliver it?", buttons: ["Depot north", "Depot south", "Other"] });
    expect(pendingOffers.find(convId, alice)?.command).toMatchObject({ part: { quantity: "3" } });

    expect(closes).toEqual([["bot-1", "How many shall I order?\n\nAnswered by Alice: 3"]]);

    await router.onButtonClicked(click(alice, `${question.id}:0`, question.messageId!));
    expect(out).toHaveLength(2);
    expect(closes).toHaveLength(1);
    expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
  });

  it("takes a typed location name like a click and then offers the complete order", async () => {
    const { router, triage, out, closes, ask } = setup();
    await ask({ ...DRAFT, part: { ...DRAFT.part, quantity: "2" } });
    await router.onTextMessageReceived(text(alice, "depot north please"));
    expect(triage.extractPartDetails).not.toHaveBeenCalled();
    expect(closes).toEqual([["bot-1", "Where shall I deliver it?\n\nAnswered by Alice: Depot north"]]);
    expect(out[1]!.buttons).toEqual(["Yes", "No"]);
    expect(out[1]!.text).toContain("> Deliver to: Depot north");
  });

  it("takes a correction at the location question, shows the details so far and closes the old question with the value", async () => {
    const { router, pendingOffers, out, closes, ask } = setup({ extracted: { quantity: "three" } });
    await ask({ ...DRAFT, part: { ...DRAFT.part, quantity: "2" } });
    const question = pendingOffers.find(convId, alice)!;

    await router.onTextMessageReceived(text(alice, "actually three"));
    expect(out[1]).toEqual({
      text: "Where shall I deliver it?\nSo far:\n> Asset: truck 12\n> Part: air filter\n> Quantity: three",
      buttons: ["Depot north", "Depot south", "Other"],
    });
    expect(pendingOffers.find(convId, alice)?.command).toMatchObject({ part: { quantity: "three" } });

    expect(closes).toEqual([["bot-1", "Where shall I deliver it?\n\nAnswered by Alice: three"]]);

    await router.onButtonClicked(click(alice, `${question.id}:0`, question.messageId!));
    expect(out).toHaveLength(2);
    expect(closes).toHaveLength(1);
  });

  it("takes a typed free-text location the triage reports when it is not a configured one", async () => {
    const { router, out, closes, ask } = setup({ extracted: { deliverTo: "workshop 3" } });
    await ask({ ...DRAFT, part: { ...DRAFT.part, quantity: "2" } });
    await router.onTextMessageReceived(text(alice, "to workshop 3"));
    expect(closes).toEqual([["bot-1", "Where shall I deliver it?\n\nAnswered by Alice: workshop 3"]]);
    expect(out[1]!.buttons).toEqual(["Yes", "No"]);
    expect(out[1]!.text).toContain("> Deliver to: workshop 3");
  });

  it("asks for the delivery location in text after the quantity click when no locations are configured", async () => {
    const { router, out, ask, clickLabel } = setup({ locations: [] });
    await ask();
    await router.onButtonClicked(clickLabel(alice, "5"));
    expect(out[1]).toEqual({ text: "To order it I need the delivery location. What is it?" });
  });

  it("declines the order for a typed no and says what is still missing for a typed yes", async () => {
    const yes = setup();
    await yes.ask();
    await yes.router.onTextMessageReceived(text(alice, "yes"));
    expect(yes.out[1]).toEqual({ text: "I haven't ordered anything yet: I still need the quantity and the delivery location." });
    expect(yes.pendingOffers.find(convId, alice)?.fillsPart).toBe("quantity");
    expect(yes.closes).toEqual([]);

    const no = setup();
    await no.ask();
    await no.router.onTextMessageReceived(text(alice, "no"));
    expect(no.out[1]).toEqual({ text: "Understood, I won't." });
    expect(no.pendingOffers.has(convId, alice)).toBe(false);
    expect(no.handlers.raiseSupportRequest.execute).not.toHaveBeenCalled();
    expect(no.closes).toEqual([["bot-1", "How many shall I order?\n\nAnswered by Alice: No"]]);
  });

  it("closes the quantity question as not answered when the requester's next message is no part detail", async () => {
    const { router, out, closes, ask } = setup();
    await ask();
    await router.onTextMessageReceived(text(alice, "lunch at noon?"));
    expect(out).toHaveLength(1);
    expect(closes).toEqual([["bot-1", "How many shall I order?\n\nClosed, as the next message was not an answer."]]);
  });

  it("closes the complete order's [Yes] [No] with the corrected value when a correction moves it on", async () => {
    const { router, out, closes, ask } = setup({ extracted: { quantity: "4" } });
    await ask({ ...DRAFT, part: { ...DRAFT.part, quantity: "2", deliverTo: "Depot north" } });
    expect(out[0]!.buttons).toEqual(["Yes", "No"]);
    await router.onTextMessageReceived(text(alice, "make it 4"));
    expect(out[1]!.buttons).toEqual(["Yes", "No"]);
    expect(closes).toHaveLength(1);
    expect(closes[0]![0]).toBe("bot-1");
    expect(closes[0]![1]).toMatch(/^Shall I order this part\?\n[\s\S]*\n\nAnswered by Alice: 4$/);
  });

  it("closes the [Yes] of an incomplete order as answered and keeps the draft for the missing details", async () => {
    const { router, pendingOffers, out, closes, ask } = setup();
    const draft: PartOrder = { ...DRAFT, part: { ...DRAFT.part, quantity: "2", deliverTo: "Depot north" } };
    await ask(draft);
    const question = pendingOffers.find(convId, alice)!;
    // The complete order loses its delivery location (as an amended offer may), then the requester says yes.
    pendingOffers.put({ ...question, command: { ...draft, part: { ...DRAFT.part, quantity: "2" } } });
    await router.onTextMessageReceived(text(alice, "yes"));
    expect(out[1]).toEqual({ text: "I haven't ordered anything yet: I still need the delivery location." });
    expect(closes).toHaveLength(1);
    expect(closes[0]![1]).toMatch(/\n\nAnswered by Alice: Yes$/);
    expect(pendingOffers.has(convId, alice)).toBe(true);
  });
});
