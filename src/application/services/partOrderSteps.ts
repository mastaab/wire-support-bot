import type { QualifiedId } from "../../domain/ids/QualifiedId";
import { DEFAULT_PART_ASSET } from "../../domain/entities/SupportRequest";
import type { PartAssetWording, PartDetails } from "../../domain/entities/SupportRequest";
import type { ChoosablePartDetail, OfferChoice, OfferCommand, PendingOfferStore } from "../ports/PendingOfferPort";
import type { SentMessageRef, WireOutboundPort } from "../ports/WireOutboundPort";
import { OFFER_TTL_MS, formatMissingPartsQuestion, formatPartSoFar, formatSupportQuestion, missingPartDetails } from "./offers";
import { newOfferId, offerPromptFields, sendOfferPrompt } from "./offerButtons";

/**
 * The questions of a part order, one step at a time. Essentials that need free text (the asset
 * and the part) are asked first and together, in text. Then the quantity is asked with quick
 * buttons, then the delivery location with the configured locations, each with [Other] for a
 * value in text; without configured locations the delivery location is asked in text. When all
 * essentials are known, the complete order is offered with [Yes] [No]. Every option is built by
 * code: the quantities are fixed and the locations come from the configuration.
 */

/** The quick quantities offered as buttons, in order. */
export const QUICK_QUANTITIES: readonly string[] = ["1", "2", "5"];

/** The label of the option that asks for the value in text. */
export const OTHER_LABEL = "Other";

/** The button question for each essential asked with buttons. */
const CHOICE_QUESTIONS: Record<ChoosablePartDetail, string> = {
  quantity: "How many shall I order?",
  deliverTo: "Where shall I deliver it?",
};

/** A support command for a part order. */
type PartOrder = Extract<OfferCommand, { kind: "support" }>;

/** The next question of a part order. */
export interface PartOrderStep {
  question: string;
  /** True when it is sent with buttons: a choice for one essential, or [Yes] [No] for the complete order. */
  buttons: boolean;
  /** The options of a choice for one essential, in button order; absent otherwise. */
  choices?: OfferChoice[];
  /** The essential the options fill. */
  fillsPart?: ChoosablePartDetail;
}

export interface PartOrderStepOptions {
  /** This essential is asked in text, because the requester chose [Other] for it. */
  inText?: ChoosablePartDetail;
  /** Quote the essentials known so far under a question for a missing one (after a changed value). */
  soFar?: boolean;
}

/** The next question for the part order in `command`: what is still missing, or the complete order. */
export function partOrderStep(
  command: PartOrder,
  asset: PartAssetWording = DEFAULT_PART_ASSET,
  deliveryLocations: readonly string[] = [],
  options: PartOrderStepOptions = {},
): PartOrderStep {
  const missing = missingPartDetails(command);
  if (missing.length === 0) {
    return { question: formatSupportQuestion(command.summary, command.description, command.requestKind, command.part, asset), buttons: true };
  }
  const soFar = (question: string) => (options.soFar ? `${question}\n${formatPartSoFar(command.part, asset)}` : question);
  const freeText = missing.filter((key) => key === "asset" || key === "part");
  if (freeText.length > 0) return { question: soFar(formatMissingPartsQuestion(freeText, asset)), buttons: false };
  const key = missing[0] as ChoosablePartDetail;
  const values = key === "quantity" ? QUICK_QUANTITIES : deliveryLocations;
  if (options.inText === key || values.length === 0) return { question: soFar(formatMissingPartsQuestion([key], asset)), buttons: false };
  return {
    question: soFar(CHOICE_QUESTIONS[key]),
    buttons: true,
    choices: [...values.map((value) => fillChoice(command, key, value)), otherChoice(command)],
    fillsPart: key,
  };
}

/** The option that fills `key` with `value`, accepted as stated by the requester since code made the choice. */
function fillChoice(command: PartOrder, key: ChoosablePartDetail, value: string): OfferChoice {
  const part: PartDetails = { ...command.part, [key]: value };
  return { label: value, answers: [value.toLowerCase()], command: { ...command, part } };
}

/** [Other]: keeps the draft as it is, so the essential is asked for in text next. */
function otherChoice(command: PartOrder): OfferChoice {
  return { label: OTHER_LABEL, answers: ["other", "something else"], command };
}

/** What sending and storing a part-order question needs. */
export interface PartOrderQuestions {
  wireOutbound: WireOutboundPort;
  offers: PendingOfferStore;
  now: () => Date;
  asset: PartAssetWording;
  deliveryLocations: readonly string[];
}

/** Who is asked, and the message the question replies to. */
export interface PartOrderTarget {
  conversationId: QualifiedId;
  requesterId: QualifiedId;
  replyToMessageId?: string;
}

/**
 * Sends the part order's next question (with buttons when it has them, without its text answer
 * hint) and then stores the order for the requester, so the question is never answerable unseen.
 * A failed send throws and stores nothing.
 */
export async function askPartOrderStep(
  deps: PartOrderQuestions, target: PartOrderTarget, command: PartOrder, options: PartOrderStepOptions = {},
): Promise<{ step: PartOrderStep; sent: SentMessageRef | undefined }> {
  const step = partOrderStep(command, deps.asset, deps.deliveryLocations, options);
  const offerId = step.buttons ? newOfferId() : undefined;
  const sent = offerId
    ? await sendOfferPrompt(deps.wireOutbound, target.conversationId, step.question, offerId, step.choices, target.replyToMessageId)
    : await deps.wireOutbound.sendPlainText(target.conversationId, step.question, { replyToMessageId: target.replyToMessageId });
  const now = deps.now();
  deps.offers.put({
    command,
    conversationId: target.conversationId,
    requesterId: target.requesterId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
    ...offerPromptFields(offerId, sent, step.question),
    ...(step.choices ? { choices: step.choices } : {}),
    ...(step.fillsPart ? { fillsPart: step.fillsPart } : {}),
  });
  return { step, sent };
}

/**
 * The text question for what the part-order draft still needs, used when asking again without
 * buttons: the free-text essentials together, otherwise the next missing one. Null for a complete order.
 */
export function partOrderTextQuestion(command: OfferCommand, asset: PartAssetWording = DEFAULT_PART_ASSET): string | null {
  const missing = missingPartDetails(command);
  if (missing.length === 0) return null;
  const freeText = missing.filter((key) => key === "asset" || key === "part");
  return formatMissingPartsQuestion(freeText.length > 0 ? freeText : [missing[0]!], asset);
}
