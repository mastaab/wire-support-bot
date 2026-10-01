import { describe, it, expect } from "vitest";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import { RECENT_DROP_MS } from "../../src/application/services/offers";
import type { PendingOffer, OfferCommand } from "../../src/application/services/offers";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const convA: QualifiedId = { id: "conv-1", domain: "example.com" };
const convB: QualifiedId = { id: "conv-2", domain: "example.com" };
const alice: QualifiedId = { id: "user-1", domain: "example.com" };
const bob: QualifiedId = { id: "user-2", domain: "example.com" };

const created = new Date("2026-09-25T10:00:00Z");
const expires = new Date("2026-09-25T10:10:00Z");

function offer(overrides: Partial<PendingOffer> = {}, command: OfferCommand = { kind: "resolve", issueKey: "SD-1" }): PendingOffer {
  return { command, conversationId: convA, requesterId: alice, createdAt: created, expiresAt: expires, ...overrides };
}

describe("InMemoryPendingOfferStore", () => {
  it("takes an unexpired offer once", () => {
    const store = new InMemoryPendingOfferStore();
    const o = offer({ expiresAt: new Date(Date.now() + 60_000) });
    store.put(o);

    expect(store.has(convA, alice)).toBe(true);
    expect(store.take(convA, alice)).toBe(o);
    expect(store.has(convA, alice)).toBe(false);
    expect(store.take(convA, alice)).toBeNull();
  });

  it("treats expiresAt as the exclusive boundary", () => {
    const store = new InMemoryPendingOfferStore();
    const o = offer({ expiresAt: new Date(Date.now() + 60_000) });
    store.put(o);
    const justBefore = new Date(o.expiresAt.getTime() - 1);

    expect(store.has(convA, alice, justBefore)).toBe(true);
    expect(store.has(convA, alice, o.expiresAt)).toBe(false);
    expect(store.take(convA, alice, o.expiresAt)).toBeNull();
    // The expired offer was removed, so even an earlier clock no longer finds it.
    expect(store.take(convA, alice, justBefore)).toBeNull();
  });

  it("has does not remove the offer", () => {
    const store = new InMemoryPendingOfferStore();
    store.put(offer({ expiresAt: new Date(Date.now() + 60_000) }));

    expect(store.has(convA, alice)).toBe(true);
    expect(store.has(convA, alice)).toBe(true);
    expect(store.take(convA, alice)).not.toBeNull();
  });

  it("replaces the requester's offer in the conversation", () => {
    const store = new InMemoryPendingOfferStore();
    const later = new Date(Date.now() + 60_000);
    store.put(offer({ expiresAt: later }));
    const replacement = offer({ expiresAt: later }, { kind: "reply", issueKey: "SD-2", body: "It works again." });
    store.put(replacement);

    expect(store.take(convA, alice)).toBe(replacement);
    expect(store.take(convA, alice)).toBeNull();
  });

  it("keeps offers per requester and per conversation", () => {
    const store = new InMemoryPendingOfferStore();
    const later = new Date(Date.now() + 60_000);
    const aliceA = offer({ expiresAt: later });
    const bobA = offer({ requesterId: bob, expiresAt: later });
    const aliceB = offer({ conversationId: convB, expiresAt: later });
    store.put(aliceA);
    store.put(bobA);
    store.put(aliceB);

    expect(store.take(convA, bob)).toBe(bobA);
    expect(store.take(convA, alice)).toBe(aliceA);
    expect(store.take(convB, alice)).toBe(aliceB);
  });

  it("treats the same user ID in another domain as a different requester", () => {
    const store = new InMemoryPendingOfferStore();
    store.put(offer({ expiresAt: new Date(Date.now() + 60_000) }));
    const impostor: QualifiedId = { id: alice.id, domain: "other.example" };

    expect(store.has(convA, impostor)).toBe(false);
    expect(store.take(convA, impostor)).toBeNull();
    expect(store.has(convA, alice)).toBe(true);
  });

  it("treats the same conversation ID in another domain as a different conversation", () => {
    const store = new InMemoryPendingOfferStore();
    store.put(offer({ expiresAt: new Date(Date.now() + 60_000) }));

    expect(store.take({ id: convA.id, domain: "other.example" }, alice)).toBeNull();
    expect(store.has(convA, alice)).toBe(true);
  });

  it("clears only the given conversation", () => {
    const store = new InMemoryPendingOfferStore();
    const later = new Date(Date.now() + 60_000);
    store.put(offer({ expiresAt: later }));
    store.put(offer({ requesterId: bob, expiresAt: later }));
    store.put(offer({ conversationId: convB, expiresAt: later }));

    store.clearConversation(convA);

    expect(store.has(convA, alice)).toBe(false);
    expect(store.has(convA, bob)).toBe(false);
    expect(store.has(convB, alice)).toBe(true);
  });

  it("purges expired offers when a new one is stored", () => {
    const store = new InMemoryPendingOfferStore();
    const stale = offer({ requesterId: bob, expiresAt: expires });
    store.put(stale);
    // Stored after the stale one expired, by the caller's clock.
    const later = new Date(expires.getTime() + 1000);
    store.put(offer({ createdAt: later, expiresAt: new Date(later.getTime() + 60_000) }));

    // With a clock before its expiry the stale offer would be live, unless it was purged.
    expect(store.has(convA, bob, new Date(stale.expiresAt.getTime() - 60_000))).toBe(false);
  });
});

