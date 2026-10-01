import { describe, it, expect, vi } from "vitest";
import { ConfirmOffer, classifyConfirmation, isAcknowledgement } from "../../src/application/usecases/jira/ConfirmOffer";
import type { ConfirmOfferHandlers } from "../../src/application/usecases/jira/ConfirmOffer";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import { RECENT_DROP_MS } from "../../src/application/services/offers";
import type { OfferCommand, PendingOffer, PendingOfferStore } from "../../src/application/services/offers";
import type { InboundFile, OfferChoice } from "../../src/application/ports/PendingOfferPort";
import { addToChoice, cancelChoice, keyChoice, raiseNewChoice } from "../../src/application/services/offerButtons";
import { partOrderStep } from "../../src/application/services/partOrderSteps";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { CompositeButton, SentMessageRef } from "../../src/application/ports/WireOutboundPort";

const convId: QualifiedId = { id: "conv-1", domain: "example.com" };
const alice: QualifiedId = { id: "user-1", domain: "example.com" };
const bob: QualifiedId = { id: "user-2", domain: "example.com" };
const now = new Date("2026-09-25T10:00:00Z");

describe("classifyConfirmation", () => {
  it.each([
    "yes", "yes please", "yep", "yeah", "go ahead", "do it", "please do", "confirm", "confirmed",
    "Yes", "  YES!  ", "yes.", "`yes`", "yes, thanks", "yes thank you", "yeah please", "go ahead, thanks!", "Yep!!",
  ])("treats %j as yes", (text) => {
    expect(classifyConfirmation(text)).toBe("yes");
  });

  it.each([
    "no", "n", "nope", "no thanks", "cancel", "don't", "do not", "stop",
    "No.", "NOPE!", "`cancel`", "no, thank you", "don’t", "stop please",
  ])("treats %j as no", (text) => {
    expect(classifyConfirmation(text)).toBe("no");
  });

  it.each([
    "", "   ", "yes but change the summary first", "no, resolve SD-7 instead", "maybe", "thanks", "please",
    "yes yes", "what is the status of SD-42?", "okay so what's next", "yesterday", "ok ok",
    "ok", "okay", "sure", "ok thanks", "ok, thanks", "sure please", "y", "OK!",
  ])("does not treat %j as a confirmation", (text) => {
    expect(classifyConfirmation(text)).toBeNull();
  });
  it.each(["ok", "OK!", "okay", "sure", "ok thanks", "ok, thanks", "thanks", "y", "cheers"])("recognises %j as an acknowledgement, not a decision", (text) => {
    expect(isAcknowledgement(text)).toBe(true);
  });

  it.each(["yes", "no", "what is due today?", "ok so what's next", "okay resolve SD-7 instead"])("does not treat %j as a bare acknowledgement", (text) => {
    expect(isAcknowledgement(text)).toBe(false);
  });
});

const SUPPORT: OfferCommand = { kind: "support", requestKind: "fault", summary: "VPN drops every ten minutes", description: "My VPN drops every ten minutes." };
const REPLY: OfferCommand = { kind: "reply", issueKey: "SD-6", body: "It still drops after the reset." };
const RESOLVE: OfferCommand = { kind: "resolve", issueKey: "SD-6" };
const RESOLVE_WITH_COMMENT: OfferCommand = { kind: "resolve", issueKey: "SD-6", comment: "The keyboard works again." };

const NOTHING = "There's nothing waiting for your yes: I haven't raised or sent anything.";
const nothingWaiting = {
  support: `${NOTHING}\nTo raise it, send \`@Wire Support Bot support: <problem>\`.`,
  reply: `${NOTHING}\nTo send a reply, use \`@Wire Support Bot reply to SD-6: <text>\`.`,
  resolve: `${NOTHING}\nTo resolve it, use \`@Wire Support Bot resolve SD-6\`.`,
} as const;

function setup(options: { store?: PendingOfferStore; clock?: () => Date; deliveryLocations?: string[] } = {}) {
  const store = options.store ?? new InMemoryPendingOfferStore();
  const handlers = {
    raiseSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
    replyToServiceDesk: { execute: vi.fn().mockResolvedValue(true) },
    resolveSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
  };
  const sent: string[] = [];
  const wire = {
    sendPlainText: vi.fn(async (_c: QualifiedId, text: string): Promise<SentMessageRef | undefined> => { sent.push(text); return undefined; }),
    getUserProfile: vi.fn(),
    sendCompositePrompt: vi.fn(async (_c: QualifiedId, text: string, _b: CompositeButton[]): Promise<SentMessageRef | undefined> => {
      sent.push(text);
      return { messageId: `bot-msg-${sent.length}`, sha256: "" };
    }),
    sendButtonConfirmation: vi.fn(),
    sendReaction: vi.fn(),
    sendFile: vi.fn(),
    withTyping: <T>(_c: QualifiedId, work: () => Promise<T>): Promise<T> => work(),
  };
  const useCase = new ConfirmOffer(store, handlers as unknown as ConfirmOfferHandlers, wire, options.clock ?? (() => now), undefined, options.deliveryLocations ?? []);
  const offer = (command: OfferCommand, requesterId: QualifiedId = alice, expiresAt = new Date(now.getTime() + 10 * 60 * 1000)): void =>
    store.put({ command, conversationId: convId, requesterId, createdAt: now, expiresAt });
  return { store, handlers, wire, sent, useCase, offer };
}

