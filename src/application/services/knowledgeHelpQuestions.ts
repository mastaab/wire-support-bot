import type { QualifiedId } from "../../domain/ids/QualifiedId";
import { SUPPORT_SUMMARY_MAX } from "../../domain/entities/SupportRequest";
import type { OfferChoice, PendingOfferStore, SupportOfferCommand } from "../ports/PendingOfferPort";
import type { SupportDraft, SupportTriagePort } from "../ports/SupportTriagePort";
import type { SentMessageRef, WireOutboundPort } from "../ports/WireOutboundPort";
import type { Logger } from "../ports/Logger";
import { OFFER_DESCRIPTION_MAX } from "./offers";
import { holdsQuestionSlot, newOfferId, offerPromptFields, sendOfferPrompt, withoutAnswerHint } from "./offerButtons";
import { REPLACED_LINE, closeEndedOfferPrompts, closedPromptText } from "./offerPromptClosing";

/**
 * "Did this help?" after an answer from the document index (WIRE_SUPPORT_BOT_KNOWLEDGE=on). When
 * the answer path answered a member's problem with at least one knowledge article and made no
 * offer, the bot asks the member under its answer: [Solved] [Raise a ticket]. [Solved] only closes
 * the question; [Raise a ticket] offers to raise the problem with [Yes] [No], like an offer of the
 * answer path, so nothing reaches the service desk before that yes. Whether the message describes
 * a problem is decided by the support triage that passive help uses: only a draft of kind "fault"
 * counts, and that draft is the request [Raise a ticket] offers. Like a desk-update question it goes
 * only to the member who asked, is never asked over another open question of theirs, and a newer
 * question replaces it; a message that picks no option ends it.
 */

/** Text answers that pick [Solved], besides its number. */
const SOLVED_ANSWERS: readonly string[] = [
  "solved", "yes", "yep", "yeah", "it did", "yes it did", "it helped", "that helped", "helped", "thanks", "thank you",
  "fixed", "it's fixed", "it's solved", "it works", "it works now", "works now",
];

/** Text answers that pick [Raise a ticket], besides its number. */
const TICKET_ANSWERS: readonly string[] = [
  "raise a ticket", "ticket", "a ticket", "raise one", "raise it", "no", "nope", "still broken", "not solved", "not fixed",
  "it didn't help", "didn't help", "it did not help", "no it didn't", "still not working", "not working",
];

/**
 * The question as sent without buttons, with its text answer hint in the last paragraph; sent with
 * buttons the hint is left out. Names the member, since every member sees it.
 */
export function knowledgeHelpQuestion(requesterName?: string): string {
  const name = requesterName?.trim();
  return `${name ? `${name}, did this help?` : "Did this help?"}\n\n(solved or ticket)?`;
}

/** The options [Solved] [Raise a ticket], in button order; [Raise a ticket] offers `command`. */
export function knowledgeHelpChoices(command: SupportOfferCommand): OfferChoice[] {
  return [
    { label: "Solved", answers: SOLVED_ANSWERS, command: null },
    { label: "Raise a ticket", answers: TICKET_ANSWERS, command: null, then: { kind: "offerRaise", command } },
  ];
}

/**
 * The request [Raise a ticket] offers, from the triage draft of the member's message: only a fault
 * (a question to the desk, a part order, a resolve or nothing at all asks nothing), within the
 * bounds of an offer of the answer path. Null otherwise.
 */
export function faultCommand(draft: SupportDraft | null): SupportOfferCommand | null {
  if (!draft || draft.requestKind !== "fault" || draft.resolves) return null;
  const summary = typeof draft.summary === "string" ? draft.summary.replace(/\s+/g, " ").trim() : "";
  const description = typeof draft.description === "string" ? draft.description.trim() : "";
  if (!summary || summary.length > SUPPORT_SUMMARY_MAX) return null;
  if (!description || description.length > OFFER_DESCRIPTION_MAX) return null;
  return { kind: "support", requestKind: "fault", summary, description };
}

