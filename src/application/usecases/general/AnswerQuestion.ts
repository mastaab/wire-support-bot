import type { GeneralAnswerService, ConversationMemberContext, GeneralAnswerOptions } from "../../ports/GeneralAnswerPort";
import type { WireOutboundPort, OutboundMention, SentMessageRef } from "../../ports/WireOutboundPort";
import type { RetrievalPort, RetrievalResult } from "../../ports/RetrievalPort";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { sameQualifiedId } from "../../../domain/ids/QualifiedId";
import { isKeyInProject } from "../../../domain/ids/jiraLink";
import { DEFAULT_PART_ASSET } from "../../../domain/entities/SupportRequest";
import type { PartAssetWording, SupportRequest, SupportRequestKind } from "../../../domain/entities/SupportRequest";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { Logger } from "../../ports/Logger";
import type { SupportTriagePort } from "../../ports/SupportTriagePort";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueReply, IssueSnapshot, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import {
  GENERIC_COMMAND_LINE, NO_CHANGE_REPLY, OFFER_TTL_MS, formatReplyQuestion, formatResolveQuestion,
  formatSupportQuestion, offerCommandLine, parseOfferMarker,
} from "../../services/offers";
import type { OfferCommand, ParsedAnswer, PendingOffer, PendingOfferStore } from "../../services/offers";
import { replaceInventedCommandLines } from "../../services/botCommandLines";
import { botActor, refreshStatusCategory } from "../jira/supportRequestStatus";
import { formatSla, statusLabel } from "../jira/formatIssue";
import { findSupportRequestInConversation } from "../jira/supportRequestScope";
import { markRepliesSeen, rememberLastMessage } from "../jira/supportRequestMarkers";
import { formatTimeInZone } from "../../services/formatTimeInZone";
import { fillMissingPartDetails, statedPartDetails } from "../../services/partDetails";
import { newOfferId, offerPromptFields, sendOfferPrompt } from "../../services/offerButtons";
import { partOrderStep } from "../../services/partOrderSteps";
import type { PartOrderStep } from "../../services/partOrderSteps";
import type { KnowledgeHelpQuestions } from "../../services/knowledgeHelpQuestions";

/**
 * Scans `text` for `@Name` tokens and returns Wire mention objects with UTF-16 offsets.
 * Only members that have both a name and a domain are eligible.
 */
function extractMentions(text: string, members: ConversationMemberContext[]): OutboundMention[] {
  const mentions: OutboundMention[] = [];
  for (const member of members) {
    if (!member.name || !member.domain) continue;
    const token = `@${member.name}`;
    let idx = text.indexOf(token);
    while (idx !== -1) {
      mentions.push({
        userId: { id: member.id, domain: member.domain },
        offset: idx,
        length: token.length,
      });
      idx = text.indexOf(token, idx + 1);
    }
  }
  return mentions;
}

export interface AnswerQuestionInput {
  question: string;
  conversationContext: string[];
  conversationId: QualifiedId;
  replyToMessageId: string;
  members?: ConversationMemberContext[];
  /** Authoritative sender of this question, independent of recent participants. */
  requester?: ConversationMemberContext;
  /**
   * The requester's offer that this message just displaced (dropped by the router), so a
   * correction such as "the description should mention X" can produce a revised offer.
   */
  pendingOffer?: OfferCommand;
  /**
   * The message reached the answer path only because it followed the requester's offer, not
   * because the bot was addressed. Nothing is sent unless it revises that offer; an empty
   * string is returned so the router can treat it as ordinary conversation.
   */
  amendOnly?: boolean;
  /** The channel's IANA timezone, in which times given to the model are shown; UTC when absent. */
  timezone?: string;
}

/**
 * The service desk for the answer path. Stored support requests of this conversation are always
 * added to the results; live ticket content is fetched only when `shareWithModel` is true.
 */
