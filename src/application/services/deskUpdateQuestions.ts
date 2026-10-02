import type { SupportRequest } from "../../domain/entities/SupportRequest";
import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { DeskUpdateTarget, OfferChoice, OfferCommand, PendingOfferStore, ReplyTextPrompt } from "../ports/PendingOfferPort";
import type { SentMessageRef, WireOutboundPort } from "../ports/WireOutboundPort";
import type { Logger } from "../ports/Logger";
import { newOfferId, offerPromptFields, sendOfferPrompt, withoutAnswerHint } from "./offerButtons";
import { REPLACED_LINE, closeEndedOfferPrompts, closedPromptText } from "./offerPromptClosing";

/**
 * Questions after a desk update. When the watch has posted a desk reply or a resolve by the
 * service desk, it asks the request's requester, in a separate short button message, what they
 * want to do: after a reply [Reply] [Solved, close it], after a resolve [Solved] [Still broken].
 * The question is never a request's last message (it is edited when it closes), lives longer than
 * other offers, and never replaces another open question to the requester; a newer question
 * replaces it. Writes still need a person's decision: [Solved, close it] is the requester's
 * explicit choice to resolve, like a picked request in other choices, and a reply is sent only
 * after a [Yes] to the reply offer that follows [Reply] or [Still broken].
 */

/** Which question follows an update: after a desk reply, or after the request was resolved. */
export type DeskUpdateKind = "reply" | "resolved";

/** The default lifetime of a desk-update question: an update may be read hours later. */
export const DESK_UPDATE_QUESTION_HOURS_DEFAULT = 4;

/** What the bot asks after [Reply]: the requester's next message is the text. */
export function replyTextQuestion(issueKey: string, prompt: ReplyTextPrompt): string {
  const lead = prompt === "stillBroken" ? "What is still wrong?" : "What shall I send to the service desk?";
  return `${lead} Your next message here becomes the reply to **${issueKey}**; I'll ask before sending it.`;
}

/** The bot's answer when the requester cancels instead of writing the reply text. */
export const REPLY_TEXT_CANCELED = "Understood, I won't send anything.";

/** The options of a desk-update question, in button order. */
export function deskUpdateChoices(kind: DeskUpdateKind, issueKey: string): OfferChoice[] {
  if (kind === "reply") {
    return [
      { label: "Reply", answers: ["reply", "answer", "send a reply", "reply to it"], command: null, asksReplyText: "reply" },
      {
        label: "Solved, close it",
        answers: ["solved", "solved, close it", "close it", "close", "resolve it", "resolve"],
        command: { kind: "resolve", issueKey },
      },
    ];
  }
  return [
    { label: "Solved", answers: ["solved", "yes", "fixed", "it's solved", "it is solved", "it's fixed", "it is fixed"], command: null },
    {
      label: "Still broken",
      answers: ["still broken", "broken", "not solved", "not fixed", "still not working", "not working"],
      command: null,
      asksReplyText: "stillBroken",
    },
  ];
}

/**
 * The question as sent without buttons, with its text answer hint in the last paragraph; sent with
 * buttons the hint is left out. Names the requester, since every member sees it.
 */
export function deskUpdateQuestion(kind: DeskUpdateKind, issueKey: string, requesterName?: string): string {
  const name = requesterName?.trim();
  if (kind === "reply") {
    const lead = name ? `${name}, would you like to reply` : "Would you like to reply";
    return `${lead} to the service desk about **${issueKey}**, or is it solved so I can close it?\n\n(reply, solved or no)?`;
  }
  const lead = name ? `${name}, is **${issueKey}** solved for you` : `Is **${issueKey}** solved for you`;
  return `${lead}, or is it still broken?\n\n(solved, still broken or no)?`;
}

/**
 * What a desk-update question is remembered as once it was dropped or expired: the command its
 * text form would be. After a reply that is resolving; after a resolve, replying.
 */
function namingCommand(kind: DeskUpdateKind, issueKey: string): OfferCommand {
  return kind === "reply" ? { kind: "resolve", issueKey } : { kind: "reply", issueKey, body: "" };
}

/** What asking a desk-update question needs. */
export interface DeskUpdateQuestionsDeps {
  offers: PendingOfferStore;
  wireOutbound: WireOutboundPort;
  /** How long the question can be answered; 0 or less asks nothing. */
  lifetimeMs: number;
  logger?: Logger;
  now?: () => Date;
}

/** Asks the requester of a request what to do after a desk update. */
export class DeskUpdateQuestions {
  constructor(private readonly deps: DeskUpdateQuestionsDeps) {}

  /**
   * Sends the question for `kind` to the request's conversation and stores it for the requester.
   * Nothing is asked when the requester has another open question there (one that is not itself a
   * desk-update question, or is the question about the agent conversation): that question is answered first and the update stands on its own. A
   * failure is logged by error name and never affects the update. True when the question was stored.
   */
  async ask(request: SupportRequest, kind: DeskUpdateKind): Promise<boolean> {
    if (this.deps.lifetimeMs <= 0) return false;
    const { conversationId, requesterId, key } = request;
    if (this.busy(conversationId, requesterId)) {
      this.deps.logger?.info("DeskUpdateQuestions: the requester has an open question; not asking", { key });
      return false;
    }
    const question = deskUpdateQuestion(kind, key, request.requesterName);
    const choices = deskUpdateChoices(kind, key);
    const offerId = newOfferId();
    let sent: SentMessageRef | undefined;
    try {
      sent = await sendOfferPrompt(this.deps.wireOutbound, conversationId, question, offerId, choices);
    } catch (err) {
      this.deps.logger?.warn("DeskUpdateQuestions: sending the question failed", { key, err: errorName(err) });
      return false;
    }
    // Another question may have been asked meanwhile (the watch runs beside the conversation's
    // messages); it is kept, and this one is closed at once.
    if (this.busy(conversationId, requesterId)) {
      this.deps.logger?.info("DeskUpdateQuestions: another question was asked meanwhile; closing this one", { key });
      if (sent) await this.closeUnstored(conversationId, sent.messageId, question);
      return false;
    }
    const now = this.now();
    const target: DeskUpdateTarget = { issueKey: key, summary: request.summary };
    this.deps.offers.put({
      command: namingCommand(kind, key),
      conversationId,
      requesterId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.deps.lifetimeMs),
      ...offerPromptFields(offerId, sent, question),
      choices,
      deskUpdate: target,
    });
    // An earlier desk-update question to the requester was replaced: close it now, not at the next sweep.
    try {
      await closeEndedOfferPrompts({ offers: this.deps.offers, wireOutbound: this.deps.wireOutbound, logger: this.deps.logger });
    } catch (err) {
      this.deps.logger?.warn("DeskUpdateQuestions: closing ended questions failed", { err: errorName(err) });
    }
    return true;
  }

  /**
   * True when the requester has an open question other than a desk-update question; the question
   * about the agent conversation (`keepsSlot`) also counts, since it is asked once per request.
   */
  private busy(conversationId: QualifiedId, requesterId: QualifiedId): boolean {
    const live = this.deps.offers.find(conversationId, requesterId, this.now());
    return !!live && (!live.deskUpdate || !!live.keepsSlot);
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
