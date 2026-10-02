import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { ChannelConfigRepository } from "../../../domain/repositories/ChannelConfigRepository";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import type { SupportRequest, SupportRequestStatusCategory } from "../../../domain/entities/SupportRequest";
import { toChannelId } from "../../../domain/ids/channelId";
import { isKeyInProject } from "../../../domain/ids/jiraLink";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueChange, IssueReply, IssueSnapshot, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { SupportRequestWrites } from "../../services/SupportRequestWrites";
import type { DeskUpdateKind, DeskUpdateQuestions } from "../../services/deskUpdateQuestions";
import type { OpenAgentConversation } from "./OpenAgentConversation";
import type { AskForAgentConversation } from "./AskForAgentConversation";
import { formatReplies, formatSla, type RepliesHeading } from "./formatIssue";
import { botActor, refreshStatusCategory } from "./supportRequestStatus";

export interface WatchCheckResult {
  /** Requests whose update was posted. */
  announced: number;
  /** Requests left for the next check: a resolve from Wire in progress, or a failed read or send. */
  pending: number;
}

/** Resolved requests stay watched this long, to catch a reopen. */
const RESOLVED_WATCH_MS = 24 * 60 * 60 * 1000;
/** Replies read per changed request. */
const REPLIES_READ = 10;
/** New replies shown in one update. */
const REPLIES_SHOWN = 3;

/**
 * Changes are asked for from this long before the previous check: Jira's search is eventually
 * consistent and its clock may differ from ours. Examining a request twice is harmless, since
 * the markers only move forward.
 */
const SINCE_OVERLAP_MS = 2 * 60 * 1000;

/**
 * Failed attempts (a failed send or read) after which a request's pending update is given up,
 * so a conversation the bot cannot post to is not retried for ever. About five minutes at a
 * 30-second interval; a resolve from Wire in progress does not count as a failure.
 */
const MAX_FAILED_ATTEMPTS = 10;

export interface WatchGuards {
  /** Shared with `ResolveSupportRequest`; a request being resolved from Wire is skipped. */
  writes?: SupportRequestWrites;
  /** Conversations never posted to, such as the CLI's test conversations; their requests are not watched. */
  skipConversation?: (conversationId: QualifiedId) => boolean;
  /**
   * Direct conversations with the desk agent: Jira account ID to Wire handle, and the use case.
   * With `ask`, the requester is asked first ([Open direct chat] [Not now]) instead of the group
   * being opened at once. Absent: no direct conversations.
   */
  agents?: { handles: ReadonlyMap<string, string>; open: OpenAgentConversation; ask?: AskForAgentConversation };
  /**
   * Asks the requester what to do after a posted desk reply or resolve, in a separate button
   * message that is never stored as the request's last message. Absent: no such questions.
   */
  questions?: DeskUpdateQuestions;
}

const NEW_REPLIES_HEADING: RepliesHeading = {
  one: "New reply from the service desk:",
  many: "New replies from the service desk:",
};

/**
 * Announces changes the service desk made in Jira (new public replies, status category
 * changes) in each support request's conversation, as a reply to the bot's last message about
 * the request. Stateful: keeps the time of the last check and the pending keys in memory; the
 * stored markers (`statusCategory`, `lastSeenReplyAt`) prevent repeats after a restart.
 * The runner calls `check()` at the configured interval, one check at a time.
 */
