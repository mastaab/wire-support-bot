import { sameQualifiedId } from "../../../domain/ids/QualifiedId";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { isKeyInProject } from "../../../domain/ids/jiraLink";
import { DEFAULT_PART_ASSET, PART_DETAIL_MAX, SUPPORT_REQUEST_KINDS, SUPPORT_SUMMARY_MAX } from "../../../domain/entities/SupportRequest";
import type { PartAssetWording, PartDetails, SupportRequest, SupportRequestKind } from "../../../domain/entities/SupportRequest";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import type { MessageCategory } from "../../ports/ClassifierPort";
import type { ChoosablePartDetail, OfferChoice, OfferCommand, PendingOfferStore } from "../../ports/PendingOfferPort";
import type { OpenRequestRef, SupportDraft, SupportTriagePort } from "../../ports/SupportTriagePort";
import type { SentMessageRef, WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import {
  OFFER_DESCRIPTION_MAX, OFFER_TTL_MS, PART_DETAIL_KEYS, REPLY_BODY_MAX,
  formatNewOrExistingQuestion, formatReplyQuestion, formatReplyTargetQuestion, formatResolveQuestion,
  formatResolveTargetQuestion, formatSupportQuestion, missingPartDetails,
} from "../../services/offers";
import type { CandidateRequest } from "../../services/offers";
import {
  OFFER_CANDIDATES_MAX, addToChoice, cancelChoice, choiceHint, keyChoice, newOfferId, offerPromptFields, raiseNewChoice, sendOfferPrompt,
} from "../../services/offerButtons";
import type { GetIssueStatus } from "./GetIssueStatus";
import { rememberLastMessage } from "./supportRequestMarkers";
import { statedPartDetails } from "../../services/partDetails";
import { partOrderStep } from "../../services/partOrderSteps";

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
  /** Canceled when the bot leaves the conversation; checked before anything is sent. */
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

/** How long a done request still counts as a candidate for a new problem that may be the same. */
const RECENTLY_DONE_MS = 7 * 24 * 60 * 60 * 1000;

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
    /** Delivery locations of part orders offered as buttons; empty asks for the location in text. */
    private readonly deliveryLocations: readonly string[] = [],
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
  private async openRequests(conversationId: QualifiedId, speakerId: QualifiedId): Promise<OpenRequest[] | null> {
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
        mine: sameQualifiedId(r.requesterId, speakerId),
      }));
    } catch (err) {
      this.logger?.warn("OfferSupportFromConversation: listing open requests failed", { err: errorName(err) });
      return null;
    }
  }

  /** The open request the question asks about, or null. A key the model invents is ignored. */
  private async matchStatus(text: string, open: readonly OpenRequest[]): Promise<string | null> {
    let key: string | null;
    try {
      key = await this.triage.matchStatusQuestion(text, open.map(toRef));
    } catch (err) {
      this.logger?.warn("OfferSupportFromConversation: matchStatusQuestion failed", { err: errorName(err) });
      return null;
    }
    const normalized = typeof key === "string" ? key.trim().toUpperCase() : "";
    return open.find((r) => r.key === normalized)?.key ?? null;
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
  private async offerSupport(input: OfferSupportInput, open: readonly OpenRequest[], additionOnly: boolean): Promise<boolean> {
    // One live offer per speaker: a new one would silently replace what they may be about to confirm.
    if (this.offers.has(input.conversationId, input.senderId)) return false;

    let draft: SupportDraft | null;
    try {
      draft = await this.triage.draftRequest(input.text, open.map(toRef));
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
      const resolveCommand = (key: string): OfferCommand => (comment ? { kind: "resolve", issueKey: key, comment } : { kind: "resolve", issueKey: key });
      // Without a key in the message, another open request may be the one meant: the speaker picks.
      const targets = this.targetCandidates(input.text, resolving, open);
      if (targets.length > 1) {
        const choices = [...targets.map((r) => keyChoice(r.key, resolveCommand(r.key))), cancelChoice()];
        return this.offer(input, formatResolveTargetQuestion(targets, choiceHint(choices), comment || undefined), resolveCommand(resolving.key), choices);
      }
      return this.offer(input, formatResolveQuestion(resolving.key, resolving.summary, comment || undefined), resolveCommand(resolving.key));
    }

    const duplicateOf = typeof draft.duplicateOf === "string" ? draft.duplicateOf.trim().toUpperCase() : "";
    const covering = duplicateOf ? open.find((r) => r.key === duplicateOf) : undefined;
    const addition = typeof draft.addition === "string" ? draft.addition.trim() : "";
    const command = additionOnly ? null : toSupportCommand(draft, input.text);

    // A new problem that may be one of the conversation's requests: the speaker picks between
    // adding to one of them and raising a new one, instead of the model guessing.
    if (command) {
      const candidates = await this.sameProblemCandidates(input, command, duplicateOf);
      if (candidates === null) return false;
      if (candidates.length > 0) {
        const body = addition && addition.length <= REPLY_BODY_MAX ? addition : command.description;
        const choices = [
          ...candidates.map((r) => addToChoice(r.key, { kind: "reply", issueKey: r.key, body })),
          raiseNewChoice(command),
          cancelChoice(),
        ];
        return this.offer(input, formatNewOrExistingQuestion(command, body, candidates, choiceHint(choices), this.partAsset), command, choices);
      }
    }

    if (covering && (additionOnly || !command)) {
      if (!addition || addition.length > REPLY_BODY_MAX) {
        this.logger?.debug("OfferSupportFromConversation: covered by an open request", { key: covering.key, addition: addition.length > 0 });
        return false;
      }
      const replyCommand = (key: string): OfferCommand => ({ kind: "reply", issueKey: key, body: addition });
      const targets = this.targetCandidates(input.text, covering, open);
      if (targets.length > 1) {
        const choices = [...targets.map((r) => keyChoice(r.key, replyCommand(r.key))), cancelChoice()];
        return this.offer(input, formatReplyTargetQuestion(targets, choiceHint(choices), addition), replyCommand(covering.key), choices);
      }
      return this.offer(input, formatReplyQuestion(covering.key, covering.summary, addition), replyCommand(covering.key));
    }
    if (additionOnly) return false;
    if (!command) {
      this.logger?.debug("OfferSupportFromConversation: draft outside the offer bounds");
      return false;
    }
    // A part order without all its essentials asks its next question instead: the free-text
    // essentials in text, then the quantity and the delivery location with buttons. The
    // incomplete order is stored like any offer: the speaker's answer, typed or clicked, amends
    // it, and it cannot be confirmed until it is complete.
    if (command.requestKind === "part" && missingPartDetails(command).length > 0) {
      const step = partOrderStep(command, this.partAsset, this.deliveryLocations);
      return this.offer(input, step.question, command, step.choices, step.buttons, step.fillsPart);
    }
    return this.offer(input, formatSupportQuestion(command.summary, command.description, command.requestKind, command.part, this.partAsset), command);
  }

  /**
   * The open requests a resolve or an addition may mean when the message names no request key:
   * the model's pick first, then the speaker's other requests, then the rest, newest first, at
   * most `OFFER_CANDIDATES_MAX`. Only the pick when the message names a key of the project.
   */
  private targetCandidates(text: string, pick: OpenRequest, open: readonly OpenRequest[]): OpenRequest[] {
    if (namesProjectKey(text, this.getIssueStatus.projectKey)) return [pick];
    const others = open.filter((r) => r.key !== pick.key);
    return [pick, ...others.filter((r) => r.mine), ...others.filter((r) => !r.mine)].slice(0, OFFER_CANDIDATES_MAX);
  }

  /**
   * Requests of this conversation that may describe the same problem as the draft: open ones and
   * those done within `RECENTLY_DONE_MS`, filtered by code. The model's `duplicateOf` counts only
   * when it is one of them and comes first; the others share a significant word with the draft's
   * summary. At most `OFFER_CANDIDATES_MAX`, newest first; null when the read failed.
   */
  private async sameProblemCandidates(
    input: OfferSupportInput, command: Extract<OfferCommand, { kind: "support" }>, duplicateOf: string,
  ): Promise<CandidateRequest[] | null> {
    const projectKey = this.getIssueStatus.projectKey;
    const doneSince = this.now().getTime() - RECENTLY_DONE_MS;
    let records: SupportRequest[];
    try {
      records = await this.requests.listByConversation(input.conversationId, { limit: OPEN_REQUESTS_MAX });
    } catch (err) {
      this.logger?.warn("OfferSupportFromConversation: listing requests failed", { err: errorName(err) });
      return null;
    }
    const known = records.filter((r) => !r.deleted && sameQualifiedId(r.conversationId, input.conversationId) && isKeyInProject(r.key, projectKey)
      && (r.statusCategory !== "done" || r.updatedAt.getTime() >= doneSince));
    const words = significantWords(command.summary);
    const hinted = known.find((r) => r.key === duplicateOf);
    const similar = known.filter((r) => r !== hinted && [...significantWords(r.summary)].some((word) => words.has(word)));
    return [...(hinted ? [hinted] : []), ...similar].slice(0, OFFER_CANDIDATES_MAX)
      .map((r) => ({ key: r.key, summary: r.summary, done: r.statusCategory === "done" }));
  }

  /**
   * Sends the code-written question as a native reply to the source message, then stores the
   * offer for the speaker. An offer question goes with buttons ([Yes] [No], or one per option of
   * a choice, or the options for a part order's essential named by `fillsPart`); `withButtons`
   * is false for a question that asks for free-text details instead. True when the
   * question was sent, even if the work was canceled during the send and the offer is not stored.
   * A button question is not stored as a request's last message: it is edited when it closes, so
   * the next watch update quotes the request's previous last message instead.
   */
  private async offer(
    input: OfferSupportInput, question: string, command: OfferCommand, choices?: OfferChoice[], withButtons = true,
    fillsPart?: ChoosablePartDetail,
  ): Promise<boolean> {
    if (input.signal?.aborted || this.offers.has(input.conversationId, input.senderId)) return false;
    const offerId = withButtons ? newOfferId() : undefined;
    let sent: SentMessageRef | undefined;
    try {
      sent = offerId
        ? await sendOfferPrompt(this.wireOutbound, input.conversationId, question, offerId, choices, input.messageId)
        : await this.wireOutbound.sendPlainText(input.conversationId, question, { replyToMessageId: input.messageId });
    } catch (err) {
      this.logger?.warn("OfferSupportFromConversation: sending the offer failed", { err: errorName(err) });
      return false;
    }
    // Canceled during the send (the bot left the conversation, which cleared its offers):
    // storing this one now would let it outlive the conversation.
    if (!input.signal?.aborted) {
      const now = this.now();
      this.offers.put({
        command,
        conversationId: input.conversationId,
        requesterId: input.senderId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
        ...offerPromptFields(offerId, sent, question),
        ...(choices ? { choices } : {}),
        ...(fillsPart ? { fillsPart } : {}),
      });
    }
    // The question is in the channel either way; only its ID and hash are kept. A button
    // question is edited when it closes, so it is no request's last message.
    if (command.kind !== "support" && !choices && !offerId) {
      await rememberLastMessage(this.requests, command.issueKey, sent, "OfferSupportFromConversation", this.logger);
    }
    return true;
  }
}

