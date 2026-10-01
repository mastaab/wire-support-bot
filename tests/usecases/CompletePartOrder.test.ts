import { describe, it, expect, vi } from "vitest";
import { CompletePartOrder } from "../../src/application/usecases/jira/CompletePartOrder";
import type { CompletePartOrderInput } from "../../src/application/usecases/jira/CompletePartOrder";
import { OFFER_TTL_MS, formatMissingPartsQuestion, formatSupportQuestion } from "../../src/application/services/offers";
import { withoutAnswerHint } from "../../src/application/services/offerButtons";
import type { OfferCommand } from "../../src/application/services/offers";
import { PART_DETAIL_MAX } from "../../src/domain/entities/SupportRequest";
import type { PartDetails } from "../../src/domain/entities/SupportRequest";
import { alice, convId, loggedText, makeLogger, makeWire, sentRefFor } from "./supportRequestFakes";

const MESSAGE = "PRIVATE_MESSAGE_MARKER deliver to depot north";
const NOW = new Date("2026-09-26T12:00:00Z");

const DRAFT: Extract<OfferCommand, { kind: "support" }> = {
  kind: "support",
  requestKind: "part",
  summary: "Paper tray for printer 7",
  description: "I need a new paper tray for printer 7.",
  part: { asset: "printer 7", part: "PRIVATE_PART_MARKER paper tray", quantity: "1" },
};

function input(overrides: Partial<CompletePartOrderInput> = {}): CompletePartOrderInput {
  return { text: MESSAGE, conversationId: convId, requesterId: alice, pending: DRAFT, replyToMessageId: "msg-9", ...overrides };
}

function setup(extracted: PartDetails = { deliverTo: "depot north" }, deliveryLocations: string[] = []) {
  const triage = {
    draftRequest: vi.fn(),
    matchStatusQuestion: vi.fn(),
    extractPartDetails: vi.fn().mockResolvedValue(extracted),
  };
  const offers = {
    put: vi.fn(), take: vi.fn(), has: vi.fn().mockReturnValue(false), peek: vi.fn(), clearConversation: vi.fn(),
    drop: vi.fn(), recentlyDropped: vi.fn(), forgetDropped: vi.fn(), find: vi.fn(), prompt: vi.fn(), markAnswered: vi.fn(), claimNotice: vi.fn(),
  };
  const { wire, sent } = makeWire();
  const logger = makeLogger();
  const useCase = new CompletePartOrder(triage, offers, wire, logger, () => NOW, undefined, deliveryLocations);
  return { triage, offers, wire, sent, logger, useCase };
}

