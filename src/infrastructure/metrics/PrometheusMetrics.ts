/**
 * MetricsPort on prom-client, with its own registry (never the library's global one), the Node
 * runtime metrics (`collectDefaultMetrics`) and the bot's metrics, all named with `METRIC_PREFIX`.
 * Counters with a label start at 0 for every value of their fixed label sets, so a rate or an
 * absence alert works before the first event.
 */

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { SUPPORT_REQUEST_KINDS } from "../../domain/entities/SupportRequest";
import {
  BUTTON_CLICK_OUTCOMES, JIRA_OPERATIONS, JIRA_OUTCOMES, MODEL_CALL_OUTCOMES, MODEL_SLOTS, OFFER_EVENTS, RATING_OUTCOMES,
  WATCH_CHECK_OUTCOMES, WIRE_CONNECTION_EVENTS, WIRE_MESSAGE_KINDS, WIRE_SDK_PROBLEMS,
  type CollectedGauge, type MetricsPort,
} from "../../application/ports/MetricsPort";

export const METRIC_PREFIX = "wire_support_bot_";

/** Model calls take seconds, up to the timeout (60 s by default) and a fallback after it. */
export const MODEL_DURATION_BUCKETS = [0.25, 0.5, 1, 2, 5, 10, 20, 30, 45, 60, 90, 120];
/** Jira calls take tens of milliseconds to seconds, up to the timeout (15 s by default). */
export const JIRA_DURATION_BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15];
/** A watch check reads the database and Jira, and posts the updates it finds. */
export const WATCH_DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

export interface PrometheusMetrics {
  metrics: MetricsPort;
  /** The Content-Type of `render`'s output (Prometheus text format). */
  contentType: string;
  /** Every metric of the registry in the Prometheus text format. */
  render(): Promise<string>;
}

/** Every combination of the label sets, for starting a counter at 0. */
function combinations(sets: Record<string, readonly string[]>): Array<Record<string, string>> {
  return Object.entries(sets).reduce<Array<Record<string, string>>>(
    (acc, [name, values]) => acc.flatMap((labels) => values.map((value) => ({ ...labels, [name]: value }))),
    [{}],
  );
}

export function createPrometheusMetrics(): PrometheusMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: METRIC_PREFIX });
  const registers = [registry];

  const counter = <L extends string>(name: string, help: string, labels: Record<L, readonly string[]>): Counter<L> => {
    const metric = new Counter<L>({ name: METRIC_PREFIX + name, help, labelNames: Object.keys(labels) as L[], registers });
    for (const values of combinations(labels)) metric.inc(values as Partial<Record<L, string>>, 0);
    return metric;
  };
  const histogram = <L extends string>(name: string, help: string, labelNames: L[], buckets: number[]): Histogram<L> =>
    new Histogram<L>({ name: METRIC_PREFIX + name, help, labelNames, buckets, registers });

  const messages = counter("wire_messages_received_total", "Wire messages received, by kind.", { kind: WIRE_MESSAGE_KINDS });
  const connectionEvents = counter("wire_connection_events_total", "Wire WebSocket connections opened and lost, as the SDK reports them.", {
    event: WIRE_CONNECTION_EVENTS,
  });
  const connected = new Gauge({
    name: `${METRIC_PREFIX}wire_connected`, help: "1 while the Wire WebSocket is connected, 0 otherwise.", registers,
  });
  const sdkProblems = counter("wire_sdk_problems_total", "Warnings and errors the Wire SDK logged, whatever the SDK log level.", {
    severity: WIRE_SDK_PROBLEMS,
  });
  const modelCalls = counter("model_calls_total", "Model calls, by slot and outcome (a fallback counts once).", {
    slot: MODEL_SLOTS, outcome: MODEL_CALL_OUTCOMES,
  });
  const modelDuration = histogram("model_call_duration_seconds", "Duration of model calls, fallback included, by slot.", ["slot"], MODEL_DURATION_BUCKETS);
  const jiraRequests = counter("jira_requests_total", "Jira HTTP requests, by the tracker operation that made them and outcome.", {
    operation: JIRA_OPERATIONS, outcome: JIRA_OUTCOMES,
  });
  const jiraDuration = histogram("jira_request_duration_seconds", "Duration of Jira HTTP requests, by tracker operation.", ["operation"], JIRA_DURATION_BUCKETS);
  const watchChecks = counter("watch_checks_total", "Watch checks, by outcome.", { outcome: WATCH_CHECK_OUTCOMES });
  const watchDuration = histogram("watch_check_duration_seconds", "Duration of watch checks.", [], WATCH_DURATION_BUCKETS);
  const watched = new Gauge({
    name: `${METRIC_PREFIX}watched_requests`, help: "Support requests the last successful watch check looked at.", registers,
  });
  const raised = counter("support_requests_raised_total", "Support requests raised with the service desk, by kind.", { kind: SUPPORT_REQUEST_KINDS });
  const replies = counter("support_replies_sent_total", "Replies sent to the service desk from Wire.", {});
  const resolved = counter("support_requests_resolved_total", "Support requests resolved from Wire.", {});
  const offers = counter("offers_total", "Offers and questions put to members, and how they ended.", { event: OFFER_EVENTS });
  const clicks = counter("button_clicks_total", "Button clicks, by outcome.", { outcome: BUTTON_CLICK_OUTCOMES });
  const ratings = counter("ratings_total", "Satisfaction ratings sent to the service desk, by outcome.", { outcome: RATING_OUTCOMES });

  // Gauges read on collection; a reader that throws leaves the gauge at its last value.
  const readers = new Map<CollectedGauge, () => number>();
  const collected = (gauge: CollectedGauge, help: string) => new Gauge({
    name: METRIC_PREFIX + gauge, help, registers,
    collect() {
      const read = readers.get(gauge);
      if (!read) return;
      try { this.set(read()); } catch { /* keep the last value */ }
    },
  });
  collected("pending_offers", "Offers and questions waiting for an answer.");
  collected("queue_length", "Messages waiting in the passive-help queue.");

  const metrics: MetricsPort = {
    wireMessageReceived: (kind) => messages.inc({ kind }),
    wireConnection: (event) => {
      connectionEvents.inc({ event });
      connected.set(event === "connected" ? 1 : 0);
    },
    wireSdkProblem: (severity) => sdkProblems.inc({ severity }),
    modelCall: (slot, outcome, seconds) => {
      modelCalls.inc({ slot, outcome });
      modelDuration.observe({ slot }, seconds);
    },
    jiraRequest: (operation, outcome, seconds) => {
      jiraRequests.inc({ operation, outcome });
      jiraDuration.observe({ operation }, seconds);
    },
    watchCheck: (outcome, seconds, count) => {
      watchChecks.inc({ outcome });
      watchDuration.observe(seconds);
      if (count !== undefined) watched.set(count);
    },
    supportRequestRaised: (kind) => raised.inc({ kind }),
    supportReplySent: () => replies.inc(),
    supportRequestResolved: () => resolved.inc(),
    offer: (event) => offers.inc({ event }),
    buttonClick: (outcome) => clicks.inc({ outcome }),
    ratingSent: (outcome) => ratings.inc({ outcome }),
    collect: (gauge, read) => { readers.set(gauge, read); },
  };

  return { metrics, contentType: registry.contentType, render: () => registry.metrics() };
}