export interface AnswerQuestionJira {
  tracker: IssueTrackerPort;
  requests: SupportRequestRepository;
  /** Records the status refresh after a live read shows a changed category. */
  auditLog: AuditLogRepository;
  offers: PendingOfferStore;
  /** Pass live status, SLAs and service-desk replies of this conversation's support requests to the answer model. */
  shareWithModel: boolean;
  /**
   * Passive service-desk help is on: the operator has opted in to offers for plain problem
   * statements, so a support offer needs no raising wording in the question.
   */
  passive?: boolean;
  /** How the asset essential of a part order is named and asked for; the default wording when absent. */
  partAsset?: PartAssetWording;
  /** Delivery locations of part orders offered as buttons; the location is asked in text when absent or empty. */
  partDeliveryLocations?: readonly string[];
  /**
   * The narrow part-details extraction (the triage port): run once on the requester's message
   * when a proposed part order lacks essentials; without it the bot asks for them.
   */
  partDetails?: Pick<SupportTriagePort, "extractPartDetails">;
  /**
   * "Did this help?" after an answer that used a knowledge article (the document index on): asked
   * when the member's message describes a problem and the answer made no offer. Absent: never asked.
   */
  knowledgeHelp?: Pick<KnowledgeHelpQuestions, "ask">;
  now?: () => Date;
}

/** Newest stored support requests of the conversation added to the results. */
const STORED_REQUESTS_SHARED = 10;
/** Keys named in the question that are looked up through the scope helper. */
const NAMED_KEYS_CHECKED = 5;
/** Tickets whose live data is passed to the model. */
const TICKETS_SHARED = 3;
const REPLIES_SHARED = 3;
const SHARED_REPLY_MAX = 500;
const FALLBACK_ANSWER = "I wasn't able to generate a response.";

/**
 * Questions that may need live ticket data: Jira, service-desk or support wording, or asking
 * for the status or news of something. Other questions make no tracker call. A named project
 * key also counts (see `asksAboutTickets`).
 */
const TICKET_QUESTION = /\b(?:jira|tickets?|service\s+desk|support|requests?|issues?|slas?|repl(?:y|ies)|status|latest|news|updates?|progress|heard|answers?)\b/i;

/*
 * Change intent that the requester's own question must express before a model offer is
 * accepted. The model is untrusted and, with sharing on, reads customer-written ticket text,
 * so an offer on a question that asks for no change ("what did we decide about lunch?") is
 * dropped. A named project key also counts as a reply target (see `asksForChange`).
 */
/**
 * support: a raising verb ("raise", "open", "create", "file", "log", "submit", "report",
 * "escalate", "put ... into") followed by a service-desk target ("service desk", "support",
 * "ticket", "request", "Jira", "it with"), or "raise it"/"report it". A question about an
 * existing request ("any news on my ticket?", "is my ticket still open?") names no raising verb
 * before the target, so it does not pass. Asking the desk ("ask the service desk", "ask
 * support") and ordering a part ("order two filters", "order a replacement cable", "order
 * me the adapter") also count; "in order to" and "the order of" do not.
 */
const SUPPORT_INTENT = /\b(?:raise|open|create|file|log(?!\s+(?:in|into|on)\b)|submit|report|escalate|put\b[^.?!]*\binto)\b[^.?!]*\b(?:service\s+desk|support|tickets?|requests?|jira|it\s+with)\b|\b(?:raise|report)\s+(?:it|this)\b|\bask\s+(?:the\s+)?(?:service\s+desk|support)\b|(?<!\b(?:in|the|an|of|this|that|which|what|your|my)\s+)\b(?:re)?order(?!\s+(?:of|to|by|in|the\s+(?:list|actions?|items?|rows?))\b)\b/i;
/** resolve: "close", "resolve", "works again", "working again", "no longer needed" and their inflections. */
const RESOLVE_INTENT = /\b(?:clos(?:e|es|ed|ing)|resolv(?:e|es|ed|ing)|(?:works?|working)\s+again|no\s+longer\s+(?:needed|necessary|required))\b/i;
/** reply, first part: a verb of sending a message ("reply", "tell", "send", "let ... know", "message", "answer"). */
const REPLY_VERB = /\b(?:repl(?:y|ies|ied|ying)|tell|send|let\b.*\bknow|message|answer)\b/i;
/**
 * reply, first part (alternative): a request to add to the request, phrased as an instruction
 * at the start of the message, optionally after "please" or "can/could/would/will you": "add to
 * SD-10 that ...", "please note on SD-10 that ...", "can you leave a comment on SD-10 ...".
 * Questions about what others did ("did anyone update SD-10?", "who can update the ticket?")
 * and "add me/us" do not count, nor does an instruction that ends as a question ("note: SD-10
 * is still open, right?") unless it asks the bot ("can you add a comment on SD-10?").
 */