describe("CompletePartOrder", () => {
  it.each(["unknown", "Not stated", "N/A", "null"])("ignores the placeholder %j as a value", async (placeholder) => {
    const pending: OfferCommand = { ...DRAFT, part: { ...DRAFT.part, deliverTo: "depot north" } };
    const { sent, offers, useCase } = setup({ deliverTo: placeholder });

    await expect(useCase.execute(input({ pending, text: `deliver to ${placeholder}` }))).resolves.toBe(false);

    expect(sent).toEqual([]);
    expect(offers.put).not.toHaveBeenCalled();
  });

  it("drops a asset, part or delivery location that does not appear in the message, keeping the quantity", async () => {
    const { offers, useCase } = setup({ asset: "printer 12", deliverTo: "depot west", quantity: "2" });

    await expect(useCase.execute(input({ text: "two please" }))).resolves.toBe(true);

    expect(offers.put.mock.calls[0]![0].command.part).toEqual({ ...DRAFT.part, quantity: "2" });
  });

  it("shows the details so far when a change leaves the order incomplete", async () => {
    const pending: OfferCommand = { ...DRAFT, part: { asset: "printer 7", part: "paper tray" } };
    const { sent, useCase } = setup({ asset: "printer 9" });

    await expect(useCase.execute(input({ pending, text: "sorry, it's printer 9" }))).resolves.toBe(true);

    expect(sent[0]).toBe("How many shall I order?\nSo far:\n> Asset: printer 9\n> Part: paper tray");
  });

  it("corrects a value in a complete part order and shows the updated offer", async () => {
    const complete: OfferCommand = { ...DRAFT, part: { ...DRAFT.part, deliverTo: "depot south" } };
    const { offers, sent, useCase } = setup({ quantity: "3" });

    await expect(useCase.execute(input({ pending: complete, text: "actually three" }))).resolves.toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Shall I order this part?");
    expect(sent[0]).toContain("> Quantity: 3");
    expect(offers.put.mock.calls[0]![0].command).toMatchObject({ part: { quantity: "3", deliverTo: "depot south" } });
  });

  it("leaves a message that only restates the draft to normal routing", async () => {
    const complete: OfferCommand = { ...DRAFT, part: { ...DRAFT.part, deliverTo: "depot south" } };
    const { offers, sent, useCase } = setup({ deliverTo: "depot south" });

    await expect(useCase.execute(input({ pending: complete, text: "to depot south" }))).resolves.toBe(false);

    expect(sent).toEqual([]);
    expect(offers.put).not.toHaveBeenCalled();
  });

  it.each<[string, OfferCommand]>([
    ["a fault", { kind: "support", requestKind: "fault", summary: "Paper jam", description: "The paper jam is on." }],
    ["a question", { kind: "support", requestKind: "question", summary: "Oil", description: "Which oil?" }],
    ["a reply offer", { kind: "reply", issueKey: "SD-6", body: "It happened again." }],
    ["a resolve offer", { kind: "resolve", issueKey: "SD-6" }],
  ])("does nothing for %s", async (_label, pending) => {
    const { triage, offers, sent, useCase } = setup();

    await expect(useCase.execute(input({ pending }))).resolves.toBe(false);

    expect(triage.extractPartDetails).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(offers.put).not.toHaveBeenCalled();
  });

  it("asks the triage about this single message only", async () => {
    const { triage, useCase } = setup();

    await useCase.execute(input());

    expect(triage.extractPartDetails).toHaveBeenCalledExactlyOnceWith(MESSAGE);
  });

  it.each<[string, PartDetails]>([
    ["nothing", {}],
    ["only blanks", { asset: "  ", part: "\n", quantity: "", deliverTo: " \t " }],
    ["only over-long values", { deliverTo: "x".repeat(PART_DETAIL_MAX + 1) }],
  ])("does nothing when the message states %s", async (_label, extracted) => {
    const { sent, offers, useCase } = setup(extracted);

    await expect(useCase.execute(input())).resolves.toBe(false);

    expect(sent).toEqual([]);
    expect(offers.put).not.toHaveBeenCalled();
  });

  it("logs an extraction failure by error name only and does nothing", async () => {
    const { triage, sent, offers, logger, useCase } = setup();
    triage.extractPartDetails.mockRejectedValue(new TypeError("PRIVATE_MESSAGE_MARKER timeout"));

    await expect(useCase.execute(input())).resolves.toBe(false);

    expect(sent).toEqual([]);
    expect(offers.put).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("CompletePartOrder: extractPartDetails failed", { err: "TypeError" });
    expect(loggedText(logger)).not.toContain("PRIVATE_MESSAGE_MARKER");
  });

  it("asks for exactly the free-text essential still missing after a partial fill and keeps the draft", async () => {
    const pending: OfferCommand = { ...DRAFT, part: { quantity: "2" } };
    const { wire, sent, offers, useCase } = setup({ part: "paper tray" });

    await expect(useCase.execute(input({ pending, text: "a paper tray" }))).resolves.toBe(true);

    expect(sent).toEqual([formatMissingPartsQuestion(["asset"])]);
    expect(sent[0]).toBe("To order it I need the item the part is for (for example a serial number). What is it?");
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-9" });
    expect(offers.put.mock.calls[0]![0].command).toEqual({ ...DRAFT, part: { quantity: "2", part: "paper tray" } });
  });

  it("asks for the quantity with buttons once the free-text essentials are known, and keeps the draft", async () => {
    const pending: OfferCommand = { ...DRAFT, part: { part: "paper tray" } };
    const { wire, sent, offers, useCase } = setup({ asset: "printer 7" }, ["Depot north", "Depot south"]);

    await expect(useCase.execute(input({ pending, text: "it's for printer 7" }))).resolves.toBe(true);

    const offer = offers.put.mock.calls[0]![0];
    expect(sent).toEqual(["How many shall I order?"]);
    expect(wire.sendCompositePrompt).toHaveBeenCalledWith(convId, "How many shall I order?", [
      { id: `${offer.id}:0`, label: "1" }, { id: `${offer.id}:1`, label: "2" }, { id: `${offer.id}:2`, label: "5" }, { id: `${offer.id}:3`, label: "Other" },
    ], { replyToMessageId: "msg-9" });
    expect(wire.sendPlainText).not.toHaveBeenCalled();
    expect(offer).toMatchObject({ fillsPart: "quantity", messageId: sentRefFor(1).messageId });
    expect(offer.command).toEqual({ ...DRAFT, part: { part: "paper tray", asset: "printer 7" } });
  });

  it("asks for the delivery location with the configured locations after a typed quantity", async () => {
    const pending: OfferCommand = { ...DRAFT, part: { asset: "printer 7", part: "paper tray" } };
    const { wire, sent, offers, useCase } = setup({ quantity: "3" }, ["Depot north", "Depot south"]);

    await expect(useCase.execute(input({ pending, text: "3" }))).resolves.toBe(true);

    const offer = offers.put.mock.calls[0]![0];
    expect(sent).toEqual(["Where shall I deliver it?"]);
    expect(wire.sendCompositePrompt.mock.calls[0]![2]).toEqual([
      { id: `${offer.id}:0`, label: "Depot north" }, { id: `${offer.id}:1`, label: "Depot south" }, { id: `${offer.id}:2`, label: "Other" },
    ]);
    expect(offer.fillsPart).toBe("deliverTo");
    expect(offer.command.part).toEqual({ asset: "printer 7", part: "paper tray", quantity: "3" });
  });

  it("asks for the delivery location in text after a typed quantity when no locations are configured", async () => {
    const pending: OfferCommand = { ...DRAFT, part: { asset: "printer 7", part: "paper tray" } };
    const { wire, sent, offers, useCase } = setup({ quantity: "3" });

    await expect(useCase.execute(input({ pending, text: "3" }))).resolves.toBe(true);

    expect(sent).toEqual(["To order it I need the delivery location. What is it?"]);
    expect(wire.sendCompositePrompt).not.toHaveBeenCalled();
    expect(offers.put.mock.calls[0]![0].fillsPart).toBeUndefined();
  });

  it("shows the part offer with the four lines once the order is complete", async () => {
    const { sent, offers, useCase } = setup({ deliverTo: "  depot\n north " });

    await expect(useCase.execute(input())).resolves.toBe(true);

    const part = { ...DRAFT.part, deliverTo: "depot north" };
    expect(sent).toEqual([withoutAnswerHint(formatSupportQuestion(DRAFT.summary, DRAFT.description, "part", part))]);
    expect(sent[0]).not.toContain("(yes or no)");
    expect(sent[0]).toContain("Shall I order this part?");
    for (const line of ["> Asset: printer 7", "> Part: PRIVATE_PART_MARKER paper tray", "> Quantity: 1", "> Deliver to: depot north"]) {
      expect(sent[0]).toContain(line);
    }
    expect(offers.put.mock.calls[0]![0].command).toEqual({
      kind: "support", requestKind: "part", summary: DRAFT.summary, description: DRAFT.description, part,
    });
  });

  it("replaces an earlier value with the one in this message", async () => {
    const { sent, offers, useCase } = setup({ quantity: "three", deliverTo: "depot north" });

    await useCase.execute(input({ text: "actually three, deliver to depot north" }));

    const command = offers.put.mock.calls[0]![0].command;
    expect(command.part).toEqual({ asset: "printer 7", part: "PRIVATE_PART_MARKER paper tray", quantity: "three", deliverTo: "depot north" });
    expect(sent[0]).toContain("> Quantity: three");
    expect(sent[0]).not.toContain("> Quantity: 1");
  });

  it("keeps earlier values that this message leaves blank or over the limit", async () => {
    const { offers, useCase } = setup({ asset: "  ", part: "x".repeat(PART_DETAIL_MAX + 1), deliverTo: "depot north" });

    await useCase.execute(input());

    expect(offers.put.mock.calls[0]![0].command.part).toEqual({ ...DRAFT.part, deliverTo: "depot north" });
  });

  it("stores the updated draft for the requester with a fresh expiry after the send", async () => {
    const { wire, offers, useCase } = setup();

    await useCase.execute(input());

    expect(offers.put).toHaveBeenCalledTimes(1);
    expect(offers.put.mock.calls[0]![0]).toMatchObject({ conversationId: convId, requesterId: alice, createdAt: NOW, expiresAt: new Date(NOW.getTime() + OFFER_TTL_MS) });
    // The complete order is asked with [Yes] [No].
    expect(wire.sendCompositePrompt.mock.invocationCallOrder[0]).toBeLessThan(offers.put.mock.invocationCallOrder[0]!);
  });

  it("stores nothing when the send fails", async () => {
    const { wire, offers, logger, useCase } = setup();
    wire.sendCompositePrompt.mockRejectedValue(new TypeError("socket closed"));

    await expect(useCase.execute(input())).resolves.toBe(false);

    expect(offers.put).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("CompletePartOrder: sending the reply failed", { err: "TypeError" });
  });

  it("never logs the message or the part values", async () => {
    const { wire, logger, useCase } = setup({ deliverTo: "PRIVATE_DELIVERY_MARKER depot north" });
    await useCase.execute(input());
    wire.sendCompositePrompt.mockRejectedValue(new TypeError("PRIVATE_MESSAGE_MARKER"));
    await useCase.execute(input());

    const logged = loggedText(logger);
    for (const marker of ["PRIVATE_MESSAGE_MARKER", "PRIVATE_PART_MARKER", "PRIVATE_DELIVERY_MARKER", "printer 7"]) {
      expect(logged).not.toContain(marker);
    }
  });
});

describe("CompletePartOrder: buttons", () => {
  it("asks the complete order with [Yes] [No] and stores the button message, but asks for missing free-text details without buttons", async () => {
    const complete = setup();
    await complete.useCase.execute(input());
    const offer = complete.offers.put.mock.calls[0]![0];
    expect(complete.wire.sendCompositePrompt).toHaveBeenCalledWith(convId, expect.stringContaining("Shall I order this part?"), [
      { id: `${offer.id}:0`, label: "Yes" }, { id: `${offer.id}:1`, label: "No" },
    ], { replyToMessageId: "msg-9" });
    expect(offer.messageId).toBe(sentRefFor(1).messageId);

    const partial = setup({ quantity: "2" });
    await partial.useCase.execute(input({ pending: { ...DRAFT, part: { part: "paper tray" } }, text: "two of them" }));
    expect(partial.sent).toEqual([formatMissingPartsQuestion(["asset"])]);
    expect(partial.wire.sendCompositePrompt).not.toHaveBeenCalled();
    expect(partial.offers.put.mock.calls[0]![0].id).toBeUndefined();
  });
});
