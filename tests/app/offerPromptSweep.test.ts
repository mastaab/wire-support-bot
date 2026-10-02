import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFER_PROMPT_SWEEP_MS, startOfferPromptSweep } from "../../src/app/offerPromptSweep";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import type { WireOutboundPort } from "../../src/application/ports/WireOutboundPort";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
const convId = { id: "conv-1", domain: "example.com" };
const alice = { id: "user-1", domain: "example.com" };

describe("startOfferPromptSweep", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("closes an expired question once a minute by the injected clock, and stops on shutdown", async () => {
    const created = new Date("2026-10-02T10:00:00Z");
    const offers = new InMemoryPendingOfferStore();
    offers.put({
      command: { kind: "resolve", issueKey: "SD-6" }, conversationId: convId, requesterId: alice,
      createdAt: created, expiresAt: new Date(created.getTime() + 90_000), id: "offer-1", messageId: "msg-1", question: "Shall I resolve **SD-6**?",
    });
    const closeButtonPrompt = vi.fn().mockResolvedValue(undefined);
    let now = created;
    const sweep = startOfferPromptSweep({ offers, wireOutbound: { closeButtonPrompt } as unknown as WireOutboundPort, logger }, logger, () => now);
    expect(OFFER_PROMPT_SWEEP_MS).toBe(60_000);

    now = new Date(created.getTime() + 60_000);
    await vi.advanceTimersByTimeAsync(OFFER_PROMPT_SWEEP_MS);
    expect(closeButtonPrompt).not.toHaveBeenCalled();

    now = new Date(created.getTime() + 120_000);
    await vi.advanceTimersByTimeAsync(OFFER_PROMPT_SWEEP_MS);
    expect(closeButtonPrompt).toHaveBeenCalledWith(convId, "msg-1", "Shall I resolve **SD-6**?\n\nThis question has expired.");

    await sweep.stop();
    await vi.advanceTimersByTimeAsync(5 * OFFER_PROMPT_SWEEP_MS);
    expect(closeButtonPrompt).toHaveBeenCalledOnce();
  });
});
