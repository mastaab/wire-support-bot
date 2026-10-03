import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { SentMessageRef, WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { NO_METRICS, type MetricsPort } from "../../ports/MetricsPort";
import { REPLY_BODY_MAX } from "../../services/offers";
import { REPLY_FOOTER } from "./formatIssue";
import { findSupportRequestInConversation } from "./supportRequestScope";
import { appendAuditSafely, notInConversation, wasRefused } from "./supportRequestStatus";
import { rememberLastMessage } from "./supportRequestMarkers";

export interface ReplyToServiceDeskInput {
  /** A tracker key, e.g. "SD-6". */
  reference: string;
  /** Reply text. Sent to the ticket; never stored, logged or audited. */
  body: string;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  replyToMessageId?: string;
}

/**
 * Sends one customer-facing reply to a support request of this conversation. The reply
 * carries a footer saying it came from Wire; the bot speaks for the team.
 */
export class ReplyToServiceDesk {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger?: Logger,
    /** Counts the replies sent. */
    private readonly metrics: MetricsPort = NO_METRICS,
  ) {}

  /** True when the reply was sent. Exactly one Wire message is sent either way. */
  async execute(input: ReplyToServiceDeskInput): Promise<boolean> {
    const reply = (text: string): Promise<SentMessageRef | undefined> =>
      this.wireOutbound.sendPlainText(input.conversationId, text, { replyToMessageId: input.replyToMessageId });

    const request = await findSupportRequestInConversation(
      this.requests, input.reference, input.conversationId, this.tracker.projectKey,
    );
    if (!request) {
      await reply(notInConversation(input.reference));
      return false;
    }
    const key = request.key;
    // A message naming this conversation's request becomes its last message, quoted by the next watch update.
    const replyAbout = async (text: string): Promise<void> =>
      rememberLastMessage(this.requests, key, await reply(text), "ReplyToServiceDesk", this.logger);

    const body = input.body.trim();
    if (!body) {
      await reply("I'm afraid there is nothing to send.");
      return false;
    }
    if (body.length > REPLY_BODY_MAX) {
      await reply(`I'm afraid that reply is too long for Jira; please keep it under ${REPLY_BODY_MAX} characters.`);
      return false;
    }

    try {
      await this.tracker.addCustomerReply(key, `${body}\n\n${REPLY_FOOTER}`);
    } catch (err) {
      this.logger?.warn("ReplyToServiceDesk: addCustomerReply failed", trackerErrorFields(err));
      if (wasRefused(err)) {
        await replyAbout(`I'm afraid I couldn't send the reply to **${key}** just now.`);
        return false;
      }
      // Jira may have accepted the reply, so the attempt is recorded.
      await this.audit(input, key, { supportRequest: key, outcome: "reply_unconfirmed" });
      await replyAbout(`I'm afraid I couldn't confirm that the reply reached **${key}**. Please check the ticket before sending it again.`);
      return false;
    }

    this.metrics.supportReplySent();
    // The reply is public in Jira now, so an audit failure must not suggest otherwise.
    await this.audit(input, key, { supportRequest: key });
    await replyAbout(`Sent your reply to **${key}** in Jira.`);
    return true;
  }

  private audit(input: ReplyToServiceDeskInput, key: string, details: Record<string, unknown>): Promise<void> {
    return appendAuditSafely(this.auditLog, {
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_created",
      entityType: "JiraComment",
      entityId: key,
      details,
    }, "ReplyToServiceDesk", this.logger);
  }
}