const input = { conversationId: convId, requesterId: alice, requesterName: "Alice", replyToMessageId: "msg-9" };

function expectNothingDispatched(handlers: ReturnType<typeof setup>["handlers"]): void {
  expect(handlers.raiseSupportRequest.execute).not.toHaveBeenCalled();
  expect(handlers.replyToServiceDesk.execute).not.toHaveBeenCalled();
  expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
}

describe("ConfirmOffer", () => {
  it("returns false for a non-confirmation without touching the store", async () => {
    const store = {
      put: vi.fn(), take: vi.fn(), has: vi.fn(), peek: vi.fn(), find: vi.fn(), clearConversation: vi.fn(),
      drop: vi.fn(), recentlyDropped: vi.fn(), forgetDropped: vi.fn(),
      prompt: vi.fn(), markAnswered: vi.fn(), claimNotice: vi.fn(),
    };
    const { handlers, wire, useCase } = setup({ store });

    expect(await useCase.execute({ ...input, text: "yes but change the summary first" })).toBe(false);

    expect(store.has).not.toHaveBeenCalled();
    expect(store.take).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
    expect(store.markAnswered).not.toHaveBeenCalled();
    expectNothingDispatched(handlers);
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it("returns false for a plain yes with nothing pending", async () => {
    const { handlers, wire, useCase } = setup();

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(false);

    expectNothingDispatched(handlers);
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it("raises the offered support request for the requester, with their display name", async () => {
    const { handlers, useCase, offer } = setup();
    offer(SUPPORT);

    expect(await useCase.execute({ ...input, text: "Yes please" })).toBe(true);

    expect(handlers.raiseSupportRequest.execute).toHaveBeenCalledWith({
      summary: "VPN drops every ten minutes", description: "My VPN drops every ten minutes.",
      conversationId: convId, requesterId: alice, requesterName: "Alice", replyToMessageId: "msg-9", requestKind: "fault",
    });
    expect(handlers.raiseSupportRequest.execute.mock.calls[0]![0]).not.toHaveProperty("part");
    expect(handlers.replyToServiceDesk.execute).not.toHaveBeenCalled();
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
  });

  it("passes no display name through when none was resolved", async () => {
    const { handlers, useCase, offer } = setup();
    offer(SUPPORT);

    await useCase.execute({ conversationId: convId, requesterId: alice, text: "yes" });

    expect(handlers.raiseSupportRequest.execute).toHaveBeenCalledWith(expect.objectContaining({ requesterName: undefined }));
  });

  it("sends the offered reply with the requester as actor", async () => {
    const { handlers, useCase, offer } = setup();
    offer(REPLY);

    expect(await useCase.execute({ ...input, text: "go ahead" })).toBe(true);

    expect(handlers.replyToServiceDesk.execute).toHaveBeenCalledWith({
      reference: "SD-6", body: "It still drops after the reset.", conversationId: convId, actorId: alice, replyToMessageId: "msg-9",
    });
    expect(handlers.raiseSupportRequest.execute).not.toHaveBeenCalled();
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
  });

  it("resolves the offered support request with the requester as actor", async () => {
    const { handlers, useCase, offer } = setup();
    offer(RESOLVE);

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);

    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledWith({
      issueKey: "SD-6", conversationId: convId, actorId: alice, replyToMessageId: "msg-9",
    });
    expect(handlers.raiseSupportRequest.execute).not.toHaveBeenCalled();
    expect(handlers.replyToServiceDesk.execute).not.toHaveBeenCalled();
  });

  it("passes the closing comment of a resolve offer to the use case", async () => {
    const { handlers, useCase, offer } = setup();
    offer(RESOLVE_WITH_COMMENT);

    expect(await useCase.execute({ ...input, text: "yes please" })).toBe(true);

    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledWith({
      issueKey: "SD-6", conversationId: convId, actorId: alice, replyToMessageId: "msg-9", comment: "The keyboard works again.",
    });
  });

  it("gives the comment form of the command for a yes after a dropped resolve offer with a comment", async () => {
    const { store, sent, useCase, offer } = setup();
    offer(RESOLVE_WITH_COMMENT);
    store.drop(convId, alice, now);

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);

    expect(sent).toEqual([`${NOTHING}\nTo resolve it with a comment, use \`@Wire Support Bot resolve SD-6: <comment>\`.`]);
  });

  it.each([
    [SUPPORT, "I need a clear yes or no, so I haven't raised anything with the service desk yet. Shall I raise it (yes or no)?"],
    [REPLY, "I need a clear yes or no, so I haven't added this to **SD-6** yet. Shall I add it (yes or no)?"],
    [RESOLVE, "I need a clear yes or no, so I haven't resolved **SD-6** yet. Shall I resolve it with the service desk (yes or no)?"],
    [RESOLVE_WITH_COMMENT, "I need a clear yes or no, so I haven't resolved **SD-6** yet. Shall I add the comment and resolve it (yes or no)?"],
  ])("asks again after an acknowledgement for a %j offer, keeps it, and a following yes still confirms it", async (command, question) => {
    const { handlers, wire, store, useCase, offer } = setup();
    offer(command);

    expect(await useCase.execute({ ...input, text: "ok thanks" })).toBe(true);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, question, { replyToMessageId: input.replyToMessageId });
    expectNothingDispatched(handlers);
    expect(store.has(convId, alice, now)).toBe(true);

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);
    const dispatched = {
      support: handlers.raiseSupportRequest.execute,
      reply: handlers.replyToServiceDesk.execute,
      resolve: handlers.resolveSupportRequest.execute,
    }[command.kind];
    expect(dispatched).toHaveBeenCalledTimes(1);
  });

  it("does not treat an acknowledgement as handled when nothing is pending", async () => {
    const { handlers, wire, useCase } = setup();
    expect(await useCase.execute({ ...input, text: "ok thanks" })).toBe(false);
    expectNothingDispatched(handlers);
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it.each([SUPPORT, REPLY, RESOLVE])("cancels a %j offer on no and consumes it", async (command) => {
    const { handlers, wire, sent, store, useCase, offer } = setup();
    offer(command);

    expect(await useCase.execute({ ...input, text: "no thanks" })).toBe(true);

    expect(sent).toEqual(["Understood, I won't."]);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, "Understood, I won't.", { replyToMessageId: "msg-9" });
    expectNothingDispatched(handlers);
    expect(store.has(convId, alice, now)).toBe(false);
    expect(await useCase.execute({ ...input, text: "yes" })).toBe(false);
    expectNothingDispatched(handlers);
  });

  it("consumes the offer once", async () => {
    const { handlers, useCase, offer } = setup();
    offer(SUPPORT);

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);
    expect(await useCase.execute({ ...input, text: "yes" })).toBe(false);

    expect(handlers.raiseSupportRequest.execute).toHaveBeenCalledTimes(1);
  });

  it("ignores another member's yes and keeps the requester's offer", async () => {
    const { handlers, store, useCase, offer } = setup();
    offer(RESOLVE);

    expect(await useCase.execute({ ...input, requesterId: bob, text: "yes" })).toBe(false);
    expect(await useCase.execute({ ...input, requesterId: { id: alice.id, domain: "other.example" }, text: "yes" })).toBe(false);

    expectNothingDispatched(handlers);
    expect(store.has(convId, alice, now)).toBe(true);
    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);
    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledTimes(1);
  });

  it("ignores a yes in another conversation", async () => {
    const { handlers, useCase, offer } = setup();
    offer(SUPPORT);

    expect(await useCase.execute({ ...input, conversationId: { id: "conv-2", domain: "example.com" }, text: "yes" })).toBe(false);

    expectNothingDispatched(handlers);
  });

  it("runs nothing for an expired offer: a yes is told nothing is waiting, a no or ok is not handled", async () => {
    const expiresAt = new Date(now.getTime() + 60_000);
    let clock = now;
    const { handlers, sent, useCase, offer } = setup({ clock: () => clock });
    offer(SUPPORT, alice, expiresAt);

    clock = expiresAt;
    expect(await useCase.execute({ ...input, text: "no" })).toBe(false);
    expect(await useCase.execute({ ...input, text: "ok" })).toBe(false);
    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);

    expectNothingDispatched(handlers);
    expect(sent).toEqual([nothingWaiting.support]);
  });

  describe("a yes with nothing to confirm", () => {
    it.each([SUPPORT, REPLY, RESOLVE])("answers a yes after a %j offer was dropped once, then forgets it", async (command) => {
      const { handlers, wire, store, useCase, offer } = setup();
      offer(command);
      expect(store.drop(convId, alice, now)).toEqual(command);

      expect(await useCase.execute({ ...input, text: "yes please" })).toBe(true);
      // A second yes may be meant for a colleague, so it is left to normal routing.
      expect(await useCase.execute({ ...input, text: "yes" })).toBe(false);

      expectNothingDispatched(handlers);
      expect(wire.sendPlainText).toHaveBeenCalledTimes(1);
      expect(wire.sendPlainText).toHaveBeenCalledWith(convId, nothingWaiting[command.kind], { replyToMessageId: "msg-9" });
      expect(store.recentlyDropped(convId, alice, now)).toBeNull();
    });

    it.each(["no", "ok thanks", "what about SD-6?"])("does not handle %j with only a recently dropped offer", async (text) => {
      const { handlers, wire, store, useCase, offer } = setup();
      offer(SUPPORT);
      store.drop(convId, alice, now);

      expect(await useCase.execute({ ...input, text })).toBe(false);

      expectNothingDispatched(handlers);
      expect(wire.sendPlainText).not.toHaveBeenCalled();
    });

    it("does not handle a yes once the drop is older than ten minutes", async () => {
      let clock = now;
      const { wire, store, useCase, offer } = setup({ clock: () => clock });
      offer(SUPPORT);
      store.drop(convId, alice, now);

      clock = new Date(now.getTime() + RECENT_DROP_MS);
      expect(await useCase.execute({ ...input, text: "yes" })).toBe(false);
      expect(wire.sendPlainText).not.toHaveBeenCalled();
    });

    it("does not answer another member's yes about the requester's dropped offer", async () => {
      const { wire, store, useCase, offer } = setup();
      offer(SUPPORT);
      store.drop(convId, alice, now);

      expect(await useCase.execute({ ...input, requesterId: bob, text: "yes" })).toBe(false);
      expect(wire.sendPlainText).not.toHaveBeenCalled();
    });

    it("confirms a new live offer instead of answering about the dropped one", async () => {
      const { handlers, sent, store, useCase, offer } = setup();
      offer(SUPPORT);
      store.drop(convId, alice, now);
      offer(RESOLVE);

      expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);

      expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([]);
    });

    it("does not treat a consumed or declined offer as dropped", async () => {
      const { sent, useCase, offer } = setup();
      offer(SUPPORT);
      expect(await useCase.execute({ ...input, text: "no" })).toBe(true);
      offer(REPLY);
      expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);

      expect(await useCase.execute({ ...input, text: "yes" })).toBe(false);
      expect(sent).toEqual(["Understood, I won't."]);
    });
  });

  describe("part orders", () => {
    const PART = { asset: "Printer 17", part: "Toner cartridges", quantity: "2", deliverTo: "Depot North" };
    const COMPLETE: OfferCommand = { kind: "support", requestKind: "part", summary: "Toner cartridges for printer 17", description: "The black toner is low.", part: PART };
    const INCOMPLETE: OfferCommand = { kind: "support", requestKind: "part", summary: "Toner cartridges", description: "The black toner is low.", part: { part: "Toner cartridges", quantity: "2" } };

    it("raises a complete part order with its kind and details", async () => {
      const { handlers, useCase, offer } = setup();
      offer(COMPLETE);

      expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);

      expect(handlers.raiseSupportRequest.execute).toHaveBeenCalledWith({
        summary: "Toner cartridges for printer 17", description: "The black toner is low.", conversationId: convId, requesterId: alice,
        requesterName: "Alice", replyToMessageId: "msg-9", requestKind: "part", part: PART,
      });
    });

    it("passes the question kind through", async () => {
      const { handlers, useCase, offer } = setup();
      offer({ kind: "support", requestKind: "question", summary: "Service interval", description: "How often is the oil changed?" });

      await useCase.execute({ ...input, text: "yes" });

      expect(handlers.raiseSupportRequest.execute).toHaveBeenCalledWith(expect.objectContaining({ requestKind: "question" }));
    });

    it("does not raise an incomplete part order on yes: says what is missing and keeps the draft", async () => {
      const { handlers, wire, sent, store, useCase, offer } = setup();
      offer(INCOMPLETE);

      expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);

      expectNothingDispatched(handlers);
      expect(sent).toEqual(["I haven't ordered anything yet: I still need the item the part is for (for example a serial number) and the delivery location."]);
      expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-9" });
      expect(store.has(convId, alice, now)).toBe(true);
      expect(store.recentlyDropped(convId, alice, now)).toBeNull();
    });

    it("refuses an order with no details at all, naming every essential", async () => {
      const { handlers, sent, useCase, offer } = setup();
      offer({ kind: "support", requestKind: "part", summary: "Tray", description: "Need a new tray." });

      expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);

      expectNothingDispatched(handlers);
      expect(sent).toEqual([
        "I haven't ordered anything yet: I still need the item the part is for (for example a serial number), the part (name or number), the quantity and the delivery location.",
      ]);
    });

    it("asks for the missing free-text details again after an acknowledgement", async () => {
      const { handlers, sent, store, useCase, offer } = setup();
      offer(INCOMPLETE);

      expect(await useCase.execute({ ...input, text: "ok" })).toBe(true);

      expectNothingDispatched(handlers);
      expect(sent).toEqual(["To order it I need the item the part is for (for example a serial number). What is it?"]);
      expect(store.has(convId, alice, now)).toBe(true);
    });

    it("cancels an incomplete part order on no", async () => {
      const { handlers, sent, store, useCase, offer } = setup();
      offer(INCOMPLETE);

      expect(await useCase.execute({ ...input, text: "no" })).toBe(true);

      expectNothingDispatched(handlers);
      expect(sent).toEqual(["Understood, I won't."]);
      expect(store.has(convId, alice, now)).toBe(false);
    });
  });

  describe("attach offers", () => {
    const PHOTO: InboundFile = {
      ref: { transport: "wire", data: { assetId: "asset-1" } }, fileKind: "photo", name: "IMG_0042.jpg", mimeType: "image/jpeg", sizeInBytes: 2048,
    };
    const DOCUMENT: InboundFile = { ...PHOTO, fileKind: "file", name: "service-log.pdf", mimeType: "application/pdf" };
    const ATTACH_PHOTO: OfferCommand = { kind: "attach", issueKey: "SD-6", file: PHOTO };
    const ATTACH_DOCUMENT: OfferCommand = { kind: "attach", issueKey: "SD-6", file: DOCUMENT };

    function setupAttach() {
      const context = setup();
      const attachFileToRequest = { execute: vi.fn().mockResolvedValue(true) };
      const useCase = new ConfirmOffer(
        context.store,
        { ...context.handlers, attachFileToRequest } as unknown as ConfirmOfferHandlers,
        context.wire,
        () => now,
      );
      return { ...context, attachFileToRequest, useCase };
    }

    it("says so instead of staying silent when attachments are not wired", async () => {
      const { sent, useCase, offer } = setup();
      offer(ATTACH_PHOTO);
      expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);
      expect(sent).toEqual(["I'm afraid I can't add files to requests here, so nothing was sent."]);
    });

    it("hands a yes to AttachFileToRequest with the file, the requester as actor and their display name", async () => {
      const { handlers, attachFileToRequest, sent, store, useCase, offer } = setupAttach();
      offer(ATTACH_PHOTO);

      expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);

      expect(attachFileToRequest.execute).toHaveBeenCalledTimes(1);
      expect(attachFileToRequest.execute).toHaveBeenCalledWith({
        issueKey: "SD-6", file: PHOTO, conversationId: convId, actorId: alice, senderName: "Alice", replyToMessageId: "msg-9",
      });
      expectNothingDispatched(handlers);
      expect(sent).toEqual([]);
      expect(store.has(convId, alice, now)).toBe(false);
    });

    it("cancels an attach offer on no without attaching", async () => {
      const { handlers, attachFileToRequest, sent, store, useCase, offer } = setupAttach();
      offer(ATTACH_PHOTO);

      expect(await useCase.execute({ ...input, text: "no" })).toBe(true);

      expect(sent).toEqual(["Understood, I won't."]);
      expect(attachFileToRequest.execute).not.toHaveBeenCalled();
      expectNothingDispatched(handlers);
      expect(store.has(convId, alice, now)).toBe(false);
      expect(await useCase.execute({ ...input, text: "yes" })).toBe(false);
      expect(attachFileToRequest.execute).not.toHaveBeenCalled();
    });

    it.each([
      [ATTACH_PHOTO, "I need a clear yes or no, so I haven't added this photo to **SD-6** yet. Shall I add it (yes or no)?"],
      [ATTACH_DOCUMENT, "I need a clear yes or no, so I haven't added this file (service-log.pdf) to **SD-6** yet. Shall I add it (yes or no)?"],
    ])("asks again after an acknowledgement for %j, keeps it, and a following yes attaches it", async (command, question) => {
      const { attachFileToRequest, wire, store, useCase, offer } = setupAttach();
      offer(command);

      expect(await useCase.execute({ ...input, text: "ok" })).toBe(true);
      expect(wire.sendPlainText).toHaveBeenCalledWith(convId, question, { replyToMessageId: "msg-9" });
      expect(attachFileToRequest.execute).not.toHaveBeenCalled();
      expect(store.has(convId, alice, now)).toBe(true);

      expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);
      expect(attachFileToRequest.execute).toHaveBeenCalledTimes(1);
    });

    it("ignores another member's yes to an attach offer", async () => {
      const { attachFileToRequest, store, useCase, offer } = setupAttach();
      offer(ATTACH_PHOTO);

      expect(await useCase.execute({ ...input, requesterId: bob, text: "yes" })).toBe(false);

      expect(attachFileToRequest.execute).not.toHaveBeenCalled();
      expect(store.has(convId, alice, now)).toBe(true);
    });

    it("tells a late yes after a dropped attach offer to post the file again", async () => {
      const { attachFileToRequest, sent, store, useCase, offer } = setupAttach();
      offer(ATTACH_PHOTO);
      store.drop(convId, alice, now);

      expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);

      expect(sent).toEqual([`${NOTHING}\nTo add it, post the file again.`]);
      expect(attachFileToRequest.execute).not.toHaveBeenCalled();
    });
  });

  it("does nothing after the conversation's offers are cleared", async () => {
    const { handlers, store, useCase, offer } = setup();
    offer(RESOLVE);
    store.clearConversation(convId);

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(false);

    expectNothingDispatched(handlers);
  });
});

