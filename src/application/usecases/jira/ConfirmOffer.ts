import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { DEFAULT_PART_ASSET } from "../../../domain/entities/SupportRequest";
import type { PartAssetWording } from "../../../domain/entities/SupportRequest";
import {
  NOTHING_TO_CONFIRM_REPLY, OFFER_TTL_MS, REPLY_BODY_MAX, formatChooseAgain, formatReplyQuestion, formatStillMissingReply,
  missingPartDetails, offerCommandLine,
} from "../../services/offers";
import type { OfferCommand, PendingOffer, PendingOfferStore } from "../../services/offers";
import type { ChoiceAction, DeskUpdateTarget, OfferChoice, ReplyTextPrompt } from "../../ports/PendingOfferPort";
import {
  YES_NO_LABELS, answerForms, choiceHint, decisionAt, matchChoice, newOfferId, offerPromptFields, sendOfferPrompt,
} from "../../services/offerButtons";
import { REPLY_TEXT_CANCELED, replyTextQuestion } from "../../services/deskUpdateQuestions";
import { answeredLine, closeOfferPrompt } from "../../services/offerPromptClosing";
import type { Logger } from "../../ports/Logger";
import { askPartOrderStep, partOrderTextQuestion } from "../../services/partOrderSteps";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { RaiseSupportRequest } from "./RaiseSupportRequest";
import type { ReplyToServiceDesk } from "./ReplyToServiceDesk";
import type { ResolveSupportRequest } from "./ResolveSupportRequest";
import type { AttachFileToRequest } from "./AttachFileToRequest";
import type { AskForAgentConversation } from "./AskForAgentConversation";
import type { SubmitFeedback } from "./SubmitFeedback";
import type { FeedbackQuestions } from "../../services/feedbackQuestions";
import { describeFile } from "../../services/attachments";

export type Confirmation = "yes" | "no";

/** Each use case re-validates scope, state and bounds at the moment the offer is confirmed. */
export interface ConfirmOfferHandlers {
  raiseSupportRequest: RaiseSupportRequest;
  replyToServiceDesk: ReplyToServiceDesk;
  resolveSupportRequest: ResolveSupportRequest;
  /** Absent when attachments are not wired; an attach offer is then never made. */
  attachFileToRequest?: AttachFileToRequest;
  /** Opens the agent conversation for [Open direct chat]; absent when the question is never asked. */
  agentConversation?: Pick<AskForAgentConversation, "accept">;
  /**
   * Satisfaction ratings (WIRE_SUPPORT_BOT_JIRA_FEEDBACK=on): the question asked after [Solved],
   * and sending the picked rating. Absent: no rating is asked or sent. A resolve, also a resolving
   * [Solved, close it], is followed by the question in `ResolveSupportRequest`.
   */
  feedback?: { questions: Pick<FeedbackQuestions, "ask">; submit: Pick<SubmitFeedback, "execute"> };
}

export interface ConfirmOfferInput {
  text: string;
  conversationId: QualifiedId;
  requesterId: QualifiedId;
  /** Wire display name of the requester, for the requester line of a `support` offer. */
  requesterName?: string;
  replyToMessageId?: string;
}

/** Explicit forms only: the bot asks "(yes or no)?", so "ok" or "sure" does not approve a write. */
const YES: ReadonlySet<string> = new Set([
  "yes", "yes please", "yep", "yeah", "go ahead", "do it", "please do", "confirm", "confirmed",
]);
const NO: ReadonlySet<string> = new Set(["no", "n", "nope", "no thanks", "cancel", "don't", "do not", "stop"]);

/**
 * Casual replies that answer the offer without deciding it. They never confirm a write; the
 * bot asks again and keeps the offer, instead of dropping it while the requester thinks it
 * is still open.
 */
const ACKNOWLEDGMENTS: ReadonlySet<string> = new Set([
  "ok", "okay", "k", "sure", "y", "thanks", "thank you", "cheers", "cool", "great", "fine", "alright", "all right",
]);

/** True for a bare acknowledgment such as "ok" or "ok thanks", which is not a decision. */
export function isAcknowledgment(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  return [normalized, normalize(stripCourtesy(normalized))].some((c) => ACKNOWLEDGMENTS.has(c));
}

/**
 * Classifies a short confirmation reply. Only the listed forms count, optionally with
 * trailing punctuation, backticks or a trailing "thanks", "thank you" or "please"; anything
 * longer ("yes but change the owner first") is not a confirmation.
 */
