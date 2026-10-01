import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { SupportRequest, SupportRequestStatusCategory } from "../../../domain/entities/SupportRequest";
import type { AuditLogEntry, AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import { IssueTrackerError } from "../../ports/IssueTrackerPort";
import type { Logger } from "../../ports/Logger";

/** Actor recorded for writes the bot makes on its own, such as a status refresh after a read. */
export function botActor(conversationId: QualifiedId): QualifiedId {
  return { id: "wire-support-bot", domain: conversationId.domain };
}

/**
 * Stores the category just read from the tracker when it differs from the last known one,
 * and audits the change. Returns the updated record, or null when nothing was written: an
 * unchanged category, a record that no longer exists, or a failed write. A failure is logged
 * and never breaks the reply, since the live value always comes from the tracker.
 */
export async function refreshStatusCategory(
  requests: SupportRequestRepository,
  auditLog: AuditLogRepository,
  request: SupportRequest,
  statusCategory: SupportRequestStatusCategory,
  actorId: QualifiedId,
  logger?: Logger,
  now: Date = new Date(),
): Promise<SupportRequest | null> {
  if (request.statusCategory === statusCategory) return null;
  try {
    const updated = await requests.updateStatusCategory(request.key, statusCategory, now);
    if (!updated) return null;
    await auditLog.append({
      timestamp: now,
      actorId,
      conversationId: request.conversationId,
      action: "entity_updated",
      entityType: "SupportRequest",
      entityId: request.key,
      details: { statusCategory },
    });
    return updated;
  } catch (err) {
    logger?.warn("Support request status refresh failed", { key: request.key, err: err instanceof Error ? err.name : "UnknownError" });
    return null;
  }
}

/** The reply for a key that is not a support request of this conversation, whatever the reason. */
export function notInConversation(reference: string): string {
  return `I'm afraid **${reference.trim().toUpperCase()}** isn't a support request in this conversation.`;
}

/**
 * Only a 4xx response means Jira refused the write. A timeout, network error, 5xx or
 * unexpected response may follow an accepted write, so it must not invite a retry.
 */
export function wasRefused(err: unknown): boolean {
  return err instanceof IssueTrackerError && err.status !== undefined && err.status >= 400 && err.status < 500;
}

/**
 * Appends an audit entry after a tracker write. The tracker may have changed by then, so a
 * failure is logged with the error name only and never changes the reply.
 */
export async function appendAuditSafely(
  auditLog: AuditLogRepository, entry: AuditLogEntry, source: string, logger?: Logger,
): Promise<void> {
  try {
    await auditLog.append(entry);
  } catch (err) {
    logger?.error(`${source}: audit append failed`, { err: err instanceof Error ? err.name : "UnknownError" });
  }
}
