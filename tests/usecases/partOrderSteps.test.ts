import { describe, it, expect, vi } from "vitest";
import { OTHER_LABEL, QUICK_QUANTITIES, askPartOrderStep, partOrderStep, partOrderTextQuestion } from "../../src/application/services/partOrderSteps";
import { OFFER_TTL_MS, formatMissingPartsQuestion, formatSupportQuestion } from "../../src/application/services/offers";
import { matchChoice } from "../../src/application/services/offerButtons";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import { DEFAULT_PART_ASSET } from "../../src/domain/entities/SupportRequest";
import type { PartAssetWording, PartDetails } from "../../src/domain/entities/SupportRequest";
import type { OfferCommand } from "../../src/application/ports/PendingOfferPort";
import { alice, convId, makeWire, sentRefFor } from "./supportRequestFakes";

type PartOrder = Extract<OfferCommand, { kind: "support" }>;
const order = (part: PartDetails): PartOrder => ({
  kind: "support", requestKind: "part", summary: "Air filter for truck 12", description: "Truck 12 needs a new air filter.", part,
});
const LOCATIONS = ["Depot north", "Depot south"];
const TRUCK: PartAssetWording = { label: "Truck", question: "the truck (fleet number)" };

describe("partOrderStep", () => {
  it("asks for the asset and the part together, in text, before anything else", () => {
    const step = partOrderStep(order({}), TRUCK, LOCATIONS);
    expect(step).toEqual({ question: "To order it I need the truck (fleet number) and the part (name or number). What are they?", buttons: false });
  });

  it("asks only for the free-text essential that is missing, even when the quantity is missing too", () => {
    expect(partOrderStep(order({ part: "air filter" }), TRUCK, LOCATIONS).question).toBe("To order it I need the truck (fleet number). What is it?");
    expect(partOrderStep(order({ asset: "truck 12", deliverTo: "Depot north" }), TRUCK, LOCATIONS).question)
      .toBe("To order it I need the part (name or number). What is it?");
  });

  it("asks for the quantity with [1] [2] [5] [Other] once the asset and part are known, whether or not locations are configured", () => {
    for (const locations of [LOCATIONS, []]) {
      const draft = order({ asset: "truck 12", part: "air filter" });
      const step = partOrderStep(draft, TRUCK, locations);
      expect(step.question).toBe("How many shall I order?");
      expect(step.buttons).toBe(true);
      expect(step.fillsPart).toBe("quantity");
      expect(step.choices!.map((c) => c.label)).toEqual([...QUICK_QUANTITIES, OTHER_LABEL]);
      expect(step.choices!.map((c) => c.command)).toEqual([
        order({ asset: "truck 12", part: "air filter", quantity: "1" }),
        order({ asset: "truck 12", part: "air filter", quantity: "2" }),
        order({ asset: "truck 12", part: "air filter", quantity: "5" }),
        draft,
      ]);
    }
  });

  it("asks for the delivery location with the configured locations and [Other] once only it is missing", () => {
    const draft = order({ asset: "truck 12", part: "air filter", quantity: "2" });
    const step = partOrderStep(draft, TRUCK, LOCATIONS);
    expect(step.question).toBe("Where shall I deliver it?");
    expect(step.fillsPart).toBe("deliverTo");
    expect(step.choices!.map((c) => [c.label, c.answers])).toEqual([["Depot north", ["depot north"]], ["Depot south", ["depot south"]], ["Other", ["other", "something else"]]]);
    expect(step.choices![1]!.command).toEqual(order({ asset: "truck 12", part: "air filter", quantity: "2", deliverTo: "Depot south" }));
    expect(step.choices![2]!.command).toEqual(draft);
  });

  it("asks the quantity before the location when both are missing", () => {
    expect(partOrderStep(order({ asset: "truck 12", part: "air filter", deliverTo: "Depot north" }), TRUCK, LOCATIONS).fillsPart).toBe("quantity");
    expect(partOrderStep(order({ asset: "truck 12", part: "air filter" }), TRUCK, LOCATIONS).fillsPart).toBe("quantity");
  });

  it("asks for the delivery location in text when no locations are configured", () => {
    const step = partOrderStep(order({ asset: "truck 12", part: "air filter", quantity: "2" }), TRUCK, []);
    expect(step).toEqual({ question: "To order it I need the delivery location. What is it?", buttons: false });
    expect(partOrderStep(order({ asset: "truck 12", part: "air filter", quantity: "2" })).buttons).toBe(false);
  });

  it("asks in text for the essential the requester chose [Other] for", () => {
    expect(partOrderStep(order({ asset: "truck 12", part: "air filter" }), TRUCK, LOCATIONS, { inText: "quantity" }))
      .toEqual({ question: "To order it I need the quantity. What is it?", buttons: false });
    expect(partOrderStep(order({ asset: "truck 12", part: "air filter", quantity: "2" }), TRUCK, LOCATIONS, { inText: "deliverTo" }))
      .toEqual({ question: "To order it I need the delivery location. What is it?", buttons: false });
    // [Other] for the quantity does not affect the location question that follows.
    expect(partOrderStep(order({ asset: "truck 12", part: "air filter", quantity: "7" }), TRUCK, LOCATIONS, { inText: "quantity" }).fillsPart).toBe("deliverTo");
  });

  it("quotes the essentials so far under a question after a change", () => {
    const step = partOrderStep(order({ asset: "truck 14", part: "air filter" }), TRUCK, LOCATIONS, { soFar: true });
    expect(step.question).toBe("How many shall I order?\nSo far:\n> Truck: truck 14\n> Part: air filter");
    expect(partOrderStep(order({ part: "air filter" }), TRUCK, LOCATIONS, { soFar: true }).question)
      .toBe("To order it I need the truck (fleet number). What is it?\nSo far:\n> Part: air filter");
  });

  it("offers the complete order with [Yes] [No]", () => {
    const part = { asset: "truck 12", part: "air filter", quantity: "2", deliverTo: "Depot north" };
    expect(partOrderStep(order(part), TRUCK, LOCATIONS)).toEqual({
      question: formatSupportQuestion("Air filter for truck 12", "Truck 12 needs a new air filter.", "part", part, TRUCK), buttons: true,
    });
  });
});

