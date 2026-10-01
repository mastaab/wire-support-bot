import type { SupportRequest } from "../../../domain/entities/SupportRequest";
import { sameQualifiedId } from "../../../domain/ids/QualifiedId";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import type { InboundFile, PendingOfferStore } from "../../ports/PendingOfferPort";
import type { SentMessageRef, WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { formatAttachQuestion } from "../../services/attachments";
import { OFFER_TTL_MS } from "../../services/offers";
import { rememberLastMessage } from "./supportRequestMarkers";

/** Input of `OfferAttachment`. */
export interface OfferAttachmentInput {
  conversationId: QualifiedId;
  /** Who posted the file; only their next message can confirm. */
  senderId: QualifiedId;
  /** The posted file's message, which the offer replies to. */
  messageId: string;
  /** Already checked by the router: an attachable type, within the size limit, not self-deleting. */
  file: InboundFile;
}

/**
 * Offers to attach a file posted in the channel to the open support request it most likely
 * belongs to: the one with the latest bot message about it (`lastMessageAt`), else the newest
 * open one. Stores an `attach` offer for the sender and replies to the file with the question
 * (`formatAttachQuestion`), then stores the reply as the request's last message. Does nothing
 * without an open request, or while the sender already has a pending offer. True when it offered.
 */
/** The reply to a file while the sender still has a question to answer. */
export const ANSWER_FIRST = "Please answer my question above first (yes or no), then post the file again.";

export class OfferAttachment {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly offers: PendingOfferStore,
    private readonly wireOutbound: WireOutboundPort,
    private readonly logger?: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: OfferAttachmentInput): Promise<boolean> {
    // A pending question to the sender is not replaced by a file: they answer it first. A pending
    // file offer is replaced, so a yes always attaches the file they posted last.
    const pending = this.offers.peek(input.conversationId, input.senderId, this.now());
    if (pending && pending.kind !== "attach") {
      try {
        await this.wireOutbound.sendPlainText(input.conversationId, ANSWER_FIRST, { replyToMessageId: input.messageId });
      } catch (err) {
        this.logger?.warn("OfferAttachment: sending the answer-first reply failed", { err: errorName(err) });
      }
      return false;
    }

    let open: SupportRequest[];
    try {
      open = await this.requests.listByConversation(input.conversationId, { openOnly: true });
    } catch (err) {
      this.logger?.warn("OfferAttachment: listing open requests failed", { err: errorName(err) });
      return false;
    }
    const target = pickTarget(open, input.conversationId);
    if (!target) return false;

    let sent: SentMessageRef | undefined;
    try {
      sent = await this.wireOutbound.sendPlainText(
        input.conversationId,
        formatAttachQuestion(target.key, target.summary, input.file),
        { replyToMessageId: input.messageId },
      );
    } catch (err) {
      this.logger?.warn("OfferAttachment: sending the offer failed", { err: errorName(err) });
      return false;
    }

    // Passive help runs alongside and may have stored a question for the sender meanwhile; keep it.
    const current = this.offers.peek(input.conversationId, input.senderId, this.now());
    if (current && current !== pending) {
      this.logger?.info("OfferAttachment: another offer was stored meanwhile; the file offer is not kept");
      return false;
    }
    const now = this.now();
    this.offers.put({
      command: { kind: "attach", issueKey: target.key, file: input.file },
      conversationId: input.conversationId,
      requesterId: input.senderId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
    });
    // The question names the request, so the next watch update quotes it; only its ID and hash are kept.
    await rememberLastMessage(this.requests, target.key, sent, "OfferAttachment", this.logger);
    return true;
  }
}

/**
 * The open request of this conversation with the latest bot message about it, else the newest
 * open one. The repository already filters; the checks are repeated so a record from another
 * conversation, a deleted one or one last known as done is never offered.
 */
function pickTarget(requests: readonly SupportRequest[], conversationId: QualifiedId): SupportRequest | null {
  let target: SupportRequest | null = null;
  for (const request of requests) {
    if (request.deleted || request.statusCategory === "done" || !sameQualifiedId(request.conversationId, conversationId)) continue;
    if (!target || isBetterTarget(request, target)) target = request;
  }
  return target;
}

/** True when `a` is the better target than `b`: a later bot message wins, then the newer request. */
function isBetterTarget(a: SupportRequest, b: SupportRequest): boolean {
  const aMessage = validTime(a.lastMessageAt);
  const bMessage = validTime(b.lastMessageAt);
  if (aMessage !== bMessage) {
    if (bMessage === undefined) return true;
    if (aMessage === undefined) return false;
    return aMessage > bMessage;
  }
  return (validTime(a.createdAt) ?? 0) > (validTime(b.createdAt) ?? 0);
}

function validTime(date: Date | undefined): number | undefined {
  if (!(date instanceof Date)) return undefined;
  const time = date.getTime();
  return Number.isNaN(time) ? undefined : time;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
