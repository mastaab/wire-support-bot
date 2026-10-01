import type { QualifiedId } from "../ids/QualifiedId";

/** Language-independent status bucket, as reported by the tracker. */
export type SupportRequestStatusCategory = "todo" | "in_progress" | "done";

/**
 * What the request is about, which decides the tracker's request type: a question to the
 * service desk, a replacement part order, or a fault (faults, breakdowns, damage, service needs).
 */
export type SupportRequestKind = "question" | "part" | "fault";

export const SUPPORT_REQUEST_KINDS: readonly SupportRequestKind[] = ["question", "part", "fault"];

/** The essentials of a part order, each as the requester gave it; absent when not yet known. */
export interface PartDetails {
  /** The item the part is for, such as a serial or asset number (see `PartAssetWording`). */
  asset?: string;
  /** Part name or number. */
  part?: string;
  quantity?: string;
  deliverTo?: string;
}

/**
 * How the bot names the asset essential of a part order, the item the part is for: the label
 * shown in confirmations and tickets ("Asset: ...") and the phrase it asks with ("To order it I
 * need <question>."). Configured per deployment, for example "Device" and "the device (its
 * serial number)".
 */
export interface PartAssetWording {
  label: string;
  question: string;
}

export const DEFAULT_PART_ASSET: PartAssetWording = {
  label: "Asset",
  question: "the item the part is for (for example a serial number)",
};

/** Longest asset label and asset question accepted from the configuration. */
export const PART_ASSET_LABEL_MAX = 40;
export const PART_ASSET_QUESTION_MAX = 200;

/** Longest value of a single part detail. */
export const PART_DETAIL_MAX = 200;

/** Longest summary kept on the record and sent as the ticket title. */
export const SUPPORT_SUMMARY_MAX = 120;

/** Longest problem description sent to the ticket. */
export const SUPPORT_DESCRIPTION_MAX = 4000;

/**
 * A service-desk request raised from Wire. The tracker key is the record's ID (e.g. "SD-6").
 * The full problem description goes to the tracker and is not stored here; the summary is
 * the extract kept for recall and listing (extract-and-forget).
 */
export interface SupportRequest {
  /** Tracker key of the configured project, upper-case. */
  key: string;
  conversationId: QualifiedId;
  /** The member who raised the request. */
  requesterId: QualifiedId;
  /** Display name at the time of raising; may be empty when none was resolved. */
  requesterName: string;
  /** One line: what the requester said the problem is. */
  summary: string;
  kind: SupportRequestKind;
  /** Last known category, refreshed whenever the bot reads the ticket. The live value comes from the tracker. */
  statusCategory: SupportRequestStatusCategory;
  createdAt: Date;
  updatedAt: Date;
  deleted: boolean;
  version: number;
  /**
   * Creation time of the newest customer-facing reply already shown or announced in Wire.
   * Absent on records from before watching existed; the first check sets it without announcing.
   */
  lastSeenReplyAt?: Date;
  /**
   * The bot's latest message about this request in its conversation, quoted by the next update.
   * Message ID and integrity hash only, never text.
   */
  lastMessage?: { messageId: string; sha256: string };
  /** When `lastMessage` was stored; picks the request a posted photo or file most likely belongs to. */
  lastMessageAt?: Date;
  /** Tracker account ID of the assignee last seen by the watch; absent when unassigned or not yet seen. */
  assigneeAccountId?: string;
  /** When the watch first stored the assignee (even "unassigned"); absent: not yet seen, so the next check only takes a baseline. */
  assigneeSeenAt?: Date;
  /** When the bot opened the direct conversation between requester and agent; at most once. */
  agentConversationAt?: Date;
  /** The group the bot created for that conversation, stored as soon as it exists; absent before. */
  agentConversationId?: QualifiedId;
  /** When the bot's leave from that group was confirmed; absent while leaving is still owed. */
  agentConversationLeftAt?: Date;
}
