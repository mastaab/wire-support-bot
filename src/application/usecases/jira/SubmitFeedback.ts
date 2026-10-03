import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import { isFeedbackRating, trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { NO_METRICS, type MetricsPort, type RatingOutcome } from "../../ports/MetricsPort";
import { findSupportRequestInConversation } from "./supportRequestScope";
import { appendAuditSafely, wasRefused } from "./supportRequestStatus";

const SOURCE = "SubmitFeedback";

/** The one reply when the rating did not reach the service desk. */
export const FEEDBACK_FAILED = "I couldn't send the rating to the service desk.";

export interface SubmitFeedbackInput {
  issueKey: string;
  /** A whole number from 1 to 5, from the picked option. */
  rating: number;
  conversationId: QualifiedId;
  /** The requester who rated; recorded in the audit. */
  actorId: QualifiedId;
  replyToMessageId?: string;
}

/**
 * Sends the requester's satisfaction rating to the request's feedback in Jira. The request must be
 * one of this conversation's and the rating 1 to 5. Success posts nothing (the rating question's
 * closing line shows the answer) and is audited with the rating only. A refused or failed call
 * (for example feedback turned off in the project, or not allowed for the bot's account) is logged
 * by error name and HTTP status and answered with one short text; a failure that may have reached
 * Jira (a timeout or server error) is audited as unconfirmed. Nothing else changes.
 */
export class SubmitFeedback {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger?: Logger,
    private readonly now: () => Date = () => new Date(),
    /** Counts the ratings by outcome. */
    private readonly metrics: MetricsPort = NO_METRICS,
  ) {}

  /** True when Jira accepted the rating. */
  async execute(input: SubmitFeedbackInput): Promise<boolean> {
    const { conversationId, rating } = input;
    const key = input.issueKey.trim().toUpperCase();
    const fail = async (outcome: RatingOutcome): Promise<false> => {
      this.metrics.ratingSent(outcome);
      try {
        await this.wireOutbound.sendPlainText(conversationId, FEEDBACK_FAILED, { replyToMessageId: input.replyToMessageId });
      } catch (err) {
        this.logger?.warn(`${SOURCE}: sending the reply failed`, { key, err: errorName(err) });
      }
      return false;
    };
    if (!isFeedbackRating(rating)) {
      this.logger?.warn(`${SOURCE}: the rating is out of range`, { key });
      return fail("not_sent");
    }
    let found;
    try {
      found = await findSupportRequestInConversation(this.requests, key, conversationId, this.tracker.projectKey);
    } catch (err) {
      this.logger?.warn(`${SOURCE}: reading the request failed`, { key, err: errorName(err) });
      return fail("not_sent");
    }
    if (!found) {
      this.logger?.info(`${SOURCE}: not a request of this conversation`, { key });
      return fail("not_sent");
    }
    const entry = {
      actorId: input.actorId,
      conversationId,
      action: "entity_created" as const,
      entityType: "JiraFeedback",
      entityId: found.key,
    };
    try {
      await this.tracker.submitFeedback(found.key, rating);
    } catch (err) {
      this.logger?.warn(`${SOURCE}: submitFeedback failed`, { key: found.key, ...trackerErrorFields(err) });
      const refused = wasRefused(err);
      if (!refused) {
        await appendAuditSafely(this.auditLog, { ...entry, timestamp: this.now(), details: { rating, outcome: "feedback_unconfirmed" } }, SOURCE, this.logger);
      }
      return fail(refused ? "refused" : "unconfirmed");
    }
    this.metrics.ratingSent("ok");
    await appendAuditSafely(this.auditLog, { ...entry, timestamp: this.now(), details: { rating } }, SOURCE, this.logger);
    return true;
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
