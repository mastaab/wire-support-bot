import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { OfferCommand, PendingOffer, PendingOfferStore } from "../../application/ports/PendingOfferPort";
import { RECENT_DROP_MS } from "../../application/services/offers";

function key(q: QualifiedId): string {
  return `${q.id}@${q.domain}`;
}

/** A dropped or expired offer's command and when it stopped being confirmable. */
interface DroppedOffer {
  command: OfferCommand;
  droppedAt: Date;
}

/**
 * Pending offers in process memory, one per qualified requester per qualified conversation.
 * Offers are short-lived and a restart simply drops them, so nothing is persisted. A dropped
 * or expired offer is remembered for `RECENT_DROP_MS`, so a late "yes" can be answered; an
 * offer consumed by `take` is not remembered.
 */
export class InMemoryPendingOfferStore implements PendingOfferStore {
  /** Conversation key to (requester key to offer). */
  private readonly offers = new Map<string, Map<string, PendingOffer>>();
  /** Conversation key to (requester key to recently dropped offer). */
  private readonly dropped = new Map<string, Map<string, DroppedOffer>>();

  put(offer: PendingOffer): void {
    // Measured by the caller's clock, like every other method, not the system clock.
    this.purgeExpired(offer.createdAt);
    this.forget(offer.conversationId, offer.requesterId);
    const conversationKey = key(offer.conversationId);
    const byRequester = this.offers.get(conversationKey) ?? new Map<string, PendingOffer>();
    byRequester.set(key(offer.requesterId), offer);
    this.offers.set(conversationKey, byRequester);
  }

  take(conversationId: QualifiedId, requesterId: QualifiedId, now: Date = new Date()): PendingOffer | null {
    const offer = this.liveOffer(conversationId, requesterId, now);
    if (!offer) return null;
    this.remove(conversationId, requesterId);
    return offer;
  }

  has(conversationId: QualifiedId, requesterId: QualifiedId, now: Date = new Date()): boolean {
    this.purgeExpired(now);
    return this.liveOffer(conversationId, requesterId, now) !== null;
  }

  peek(conversationId: QualifiedId, requesterId: QualifiedId, now: Date = new Date()): OfferCommand | null {
    this.purgeExpired(now);
    return this.liveOffer(conversationId, requesterId, now)?.command ?? null;
  }

  clearConversation(conversationId: QualifiedId): void {
    this.offers.delete(key(conversationId));
    this.dropped.delete(key(conversationId));
  }

  drop(conversationId: QualifiedId, requesterId: QualifiedId, now: Date = new Date()): OfferCommand | null {
    this.purgeExpired(now);
    const offer = this.liveOffer(conversationId, requesterId, now);
    if (!offer) return null;
    this.remove(conversationId, requesterId);
    this.remember(conversationId, requesterId, offer.command, now);
    return offer.command;
  }

  recentlyDropped(conversationId: QualifiedId, requesterId: QualifiedId, now: Date = new Date()): OfferCommand | null {
    // An offer that expired but was not yet noticed is remembered first, as of its expiry.
    this.liveOffer(conversationId, requesterId, now);
    const entry = this.dropped.get(key(conversationId))?.get(key(requesterId));
    if (!entry) return null;
    if (isRecent(entry, now)) return entry.command;
    this.forget(conversationId, requesterId);
    return null;
  }

  forgetDropped(conversationId: QualifiedId, requesterId: QualifiedId): void {
    this.forget(conversationId, requesterId);
  }

  /** The requester's unexpired offer; an expired one is removed and remembered as of its expiry. */
  private liveOffer(conversationId: QualifiedId, requesterId: QualifiedId, now: Date): PendingOffer | null {
    const offer = this.offers.get(key(conversationId))?.get(key(requesterId)) ?? null;
    if (!offer) return null;
    if (isLive(offer, now)) return offer;
    this.remove(conversationId, requesterId);
    this.remember(conversationId, requesterId, offer.command, offer.expiresAt);
    return null;
  }

  private remove(conversationId: QualifiedId, requesterId: QualifiedId): void {
    const conversationKey = key(conversationId);
    const byRequester = this.offers.get(conversationKey);
    if (!byRequester) return;
    byRequester.delete(key(requesterId));
    if (byRequester.size === 0) this.offers.delete(conversationKey);
  }

  private remember(conversationId: QualifiedId, requesterId: QualifiedId, command: OfferCommand, droppedAt: Date): void {
    const conversationKey = key(conversationId);
    const byRequester = this.dropped.get(conversationKey) ?? new Map<string, DroppedOffer>();
    byRequester.set(key(requesterId), { command: withoutFileRef(command), droppedAt });
    this.dropped.set(conversationKey, byRequester);
  }

  private forget(conversationId: QualifiedId, requesterId: QualifiedId): void {
    const conversationKey = key(conversationId);
    const byRequester = this.dropped.get(conversationKey);
    if (!byRequester) return;
    byRequester.delete(key(requesterId));
    if (byRequester.size === 0) this.dropped.delete(conversationKey);
  }

  /** Remembers expired offers as of their expiry and forgets drops older than `RECENT_DROP_MS`. */
  private purgeExpired(now: Date): void {
    for (const [conversationKey, byRequester] of this.offers) {
      for (const [requesterKey, offer] of byRequester) {
        if (isLive(offer, now)) continue;
        byRequester.delete(requesterKey);
        const remembered = this.dropped.get(conversationKey) ?? new Map<string, DroppedOffer>();
        remembered.set(requesterKey, { command: withoutFileRef(offer.command), droppedAt: offer.expiresAt });
        this.dropped.set(conversationKey, remembered);
      }
      if (byRequester.size === 0) this.offers.delete(conversationKey);
    }
    for (const [conversationKey, byRequester] of this.dropped) {
      for (const [requesterKey, entry] of byRequester) {
        if (!isRecent(entry, now)) byRequester.delete(requesterKey);
      }
      if (byRequester.size === 0) this.dropped.delete(conversationKey);
    }
  }
}

function isLive(offer: PendingOffer, now: Date): boolean {
  return now.getTime() < offer.expiresAt.getTime();
}

function isRecent(entry: DroppedOffer, now: Date): boolean {
  return now.getTime() - entry.droppedAt.getTime() < RECENT_DROP_MS;
}

/**
 * A remembered attach offer keeps no download reference: it holds the file's key material, and a
 * dropped offer can never be confirmed, only mentioned ("To add it, post the file again.").
 */
function withoutFileRef(command: OfferCommand): OfferCommand {
  if (command.kind !== "attach") return command;
  return { ...command, file: { ...command.file, ref: { transport: command.file.ref.transport, data: null } } };
}