describe("askPartOrderStep", () => {
  const deps = (wire: ReturnType<typeof makeWire>["wire"], offers = new InMemoryPendingOfferStore()) => ({
    wireOutbound: wire, offers, now: () => new Date("2026-10-01T10:00:00Z"), asset: DEFAULT_PART_ASSET, deliveryLocations: LOCATIONS,
  });
  const target = { conversationId: convId, requesterId: alice, replyToMessageId: "msg-9" };

  it("sends a button question without a text answer hint and then stores its options, ID and message", async () => {
    const { wire, sent } = makeWire();
    const offers = new InMemoryPendingOfferStore();
    const draft = order({ asset: "truck 12", part: "air filter" });
    await askPartOrderStep(deps(wire, offers), target, draft);
    const stored = offers.find(convId, alice, new Date("2026-10-01T10:00:00Z"))!;
    expect(sent).toEqual(["How many shall I order?"]);
    expect(wire.sendCompositePrompt).toHaveBeenCalledWith(convId, "How many shall I order?", [
      { id: `${stored.id}:0`, label: "1" }, { id: `${stored.id}:1`, label: "2" }, { id: `${stored.id}:2`, label: "5" }, { id: `${stored.id}:3`, label: "Other" },
    ], { replyToMessageId: "msg-9" });
    expect(stored).toMatchObject({ command: draft, fillsPart: "quantity", messageId: sentRefFor(1).messageId });
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(OFFER_TTL_MS);
    expect(offers.prompt(convId, sentRefFor(1).messageId)).toEqual({ offerId: stored.id, requesterId: alice, answered: false });
  });

  it("sends a text question as plain text and stores the draft without buttons", async () => {
    const { wire, sent } = makeWire();
    const offers = new InMemoryPendingOfferStore();
    await askPartOrderStep(deps(wire, offers), target, order({ part: "air filter" }));
    expect(sent).toEqual([formatMissingPartsQuestion(["asset"])]);
    expect(wire.sendCompositePrompt).not.toHaveBeenCalled();
    const stored = offers.find(convId, alice, new Date("2026-10-01T10:00:00Z"))!;
    expect(stored.id).toBeUndefined();
    expect(stored.choices).toBeUndefined();
    expect(stored.fillsPart).toBeUndefined();
  });

  it("stores nothing when the send fails", async () => {
    const { wire } = makeWire();
    wire.sendCompositePrompt.mockRejectedValue(new Error("socket closed"));
    const offers = { put: vi.fn() } as unknown as InMemoryPendingOfferStore;
    await expect(askPartOrderStep(deps(wire, offers), target, order({ asset: "truck 12", part: "air filter" }))).rejects.toThrow("socket closed");
    expect(offers.put).not.toHaveBeenCalled();
  });
});

describe("partOrderTextQuestion", () => {
  it("names the free-text essentials together, otherwise the next missing one, and nothing for a complete order", () => {
    expect(partOrderTextQuestion(order({ quantity: "2" }))).toBe(formatMissingPartsQuestion(["asset", "part"]));
    expect(partOrderTextQuestion(order({ asset: "truck 12", part: "air filter" }))).toBe(formatMissingPartsQuestion(["quantity"]));
    expect(partOrderTextQuestion(order({ asset: "truck 12", part: "air filter", quantity: "2" }))).toBe(formatMissingPartsQuestion(["deliverTo"]));
    expect(partOrderTextQuestion(order({ asset: "truck 12", part: "air filter", quantity: "2", deliverTo: "Depot north" }))).toBeNull();
    expect(partOrderTextQuestion({ kind: "resolve", issueKey: "SD-6" })).toBeNull();
  });
});

describe("matchChoice without numbers as positions", () => {
  it("matches the quick quantities by label, never a number by its position", () => {
    const { choices } = partOrderStep(order({ asset: "truck 12", part: "air filter" }), TRUCK, LOCATIONS);
    expect(matchChoice(choices!, "5", { byNumber: false })).toBe(2);
    expect(matchChoice(choices!, "2.", { byNumber: false })).toBe(1);
    expect(matchChoice(choices!, "Other", { byNumber: false })).toBe(3);
    expect(matchChoice(choices!, "3", { byNumber: false })).toBeNull();
    expect(matchChoice(choices!, "4", { byNumber: false })).toBeNull();
    // By default a number is the option's position, as for the other choices.
    expect(matchChoice(choices!, "3")).toBe(2);
  });
});