describe("InMemoryPendingOfferStore: dropped offers", () => {
  const SUPPORT: OfferCommand = { kind: "support", requestKind: "fault", summary: "VPN drops", description: "My VPN drops." };
  const REPLY: OfferCommand = { kind: "reply", issueKey: "SD-6", body: "It still drops." };
  const base = (): Date => new Date(Date.now() + 1000);
  const live = (at: Date, command: OfferCommand = SUPPORT, overrides: Partial<PendingOffer> = {}): PendingOffer =>
    offer({ createdAt: at, expiresAt: new Date(at.getTime() + 10 * 60_000), ...overrides }, command);

  it("drops a live offer, returns its command and remembers it without removing the memory", () => {
    const store = new InMemoryPendingOfferStore();
    const t = base();
    store.put(live(t));

    expect(store.drop(convA, alice, t)).toEqual(SUPPORT);
    expect(store.has(convA, alice, t)).toBe(false);
    expect(store.take(convA, alice, t)).toBeNull();
    expect(store.recentlyDropped(convA, alice, t)).toEqual(SUPPORT);
    expect(store.recentlyDropped(convA, alice, t)).toEqual(SUPPORT);
  });

  it("returns null from drop when there is no offer", () => {
    const store = new InMemoryPendingOfferStore();
    expect(store.drop(convA, alice, base())).toBeNull();
    expect(store.recentlyDropped(convA, alice, base())).toBeNull();
  });

  it("remembers a drop for RECENT_DROP_MS from the drop, exclusive", () => {
    const store = new InMemoryPendingOfferStore();
    const t = base();
    store.put(live(t));
    const droppedAt = new Date(t.getTime() + 60_000);
    store.drop(convA, alice, droppedAt);

    expect(store.recentlyDropped(convA, alice, new Date(droppedAt.getTime() + RECENT_DROP_MS - 1))).toEqual(SUPPORT);
    expect(store.recentlyDropped(convA, alice, new Date(droppedAt.getTime() + RECENT_DROP_MS))).toBeNull();
    // A stale memory is forgotten, so an earlier clock no longer finds it.
    expect(store.recentlyDropped(convA, alice, droppedAt)).toBeNull();
  });

  it("does not remember an offer consumed by take", () => {
    const store = new InMemoryPendingOfferStore();
    const t = base();
    store.put(live(t));

    expect(store.take(convA, alice, t)).not.toBeNull();
    expect(store.recentlyDropped(convA, alice, t)).toBeNull();
  });

  it.each([
    ["has", (store: InMemoryPendingOfferStore, at: Date) => expect(store.has(convA, alice, at)).toBe(false)],
    ["take", (store: InMemoryPendingOfferStore, at: Date) => expect(store.take(convA, alice, at)).toBeNull()],
    ["drop", (store: InMemoryPendingOfferStore, at: Date) => expect(store.drop(convA, alice, at)).toBeNull()],
    ["recentlyDropped", (store: InMemoryPendingOfferStore, at: Date) => expect(store.recentlyDropped(convA, alice, at)).toEqual(SUPPORT)],
  ] as const)("remembers an expired offer as of its expiry when noticed by %s", (_name, notice) => {
    const store = new InMemoryPendingOfferStore();
    const t = base();
    const o = live(t);
    store.put(o);

    notice(store, new Date(o.expiresAt.getTime() + 60_000));

    expect(store.recentlyDropped(convA, alice, new Date(o.expiresAt.getTime() + RECENT_DROP_MS - 1))).toEqual(SUPPORT);
    expect(store.recentlyDropped(convA, alice, new Date(o.expiresAt.getTime() + RECENT_DROP_MS))).toBeNull();
  });

  it("remembers an expired offer found by purging, as of its expiry", () => {
    const store = new InMemoryPendingOfferStore();
    const expiresAt = new Date(Date.now() - 60_000);
    store.put(offer({ requesterId: bob, createdAt: new Date(expiresAt.getTime() - 60_000), expiresAt }, REPLY));
    store.put(live(base()));

    expect(store.recentlyDropped(convA, bob, new Date(expiresAt.getTime() + RECENT_DROP_MS - 1))).toEqual(REPLY);
  });

  it("forgets a remembered offer when a new one is put for that requester", () => {
    const store = new InMemoryPendingOfferStore();
    const t = base();
    store.put(live(t));
    store.drop(convA, alice, t);

    store.put(live(t, REPLY));

    expect(store.recentlyDropped(convA, alice, t)).toBeNull();
    expect(store.drop(convA, alice, t)).toEqual(REPLY);
    expect(store.recentlyDropped(convA, alice, t)).toEqual(REPLY);
  });

  it("forgets only that requester's remembered offer on request", () => {
    const store = new InMemoryPendingOfferStore();
    const t = base();
    store.put(live(t));
    store.put({ ...live(t), requesterId: bob });
    store.drop(convA, alice, t);
    store.drop(convA, bob, t);

    store.forgetDropped(convA, alice);

    expect(store.recentlyDropped(convA, alice, t)).toBeNull();
    expect(store.recentlyDropped(convA, bob, t)).toEqual(SUPPORT);
  });

  it("keeps another requester's memory when an offer is put", () => {
    const store = new InMemoryPendingOfferStore();
    const t = base();
    store.put(live(t, SUPPORT, { requesterId: bob }));
    store.drop(convA, bob, t);

    store.put(live(t));

    expect(store.recentlyDropped(convA, bob, t)).toEqual(SUPPORT);
  });

  it("forgets remembered offers of the conversation when it is cleared", () => {
    const store = new InMemoryPendingOfferStore();
    const t = base();
    store.put(live(t));
    store.put(live(t, SUPPORT, { conversationId: convB }));
    store.drop(convA, alice, t);
    store.drop(convB, alice, t);

    store.clearConversation(convA);

    expect(store.recentlyDropped(convA, alice, t)).toBeNull();
    expect(store.recentlyDropped(convB, alice, t)).toEqual(SUPPORT);
  });

  it("keeps memories per qualified requester and conversation", () => {
    const store = new InMemoryPendingOfferStore();
    const t = base();
    store.put(live(t));
    store.drop(convA, alice, t);

    expect(store.recentlyDropped(convA, bob, t)).toBeNull();
    expect(store.recentlyDropped(convA, { id: alice.id, domain: "other.example" }, t)).toBeNull();
    expect(store.recentlyDropped({ id: convA.id, domain: "other.example" }, alice, t)).toBeNull();
    expect(store.recentlyDropped(convB, alice, t)).toBeNull();
    expect(store.recentlyDropped(convA, alice, t)).toEqual(SUPPORT);
  });

  it("keeps no file reference for an attach offer once it is dropped or expired", () => {
    const attach: OfferCommand = {
      kind: "attach", issueKey: "SD-1",
      file: { ref: { transport: "wire", data: { otrKey: "secret-key" } }, fileKind: "photo", name: "jam.jpg", mimeType: "image/jpeg", sizeInBytes: 10 },
    };
    const store = new InMemoryPendingOfferStore();
    store.put(offer({}, attach));
    expect(store.drop(convA, alice, created)).toEqual(attach);
    const dropped = store.recentlyDropped(convA, alice, created);
    expect(dropped).toMatchObject({ kind: "attach", issueKey: "SD-1", file: { name: "jam.jpg", ref: { transport: "wire", data: null } } });
    expect(JSON.stringify(dropped)).not.toContain("secret-key");

    store.put(offer({ requesterId: bob }, attach));
    const later = new Date(expires.getTime() + 1);
    expect(store.has(convA, bob, later)).toBe(false);
    expect(JSON.stringify(store.recentlyDropped(convA, bob, later))).not.toContain("secret-key");
  });

  it("peeks at a live offer without removing it", () => {
    const store = new InMemoryPendingOfferStore();
    store.put(offer());
    expect(store.peek(convA, alice, created)).toEqual({ kind: "resolve", issueKey: "SD-1" });
    expect(store.has(convA, alice, created)).toBe(true);
    expect(store.peek(convA, bob, created)).toBeNull();
    expect(store.peek(convA, alice, new Date(expires.getTime() + 1))).toBeNull();
  });
});

