import { randomUUID } from "node:crypto";
import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { CompositeButton, SentMessageRef, WireOutboundPort } from "../ports/WireOutboundPort";
import type { OfferChoice, OfferCommand, PendingOffer } from "../ports/PendingOfferPort";

/**
 * Buttons and choices of offers. Every offer question is sent with buttons: [Yes] [No] for a
 * yes-or-no offer, or one button per option for a choice offer. A button ID is opaque: the
 * offer's ID and the option's index, checked against the stored offer when clicked, never a key
 * or text taken from the click. Text answers keep working for every button question.
 */

/** Most requests offered as candidates in one choice. */
export const OFFER_CANDIDATES_MAX = 3;

/** The labels of a yes-or-no offer, in button order: index 0 runs the offer, index 1 declines it. */
export const YES_NO_LABELS: readonly [string, string] = ["Yes", "No"];

/** A fresh opaque offer ID. */
export function newOfferId(): string {
  return randomUUID();
}

/** The buttons of an offer: [Yes] [No], or one per option of a choice offer. */
export function offerButtons(offerId: string, choices?: readonly OfferChoice[]): CompositeButton[] {
  const labels = choices ? choices.map((choice) => choice.label) : [...YES_NO_LABELS];
  return labels.map((label, index) => ({ id: `${offerId}:${index}`, label }));
}

const BUTTON_ID = /^([A-Za-z0-9-]{8,64}):(\d{1,2})$/;

/** The offer ID and option index a button ID carries, or null when it is not an offer button. */
export function parseOfferButtonId(buttonId: string): { offerId: string; index: number } | null {
  const match = BUTTON_ID.exec(buttonId);
  return match ? { offerId: match[1]!, index: Number(match[2]) } : null;
}

/**
 * What option `index` of the offer decides: the command to run, or null to decline. Undefined
 * when the offer has no such option.
 */
export function decisionAt(offer: Pick<PendingOffer, "command" | "choices">, index: number): { command: OfferCommand | null } | undefined {
  if (!Number.isInteger(index) || index < 0) return undefined;
  if (offer.choices) {
    const choice = offer.choices[index];
    return choice ? { command: choice.command } : undefined;
  }
  if (index === 0) return { command: offer.command };
  if (index === 1) return { command: null };
  return undefined;
}

/**
 * The option a text answer picks: its number ("2"), one of its answers ("SD-41", "new",
 * "cancel") or its label, optionally with trailing punctuation, emphasis or a trailing "thanks"
 * or "please". Null when the text picks no option.
 */
export function matchChoice(choices: readonly OfferChoice[], text: string): number | null {
  const normalised = normaliseAnswer(text);
  if (!normalised) return null;
  const candidates = [normalised, normaliseAnswer(normalised.replace(/[\s,]+(thanks|thank you|please)$/, ""))];
  for (const candidate of candidates) {
    if (/^\d{1,2}$/.test(candidate)) {
      const index = Number(candidate) - 1;
      if (index >= 0 && index < choices.length) return index;
      continue;
    }
    const index = choices.findIndex((choice) =>
      choice.answers.includes(candidate) || normaliseAnswer(choice.label) === candidate);
    if (index >= 0) return index;
  }
  return null;
}

function normaliseAnswer(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[`*_"]/g, "")
    .replace(/[\s.!?,;:)]+$/, "")
    .replace(/^[\s(]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** How the question names the text answers, for example "SD-40, SD-41, new or cancel". */
export function choiceHint(choices: readonly OfferChoice[]): string {
  const hints = choices.map((choice) => displayAnswer(choice));
  return hints.length <= 1 ? hints.join("") : `${hints.slice(0, -1).join(", ")} or ${hints[hints.length - 1]}`;
}

/** The first answer, with a request key shown in its usual upper case. */
function displayAnswer(choice: OfferChoice): string {
  const first = choice.answers[0] ?? choice.label.toLowerCase();
  return /^[a-z][a-z0-9]*-\d+$/.test(first) ? first.toUpperCase() : first;
}

/** An option that picks a request by its key, labelled with the key ("SD-41"). */
export function keyChoice(key: string, command: OfferCommand): OfferChoice {
  return { label: key, answers: [key.toLowerCase()], command };
}

/** An option that adds to an existing request ("Add to SD-41"). */
export function addToChoice(key: string, command: OfferCommand): OfferChoice {
  return { label: `Add to ${key}`, answers: [key.toLowerCase(), `add to ${key.toLowerCase()}`, `add it to ${key.toLowerCase()}`], command };
}

/** An option that raises a new request instead of adding to an existing one. */
export function raiseNewChoice(command: OfferCommand): OfferChoice {
  return {
    label: "Raise new request",
    answers: ["new", "new request", "a new request", "new one", "a new one", "raise new", "raise new request", "raise a new request", "raise a new one"],
    command,
  };
}

/** Declining forms every choice accepts, like a "no" to a yes-or-no offer. */
const DECLINES: readonly string[] = ["cancel", "no", "n", "nope", "no thanks", "none", "neither", "stop", "don't", "do not"];

/** The option that declines the offer, labelled "Cancel". */
export function cancelChoice(): OfferChoice {
  return { label: "Cancel", answers: DECLINES, command: null };
}

/** The option that declines a file offer. */
export function doNotAttachChoice(): OfferChoice {
  return { label: "Do not attach", answers: ["no", ...DECLINES.filter((answer) => answer !== "no"), "do not attach", "don't attach", "dont attach"], command: null };
}

/** True for a choice offer, false for a yes-or-no offer. */
export function isChoiceOffer(offer: Pick<PendingOffer, "choices">): boolean {
  return offer.choices !== undefined;
}

/**
 * Sends an offer question with the offer's buttons, as a native reply to `replyToMessageId`.
 * Returns the sent message's reference, which the stored offer keeps so a click can be matched.
 */
export function sendOfferPrompt(
  wireOutbound: WireOutboundPort,
  conversationId: QualifiedId,
  question: string,
  offerId: string,
  choices?: readonly OfferChoice[],
  replyToMessageId?: string,
): Promise<SentMessageRef | undefined> {
  return wireOutbound.sendCompositePrompt(conversationId, question, offerButtons(offerId, choices), { replyToMessageId });
}