/** An open request of the conversation as passive help uses it: what the model sees, and whether the speaker raised it. */
interface OpenRequest extends OpenRequestRef {
  mine: boolean;
}

/** What the model sees of an open request: key, summary and the recent mark, never the requester. */
function toRef(request: OpenRequest): OpenRequestRef {
  return request.raisedBySpeakerRecently === undefined
    ? { key: request.key, summary: request.summary }
    : { key: request.key, summary: request.summary, raisedBySpeakerRecently: request.raisedBySpeakerRecently };
}

/** True when the text names a key of the project ("SD-41"). */
function namesProjectKey(text: string, projectKey: string): boolean {
  const escaped = projectKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}-\\d+\\b`, "i").test(text);
}

/** Words too common to tie two requests together. */
const COMMON_WORDS: ReadonlySet<string> = new Set([
  "about", "after", "again", "also", "always", "anymore", "been", "before", "being", "could", "does", "doesn't", "done", "down",
  "every", "from", "have", "having", "into", "just", "keeps", "more", "much", "need", "needs", "never", "only", "other",
  "over", "please", "really", "same", "should", "since", "some", "still", "than", "that", "their", "them", "then", "there",
  "these", "they", "this", "today", "very", "want", "wants", "were", "what", "when", "where", "which", "while", "will",
  "with", "won't", "work", "working", "works", "would", "your", "request", "issue", "problem", "ticket",
]);

/** The words of a summary that may tie it to another request: four letters or more, not common, without a plural "s". */
function significantWords(text: string): Set<string> {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}']+/u)
    .filter((word) => word.length >= 4 && !COMMON_WORDS.has(word))
    .map((word) => (word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
  return new Set(words);
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
