import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type {
  EndedOfferPrompt, OfferCommand, OfferPrompt, OfferPromptEnding, OfferPromptNotice, PendingOffer, PendingOfferStore,
} from "../../application/ports/PendingOfferPort";
import { RECENT_DROP_MS } from "../../application/services/offers";
import { NO_METRICS, type MetricsPort } from "../../application/ports/MetricsPort";

function key(q: QualifiedId): string {
  return `${q.id}@${q.domain}`;
}

/** A dropped or expired offer's command and when it stopped being confirmable. */
interface DroppedOffer {
  command: OfferCommand;
  droppedAt: Date;
}

/** A button message the bot sent for an offer, and the notices it has had. */
interface PromptEntry {
  /** Null for a message the store never knew (a notice was claimed for it). */
  prompt: OfferPrompt | null;
  /** The question as sent with the buttons, for closing the message. */
  question?: string;
  notices: Set<OfferPromptNotice>;
}

/** Button messages remembered per conversation; the oldest is forgotten first. */
const PROMPTS_PER_CONVERSATION = 200;

/**
 * Pending offers in process memory, one per qualified requester per qualified conversation.
 * Offers are short-lived and a restart simply drops them, so nothing is persisted. A dropped
 * or expired offer is remembered for `RECENT_DROP_MS`, so a late "yes" can be answered; an
 * offer consumed by `take` is not remembered. The button message of an offer stored with an ID
 * and a message is remembered longer (bounded per conversation), with who was asked, its question,
 * whether the offer was answered or its message closed, and which one-off notices it had. A button
 * question that expires or is replaced by a newer one to the same requester is queued for closing
 * when the store notices it (`takeEndedPrompts`), marked closed so it is closed once.
 *
 * Metrics: an offer is counted as made the first time it is stored (storing the same offer again,
 * as after an acknowledgment, does not count) and as expired when the store notices its expiry.
 */
export class InMemoryPendingOfferStore implements PendingOfferStore {
  /** Conversation key to (requester key to offer). */
  private readonly offers = new Map<string, Map<string, PendingOffer>>();
  /** Conversation key to (requester key to recently dropped offer). */
  private readonly dropped = new Map<string, Map<string, DroppedOffer>>();
  /** Conversation key to (button message ID to what is known about it). */
  private readonly prompts = new Map<string, Map<string, PromptEntry>>();
  /** Button messages whose question ended without an answer, waiting to be closed. */
  private ended: EndedOfferPrompt[] = [];
  /** Offers stored so far, so storing one again is not counted as made. */
  private readonly counted = new WeakSet<PendingOffer>();

  constructor(private readonly metrics: MetricsPort = NO_METRICS) {}

  /** Unexpired offers in every conversation, for the pending-offers gauge. */
  pendingCount(now: Date = new Date()): number {
    let count = 0;
    for (const byRequester of this.offers.values()) {
      for (const offer of byRequester.values()) if (isLive(offer, now)) count++;
    }
    return count;
  }

  put(offer: PendingOffer): void {
    if (!this.counted.has(offer)) {
      this.counted.add(offer);
      this.metrics.offer("made");
    }
    // Measured by the caller's clock, like every other method, not the system clock.
    this.purgeExpired(offer.createdAt);
    this.forget(offer.conversationId, offer.requesterId);
    const conversationKey = key(offer.conversationId);
    const byRequester = this.offers.get(conversationKey) ?? new Map<string, PendingOffer>();
    // A newer question to the same requester replaces the open one, whose message is closed.
    const replaced = byRequester.get(key(offer.requesterId));
    if (replaced?.messageId && replaced.messageId !== offer.messageId) this.endPrompt(replaced, "replaced");
    byRequester.set(key(offer.requesterId), offer);
    this.offers.set(conversationKey, byRequester);
    if (offer.id && offer.messageId) {
      const entry = this.promptEntry(conversationKey, offer.messageId);
      // A re-stored offer (asked again after an acknowledgment) keeps what its message had.
      if (entry.prompt?.offerId !== offer.id) {
        entry.prompt = { offerId: offer.id, requesterId: offer.requesterId, answered: false, closed: false };
        entry.question = offer.question;
      }
    }
  }

  find(conversationId: QualifiedId, requesterId: QualifiedId, now: Date = new Date()): PendingOffer | null {
    this.purgeExpired(now);
    return this.liveOffer(conversationId, requesterId, now);
  }

  prompt(conversationId: QualifiedId, messageId: string): OfferPrompt | null {
    const prompt = this.prompts.get(key(conversationId))?.get(messageId)?.prompt;
    return prompt ? { ...prompt } : null;
  }

  markAnswered(conversationId: QualifiedId, offerId: string): void {
    for (const entry of this.prompts.get(key(conversationId))?.values() ?? []) {
      if (entry.prompt?.offerId === offerId) entry.prompt.answered = true;
    }
  }

  claimClose(conversationId: QualifiedId, messageId: string): { question?: string } | null {
    const entry = this.prompts.get(key(conversationId))?.get(messageId);
    if (!entry?.prompt || entry.prompt.closed) return null;
    entry.prompt.closed = true;
    return entry.question !== undefined ? { question: entry.question } : {};
  }

  takeEndedPrompts(): EndedOfferPrompt[] {
    const ended = this.ended;
    this.ended = [];
    return ended;
  }

  sweepExpired(now: Date): void {
    this.purgeExpired(now);
  }

  claimNotice(conversationId: QualifiedId, messageId: string, notice: OfferPromptNotice): boolean {
    const entry = this.promptEntry(key(conversationId), messageId);
    if (entry.notices.has(notice)) return false;
    entry.notices.add(notice);
    return true;
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
    this.prompts.delete(key(conversationId));
    // The bot has left: its messages there can no longer be edited.
    this.ended = this.ended.filter((prompt) => key(prompt.conversationId) !== key(conversationId));
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
    this.metrics.offer("expired");
    this.endPrompt(offer, "expired");
    this.remember(conversationId, requesterId, offer.command, offer.expiresAt);
    return null;
  }

  /** Queues the offer's button message for closing, unless it is unknown or already closed. */
  private endPrompt(offer: PendingOffer, reason: OfferPromptEnding): void {
    if (!offer.messageId) return;
    const closing = this.claimClose(offer.conversationId, offer.messageId);
    if (!closing) return;
    this.ended.push({ conversationId: offer.conversationId, messageId: offer.messageId, ...closing, reason });
  }

  /** The entry for a button message, created when absent; bounded per conversation. */
  private promptEntry(conversationKey: string, messageId: string): PromptEntry {
    const byMessage = this.prompts.get(conversationKey) ?? new Map<string, PromptEntry>();
    this.prompts.set(conversationKey, byMessage);
    let entry = byMessage.get(messageId);
    if (!entry) {
      entry = { prompt: null, notices: new Set() };
      byMessage.set(messageId, entry);
      if (byMessage.size > PROMPTS_PER_CONVERSATION) byMessage.delete(byMessage.keys().next().value!);
    }
    return entry;
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

  /**
   * Remembers expired offers as of their expiry, queues their button messages for closing and
   * forgets drops older than `RECENT_DROP_MS`.
   */
  private purgeExpired(now: Date): void {
    for (const [conversationKey, byRequester] of this.offers) {
      for (const [requesterKey, offer] of byRequester) {
        if (isLive(offer, now)) continue;
        byRequester.delete(requesterKey);
        this.metrics.offer("expired");
        this.endPrompt(offer, "expired");
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
