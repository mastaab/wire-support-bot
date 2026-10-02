/**
 * The asset essential of a part order with a configured label and question (here a printer
 * example), through every path that shows or asks for it.
 */
import { describe, it, expect, vi } from "vitest";
import {
  formatMissingPartsQuestion, formatStillMissingReply, formatSupportQuestion, partDetailFields,
} from "../../src/application/services/offers";
import type { OfferCommand } from "../../src/application/services/offers";
import { statedPartDetails } from "../../src/application/services/partDetails";
import { RaiseSupportRequest } from "../../src/application/usecases/jira/RaiseSupportRequest";
import { CompletePartOrder } from "../../src/application/usecases/jira/CompletePartOrder";
import { ConfirmOffer } from "../../src/application/usecases/jira/ConfirmOffer";
import type { ConfirmOfferHandlers } from "../../src/application/usecases/jira/ConfirmOffer";
import { OfferSupportFromConversation } from "../../src/application/usecases/jira/OfferSupportFromConversation";
import type { GetIssueStatus } from "../../src/application/usecases/jira/GetIssueStatus";
import { AnswerQuestion } from "../../src/application/usecases/general/AnswerQuestion";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import { DEFAULT_PART_ASSET } from "../../src/domain/entities/SupportRequest";
import type { PartAssetWording } from "../../src/domain/entities/SupportRequest";
import { alice, convId, makeAudit, makeLogger, makeRequests, makeTracker, makeWire } from "./supportRequestFakes";

const PRINTER: PartAssetWording = { label: "Device", question: "the device (asset tag or room number)" };
const NOW = new Date("2026-09-26T12:00:00Z");
const COMPLETE = { asset: "Printer 17", part: "Toner cartridges, black", quantity: "2", deliverTo: "Depot North" };

function offers() {
  return {
    put: vi.fn(), take: vi.fn(), has: vi.fn().mockReturnValue(false), clearConversation: vi.fn(),
    drop: vi.fn(), recentlyDropped: vi.fn(), forgetDropped: vi.fn(), find: vi.fn(), prompt: vi.fn(), markAnswered: vi.fn(), claimNotice: vi.fn(), peek: vi.fn(),
  };
}

describe("part asset wording: offer texts", () => {
  it("uses the generic label and question by default", () => {
    expect(partDetailFields()[0]).toEqual({ key: "asset", label: "Asset", ask: "the item the part is for (for example a machine, vehicle or device)" });
    expect(partDetailFields(DEFAULT_PART_ASSET)).toEqual(partDetailFields());
    expect(formatMissingPartsQuestion(["asset"])).toBe("To order it I need the item the part is for (for example a machine, vehicle or device). What is it?");
  });

  it("shows the configured label in the confirmation and asks with the configured question", () => {
    expect(formatSupportQuestion("Toner cartridges for printer 17", "The black toner is nearly empty.", "part", COMPLETE, PRINTER)).toBe(
      "Shall I order this part?\n> **Toner cartridges for printer 17**\n> Device: Printer 17\n> Part: Toner cartridges, black\n> Quantity: 2\n> Deliver to: Depot North\n> The black toner is nearly empty.\n\n(yes or no)?",
    );
    expect(formatMissingPartsQuestion(["asset", "deliverTo"], PRINTER))
      .toBe("To order it I need the device (asset tag or room number) and the delivery location. What are they?");
    expect(formatStillMissingReply(["asset"], PRINTER)).toBe("I haven't ordered anything yet: I still need the device (asset tag or room number).");
  });

  it("keeps a number that belongs to the asset out of the quantity, whatever the asset is", () => {
    expect(statedPartDetails({ asset: "printer 3", quantity: "3" }, "toner for printer 3")).toEqual({ asset: "printer 3" });
    expect(statedPartDetails({ asset: "printer 3", quantity: "2" }, "two toners for printer 3")).toEqual({ asset: "printer 3", quantity: "2" });
  });
});

