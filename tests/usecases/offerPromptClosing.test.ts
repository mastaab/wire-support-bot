import { describe, it, expect, vi } from "vitest";
import {
  EXPIRED_LINE, NOT_AN_ANSWER_LINE, REPLACED_LINE, answeredLine, closeEndedOfferPrompts, closeOfferPrompt, closedPromptText, sweepEndedOfferPrompts,
} from "../../src/application/services/offerPromptClosing";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import type { PendingOffer } from "../../src/application/ports/PendingOfferPort";
import type { WireOutboundPort } from "../../src/application/ports/WireOutboundPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const convA: QualifiedId = { id: "conv-1", domain: "example.com" };
const convB: QualifiedId = { id: "conv-2", domain: "example.com" };
const alice: QualifiedId = { id: "user-1", domain: "example.com" };
const bob: QualifiedId = { id: "user-2", domain: "example.com" };

const created = new Date("2026-10-02T10:00:00Z");
const expires = new Date("2026-10-02T10:10:00Z");
const QUESTION = "Shall I resolve **SD-6**?";

function offer(overrides: Partial<PendingOffer> = {}): PendingOffer {
  return {
    command: { kind: "resolve", issueKey: "SD-6" }, conversationId: convA, requesterId: alice, createdAt: created, expiresAt: expires,
    id: "offer-1", messageId: "msg-1", question: QUESTION, ...overrides,
  };
}

function setup() {
  const offers = new InMemoryPendingOfferStore();
  const closeButtonPrompt = vi.fn().mockResolvedValue(undefined);
  const wireOutbound = { closeButtonPrompt } as unknown as WireOutboundPort;
  const logger = { child: vi.fn().mockReturnThis(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { offers, closeButtonPrompt, deps: { offers, wireOutbound, logger }, logger };
}

describe("closing lines", () => {
  it("names who answered and what, or just the answer without a name", () => {
    expect(answeredLine("Alice", "Add to SD-38")).toBe("Answered by Alice: Add to SD-38");
    expect(answeredLine(undefined, "No")).toBe("Answered: No");
    expect(answeredLine("", "No")).toBe("Answered: No");
  });

  it("puts the closing line under the question, or alone without one", () => {
    expect(closedPromptText("Shall I?\n", EXPIRED_LINE)).toBe("Shall I?\n\nThis question has expired.");
    expect(closedPromptText(undefined, REPLACED_LINE)).toBe("This question was replaced by a newer one.");
    expect(NOT_AN_ANSWER_LINE).toBe("Closed, as the next message was not an answer.");
  });
});

describe("closeOfferPrompt", () => {
  it("edits the button message once into its question and the closing line", async () => {
    const { offers, closeButtonPrompt, deps } = setup();
    offers.put(offer());
    expect(await closeOfferPrompt(deps, convA, "msg-1", answeredLine("Alice", "Yes"))).toBe(true);
    expect(await closeOfferPrompt(deps, convA, "msg-1", NOT_AN_ANSWER_LINE)).toBe(false);
    expect(closeButtonPrompt).toHaveBeenCalledOnce();
    expect(closeButtonPrompt).toHaveBeenCalledWith(convA, "msg-1", `${QUESTION}\n\nAnswered by Alice: Yes`);
  });

  it("does nothing for an unknown message, another conversation or no message", async () => {
    const { offers, closeButtonPrompt, deps } = setup();
    offers.put(offer());
    expect(await closeOfferPrompt(deps, convA, "unknown", EXPIRED_LINE)).toBe(false);
    expect(await closeOfferPrompt(deps, convB, "msg-1", EXPIRED_LINE)).toBe(false);
    expect(await closeOfferPrompt(deps, convA, undefined, EXPIRED_LINE)).toBe(false);
    expect(closeButtonPrompt).not.toHaveBeenCalled();
  });

  it("logs a failed edit by error name only, changes nothing else and does not retry", async () => {
    const { offers, closeButtonPrompt, deps, logger } = setup();
    closeButtonPrompt.mockRejectedValueOnce(new RangeError("secret detail"));
    offers.put(offer());
    expect(await closeOfferPrompt(deps, convA, "msg-1", answeredLine("Alice", "No"))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith("Closing a button question failed", { err: "RangeError" });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret detail");
    expect(offers.find(convA, alice, created)?.id).toBe("offer-1");
    expect(await closeOfferPrompt(deps, convA, "msg-1", answeredLine("Alice", "No"))).toBe(false);
    expect(closeButtonPrompt).toHaveBeenCalledOnce();
  });
});

describe("closing ended questions", () => {
  it("closes the questions the store noticed as expired or replaced, each once", async () => {
    const { offers, closeButtonPrompt, deps } = setup();
    offers.put(offer());
    offers.put(offer({ id: "offer-2", messageId: "msg-2", question: "Shall I add it?" }));
    offers.put(offer({ id: "offer-3", messageId: "msg-3", requesterId: bob, question: "Shall I raise it?" }));
    offers.find(convA, bob, expires);

    expect(await closeEndedOfferPrompts(deps)).toBe(3);
    expect(closeButtonPrompt.mock.calls).toEqual([
      [convA, "msg-1", `${QUESTION}\n\nThis question was replaced by a newer one.`],
      [convA, "msg-2", "Shall I add it?\n\nThis question has expired."],
      [convA, "msg-3", "Shall I raise it?\n\nThis question has expired."],
    ]);
    expect(await closeEndedOfferPrompts(deps)).toBe(0);
  });

  it("closes expired questions in a quiet conversation on a sweep, by the injected time", async () => {
    const { offers, closeButtonPrompt, deps } = setup();
    offers.put(offer());
    offers.put(offer({ id: "offer-2", messageId: "msg-2", conversationId: convB, question: "Shall I add it?", expiresAt: new Date(expires.getTime() + 60_000) }));

    expect(await sweepEndedOfferPrompts(deps, new Date(expires.getTime() - 1))).toBe(0);
    expect(await sweepEndedOfferPrompts(deps, expires)).toBe(1);
    expect(closeButtonPrompt).toHaveBeenCalledWith(convA, "msg-1", `${QUESTION}\n\nThis question has expired.`);
    expect(await sweepEndedOfferPrompts(deps, new Date(expires.getTime() + 60_000))).toBe(1);
    expect(closeButtonPrompt).toHaveBeenLastCalledWith(convB, "msg-2", "Shall I add it?\n\nThis question has expired.");
    expect(await sweepEndedOfferPrompts(deps, new Date(expires.getTime() + 120_000))).toBe(0);
    expect(closeButtonPrompt).toHaveBeenCalledTimes(2);
  });

  it("does not close an answered question when its kept offer expires", async () => {
    const { offers, closeButtonPrompt, deps } = setup();
    const kept = offer();
    offers.put(kept);
    await closeOfferPrompt(deps, convA, "msg-1", answeredLine("Alice", "Yes"));
    expect(await sweepEndedOfferPrompts(deps, expires)).toBe(0);
    expect(closeButtonPrompt).toHaveBeenCalledOnce();
  });

  it("keeps closing the others when one edit fails", async () => {
    const { offers, closeButtonPrompt, deps, logger } = setup();
    closeButtonPrompt.mockRejectedValueOnce(new TypeError("offline"));
    offers.put(offer());
    offers.put(offer({ id: "offer-2", messageId: "msg-2", requesterId: bob }));
    expect(await sweepEndedOfferPrompts(deps, expires)).toBe(1);
    expect(closeButtonPrompt).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith("Closing a button question failed", { err: "TypeError" });
  });
});
