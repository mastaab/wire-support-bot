/**
 * Jira Service Management adapter for IssueTrackerPort, using built-in fetch.
 *
 * - Requests are raised through the Service Management API so they enter the queues and
 *   SLAs; the due date and labels are set with a follow-up issue edit because that API only
 *   accepts fields on the customer request form.
 * - Status is read by category only. Status names are localized and never used.
 * - Errors and logs never include request bodies, response bodies or credentials.
 * - Every HTTP request is recorded in the metrics by the tracker operation that made it, with its
 *   status class (or timeout or error) and duration.
 * - Ticket links point to the agent view, or with portal links to the request in the customer
 *   portal: the request's own web link when Jira returns one, else the portal address built from
 *   the service desk ID, the format Jira uses for it.
 */

import {
  IssueTrackerError,
  isFeedbackRating,
  type CreateIssueRequest,
  type CreatedIssue,
  type AttachmentFile,
  type IssueChange,
  type IssueSnapshot,
  type IssueStatusCategory,
  type IssueReply,
  type IssueTrackerPort,
  type SlaSummary,
} from "../../application/ports/IssueTrackerPort";
import type { Logger } from "../../application/ports/Logger";
import {
  NO_METRICS, secondsSince, type JiraOperation, type JiraOutcome, type MetricsPort,
} from "../../application/ports/MetricsPort";
import type { JiraConfig } from "../../app/config";
import { JIRA_KEY_PATTERN, isKeyInProject } from "../../domain/ids/jiraLink";

export interface JiraAdapterOptions {
  sleep?: (ms: number) => Promise<void>;
  slaPollAttempts?: number;
  slaPollIntervalMs?: number;
  metrics?: MetricsPort;
}

const SUMMARY_MAX_LENGTH = 255;
const MAX_TRANSITION_HOPS = 3;
const COMMENT_PAGE_SIZE = 100;
const MAX_COMMENT_PAGES = 5;
/** Keys per JQL search. */
const SEARCH_BATCH_SIZE = 50;
/** Upper bound on result pages per batch, in case Jira keeps returning a page token. */
const MAX_SEARCH_PAGES = 5;
interface JiraStatus {
  id?: string;
  statusCategory?: { key?: string };
}

interface JiraIssue {
  key?: string;
  fields?: { summary?: string; status?: JiraStatus };
}

interface JiraTransition {
  id?: string;
  to?: JiraStatus;
}

interface JiraDuration {
  friendly?: string;
}

interface JiraSlaCycle {
  breached?: boolean;
  paused?: boolean;
  goalDuration?: JiraDuration;
  elapsedTime?: JiraDuration;
  remainingTime?: JiraDuration;
}

interface JiraSla {
  name?: string;
  ongoingCycle?: JiraSlaCycle;
  completedCycles?: JiraSlaCycle[];
}

interface JiraComment {
  public?: unknown;
  body?: unknown;
  author?: { accountId?: string; displayName?: string };
  created?: { epochMillis?: number; iso8601?: string };
}

interface JiraSearchIssue {
  key?: string;
  fields?: { status?: JiraStatus; updated?: unknown; assignee?: { accountId?: unknown } | null };
}

interface JiraSearchPage {
  issues?: JiraSearchIssue[];
  nextPageToken?: unknown;
  isLast?: boolean;
}

interface JiraResponse<T> {
  status: number;
  data: T | null;
}

function toCategory(key: string | undefined): IssueStatusCategory {
  if (key === "indeterminate") return "in_progress";
  if (key === "done") return "done";
  return "todo";
}

function toSla(entry: JiraSla): SlaSummary | null {
  const name = entry.name ?? "SLA";
  const ongoing = entry.ongoingCycle;
  if (ongoing) {
    const state = ongoing.paused ? "paused" : ongoing.breached ? "breached" : "running";
    return {
      name, state,
      elapsed: ongoing.elapsedTime?.friendly,
      remaining: ongoing.remainingTime?.friendly,
      goal: ongoing.goalDuration?.friendly,
    };
  }
  const cycles = entry.completedCycles ?? [];
  const last = cycles[cycles.length - 1];
  if (!last) return null;
  return {
    name,
    state: last.breached ? "breached" : "met",
    elapsed: last.elapsedTime?.friendly,
    goal: last.goalDuration?.friendly,
  };
}

/**
 * Parses a Jira timestamp such as "2026-09-26T21:24:35.123+0200". A colon is put into the
 * offset first, since Jira omits it and not every parser accepts that form.
 */
function parseJiraTime(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const millis = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(millis) ? new Date(millis) : null;
}

