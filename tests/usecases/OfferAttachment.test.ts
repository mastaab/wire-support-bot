import { describe, it, expect, vi } from "vitest";
import { ANSWER_FIRST, OfferAttachment } from "../../src/application/usecases/jira/OfferAttachment";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import { OFFER_TTL_MS } from "../../src/application/services/offers";
import type { InboundFile } from "../../src/application/ports/PendingOfferPort";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import { sameQualifiedId } from "../../src/domain/ids/QualifiedId";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { SupportRequestListOptions } from "../../src/domain/repositories/SupportRequestRepository";
import {
  alice, bob, convId, loggedText, makeLogger, makeRequest, makeRequests, makeWire, sentRefFor,
} from "./supportRequestFakes";

const now = new Date("2026-09-28T10:00:00Z");
const at = (iso: string): Date => new Date(iso);

const PHOTO: InboundFile = {
  ref: { transport: "wire", data: { assetId: "asset-1", token: "secret-token" } },
  fileKind: "photo",
  name: "IMG_0042.jpg",
  mimeType: "image/jpeg",
  sizeInBytes: 2048,
};
const DOCUMENT: InboundFile = { ...PHOTO, fileKind: "file", name: "service-log.pdf", mimeType: "application/pdf" };

/** Repository whose listing behaves like the contract: this conversation only, not deleted, open only on request, newest first. */
function makeScopedRequests(records: SupportRequest[]) {
  const requests = makeRequests(records);
  requests.listByConversation.mockImplementation(async (conversationId: QualifiedId, options?: SupportRequestListOptions) =>
    records
      .filter((r) => !r.deleted && sameQualifiedId(r.conversationId, conversationId))
      .filter((r) => !options?.openOnly || r.statusCategory !== "done")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()));
  return requests;
}

function setup(records: SupportRequest[], options: { scoped?: boolean } = {}) {
  const requests = options.scoped === false ? makeRequests(records) : makeScopedRequests(records);
  const offers = new InMemoryPendingOfferStore();
  const { wire, sent } = makeWire();
  const logger = makeLogger();
  const useCase = new OfferAttachment(requests, offers, wire, logger, () => now);
  return { requests, offers, wire, sent, logger, useCase };
}

const input = { conversationId: convId, senderId: alice, messageId: "file-msg-1", file: PHOTO };