export interface KnowledgeHelpQuestionsDeps {
  offers: PendingOfferStore;
  wireOutbound: WireOutboundPort;
  /** The support triage of passive help: decides whether the message describes a fault, and drafts it. */
  triage: Pick<SupportTriagePort, "draftRequest">;
  /** How long the question can be answered. */
  lifetimeMs: number;
  logger?: Logger;
  now?: () => Date;
}

export interface KnowledgeHelpInput {
  /** The member's message the answer replied to. */
  message: string;
  conversationId: QualifiedId;
  requesterId: QualifiedId;
  requesterName?: string;
  /** The member's message; the question is sent as a reply to it, like the answer. */
  replyToMessageId?: string;
}

/** Asks the member whether an answer from the document index helped. */
export class KnowledgeHelpQuestions {
  constructor(private readonly deps: KnowledgeHelpQuestionsDeps) {}

  /**
   * Drafts the member's message with the triage and, for a fault, sends the question and stores it.
   * Nothing is asked over their other open question (one that is not itself a question the bot asked
   * on its own). A failure is logged by error name and changes nothing else. True when the question
   * was stored.
   */
  async ask(input: KnowledgeHelpInput): Promise<boolean> {
    if (this.deps.lifetimeMs <= 0) return false;
    const { conversationId, requesterId } = input;
    if (this.busy(conversationId, requesterId)) {
      this.deps.logger?.debug("KnowledgeHelpQuestions: the member has an open question; not asking");
      return false;
    }
    let draft: SupportDraft | null;
    try {
      // No open requests are listed: the draft is a new request, never an addition or a resolve.
      draft = await this.deps.triage.draftRequest(input.message, []);
    } catch (err) {
      this.deps.logger?.warn("KnowledgeHelpQuestions: draftRequest failed", { err: errorName(err) });
      return false;
    }
    const command = faultCommand(draft);
    if (!command) {
      this.deps.logger?.debug("KnowledgeHelpQuestions: the message describes no fault; not asking", { kind: draft?.requestKind ?? null });
      return false;
    }
    const question = knowledgeHelpQuestion(input.requesterName);
    const choices = knowledgeHelpChoices(command);
    const offerId = newOfferId();
    let sent: SentMessageRef | undefined;
    try {
      sent = await sendOfferPrompt(this.deps.wireOutbound, conversationId, question, offerId, choices, input.replyToMessageId);
    } catch (err) {
      this.deps.logger?.warn("KnowledgeHelpQuestions: sending the question failed", { err: errorName(err) });
      return false;
    }
    // Another question may have been asked meanwhile (the watch runs beside the conversation's
    // messages); it is kept, and this one is closed at once.
    if (this.busy(conversationId, requesterId)) {
      this.deps.logger?.debug("KnowledgeHelpQuestions: another question was asked meanwhile; closing this one");
      if (sent) await this.closeUnstored(conversationId, sent.messageId, question);
      return false;
    }
    const now = this.now();
    this.deps.offers.put({
      command,
      conversationId,
      requesterId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.deps.lifetimeMs),
      ...offerPromptFields(offerId, sent, question),
      choices,
      knowledgeHelp: true,
    });
    // An earlier question the bot asked on its own was replaced: close it now, not at the next sweep.
    try {
      await closeEndedOfferPrompts({ offers: this.deps.offers, wireOutbound: this.deps.wireOutbound, logger: this.deps.logger });
    } catch (err) {
      this.deps.logger?.warn("KnowledgeHelpQuestions: closing ended questions failed", { err: errorName(err) });
    }
    return true;
  }

  private busy(conversationId: QualifiedId, requesterId: QualifiedId): boolean {
    return holdsQuestionSlot(this.deps.offers.find(conversationId, requesterId, this.now()));
  }

  private async closeUnstored(conversationId: QualifiedId, messageId: string, question: string): Promise<void> {
    try {
      await this.deps.wireOutbound.closeButtonPrompt(conversationId, messageId, closedPromptText(withoutAnswerHint(question), REPLACED_LINE));
    } catch (err) {
      this.deps.logger?.warn("Closing a button question failed", { err: errorName(err) });
    }
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
