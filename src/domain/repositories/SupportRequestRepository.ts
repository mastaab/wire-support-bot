import type { SupportRequest, SupportRequestStatusCategory } from "../entities/SupportRequest";
import type { QualifiedId } from "../ids/QualifiedId";

export interface SupportRequestListOptions {
  /** Only requests whose last known category is not `done`. */
  openOnly?: boolean;
  /** Only requests raised by this member. */
  requesterId?: QualifiedId;
  /** Defaults to 50. */
  limit?: number;
}

/**
 * Persistence for support requests. Callers enforce conversation scope and audit writes;
 * the repository never returns deleted records from `listByConversation`.
 */
export interface SupportRequestRepository {
  create(request: SupportRequest): Promise<SupportRequest>;
  /** Exact key lookup (upper-cased by the caller), including deleted records. */
  findByKey(key: string): Promise<SupportRequest | null>;
  /** Not-deleted requests of the conversation (qualified ID match), newest first. */
  listByConversation(conversationId: QualifiedId, options?: SupportRequestListOptions): Promise<SupportRequest[]>;
  /** Stores a new last known category, bumps `version` and `updatedAt`; returns the updated record or null when absent. */
  updateStatusCategory(key: string, statusCategory: SupportRequestStatusCategory, updatedAt: Date): Promise<SupportRequest | null>;
  /**
   * Not-deleted requests of every conversation to watch for tracker changes: all whose last
   * known category is not `done`, plus `done` ones updated at or after `resolvedSince` (to catch
   * a reopen). Oldest first, at most `limit` (defaults to 500).
   */
  listWatched(resolvedSince: Date, limit?: number): Promise<SupportRequest[]>;
  /**
   * Bookkeeping, not audited; leaves `version` and `updatedAt` alone. Sets `lastSeenReplyAt`
   * only when it is absent or earlier than `at`, so it never moves back.
   */
  advanceLastSeenReplyAt(key: string, at: Date): Promise<void>;
  /** Bookkeeping, not audited; leaves `version` and `updatedAt` alone. Null clears it; also stamps `assigneeSeenAt` once. */
  setAssignee(key: string, accountId: string | null): Promise<void>;
  /**
   * Sets `agentConversationAt` only when it is not set yet; true when this call set it, so two
   * checks can never open two conversations for one request.
   */
  markAgentConversation(key: string, at: Date): Promise<boolean>;
  /** Bookkeeping, not audited; leaves `version` and `updatedAt` alone. Also stamps `lastMessageAt` with the current time. */
  setLastMessage(key: string, ref: { messageId: string; sha256: string }): Promise<void>;
  /** Bookkeeping, not audited; leaves `version` and `updatedAt` alone. Stores the group created for the request. */
  setAgentConversation(key: string, conversationId: QualifiedId): Promise<void>;
  /** Bookkeeping, not audited; leaves `version` and `updatedAt` alone. Stores when leaving that group was confirmed. */
  markAgentConversationLeft(key: string, at: Date): Promise<void>;
  /**
   * Requests whose group is stored but not yet left, deleted ones included (the bot still has to
   * leave their group). Oldest first, at most `limit` (defaults to 500).
   */
  listAgentConversationsNotLeft(limit?: number): Promise<SupportRequest[]>;
}