describe("part asset wording: use cases", () => {
  it("RaiseSupportRequest writes the configured label on the ticket and asks with the configured question", async () => {
    const tracker = makeTracker();
    tracker.createIssue.mockResolvedValue({ key: "SD-12", url: "https://jira.test/browse/SD-12", fieldsApplied: true });
    const { wire, sent } = makeWire();
    const useCase = new RaiseSupportRequest(makeRequests([]), tracker, wire, makeAudit(), makeLogger(), {}, PRINTER);
    const base = { summary: "Toner cartridges for printer 17", description: "The black toner is nearly empty.", conversationId: convId, requesterId: alice, requesterName: "Alice", requestKind: "part" as const };

    await useCase.execute({ ...base, part: COMPLETE });
    expect(tracker.createIssue.mock.calls[0]![0].description).toMatch(/^Device: Printer 17\nPart: Toner cartridges, black\n/);

    await useCase.execute({ ...base, part: { ...COMPLETE, asset: " " } });
    expect(sent.at(-1)).toBe("I haven't ordered anything yet: I still need the device (asset tag or room number).");
  });

  it("CompletePartOrder asks for the asset with the configured question", async () => {
    const triage = { draftRequest: vi.fn(), matchStatusQuestion: vi.fn(), extractPartDetails: vi.fn().mockResolvedValue({ quantity: "2" }) };
    const { wire, sent } = makeWire();
    const useCase = new CompletePartOrder(triage, offers(), wire, makeLogger(), () => NOW, PRINTER);
    const pending: OfferCommand = { kind: "support", requestKind: "part", summary: "Toner cartridges", description: "Need toner cartridges.", part: { part: "toner cartridges" } };

    expect(await useCase.execute({ text: "2 please", conversationId: convId, requesterId: alice, pending })).toBe(true);
    expect(sent).toEqual(["To order it I need the device (asset tag or room number). What is it?"]);
  });

  it("OfferSupportFromConversation asks for the asset with the configured question", async () => {
    const draft = {
      requestKind: "part" as const, part: { part: "toner cartridges", quantity: "2", deliverTo: "Depot North" },
      summary: "Toner cartridges", description: "I need 2 toner cartridges delivered to Depot North.",
      duplicateOf: null, addition: null, resolves: null, closingComment: null,
    };
    const triage = { draftRequest: vi.fn().mockResolvedValue(draft), matchStatusQuestion: vi.fn().mockResolvedValue(null), extractPartDetails: vi.fn() };
    const { wire, sent } = makeWire();
    const getIssueStatus = { projectKey: "SD", execute: vi.fn() } as unknown as GetIssueStatus;
    const useCase = new OfferSupportFromConversation(makeRequests([]), triage, getIssueStatus, offers(), wire, makeLogger(), () => NOW, PRINTER);

    await useCase.execute({
      text: draft.description, messageId: "m", conversationId: convId, senderId: alice, categories: ["service_request"], confidence: 0.9,
    });
    expect(sent).toEqual(["To order it I need the device (asset tag or room number). What is it?"]);
  });

  it("ConfirmOffer names the missing asset with the configured question on a yes and after an acknowledgement", async () => {
    const store = new InMemoryPendingOfferStore();
    const handlers = { raiseSupportRequest: { execute: vi.fn() }, replyToServiceDesk: { execute: vi.fn() }, resolveSupportRequest: { execute: vi.fn() } };
    const { wire, sent } = makeWire();
    const useCase = new ConfirmOffer(store, handlers as unknown as ConfirmOfferHandlers, wire, () => NOW, PRINTER);
    store.put({
      command: { kind: "support", requestKind: "part", summary: "Toner cartridges", description: "Need toner cartridges.", part: { part: "toner cartridges", quantity: "2", deliverTo: "Depot North" } },
      conversationId: convId, requesterId: alice, createdAt: NOW, expiresAt: new Date(NOW.getTime() + 60_000),
    });

    await useCase.execute({ text: "ok", conversationId: convId, requesterId: alice });
    await useCase.execute({ text: "yes", conversationId: convId, requesterId: alice });
    expect(sent).toEqual([
      "To order it I need the device (asset tag or room number). What is it?",
      "I haven't ordered anything yet: I still need the device (asset tag or room number).",
    ]);
    expect(handlers.raiseSupportRequest.execute).not.toHaveBeenCalled();
  });

  it("AnswerQuestion asks for the asset with the configured question", async () => {
    const offer = { kind: "support", requestKind: "part", summary: "Toner cartridges", description: "I want to order 2 toner cartridges to Depot North.", part: { part: "toner cartridges", quantity: "2", deliverTo: "Depot North" } };
    const general = { answer: vi.fn().mockResolvedValue(`I can order that.\nOFFER: ${JSON.stringify(offer)}`) };
    const { wire, sent } = makeWire();
    const jira = {
      tracker: makeTracker(), requests: makeRequests([]), auditLog: makeAudit(), offers: offers(), shareWithModel: false, partAsset: PRINTER, now: () => NOW,
    };
    const useCase = new AnswerQuestion(general, wire as never, jira as never);

    await useCase.execute({
      question: "Please order 2 toner cartridges to Depot North", conversationContext: [], conversationId: convId, replyToMessageId: "q",
      requester: { id: alice.id, domain: alice.domain, name: "Alice" },
    });
    expect(sent).toEqual(["To order it I need the device (asset tag or room number). What is it?"]);
  });
});
