import type { SupportRequestKind } from "../../domain/entities/SupportRequest";

/**
 * Port for operational metrics. Use cases and adapters record events and durations here without
 * knowing the metrics library; the Prometheus adapter turns them into counters, histograms and
 * gauges. Every label value comes from one of the small fixed sets below, or for token counts from
 * the configured model names: never a conversation, user, ticket or request ID, and never text.
 */

/** What arrived from Wire: a text, a photo or document upload, a button click, anything else. */
export const WIRE_MESSAGE_KINDS = ["text", "file", "button_click", "other"] as const;
export type WireMessageKind = (typeof WIRE_MESSAGE_KINDS)[number];

/** WebSocket state changes the Wire SDK reports. */
export const WIRE_CONNECTION_EVENTS = ["connected", "disconnected"] as const;
export type WireConnectionEvent = (typeof WIRE_CONNECTION_EVENTS)[number];

/**
 * What the Wire connection watchdog did: `restart` (asked the SDK to listen again after a period
 * without a connection), `exit` (ended the process after a second period, for a restart from outside).
 */
export const WIRE_WATCHDOG_ACTIONS = ["restart", "exit"] as const;
export type WireWatchdogAction = (typeof WIRE_WATCHDOG_ACTIONS)[number];

/** Severities of Wire SDK log calls that are counted, whatever the SDK's log level. */
export const WIRE_SDK_PROBLEMS = ["warn", "error"] as const;
export type WireSdkProblem = (typeof WIRE_SDK_PROBLEMS)[number];

/** The model slots (see `LLMConfig.slots`), and `embed` for the embeddings of the document index. */
export const MODEL_SLOTS = ["classify", "respond", "embed"] as const;
export type ModelSlotLabel = (typeof MODEL_SLOTS)[number];

/**
 * How a model call ended: `ok` from the primary model, `fallback` from the fallback model after
 * the primary was unavailable or timed out, `timeout` when the last attempt timed out, `error` otherwise.
 */
export const MODEL_CALL_OUTCOMES = ["ok", "fallback", "timeout", "error"] as const;
export type ModelCallOutcome = (typeof MODEL_CALL_OUTCOMES)[number];

/** Token directions of a model call: `input` (the prompt) and `output` (the completion). */
export const TOKEN_DIRECTIONS = ["input", "output"] as const;
export type TokenDirection = (typeof TOKEN_DIRECTIONS)[number];

/** The tracker operations (`IssueTrackerPort` methods) a tracker HTTP request is made for. */
export const JIRA_OPERATIONS = [
  "create_issue", "get_issue", "resolve_issue", "list_customer_replies", "add_customer_reply",
  "list_changed_since", "add_customer_attachment", "submit_feedback",
] as const;
export type JiraOperation = (typeof JIRA_OPERATIONS)[number];

/** How a tracker HTTP request ended: the response's status class, a timeout, or no response (`error`). */
export const JIRA_OUTCOMES = ["2xx", "4xx", "5xx", "timeout", "error"] as const;
export type JiraOutcome = (typeof JIRA_OUTCOMES)[number];

/** A watch check: `ok`, or `error` when the watched requests or the tracker's changes could not be read. */
export const WATCH_CHECK_OUTCOMES = ["ok", "error"] as const;
export type WatchCheckOutcome = (typeof WATCH_CHECK_OUTCOMES)[number];

/**
 * What happened to an offer or a question put to a member: made (stored), accepted (an option or
 * a yes ran), declined (a no or a declining option), expired (unanswered in time).
 */
export const OFFER_EVENTS = ["made", "accepted", "declined", "expired"] as const;
export type OfferEvent = (typeof OFFER_EVENTS)[number];

/**
 * A button click: accepted (decides the question), not_asked (by another member on an open
 * question), late (on an answered, closed, expired, replaced or unknown question), invalid (a
 * button that does not belong to the question).
 */
export const BUTTON_CLICK_OUTCOMES = ["accepted", "not_asked", "late", "invalid"] as const;
export type ButtonClickOutcome = (typeof BUTTON_CLICK_OUTCOMES)[number];

/**
 * A satisfaction rating: ok (Jira accepted it), refused (Jira rejected it), unconfirmed (a timeout
 * or server error, so it may have arrived), not_sent (stopped before Jira: out of range, not a
 * request of the conversation, or the request could not be read).
 */