export function classifyConfirmation(text: string): Confirmation | null {
  const normalized = normalize(text);
  if (!normalized) return null;
  const candidates = [normalized, normalize(stripCourtesy(normalized))];
  if (candidates.some(c => YES.has(c))) return "yes";
  if (candidates.some(c => NO.has(c))) return "no";
  return null;
}

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/`/g, "")
    .replace(/[\s.!?,;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripCourtesy(text: string): string {
  return text.replace(/[\s,]+(thanks|thank you|please)$/, "");
}

/** A click on one of an offer's buttons, already matched to the offer's message and its requester. */
export interface ChooseOfferInput {
  conversationId: QualifiedId;
  requesterId: QualifiedId;
  /** Wire display name of the requester, for the requester line of a `support` offer. */
  requesterName?: string;
  /** The offer ID and option index the clicked button carries. */
  offerId: string;
  index: number;
}

/** Who answered and where the result goes. */
interface AnswerContext {
  conversationId: QualifiedId;
  requesterId: QualifiedId;
  requesterName?: string;
  replyToMessageId?: string;
}

/**
 * Runs a pending offer when its requester confirms it, by a text answer or a button. The offer
 * is consumed once, and the dispatched use case re-validates scope and state at that moment.
 *
 * The router calls `execute` when the requester has a live offer (`has`) or a recently dropped
 * or expired one (`recentlyDropped`), so a bare yes after a drop is answered instead of ignored.
 * It calls `choose` for an accepted click.
 */
export class ConfirmOffer {
  constructor(
    private readonly offers: PendingOfferStore,
    private readonly handlers: ConfirmOfferHandlers,
    private readonly wireOutbound: WireOutboundPort,
    private readonly now: () => Date = () => new Date(),
    /** How the asset essential of a part order is named and asked for. */
    private readonly partAsset: PartAssetWording = DEFAULT_PART_ASSET,
    /** Delivery locations of part orders offered as buttons; empty asks for the location in text. */
    private readonly deliveryLocations: readonly string[] = [],
    private readonly logger?: Logger,
  ) {}

  /**
   * True when the message confirmed, declined or chose for this requester's pending offer, was
   * asked again, or was a yes answered with "nothing waiting" because the offer was recently
   * dropped or expired.
   */
  async execute(input: ConfirmOfferInput): Promise<boolean> {
    const now = this.now();
    const live = this.offers.find(input.conversationId, input.requesterId, now);
    if (live?.awaitsReplyText) return this.takeReplyText(live.awaitsReplyText, input, now);
    if (live?.fillsPart && live.choices) return this.answerFill(live, live.choices, input, now);
    if (live?.choices) return this.answerChoice(live, live.choices, input, now);

    const answer = classifyConfirmation(input.text);
    if (!answer) {
      if (!isAcknowledgment(input.text) || !live) return false;
      const pending = this.offers.take(input.conversationId, input.requesterId, now);
      if (!pending) return false;
      // Keep the offer and ask again: an acknowledgment is a response, but not a decision.
      this.offers.put(pending);
      await this.wireOutbound.sendPlainText(input.conversationId, askAgain(pending.command, this.partAsset), { replyToMessageId: input.replyToMessageId });
      return true;
    }

    const offer = live ? this.offers.take(input.conversationId, input.requesterId, now) : null;
    if (!offer) return answer === "yes" ? this.nothingToConfirm(input, now) : false;
    await this.decide(offer, answer === "yes" ? offer.command : null, input, true, answer === "yes" ? YES_NO_LABELS[0] : YES_NO_LABELS[1]);
    return true;
  }

  /**
   * An accepted click: runs the option the button stands for, when the requester's live offer is
   * still the one the button belongs to and has that option. False (and nothing done) otherwise.
   */
  async choose(input: ChooseOfferInput): Promise<boolean> {
    const now = this.now();
    const live = this.offers.find(input.conversationId, input.requesterId, now);
    if (!live?.id || live.id !== input.offerId) return false;
    const decision = decisionAt(live, input.index);
    if (!decision) return false;
    const offer = this.offers.take(input.conversationId, input.requesterId, now);
    if (!offer) return false;
    const choice = offer.choices?.[input.index];
    const label = choice ? choice.label : YES_NO_LABELS[input.index]!;
    await this.decide(offer, decision.command, input, !offer.choices, label, choice);
    return true;
  }

  /** A text answer to a choice offer: an option runs, a bare yes or acknowledgment asks again, anything else is not an answer. */
  private async answerChoice(live: PendingOffer, choices: readonly OfferChoice[], input: ConfirmOfferInput, now: Date): Promise<boolean> {
    const index = matchChoice(choices, input.text);
    if (index === null && live.deskUpdate) {
      // A desk-update question is answered by an option or a "no"; anything else is the
      // requester moving on, also a "yes" or "thanks", which may be meant for the desk's reply.
      if (classifyConfirmation(input.text) !== "no") return false;
      const offer = this.offers.take(input.conversationId, input.requesterId, now);
      if (!offer) return false;
      await this.decide(offer, null, input, false, YES_NO_LABELS[1]);
      return true;
    }
    if (index === null) {
      if (classifyConfirmation(input.text) !== "yes" && !isAcknowledgment(input.text)) return false;
      await this.wireOutbound.sendPlainText(input.conversationId, formatChooseAgain(choiceHint(choices)), { replyToMessageId: input.replyToMessageId });
      return true;
    }
    const offer = this.offers.take(input.conversationId, input.requesterId, now);
    if (!offer) return false;
    await this.decide(offer, choices[index]!.command, input, false, choices[index]!.label, choices[index]);
    return true;
  }

  /**
   * The requester's message after the bot asked for the text of a reply ([Reply] or [Still
   * broken]): a "no" cancels, a text too long for Jira is refused and the bot keeps waiting, and
   * any other text is offered as a reply to the request with [Yes] [No]. Nothing reaches Jira
   * before that yes; `ReplyToServiceDesk` re-validates the request then.
   */
  private async takeReplyText(target: DeskUpdateTarget, input: ConfirmOfferInput, now: Date): Promise<boolean> {
    const body = input.text.trim();
    if (!body) return false;
    const waiting = this.offers.take(input.conversationId, input.requesterId, now);
    if (!waiting) return false;
    const reply = (text: string) => this.wireOutbound.sendPlainText(input.conversationId, text, { replyToMessageId: input.replyToMessageId });
    if (classifyConfirmation(body) === "no") {
      await reply(REPLY_TEXT_CANCELED);
      return true;
    }
    if (body.length > REPLY_BODY_MAX) {
      this.offers.put(waiting);
      await reply(`I'm afraid that is too long for Jira; please keep it under ${REPLY_BODY_MAX} characters and send it again.`);
      return true;
    }
    const command: OfferCommand = { kind: "reply", issueKey: target.issueKey, body };
    const question = formatReplyQuestion(target.issueKey, target.summary, body);
    const offerId = newOfferId();
    const sent = await sendOfferPrompt(this.wireOutbound, input.conversationId, question, offerId, undefined, input.replyToMessageId);
    const at = this.now();
    this.offers.put({
      command, conversationId: input.conversationId, requesterId: input.requesterId,
      createdAt: at, expiresAt: new Date(at.getTime() + OFFER_TTL_MS), ...offerPromptFields(offerId, sent, question),
    });
    return true;
  }

  /**
   * After [Reply] or [Still broken] on a desk-update question: asks for the reply text and waits
   * for the requester's next message, for as long as an offer lives.
   */
  private async askReplyText(offer: PendingOffer, target: DeskUpdateTarget, prompt: ReplyTextPrompt, context: AnswerContext): Promise<void> {
    const now = this.now();
    this.offers.put({
      command: { kind: "reply", issueKey: target.issueKey, body: "" },
      conversationId: offer.conversationId,
      requesterId: context.requesterId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
      awaitsReplyText: target,
    });
    await this.wireOutbound.sendPlainText(context.conversationId, replyTextQuestion(target.issueKey, prompt), {
      replyToMessageId: context.replyToMessageId,
    });
  }

  /**
   * A text answer to a button question for one part-order essential. An option's label ("2",
   * "Depot north", "other") picks it like a click; for the quantity, a bare number ("3") fills it
   * directly. A "no" declines the order; a "yes" or an acknowledgment says what is still missing
   * and keeps the question open. Anything else is not handled here: the router hands it to
   * `CompletePartOrder`, so a free-text value or a correction ("actually three") still works.
   */
  private async answerFill(live: PendingOffer, choices: readonly OfferChoice[], input: ConfirmOfferInput, now: Date): Promise<boolean> {
    const index = matchChoice(choices, input.text, { byNumber: false });
    const quantity = live.fillsPart === "quantity" ? answerForms(input.text).find((form) => /^\d{1,4}$/.test(form) && Number(form) > 0) : undefined;
    const decision = classifyConfirmation(input.text);
    if (index === null && !quantity && decision !== "no") {
      if (decision !== "yes" && !isAcknowledgment(input.text)) return false;
      await this.wireOutbound.sendPlainText(input.conversationId, formatStillMissingReply(missingPartDetails(live.command), this.partAsset), {
        replyToMessageId: input.replyToMessageId,
      });
      return true;
    }
    const offer = this.offers.take(input.conversationId, input.requesterId, now);
    if (!offer) return false;
    let command: OfferCommand | null = null;
    // The answer shown when the question closes: the option, the typed quantity, or a decline.
    let answer: string = YES_NO_LABELS[1];
    if (index !== null) {
      command = choices[index]!.command;
      answer = choices[index]!.label;
    } else if (quantity && offer.command.kind === "support") {
      command = { ...offer.command, part: { ...offer.command.part, quantity: String(Number(quantity)) } };
      answer = String(Number(quantity));
    }
    await this.decide(offer, command, input, false, answer);
    return true;
  }

  /**
   * Runs `command` for the taken offer, or declines it when null, after recording the offer's
   * message as answered and closing it with "Answered by <name>: <answer>". `confirmed` is true
   * for a yes to a yes-or-no offer, whose incomplete part order is kept for amending; a chosen
   * incomplete order is asked about afresh. `choice` is the picked option of a choice offer: one
   * of a desk-update question may ask for the reply text instead, and one may run a step other
   * than a command (`then`).
   */
  private async decide(
    offer: PendingOffer, command: OfferCommand | null, context: AnswerContext, confirmed: boolean, answer: string,
    choice?: OfferChoice,
  ): Promise<void> {
    const asksReplyText = choice?.asksReplyText;
    if (offer.id) this.offers.markAnswered(offer.conversationId, offer.id);
    const { conversationId, requesterId: actorId, replyToMessageId } = context;
    await closeOfferPrompt(
      { offers: this.offers, wireOutbound: this.wireOutbound, logger: this.logger },
      conversationId, offer.messageId, answeredLine(context.requesterName, answer),
    );
    if (asksReplyText && offer.deskUpdate) {
      await this.askReplyText(offer, offer.deskUpdate, asksReplyText, context);
      return;
    }
    if (choice?.then) {
      await this.runAction(choice.then, context);
      return;
    }
    if (!command) {
      // A desk-update question's [Solved] or "no" changes nothing; its closing line says so.
      if (!offer.deskUpdate) await this.wireOutbound.sendPlainText(conversationId, "Understood, I won't.", { replyToMessageId });
      // [Solved]: the requester is satisfied, so the bot may ask for a rating.
      if (choice?.asksFeedback && offer.deskUpdate) await this.askFeedback(offer.deskUpdate, context);
      return;
    }

    const missing = missingPartDetails(command);
    if (confirmed && missing.length > 0) {
      // An incomplete part order can only be amended: keep it so the next answer can fill it.
      this.offers.put(offer);
      await this.wireOutbound.sendPlainText(conversationId, formatStillMissingReply(missing, this.partAsset), { replyToMessageId });
      return;
    }
    // A chosen essential never runs the order, and a chosen incomplete order is asked about
    // afresh: the order continues with its next question. [Other] keeps the draft without the
    // essential, which is then asked for in text.
    if (command.kind === "support" && command.requestKind === "part" && (offer.fillsPart || missing.length > 0)) {
      const inText = offer.fillsPart && missing.includes(offer.fillsPart) ? offer.fillsPart : undefined;
      await askPartOrderStep(
        { wireOutbound: this.wireOutbound, offers: this.offers, now: this.now, asset: this.partAsset, deliveryLocations: this.deliveryLocations },
        { conversationId, requesterId: actorId, replyToMessageId },
        command,
        inText ? { inText } : {},
      );
      return;
    }
    switch (command.kind) {
      case "support":
        await this.handlers.raiseSupportRequest.execute({
          summary: command.summary, description: command.description, conversationId, requesterId: actorId,
          requesterName: context.requesterName, replyToMessageId, requestKind: command.requestKind,
          ...(command.part ? { part: command.part } : {}),
        });
        break;
      case "reply":
        await this.handlers.replyToServiceDesk.execute({
          reference: command.issueKey, body: command.body, conversationId, actorId, replyToMessageId,
        });
        break;
      case "resolve": {
        // A resolve that reached done asks the request's requester for a rating itself, so a
        // resolving [Solved, close it] is not asked about here as well.
        await this.handlers.resolveSupportRequest.execute({
          issueKey: command.issueKey, conversationId, actorId, replyToMessageId,
          ...(command.comment ? { comment: command.comment } : {}),
        });
        break;
      }
      case "attach":
        if (!this.handlers.attachFileToRequest) {
          await this.wireOutbound.sendPlainText(conversationId, "I'm afraid I can't add files to requests here, so nothing was sent.", { replyToMessageId });
          break;
        }
        await this.handlers.attachFileToRequest.execute({
          issueKey: command.issueKey, file: command.file, conversationId, actorId,
          senderName: context.requesterName, replyToMessageId,
        });
        break;
    }
  }

  /** Runs the step of a picked option that is not an offer command. */
  private async runAction(action: ChoiceAction, context: AnswerContext): Promise<void> {
    switch (action.kind) {
      case "openAgentChat":
        if (!this.handlers.agentConversation) {
          await this.wireOutbound.sendPlainText(context.conversationId, "I'm afraid I can't open direct conversations here.", {
            replyToMessageId: context.replyToMessageId,
          });
          return;
        }
        await this.handlers.agentConversation.accept({
          issueKey: action.issueKey, agentHandle: action.agentHandle, conversationId: context.conversationId,
          requesterId: context.requesterId, replyToMessageId: context.replyToMessageId,
        });
        return;
      case "rate":
        if (!this.handlers.feedback) {
          await this.wireOutbound.sendPlainText(context.conversationId, "I'm afraid I can't send ratings to the service desk here.", {
            replyToMessageId: context.replyToMessageId,
          });
          return;
        }
        await this.handlers.feedback.submit.execute({
          issueKey: action.issueKey, rating: action.rating, conversationId: context.conversationId,
          actorId: context.requesterId, replyToMessageId: context.replyToMessageId,
        });
        return;
    }
  }

  /** Asks the requester for a satisfaction rating of the request, when ratings are on. Never fails the answer. */
  private async askFeedback(target: DeskUpdateTarget, context: AnswerContext): Promise<void> {
    if (!this.handlers.feedback) return;
    try {
      await this.handlers.feedback.questions.ask({
        target, conversationId: context.conversationId, requesterId: context.requesterId, requesterName: context.requesterName,
      });
    } catch (err) {
      this.logger?.warn("ConfirmOffer: asking for a rating failed", { err: err instanceof Error ? err.name : "UnknownError" });
    }
  }

  /**
   * A yes with no live offer: when the requester's offer was recently dropped or expired, say
   * that nothing was done and give its command, once: the memory is then forgotten, so a later
   * yes meant for someone else is not answered. Otherwise the yes is not handled here.
   */
  private async nothingToConfirm(input: ConfirmOfferInput, now: Date): Promise<boolean> {
    const dropped = this.offers.recentlyDropped(input.conversationId, input.requesterId, now);
    if (!dropped) return false;
    this.offers.forgetDropped(input.conversationId, input.requesterId);
    await this.wireOutbound.sendPlainText(input.conversationId, `${NOTHING_TO_CONFIRM_REPLY}\n${offerCommandLine(dropped)}`, {
      replyToMessageId: input.replyToMessageId,
    });
    return true;
  }
}

/** The code-written re-ask after an acknowledgment; it ends with a question like the offer itself. */
function askAgain(command: OfferCommand, asset: PartAssetWording): string {
  const partQuestion = partOrderTextQuestion(command, asset);
  if (partQuestion) return partQuestion;
  switch (command.kind) {
    case "support":
      return "I need a clear yes or no, so I haven't raised anything with the service desk yet. Shall I raise it (yes or no)?";
    case "resolve":
      return command.comment
        ? `I need a clear yes or no, so I haven't resolved **${command.issueKey}** yet. Shall I add the comment and resolve it (yes or no)?`
        : `I need a clear yes or no, so I haven't resolved **${command.issueKey}** yet. Shall I resolve it with the service desk (yes or no)?`;
    case "reply":
      return `I need a clear yes or no, so I haven't added this to **${command.issueKey}** yet. Shall I add it (yes or no)?`;
    case "attach":
      return `I need a clear yes or no, so I haven't added ${describeFile(command.file)} to **${command.issueKey}** yet. Shall I add it (yes or no)?`;
  }
}
