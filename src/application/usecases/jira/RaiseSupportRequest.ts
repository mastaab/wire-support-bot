import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { DEFAULT_PART_ASSET, PART_DETAIL_MAX, SUPPORT_DESCRIPTION_MAX, SUPPORT_SUMMARY_MAX } from "../../../domain/entities/SupportRequest";
import type { PartAssetWording, PartDetails, SupportRequest, SupportRequestKind } from "../../../domain/entities/SupportRequest";
import { formatStillMissingReply, partDetailFields } from "../../services/offers";
import { isKeyInProject } from "../../../domain/ids/jiraLink";
import type { AuditLogEntry, AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { CreateIssueRequest, CreatedIssue, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { SentMessageRef, WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { NO_METRICS, type MetricsPort } from "../../ports/MetricsPort";
import { appendAuditSafely, wasRefused } from "./supportRequestStatus";
import { rememberLastMessage } from "./supportRequestMarkers";

export interface RaiseSupportRequestInput {
  /** One line; becomes the ticket title and the stored summary. */
  summary: string;
  /** The full problem description. Sent to the ticket; never stored or logged. */
  description: string;
  conversationId: QualifiedId;
  requesterId: QualifiedId;
  /** Wire display name of the requester, when resolved. */
  requesterName?: string;
  replyToMessageId?: string;
  /** Decides the tracker's request type; `fault` when absent. */
  requestKind?: SupportRequestKind;
  /** The essentials of a part order; all four are required when `requestKind` is `part`. */
  part?: PartDetails;
}

const LABEL = "wire-support-bot";
/** A raw user ID, optionally qualified with its domain, is not a name the desk can use. */
const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(@\S+)?$/i;

/**
 * Raises a support request with the service desk and records it for this conversation.
 * The ticket carries only what the requester asked to raise plus their display name, never
 * the surrounding conversation. One bot process serves all conversations, so an in-process
 * guard per conversation and requester is enough to stop a double submit.
 */
export class RaiseSupportRequest {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger?: Logger,
    /** Tracker request type per kind; a kind without an entry uses the tracker's default. */
    private readonly requestTypes: Partial<Record<SupportRequestKind, string>> = {},
    /** How the asset essential of a part order is named and asked for. */
    private readonly partAsset: PartAssetWording = DEFAULT_PART_ASSET,
    /** Counts the requests raised with the service desk, by kind. */
    private readonly metrics: MetricsPort = NO_METRICS,
  ) {}

  async execute(input: RaiseSupportRequestInput): Promise<SupportRequest | null> {
    const reply = (text: string): Promise<SentMessageRef | undefined> =>
      this.wireOutbound.sendPlainText(input.conversationId, text, { replyToMessageId: input.replyToMessageId });

    const summary = input.summary.replace(/\s+/g, " ").trim();
    const description = input.description.trim();
    if (!summary || !description) {
      await reply("I'm afraid there is nothing to raise; please describe the problem.");
      return null;
    }
    if (summary.length > SUPPORT_SUMMARY_MAX) {
      await reply(`I'm afraid that summary is too long; please keep it under ${SUPPORT_SUMMARY_MAX} characters.`);
      return null;
    }
    if (description.length > SUPPORT_DESCRIPTION_MAX) {
      await reply(`I'm afraid that description is too long; please keep it under ${SUPPORT_DESCRIPTION_MAX} characters.`);
      return null;
    }
    const kind = input.requestKind ?? "fault";
    const part = kind === "part" ? partLines(input.part, this.partAsset) : null;
    if (part && part.missing.length > 0) {
      // The offer path never confirms an incomplete order; this guards any other caller.
      await reply(formatStillMissingReply(part.missing, this.partAsset));
      return null;
    }

    const guardKey = [input.conversationId.id, input.conversationId.domain, input.requesterId.id, input.requesterId.domain].join("|");
    if (this.inFlight.has(guardKey)) {
      await reply("Your support request is already being raised with the service desk.");
      return null;
    }
    this.inFlight.add(guardKey);
    try {
      // Summaries often start lower-case ("my VPN drops"); a ticket title should not.
      const body = part ? `${part.lines.join("\n")}\n\n${description}` : description;
      return await this.raise(summary.charAt(0).toUpperCase() + summary.slice(1), body, kind, input, reply);
    } finally {
      this.inFlight.delete(guardKey);
    }
  }

  private async raise(
    summary: string, description: string, kind: SupportRequestKind, input: RaiseSupportRequestInput,
    reply: (text: string) => Promise<SentMessageRef | undefined>,
  ): Promise<SupportRequest | null> {
    const requesterName = displayName(input.requesterName);
    let created: CreatedIssue;
    try {
      created = await this.tracker.createIssue(buildRequest(summary, description, requesterName, this.requestTypes[kind]));
    } catch (err) {
      this.logger?.warn("RaiseSupportRequest: createIssue failed", trackerErrorFields(err));
      const refused = wasRefused(err);
      // No key is known, but a ticket may exist after an unconfirmed create, so the attempt is recorded.
      await this.appendAudit({
        timestamp: new Date(), actorId: input.requesterId, conversationId: input.conversationId,
        action: "entity_created", entityType: "JiraIssue", entityId: "unknown",
        details: { outcome: refused ? "create_refused" : "create_unconfirmed" },
      });
      await reply(refused
        ? "I'm afraid I couldn't raise the request with the service desk just now."
        : `I'm afraid I couldn't confirm that the request reached the service desk. Please check the ${this.tracker.projectKey} queue before raising it again.`);
      return null;
    }
    // Counted once the tracker has the ticket, also when it cannot be recorded here.
    this.metrics.supportRequestRaised(kind);
    const key = created.key.toUpperCase();
    const now = new Date();

    if (!isKeyInProject(key, this.tracker.projectKey)) {
      // A key outside the project would never pass the scope helper, so it is not stored.
      this.logger?.warn("RaiseSupportRequest: created key is outside the project");
      await this.appendAudit({
        timestamp: now, actorId: input.requesterId, conversationId: input.conversationId,
        action: "entity_created", entityType: "JiraIssue", entityId: key, details: { outcome: "unexpected_key" },
      });
      await reply(`Raised the request with the service desk (${created.url}), but I'm afraid I can't track it from Wire.`);
      return null;
    }

    let stored: SupportRequest;
    try {
      stored = await this.requests.create({
        key,
        conversationId: input.conversationId,
        requesterId: input.requesterId,
        requesterName,
        summary,
        kind,
        statusCategory: "todo",
        createdAt: now,
        updatedAt: now,
        deleted: false,
        version: 1,
        // A new ticket has no replies yet, so the watch has nothing earlier to announce.
        lastSeenReplyAt: now,
        // Nor an assignee: an agent assigned before the watch's first check is a change, which
        // opens the direct conversation, not a baseline that only records it.
        assigneeSeenAt: now,
      });
    } catch (err) {
      this.logger?.warn("RaiseSupportRequest: storing the support request failed", { key, err: err instanceof Error ? err.name : "UnknownError" });
      // The ticket exists, so record the tracker write even though the record is missing.
      await this.appendAudit({
        timestamp: new Date(), actorId: input.requesterId, conversationId: input.conversationId,
        action: "entity_created", entityType: "JiraIssue", entityId: key, details: { outcome: "store_failed" },
      });
      await reply(`Raised **${key}** with the service desk (${created.url}), but I'm afraid I couldn't record it here, so I can't follow it from this channel.`);
      return null;
    }

    await this.appendAudit({
      timestamp: new Date(), actorId: input.requesterId, conversationId: input.conversationId,
      action: "entity_created", entityType: "SupportRequest", entityId: key, details: { statusCategory: "todo", kind },
    });

    let text = `Raised **${key}** with the service desk: ${created.url}`;
    if (!created.fieldsApplied) text += "\nI'm afraid I couldn't set the label on the ticket.";
    await rememberLastMessage(this.requests, key, await reply(text), "RaiseSupportRequest", this.logger);
    return stored;
  }

  /** The tracker may have changed by now, so an audit failure must not suggest otherwise. */
  private appendAudit(entry: AuditLogEntry): Promise<void> {
    return appendAuditSafely(this.auditLog, entry, "RaiseSupportRequest", this.logger);
  }
}

/** The name kept on the record and shown to the desk; empty when none was resolved. */
function displayName(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed && !USER_ID_RE.test(trimmed) ? trimmed : "";
}

/** The ticket carries the requester's own words and their name only (extract-and-forget). */
function buildRequest(summary: string, description: string, requesterName: string, requestTypeId: string | undefined): CreateIssueRequest {
  const requesterLine = requesterName ? `Requested by ${requesterName} via Wire.` : "Requested via Wire.";
  return {
    summary,
    description: `${description}\n\n${requesterLine}`,
    labels: [LABEL],
    ...(requestTypeId ? { requestTypeId } : {}),
  };
}

/**
 * The part-order essentials as ticket lines (`Asset: …`, with the configured asset label), in the
 * order they are shown to the requester, plus those missing. A value is collapsed to one line;
 * one that is empty or over `PART_DETAIL_MAX` counts as missing.
 */
function partLines(part: PartDetails | undefined, asset: PartAssetWording): { lines: string[]; missing: Array<keyof PartDetails> } {
  const lines: string[] = [];
  const missing: Array<keyof PartDetails> = [];
  for (const { key, label } of partDetailFields(asset)) {
    const value = (part?.[key] ?? "").replace(/\s+/g, " ").trim();
    if (value && value.length <= PART_DETAIL_MAX) lines.push(`${label}: ${value}`);
    else missing.push(key);
  }
  return { lines, missing };
}
