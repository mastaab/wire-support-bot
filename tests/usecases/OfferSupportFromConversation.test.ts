import { describe, it, expect, vi } from "vitest";
import { OfferSupportFromConversation, PASSIVE_CONFIDENCE_MIN } from "../../src/application/usecases/jira/OfferSupportFromConversation";
import type { OfferSupportInput } from "../../src/application/usecases/jira/OfferSupportFromConversation";
import { GetIssueStatus } from "../../src/application/usecases/jira/GetIssueStatus";
import { formatIssueStatus } from "../../src/application/usecases/jira/formatIssue";
import {
  OFFER_DESCRIPTION_MAX, OFFER_TTL_MS, REPLY_BODY_MAX, formatMissingPartsQuestion, formatReplyQuestion, formatResolveQuestion, formatSupportQuestion,
} from "../../src/application/services/offers";
import { withoutAnswerHint } from "../../src/application/services/offerButtons";
import { PART_DETAIL_MAX, SUPPORT_SUMMARY_MAX } from "../../src/domain/entities/SupportRequest";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import type { SupportDraft } from "../../src/application/ports/SupportTriagePort";
import type { MessageCategory } from "../../src/application/ports/ClassifierPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import { alice, bob, convId, created, loggedText, makeAudit, makeLogger, makeRequest, makeRequests, makeSnapshot, makeTracker, makeWire, sentRefFor } from "./supportRequestFakes";

const MESSAGE = "PRIVATE_MESSAGE_MARKER the printer on floor 3 jams on every job";
const DRAFT: SupportDraft = {
  requestKind: "fault",
  summary: "Printer on floor 3 jams on every job",
  description: "The printer on floor 3 jams on every job.",
  duplicateOf: null,
  addition: null,
  resolves: null,
  closingComment: null,
};

function input(overrides: Partial<OfferSupportInput> = {}): OfferSupportInput {
  return {
    text: MESSAGE,
    messageId: "msg-9",
    conversationId: convId,
    senderId: alice,
    senderName: "Alice",
    categories: ["service_request"],
    confidence: 0.9,
    timezone: "Europe/Berlin",
    ...overrides,
  };
}

/** An hour and a bit after `created`, so the default record is not recent for the speaker. */
const LATER = new Date(created.getTime() + 61 * 60 * 1000);

function setup(
  records: SupportRequest[] = [makeRequest()], draft: SupportDraft | null = DRAFT, statusKey: string | null = null, now: Date = LATER,
  deliveryLocations: string[] = [],
) {
  const requests = makeRequests(records);
  const triage = {
    draftRequest: vi.fn().mockResolvedValue(draft),
    matchStatusQuestion: vi.fn().mockResolvedValue(statusKey),
    extractPartDetails: vi.fn(),
  };
  const getIssueStatus = { projectKey: "SD", execute: vi.fn().mockResolvedValue(null) };
  const offers = {
    put: vi.fn(), take: vi.fn(), has: vi.fn().mockReturnValue(false), peek: vi.fn(), clearConversation: vi.fn(),
    drop: vi.fn(), recentlyDropped: vi.fn(), forgetDropped: vi.fn(), find: vi.fn(), prompt: vi.fn(), markAnswered: vi.fn(), claimNotice: vi.fn(), claimClose: vi.fn(() => null), takeEndedPrompts: vi.fn(() => []), sweepExpired: vi.fn(),
  };
  const { wire, sent } = makeWire();
  const logger = makeLogger();
  const useCase = new OfferSupportFromConversation(requests, triage, getIssueStatus as unknown as GetIssueStatus, offers, wire, logger, () => now, undefined, deliveryLocations);
  return { requests, triage, getIssueStatus, offers, wire, sent, logger, useCase };
}

describe("formatSupportQuestion", () => {
  it("quotes the summary in bold and the description line by line", () => {
    expect(formatSupportQuestion("VPN drops", "It drops every ten minutes.\n\nSince Monday."))
      .toBe("Shall I report this to the service desk?\n> **VPN drops**\n> It drops every ten minutes.\n> Since Monday.\n\n(yes or no)?");
  });

  it("leaves out a description that only repeats the summary", () => {
    expect(formatSupportQuestion("VPN drops", "  vpn   drops "))
      .toBe("Shall I report this to the service desk?\n> **VPN drops**\n\n(yes or no)?");
  });
});

