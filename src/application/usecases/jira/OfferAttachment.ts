import type { SupportRequest } from "../../../domain/entities/SupportRequest";
import { sameQualifiedId } from "../../../domain/ids/QualifiedId";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import type { InboundFile, OfferCommand, PendingOfferStore } from "../../ports/PendingOfferPort";
import type { SentMessageRef, WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { describeFile, formatAttachQuestion } from "../../services/attachments";
import { OFFER_TTL_MS, formatAttachTargetQuestion } from "../../services/offers";
import { OFFER_CANDIDATES_MAX, choiceHint, doNotAttachChoice, keyChoice, newOfferId, sendOfferPrompt } from "../../services/offerButtons";
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
 * Offers to attach a file posted in the channel to an open support request. When the sender has
 * more than one open request of their own in the conversation, they choose between them (at most
 * three, likeliest first) or decline; otherwise the offer names the request the file most likely
 * belongs to: the one with the latest bot message about it (`lastMessageAt`), else the newest open
 * one, and that question is stored as the request's last message. Stores an `attach` offer for the
 * sender and replies to the file with the question and its buttons. Does nothing without an open
 * request, or while the sender already has a pending offer. True when it offered.
 */
/** The reply to a file while the sender still has a question to answer. */
export const ANSWER_FIRST = "Please answer my question above first, then post the file again.";

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
    // With more than one open request of their own, the sender picks the request instead of the
    // bot taking the likeliest one.
    const own = ownTargets(open, input.conversationId, input.senderId);
    const attach = (key: string): OfferCommand => ({ kind: "attach", issueKey: key, file: input.file });
    const choices = own.length > 1 ? [...own.map((r) => keyChoice(r.key, attach(r.key))), doNotAttachChoice()] : undefined;
    const command = attach(choices ? own[0]!.key : target.key);
    const question = choices
      ? formatAttachTargetQuestion(own, choiceHint(choices), describeFile(input.file))
      : formatAttachQuestion(target.key, target.summary, input.file);

    const offerId = newOfferId();
    let sent: SentMessageRef | undefined;
    try {
      sent = await sendOfferPrompt(this.wireOutbound, input.conversationId, question, offerId, choices, input.messageId);
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
      command,
      conversationId: input.conversationId,
      requesterId: input.senderId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
      id: offerId,
      ...(sent ? { messageId: sent.messageId } : {}),
      ...(choices ? { choices } : {}),
    });
    // A yes-or-no question names the request, so the next watch update quotes it; only its ID and
    // hash are kept. A choice names several requests and is no one's last message.
    if (!choices) await rememberLastMessage(this.requests, target.key, sent, "OfferAttachment", this.logger);
    return true;
  }
}

/**
 * The sender's own open requests of this conversation, likeliest first (as `pickTarget` ranks
 * them: the latest bot message, then the newest), at most `OFFER_CANDIDATES_MAX`.
 */
function ownTargets(requests: readonly SupportRequest[], conversationId: QualifiedId, senderId: QualifiedId): SupportRequest[] {
  return requests
    .filter((r) => !r.deleted && r.statusCategory !== "done" && sameQualifiedId(r.conversationId, conversationId) && sameQualifiedId(r.requesterId, senderId))
    .sort((a, b) => (isBetterTarget(a, b) ? -1 : isBetterTarget(b, a) ? 1 : 0))
    .slice(0, OFFER_CANDIDATES_MAX);
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