describe("OfferAttachment", () => {
  it("replies to the file with the question, stores an attach offer for the sender and stores the sent ref", async () => {
    const { requests, offers, wire, sent, useCase } = setup([makeRequest({ key: "SD-16", summary: "Error light on printer 12" })]);

    expect(await useCase.execute(input)).toBe(true);

    expect(sent).toEqual(['Shall I add this photo to **SD-16** "Error light on printer 12"?']);
    const offerId = offers.find(convId, alice, now)!.id!;
    expect(wire.sendCompositePrompt).toHaveBeenCalledWith(convId, sent[0], [
      { id: `${offerId}:0`, label: "Yes" }, { id: `${offerId}:1`, label: "No" },
    ], { replyToMessageId: "file-msg-1" });
    expect(requests.listByConversation).toHaveBeenCalledWith(convId, { openOnly: true });
    const offer = offers.take(convId, alice, now);
    expect(offer).toEqual({
      command: { kind: "attach", issueKey: "SD-16", file: PHOTO },
      conversationId: convId,
      requesterId: alice,
      createdAt: now,
      expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
      id: offerId,
      messageId: sentRefFor(1).messageId,
    });
    expect(requests.setLastMessage).toHaveBeenCalledTimes(1);
    expect(requests.setLastMessage).toHaveBeenCalledWith("SD-16", sentRefFor(1));
  });

  it("names a document with its file name", async () => {
    const { sent, useCase } = setup([makeRequest({ key: "SD-16", summary: "Error light on printer 12" })]);

    expect(await useCase.execute({ ...input, file: DOCUMENT })).toBe(true);

    expect(sent).toEqual(['Shall I add this file (service-log.pdf) to **SD-16** "Error light on printer 12"?']);
  });

  it("stores the offer for the sender only", async () => {
    const { offers, useCase } = setup([makeRequest()]);

    expect(await useCase.execute({ ...input, senderId: bob })).toBe(true);

    expect(offers.has(convId, alice, now)).toBe(false);
    expect(offers.has(convId, { id: bob.id, domain: "other.example" }, now)).toBe(false);
    expect(offers.has({ id: "conv-2", domain: "example.com" }, bob, now)).toBe(false);
    expect(offers.has(convId, bob, now)).toBe(true);
  });

  describe("target", () => {
    it("picks the open request with the latest bot message about it", async () => {
      const { offers, sent, useCase } = setup([
        makeRequest({ key: "SD-3", summary: "Older, last message late", createdAt: at("2026-09-20T09:00:00Z"), lastMessageAt: at("2026-09-28T09:30:00Z") }),
        makeRequest({ key: "SD-9", summary: "Newest, no message", createdAt: at("2026-09-27T09:00:00Z") }),
        makeRequest({ key: "SD-5", summary: "Middle, last message early", createdAt: at("2026-09-22T09:00:00Z"), lastMessageAt: at("2026-09-28T08:00:00Z") }),
      ]);

      expect(await useCase.execute(input)).toBe(true);

      expect(sent[0]).toContain("**SD-3**");
      expect(offers.take(convId, alice, now)?.command).toEqual({ kind: "attach", issueKey: "SD-3", file: PHOTO });
    });

    it("falls back to the newest open request when none has a bot message", async () => {
      const { offers, useCase } = setup([
        makeRequest({ key: "SD-3", createdAt: at("2026-09-20T09:00:00Z") }),
        makeRequest({ key: "SD-9", createdAt: at("2026-09-27T09:00:00Z") }),
        makeRequest({ key: "SD-5", createdAt: at("2026-09-22T09:00:00Z") }),
      ]);

      expect(await useCase.execute(input)).toBe(true);

      expect(offers.take(convId, alice, now)?.command).toMatchObject({ issueKey: "SD-9" });
    });

    it("breaks a tie on the last message by the newer request", async () => {
      const same = at("2026-09-28T09:00:00Z");
      const { offers, useCase } = setup([
        makeRequest({ key: "SD-3", createdAt: at("2026-09-20T09:00:00Z"), lastMessageAt: same }),
        makeRequest({ key: "SD-5", createdAt: at("2026-09-22T09:00:00Z"), lastMessageAt: same }),
      ]);

      expect(await useCase.execute(input)).toBe(true);

      expect(offers.take(convId, alice, now)?.command).toMatchObject({ issueKey: "SD-5" });
    });

    it("ignores the latest bot message about a resolved request", async () => {
      const { offers, useCase } = setup([
        makeRequest({ key: "SD-3", statusCategory: "done", lastMessageAt: at("2026-09-28T09:50:00Z") }),
        makeRequest({ key: "SD-5", statusCategory: "in_progress", lastMessageAt: at("2026-09-28T08:00:00Z") }),
      ]);

      expect(await useCase.execute(input)).toBe(true);

      expect(offers.take(convId, alice, now)?.command).toMatchObject({ issueKey: "SD-5" });
    });

    it("only considers requests of this conversation", async () => {
      const { offers, useCase } = setup([
        makeRequest({ key: "SD-7", conversationId: { id: "conv-2", domain: "example.com" }, lastMessageAt: at("2026-09-28T09:50:00Z") }),
        makeRequest({ key: "SD-8", conversationId: { id: "conv-1", domain: "other.example" }, lastMessageAt: at("2026-09-28T09:55:00Z") }),
        makeRequest({ key: "SD-5" }),
      ]);

      expect(await useCase.execute(input)).toBe(true);

      expect(offers.take(convId, alice, now)?.command).toMatchObject({ issueKey: "SD-5" });
    });

    it("re-checks scope, deletion and status even when the repository returns other records", async () => {
      const { offers, useCase } = setup([
        makeRequest({ key: "SD-7", conversationId: { id: "conv-2", domain: "example.com" }, lastMessageAt: at("2026-09-28T09:50:00Z") }),
        makeRequest({ key: "SD-8", deleted: true, lastMessageAt: at("2026-09-28T09:51:00Z") }),
        makeRequest({ key: "SD-9", statusCategory: "done", lastMessageAt: at("2026-09-28T09:52:00Z") }),
        makeRequest({ key: "SD-5" }),
      ], { scoped: false });

      expect(await useCase.execute(input)).toBe(true);

      expect(offers.take(convId, alice, now)?.command).toMatchObject({ issueKey: "SD-5" });
    });
  });

  describe("no offer", () => {
    it.each<[string, SupportRequest[]]>([
      ["no request at all", []],
      ["only resolved requests", [makeRequest({ statusCategory: "done" })]],
      ["only deleted requests", [makeRequest({ deleted: true })]],
      ["only another conversation's requests", [makeRequest({ conversationId: { id: "conv-2", domain: "example.com" } })]],
    ])("with %s: sends nothing and stores nothing", async (_label, records) => {
      const { requests, offers, wire, useCase } = setup(records);

      expect(await useCase.execute(input)).toBe(false);

      expect(wire.sendPlainText).not.toHaveBeenCalled();
      expect(wire.sendCompositePrompt).not.toHaveBeenCalled();
      expect(offers.has(convId, alice, now)).toBe(false);
      expect(requests.setLastMessage).not.toHaveBeenCalled();
    });

    it("keeps the sender's pending question and asks them to answer it first", async () => {
      const { requests, offers, wire, useCase } = setup([makeRequest()]);
      const existing = {
        command: { kind: "reply" as const, issueKey: "SD-6", body: "It still drops." },
        conversationId: convId, requesterId: alice, createdAt: now, expiresAt: new Date(now.getTime() + 60_000),
      };
      offers.put(existing);

      expect(await useCase.execute(input)).toBe(false);

      expect(wire.sendPlainText).toHaveBeenCalledWith(convId, ANSWER_FIRST, { replyToMessageId: "file-msg-1" });
      expect(requests.setLastMessage).not.toHaveBeenCalled();
      expect(offers.take(convId, alice, now)).toEqual(existing);
    });

    it("replaces the sender's pending file offer, so a yes attaches the file posted last", async () => {
      const { offers, useCase } = setup([makeRequest()]);
      expect(await useCase.execute(input)).toBe(true);
      expect(await useCase.execute({ ...input, messageId: "file-msg-2", file: DOCUMENT })).toBe(true);
      const live = offers.take(convId, alice, now);
      expect(live?.command).toMatchObject({ kind: "attach", file: { name: "service-log.pdf" } });
    });

    it("keeps an offer stored by passive help while the question was being sent", async () => {
      const { offers, wire, useCase } = setup([makeRequest()]);
      const passive = {
        command: { kind: "reply" as const, issueKey: "SD-6", body: "Fluid is low." },
        conversationId: convId, requesterId: alice, createdAt: now, expiresAt: new Date(now.getTime() + 60_000),
      };
      const send = wire.sendCompositePrompt.getMockImplementation()!;
      wire.sendCompositePrompt.mockImplementationOnce(async (...args) => { offers.put(passive); return send(...args); });

      expect(await useCase.execute(input)).toBe(false);

      expect(offers.take(convId, alice, now)).toEqual(passive);
    });

    it("offers when only another member has a pending offer", async () => {
      const { offers, useCase } = setup([makeRequest()]);
      offers.put({
        command: { kind: "resolve", issueKey: "SD-6" },
        conversationId: convId, requesterId: bob, createdAt: now, expiresAt: new Date(now.getTime() + 60_000),
      });

      expect(await useCase.execute(input)).toBe(true);

      expect(offers.has(convId, alice, now)).toBe(true);
      expect(offers.take(convId, bob, now)?.command.kind).toBe("resolve");
    });

    it("stores no offer when the send fails, and logs the error name only", async () => {
      const { requests, offers, wire, logger, useCase } = setup([makeRequest({ summary: "Error light on printer 12" })]);
      wire.sendCompositePrompt.mockRejectedValueOnce(new TypeError("send failed for IMG_0042.jpg"));

      expect(await useCase.execute(input)).toBe(false);

      expect(offers.has(convId, alice, now)).toBe(false);
      expect(requests.setLastMessage).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith("OfferAttachment: sending the offer failed", { err: "TypeError" });
      const logged = loggedText(logger);
      expect(logged).not.toContain("IMG_0042");
      expect(logged).not.toContain("Error light");
      expect(logged).not.toContain("secret-token");
    });

    it("sends nothing when listing the requests fails", async () => {
      const { requests, offers, wire, logger, useCase } = setup([makeRequest()]);
      requests.listByConversation.mockRejectedValueOnce(new Error("db down"));

      expect(await useCase.execute(input)).toBe(false);

      expect(wire.sendPlainText).not.toHaveBeenCalled();
      expect(wire.sendCompositePrompt).not.toHaveBeenCalled();
      expect(offers.has(convId, alice, now)).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith("OfferAttachment: listing open requests failed", { err: "Error" });
    });
  });

  it("stores the offer but no ref when the transport returns no reference", async () => {
    const { requests, offers, wire, useCase } = setup([makeRequest()]);
    wire.sendCompositePrompt.mockResolvedValueOnce(undefined);

    expect(await useCase.execute(input)).toBe(true);

    expect(offers.has(convId, alice, now)).toBe(true);
    expect(requests.setLastMessage).not.toHaveBeenCalled();
  });

  it("keeps the offer when storing the ref fails", async () => {
    const { requests, offers, logger, useCase } = setup([makeRequest()]);
    requests.setLastMessage.mockRejectedValueOnce(new RangeError("write failed"));

    expect(await useCase.execute(input)).toBe(true);

    expect(offers.has(convId, alice, now)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith("OfferAttachment: storing the last message failed", { key: "SD-6", err: "RangeError" });
  });

  it("never logs the file name, summary or download reference", async () => {
    const { logger, useCase } = setup([makeRequest({ summary: "Error light on printer 12" })]);

    await useCase.execute({ ...input, file: DOCUMENT });

    const logged = loggedText(logger);
    expect(logged).not.toContain("service-log");
    expect(logged).not.toContain("Error light");
    expect(logged).not.toContain("secret-token");
  });

  it("uses the injected clock for the expiry check", async () => {
    const clock = vi.fn(() => now);
    const requests = makeScopedRequests([makeRequest()]);
    const offers = new InMemoryPendingOfferStore();
    const { wire } = makeWire();
    const useCase = new OfferAttachment(requests, offers, wire, undefined, clock);
    offers.put({
      command: { kind: "resolve", issueKey: "SD-6" },
      conversationId: convId, requesterId: alice, createdAt: now, expiresAt: now,
    });

    // The earlier offer expired at `now`, so it no longer blocks a new one.
    expect(await useCase.execute(input)).toBe(true);
    expect(clock).toHaveBeenCalled();
  });
});

describe("OfferAttachment: choosing the request", () => {
  const labels = (wire: ReturnType<typeof setup>["wire"]) => (wire.sendCompositePrompt.mock.calls[0]![2] as Array<{ label: string }>).map((b) => b.label);

  it("asks which of the sender's open requests the file belongs to, likeliest first, at most three, with [Do not attach]", async () => {
    const records = [
      makeRequest({ key: "SD-40", summary: "Printer 12 error light", createdAt: at("2026-09-27T09:00:00Z") }),
      makeRequest({ key: "SD-41", summary: "Scanner offline", createdAt: at("2026-09-28T09:00:00Z") }),
      makeRequest({ key: "SD-42", summary: "Badge reader", createdAt: at("2026-09-26T09:00:00Z"), lastMessageAt: at("2026-09-28T09:30:00Z") }),
      makeRequest({ key: "SD-39", summary: "Old one", createdAt: at("2026-09-20T09:00:00Z") }),
      makeRequest({ key: "SD-43", summary: "Bob's request", requesterId: bob, createdAt: at("2026-09-28T09:50:00Z") }),
      makeRequest({ key: "SD-44", summary: "Done", statusCategory: "done", createdAt: at("2026-09-28T09:55:00Z") }),
    ];
    const { offers, wire, sent, requests, useCase } = setup(records);

    expect(await useCase.execute(input)).toBe(true);

    expect(labels(wire)).toEqual(["SD-42", "SD-41", "SD-40", "Do not attach"]);
    expect(sent).toEqual([
      'Which request shall I add this photo to?\n\n- **SD-42** "Badge reader"\n- **SD-41** "Scanner offline"\n- **SD-40** "Printer 12 error light"',
    ]);
    expect(wire.sendCompositePrompt.mock.calls[0]![3]).toEqual({ replyToMessageId: "file-msg-1" });
    const offer = offers.find(convId, alice, now)!;
    expect(offer.choices!.map((c) => c.command)).toEqual([
      { kind: "attach", issueKey: "SD-42", file: PHOTO }, { kind: "attach", issueKey: "SD-41", file: PHOTO }, { kind: "attach", issueKey: "SD-40", file: PHOTO }, null,
    ]);
    expect(offer.messageId).toBe(sentRefFor(1).messageId);
    // A choice names several requests, so it is no request's last message.
    expect(requests.setLastMessage).not.toHaveBeenCalled();
  });

  it("keeps the yes-or-no offer for the likeliest request when the sender has one open request or none of their own", async () => {
    const one = setup([makeRequest({ key: "SD-40" }), makeRequest({ key: "SD-43", requesterId: bob, createdAt: at("2026-09-28T09:50:00Z") })]);
    expect(await one.useCase.execute(input)).toBe(true);
    expect(labels(one.wire)).toEqual(["Yes", "No"]);
    expect(one.offers.find(convId, alice, now)!.choices).toBeUndefined();

    const none = setup([makeRequest({ key: "SD-43", requesterId: bob })]);
    expect(await none.useCase.execute(input)).toBe(true);
    expect(labels(none.wire)).toEqual(["Yes", "No"]);
    expect(none.offers.find(convId, alice, now)!.command).toMatchObject({ issueKey: "SD-43" });
  });
});