const ADD_REQUEST = /^(?:(?:please|pls|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:add(?!\s+(?:me|us)\b)|comment|note|update(?!\s+(?:me|us|them|him|her)\b)|(?:leave|post|put|write)\s+(?:a|an)\s+(?:note|comment))\b/i;
const ASKS_BOT = /^(?:(?:please|pls|kindly)\s+)?(?:can|could|would|will)\s+you\b/i;

/** True when the question asks the bot to add something to a request (see `ADD_REQUEST`). */
function asksToAdd(question: string): boolean {
  const text = question.trim();
  return ADD_REQUEST.test(text) && (!text.endsWith("?") || ASKS_BOT.test(text));
}
/** reply, second part: the service desk as recipient. */
const REPLY_TARGET = /\b(?:service\s+desk|support|jira|tickets?)\b/i;

/** A validated offer and the code-written question that asks the requester to confirm it. */
interface PreparedOffer {
  question: string;
  /** Sent with buttons: [Yes] [No], or the options in `offer.choices`. */
  buttons: boolean;
  offer: PendingOffer;
  /** The request of this conversation the question names (reply and resolve offers). */
  requestKey?: string;
}

/** One model answer as the use case reads it. */
interface Proposal {
  parsed: ParsedAnswer;
  command: OfferCommand | null;
  prepared: PreparedOffer | null;
}

/** Live data for one support request, and its record when the read refreshed the stored category. */
interface LiveTicket {
  key: string;
  result: RetrievalResult;
  refreshed: SupportRequest | null;
  /** The public replies passed to the model. */
  replies: IssueReply[];
}

/** The support request results for the model, and the live tickets among them. */
interface SupportRequestContext {
  results: RetrievalResult[];
  live: LiveTicket[];
}

/**
 * Answers a question addressed to the bot using the answer model. The model sees the recent
 * conversation and retrieval results: the results of the optional retrieval source (for
 * example a knowledge base) and the stored support requests of this conversation, plus live
 * data for some of them only with sharing enabled. A
 * model-proposed offer is validated by code and turned into a code-written confirmation
 * question. This path never writes to the tracker; its only record write is the status refresh.
 */
export class AnswerQuestion {
  constructor(
    private readonly generalAnswer: GeneralAnswerService,
    private readonly wireOutbound: WireOutboundPort,
    private readonly jira: AnswerQuestionJira,
    private readonly retrieval?: RetrievalPort,
    private readonly logger?: Logger,
  ) {}

  async execute(input: AnswerQuestionInput): Promise<string> {
    let retrievalResults: RetrievalResult[] = [];
    // Knowledge articles passed to the model, which make the answer one "Did this help?" may follow.
    let articles = 0;

    if (this.retrieval) {
      try {
        retrievalResults = await this.retrieval.retrieve({
          question: input.question,
          conversationId: input.conversationId,
          ...(input.requester?.domain ? { requesterId: { id: input.requester.id, domain: input.requester.domain } } : {}),
        });
      } catch (err) {
        // Non-fatal: answer without the source's results rather than failing.
        this.logger?.warn("AnswerQuestion: retrieval failed, answering without it", { err: (err instanceof Error ? err.name : "UnknownError") });
      }
      articles = retrievalResults.filter((result) => result.type === "knowledge_article").length;
    }

    const now = (this.jira.now ?? (() => new Date()))();
    const context = await this.supportRequestContext(this.jira, input);
    const live = context.live;
    retrievalResults = [...retrievalResults, ...context.results];
    retrievalResults.push(channelTimezoneResult(input.timezone ?? "UTC", now));
    const amended = amendableOffer(input.pendingOffer);
    if (amended) retrievalResults.push(pendingOfferResult(amended, now));

    const ask = (options?: GeneralAnswerOptions) => this.generalAnswer.answer(
      input.question,
      input.conversationContext,
      retrievalResults,
      input.members,
      input.requester,
      ...(options ? [options] : []),
    );

    // The raw marker is never sent, whether or not the offer is valid.
    let { parsed, command, prepared } = await this.proposal(await ask(), input);
    // A clear request to raise, order, reply or resolve that got no offer (the small model may
    // answer with a command instead) is asked once more; the second answer is used only when it
    // carries a valid offer, otherwise the first answer stands.
    if (!parsed.hadMarker && !input.amendOnly && asksForAnyChange(input.question, this.jira.tracker.projectKey)) {
      this.logger?.debug("AnswerQuestion: no offer for a clear request, asking again");
      const second = await this.proposal(await ask({ requireOffer: true }), input);
      if (second.prepared) ({ parsed, command, prepared } = second);
    }
    // A suggested bot command that does not exist is replaced by a supported command line.
    const text = replaceInventedCommandLines(parsed.text || FALLBACK_ANSWER, this.jira.tracker.projectKey);
    if (input.amendOnly && !(prepared && command && isRevision(input.pendingOffer, command)
        && !sameCommand(input.pendingOffer, command))) {
      // Unaddressed chat after an offer ("lunch at noon?") is not for the bot, and repeating the
      // same offer would make it follow every message; only a real revision is sent.
      return "";
    }
    if (!prepared && parsed.hadMarker) {
      // The model meant to propose a change that code did not accept. Its text may claim the
      // change ("Updated with that detail."), so only a code-written reply is sent.
      const line = command ? offerCommandLine(command, this.jira.tracker.projectKey) : GENERIC_COMMAND_LINE;
      const reply = `${NO_CHANGE_REPLY}\n${line}`;
      await this.send(input, reply, false);
      return reply;
    }
    if (!prepared) {
      const sent = await this.send(input, text, true);
      await this.rememberAnswer(this.jira, input, text, sent, live);
      if (articles > 0 && parsed.text) await this.askWhetherItHelped(input);
      return text;
    }

    // Only the code-written question is sent: the model's own lead-in can imply the change
    // already happened ("I'll send that ..."), which is wrong until the requester confirms.
    // No mentions: a quoted summary or reply body may contain @names that must not ping members.
    // The offer is stored only after the question was sent, so it is never confirmable unseen.
    // A yes-or-no question goes with [Yes] [No] and a part order's quantity or delivery location
    // with its options; a question for free-text part details has no buttons.
    const offerId = prepared.buttons ? newOfferId() : undefined;
    const sent = offerId
      ? await sendOfferPrompt(this.wireOutbound, input.conversationId, prepared.question, offerId, prepared.offer.choices, input.replyToMessageId)
      : await this.send(input, prepared.question, false);
    this.jira.offers.put({ ...prepared.offer, ...offerPromptFields(offerId, sent, prepared.question) });
    // A reply or resolve question names a request of this conversation (checked by the scope
    // helper). Asked without buttons, it becomes that request's last message, quoted by the next
    // watch update; a button question is not, since it is edited when it closes, so the request
    // keeps its previous last message.
    if (prepared.requestKey && !offerId) {
      await rememberLastMessage(this.jira.requests, prepared.requestKey, sent, "AnswerQuestion", this.logger);
    }
    return prepared.question;
  }

  /**
   * After an answer that used a knowledge article and made no offer: asks the member "Did this
   * help?" when their message may describe a problem. A how-to question ("how do I reset the
   * dashboard?") and a message about a named request ("any news on SD-42?") are not one, and are
   * never sent to the triage; `KnowledgeHelpQuestions` asks only when the triage drafts a fault.
   * Never fails the answer.
   */
  private async askWhetherItHelped(input: AnswerQuestionInput): Promise<void> {
    const help = this.jira.knowledgeHelp;
    const requester = input.requester;
    if (!help || !requester?.domain || input.amendOnly) return;
    const question = input.question.trim();
    if (HOW_TO_QUESTION.test(question) || namedKeys(question, this.jira.tracker.projectKey).length > 0) {
      this.logger?.debug("AnswerQuestion: not a problem description; not asking whether the answer helped");
      return;
    }
    try {
      await help.ask({
        message: question,
        conversationId: input.conversationId,
        requesterId: { id: requester.id, domain: requester.domain },
        ...(requester.name ? { requesterName: requester.name } : {}),
        replyToMessageId: input.replyToMessageId,
      });
    } catch (err) {
      this.logger?.warn("AnswerQuestion: asking whether the answer helped failed", { err: err instanceof Error ? err.name : "UnknownError" });
    }
  }

  /** The model's answer without its marker, its command and, when code accepts it, the prepared offer. */
  private async proposal(answer: string, input: AnswerQuestionInput): Promise<Proposal> {
    const parsed = parseOfferMarker(answer);
    const command = parsed.command ? await this.proposedCommand(parsed.command, input) : null;
    const prepared = command ? await this.prepareOffer(this.jira, input, command) : null;
    return { parsed, command, prepared };
  }

  /**
   * The model's command with the part essentials it may keep: those stated in this message, the
   * pending draft's earlier ones, and, when the order still lacks some, those the narrow
   * extraction finds in this message (never replacing a value the offer has).
   */
  private async proposedCommand(proposed: OfferCommand, input: AnswerQuestionInput): Promise<OfferCommand> {
    const command = withPendingDetails(input.pendingOffer, withStatedPart(proposed, input.question));
    return fillMissingPartDetails(command, input.question, this.jira.partDetails, (err) => {
      this.logger?.warn("AnswerQuestion: extractPartDetails failed", { err: err instanceof Error ? err.name : "UnknownError" });
    });
  }

  private async send(input: AnswerQuestionInput, text: string, withMentions: boolean): Promise<SentMessageRef | undefined> {
    const mentions = withMentions ? extractMentions(text, input.members ?? []) : [];
    return this.wireOutbound.sendPlainText(input.conversationId, text, {
      replyToMessageId: input.replyToMessageId,
      mentions: mentions.length > 0 ? mentions : undefined,
    });
  }

  /**
   * After the model's answer was sent: each support request of this conversation it names
   * (checked by the scope helper, so another channel's key is ignored) gets the answer as its
   * last message, and the replies of the live tickets the answer names count as shown, so the
   * watch does not announce them again. Replies of a ticket the answer leaves out stay unseen:
   * the model may not have repeated them. Bookkeeping failures are logged and never change the answer.
   */
  private async rememberAnswer(
    jira: AnswerQuestionJira, input: AnswerQuestionInput, text: string, sent: SentMessageRef | undefined, live: readonly LiveTicket[],
  ): Promise<void> {
    if (sent) {
      for (const key of namedKeys(text, jira.tracker.projectKey).slice(0, NAMED_KEYS_CHECKED)) {
        let request: SupportRequest | null;
        try {
          request = await findSupportRequestInConversation(jira.requests, key, input.conversationId, jira.tracker.projectKey);
        } catch (err) {
          this.logger?.warn("AnswerQuestion: support request lookup failed", { err: err instanceof Error ? err.name : "UnknownError" });
          continue;
        }
        if (request) await rememberLastMessage(jira.requests, request.key, sent, "AnswerQuestion", this.logger);
      }
    }
    const named = namedKeys(text, jira.tracker.projectKey);
    for (const ticket of live.filter((t) => named.includes(t.key.toUpperCase()))) {
      await markRepliesSeen(jira.requests, ticket.key, ticket.replies, "AnswerQuestion", this.logger);
    }
  }


  /**
   * Support requests of this conversation for the model: the stored records (keys named in the
   * question first, then the newest ones), independent of sharing, and, with sharing on and a
   * ticket-type question, live data for at most three of them. Named keys go through the scope
   * helper, so another channel's key is neither shown nor fetched.
   */
  private async supportRequestContext(jira: AnswerQuestionJira, input: AnswerQuestionInput): Promise<SupportRequestContext> {
    const projectKey = jira.tracker.projectKey;
    const named: SupportRequest[] = [];
    let recent: SupportRequest[] = [];
    try {
      for (const key of namedKeys(input.question, projectKey).slice(0, NAMED_KEYS_CHECKED)) {
        const request = await findSupportRequestInConversation(jira.requests, key, input.conversationId, projectKey);
        if (request) named.push(request);
      }
      recent = inConversation(await jira.requests.listByConversation(input.conversationId, { limit: STORED_REQUESTS_SHARED }), input.conversationId, projectKey);
    } catch (err) {
      this.logger?.warn("AnswerQuestion: support request lookup failed", { err: err instanceof Error ? err.name : "UnknownError" });
    }
    const known = uniqueByKey([...named, ...recent]);
    if (!jira.shareWithModel || !asksAboutTickets(input.question, projectKey)) {
      return { results: known.map((request) => storedRequestResult(request)), live: [] };
    }

    let open: SupportRequest[] = [];
    try {
      open = inConversation(await jira.requests.listByConversation(input.conversationId, { openOnly: true, limit: TICKETS_SHARED }), input.conversationId, projectKey)
        .filter((request) => request.statusCategory !== "done");
    } catch (err) {
      this.logger?.warn("AnswerQuestion: support request lookup failed", { err: err instanceof Error ? err.name : "UnknownError" });
    }
    const live = await this.liveTickets(jira, input, uniqueByKey([...named, ...open]).slice(0, TICKETS_SHARED));
    // A refreshed record replaces the stored one, so the model never sees a stale category next to live data.
    for (const { refreshed } of live) {
      if (!refreshed) continue;
      const index = known.findIndex((request) => request.key === refreshed.key);
      if (index >= 0) known[index] = refreshed;
    }
    return {
      results: [...known.map((request) => storedRequestResult(request)), ...live.map((ticket) => ticket.result)],
      live,
    };
  }

  /**
   * Live status, SLAs and public service-desk replies of the given support requests (the port
   * never returns internal notes). A read that shows a changed category refreshes the stored
   * one. The content goes to the model only; it is never stored or logged.
   */
  private async liveTickets(jira: AnswerQuestionJira, input: AnswerQuestionInput, requests: readonly SupportRequest[]): Promise<LiveTicket[]> {
    const now = (jira.now ?? (() => new Date()))();
    const tickets = await Promise.all(requests.map(async (request): Promise<LiveTicket | null> => {
      let snapshot: IssueSnapshot | null;
      let replies: IssueReply[];
      try {
        [snapshot, replies] = await Promise.all([
          jira.tracker.getIssue(request.key),
          jira.tracker.listCustomerReplies(request.key, REPLIES_SHARED),
        ]);
      } catch (err) {
        this.logger?.warn("AnswerQuestion: ticket read failed", trackerErrorFields(err));
        return null;
      }
      if (!snapshot) return null;
      return {
        key: request.key,
        replies,
        result: {
          id: request.key,
          type: "live_ticket",
          content: ticketContent(snapshot, replies, input.timezone ?? "UTC"),
          sourceDate: now,
        },
        refreshed: await refreshStatusCategory(
          jira.requests, jira.auditLog, request, snapshot.statusCategory, botActor(input.conversationId), this.logger, now,
        ),
      };
    }));
    return tickets.filter((t): t is LiveTicket => t !== null);
  }

  /**
   * Validates a model-proposed offer. Returns the offer with its code-written question, or null
   * when the offer is dropped. Nothing is stored here: the caller stores the offer after sending.
   */
  private async prepareOffer(jira: AnswerQuestionJira, input: AnswerQuestionInput, command: OfferCommand): Promise<PreparedOffer | null> {
    // A revision of the offer this message displaced needs no fresh change intent: the
    // original offer established it. Scope and bounds are still checked below.
    const passiveSupport = command.kind === "support" && jira.passive === true;
    const revision = isRevision(input.pendingOffer, command);
    // A how-to question ("how do I order a part?") never gets an offer, also with passive help on.
    if (!revision && HOW_TO_QUESTION.test(input.question.trim())) {
      this.logger?.warn("AnswerQuestion: offer dropped, the question asks for no change", { kind: command.kind });
      return null;
    }
    if (!passiveSupport && !revision && !asksForChange(command.kind, input.question, jira.tracker.projectKey)) {
      this.logger?.warn("AnswerQuestion: offer dropped, the question asks for no change", { kind: command.kind });
      return null;
    }

    const requester = input.requester;
    let question: string | null = null;
    let requestKey: string | undefined;
    let step: Pick<PartOrderStep, "buttons" | "choices" | "fillsPart"> = { buttons: true };
    if (requester?.domain) {
      try {
        const validated = await this.offerQuestion(jira, command, input.conversationId);
        question = validated?.question ?? null;
        requestKey = validated?.requestKey;
        if (validated?.step) step = validated.step;
      } catch (err) {
        this.logger?.warn("AnswerQuestion: offer validation failed", { kind: command.kind, err: err instanceof Error ? err.name : "UnknownError" });
        return null;
      }
    }
    if (!question || !requester?.domain) {
      this.logger?.warn("AnswerQuestion: offer dropped", { kind: command.kind });
      return null;
    }

    const now = (jira.now ?? (() => new Date()))();
    return {
      question,
      buttons: step.buttons,
      ...(requestKey ? { requestKey } : {}),
      offer: {
        command,
        conversationId: input.conversationId,
        requesterId: { id: requester.id, domain: requester.domain },
        createdAt: now,
        expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
        ...(step.choices ? { choices: step.choices } : {}),
        ...(step.fillsPart ? { fillsPart: step.fillsPart } : {}),
      },
    };
  }

  /**
   * Validates the proposed command against the records; returns the question and, for a reply
   * or resolve, the key of the request of this conversation it names, or null when invalid.
   * Every question ends with "?" so the router treats a non-exact answer as a follow-up.
   */
  private async offerQuestion(
    jira: AnswerQuestionJira, command: OfferCommand, conversationId: QualifiedId,
  ): Promise<{ question: string; requestKey?: string; step?: PartOrderStep } | null> {
    if (command.kind === "support") {
      const asset = jira.partAsset ?? DEFAULT_PART_ASSET;
      if (command.requestKind !== "part") {
        return { question: formatSupportQuestion(command.summary, command.description, command.requestKind, command.part, asset) };
      }
      // An incomplete part order is stored as an amendable draft that asks its next question:
      // the requester's answer, typed or clicked, fills it.
      const step = partOrderStep(command, asset, jira.partDeliveryLocations ?? []);
      return { question: step.question, step };
    }

    const request = await findSupportRequestInConversation(jira.requests, command.issueKey, conversationId, jira.tracker.projectKey);
    if (!request) return null;
    if (command.kind === "reply") return { question: formatReplyQuestion(request.key, request.summary, command.body), requestKey: request.key };
    // Only code offers attachments; the answer model never proposes one.
    if (command.kind === "attach") return null;
    // A request last known as done is not dropped: the desk may have reopened it, and the use case checks live.
    return { question: formatResolveQuestion(request.key, request.summary, command.comment), requestKey: request.key };
  }
}

/** Keys of the configured project named in the text, upper-cased, in order, without repeats. */
function namedKeys(text: string, projectKey: string): string[] {
  const escaped = projectKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}-\\d+\\b`, "gi");
  const keys: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const key = match[0].toUpperCase();
    if (isKeyInProject(key, projectKey) && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** True when the question may need live ticket data (see `TICKET_QUESTION`). */
function asksAboutTickets(question: string, projectKey: string): boolean {
  return TICKET_QUESTION.test(question) || namedKeys(question, projectKey).length > 0;
}

/** A question about how to do something ("how do I raise a ticket?"), which asks for no change itself. */
const HOW_TO_QUESTION = /^(?:(?:hi|hey|hello)\b[,!]?\s*)?how\s+(?:do|can|could|should|would|does|did)\s+(?:i|we|you|one|people|someone|anyone)\b/i;

/**
 * True when the requester's message clearly asks to raise, order, reply to or resolve something:
 * the change intent of an offer kind (see `asksForChange`), but not a how-to question.
 */
function asksForAnyChange(question: string, projectKey: string): boolean {
  if (HOW_TO_QUESTION.test(question.trim())) return false;
  return (["support", "reply", "resolve"] as const).some((kind) => asksForChange(kind, question, projectKey));
}

/** True when the requester's question expresses the change that the offer proposes. */
function asksForChange(kind: OfferCommand["kind"], question: string, projectKey: string): boolean {
  // "How do I order a part?" asks how, not for an order, so it never accepts an offer.
  if (HOW_TO_QUESTION.test(question.trim())) return false;
  switch (kind) {
    case "support":
      return SUPPORT_INTENT.test(question);
    case "resolve":
      return RESOLVE_INTENT.test(question);
    case "reply":
      return (REPLY_VERB.test(question) || asksToAdd(question))
        && (REPLY_TARGET.test(question) || namedKeys(question, projectKey).length > 0);
    case "attach":
      return false;
  }
}

/**
 * The displaced offer when the requester may amend it: `support`, `reply` and `resolve`, so a
 * plain resolve offer can gain a closing comment. An attachment is fixed and cannot be amended.
 */
function amendableOffer(pending: OfferCommand | undefined): OfferCommand | null {
  return pending && pending.kind !== "attach" ? pending : null;
}

/**
 * True when `command` revises the amendable displaced offer: the same kind and, for a reply or
 * a resolve, the same request.
 */
function isRevision(pending: OfferCommand | undefined, command: OfferCommand): boolean {
  const amended = amendableOffer(pending);
  if (!amended || amended.kind !== command.kind) return false;
  if (amended.kind === "support") {
    // The same kind of request: turning a part order into a fault would skip its essentials.
    return command.kind === "support" && amended.requestKind === command.requestKind;
  }
  if (amended.kind === "reply") return command.kind === "reply" && amended.issueKey === command.issueKey;
  return command.kind === "resolve" && amended.issueKey === command.issueKey;
}

/** A part order keeps only the essentials the requester's message states (see `statedPartDetails`). */
function withStatedPart(command: OfferCommand, message: string): OfferCommand {
  if (command.kind !== "support" || command.requestKind !== "part") return command;
  const part = statedPartDetails(command.part, message);
  if (Object.keys(part).length > 0) return { ...command, part };
  const { part: _dropped, ...rest } = command;
  return rest;
}

/**
 * A revised part order keeps the essentials already given: the model may return only the
 * ones the message adds, and a detail the requester gave earlier must not be asked for again.
 */
function withPendingDetails(pending: OfferCommand | undefined, command: OfferCommand): OfferCommand {
  if (pending?.kind !== "support" || pending.requestKind !== "part" || command.kind !== "support" || command.requestKind !== "part") return command;
  const part = { ...(pending.part ?? {}), ...(command.part ?? {}) };
  return Object.keys(part).length > 0 ? { ...command, part } : command;
}

/** True when both commands propose exactly the same change. */
function sameCommand(a: OfferCommand | undefined, b: OfferCommand): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

/** The displaced offer for the model, so the requester's correction can produce a revised offer. */
function pendingOfferResult(command: OfferCommand, now: Date): RetrievalResult {
  return {
    id: "pending-offer",
    type: "context",
    content: `Pending offer being amended (not confirmed, nothing was sent; the requester's message changes it): ${JSON.stringify(command)}`,
    sourceDate: now,
  };
}