/** Jira rejects summaries over 255 characters; cut long ones visibly rather than silently. */
function truncateSummary(summary: string): string {
  const text = summary.trim();
  return text.length <= SUMMARY_MAX_LENGTH ? text : `${text.slice(0, SUMMARY_MAX_LENGTH - 3).trimEnd()}...`;
}

/** Longest attachment name Jira accepts. */
const FILE_NAME_MAX = 255;

/** File uploads get at least this long, since a 10 MB file can outlast the default timeout. */
const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * A file name safe to send: path separators, control characters and bidirectional or other
 * invisible format characters (which can disguise an extension) removed, trimmed, cut to
 * Jira's length limit keeping the extension, and "attachment" when nothing is left.
 */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/\p{Cc}\p{Cf}]/gu, "").trim();
  if (!cleaned) return "attachment";
  if (cleaned.length <= FILE_NAME_MAX) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, FILE_NAME_MAX - extension.length) + extension;
}

/** The status class of a response for the metrics; a status outside 2xx, 4xx and 5xx counts as an error. */
function statusClass(status: number): JiraOutcome {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "error";
}

const isAbort = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class JiraServiceManagementAdapter implements IssueTrackerPort {
  readonly projectKey: string;
  private readonly authorization: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly slaPollAttempts: number;
  private readonly slaPollIntervalMs: number;
  private readonly metrics: MetricsPort;
  /** The service account's own Jira account ID, cached after the first successful lookup. */
  private ownAccountId: string | undefined;
  /** The lookup in progress, shared by concurrent reads so /myself is requested once. */
  private ownAccountLookup: Promise<string | undefined> | undefined;

  constructor(
    private readonly config: JiraConfig,
    private readonly logger: Logger,
    options: JiraAdapterOptions = {},
  ) {
    this.projectKey = config.projectKey;
    this.authorization = config.email
      ? `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`
      : `Bearer ${config.apiToken}`;
    this.sleep = options.sleep ?? defaultSleep;
    this.slaPollAttempts = options.slaPollAttempts ?? 5;
    this.slaPollIntervalMs = options.slaPollIntervalMs ?? 2000;
    this.metrics = options.metrics ?? NO_METRICS;
  }

  async createIssue(request: CreateIssueRequest): Promise<CreatedIssue> {

    const created = await this.request<{ issueKey?: unknown; _links?: { web?: unknown } }>("create_issue", "POST", "/rest/servicedeskapi/request", {
      serviceDeskId: this.config.serviceDeskId,
      requestTypeId: request.requestTypeId ?? this.config.requestTypes.fault,
      requestFieldValues: {
        summary: truncateSummary(request.summary),
        description: request.description,
      },
    });
    const key = created.data?.issueKey;
    if (typeof key !== "string" || !JIRA_KEY_PATTERN.test(key)) {
      throw new IssueTrackerError("Jira returned an unexpected response");
    }

    const fields: { duedate?: string; labels?: string[] } = {};
    if (request.dueDate) fields.duedate = request.dueDate;
    if (request.labels && request.labels.length > 0) fields.labels = request.labels;
    let fieldsApplied = true;
    if (Object.keys(fields).length > 0) {
      try {
        await this.request("create_issue", "PUT", `/rest/api/3/issue/${key}`, { fields });
      } catch (err) {
        fieldsApplied = false;
        this.logger.warn("Jira issue created but field update failed", {
          key, status: err instanceof IssueTrackerError ? err.status : undefined,
        });
      }
    }
    return { key, url: this.ticketUrl(key, created.data?._links?.web), fieldsApplied };
  }

  async getIssue(key: string): Promise<IssueSnapshot | null> {
    return this.readIssue(key, "get_issue");
  }

  private async readIssue(key: string, operation: JiraOperation): Promise<IssueSnapshot | null> {
    this.assertInProject(key);
    const issue = await this.request<JiraIssue>(operation, "GET", `/rest/api/3/issue/${key}?fields=summary,status`, undefined, true);
    if (issue.status === 404 || !issue.data) return null;
    return {
      key,
      url: this.ticketUrl(key),
      summary: issue.data.fields?.summary ?? "",
      statusCategory: toCategory(issue.data.fields?.status?.statusCategory?.key),
      slas: await this.readSlas(key, operation),
    };
  }

  async resolveIssue(key: string): Promise<IssueSnapshot> {
    this.assertInProject(key);
    const initial = await this.request<JiraIssue>("resolve_issue", "GET", `/rest/api/3/issue/${key}?fields=status`);
    let current: JiraStatus = initial.data?.fields?.status ?? {};
    const visited = new Set<string>();

    for (let hop = 0; hop < MAX_TRANSITION_HOPS; hop++) {
      if (toCategory(current.statusCategory?.key) === "done") break;
      if (current.id) visited.add(current.id);
      const list = await this.request<{ transitions?: JiraTransition[] }>("resolve_issue", "GET", `/rest/api/3/issue/${key}/transitions`);
      const transitions = (list.data?.transitions ?? []).filter((t) => typeof t.id === "string");
      const next =
        transitions.find((t) => t.to?.statusCategory?.key === "done") ??
        transitions.find((t) => t.to?.statusCategory?.key === "indeterminate" && !!t.to.id && !visited.has(t.to.id));
      if (!next?.id) break;
      await this.request("resolve_issue", "POST", `/rest/api/3/issue/${key}/transitions`, { transition: { id: next.id } });
      current = next.to ?? {};
    }

    let snapshot = await this.requireIssue(key);
    if (snapshot.statusCategory !== "done") return snapshot;
    // SLA recalculation lags the transition by a few seconds, so wait for the clocks to
    // stop. The status is already done; only the SLAs need re-reading.
    for (let attempt = 1; attempt < this.slaPollAttempts && snapshot.slas.some((s) => s.state === "running"); attempt++) {
      await this.sleep(this.slaPollIntervalMs);
      snapshot = { ...snapshot, slas: await this.readSlas(key, "resolve_issue") };
    }
    return snapshot;
  }

  async listChangedSince(keys: readonly string[], since?: Date): Promise<IssueChange[]> {
    for (const key of keys) this.assertInProject(key);
    const unique = [...new Set(keys)];
    if (unique.length === 0) return [];
    // JQL dates are read in the account's timezone, so bound the search relatively, in whole
    // minutes rounded up plus a one-minute margin, and compare the exact time below.
    const bound = since
      ? ` AND updated >= "-${Math.max(1, Math.ceil((Date.now() - since.getTime()) / 60_000) + 1)}m"`
      : "";
    const changes: IssueChange[] = [];
    for (let start = 0; start < unique.length; start += SEARCH_BATCH_SIZE) {
      changes.push(...(await this.searchChanged(unique.slice(start, start + SEARCH_BATCH_SIZE), bound, since)));
    }
    return changes;
  }

  /**
   * One batch of the change check. Jira rejects the whole search (400) when one listed key no
   * longer exists or is not visible, so a rejected batch is split and retried, and a key that
   * is rejected on its own is left out, as the port promises.
   */
  private async searchChanged(batch: readonly string[], bound: string, since?: Date): Promise<IssueChange[]> {
    try {
      return await this.searchChangedPages(batch, bound, since);
    } catch (err) {
      if (!(err instanceof IssueTrackerError) || err.status !== 400) throw err;
      if (batch.length === 1) {
        this.logger.warn("Jira change check: key rejected, left out", { key: batch[0] });
        return [];
      }
      const half = Math.ceil(batch.length / 2);
      return [
        ...(await this.searchChanged(batch.slice(0, half), bound, since)),
        ...(await this.searchChanged(batch.slice(half), bound, since)),
      ];
    }
  }

  private async searchChangedPages(batch: readonly string[], bound: string, since?: Date): Promise<IssueChange[]> {
    const changes: IssueChange[] = [];
    const jql = `project = ${this.projectKey} AND key in (${batch.join(", ")})${bound}`;
    let nextPageToken: string | undefined;
    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      const res = await this.request<JiraSearchPage>("list_changed_since", "POST", "/rest/api/3/search/jql", {
        jql,
        fields: ["status", "updated", "assignee"],
        maxResults: SEARCH_BATCH_SIZE,
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      for (const issue of res.data?.issues ?? []) {
        const key = issue.key;
        if (typeof key !== "string" || !isKeyInProject(key, this.projectKey)) continue;
        const updated = parseJiraTime(issue.fields?.updated);
        if (!updated) continue;
        if (since && updated.getTime() <= since.getTime()) continue;
        const assignee = issue.fields?.assignee?.accountId;
        changes.push({
          key, statusCategory: toCategory(issue.fields?.status?.statusCategory?.key), updated,
          ...(typeof assignee === "string" && assignee ? { assigneeAccountId: assignee } : {}),
        });
      }
      const token = res.data?.nextPageToken;
      nextPageToken = typeof token === "string" && token ? token : undefined;
      if (!nextPageToken || res.data?.isLast === true) break;
    }
    return changes;
  }

  /**
   * Uploads the file as a temporary attachment to the service desk, then attaches it to the
   * request with a public comment. Neither step is retried: after a timeout or a server error
   * Jira may already have stored the file, so the error is reported instead.
   */
  async addCustomerAttachment(key: string, file: AttachmentFile, comment: string): Promise<void> {
    this.assertInProject(key);
    const form = new FormData();
    // Copied into a plain ArrayBuffer view, since Blob does not accept a shared buffer.
    form.append("file", new Blob([new Uint8Array(file.data)], { type: file.mimeType }), sanitizeFileName(file.name));
    const uploaded = await this.request<{ temporaryAttachments?: Array<{ temporaryAttachmentId?: unknown }> }>(
      "add_customer_attachment",
      "POST",
      `/rest/servicedeskapi/servicedesk/${this.config.serviceDeskId}/attachTemporaryFile`,
      form,
      false,
      { "X-Atlassian-Token": "no-check", "X-ExperimentalApi": "opt-in" },
    );
    const temporaries = uploaded.data?.temporaryAttachments;
    const id = Array.isArray(temporaries) ? temporaries[0]?.temporaryAttachmentId : undefined;
    if (typeof id !== "string" || !id.trim()) {
      throw new IssueTrackerError("Jira returned an unexpected response", uploaded.status);
    }
    await this.request(
      "add_customer_attachment",
      "POST",
      `/rest/servicedeskapi/request/${key}/attachment`,
      // The service account is an agent: send the public flag explicitly, as for replies.
      { temporaryAttachmentIds: [id], public: true, additionalComment: { body: comment } },
      false,
      { "X-ExperimentalApi": "opt-in" },
    );
  }

  async listCustomerReplies(key: string, limit: number): Promise<IssueReply[]> {
    this.assertInProject(key);
    if (limit <= 0) return [];
    const replies: Array<IssueReply & { accountId?: string }> = [];
    for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
      const res = await this.request<{ values?: JiraComment[]; isLastPage?: boolean }>(
        "list_customer_replies",
        "GET",
        `/rest/servicedeskapi/request/${key}/comment?public=true&internal=false&start=${page * COMMENT_PAGE_SIZE}&limit=${COMMENT_PAGE_SIZE}`,
      );
      for (const comment of res.data?.values ?? []) {
        // An agent credential also receives internal notes, and the query filter is not relied
        // on: only a comment explicitly flagged public reaches the customer-facing view.
        if (comment.public !== true || typeof comment.body !== "string" || !comment.body.trim()) continue;
        const millis = comment.created?.epochMillis ?? Date.parse(comment.created?.iso8601 ?? "");
        if (!Number.isFinite(millis)) continue;
        replies.push({
          author: comment.author?.displayName?.trim() || "Service desk",
          created: new Date(millis),
          body: comment.body,
          accountId: comment.author?.accountId,
        });
      }
      if (res.data?.isLastPage !== false) break;
    }
    // Only look up the bot's own account when there is a reply to mark.
    const ownAccountId = replies.length > 0 ? await this.readOwnAccountId() : undefined;
    // The comment order is not documented, so sort explicitly.
    replies.sort((a, b) => a.created.getTime() - b.created.getTime());
    return replies.slice(-limit).map(({ accountId, ...reply }) => ({
      ...reply,
      fromThisBot: ownAccountId !== undefined && accountId === ownAccountId,
    }));
  }

  async addCustomerReply(key: string, body: string): Promise<void> {
    this.assertInProject(key);
    // The service account is an agent, so the comment is an internal note unless it is
    // explicitly marked public. Always send the flag; never rely on the default.
    await this.request("add_customer_reply", "POST", `/rest/servicedeskapi/request/${key}/comment`, { body, public: true });
  }

  /**
   * Rates the request through the experimental feedback endpoint (it needs the opt-in header),
   * as a customer satisfaction rating (`type` "csat") with the rating only and no comment. A rating
   * outside 1 to 5 is refused without calling Jira.
   */
  async submitFeedback(key: string, rating: number): Promise<void> {
    this.assertInProject(key);
    if (!isFeedbackRating(rating)) throw new IssueTrackerError("Feedback rating must be a whole number from 1 to 5");
    await this.request("submit_feedback", "POST", `/rest/servicedeskapi/request/${key}/feedback`, { type: "csat", rating }, false, { "X-ExperimentalApi": "opt-in" });
  }

  private async requireIssue(key: string): Promise<IssueSnapshot> {
    const snapshot = await this.readIssue(key, "resolve_issue");
    if (!snapshot) throw new IssueTrackerError("Jira request failed (404)", 404);
    return snapshot;
  }

  private async readSlas(key: string, operation: JiraOperation): Promise<SlaSummary[]> {
    try {
      const res = await this.request<{ values?: JiraSla[] }>(operation, "GET", `/rest/servicedeskapi/request/${key}/sla`);
      return (res.data?.values ?? []).map(toSla).filter((s): s is SlaSummary => s !== null);
    } catch (err) {
      this.logger.warn("Jira SLA read failed; reporting no SLAs", {
        key, status: err instanceof IssueTrackerError ? err.status : undefined,
      });
      return [];
    }
  }

  /**
   * The bot's own Jira account ID, used to recognize replies sent from Wire. A failed lookup
   * is not cached, so the next call tries again; until then no reply is marked as the bot's.
   */
  private async readOwnAccountId(): Promise<string | undefined> {
    if (this.ownAccountId !== undefined) return this.ownAccountId;
    // A failed lookup is not cached, so the next read tries again.
    this.ownAccountLookup ??= this.lookUpOwnAccountId().finally(() => { this.ownAccountLookup = undefined; });
    return this.ownAccountLookup;
  }

  private async lookUpOwnAccountId(): Promise<string | undefined> {
    try {
      const res = await this.request<{ accountId?: unknown }>("list_customer_replies", "GET", "/rest/api/3/myself");
      const accountId = res.data?.accountId;
      if (typeof accountId === "string" && accountId) this.ownAccountId = accountId;
      return this.ownAccountId;
    } catch (err) {
      this.logger.warn("Jira own account lookup failed; not marking replies from this bot", {
        status: err instanceof IssueTrackerError ? err.status : undefined,
      });
      return undefined;
    }
  }

  private assertInProject(key: string): void {
    if (!isKeyInProject(key, this.projectKey)) {
      throw new IssueTrackerError("Issue key is outside the configured project");
    }
  }

  private browseUrl(key: string): string {
    return `${this.config.siteUrl}/browse/${key}`;
  }

  /**
   * The link posted for a ticket: the agent view, or with portal links the request in the customer
   * portal. `web` is the request's own portal link from a service desk API response, used when it
   * is an https link to this key; otherwise the link is built from the site and service desk ID
   * (`<site>/servicedesk/customer/portal/<service desk ID>/<key>`, as Jira returns it).
   */
  private ticketUrl(key: string, web?: unknown): string {
    if (this.config.links !== "portal") return this.browseUrl(key);
    if (typeof web === "string" && web.startsWith("https://") && web.endsWith(`/${key}`)) return web;
    return `${this.config.siteUrl}/servicedesk/customer/portal/${this.config.serviceDeskId}/${key}`;
  }

  /**
   * One Jira call, recorded in the metrics under `operation`. A FormData body is sent as multipart
   * without an explicit Content-Type, so fetch sets the boundary; any other body is sent as JSON.
   */
  private async request<T>(
    operation: JiraOperation,
    method: string,
    path: string,
    body?: unknown,
    allowNotFound = false,
    extraHeaders: Record<string, string> = {},
  ): Promise<JiraResponse<T>> {
    const headers: Record<string, string> = {
      Authorization: this.authorization,
      Accept: "application/json",
      // Without an explicit language Jira localizes status names for this account.
      "Accept-Language": "en-GB",
      ...extraHeaders,
    };
    const isForm = body instanceof FormData;
    if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), isForm ? Math.max(this.config.timeoutMs, UPLOAD_TIMEOUT_MS) : this.config.timeoutMs);
    const started = performance.now();
    let outcome: JiraOutcome = "error";
    try {
      let res: Response;
      try {
        res = await fetch(`${this.config.baseUrl}${path}`, {
          method, headers, signal: controller.signal,
          body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
        });
      } catch (err) {
        if (isAbort(err)) outcome = "timeout";
        throw this.transportError(err);
      }
      outcome = statusClass(res.status);
      if (allowNotFound && res.status === 404) return { status: 404, data: null };
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new IssueTrackerError(`Jira rejected the credentials or scopes (${res.status})`, res.status);
        }
        throw new IssueTrackerError(`Jira request failed (${res.status})`, res.status);
      }
      if (res.status === 204) return { status: 204, data: null };
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        if (isAbort(err)) outcome = "timeout";
        throw this.transportError(err);
      }
      if (!text) return { status: res.status, data: null };
      try {
        return { status: res.status, data: JSON.parse(text) as T };
      } catch {
        throw new IssueTrackerError("Jira returned an unexpected response", res.status);
      }
    } finally {
      clearTimeout(timeout);
      this.metrics.jiraRequest(operation, outcome, secondsSince(started));
    }
  }

  private transportError(err: unknown): IssueTrackerError {
    if (isAbort(err)) return new IssueTrackerError("Jira request timed out");
    return new IssueTrackerError("Jira is unreachable");
  }
}