export const RATING_OUTCOMES = ["ok", "refused", "unconfirmed", "not_sent"] as const;
export type RatingOutcome = (typeof RATING_OUTCOMES)[number];

/**
 * A search of the document index for an answer: hit (at least one excerpt passed on), miss (none
 * scored high enough, or the index is empty), error (the question could not be embedded or the
 * index could not be read).
 */
export const KNOWLEDGE_RETRIEVAL_OUTCOMES = ["hit", "miss", "error"] as const;
export type KnowledgeRetrievalOutcome = (typeof KNOWLEDGE_RETRIEVAL_OUTCOMES)[number];

/**
 * How the question "Did this help?" after an answer from the document index ended: solved
 * ([Solved] or a text answer such as "thanks"), ticket ([Raise a ticket], which leads to the raise
 * offer), ended (another message, a file or a newer question ended it without a decision),
 * expired (unanswered in time).
 */
export const KNOWLEDGE_HELP_OUTCOMES = ["solved", "ticket", "ended", "expired"] as const;
export type KnowledgeHelpOutcome = (typeof KNOWLEDGE_HELP_OUTCOMES)[number];

/** Values read when metrics are collected, not recorded as events. */
export const COLLECTED_GAUGES = ["pending_offers", "queue_length", "knowledge_chunks"] as const;
export type CollectedGauge = (typeof COLLECTED_GAUGES)[number];

export interface MetricsPort {
  wireMessageReceived(kind: WireMessageKind): void;
  wireConnection(event: WireConnectionEvent): void;
  wireWatchdogAction(action: WireWatchdogAction): void;
  wireSdkProblem(severity: WireSdkProblem): void;
  /** One model call through a slot, fallback included, with its duration in seconds. */
  modelCall(slot: ModelSlotLabel, outcome: ModelCallOutcome, seconds: number): void;
  /**
   * Tokens a successful model call used, as the provider reported them, under the configured name
   * of the model that answered (the fallback's name after a fallback). `output` is left out for
   * embeddings. The model name is the only label value that does not come from a fixed set.
   */
  modelTokens(slot: ModelSlotLabel, model: string, input: number, output?: number): void;
  /** A successful model call whose response reported no usable token usage. */
  modelUsageMissing(slot: ModelSlotLabel): void;
  /** One tracker HTTP request, with its duration in seconds. */
  jiraRequest(operation: JiraOperation, outcome: JiraOutcome, seconds: number): void;
  /** One watch check, with its duration in seconds and, when they were read, the number of requests watched. */
  watchCheck(outcome: WatchCheckOutcome, seconds: number, watched?: number): void;
  supportRequestRaised(kind: SupportRequestKind): void;
  supportReplySent(): void;
  supportRequestResolved(): void;
  offer(event: OfferEvent): void;
  buttonClick(outcome: ButtonClickOutcome): void;
  ratingSent(outcome: RatingOutcome): void;
  knowledgeRetrieval(outcome: KnowledgeRetrievalOutcome): void;
  knowledgeHelpAnswer(outcome: KnowledgeHelpOutcome): void;
  /** Registers how a gauge is read; it is called each time metrics are collected. */
  collect(gauge: CollectedGauge, read: () => number): void;
}

const ignore = (): void => {};

/** Records nothing: used when metrics are off, and as the default in tests and the CLI. */
export const NO_METRICS: MetricsPort = {
  wireMessageReceived: ignore,
  wireConnection: ignore,
  wireWatchdogAction: ignore,
  wireSdkProblem: ignore,
  modelCall: ignore,
  modelTokens: ignore,
  modelUsageMissing: ignore,
  jiraRequest: ignore,
  watchCheck: ignore,
  supportRequestRaised: ignore,
  supportReplySent: ignore,
  supportRequestResolved: ignore,
  offer: ignore,
  buttonClick: ignore,
  ratingSent: ignore,
  knowledgeRetrieval: ignore,
  knowledgeHelpAnswer: ignore,
  collect: ignore,
};

/** Seconds since `startedMs`, a `performance.now()` reading. */
export function secondsSince(startedMs: number): number {
  return (performance.now() - startedMs) / 1000;
}
