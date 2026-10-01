import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { SupportRequest } from "../../../domain/entities/SupportRequest";
import type { AuditLogEntry, AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueSnapshot, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { SentMessageRef, WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { REPLY_BODY_MAX } from "../../services/offers";
import { SupportRequestWrites } from "../../services/SupportRequestWrites";
import { REPLY_FOOTER, formatResolution } from "./formatIssue";
import { findSupportRequestInConversation } from "./supportRequestScope";
import { appendAuditSafely, botActor, notInConversation, refreshStatusCategory, wasRefused } from "./supportRequestStatus";
import { rememberLastMessage } from "./supportRequestMarkers";

export interface ResolveSupportRequestInput {
  issueKey: string;
  conversationId: QualifiedId;
  /** Any member of the channel may resolve; the audit entry records who did. */
  actorId: QualifiedId;
  /**
   * A closing comment, sent first as a customer-facing reply (footer "Sent from Wire.",
   * audited). If it is refused or its delivery cannot be confirmed, the request is not resolved.
   */
  comment?: string;
  replyToMessageId?: string;
}

/**
 * Moves a support request of this conversation to done with the service desk, stores the
 * resulting category and reports the SLA outcome. A request last known as done is read live
 * first, since the desk may have reopened it. Every attempt that reaches the tracker is
 * audited with the actor, because some transitions may apply before a failure.
 *
 * A closing comment is sent first, so the desk never sees a closed request without the
 * explanation: when it is refused or its delivery cannot be confirmed, nothing is resolved.
 * The comment is sent to the ticket only; it is never stored, logged or audited.
 */
export class ResolveSupportRequest {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger?: Logger,
    /** Shared with the watch, which skips a request while it is being resolved here. */
    private readonly writes: SupportRequestWrites = new SupportRequestWrites(),
  ) {}

  /** The final snapshot, or null when nothing was resolved. Exactly one Wire message is sent. */
  async execute(input: ResolveSupportRequestInput): Promise<IssueSnapshot | null> {
    const reply = (text: string): Promise<SentMessageRef | undefined> =>
      this.wireOutbound.sendPlainText(input.conversationId, text, { replyToMessageId: input.replyToMessageId });

    const request = await findSupportRequestInConversation(
      this.requests, input.issueKey, input.conversationId, this.tracker.projectKey,
    );
    if (!request) {
      await reply(notInConversation(input.issueKey));
      return null;
    }
    const key = request.key;
    // Every message below names this conversation's request, so each becomes its last message,
    // quoted by the next watch update.
    const replyAbout = async (text: string): Promise<SentMessageRef | undefined> => {
      const ref = await reply(text);
      await rememberLastMessage(this.requests, key, ref, "ResolveSupportRequest", this.logger);
      return ref;
    };
    let comment: string | undefined;
    if (input.comment !== undefined) {
      comment = input.comment.trim();
      if (!comment) {
        await replyAbout(`I'm afraid the comment is empty, so I haven't resolved **${key}**.`);
        return null;
      }
      if (comment.length > REPLY_BODY_MAX) {
        await replyAbout(`I'm afraid that comment is too long for Jira, so I haven't resolved **${key}**; please keep it under ${REPLY_BODY_MAX} characters.`);
        return null;
      }
    }
    let current = request;
    if (request.statusCategory === "done") {
      // The desk may have reopened the ticket since, so the last known category is checked live.
      let live: IssueSnapshot | null;
      try {
        live = await this.tracker.getIssue(key);
      } catch (err) {
        this.logger?.warn("ResolveSupportRequest: getIssue failed", { key, ...trackerErrorFields(err) });
        live = null;
      }
      if (!live) {
        await replyAbout(`I'm afraid I couldn't reach Jira to check **${key}** just now; please try again later.`);
        return null;
      }
      const refreshed = await refreshStatusCategory(
        this.requests, this.auditLog, request, live.statusCategory, botActor(input.conversationId), this.logger,
      );
      if (live.statusCategory === "done") {
        await replyAbout(comment !== undefined
          ? `**${key}** is already resolved, so I haven't added your comment.`
          : `**${key}** is already resolved.`);
        return null;
      }
      current = refreshed ?? { ...request, statusCategory: live.statusCategory };
    }

    if (comment !== undefined && !(await this.addComment(input, key, comment, replyAbout))) return null;

    const entry: Omit<AuditLogEntry, "details"> = {
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "SupportRequest",
      entityId: key,
    };
    let snapshot: IssueSnapshot;
    let refreshed: SupportRequest | null;
    try {
      // The new category is stored inside the guard, so the watch never sees Jira ahead of the record.
      [snapshot, refreshed] = await this.writes.during(key, async () => {
        const resolved = await this.tracker.resolveIssue(key);
        // The refresh audits a changed category with the actor; an unchanged one is audited
        // below, so every resolve attempt that reached the tracker has an entry.
        return [resolved, await refreshStatusCategory(
          this.requests, this.auditLog, current, resolved.statusCategory, input.actorId, this.logger,
        )] as const;
      });
    } catch (err) {
      this.logger?.warn("ResolveSupportRequest: resolveIssue failed", { key, ...trackerErrorFields(err) });
      await appendAuditSafely(this.auditLog, { ...entry, details: { outcome: "resolve_failed" } }, "ResolveSupportRequest", this.logger);
      await replyAbout(withCommentNote(`I'm afraid I couldn't resolve **${key}** with the service desk; please check the ticket.`, comment));
      return null;
    }

    if (!refreshed) {
      await appendAuditSafely(this.auditLog, { ...entry, details: { statusCategory: snapshot.statusCategory } }, "ResolveSupportRequest", this.logger);
    }
    await replyAbout(resolutionReply(snapshot, comment));
    return snapshot;
  }

  /**
   * Sends the closing comment with the Wire footer. True when Jira accepted it; otherwise the
   * requester is told that nothing was resolved, and an unconfirmed delivery is audited, since
   * Jira may have accepted it.
   */
  private async addComment(
    input: ResolveSupportRequestInput, key: string, comment: string, reply: (text: string) => Promise<SentMessageRef | undefined>,
  ): Promise<boolean> {
    try {
      await this.tracker.addCustomerReply(key, `${comment}\n\n${REPLY_FOOTER}`);
    } catch (err) {
      this.logger?.warn("ResolveSupportRequest: addCustomerReply failed", { key, ...trackerErrorFields(err) });
      if (wasRefused(err)) {
        await reply(`I'm afraid I couldn't add the comment to **${key}**, so I haven't resolved it.`);
        return false;
      }
      await this.auditComment(input, key, { supportRequest: key, outcome: "reply_unconfirmed" });
      await reply(`I'm afraid I couldn't confirm that the comment reached **${key}**, so I haven't resolved it. Please check the ticket.`);
      return false;
    }
    // The comment is public in Jira now, so an audit failure must not stop the resolve.
    await this.auditComment(input, key, { supportRequest: key });
    return true;
  }

  private auditComment(input: ResolveSupportRequestInput, key: string, details: Record<string, unknown>): Promise<void> {
    return appendAuditSafely(this.auditLog, {
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_created",
      entityType: "JiraComment",
      entityId: key,
      details,
    }, "ResolveSupportRequest", this.logger);
  }
}

/** The resolution reply; after a closing comment, a line saying it was added comes before the SLA lines. */
function resolutionReply(snapshot: IssueSnapshot, comment: string | undefined): string {
  const text = formatResolution(snapshot);
  if (comment === undefined) return text;
  if (snapshot.statusCategory !== "done") return withCommentNote(text, comment);
  const [first, ...slaLines] = text.split("\n");
  return [first, "Added your comment before resolving.", ...slaLines].join("\n");
}

/** A failed or incomplete resolve after the comment was sent says the comment is on the ticket. */
function withCommentNote(text: string, comment: string | undefined): string {
  return comment === undefined ? text : `${text}\nYour comment was added to the ticket.`;
}
