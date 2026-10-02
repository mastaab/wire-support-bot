import type { Logger } from "../application/ports/Logger";
import { sweepEndedOfferPrompts, type OfferPromptClosing } from "../application/services/offerPromptClosing";
import { startIntervalRunner, type IntervalRunner } from "./intervalRunner";

/** How often expired button questions are looked for, so they are closed in a quiet conversation too. */
export const OFFER_PROMPT_SWEEP_MS = 60 * 1000;

/**
 * Closes expired button questions periodically, also in conversations where nobody writes. Each
 * run reads the time from `now`; stop it on shutdown like the other runners.
 */
export function startOfferPromptSweep(
  deps: OfferPromptClosing,
  logger: Logger,
  now: () => Date = () => new Date(),
  intervalMs: number = OFFER_PROMPT_SWEEP_MS,
): IntervalRunner {
  return startIntervalRunner("Offer question sweep", () => sweepEndedOfferPrompts(deps, now()), intervalMs, logger);
}
