import { sameQualifiedId } from "../../../domain/ids/QualifiedId";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { isKeyInProject } from "../../../domain/ids/jiraLink";
import { DEFAULT_PART_ASSET, PART_DETAIL_MAX, SUPPORT_REQUEST_KINDS, SUPPORT_SUMMARY_MAX } from "../../../domain/entities/SupportRequest";
import type { PartAssetWording, PartDetails, SupportRequest, SupportRequestKind } from "../../../domain/entities/SupportRequest";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import type { MessageCategory } from "../../ports/ClassifierPort";
import type { OfferCommand, PendingOfferStore } from "../../ports/PendingOfferPort";
import type { OpenRequestRef, SupportDraft, SupportTriagePort } from "../../ports/SupportTriagePort";
import type { SentMessageRef, WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import {
  OFFER_DESCRIPTION_MAX, OFFER_TTL_MS, PART_DETAIL_KEYS, REPLY_BODY_MAX,
  formatMissingPartsQuestion, formatReplyQuestion, formatResolveQuestion, formatSupportQuestion, missingPartDetails,
} from "../../services/offers";
import type { GetIssueStatus } from "./GetIssueStatus";
import { rememberLastMessage } from "./supportRequestMarkers";
import { statedPartDetails } from "../../services/partDetails";

/** Classifier confidence required before passive help acts on a message. */
export const PASSIVE_CONFIDENCE_MIN = 0.8;

export interface OfferSupportInput {
  /** The unaddressed message. Sent to the model for triage only; never stored or logged. */
  text: string;
  /** Source message, for the native reply. */
  messageId: string;
  conversationId: QualifiedId;
  senderId: QualifiedId;
  senderName?: string;
  categories: readonly MessageCategory[];
  confidence: number;
  /** Conversation timezone for reply times in a status answer. */
  timezone?: string;
  /** Cancelled when the bot leaves the conversation; checked before anything is sent. */
  signal?: AbortSignal;
}

/**
 * Passive service-desk help: offers to raise, add to or resolve a request, or answers its status.
 * Called by the pipeline for unaddressed ACTIVE messages when passive help is on.
 */
export interface OfferSupportFromConversationPort {
  /** True when it sent anything (an offer, a missing-details question or a status answer). */
  execute(input: OfferSupportInput): Promise<boolean>;
}

/** Most open requests shown to the model. */
const OPEN_REQUESTS_MAX = 20;

/** How recently the speaker must have raised a request for a message without its own subject to continue it. */
const RECENTLY_RAISED_MS = 60 * 60 * 1000;

/** Categories that may add to or resolve an open request, but never raise a new one. */
const MAY_ADD_CATEGORIES: readonly MessageCategory[] = ["update", "blocker"];

/**
 * Offers to raise a problem noticed in an unaddressed message, offers to add what a message
 * adds to an open request of this conversation as a reply to it, offers to resolve an open
 * request the message says is solved or can be closed, or answers a status question about an
 * open request. The model only drafts or matches; code checks the result against
 * this conversation's records and the offer bounds, writes the question, and stores the
 * offer, so nothing reaches the tracker without the speaker's yes. Failures are logged by
 * error name and stay silent in the channel.
 */
export class OfferSupportFromConversation implements OfferSupportFromConversationPort {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly triage: SupportTriagePort,
    private readonly getIssueStatus: GetIssueStatus,
    private readonly offers: PendingOfferStore,
    private readonly wireOutbound: WireOutboundPort,
    private readonly logger?: Logger,
    private readonly now: () => Date = () => new Date(),
    /** How the asset essential of a part order is named and asked for. */
    private readonly partAsset: PartAssetWording = DEFAULT_PART_ASSET,
  ) {}

  async execute(input: OfferSupportInput): Promise<boolean> {
    if (!(input.confidence >= PASSIVE_CONFIDENCE_MIN)) return false;
    const wantsStatus = input.categories.includes("request_status");
    const wantsOffer = input.categories.includes("service_request");
    // The classifier often labels news about a reported problem ("it only happens on the new
    // laptops", "the cable was delivered, please close SD-14") as an update or blocker only. Such a message may add to or resolve an open request, but it never leads to
    // an offer to raise a new one.
    const mayAdd = !wantsOffer && MAY_ADD_CATEGORIES.some((category) => input.categories.includes(category));
    if (!wantsStatus && !wantsOffer && !mayAdd) return false;

    const open = await this.openRequests(input.conversationId, input.senderId);
    if (!open) return false;

    if (wantsStatus && open.length > 0) {
      const key = await this.matchStatus(input.text, open);
      if (key) return this.answerStatus(input, key);
    }
    if (wantsOffer) return this.offerSupport(input, open, false);
    if (mayAdd && open.length > 0) return this.offerSupport(input, open, true);
    return false;
  }

  /**
   * This conversation's requests not done by last known category, in the tracker's project,
   * newest first, each marked when the speaker raised it within the last hour; null when the
   * read failed.
   */
  private async openRequests(conversationId: QualifiedId, speakerId: QualifiedId): Promise<OpenRequestRef[] | null> {
    const projectKey = this.getIssueStatus.projectKey;
    const recentSince = this.now().getTime() - RECENTLY_RAISED_MS;
    try {
      const records = await this.requests.listByConversation(conversationId, { openOnly: true, limit: OPEN_REQUESTS_MAX });
      const open = records
        .filter((r) => !r.deleted && r.statusCategory !== "done"
          && sameQualifiedId(r.conversationId, conversationId) && isKeyInProject(r.key, projectKey))
        .slice(0, OPEN_REQUESTS_MAX);
      // Only the speaker's newest recent request is marked: "it" continues one request, not several.
      const newestBySpeaker = open
        .filter((r) => sameQualifiedId(r.requesterId, speakerId) && r.createdAt.getTime() >= recentSince)
        .reduce<SupportRequest | null>((newest, r) => (!newest || r.createdAt > newest.createdAt ? r : newest), null);
      return open.map((r) => ({
        key: r.key,
        summary: r.summary,
        raisedBySpeakerRecently: r.key === newestBySpeaker?.key,
      }));
    } catch (err) {
      this.logger?.warn("OfferSupportFromConversation: listing open requests failed", { err: errorName(err) });
      return null;
    }
  }

  /** The open request the question asks about, or null. A key the model invents is ignored. */
  private async matchStatus(text: string, open: readonly OpenRequestRef[]): Promise<string | null> {
    let key: string | null;
    try {
      key = await this.triage.matchStatusQuestion(text, open);
    } catch (err) {
      this.logger?.warn("OfferSupportFromConversation: matchStatusQuestion failed", { err: errorName(err) });
      return null;
    }
    const normalised = typeof key === "string" ? key.trim().toUpperCase() : "";
    return open.find((r) => r.key === normalised)?.key ?? null;
  }

  /**
   * Read-only: `GetIssueStatus` re-checks scope, reads the ticket live and replies to the source
   * message on every path, so it sent something exactly when it did not throw.
   */
  private async answerStatus(input: OfferSupportInput, key: string): Promise<boolean> {
    if (input.signal?.aborted) return false;
    try {
      await this.getIssueStatus.execute({
        reference: key,
        conversationId: input.conversationId,
        timezone: input.timezone,
        replyToMessageId: input.messageId,
      });
      return true;
    } catch (err) {
      this.logger?.warn("OfferSupportFromConversation: status answer failed", { err: errorName(err) });
      return false;
    }
  }

  /** True when it sent an offer or a missing-details question. */
  private async offerSupport(input: OfferSupportInput, open: readonly OpenRequestRef[], additionOnly: boolean): Promise<boolean> {
    // One live offer per speaker: a new one would silently replace what they may be about to confirm.
    if (this.offers.has(input.conversationId, input.senderId)) return false;

    let draft: SupportDraft | null;
    try {
      draft = await this.triage.draftRequest(input.text, open);
    } catch (err) {
      this.logger?.warn("OfferSupportFromConversation: draftRequest failed", { err: errorName(err) });
      return false;
    }
    if (!draft) return false;

    // Resolving takes precedence over adding and over raising: a message that says an open
    // request is solved is about that request, whatever else it mentions.
    const resolves = typeof draft.resolves === "string" ? draft.resolves.trim().toUpperCase() : "";
    const resolving = resolves ? open.find((r) => r.key === resolves) : undefined;
    // A close request for a request that is not open here never falls through to raising a new one.
    if (resolves && !resolving) {
      this.logger?.debug("OfferSupportFromConversation: close request for a request that is not open here", { key: resolves });
      return false;
    }
    if (resolving) {
      const comment = typeof draft.closingComment === "string" ? draft.closingComment.trim() : "";
      if (comment.length > REPLY_BODY_MAX) {
        this.logger?.debug("OfferSupportFromConversation: closing comment outside the offer bounds", { key: resolving.key });
        return false;
      }
      return this.offer(
        input,
        formatResolveQuestion(resolving.key, resolving.summary, comment || undefined),
        comment ? { kind: "resolve", issueKey: resolving.key, comment } : { kind: "resolve", issueKey: resolving.key },
      );
    }

    const duplicateOf = typeof draft.duplicateOf === "string" ? draft.duplicateOf.trim().toUpperCase() : "";
    const covering = duplicateOf ? open.find((r) => r.key === duplicateOf) : undefined;
    if (covering) {
      const body = typeof draft.addition === "string" ? draft.addition.trim() : "";
      if (!body || body.length > REPLY_BODY_MAX) {
        this.logger?.debug("OfferSupportFromConversation: covered by an open request", { key: covering.key, addition: body.length > 0 });
        return false;
      }
      return this.offer(input, formatReplyQuestion(covering.key, covering.summary, body), { kind: "reply", issueKey: covering.key, body });
    }
    if (additionOnly) return false;
    const command = toSupportCommand(draft, input.text);
    if (!command) {
      this.logger?.debug("OfferSupportFromConversation: draft outside the offer bounds");
      return false;
    }
    // A part order without all its essentials asks for what is missing instead. The incomplete
    // order is stored like any offer: the speaker's answer amends it, and it cannot be confirmed
    // until it is complete.
    const missing = missingPartDetails(command);
    const question = missing.length > 0
      ? formatMissingPartsQuestion(missing, this.partAsset)
      : formatSupportQuestion(command.summary, command.description, command.requestKind, command.part, this.partAsset);
    return this.offer(input, question, command);
  }

  /**
   * Sends the code-written question as a native reply to the source message, then stores the
   * offer for the speaker. True when the question was sent, even if the work was cancelled during
   * the send and the offer is not stored. A reply or resolve offer names an open request of this
   * conversation, so it becomes that request's last message, quoted by the next watch update.
   */
  private async offer(input: OfferSupportInput, question: string, command: OfferCommand): Promise<boolean> {
    if (input.signal?.aborted || this.offers.has(input.conversationId, input.senderId)) return false;
    let sent: SentMessageRef | undefined;
    try {
      sent = await this.wireOutbound.sendPlainText(input.conversationId, question, { replyToMessageId: input.messageId });
    } catch (err) {
      this.logger?.warn("OfferSupportFromConversation: sending the offer failed", { err: errorName(err) });
      return false;
    }
    // Cancelled during the send (the bot left the conversation, which cleared its offers):
    // storing this one now would let it outlive the conversation.
    if (!input.signal?.aborted) {
      const now = this.now();
      this.offers.put({
        command,
        conversationId: input.conversationId,
        requesterId: input.senderId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
      });
    }
    // The question is in the channel either way; only its ID and hash are kept.
    if (command.kind !== "support") {
      await rememberLastMessage(this.requests, command.issueKey, sent, "OfferSupportFromConversation", this.logger);
    }
    return true;
  }
}