export class WatchSupportRequests {
  /** Start of the last check whose tracker call succeeded; absent until then. */
  private lastCheck: Date | undefined;
  /**
   * Keys to examine again at the next check, with the tracker state last seen for them. That
   * state stays current until Jira reports the issue as changed again, which replaces it.
   */
  private readonly pending = new Map<string, IssueChange>();
  /** Consecutive failed attempts per pending key. */
  private readonly failures = new Map<string, number>();
  /**
   * Keys whose agent-conversation question waits for the requester's question slot, with when it
   * first had to wait. Asked again at each check until the question's lifetime has passed.
   */
  private readonly agentQuestionWaiting = new Map<string, Date>();

  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly channels: ChannelConfigRepository,
    private readonly logger?: Logger,
    private readonly now: () => Date = () => new Date(),
    private readonly guards: WatchGuards = {},
  ) {}

  async check(): Promise<WatchCheckResult> {
    let watched: SupportRequest[];
    try {
      watched = (await this.requests.listWatched(new Date(this.now().getTime() - RESOLVED_WATCH_MS)))
        .filter((request) => isKeyInProject(request.key, this.tracker.projectKey)
          && !this.guards.skipConversation?.(request.conversationId));
    } catch (err) {
      this.logger?.warn("WatchSupportRequests: listWatched failed", trackerErrorFields(err));
      return this.result(0);
    }

    const byKey = new Map(watched.map((request) => [request.key, request]));
    // Pending keys no longer watched (deleted, or resolved long ago) are dropped.
    for (const key of [...this.pending.keys()]) {
      if (!byKey.has(key)) {
        this.pending.delete(key);
        this.failures.delete(key);
      }
    }
    for (const key of [...this.agentQuestionWaiting.keys()]) {
      if (!byKey.has(key)) this.agentQuestionWaiting.delete(key);
    }

    const checkTime = this.now();
    if (watched.length === 0) {
      this.lastCheck = checkTime;
      return this.result(0);
    }

    let changes: IssueChange[];
    try {
      changes = await this.tracker.listChangedSince([...byKey.keys()], this.askFrom());
    } catch (err) {
      this.logger?.warn("WatchSupportRequests: listChangedSince failed", trackerErrorFields(err));
      return this.result(0);
    }
    const since = this.askFrom();
    this.lastCheck = checkTime;

    const toExamine = new Map(this.pending);
    for (const change of changes) {
      if (!byKey.has(change.key)) continue;
      if (since && change.updated.getTime() <= since.getTime()) continue;
      toExamine.set(change.key, change);
    }

    let announced = 0;
    for (const [key, change] of toExamine) {
      const request = byKey.get(key)!;
      try {
        const outcome = await this.examine(request, change);
        if (outcome === "announcedWaiting") {
          // Posted, but the agent question still waits for the requester's question slot.
          this.pending.set(key, change);
          this.failures.delete(key);
          announced++;
          continue;
        }
        if (outcome === "pending") {
          this.pending.set(key, change);
          continue;
        }
        if (outcome === "failed") {
          this.failed(key, change);
          continue;
        }
        this.pending.delete(key);
        this.failures.delete(key);
        if (outcome === "announced") announced++;
      } catch (err) {
        this.logger?.warn("WatchSupportRequests: request check failed", { key, ...trackerErrorFields(err) });
        this.failed(key, change);
      }
    }
    return this.result(announced);
  }

  /** Keeps the key for the next check, or gives it up after too many failed attempts. */
  private failed(key: string, change: IssueChange): void {
    const attempts = (this.failures.get(key) ?? 0) + 1;
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      this.logger?.warn("WatchSupportRequests: giving up on the update after repeated failures", { key, attempts });
      this.pending.delete(key);
      this.failures.delete(key);
      return;
    }
    this.failures.set(key, attempts);
    this.pending.set(key, change);
  }

  private askFrom(): Date | undefined {
    return this.lastCheck ? new Date(this.lastCheck.getTime() - SINCE_OVERLAP_MS) : undefined;
  }

  private result(announced: number): WatchCheckResult {
    return { announced, pending: this.pending.size };
  }

  /** Posts the update for one request when there is one and stores the new markers. */
  private async examine(
    listed: SupportRequest, change: IssueChange,
  ): Promise<"announced" | "announcedWaiting" | "silent" | "pending" | "failed"> {
    if (this.guards.writes?.has(listed.key)) return "pending";
    // Re-read: a resolve, `status of` or answer during this check may have moved the markers.
    const request = await this.requests.findByKey(listed.key);
    if (!request || request.deleted) return "silent";
    const timeZone = await this.channelTimeZone(request);

    // First sight of this request: take a baseline of replies and status so nothing old is announced.
    const baseline = !request.lastSeenReplyAt;
    // The assignee has its own baseline: rows from before the assignee was stored have replies seen.
    const assigneeBaseline = !request.assigneeSeenAt;
    const assignee = change.assigneeAccountId ?? null;
    const assigneeChanged = assignee !== (request.assigneeAccountId ?? null);

    const replies = await this.tracker.listCustomerReplies(request.key, REPLIES_READ);
    const newest = newestReplyTime(replies);
    let newReplies: IssueReply[] = [];
    let seenUpTo: Date | undefined;
    if (baseline) {
      seenUpTo = newest ?? request.createdAt;
    } else {
      const lastSeen = request.lastSeenReplyAt!.getTime();
      newReplies = replies
        .filter((reply) => reply.created.getTime() > lastSeen && !reply.fromThisBot)
        .slice(-REPLIES_SHOWN);
      if (newest && newest.getTime() > lastSeen) seenUpTo = newest;
    }

    // The listed category may be stale (a pending key, or a change the bot made meanwhile), so
    // a difference is confirmed with a live read before it is announced or stored.
    let status = change.statusCategory;
    let snapshot: IssueSnapshot | null = null;
    if (status !== request.statusCategory) {
      snapshot = await this.tracker.getIssue(request.key);
      if (!snapshot) return "silent";
      status = snapshot.statusCategory;
    }

    // A newly assigned mapped agent gets the direct conversation, once: opened at once before the
    // other update, or (with `ask`) offered to the requester after it.
    let lastMessage = request.lastMessage;
    let openFailed = false;
    const agentHandle = assignee !== null ? this.guards.agents?.handles.get(assignee) : undefined;
    const agentDue = !assigneeBaseline && assigneeChanged && !!agentHandle && status !== "done" && !request.agentConversationAt;
    const askAgent = agentDue ? this.guards.agents?.ask : undefined;
    if (!agentDue) this.agentQuestionWaiting.delete(request.key);
    if (agentDue && !askAgent) {
      // Checked again: a resolve may have started during the reads.
      if (this.guards.writes?.has(request.key)) return "pending";
      const opened = await this.openAgentConversation(request, agentHandle!);
      lastMessage = opened.lastMessage;
      openFailed = opened.failed;
    }
    // Stored only now, and not after a failed open, so a failed read or open is retried with the
    // change. With `ask`, it is stored after the question below.
    if ((assigneeBaseline || assigneeChanged) && !openFailed && !askAgent) await this.storeAssignee(request.key, assignee);

    const statusLines = baseline ? [] : statusChangeLines(request.statusCategory, status, snapshot);
    const announce = statusLines.length > 0 || newReplies.length > 0;
    if (announce) {
      // Checked again just before posting: a resolve may have started during the reads.
      if (this.guards.writes?.has(request.key)) return "pending";
      const text = [
        `**${request.key}** ${request.summary}`,
        ...statusLines,
        ...(newReplies.length > 0 ? ["", formatReplies(newReplies, timeZone, NEW_REPLIES_HEADING)] : []),
      ].join("\n");
      let ref;
      try {
        ref = await this.wireOutbound.sendPlainText(
          request.conversationId, text, lastMessage ? { quote: lastMessage } : undefined,
        );
      } catch (err) {
        this.logger?.warn("WatchSupportRequests: send failed", { key: request.key, ...trackerErrorFields(err) });
        return "failed";
      }
      if (ref) {
        try {
          await this.requests.setLastMessage(request.key, ref);
        } catch (err) {
          this.logger?.warn("WatchSupportRequests: setLastMessage failed", { key: request.key, ...trackerErrorFields(err) });
        }
      }
    }

    // With `ask`, the question about the agent conversation follows the update. It takes the
    // requester's question slot, so no desk-update question is asked in the same check.
    let agentAsked = false;
    let agentWaiting = false;
    if (askAgent) {
      if (!announce && this.guards.writes?.has(request.key)) return "pending";
      const asked = await this.askAgentConversation(askAgent, request, agentHandle!);
      agentAsked = asked === "asked";
      agentWaiting = asked === "waiting";
      openFailed = asked === "failed";
      if ((assigneeBaseline || assigneeChanged) && !openFailed && !agentWaiting) await this.storeAssignee(request.key, assignee);
    }

    if (announce && !agentAsked) {
      const question = followUpKind(status, newReplies.length > 0);
      // Never fails: the update is posted and must not be posted again.
      if (question) await this.guards.questions?.ask(request, question);
    }

    const now = this.now();
    await refreshStatusCategory(
      this.requests, this.auditLog, request, status, botActor(request.conversationId), this.logger, now,
    );
    if (seenUpTo) {
      try {
        await this.requests.advanceLastSeenReplyAt(request.key, seenUpTo);
      } catch (err) {
        this.logger?.warn("WatchSupportRequests: advanceLastSeenReplyAt failed", { key: request.key, ...trackerErrorFields(err) });
      }
    }
    if (openFailed) return "failed";
    if (agentWaiting) return announce ? "announcedWaiting" : "pending";
    return announce ? "announced" : "silent";
  }

  /**
   * Asks the requester about the agent conversation. "waiting" when their question slot is taken:
   * the change is kept and asked about again at the next check, until the question's lifetime has
   * passed since the first wait; then it is given up ("skipped") and the assignee is stored, so
   * nothing is asked about it later. A failure is logged and retried like a failed open.
   */
  private async askAgentConversation(
    ask: AskForAgentConversation, request: SupportRequest, agentHandle: string,
  ): Promise<"asked" | "skipped" | "waiting" | "failed"> {
    let outcome;
    try {
      outcome = await ask.ask(request, agentHandle);
    } catch (err) {
      this.logger?.warn("WatchSupportRequests: asking about the agent conversation failed", { key: request.key, ...trackerErrorFields(err) });
      outcome = "failed" as const;
    }
    if (outcome !== "busy") {
      this.agentQuestionWaiting.delete(request.key);
      return outcome;
    }
    const now = this.now();
    const since = this.agentQuestionWaiting.get(request.key) ?? now;
    if (now.getTime() - since.getTime() >= ask.lifetimeMs) {
      this.logger?.info("WatchSupportRequests: the requester stayed busy; not asking about the agent conversation", { key: request.key });
      this.agentQuestionWaiting.delete(request.key);
      return "skipped";
    }
    this.agentQuestionWaiting.set(request.key, since);
    return "waiting";
  }

  /** Stores the assignee last seen; bookkeeping, so a failure is logged and never stops the check. */
  private async storeAssignee(key: string, accountId: string | null): Promise<void> {
    try {
      await this.requests.setAssignee(key, accountId);
    } catch (err) {
      this.logger?.warn("WatchSupportRequests: setAssignee failed", { key, ...trackerErrorFields(err) });
    }
  }

  /**
   * Opens the direct conversation with the agent and returns the message the request's next
   * update should quote: the notice just posted when the conversation was opened, otherwise the
   * stored one. A failure is logged and never stops the rest of the check.
   */
  private async openAgentConversation(
    request: SupportRequest, agentHandle: string,
  ): Promise<{ lastMessage: SupportRequest["lastMessage"]; failed: boolean }> {
    let outcome;
    try {
      outcome = await this.guards.agents!.open.execute({ request, agentHandle });
    } catch (err) {
      this.logger?.warn("WatchSupportRequests: opening the agent conversation failed", { key: request.key, ...trackerErrorFields(err) });
      return { lastMessage: request.lastMessage, failed: true };
    }
    if (outcome !== "opened") return { lastMessage: request.lastMessage, failed: outcome === "failed" };
    try {
      return { lastMessage: (await this.requests.findByKey(request.key))?.lastMessage ?? request.lastMessage, failed: false };
    } catch (err) {
      this.logger?.warn("WatchSupportRequests: re-reading after the agent conversation failed", { key: request.key, ...trackerErrorFields(err) });
      return { lastMessage: request.lastMessage, failed: false };
    }
  }

  /** The timezone of the request's channel for reply times; UTC without a channel config. */
  private async channelTimeZone(request: SupportRequest): Promise<string> {
    const channel = await this.channels.get(toChannelId(request.conversationId));
    return channel?.timezone || "UTC";
  }
}

/** The status line for a category change, with the SLA outcome after a resolve; none otherwise. */
function statusChangeLines(
  previous: SupportRequestStatusCategory, next: SupportRequestStatusCategory, snapshot: IssueSnapshot | null,
): string[] {
  if (previous === next) return [];
  if (next === "done") return ["Resolved by the service desk.", ...(snapshot?.slas.map(formatSla) ?? [])];
  if (previous === "done") return ["Reopened by the service desk."];
  if (next === "in_progress") return ["Now in progress."];
  return ["Moved back to To do."];
}

/**
 * The question after a posted update: with the request now done (resolved by the desk, or a reply
 * on a resolved request), whether it is solved; with a new desk reply, whether to reply or close.
 * None for other status changes: the bot only knows the category, not the status name.
 */
function followUpKind(status: SupportRequestStatusCategory, newReplies: boolean): DeskUpdateKind | null {
  if (status === "done") return "resolved";
  return newReplies ? "reply" : null;
}

function newestReplyTime(replies: readonly IssueReply[]): Date | undefined {
  let newest: Date | undefined;
  for (const reply of replies) {
    if (!newest || reply.created.getTime() > newest.getTime()) newest = reply.created;
  }
  return newest;
}
