import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { SupportRequest, SupportRequestKind } from "../../../domain/entities/SupportRequest";
import { isKeyInProject } from "../../../domain/ids/jiraLink";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueSnapshot, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { statusLabel } from "./formatIssue";
import { botActor, refreshStatusCategory } from "./supportRequestStatus";

export interface ListSupportRequestsInput {
  conversationId: QualifiedId;
  /** Only the requests this member raised ("my support requests"). */
  requesterId?: QualifiedId;
  replyToMessageId?: string;
}

const LISTED_MAX = 10;

/** How each kind opens its line, so the desk's queues are visible in the list. */
const KIND_LABEL: Record<SupportRequestKind, string> = {
  question: "Question",
  part: "Part order",
  fault: "Fault",
};

/**
 * Lists the open support requests of this conversation with their live status. The newest
 * requests are read whatever their last known category, so one the desk has reopened shows
 * again. Every changed category is refreshed and a request the tracker reports as done is
 * left out; when the tracker cannot be read, the last known status is shown, marked as such,
 * unless it is done.
 */
export class ListSupportRequests {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /** The requests shown, in the order listed. */
  async execute(input: ListSupportRequestsInput): Promise<SupportRequest[]> {
    const stored = (await this.requests.listByConversation(input.conversationId, {
      requesterId: input.requesterId,
      limit: LISTED_MAX,
    })).filter((request) => isKeyInProject(request.key, this.tracker.projectKey));
    const live = await Promise.all(stored.map((request) => this.readLive(request)));

    const shown: SupportRequest[] = [];
    const lines: string[] = [];
    for (let i = 0; i < stored.length; i++) {
      const request = stored[i]!;
      const snapshot = live[i];
      if (snapshot) {
        await refreshStatusCategory(
          this.requests, this.auditLog, request, snapshot.statusCategory, botActor(input.conversationId), this.logger,
        );
        if (snapshot.statusCategory === "done") continue;
      } else if (request.statusCategory === "done") {
        continue;
      }
      const status = snapshot ? statusLabel(snapshot.statusCategory) : `${statusLabel(request.statusCategory)} (last known)`;
      const requester = request.requesterName ? ` (${request.requesterName})` : "";
      lines.push(`- ${KIND_LABEL[request.kind]} **${request.key}** ${request.summary}${requester}: ${status}`);
      shown.push(request);
    }

    const text = lines.length > 0
      ? [input.requesterId ? "Your open support requests in this channel:" : "Open support requests in this channel:", ...lines].join("\n")
      : input.requesterId
        ? "You have no open support requests in this channel."
        : "There are no open support requests in this channel.";
    await this.wireOutbound.sendPlainText(input.conversationId, text, { replyToMessageId: input.replyToMessageId });
    return shown;
  }

  /** The live snapshot, or null when the tracker cannot be read or no longer shows the ticket. */
  private async readLive(request: SupportRequest): Promise<IssueSnapshot | null> {
    try {
      return await this.tracker.getIssue(request.key);
    } catch (err) {
      this.logger?.warn("ListSupportRequests: getIssue failed", { key: request.key, ...trackerErrorFields(err) });
      return null;
    }
  }
}