/** The draft as a `support` command within the offer bounds, or null. */
function toSupportCommand(draft: SupportDraft, message: string): Extract<OfferCommand, { kind: "support" }> | null {
  const summary = typeof draft.summary === "string" ? draft.summary.replace(/\s+/g, " ").trim() : "";
  const description = typeof draft.description === "string" ? draft.description.trim() : "";
  if (!summary || summary.length > SUPPORT_SUMMARY_MAX) return null;
  if (!description || description.length > OFFER_DESCRIPTION_MAX) return null;
  const requestKind: SupportRequestKind = SUPPORT_REQUEST_KINDS.includes(draft.requestKind) ? draft.requestKind : "fault";
  if (requestKind !== "part") return { kind: "support", requestKind, summary, description };
  // Only essentials the requester's message states; anything the model filled in is asked for.
  return { kind: "support", requestKind, summary, description, part: statedPartDetails(toPartDetails(draft.part), message) };
}

/**
 * The part essentials, each collapsed to one line. A value that is empty or longer than
 * `PART_DETAIL_MAX` is left out, so it counts as missing and is asked for.
 */
function toPartDetails(part: PartDetails | undefined): PartDetails {
  const details: PartDetails = {};
  for (const key of PART_DETAIL_KEYS) {
    const value = typeof part?.[key] === "string" ? part[key]!.replace(/\s+/g, " ").trim() : "";
    if (value && value.length <= PART_DETAIL_MAX) details[key] = value;
  }
  return details;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