describe("InMemoryPendingOfferStore: button messages", () => {
  const live = new Date("2026-09-25T10:05:00Z");

  it("finds the requester's live offer without removing it", () => {
    const store = new InMemoryPendingOfferStore();
    const o = offer({ id: "offer-1234", messageId: "msg-q" });
    store.put(o);
    expect(store.find(convA, alice, live)).toBe(o);
    expect(store.find(convA, alice, live)).toBe(o);
    expect(store.find(convA, bob, live)).toBeNull();
    expect(store.find(convA, alice, expires)).toBeNull();
  });

  it("remembers who was asked by a button message, also after the offer was taken, dropped or expired", () => {
    const store = new InMemoryPendingOfferStore();
    store.put(offer({ id: "offer-1", messageId: "msg-1" }));
    expect(store.prompt(convA, "msg-1")).toEqual({ offerId: "offer-1", requesterId: alice, answered: false });
    store.take(convA, alice, live);
    expect(store.prompt(convA, "msg-1")).toEqual({ offerId: "offer-1", requesterId: alice, answered: false });

    store.put(offer({ id: "offer-2", messageId: "msg-2", requesterId: bob }));
    store.drop(convA, bob, live);
    expect(store.prompt(convA, "msg-2")?.requesterId).toEqual(bob);
    expect(store.prompt(convB, "msg-2")).toBeNull();
    expect(store.prompt(convA, "msg-3")).toBeNull();
  });

  it("does not record a message for an offer without an ID or a message", () => {
    const store = new InMemoryPendingOfferStore();
    store.put(offer({ messageId: "msg-1" }));
    store.put(offer({ id: "offer-2", requesterId: bob }));
    expect(store.prompt(convA, "msg-1")).toBeNull();
  });

  it("marks the message of an answered offer", () => {
    const store = new InMemoryPendingOfferStore();
    store.put(offer({ id: "offer-1", messageId: "msg-1" }));
    store.markAnswered(convA, "offer-other");
    expect(store.prompt(convA, "msg-1")?.answered).toBe(false);
    store.markAnswered(convA, "offer-1");
    expect(store.prompt(convA, "msg-1")?.answered).toBe(true);
  });

  it("keeps the answered mark when the same offer is stored again, and resets it for a new offer on the message", () => {
    const store = new InMemoryPendingOfferStore();
    const o = offer({ id: "offer-1", messageId: "msg-1" });
    store.put(o);
    store.markAnswered(convA, "offer-1");
    store.put(o);
    expect(store.prompt(convA, "msg-1")?.answered).toBe(true);
    store.put(offer({ id: "offer-2", messageId: "msg-1" }));
    expect(store.prompt(convA, "msg-1")).toEqual({ offerId: "offer-2", requesterId: alice, answered: false });
  });

  it("lets each notice be claimed once per message, also for an unknown message", () => {
    const store = new InMemoryPendingOfferStore();
    store.put(offer({ id: "offer-1", messageId: "msg-1" }));
    expect(store.claimNotice(convA, "msg-1", "others")).toBe(true);
    expect(store.claimNotice(convA, "msg-1", "others")).toBe(false);
    expect(store.claimNotice(convA, "msg-1", "stale")).toBe(true);
    expect(store.claimNotice(convA, "msg-1", "stale")).toBe(false);
    expect(store.claimNotice(convA, "unknown", "stale")).toBe(true);
    expect(store.claimNotice(convA, "unknown", "stale")).toBe(false);
    expect(store.claimNotice(convB, "unknown", "stale")).toBe(true);
    // Claiming a notice for an unknown message does not make it known.
    expect(store.prompt(convA, "unknown")).toBeNull();
  });

  it("forgets the conversation's button messages when it is cleared", () => {
    const store = new InMemoryPendingOfferStore();
    store.put(offer({ id: "offer-1", messageId: "msg-1" }));
    store.claimNotice(convA, "msg-1", "stale");
    store.clearConversation(convA);
    expect(store.prompt(convA, "msg-1")).toBeNull();
    expect(store.claimNotice(convA, "msg-1", "stale")).toBe(true);
  });

  it("remembers a bounded number of button messages per conversation, forgetting the oldest", () => {
    const store = new InMemoryPendingOfferStore();
    for (let i = 0; i < 201; i++) store.put(offer({ id: `offer-${i}`, messageId: `msg-${i}` }));
    expect(store.prompt(convA, "msg-0")).toBeNull();
    expect(store.prompt(convA, "msg-1")?.offerId).toBe("offer-1");
    expect(store.prompt(convA, "msg-200")?.offerId).toBe("offer-200");
  });
});
