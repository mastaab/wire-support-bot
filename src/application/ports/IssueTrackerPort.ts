/**
 * Issue tracker port: the application's view of an external ticketing system
 * (Jira Service Management in this repository). Use cases depend on this
 * interface only; the adapter owns HTTP, authentication and workflow details.
 */

/** Language-independent status bucket. Tracker status names are localised, so never match on them. */
export type IssueStatusCategory = "todo" | "in_progress" | "done";

export type SlaState = "running" | "paused" | "met" | "breached";

export interface SlaSummary {
  /** Tracker-defined SLA name, e.g. "Time to done". */
  name: string;
  state: SlaState;
  /** Human-readable durations as reported by the tracker, e.g. "3m", "16h". */
  elapsed?: string;
  remaining?: string;
  goal?: string;
}

export interface IssueSnapshot {
  key: string;
  url: string;
  summary: string;
  statusCategory: IssueStatusCategory;
  slas: SlaSummary[];
}

export interface CreateIssueRequest {
  summary: string;
  /** Plain text. Must not contain surrounding conversation (extract-and-forget). */
  description: string;
  /** Calendar date (YYYY-MM-DD) already resolved in the conversation's timezone. */
  dueDate?: string;
  labels?: string[];
  /** Tracker request type for this request; the configured general (fault) type when absent. */
  requestTypeId?: string;
}

/** A reply visible to the customer. Internal agent notes are never represented. */
export interface IssueReply {
  author: string;
  created: Date;
  /**
   * Plain text as entered in the tracker. Show it; never store or log it. It reaches the
   * answer model only when sharing ticket content with the model is explicitly enabled.
   */
  body: string;
  /** True when the reply was sent by this bot's own tracker account (from Wire). */
  fromThisBot?: boolean;
}

export interface CreatedIssue {
  key: string;
  url: string;
  /** False when the issue was created but the follow-up field edit (due date, labels) failed. */
  fieldsApplied: boolean;
}

/** Current state of an issue, as returned by the change check. */
export interface IssueChange {
  key: string;
  statusCategory: IssueStatusCategory;
  /** The tracker's last update time of the issue (any field, comment or transition). */
  updated: Date;
  /** Tracker account ID of the assignee; absent when unassigned. */
  assigneeAccountId?: string;
}

export interface IssueTrackerPort {
  /** Project key the tracker is scoped to. Keys from other projects must be rejected by callers. */
  readonly projectKey: string;
  createIssue(request: CreateIssueRequest): Promise<CreatedIssue>;
  /** Returns null when the issue does not exist or is not visible. */
  getIssue(key: string): Promise<IssueSnapshot | null>;
  /**
   * Moves the issue towards a done-category status by following workflow transitions
   * by category, within a bounded number of hops. Returns the final snapshot, which may
   * not be done if no path was found; callers must report the actual category.
   */
  resolveIssue(key: string): Promise<IssueSnapshot>;
  /**
   * The newest `limit` customer-facing replies, oldest first. Implementations must exclude
   * internal notes even when the credential could read them.
   */
  listCustomerReplies(key: string, limit: number): Promise<IssueReply[]>;
  /** Adds a customer-facing reply (never an internal note) to the issue. */
  addCustomerReply(key: string, body: string): Promise<void>;
  /**
   * Of the given keys (all of this project), those updated after `since`, or all of them that
   * exist when `since` is absent, with status category and last update time. Reads keys and
   * statuses only, never comment text. Keys that do not exist or are not visible are left out.
   * Implementations batch the keys and may return issues updated shortly before `since`
   * (the tracker's search works in minutes); callers compare `updated` themselves.
   */
  listChangedSince(keys: readonly string[], since?: Date): Promise<IssueChange[]>;
  /**
   * Attaches a file to the issue as part of a customer-facing reply with `comment` (never an
   * internal note). The bytes are sent and not kept; failures never include the file or body.
   */
  addCustomerAttachment(key: string, file: AttachmentFile, comment: string): Promise<void>;
}

/** A file to attach, held in memory only. */
export interface AttachmentFile {
  name: string;
  mimeType: string;
  data: Uint8Array;
}

/** Tracker failure. Messages never include response bodies or credentials. */
export class IssueTrackerError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "IssueTrackerError";
  }
}

/** Log fields for a failure: error name and tracker status only, never messages or bodies. */
export function trackerErrorFields(err: unknown): Record<string, unknown> {
  return {
    err: err instanceof Error ? err.name : "UnknownError",
    ...(err instanceof IssueTrackerError && err.status !== undefined ? { status: err.status } : {}),
  };
}