describe("ConfirmOffer: buttons and choices", () => {
  const PART_MISSING: OfferCommand = { kind: "support", requestKind: "part", summary: "Paper tray", description: "Order a paper tray.", part: { part: "paper tray" } };
  const replyTo = (key: string): OfferCommand => ({ kind: "reply", issueKey: key, body: "Printer jams again." });
  const NEW_SUPPORT: OfferCommand = { kind: "support", requestKind: "fault", summary: "Printer jams", description: "Printer jams again." };
  const newOrExisting = (): OfferChoice[] => [addToChoice("SD-38", replyTo("SD-38")), addToChoice("SD-40", replyTo("SD-40")), raiseNewChoice(NEW_SUPPORT), cancelChoice()];
  const resolveChoices = (): OfferChoice[] => [keyChoice("SD-40", { kind: "resolve", issueKey: "SD-40" }), keyChoice("SD-41", { kind: "resolve", issueKey: "SD-41" }), cancelChoice()];

  function withOffer(command: OfferCommand, extra: Partial<PendingOffer> = {}) {
    const ctx = setup();
    ctx.store.put({
      command, conversationId: convId, requesterId: alice, createdAt: now, expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      id: "offer-1234", messageId: "msg-q", ...extra,
    });
    return ctx;
  }
  const click = (index: number, offerId = "offer-1234") => ({ conversationId: convId, requesterId: alice, requesterName: "Alice", offerId, index });

  it("runs a yes-or-no offer for [Yes] like a text yes, with all checks of the use case, and marks the message answered", async () => {
    const { store, handlers, useCase } = withOffer(REPLY);
    expect(await useCase.choose(click(0))).toBe(true);
    expect(handlers.replyToServiceDesk.execute).toHaveBeenCalledWith({
      reference: "SD-6", body: "It still drops after the reset.", conversationId: convId, actorId: alice, replyToMessageId: undefined,
    });
    expect(store.has(convId, alice, now)).toBe(false);
    expect(store.prompt(convId, "msg-q")?.answered).toBe(true);
  });

  it("declines a yes-or-no offer for [No] like a text no", async () => {
    const { store, handlers, sent, useCase } = withOffer(SUPPORT);
    expect(await useCase.choose(click(1))).toBe(true);
    expectNothingDispatched(handlers);
    expect(sent).toEqual(["Understood, I won't."]);
    expect(store.has(convId, alice, now)).toBe(false);
  });

  it("does nothing for a button of another offer, an index beyond the options, another member or no offer", async () => {
    for (const [label, input] of [
      ["another offer", click(0, "offer-9999")],
      ["no such option", click(2)],
      ["another member", { ...click(0), requesterId: bob }],
    ] as const) {
      const { store, handlers, sent, useCase } = withOffer(SUPPORT);
      expect(await useCase.choose(input), label).toBe(false);
      expectNothingDispatched(handlers);
      expect(sent).toEqual([]);
      expect(store.has(convId, alice, now)).toBe(true);
      expect(store.prompt(convId, "msg-q")?.answered).toBe(false);
    }
    const { handlers, useCase } = setup();
    expect(await useCase.choose(click(0))).toBe(false);
    expectNothingDispatched(handlers);
  });

  it("does nothing for an expired offer", async () => {
    const { handlers, useCase } = withOffer(SUPPORT, { expiresAt: now });
    expect(await useCase.choose(click(0))).toBe(false);
    expectNothingDispatched(handlers);
  });

  it("runs the chosen target of a choice offer", async () => {
    const { handlers, store, useCase } = withOffer(NEW_SUPPORT, { choices: newOrExisting() });
    expect(await useCase.choose(click(1))).toBe(true);
    expect(handlers.replyToServiceDesk.execute).toHaveBeenCalledWith(expect.objectContaining({ reference: "SD-40", body: "Printer jams again." }));
    expect(handlers.raiseSupportRequest.execute).not.toHaveBeenCalled();
    expect(store.prompt(convId, "msg-q")?.answered).toBe(true);
  });

  it("raises the new request for [Raise new request] with the requester's name", async () => {
    const { handlers, useCase } = withOffer(NEW_SUPPORT, { choices: newOrExisting() });
    expect(await useCase.choose(click(2))).toBe(true);
    expect(handlers.raiseSupportRequest.execute).toHaveBeenCalledWith(expect.objectContaining({
      summary: "Printer jams", requesterId: alice, requesterName: "Alice", requestKind: "fault",
    }));
    expect(handlers.replyToServiceDesk.execute).not.toHaveBeenCalled();
  });

  it("declines a choice offer for [Cancel]", async () => {
    const { handlers, sent, useCase } = withOffer(NEW_SUPPORT, { choices: newOrExisting() });
    expect(await useCase.choose(click(3))).toBe(true);
    expectNothingDispatched(handlers);
    expect(sent).toEqual(["Understood, I won't."]);
  });

  it("asks for the missing free-text essentials when a chosen new part order is incomplete, and keeps it for amending", async () => {
    const choices = [addToChoice("SD-38", replyTo("SD-38")), raiseNewChoice(PART_MISSING), cancelChoice()];
    const { handlers, sent, store, useCase } = withOffer(PART_MISSING, { choices });
    expect(await useCase.choose(click(1))).toBe(true);
    expectNothingDispatched(handlers);
    expect(sent).toEqual(["To order it I need the item the part is for (for example a serial number). What is it?"]);
    const kept = store.find(convId, alice, now);
    expect(kept?.command).toEqual(PART_MISSING);
    expect(kept?.choices).toBeUndefined();
    expect(kept?.id).toBeUndefined();
  });

  describe("text answers to a choice", () => {
    it.each<[string, string]>([["SD-41", "SD-41"], ["sd-40", "SD-40"], ["2", "SD-41"], ["1.", "SD-40"]])("runs the request picked by %j", async (text, key) => {
      const { handlers, store, useCase } = withOffer({ kind: "resolve", issueKey: "SD-40" }, { choices: resolveChoices() });
      expect(await useCase.execute({ ...input, text })).toBe(true);
      expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledWith(expect.objectContaining({ issueKey: key, replyToMessageId: "msg-9" }));
      expect(store.has(convId, alice, now)).toBe(false);
      expect(store.prompt(convId, "msg-q")?.answered).toBe(true);
    });

    it.each(["new", "New request", "3"])("raises the new request for %j", async (text) => {
      const { handlers, useCase } = withOffer(NEW_SUPPORT, { choices: newOrExisting() });
      expect(await useCase.execute({ ...input, text })).toBe(true);
      expect(handlers.raiseSupportRequest.execute).toHaveBeenCalledOnce();
    });

    it.each(["cancel", "no", "4"])("declines for %j", async (text) => {
      const { handlers, sent, useCase } = withOffer(NEW_SUPPORT, { choices: newOrExisting() });
      expect(await useCase.execute({ ...input, text })).toBe(true);
      expectNothingDispatched(handlers);
      expect(sent).toEqual(["Understood, I won't."]);
    });

    it.each(["yes", "ok", "sure"])("asks again for %j and keeps the offer", async (text) => {
      const { handlers, sent, store, useCase } = withOffer(NEW_SUPPORT, { choices: newOrExisting() });
      expect(await useCase.execute({ ...input, text })).toBe(true);
      expectNothingDispatched(handlers);
      expect(sent).toEqual(["I need you to pick one, so I haven't done anything yet. Which one (SD-38, SD-40, new or cancel)?"]);
      expect(store.find(convId, alice, now)?.id).toBe("offer-1234");
      expect(store.prompt(convId, "msg-q")?.answered).toBe(false);
    });

    it.each(["SD-99", "5", "the printer is on floor 2"])("is not an answer: %j", async (text) => {
      const { handlers, sent, store, useCase } = withOffer(NEW_SUPPORT, { choices: newOrExisting() });
      expect(await useCase.execute({ ...input, text })).toBe(false);
      expectNothingDispatched(handlers);
      expect(sent).toEqual([]);
      expect(store.has(convId, alice, now)).toBe(true);
    });
  });

  it("marks the button message answered for a text yes or no to a yes-or-no offer, but not for an acknowledgement", async () => {
    const ack = withOffer(SUPPORT);
    expect(await ack.useCase.execute({ ...input, text: "ok" })).toBe(true);
    expect(ack.store.prompt(convId, "msg-q")?.answered).toBe(false);
    expect(ack.store.find(convId, alice, now)?.id).toBe("offer-1234");

    for (const text of ["yes", "no"]) {
      const { store, useCase } = withOffer(SUPPORT);
      expect(await useCase.execute({ ...input, text })).toBe(true);
      expect(store.prompt(convId, "msg-q")?.answered).toBe(true);
    }
  });
});

