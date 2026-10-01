import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import type { IssueReply } from "../../ports/IssueTrackerPort";
import type { SentMessageRef } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";

/**
 * The watch markers of a support request (see the watch in WatchSupportRequests).
 * Both are bookkeeping: a failed write is logged with the error name only and never changes
 * or breaks the reply that led to it.
 */

/**
 * Stores the bot's message that just named the request as its last message about it, so the
 * next watch update quotes it. Nothing is stored when the transport returned no reference.
 * Callers pass only keys of records that belong to the conversation the message went to.
 */
export async function rememberLastMessage(
  requests: SupportRequestRepository,
  key: string,
  ref: SentMessageRef | undefined,
  source: string,
  logger?: Logger,
): Promise<void> {
  if (!ref) return;
  try {
    await requests.setLastMessage(key, { messageId: ref.messageId, sha256: ref.sha256 });
  } catch (err) {
    logger?.warn(`${source}: storing the last message failed`, { key, err: errorName(err) });
  }
}

/**
 * Marks the newest of the replies just shown as seen, so the watch does not announce it again.
 * Nothing is written when no reply was shown.
 */
export async function markRepliesSeen(
  requests: SupportRequestRepository,
  key: string,
  shown: readonly IssueReply[],
  source: string,
  logger?: Logger,
): Promise<void> {
  const newest = newestReplyTime(shown);
  if (!newest) return;
  try {
    await requests.advanceLastSeenReplyAt(key, newest);
  } catch (err) {
    logger?.warn(`${source}: advancing the last seen reply failed`, { key, err: errorName(err) });
  }
}

/** Creation time of the newest reply, or undefined when there is none with a valid time. */
function newestReplyTime(replies: readonly IssueReply[]): Date | undefined {
  let newest: Date | undefined;
  for (const reply of replies) {
    if (!(reply.created instanceof Date) || Number.isNaN(reply.created.getTime())) continue;
    if (!newest || reply.created > newest) newest = reply.created;
  }
  return newest;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
