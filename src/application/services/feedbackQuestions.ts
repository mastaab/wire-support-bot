import type { QualifiedId } from "../../domain/ids/QualifiedId";
import { FEEDBACK_RATINGS } from "../ports/IssueTrackerPort";
import type { DeskUpdateTarget, OfferChoice, PendingOfferStore } from "../ports/PendingOfferPort";
import type { SentMessageRef, WireOutboundPort } from "../ports/WireOutboundPort";
import type { Logger } from "../ports/Logger";
import { newOfferId, offerPromptFields, sendOfferPrompt } from "./offerButtons";
import { closeEndedOfferPrompts } from "./offerPromptClosing";

/**
 * The satisfaction rating after a solved request (WIRE_SUPPORT_BOT_JIRA_FEEDBACK=on). When the
 * requester answers [Solved] to a desk-update question, or any resolve from Wire reached done (the
 * resolve command, a yes to a resolve offer, [Solved, close it]; asked by `ResolveSupportRequest`,
 * also when another member resolved), the bot asks the request's requester how the service desk
 * did, [1] to [5]. A rating is sent to the request's feedback in
 * Jira by `SubmitFeedback`; "no" or any other message only ends the question. Like a desk-update
 * question it goes only to the requester, lives as long as one, is not asked over another open
 * question of theirs, and a newer question replaces it.
 */

/** Words that pick a rating in text, besides its number. */
const RATING_WORDS: Readonly<Record<number, readonly string[]>> = {
  1: ["one", "1/5"],
  2: ["two", "2/5"],
  3: ["three", "3/5"],
  4: ["four", "4/5"],
  5: ["five", "5/5"],
};

/**
 * The question as sent without buttons, with its text answer hint in the last paragraph; sent with
 * buttons the hint is left out. Names the requester, since every member sees it.
 */
export function feedbackQuestion(issueKey: string, requesterName?: string): string {
  const name = requesterName?.trim();
  const lead = name ? `${name}, how did the service desk do on **${issueKey}**?` : `How did the service desk do on **${issueKey}**?`;
  return `${lead} 1 is poor, 5 is great.\n\n(1 to 5, or no)?`;
}

/** The options [1] to [5], in button order; each sends its rating. */
export function feedbackChoices(issueKey: string): OfferChoice[] {
  return FEEDBACK_RATINGS.map((rating) => ({
    label: String(rating),
    answers: [String(rating), ...(RATING_WORDS[rating] ?? [])],
    command: null,
    then: { kind: "rate", issueKey, rating },
  }));
}

export interface FeedbackQuestionsDeps {
  offers: PendingOfferStore;
  wireOutbound: WireOutboundPort;
  /** How long the question can be answered. */
  lifetimeMs: number;
  logger?: Logger;
  now?: () => Date;
}

export interface FeedbackQuestionInput {
  target: DeskUpdateTarget;
  conversationId: QualifiedId;
  requesterId: QualifiedId;
  requesterName?: string;
}

/** Asks the requester for a satisfaction rating of a solved request. */
export class FeedbackQuestions {
  constructor(private readonly deps: FeedbackQuestionsDeps) {}

  /**
   * Sends the rating question and stores it for the requester. Nothing is asked over their other
   * open question (one that is not itself a question the bot asked on its own). A failure is logged
   * by error name and changes nothing else. True when the question was stored.
   */
  async ask(input: FeedbackQuestionInput): Promise<boolean> {
    const { target, conversationId, requesterId } = input;
    const key = target.issueKey;
    if (this.busy(conversationId, requesterId)) {
      this.deps.logger?.info("FeedbackQuestions: the requester has an open question; not asking", { key });
      return false;
    }
    const question = feedbackQuestion(key, input.requesterName);
    const choices = feedbackChoices(key);
    const offerId = newOfferId();
    let sent: SentMessageRef | undefined;
    try {
      sent = await sendOfferPrompt(this.deps.wireOutbound, conversationId, question, offerId, choices);
    } catch (err) {
      this.deps.logger?.warn("FeedbackQuestions: sending the question failed", { key, err: errorName(err) });
      return false;
    }
    const now = this.now();
    this.deps.offers.put({
      // Remembered as declined once dropped or expired: nothing to confirm later.
      command: { kind: "reply", issueKey: key, body: "" },
      conversationId,
      requesterId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.deps.lifetimeMs),
      ...offerPromptFields(offerId, sent, question),
      choices,
      deskUpdate: target,
    });
    try {
      await closeEndedOfferPrompts({ offers: this.deps.offers, wireOutbound: this.deps.wireOutbound, logger: this.deps.logger });
    } catch (err) {
      this.deps.logger?.warn("FeedbackQuestions: closing ended questions failed", { err: errorName(err) });
    }
    return true;
  }

  private busy(conversationId: QualifiedId, requesterId: QualifiedId): boolean {
    const live = this.deps.offers.find(conversationId, requesterId, this.now());
    return !!live && (!live.deskUpdate || !!live.keepsSlot);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