/** The channel's timezone for the model, so it reads and states times of day in that zone. */
function channelTimezoneResult(timezone: string, now: Date): RetrievalResult {
  return {
    id: "channel-timezone",
    type: "context",
    content: `This channel's timezone is ${timezone}; times of day in service-desk replies are shown in it.`,
    sourceDate: now,
  };
}

/** Only not-deleted records of this conversation and project, whatever the repository returned. */
function inConversation(requests: readonly SupportRequest[], conversationId: QualifiedId, projectKey: string): SupportRequest[] {
  return requests.filter((request) =>
    !request.deleted && sameQualifiedId(request.conversationId, conversationId) && isKeyInProject(request.key, projectKey));
}

/** The first record per key, in order. */
function uniqueByKey(requests: readonly SupportRequest[]): SupportRequest[] {
  const seen = new Set<string>();
  return requests.filter((request) => {
    if (seen.has(request.key)) return false;
    seen.add(request.key);
    return true;
  });
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The kind of a stored request as the model reads it. */
const KIND_LABEL: Record<SupportRequestKind, string> = {
  question: "question",
  part: "part order",
  fault: "fault",
};

/** The stored record for the model: key, summary, kind, requester name and last known status only. */
function storedRequestResult(request: SupportRequest): RetrievalResult {
  const requesterName = request.requesterName.trim();
  return {
    id: request.key,
    type: "support_request",
    content: [
      request.key,
      `Summary: ${oneLine(request.summary)}`,
      `Kind: ${KIND_LABEL[request.kind]}`,
      ...(requesterName ? [`Requested by: ${requesterName}`] : []),
      `Last known status: ${statusLabel(request.statusCategory)}`,
    ].join(" | "),
    sourceDate: request.createdAt,
  };
}

/** Compact ticket text for the model. Uses the English status label, never the tracker's status name. */
function ticketContent(snapshot: IssueSnapshot, replies: readonly IssueReply[], timezone: string): string {
  const replyLines = replies.map((reply) => {
    const author = reply.fromThisBot ? "your team via Wire" : reply.author;
    const body = oneLine(reply.body);
    const text = body.length <= SHARED_REPLY_MAX ? body : `${body.slice(0, SHARED_REPLY_MAX - 3).trimEnd()}...`;
    return `Reply from ${author} at ${formatTimeInZone(reply.created, timezone, "dayMonth")}: ${text}`;
  });
  return [
    `${snapshot.key}: ${snapshot.summary}`,
    `Status: ${statusLabel(snapshot.statusCategory)}`,
    ...snapshot.slas.map(formatSla),
    ...(replyLines.length > 0 ? replyLines : ["No service-desk replies yet."]),
  ].join("\n");
}