describe("OfferSupportFromConversation", () => {
  describe("gate", () => {
    it("does nothing below the confidence threshold", async () => {
      const { requests, triage, sent, useCase } = setup();

      await useCase.execute(input({ confidence: PASSIVE_CONFIDENCE_MIN - 0.01 }));

      expect(requests.listByConversation).not.toHaveBeenCalled();
      expect(triage.draftRequest).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });

    it("acts at exactly the threshold", async () => {
      const { sent, useCase } = setup();

      await useCase.execute(input({ confidence: PASSIVE_CONFIDENCE_MIN }));

      expect(sent).toHaveLength(1);
    });

    it("does nothing without a service-desk, update or blocker category", async () => {
      const { triage, sent, useCase } = setup();

      await useCase.execute(input({ categories: ["other"] }));

      expect(triage.draftRequest).not.toHaveBeenCalled();
      expect(triage.matchStatusQuestion).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });
  });

  describe("update or blocker", () => {
    it.each<[MessageCategory]>([["update"], ["blocker"]])("offers to add new information to an open request for a %s", async (category) => {
      const { offers, sent, useCase } = setup(undefined, { ...DRAFT, duplicateOf: "SD-6", addition: "It only happens on the new ThinkPads." });

      await useCase.execute(input({ categories: [category] }));

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("Shall I add this to **SD-6**");
      expect(offers.put).toHaveBeenCalledWith(expect.objectContaining({
        command: { kind: "reply", issueKey: "SD-6", body: "It only happens on the new ThinkPads." },
      }));
    });

    it.each([
      ["update", { duplicateOf: null, addition: null, resolves: null, closingComment: null }],
      ["blocker", { duplicateOf: null, addition: null, resolves: null, closingComment: null }],
      ["update", { duplicateOf: "SD-99", addition: "It happened again." }],
      ["blocker", { duplicateOf: null, addition: null, resolves: "SD-99", closingComment: null }],
    ] as const)("never offers to raise a new request from a %s (draft %j)", async (category, overrides) => {
      const { offers, sent, useCase } = setup(undefined, { ...DRAFT, ...overrides });

      await useCase.execute(input({ categories: [category] }));

      expect(sent).toEqual([]);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("falls through from an unmatched status question to an addition when the message is also an update", async () => {
      const { sent, useCase } = setup(undefined, { ...DRAFT, duplicateOf: "SD-6", addition: "It happened again." }, null);

      await useCase.execute(input({ categories: ["request_status", "update"] }));

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("Shall I add this to **SD-6**");
    });

    it("makes no model call for an update when the conversation has no open request", async () => {
      const { triage, sent, useCase } = setup([]);

      await useCase.execute(input({ categories: ["update"] }));

      expect(triage.draftRequest).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });
  });

  describe("service_request", () => {
    it("sends the code-written question as a native reply, then stores the offer for the speaker", async () => {
      const { triage, offers, wire, sent, useCase } = setup();

      await useCase.execute(input());

      expect(triage.draftRequest).toHaveBeenCalledWith(MESSAGE, [{ key: "SD-6", summary: "VPN drops every ten minutes", raisedBySpeakerRecently: false }]);
      expect(sent).toEqual([withoutAnswerHint(formatSupportQuestion(DRAFT.summary, DRAFT.description))]);
      expect(sent[0]).toBe("Shall I report this to the service desk?\n> **Printer on floor 3 jams on every job**\n> The printer on floor 3 jams on every job.");
      expect(wire.sendCompositePrompt).toHaveBeenCalledWith(convId, sent[0], expect.any(Array), { replyToMessageId: "msg-9" });
      expect(offers.put).toHaveBeenCalledTimes(1);
      const offer = offers.put.mock.calls[0]![0];
      expect(offer).toMatchObject({
        command: { kind: "support", summary: DRAFT.summary, description: DRAFT.description },
        conversationId: convId,
        requesterId: alice,
      });
      expect(offer.createdAt).toEqual(LATER);
      expect(offer.expiresAt.getTime() - offer.createdAt.getTime()).toBe(OFFER_TTL_MS);
      expect(wire.sendCompositePrompt.mock.invocationCallOrder[0]).toBeLessThan(offers.put.mock.invocationCallOrder[0]!);
    });

    it("collapses whitespace in the summary and trims the description", async () => {
      const { offers, sent, useCase } = setup(undefined, { requestKind: "fault", summary: "  Printer\n jams  ", description: "\n Printer jams on every job. \n", duplicateOf: null, addition: null, resolves: null, closingComment: null });

      await useCase.execute(input());

      expect(offers.put.mock.calls[0]![0].command).toEqual({ kind: "support", requestKind: "fault", summary: "Printer jams", description: "Printer jams on every job." });
      expect(sent[0]).toContain("> **Printer jams**\n> Printer jams on every job.");
    });

    it("shows only the summary when the description repeats it", async () => {
      const { sent, useCase } = setup(undefined, { requestKind: "fault", summary: "Printer jams", description: "printer jams", duplicateOf: null, addition: null, resolves: null, closingComment: null });

      await useCase.execute(input());

      expect(sent).toEqual(["Shall I report this to the service desk?\n> **Printer jams**"]);
    });

    it("passes only open requests of this conversation in the tracker's project, at most 20", async () => {
      const many = Array.from({ length: 25 }, (_, i) => makeRequest({ key: `SD-${100 + i}`, summary: `Problem ${i}` }));
      const records = [
        makeRequest({ key: "SD-1", statusCategory: "done" }),
        makeRequest({ key: "SD-2", conversationId: { id: "conv-2", domain: "example.com" } }),
        makeRequest({ key: "SD-3", conversationId: { id: "conv-1", domain: "other.example" } }),
        makeRequest({ key: "SD-4", deleted: true }),
        makeRequest({ key: "OPS-5" }),
        makeRequest({ key: "SD-6", statusCategory: "in_progress" }),
        ...many,
      ];
      const { requests, triage, useCase } = setup(records);

      await useCase.execute(input());

      expect(requests.listByConversation).toHaveBeenCalledWith(convId, { openOnly: true, limit: 20 });
      const open = triage.draftRequest.mock.calls[0]![1] as Array<{ key: string; summary: string }>;
      expect(open).toHaveLength(20);
      expect(open[0]).toEqual({ key: "SD-6", summary: "VPN drops every ten minutes", raisedBySpeakerRecently: false });
      for (const excluded of ["SD-1", "SD-2", "SD-3", "SD-4", "OPS-5"]) expect(open.map((r) => r.key)).not.toContain(excluded);
      expect(Object.keys(open[0]!)).toEqual(["key", "summary", "raisedBySpeakerRecently"]);
    });

    it("marks only the speaker's newest request of the last hour, keeping newest first", async () => {
      const now = new Date("2026-09-25T12:00:00Z");
      const records = [
        makeRequest({ key: "SD-10", createdAt: new Date(now.getTime() - 5 * 60 * 1000) }),
        makeRequest({ key: "SD-9", requesterId: bob, createdAt: new Date(now.getTime() - 10 * 60 * 1000) }),
        makeRequest({ key: "SD-8", requesterId: { id: "user-1", domain: "other.example" }, createdAt: new Date(now.getTime() - 20 * 60 * 1000) }),
        makeRequest({ key: "SD-7", createdAt: new Date(now.getTime() - 60 * 60 * 1000) }),
        makeRequest({ key: "SD-6", createdAt: new Date(now.getTime() - 60 * 60 * 1000 - 1) }),
      ];
      const { triage, useCase } = setup(records, DRAFT, null, now);

      await useCase.execute(input());

      const open = triage.draftRequest.mock.calls[0]![1] as Array<{ key: string; raisedBySpeakerRecently: boolean }>;
      expect(open.map((r) => [r.key, r.raisedBySpeakerRecently])).toEqual([
        ["SD-10", true], ["SD-9", false], ["SD-8", false], ["SD-7", false], ["SD-6", false],
      ]);
    });

    it("marks the speaker's request from exactly an hour ago when it is their only recent one", async () => {
      const now = new Date("2026-09-25T12:00:00Z");
      const records = [
        makeRequest({ key: "SD-9", requesterId: bob, createdAt: new Date(now.getTime() - 10 * 60 * 1000) }),
        makeRequest({ key: "SD-7", createdAt: new Date(now.getTime() - 60 * 60 * 1000) }),
      ];
      const { triage, useCase } = setup(records, DRAFT, null, now);

      await useCase.execute(input());

      const open = triage.draftRequest.mock.calls[0]![1] as Array<{ key: string; raisedBySpeakerRecently: boolean }>;
      expect(open.map((r) => [r.key, r.raisedBySpeakerRecently])).toEqual([["SD-9", false], ["SD-7", true]]);
    });

    it("stays silent when the model finds no service-desk problem", async () => {
      const { offers, sent, useCase } = setup(undefined, null);

      await useCase.execute(input());

      expect(sent).toEqual([]);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("stays silent for an update when an open request of this conversation already covers the problem and nothing is added", async () => {
      for (const addition of [null, "   "]) {
        const { offers, sent, useCase } = setup(undefined, { ...DRAFT, duplicateOf: "sd-6", addition });

        await useCase.execute(input({ categories: ["update"] }));

        expect(sent).toEqual([]);
        expect(offers.put).not.toHaveBeenCalled();
      }
    });

    it("offers to add new information to the open request as a native reply for an update, then stores a reply offer", async () => {
      const { offers, wire, sent, useCase } = setup(undefined, { ...DRAFT, duplicateOf: "sd-6", addition: "  It only happens on the 3rd floor. " });

      await useCase.execute(input({ categories: ["update"] }));

      expect(sent).toEqual([withoutAnswerHint(formatReplyQuestion("SD-6", "VPN drops every ten minutes", "It only happens on the 3rd floor."))]);
      expect(sent[0]).toBe("Shall I add this to **SD-6** \"VPN drops every ten minutes\"?\n> It only happens on the 3rd floor.");
      expect(wire.sendCompositePrompt).toHaveBeenCalledWith(convId, sent[0], expect.any(Array), { replyToMessageId: "msg-9" });
      expect(offers.put).toHaveBeenCalledTimes(1);
      const offer = offers.put.mock.calls[0]![0];
      expect(offer).toMatchObject({
        command: { kind: "reply", issueKey: "SD-6", body: "It only happens on the 3rd floor." },
        conversationId: convId,
        requesterId: alice,
      });
      expect(offer.expiresAt.getTime() - offer.createdAt.getTime()).toBe(OFFER_TTL_MS);
      expect(wire.sendCompositePrompt.mock.invocationCallOrder[0]).toBeLessThan(offers.put.mock.invocationCallOrder[0]!);
    });

    it("lets any member add to a request someone else raised", async () => {
      const { offers, sent, useCase } = setup(undefined, { ...DRAFT, duplicateOf: "SD-6", addition: "Now also on the 2nd floor." });

      await useCase.execute(input({ senderId: bob, senderName: "Bob", categories: ["update"] }));

      expect(sent).toHaveLength(1);
      expect(offers.put.mock.calls[0]![0]).toMatchObject({ command: { kind: "reply", issueKey: "SD-6" }, requesterId: bob });
    });

    it("accepts an addition exactly at the reply limit and drops a longer one", async () => {
      const atLimit = setup(undefined, { ...DRAFT, duplicateOf: "SD-6", addition: "a".repeat(REPLY_BODY_MAX) });
      await atLimit.useCase.execute(input({ categories: ["update"] }));
      expect(atLimit.offers.put).toHaveBeenCalledTimes(1);

      const over = setup(undefined, { ...DRAFT, duplicateOf: "SD-6", addition: "a".repeat(REPLY_BODY_MAX + 1) });
      await over.useCase.execute(input({ categories: ["update"] }));
      expect(over.sent).toEqual([]);
      expect(over.offers.put).not.toHaveBeenCalled();
    });

    it("does not offer an addition while the speaker has a live offer or after a cancel", async () => {
      const draft = { ...DRAFT, duplicateOf: "SD-6", addition: "It happened again." };
      const busy = setup(undefined, draft);
      busy.offers.has.mockReturnValueOnce(false).mockReturnValue(true);
      await busy.useCase.execute(input());
      expect(busy.sent).toEqual([]);
      expect(busy.offers.put).not.toHaveBeenCalled();

      // A live offer before the model call skips the triage entirely.
      const live = setup(undefined, draft);
      live.offers.has.mockReturnValue(true);
      await live.useCase.execute(input());
      expect(live.triage.draftRequest).not.toHaveBeenCalled();
      expect(live.sent).toEqual([]);

      const controller = new AbortController();
      const canceled = setup(undefined, draft);
      canceled.triage.draftRequest.mockImplementation(async () => { controller.abort(); return draft; });
      await canceled.useCase.execute(input({ signal: controller.signal }));
      expect(canceled.sent).toEqual([]);
      expect(canceled.offers.put).not.toHaveBeenCalled();
    });

    it("does not store the addition offer when the work is canceled while the question is being sent", async () => {
      const controller = new AbortController();
      const { wire, offers, sent, useCase } = setup(undefined, { ...DRAFT, duplicateOf: "SD-6", addition: "It happened again." });
      wire.sendCompositePrompt.mockImplementation(async (_conv: QualifiedId, text: string) => { sent.push(text); controller.abort(); return undefined; });

      await useCase.execute(input({ signal: controller.signal }));

      expect(sent).toHaveLength(1);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("does not store the addition offer when sending the question failed", async () => {
      const { wire, offers, useCase } = setup(undefined, { ...DRAFT, duplicateOf: "SD-6", addition: "It happened again." });
      wire.sendCompositePrompt.mockRejectedValue(new TypeError("socket closed"));

      await expect(useCase.execute(input())).resolves.toBe(false);

      expect(offers.put).not.toHaveBeenCalled();
    });

    it("still offers to raise it when the named duplicate is not an open request of this conversation", async () => {
      const { offers, sent, useCase } = setup(undefined, { ...DRAFT, duplicateOf: "SD-99", addition: "It happened again." });

      await useCase.execute(input());

      expect(sent).toEqual([withoutAnswerHint(formatSupportQuestion(DRAFT.summary, DRAFT.description))]);
      expect(offers.put.mock.calls[0]![0].command.kind).toBe("support");
    });

    it.each<[string, SupportDraft]>([
      ["an empty summary", { ...DRAFT, summary: "  " }],
      ["a summary over the limit", { ...DRAFT, summary: "x".repeat(SUPPORT_SUMMARY_MAX + 1) }],
      ["an empty description", { ...DRAFT, description: " \n " }],
      ["a description over the offer limit", { ...DRAFT, description: "y".repeat(OFFER_DESCRIPTION_MAX + 1) }],
    ])("drops a draft with %s", async (_label, draft) => {
      const { offers, sent, useCase } = setup(undefined, draft);

      await useCase.execute(input());

      expect(sent).toEqual([]);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("accepts a draft exactly at the bounds", async () => {
      const draft: SupportDraft = { requestKind: "fault", summary: "x".repeat(SUPPORT_SUMMARY_MAX), description: "y".repeat(OFFER_DESCRIPTION_MAX), duplicateOf: null, addition: null, resolves: null, closingComment: null };
      const { offers, useCase } = setup(undefined, draft);

      await useCase.execute(input());

      expect(offers.put).toHaveBeenCalledTimes(1);
    });

    describe("request kinds and part orders", () => {
      const PART_DRAFT: SupportDraft = {
        requestKind: "part",
        part: { asset: "printer 17", part: "paper tray roller", quantity: "2", deliverTo: "Depot North" },
        summary: "Paper tray roller for printer 17",
        description: "I need two paper tray rollers for printer 17, delivered to Depot North.",
        duplicateOf: null,
        addition: null,
        resolves: null,
        closingComment: null,
      };

      it.each<[SupportDraft["requestKind"], string]>([
        ["question", "Shall I ask the service desk?"],
        ["fault", "Shall I report this to the service desk?"],
      ])("offers a %s with its own question and stores the kind", async (requestKind, lead) => {
        const draft = { ...DRAFT, requestKind, part: { asset: "printer 17" } };
        const { offers, sent, useCase } = setup(undefined, draft);

        await useCase.execute(input());

        expect(sent).toEqual([`${lead}\n> **${DRAFT.summary}**\n> ${DRAFT.description}`]);
        expect(offers.put.mock.calls[0]![0].command).toEqual({ kind: "support", requestKind, summary: DRAFT.summary, description: DRAFT.description });
      });

      it("offers a scheduled service as a fault", async () => {
        const draft: SupportDraft = { ...DRAFT, requestKind: "fault", summary: "Printer 17 is due for its 60,000-page service", description: "Printer 17 is due for its 60,000-page service next week." };
        const { offers, sent, useCase } = setup(undefined, draft);

        await useCase.execute(input());

        expect(sent[0]).toMatch(/^Shall I report this to the service desk\?\n/);
        expect(offers.put.mock.calls[0]![0].command.requestKind).toBe("fault");
      });

      it("treats an unknown kind as a fault", async () => {
        const { offers, sent, useCase } = setup(undefined, { ...DRAFT, requestKind: "incident" as SupportDraft["requestKind"] });

        await useCase.execute(input());

        expect(sent[0]).toMatch(/^Shall I report this to the service desk\?\n/);
        expect(offers.put.mock.calls[0]![0].command.requestKind).toBe("fault");
      });

      it("offers a complete part order with the detail lines above the description", async () => {
        const { offers, wire, sent, useCase } = setup(undefined, PART_DRAFT);

        await useCase.execute(input({ text: PART_DRAFT.description }));

        expect(sent).toEqual([
          "Shall I order this part?\n> **Paper tray roller for printer 17**\n> Asset: printer 17\n> Part: paper tray roller\n> Quantity: 2\n> Deliver to: Depot North\n> I need two paper tray rollers for printer 17, delivered to Depot North.",
        ]);
        expect(wire.sendCompositePrompt).toHaveBeenCalledWith(convId, sent[0], expect.any(Array), { replyToMessageId: "msg-9" });
        expect(offers.put.mock.calls[0]![0].command).toEqual({
          kind: "support", requestKind: "part", summary: PART_DRAFT.summary, description: PART_DRAFT.description, part: PART_DRAFT.part,
        });
      });

      it("asks for the quantity with buttons when the model filled one in that the requester did not state", async () => {
        const { offers, wire, sent, useCase } = setup(undefined, { ...PART_DRAFT, part: { asset: "printer 7", part: "paper tray", quantity: "1" } });

        await useCase.execute(input({ text: "we need a new paper tray for printer 7" }));

        const offer = offers.put.mock.calls[0]![0];
        expect(sent).toEqual(["How many shall I order?"]);
        expect(wire.sendCompositePrompt).toHaveBeenCalledWith(convId, "How many shall I order?", [
          { id: `${offer.id}:0`, label: "1" }, { id: `${offer.id}:1`, label: "2" }, { id: `${offer.id}:2`, label: "5" }, { id: `${offer.id}:3`, label: "Other" },
        ], { replyToMessageId: "msg-9" });
        expect(offer.command.part).toEqual({ asset: "printer 7", part: "paper tray" });
        expect(offer.fillsPart).toBe("quantity");
        expect(offer.choices?.[1]?.command).toEqual({ ...offer.command, part: { asset: "printer 7", part: "paper tray", quantity: "2" } });
      });

      it("asks for the delivery location with the configured locations once only it is missing", async () => {
        const part = { asset: "printer 17", part: "paper tray roller", quantity: "2" };
        const { offers, wire, sent, useCase } = setup(undefined, { ...PART_DRAFT, part }, null, LATER, ["Depot north", "Depot south"]);

        await useCase.execute(input({ text: "I need two paper tray rollers for printer 17" }));

        const offer = offers.put.mock.calls[0]![0];
        expect(sent).toEqual(["Where shall I deliver it?"]);
        expect(wire.sendCompositePrompt.mock.calls[0]![2]).toEqual([
          { id: `${offer.id}:0`, label: "Depot north" }, { id: `${offer.id}:1`, label: "Depot south" }, { id: `${offer.id}:2`, label: "Other" },
        ]);
        expect(offer).toMatchObject({ fillsPart: "deliverTo", messageId: sentRefFor(1).messageId });
        expect(offer.choices?.[0]?.command.part).toEqual({ ...part, deliverTo: "Depot north" });
      });

      it("collapses whitespace in the part details", async () => {
        const { offers, useCase } = setup(undefined, { ...PART_DRAFT, part: { asset: " printer\n 17 ", part: "paper  tray roller", quantity: " 2 ", deliverTo: "Depot\tNorth" } });

        await useCase.execute(input({ text: PART_DRAFT.description }));

        expect(offers.put.mock.calls[0]![0].command.part).toEqual(PART_DRAFT.part);
      });

      it("asks for exactly the missing details and stores the incomplete order for the speaker", async () => {
        const { offers, wire, sent, useCase } = setup(undefined, { ...PART_DRAFT, part: { part: "paper tray roller", quantity: "2" } });

        await useCase.execute(input({ text: PART_DRAFT.description }));

        expect(sent).toEqual([formatMissingPartsQuestion(["asset"])]);
        expect(sent[0]).toBe("To order it I need the item the part is for (for example a machine, vehicle or device). What is it?");
        expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-9" });
        expect(offers.put).toHaveBeenCalledTimes(1);
        const offer = offers.put.mock.calls[0]![0];
        expect(offer).toMatchObject({
          command: { kind: "support", requestKind: "part", summary: PART_DRAFT.summary, description: PART_DRAFT.description, part: { part: "paper tray roller", quantity: "2" } },
          conversationId: convId,
          requesterId: alice,
        });
        expect(offer.command.part).toEqual({ part: "paper tray roller", quantity: "2" });
        expect(offer.expiresAt.getTime() - offer.createdAt.getTime()).toBe(OFFER_TTL_MS);
        expect(wire.sendPlainText.mock.invocationCallOrder[0]).toBeLessThan(offers.put.mock.invocationCallOrder[0]!);
      });

      it("asks for the asset and the part together first when the part order states none", async () => {
        const { offers, sent, useCase } = setup(undefined, { ...PART_DRAFT, part: undefined });

        await useCase.execute(input());

        expect(sent).toEqual([formatMissingPartsQuestion(["asset", "part"])]);
        expect(offers.put.mock.calls[0]![0].command).toEqual({
          kind: "support", requestKind: "part", summary: PART_DRAFT.summary, description: PART_DRAFT.description, part: {},
        });
      });

      it("treats an empty or over-long detail as missing", async () => {
        const { offers, sent, useCase } = setup(undefined, { ...PART_DRAFT, part: { ...PART_DRAFT.part, asset: "v".repeat(PART_DETAIL_MAX + 1), quantity: "  " } });

        await useCase.execute(input({ text: PART_DRAFT.description }));

        expect(sent).toEqual([formatMissingPartsQuestion(["asset"])]);
        expect(offers.put.mock.calls[0]![0].command.part).toEqual({ part: "paper tray roller", deliverTo: "Depot North" });
      });

      it("accepts a detail exactly at the limit", async () => {
        const asset = "v".repeat(PART_DETAIL_MAX);
        const { offers, sent, useCase } = setup(undefined, { ...PART_DRAFT, part: { ...PART_DRAFT.part, asset } });

        await useCase.execute(input({ text: `${PART_DRAFT.description} ${asset}` }));

        expect(sent[0]).toMatch(/^Shall I order this part\?\n/);
        expect(offers.put.mock.calls[0]![0].command.part.asset).toBe(asset);
      });

      it("does not store the incomplete order when the work is canceled while the question is being sent", async () => {
        const controller = new AbortController();
        const { wire, offers, sent, useCase } = setup(undefined, { ...PART_DRAFT, part: { part: "paper tray roller" } });
        wire.sendPlainText.mockImplementation(async (_conv: QualifiedId, text: string) => { sent.push(text); controller.abort(); return undefined; });

        await useCase.execute(input({ signal: controller.signal }));

        expect(sent).toHaveLength(1);
        expect(offers.put).not.toHaveBeenCalled();
      });

      it("still offers an addition for a part draft that names an open request, next to raising the order", async () => {
        const { offers, sent, useCase } = setup(undefined, { ...PART_DRAFT, part: {}, duplicateOf: "SD-6", addition: "It happened again." });

        await useCase.execute(input());

        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain('- **SD-6** "VPN drops every ten minutes"');
        const offer = offers.put.mock.calls[0]![0];
        expect(offer.choices![0]!.command).toEqual({ kind: "reply", issueKey: "SD-6", body: "It happened again." });
        expect(offer.choices![1]!.command).toMatchObject({ kind: "support", requestKind: "part" });
      });
    });

    it("never offers while the speaker has a live offer", async () => {
      const { triage, offers, sent, useCase } = setup();
      offers.has.mockReturnValue(true);

      await useCase.execute(input());

      expect(offers.has).toHaveBeenCalledWith(convId, alice);
      expect(triage.draftRequest).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("does not replace an offer made while the draft was being written", async () => {
      const { offers, sent, useCase } = setup();
      offers.has.mockReturnValueOnce(false).mockReturnValue(true);

      await useCase.execute(input());

      expect(sent).toEqual([]);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("sends and stores nothing when the job was canceled during the draft", async () => {
      const controller = new AbortController();
      const { triage, offers, sent, useCase } = setup();
      triage.draftRequest.mockImplementation(async () => { controller.abort(); return DRAFT; });

      await useCase.execute(input({ signal: controller.signal }));

      expect(sent).toEqual([]);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("does not store the offer when the work is canceled while the question is being sent", async () => {
      const controller = new AbortController();
      const { wire, offers, sent, useCase } = setup();
      wire.sendCompositePrompt.mockImplementation(async (_conv: QualifiedId, text: string) => { sent.push(text); controller.abort(); return undefined; });

      await useCase.execute(input({ signal: controller.signal }));

      expect(sent).toHaveLength(1);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("does not store the offer when sending the question failed", async () => {
      const { wire, offers, logger, useCase } = setup();
      wire.sendCompositePrompt.mockRejectedValue(new TypeError("socket closed"));

      await expect(useCase.execute(input())).resolves.toBe(false);

      expect(offers.put).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { err: "TypeError" });
    });

    it("logs a model failure by error name only and stays silent", async () => {
      const { triage, sent, logger, useCase } = setup();
      triage.draftRequest.mockRejectedValue(new RangeError(`bad ${MESSAGE}`));

      await expect(useCase.execute(input())).resolves.toBe(false);

      expect(sent).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { err: "RangeError" });
      expect(loggedText(logger)).not.toContain("PRIVATE_MESSAGE_MARKER");
    });

    it("stays silent when the open requests cannot be read", async () => {
      const { requests, triage, sent, logger, useCase } = setup();
      requests.listByConversation.mockRejectedValue(new Error("db down"));

      await useCase.execute(input());

      expect(triage.draftRequest).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { err: "Error" });
    });

    it("never logs the message, the draft, the addition or the summaries", async () => {
      const records = [makeRequest({ summary: "PRIVATE_SUMMARY_MARKER" })];
      const draft: SupportDraft = { requestKind: "fault", summary: "PRIVATE_DRAFT_MARKER", description: "PRIVATE_DESCRIPTION_MARKER", duplicateOf: null, addition: null, resolves: null, closingComment: null };
      const addition = "PRIVATE_ADDITION_MARKER";
      for (const d of [
        draft,
        { ...draft, duplicateOf: "SD-6" },
        { ...draft, duplicateOf: "SD-6", addition },
        { ...draft, duplicateOf: "SD-6", addition: addition.repeat(200) },
        { ...draft, summary: "z".repeat(500) },
      ]) {
        const { logger, useCase } = setup(records, d);
        await useCase.execute(input());
        const logged = loggedText(logger);
        for (const marker of ["PRIVATE_MESSAGE_MARKER", "PRIVATE_SUMMARY_MARKER", "PRIVATE_DRAFT_MARKER", "PRIVATE_DESCRIPTION_MARKER", "PRIVATE_ADDITION_MARKER"]) {
          expect(logged).not.toContain(marker);
        }
      }
    });
  });

  describe("resolve", () => {
    const COMMENT = "The tray arrived at depot north.";
    const RESOLVE: SupportDraft = { ...DRAFT, summary: "", description: "", resolves: "SD-6", closingComment: COMMENT };

    it("offers to resolve with the closing comment as a native reply, then stores a resolve offer", async () => {
      const { offers, wire, sent, useCase } = setup(undefined, RESOLVE);

      await useCase.execute(input());

      expect(sent).toEqual([withoutAnswerHint(formatResolveQuestion("SD-6", "VPN drops every ten minutes", COMMENT))]);
      expect(sent[0]).toBe(`Shall I resolve **SD-6** "VPN drops every ten minutes" with the service desk and add this comment?\n> ${COMMENT}`);
      expect(wire.sendCompositePrompt).toHaveBeenCalledWith(convId, sent[0], expect.any(Array), { replyToMessageId: "msg-9" });
      expect(offers.put).toHaveBeenCalledTimes(1);
      const offer = offers.put.mock.calls[0]![0];
      expect(offer).toMatchObject({ command: { kind: "resolve", issueKey: "SD-6", comment: COMMENT }, conversationId: convId, requesterId: alice });
      expect(offer.expiresAt.getTime() - offer.createdAt.getTime()).toBe(OFFER_TTL_MS);
      expect(wire.sendCompositePrompt.mock.invocationCallOrder[0]).toBeLessThan(offers.put.mock.invocationCallOrder[0]!);
    });

    it("offers a plain resolve without a comment", async () => {
      const { offers, sent, useCase } = setup(undefined, { ...RESOLVE, closingComment: null });

      await useCase.execute(input());

      expect(sent).toEqual([`Shall I resolve **SD-6** "VPN drops every ten minutes" with the service desk?`]);
      expect(offers.put.mock.calls[0]![0].command).toEqual({ kind: "resolve", issueKey: "SD-6" });
    });

    it("treats a blank comment as none and trims the comment", async () => {
      const blank = setup(undefined, { ...RESOLVE, closingComment: "   " });
      await blank.useCase.execute(input());
      expect(blank.offers.put.mock.calls[0]![0].command).toEqual({ kind: "resolve", issueKey: "SD-6" });

      const padded = setup(undefined, { ...RESOLVE, closingComment: `  ${COMMENT}\n` });
      await padded.useCase.execute(input());
      expect(padded.offers.put.mock.calls[0]![0].command).toEqual({ kind: "resolve", issueKey: "SD-6", comment: COMMENT });
    });

    it("normalizes the key to the listed form", async () => {
      const { offers, useCase } = setup(undefined, { ...RESOLVE, resolves: " sd-6 " });

      await useCase.execute(input());

      expect(offers.put.mock.calls[0]![0].command).toMatchObject({ kind: "resolve", issueKey: "SD-6" });
    });

    it("accepts a comment exactly at the reply limit and offers nothing for a longer one", async () => {
      const at = setup(undefined, { ...RESOLVE, closingComment: "c".repeat(REPLY_BODY_MAX) });
      await at.useCase.execute(input());
      expect(at.offers.put.mock.calls[0]![0].command).toEqual({ kind: "resolve", issueKey: "SD-6", comment: "c".repeat(REPLY_BODY_MAX) });

      const over = setup(undefined, { ...RESOLVE, closingComment: "c".repeat(REPLY_BODY_MAX + 1) });
      await over.useCase.execute(input());
      expect(over.sent).toEqual([]);
      expect(over.offers.put).not.toHaveBeenCalled();
    });

    it("takes precedence over an addition", async () => {
      const { offers, sent, useCase } = setup(undefined, { ...RESOLVE, duplicateOf: "SD-6", addition: "It arrived today." });

      await useCase.execute(input());

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("Shall I resolve **SD-6**");
      expect(offers.put.mock.calls[0]![0].command).toEqual({ kind: "resolve", issueKey: "SD-6", comment: COMMENT });
    });

    it("takes precedence over raising a new request", async () => {
      const { offers, sent, useCase } = setup(undefined, { ...DRAFT, resolves: "SD-6", closingComment: null });

      await useCase.execute(input());

      expect(sent).toEqual([withoutAnswerHint(formatResolveQuestion("SD-6", "VPN drops every ten minutes"))]);
      expect(offers.put.mock.calls[0]![0].command).toEqual({ kind: "resolve", issueKey: "SD-6" });
    });

    it("makes no offer at all for a close request naming a request that is not open here, never a new request", async () => {
      const records = [makeRequest(), makeRequest({ key: "SD-7", statusCategory: "done" })];
      for (const resolves of ["SD-99", "SD-7"]) {
        const { offers, sent, useCase } = setup(records, { ...DRAFT, resolves, closingComment: COMMENT });
        await useCase.execute(input());
        expect(sent).toEqual([]);
        expect(offers.put).not.toHaveBeenCalled();
      }

      const additionOnly = setup(records, { ...RESOLVE, resolves: "SD-99" });
      await additionOnly.useCase.execute(input({ categories: ["update"] }));
      expect(additionOnly.sent).toEqual([]);
    });

    it.each<[MessageCategory]>([["update"], ["blocker"]])("offers to resolve for a %s", async (category) => {
      const { offers, sent, useCase } = setup(undefined, RESOLVE);

      await useCase.execute(input({ categories: [category] }));

      expect(sent).toHaveLength(1);
      expect(offers.put.mock.calls[0]![0].command).toEqual({ kind: "resolve", issueKey: "SD-6", comment: COMMENT });
    });

    it.each<[MessageCategory]>([["update"], ["blocker"]])("makes no model call for an %s when the conversation has no open request", async (category) => {
      const { triage, sent, useCase } = setup([], RESOLVE);

      await useCase.execute(input({ categories: [category] }));

      expect(triage.draftRequest).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });

    it("does not offer while the speaker has a live offer, nor replace one made during the draft", async () => {
      const live = setup(undefined, RESOLVE);
      live.offers.has.mockReturnValue(true);
      await live.useCase.execute(input());
      expect(live.triage.draftRequest).not.toHaveBeenCalled();
      expect(live.sent).toEqual([]);

      const busy = setup(undefined, RESOLVE);
      busy.offers.has.mockReturnValueOnce(false).mockReturnValue(true);
      await busy.useCase.execute(input());
      expect(busy.sent).toEqual([]);
      expect(busy.offers.put).not.toHaveBeenCalled();
    });

    it("sends and stores nothing when the job was canceled during the draft", async () => {
      const controller = new AbortController();
      const { triage, offers, sent, useCase } = setup(undefined, RESOLVE);
      triage.draftRequest.mockImplementation(async () => { controller.abort(); return RESOLVE; });

      await useCase.execute(input({ signal: controller.signal }));

      expect(sent).toEqual([]);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("does not store the offer when the work is canceled while the question is being sent", async () => {
      const controller = new AbortController();
      const { wire, offers, sent, useCase } = setup(undefined, RESOLVE);
      wire.sendCompositePrompt.mockImplementation(async (_conv: QualifiedId, text: string) => { sent.push(text); controller.abort(); return undefined; });

      await useCase.execute(input({ signal: controller.signal }));

      expect(sent).toHaveLength(1);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("does not store the offer when sending the question failed", async () => {
      const { wire, offers, useCase } = setup(undefined, RESOLVE);
      wire.sendCompositePrompt.mockRejectedValue(new TypeError("socket closed"));

      await expect(useCase.execute(input())).resolves.toBe(false);

      expect(offers.put).not.toHaveBeenCalled();
    });

    it("never logs the closing comment", async () => {
      const marker = "PRIVATE_COMMENT_MARKER";
      for (const closingComment of [marker, marker.repeat(200)]) {
        const { logger, wire, useCase } = setup(undefined, { ...RESOLVE, closingComment });
        await useCase.execute(input());
        expect(loggedText(logger)).not.toContain(marker);

        wire.sendCompositePrompt.mockRejectedValue(new TypeError("socket closed"));
        await useCase.execute(input());
        expect(loggedText(logger)).not.toContain(marker);
      }
    });
  });

  describe("request_status", () => {
    it("answers through GetIssueStatus as a native reply when the question matches an open request", async () => {
      const { triage, getIssueStatus, offers, sent, useCase } = setup(undefined, DRAFT, "sd-6");

      await useCase.execute(input({ categories: ["request_status"] }));

      expect(triage.matchStatusQuestion).toHaveBeenCalledWith(MESSAGE, [{ key: "SD-6", summary: "VPN drops every ten minutes", raisedBySpeakerRecently: false }]);
      expect(getIssueStatus.execute).toHaveBeenCalledWith({
        reference: "SD-6", conversationId: convId, timezone: "Europe/Berlin", replyToMessageId: "msg-9",
      });
      expect(triage.draftRequest).not.toHaveBeenCalled();
      expect(offers.put).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });

    it("stays silent when the question matches no open request", async () => {
      const { getIssueStatus, sent, useCase } = setup(undefined, DRAFT, null);

      await useCase.execute(input({ categories: ["request_status"] }));

      expect(getIssueStatus.execute).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });

    it("ignores a key that is not an open request of this conversation", async () => {
      const records = [makeRequest(), makeRequest({ key: "SD-7", statusCategory: "done" })];
      for (const key of ["SD-7", "SD-99", "OPS-6"]) {
        const { getIssueStatus, sent, useCase } = setup(records, DRAFT, key);
        await useCase.execute(input({ categories: ["request_status"] }));
        expect(getIssueStatus.execute).not.toHaveBeenCalled();
        expect(sent).toEqual([]);
      }
    });

    it("does not ask the model when the conversation has no open requests", async () => {
      const { triage, getIssueStatus, useCase } = setup([], DRAFT, "SD-6");

      await useCase.execute(input({ categories: ["request_status"] }));

      expect(triage.matchStatusQuestion).not.toHaveBeenCalled();
      expect(getIssueStatus.execute).not.toHaveBeenCalled();
    });

    it("does not answer when the job was canceled during the match", async () => {
      const controller = new AbortController();
      const { triage, getIssueStatus, useCase } = setup(undefined, DRAFT, "SD-6");
      triage.matchStatusQuestion.mockImplementation(async () => { controller.abort(); return "SD-6"; });

      await useCase.execute(input({ categories: ["request_status"], signal: controller.signal }));

      expect(getIssueStatus.execute).not.toHaveBeenCalled();
    });

    it("logs a model failure by error name only and stays silent", async () => {
      const { triage, getIssueStatus, logger, useCase } = setup();
      triage.matchStatusQuestion.mockRejectedValue(new SyntaxError("bad"));

      await expect(useCase.execute(input({ categories: ["request_status"] }))).resolves.toBe(false);

      expect(getIssueStatus.execute).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { err: "SyntaxError" });
    });

    it("replies with the live status through the real GetIssueStatus", async () => {
      const records = [makeRequest()];
      const requests = makeRequests(records);
      const tracker = makeTracker();
      const { wire, sent } = makeWire();
      const getIssueStatus = new GetIssueStatus(requests, tracker, wire, makeAudit(), makeLogger());
      const triage = { draftRequest: vi.fn(), matchStatusQuestion: vi.fn().mockResolvedValue("SD-6"), extractPartDetails: vi.fn() };
      const offers = {
      put: vi.fn(), take: vi.fn(), has: vi.fn(), peek: vi.fn(), clearConversation: vi.fn(),
      drop: vi.fn(), recentlyDropped: vi.fn(), forgetDropped: vi.fn(), find: vi.fn(), prompt: vi.fn(), markAnswered: vi.fn(), claimNotice: vi.fn(), claimClose: vi.fn(() => null), takeEndedPrompts: vi.fn(() => []), sweepExpired: vi.fn(),
    };
      const useCase = new OfferSupportFromConversation(requests, triage, getIssueStatus, offers, wire, makeLogger());

      await useCase.execute(input({ categories: ["request_status"] }));

      expect(sent).toEqual([formatIssueStatus(makeSnapshot(), "No replies from the service desk yet.")]);
      expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-9" });
      expect(tracker.createIssue).not.toHaveBeenCalled();
    });
  });

  describe("both categories", () => {
    it("prefers the status answer when an open request matches", async () => {
      const { triage, getIssueStatus, offers, useCase } = setup(undefined, DRAFT, "SD-6");

      await useCase.execute(input({ categories: ["service_request", "request_status"] }));

      expect(getIssueStatus.execute).toHaveBeenCalledTimes(1);
      expect(triage.draftRequest).not.toHaveBeenCalled();
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("offers when no open request matches", async () => {
      const { getIssueStatus, offers, sent, useCase } = setup(undefined, DRAFT, null);

      await useCase.execute(input({ categories: ["request_status", "service_request"] }));

      expect(getIssueStatus.execute).not.toHaveBeenCalled();
      expect(sent).toHaveLength(1);
      expect(offers.put).toHaveBeenCalledTimes(1);
    });
  });

  describe("return value", () => {
    const ADDITION = { ...DRAFT, duplicateOf: "SD-6", addition: "It happened again." };
    const RESOLVE = { ...DRAFT, resolves: "SD-6", closingComment: "It works again." };
    const PART = { ...DRAFT, requestKind: "part" as const, part: { part: "paper tray roller" } };

    it.each<[string, SupportDraft, OfferSupportInput["categories"]]>([
      ["an offer to raise", DRAFT, ["service_request"]],
      ["a missing-details question", PART, ["service_request"]],
      ["an addition offer", ADDITION, ["update"]],
      ["a resolve offer", RESOLVE, ["update"]],
    ])("is true after sending %s", async (_label, draft, categories) => {
      const { sent, useCase } = setup(undefined, draft);
      await expect(useCase.execute(input({ categories }))).resolves.toBe(true);
      expect(sent).toHaveLength(1);
    });

    it("is true after a status answer", async () => {
      const { getIssueStatus, useCase } = setup(undefined, DRAFT, "SD-6");
      await expect(useCase.execute(input({ categories: ["request_status"] }))).resolves.toBe(true);
      expect(getIssueStatus.execute).toHaveBeenCalledOnce();
    });

    it("is false when the status answer throws", async () => {
      const { getIssueStatus, useCase } = setup(undefined, DRAFT, "SD-6");
      getIssueStatus.execute.mockRejectedValue(new TypeError("socket closed"));
      await expect(useCase.execute(input({ categories: ["request_status"] }))).resolves.toBe(false);
    });

    it("is true when the question was sent but a cancellation during the send kept the offer from being stored", async () => {
      const controller = new AbortController();
      const { wire, offers, sent, useCase } = setup();
      wire.sendCompositePrompt.mockImplementation(async (_conv: QualifiedId, text: string) => { sent.push(text); controller.abort(); return undefined; });
      await expect(useCase.execute(input({ signal: controller.signal }))).resolves.toBe(true);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("is false for every path that sends nothing", async () => {
      const cases: Array<[ReturnType<typeof setup>, OfferSupportInput]> = [];
      // Below the threshold, and without a relevant category.
      cases.push([setup(), input({ confidence: PASSIVE_CONFIDENCE_MIN - 0.01 })]);
      cases.push([setup(), input({ categories: ["other"] })]);
      // The open requests cannot be read.
      const unreadable = setup();
      unreadable.requests.listByConversation.mockRejectedValue(new Error("db down"));
      cases.push([unreadable, input()]);
      // No draft, a covered problem without an addition, an addition-only category without one,
      // a close request for a request that is not open here, a draft outside the bounds.
      cases.push([setup(undefined, null), input()]);
      cases.push([setup(undefined, { ...DRAFT, duplicateOf: "SD-6" }), input({ categories: ["update"] })]);
      cases.push([setup(undefined, DRAFT), input({ categories: ["update"] })]);
      cases.push([setup([], DRAFT), input({ categories: ["update"] })]);
      cases.push([setup(undefined, { ...DRAFT, resolves: "SD-99" }), input()]);
      cases.push([setup(undefined, { ...DRAFT, summary: "" }), input()]);
      cases.push([setup(undefined, { ...DRAFT, resolves: "SD-6", closingComment: "x".repeat(REPLY_BODY_MAX + 1) }), input()]);
      // A live offer, a draft failure, a status question that matches nothing.
      const busy = setup();
      busy.offers.has.mockReturnValue(true);
      cases.push([busy, input()]);
      const failing = setup();
      failing.triage.draftRequest.mockRejectedValue(new SyntaxError("bad"));
      cases.push([failing, input()]);
      cases.push([setup(undefined, DRAFT, null), input({ categories: ["request_status"] })]);
      // Canceled before the send, and a failed send.
      const controller = new AbortController();
      controller.abort();
      cases.push([setup(), input({ signal: controller.signal })]);
      const statusCanceled = setup(undefined, DRAFT, "SD-6");
      cases.push([statusCanceled, input({ categories: ["request_status"], signal: controller.signal })]);
      const sendFails = setup();
      sendFails.wire.sendCompositePrompt.mockRejectedValue(new TypeError("socket closed"));
      cases.push([sendFails, input()]);

      for (const [ctx, message] of cases) {
        await expect(ctx.useCase.execute(message)).resolves.toBe(false);
        expect(ctx.getIssueStatus.execute).not.toHaveBeenCalled();
        expect(ctx.sent).toEqual([]);
      }
    });
  });
});

describe("OfferSupportFromConversation: last message reference", () => {
  const ADDITION: SupportDraft = { ...DRAFT, duplicateOf: "sd-6", addition: "It only happens on the 3rd floor." };
  const RESOLVE: SupportDraft = { ...DRAFT, summary: "", description: "", resolves: "SD-6", closingComment: null };

  it.each<[string, SupportDraft]>([
    ["an addition offer", ADDITION],
    ["a resolve offer", RESOLVE],
  ])("does not store %s, sent with buttons, as the request's last message", async (_label, draft) => {
    // The question is edited when it closes, so the request keeps its previous last message.
    const { requests, offers, sent, useCase } = setup(undefined, draft);

    await expect(useCase.execute(input({ categories: ["update"] }))).resolves.toBe(true);

    expect(requests.setLastMessage).not.toHaveBeenCalled();
    expect(offers.put).toHaveBeenCalledTimes(1);
    expect(offers.put).toHaveBeenCalledWith(expect.objectContaining({ messageId: sentRefFor(1).messageId, question: sent[0] }));
  });

  it("stores no reference for an offer to raise a new request or a missing-details question", async () => {
    const raise = setup();
    await raise.useCase.execute(input());
    expect(raise.sent).toHaveLength(1);
    expect(raise.requests.setLastMessage).not.toHaveBeenCalled();

    const part = setup(undefined, { ...DRAFT, requestKind: "part", part: { asset: "printer 12" } });
    await part.useCase.execute(input());
    expect(part.sent).toHaveLength(1);
    expect(part.requests.setLastMessage).not.toHaveBeenCalled();
  });

  it("stores no reference when the send failed or returned none", async () => {
    const failed = setup(undefined, ADDITION);
    failed.wire.sendCompositePrompt.mockRejectedValue(new TypeError("socket closed"));
    await failed.useCase.execute(input({ categories: ["update"] }));
    expect(failed.requests.setLastMessage).not.toHaveBeenCalled();

    const none = setup(undefined, ADDITION);
    none.wire.sendCompositePrompt.mockResolvedValueOnce(undefined);
    await expect(none.useCase.execute(input({ categories: ["update"] }))).resolves.toBe(true);
    expect(none.requests.setLastMessage).not.toHaveBeenCalled();
    expect(none.offers.put).toHaveBeenCalledTimes(1);
  });

  it("stores neither the offer nor a reference when the work is canceled while the question is being sent", async () => {
    const controller = new AbortController();
    const { requests, wire, offers, sent, useCase } = setup(undefined, ADDITION);
    wire.sendCompositePrompt.mockImplementation(async (_conv: QualifiedId, text: string) => {
      sent.push(text);
      controller.abort();
      return sentRefFor(sent.length);
    });

    await expect(useCase.execute(input({ signal: controller.signal, categories: ["update"] }))).resolves.toBe(true);

    expect(offers.put).not.toHaveBeenCalled();
    expect(requests.setLastMessage).not.toHaveBeenCalled();
  });

  it("stores the reference of a passive status answer through the real GetIssueStatus", async () => {
    const requests = makeRequests([makeRequest()]);
    const { wire } = makeWire();
    const getIssueStatus = new GetIssueStatus(requests, makeTracker(), wire, makeAudit(), makeLogger());
    const triage = { draftRequest: vi.fn(), matchStatusQuestion: vi.fn().mockResolvedValue("SD-6"), extractPartDetails: vi.fn() };
    const offers = {
      put: vi.fn(), take: vi.fn(), has: vi.fn(), peek: vi.fn(), clearConversation: vi.fn(),
      drop: vi.fn(), recentlyDropped: vi.fn(), forgetDropped: vi.fn(), find: vi.fn(), prompt: vi.fn(), markAnswered: vi.fn(), claimNotice: vi.fn(), claimClose: vi.fn(() => null), takeEndedPrompts: vi.fn(() => []), sweepExpired: vi.fn(),
    };
    const useCase = new OfferSupportFromConversation(requests, triage, getIssueStatus, offers, wire, makeLogger());

    await useCase.execute(input({ categories: ["request_status"] }));

    expect(requests.setLastMessage).toHaveBeenCalledWith("SD-6", sentRefFor(1));
  });
});

describe("OfferSupportFromConversation: choosing the target", () => {
  const printer = (key: string, overrides: Partial<SupportRequest> = {}): SupportRequest =>
    makeRequest({ key, summary: `Printer on floor ${key.slice(3)} is broken`, ...overrides });
  const buttonLabels = (wire: ReturnType<typeof setup>["wire"]) => (wire.sendCompositePrompt.mock.calls[0]![2] as Array<{ label: string }>).map((b) => b.label);

  describe("new or existing request", () => {
    it("offers [Add to SD-n] [Raise new request] [Cancel] when an open request shares a significant word", async () => {
      const { offers, wire, sent, useCase } = setup([printer("SD-38")]);

      await expect(useCase.execute(input())).resolves.toBe(true);

      expect(sent).toEqual([
        "This may be the same problem as an existing request. Shall I add it there, or raise a new request?\n"
        + "> **Printer on floor 3 jams on every job**\n> The printer on floor 3 jams on every job.\n\n"
        + '- **SD-38** "Printer on floor 38 is broken"',
      ]);
      expect(buttonLabels(wire)).toEqual(["Add to SD-38", "Raise new request", "Cancel"]);
      const offer = offers.put.mock.calls[0]![0];
      expect(offer.choices!.map((c: { command: unknown }) => c.command)).toEqual([
        { kind: "reply", issueKey: "SD-38", body: DRAFT.description },
        { kind: "support", requestKind: "fault", summary: DRAFT.summary, description: DRAFT.description },
        null,
      ]);
      // The button IDs carry the stored offer's ID and the index only.
      expect(wire.sendCompositePrompt.mock.calls[0]![2]).toEqual([
        { id: `${offer.id}:0`, label: "Add to SD-38" }, { id: `${offer.id}:1`, label: "Raise new request" }, { id: `${offer.id}:2`, label: "Cancel" },
      ]);
      expect(offer.messageId).toBe(sentRefFor(1).messageId);
      expect(offer.command.kind).toBe("support");
    });

    it("adds the model's addition, quoted, when it differs from the description", async () => {
      const { offers, sent, useCase } = setup([printer("SD-38")], { ...DRAFT, duplicateOf: "SD-38", addition: "It happened again on floor 3." });
      await useCase.execute(input());
      expect(sent[0]).toContain("Added to an existing request, it would say:\n> It happened again on floor 3.");
      expect(offers.put.mock.calls[0]![0].choices[0].command).toEqual({ kind: "reply", issueKey: "SD-38", body: "It happened again on floor 3." });
    });

    it("accepts the model's suggestion only when it is one of the conversation's requests, and puts it first", async () => {
      const records = [printer("SD-40"), makeRequest({ key: "SD-6" })];
      const hinted = setup(records, { ...DRAFT, duplicateOf: "sd-6" });
      await hinted.useCase.execute(input());
      expect(buttonLabels(hinted.wire)).toEqual(["Add to SD-6", "Add to SD-40", "Raise new request", "Cancel"]);

      const invented = setup(records, { ...DRAFT, duplicateOf: "SD-77" });
      await invented.useCase.execute(input());
      expect(buttonLabels(invented.wire)).toEqual(["Add to SD-40", "Raise new request", "Cancel"]);

      const elsewhere = setup([makeRequest({ key: "SD-6", conversationId: { id: "conv-2", domain: "example.com" } })], { ...DRAFT, duplicateOf: "SD-6" });
      await elsewhere.useCase.execute(input());
      expect(elsewhere.wire.sendCompositePrompt.mock.calls[0]![1]).toBe(withoutAnswerHint(formatSupportQuestion(DRAFT.summary, DRAFT.description)));
      expect(buttonLabels(elsewhere.wire)).toEqual(["Yes", "No"]);
    });

    it("offers only the conversation's own requests of the project, open or done within seven days, at most three", async () => {
      const day = 24 * 60 * 60 * 1000;
      const records = [
        printer("SD-41"),
        printer("SD-42", { statusCategory: "done", updatedAt: new Date(LATER.getTime() - 6 * day) }),
        printer("SD-43", { statusCategory: "done", updatedAt: new Date(LATER.getTime() - 8 * day) }),
        printer("SD-44", { conversationId: { id: "conv-1", domain: "other.example" } }),
        printer("SD-45", { deleted: true }),
        printer("OPS-46"),
        printer("SD-47"),
        printer("SD-48"),
      ];
      const { wire, sent, useCase } = setup(records);
      await useCase.execute(input());
      expect(buttonLabels(wire)).toEqual(["Add to SD-41", "Add to SD-42", "Add to SD-47", "Raise new request", "Cancel"]);
      expect(sent[0]).toContain('- **SD-42** "Printer on floor 42 is broken" (resolved)');
    });

    it("keeps the yes-or-no offer to raise when no request may be the same problem", async () => {
      const { offers, wire, useCase } = setup([makeRequest({ key: "SD-6", summary: "VPN drops every ten minutes" })]);
      await useCase.execute(input());
      expect(wire.sendCompositePrompt.mock.calls[0]![1]).toBe(withoutAnswerHint(formatSupportQuestion(DRAFT.summary, DRAFT.description)));
      expect(buttonLabels(wire)).toEqual(["Yes", "No"]);
      expect(offers.put.mock.calls[0]![0].choices).toBeUndefined();
    });

    it("stays silent when the requests cannot be read for the candidates", async () => {
      const { requests, sent, offers, useCase } = setup([printer("SD-38")]);
      requests.listByConversation.mockImplementation(async (_c: QualifiedId, options?: { openOnly?: boolean }) => {
        if (options?.openOnly) return [printer("SD-38")];
        throw new Error("db down");
      });
      await expect(useCase.execute(input())).resolves.toBe(false);
      expect(sent).toEqual([]);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("stores the choice as nobody's last message", async () => {
      const { requests, useCase } = setup([printer("SD-38")]);
      await useCase.execute(input());
      expect(requests.setLastMessage).not.toHaveBeenCalled();
    });
  });

  describe("which request to resolve or add to", () => {
    const RESOLVE_38: SupportDraft = { ...DRAFT, resolves: "SD-38", closingComment: "Works after the reset." };

    it("lists the model's pick first, then the speaker's, then the others, at most three, plus [Cancel], when the message names no key", async () => {
      const records = [
        makeRequest({ key: "SD-50", requesterId: bob }),
        makeRequest({ key: "SD-49", requesterId: bob }),
        makeRequest({ key: "SD-39" }),
        makeRequest({ key: "SD-38", requesterId: bob }),
      ];
      const { offers, wire, sent, useCase } = setup(records, RESOLVE_38);
      await useCase.execute(input({ text: "the printer works again after the reset" }));
      expect(buttonLabels(wire)).toEqual(["SD-38", "SD-39", "SD-50", "Cancel"]);
      expect(sent[0]).toBe(
        "Which request shall I resolve with the service desk, adding this comment?\n> Works after the reset.\n\n"
        + '- **SD-38** "VPN drops every ten minutes"\n- **SD-39** "VPN drops every ten minutes"\n- **SD-50** "VPN drops every ten minutes"',
      );
      const offer = offers.put.mock.calls[0]![0];
      expect(offer.command).toEqual({ kind: "resolve", issueKey: "SD-38", comment: "Works after the reset." });
      expect(offer.choices.map((c: { command: unknown }) => c.command)).toEqual([
        { kind: "resolve", issueKey: "SD-38", comment: "Works after the reset." },
        { kind: "resolve", issueKey: "SD-39", comment: "Works after the reset." },
        { kind: "resolve", issueKey: "SD-50", comment: "Works after the reset." },
        null,
      ]);
    });

    it("keeps the yes-or-no resolve offer when the message names a key or only one request is open", async () => {
      const named = setup([makeRequest({ key: "SD-38" }), makeRequest({ key: "SD-39" })], RESOLVE_38);
      await named.useCase.execute(input({ text: "SD-38 works again after the reset" }));
      expect(buttonLabels(named.wire)).toEqual(["Yes", "No"]);
      expect(named.sent[0]).toBe(withoutAnswerHint(formatResolveQuestion("SD-38", "VPN drops every ten minutes", "Works after the reset.")));

      const single = setup([makeRequest({ key: "SD-38" })], RESOLVE_38);
      await single.useCase.execute(input({ text: "it works again after the reset" }));
      expect(buttonLabels(single.wire)).toEqual(["Yes", "No"]);
    });

    it("asks which request an update adds to when several are open and no key is named", async () => {
      const draft = { ...DRAFT, duplicateOf: "SD-39", addition: "It also happens on floor 2." };
      const { offers, wire, sent, useCase } = setup([makeRequest({ key: "SD-40" }), makeRequest({ key: "SD-39" })], draft);
      await useCase.execute(input({ categories: ["update"], text: "it also happens on floor 2" }));
      expect(buttonLabels(wire)).toEqual(["SD-39", "SD-40", "Cancel"]);
      expect(sent[0]).toBe('Which request shall I add this to?\n> It also happens on floor 2.\n\n- **SD-39** "VPN drops every ten minutes"\n- **SD-40** "VPN drops every ten minutes"');
      expect(offers.put.mock.calls[0]![0].choices[1].command).toEqual({ kind: "reply", issueKey: "SD-40", body: "It also happens on floor 2." });
    });
  });
});
