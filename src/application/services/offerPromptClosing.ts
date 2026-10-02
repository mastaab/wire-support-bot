import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { EndedOfferPrompt, OfferPromptEnding, PendingOfferStore } from "../ports/PendingOfferPort";
import type { WireOutboundPort } from "../ports/WireOutboundPort";
import type { Logger } from "../ports/Logger";

/**
 * Closing button questions. When a question ends, the bot replaces its button message with the
 * question as sent and a closing line, without buttons, so the message stops inviting clicks for
 * every member. Each message is closed at most once (the offer store claims it). A failed edit is
 * logged by error name and changes nothing else: the offer logic never depends on it.
 */

/** The closing line of a question that expired. */
export const EXPIRED_LINE = "This question has expired.";
/** The closing line of a question replaced by a newer question to the same requester. */
export const REPLACED_LINE = "This question was replaced by a newer one.";
/** The closing line of a question dropped because the requester's next message was not an answer to it. */
export const NOT_AN_ANSWER_LINE = "Closed, as the next message was not an answer.";

/** The closing line of an answered question: "Answered by Alice: Yes", or "Answered: Yes" without a name. */
export function answeredLine(requesterName: string | undefined, answer: string): string {
  return requesterName ? `Answered by ${requesterName}: ${answer}` : `Answered: ${answer}`;
}

/** The closing line for an ending the store noticed. */
export function endingLine(reason: OfferPromptEnding): string {
  return reason === "expired" ? EXPIRED_LINE : REPLACED_LINE;
}

/** The text a closed button message shows: its question, then the closing line. */
export function closedPromptText(question: string | undefined, line: string): string {
  const asked = question?.trimEnd();
  return asked ? `${asked}\n\n${line}` : line;
}

/** What closing a button message needs. */
export interface OfferPromptClosing {
  offers: PendingOfferStore;
  wireOutbound: WireOutboundPort;
  logger?: Logger;
}

/**
 * Closes the button message `messageId` with `line`, unless it is unknown or already closed.
 * True when the edit was sent; false when there was nothing to close or the edit failed.
 */
export async function closeOfferPrompt(
  deps: OfferPromptClosing, conversationId: QualifiedId, messageId: string | undefined, line: string,
): Promise<boolean> {
  if (!messageId) return false;
  const closing = deps.offers.claimClose(conversationId, messageId);
  if (!closing) return false;
  return sendClose(deps, conversationId, messageId, closedPromptText(closing.question, line));
}

/** Closes every button message the store noticed as expired or replaced. Returns how many edits were sent. */
export async function closeEndedOfferPrompts(deps: OfferPromptClosing): Promise<number> {
  let closed = 0;
  for (const prompt of deps.offers.takeEndedPrompts()) {
    if (await closeEnded(deps, prompt)) closed += 1;
  }
  return closed;
}

/**
 * The periodic sweep: notices every offer expired at `now`, also in a quiet conversation, and
 * closes the button messages that ended. Returns how many edits were sent.
 */
export async function sweepEndedOfferPrompts(deps: OfferPromptClosing, now: Date): Promise<number> {
  deps.offers.sweepExpired(now);
  return closeEndedOfferPrompts(deps);
}

function closeEnded(deps: OfferPromptClosing, prompt: EndedOfferPrompt): Promise<boolean> {
  return sendClose(deps, prompt.conversationId, prompt.messageId, closedPromptText(prompt.question, endingLine(prompt.reason)));
}

async function sendClose(deps: OfferPromptClosing, conversationId: QualifiedId, messageId: string, text: string): Promise<boolean> {
  try {
    await deps.wireOutbound.closeButtonPrompt(conversationId, messageId, text);
    return true;
  } catch (err) {
    deps.logger?.warn("Closing a button question failed", { err: err instanceof Error ? err.name : "UnknownError" });
    return false;
  }
}