describe("ConfirmOffer: part-order essentials with buttons", () => {
  type PartOrder = Extract<OfferCommand, { kind: "support" }>;
  const LOCATIONS = ["Depot north", "Depot south"];
  const order = (part: Record<string, string>): PartOrder => ({ kind: "support", requestKind: "part", summary: "Air filter", description: "Truck 12 needs an air filter.", part });
  const NEEDS_QUANTITY = order({ asset: "truck 12", part: "air filter" });
  const NEEDS_LOCATION = order({ asset: "truck 12", part: "air filter", quantity: "2" });

  /** Alice's button question for the draft's next essential, as the use cases store it. */
  function asked(draft: PartOrder, locations: string[] = LOCATIONS) {
    const ctx = setup({ deliveryLocations: locations });
    const step = partOrderStep(draft, undefined, locations);
    ctx.store.put({
      command: draft, conversationId: convId, requesterId: alice, createdAt: now, expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      id: "offer-1234", messageId: "msg-q", choices: step.choices!, fillsPart: step.fillsPart!,
    });
    return ctx;
  }
  const click = (index: number) => ({ conversationId: convId, requesterId: alice, requesterName: "Alice", offerId: "offer-1234", index });

  it("fills the quantity from a click, never runs the order, and asks for the location with buttons", async () => {
    const { handlers, sent, store, wire, useCase } = asked(NEEDS_QUANTITY);
    expect(await useCase.choose(click(1))).toBe(true);
    expectNothingDispatched(handlers);
    expect(sent).toEqual(["Where shall I deliver it?"]);
    expect(wire.sendCompositePrompt.mock.calls[0]![2].map((b) => b.label)).toEqual(["Depot north", "Depot south", "Other"]);
    expect(store.prompt(convId, "msg-q")?.answered).toBe(true);
    expect(store.find(convId, alice, now)).toMatchObject({ command: { part: { quantity: "2" } }, fillsPart: "deliverTo", messageId: "bot-msg-1" });
  });

  it("offers the complete order with [Yes] [No] after the last essential is clicked, without raising it", async () => {
    const { handlers, sent, store, wire, useCase } = asked(NEEDS_LOCATION);
    expect(await useCase.choose(click(0))).toBe(true);
    expectNothingDispatched(handlers);
    expect(sent[0]).toContain("Shall I order this part?");
    expect(sent[0]).toContain("> Deliver to: Depot north");
    expect(sent[0]).not.toContain("(yes or no)");
    expect(wire.sendCompositePrompt.mock.calls[0]![2].map((b) => b.label)).toEqual(["Yes", "No"]);
    const offer = store.find(convId, alice, now)!;
    expect(offer.command).toEqual({ ...NEEDS_LOCATION, part: { ...NEEDS_LOCATION.part, deliverTo: "Depot north" } });
    expect(offer.choices).toBeUndefined();
    expect(offer.fillsPart).toBeUndefined();

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);
    expect(handlers.raiseSupportRequest.execute).toHaveBeenCalledWith(expect.objectContaining({
      requestKind: "part", part: { asset: "truck 12", part: "air filter", quantity: "2", deliverTo: "Depot north" },
    }));
  });

  it.each<[string, number]>([["the quantity", 3], ["the delivery location", 2]])("asks for %s in text after [Other]", async (_label, index) => {
    const draft = index === 3 ? NEEDS_QUANTITY : NEEDS_LOCATION;
    const { handlers, sent, store, wire, useCase } = asked(draft);
    expect(await useCase.choose(click(index))).toBe(true);
    expectNothingDispatched(handlers);
    expect(sent).toEqual([index === 3 ? "To order it I need the quantity. What is it?" : "To order it I need the delivery location. What is it?"]);
    expect(wire.sendCompositePrompt).not.toHaveBeenCalled();
    const kept = store.find(convId, alice, now)!;
    expect(kept.command).toEqual(draft);
    expect(kept.id).toBeUndefined();
    expect(kept.fillsPart).toBeUndefined();
  });

  it.each<[string, string]>([["1", "1"], ["2", "2"], ["5", "5"], ["3", "3"], ["12", "12"], ["3 please", "3"], ["007", "7"]])(
    "fills the quantity %j typed as text", async (text, quantity) => {
      const { handlers, store, useCase } = asked(NEEDS_QUANTITY);
      expect(await useCase.execute({ ...input, text })).toBe(true);
      expectNothingDispatched(handlers);
      expect(store.find(convId, alice, now)?.command).toEqual({ ...NEEDS_QUANTITY, part: { ...NEEDS_QUANTITY.part, quantity } });
      expect(store.prompt(convId, "msg-q")?.answered).toBe(true);
    },
  );

  it.each(["Depot south", "depot south.", "DEPOT SOUTH please"])("takes the typed location %j like a click", async (text) => {
    const { store, useCase } = asked(NEEDS_LOCATION);
    expect(await useCase.execute({ ...input, text })).toBe(true);
    expect(store.find(convId, alice, now)?.command).toMatchObject({ part: { deliverTo: "Depot south" } });
  });

  it("asks for the value in text for a typed other", async () => {
    const { sent, useCase } = asked(NEEDS_LOCATION);
    expect(await useCase.execute({ ...input, text: "other" })).toBe(true);
    expect(sent).toEqual(["To order it I need the delivery location. What is it?"]);
  });

  it.each(["0", "2", "actually three", "to workshop 3", "lunch at noon?"])(
    "leaves %j at the location question to the part-order completion, keeping the question", async (text) => {
      const { handlers, sent, store, useCase } = asked(NEEDS_LOCATION);
      expect(await useCase.execute({ ...input, text })).toBe(false);
      expectNothingDispatched(handlers);
      expect(sent).toEqual([]);
      expect(store.find(convId, alice, now)?.id).toBe("offer-1234");
    },
  );

  it("does not take a zero as a quantity", async () => {
    const { sent, useCase } = asked(NEEDS_QUANTITY);
    expect(await useCase.execute({ ...input, text: "0" })).toBe(false);
    expect(sent).toEqual([]);
  });

  it.each(["yes", "ok"])("says what is still missing for %j and keeps the question open", async (text) => {
    const { handlers, sent, store, useCase } = asked(NEEDS_QUANTITY);
    expect(await useCase.execute({ ...input, text })).toBe(true);
    expectNothingDispatched(handlers);
    expect(sent).toEqual(["I haven't ordered anything yet: I still need the quantity and the delivery location."]);
    expect(store.find(convId, alice, now)?.id).toBe("offer-1234");
    expect(store.prompt(convId, "msg-q")?.answered).toBe(false);
  });

  it("declines the order for a typed no", async () => {
    const { handlers, sent, store, useCase } = asked(NEEDS_QUANTITY);
    expect(await useCase.execute({ ...input, text: "no" })).toBe(true);
    expectNothingDispatched(handlers);
    expect(sent).toEqual(["Understood, I won't."]);
    expect(store.has(convId, alice, now)).toBe(false);
    expect(store.prompt(convId, "msg-q")?.answered).toBe(true);
  });

  it("asks for the delivery location in text after a quantity click when no locations are configured", async () => {
    const { sent, wire, useCase } = asked(NEEDS_QUANTITY, []);
    expect(await useCase.choose(click(2))).toBe(true);
    expect(sent).toEqual(["To order it I need the delivery location. What is it?"]);
    expect(wire.sendCompositePrompt).not.toHaveBeenCalled();
  });
});
