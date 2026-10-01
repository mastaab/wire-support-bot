import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueReply, IssueSnapshot, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { SentMessageRef, WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { formatIssueStatus, formatReplies } from "./formatIssue";
import { findSupportRequestInConversation } from "./supportRequestScope";
import { botActor, notInConversation, refreshStatusCategory } from "./supportRequestStatus";
import { markRepliesSeen, rememberLastMessage } from "./supportRequestMarkers";

export interface GetIssueStatusInput {
  /** A tracker key, e.g. "SD-6". */
  reference: string;
  conversationId: QualifiedId;
  /** Conversation timezone for reply times; UTC when absent. */
  timezone?: string;
  replyToMessageId?: string;
}

const REPLIES_SHOWN = 3;

/** Reads a support request's live status, restricted to support requests of this conversation. */
export class GetIssueStatus {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /** The only project whose keys this lookup accepts. */
  get projectKey(): string {
    return this.tracker.projectKey;
  }

  async execute(input: GetIssueStatusInput): Promise<IssueSnapshot | null> {
    const reply = (text: string): Promise<SentMessageRef | undefined> =>
      this.wireOutbound.sendPlainText(input.conversationId, text, { replyToMessageId: input.replyToMessageId });

    const request = await findSupportRequestInConversation(
      this.requests, input.reference, input.conversationId, this.tracker.projectKey,
    );
    if (!request) {
      await reply(notInConversation(input.reference));
      return null;
    }
    const key = request.key;

    let snapshot: IssueSnapshot | null;
    try {
      snapshot = await this.tracker.getIssue(key);
    } catch (err) {
      this.logger?.warn("GetIssueStatus: getIssue failed", trackerErrorFields(err));
      await reply("I'm afraid I couldn't reach Jira just now.");
      return null;
    }
    // Both messages below name this conversation's request, so each becomes its last message,
    // quoted by the next watch update.
    if (!snapshot) {
      await this.remember(key, await reply(`I'm afraid I couldn't find **${key}** in Jira.`));
      return null;
    }
    await refreshStatusCategory(
      this.requests, this.auditLog, request, snapshot.statusCategory, botActor(input.conversationId), this.logger,
    );
    const replies = await this.replies(key);
    const block = replies
      ? formatReplies(replies, input.timezone ?? "UTC")
      : "I'm afraid I couldn't load the replies from Jira just now.";
    await this.remember(key, await reply(formatIssueStatus(snapshot, block)));
    // The replies have been shown, so the watch does not announce them again.
    if (replies) await markRepliesSeen(this.requests, key, replies, "GetIssueStatus", this.logger);
    return snapshot;
  }

  /** Customer-facing replies only; null when the read failed (the status is still shown). */
  private async replies(key: string): Promise<IssueReply[] | null> {
    try {
      return await this.tracker.listCustomerReplies(key, REPLIES_SHOWN);
    } catch (err) {
      this.logger?.warn("GetIssueStatus: listCustomerReplies failed", trackerErrorFields(err));
      return null;
    }
  }

  private remember(key: string, ref: SentMessageRef | undefined): Promise<void> {
    return rememberLastMessage(this.requests, key, ref, "GetIssueStatus", this.logger);
  }
}
