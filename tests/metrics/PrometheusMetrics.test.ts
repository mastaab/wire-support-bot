import { describe, expect, it } from "vitest";
import { createPrometheusMetrics } from "../../src/infrastructure/metrics/PrometheusMetrics";
import { NO_METRICS, type MetricsPort } from "../../src/application/ports/MetricsPort";

/** The sample lines (not comments) of the bot's own metrics, without the Node runtime metrics. */
async function appSamples(render: () => Promise<string>): Promise<string[]> {
  const text = await render();
  return text.split("\n").filter((line) => line.startsWith("wire_support_bot_") && !line.startsWith("wire_support_bot_process_")
    && !line.startsWith("wire_support_bot_nodejs_"));
}

describe("createPrometheusMetrics", () => {
  it("names every metric with the prefix, including the Node runtime metrics", async () => {
    const { render, contentType } = createPrometheusMetrics();
    const text = await render();
    expect(contentType).toContain("text/plain");
    expect(text).toContain("# TYPE wire_support_bot_process_cpu_seconds_total counter");
    expect(text).toContain("# TYPE wire_support_bot_nodejs_eventloop_lag_seconds gauge");
    const names = [...text.matchAll(/^# TYPE (\S+) (\S+)$/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(names.every((name) => name.startsWith("wire_support_bot_"))).toBe(true);
    for (const expected of [
      "wire_support_bot_wire_messages_received_total counter",
      "wire_support_bot_wire_connection_events_total counter",
      "wire_support_bot_wire_connected gauge",
      "wire_support_bot_wire_sdk_problems_total counter",
      "wire_support_bot_model_calls_total counter",
      "wire_support_bot_model_call_duration_seconds histogram",
      "wire_support_bot_jira_requests_total counter",
      "wire_support_bot_jira_request_duration_seconds histogram",
      "wire_support_bot_watch_checks_total counter",
      "wire_support_bot_watch_check_duration_seconds histogram",
      "wire_support_bot_watched_requests gauge",
      "wire_support_bot_support_requests_raised_total counter",
      "wire_support_bot_support_replies_sent_total counter",
      "wire_support_bot_support_requests_resolved_total counter",
      "wire_support_bot_offers_total counter",
      "wire_support_bot_button_clicks_total counter",
      "wire_support_bot_ratings_total counter",
      "wire_support_bot_pending_offers gauge",
      "wire_support_bot_queue_length gauge",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("starts every counter at 0 for each value of its fixed label sets", async () => {
    const { render } = createPrometheusMetrics();
    const samples = await appSamples(render);
    expect(samples).toContain('wire_support_bot_wire_messages_received_total{kind="button_click"} 0');
    expect(samples).toContain('wire_support_bot_model_calls_total{slot="classify",outcome="fallback"} 0');
    expect(samples).toContain('wire_support_bot_jira_requests_total{operation="submit_feedback",outcome="timeout"} 0');
    expect(samples).toContain('wire_support_bot_support_requests_raised_total{kind="part"} 0');
    expect(samples).toContain("wire_support_bot_support_replies_sent_total 0");
    expect(samples.filter((s) => s.startsWith("wire_support_bot_jira_requests_total{"))).toHaveLength(8 * 5);
    expect(samples.filter((s) => s.startsWith("wire_support_bot_model_calls_total{"))).toHaveLength(2 * 4);
  });

  it("records events with their labels, durations in the histograms, and gauges on collection", async () => {
    const { metrics, render } = createPrometheusMetrics();
    let pending = 3;
    metrics.collect("pending_offers", () => pending);
    metrics.collect("queue_length", () => { throw new Error("not available"); });
    metrics.wireMessageReceived("text");
    metrics.wireMessageReceived("text");
    metrics.wireConnection("connected");
    metrics.wireSdkProblem("error");
    metrics.modelCall("respond", "fallback", 12.5);
    metrics.jiraRequest("get_issue", "4xx", 0.2);
    metrics.watchCheck("ok", 1.5, 7);
    metrics.watchCheck("error", 0.3);
    metrics.supportRequestRaised("fault");
    metrics.supportReplySent();
    metrics.supportRequestResolved();
    metrics.offer("made");
    metrics.buttonClick("not_asked");
    metrics.ratingSent("refused");
    let samples = await appSamples(render);
    for (const expected of [
      'wire_support_bot_wire_messages_received_total{kind="text"} 2',
      'wire_support_bot_wire_connection_events_total{event="connected"} 1',
      "wire_support_bot_wire_connected 1",
      'wire_support_bot_wire_sdk_problems_total{severity="error"} 1',
      'wire_support_bot_model_calls_total{slot="respond",outcome="fallback"} 1',
      'wire_support_bot_model_call_duration_seconds_bucket{le="10",slot="respond"} 0',
      'wire_support_bot_model_call_duration_seconds_bucket{le="20",slot="respond"} 1',
      'wire_support_bot_model_call_duration_seconds_sum{slot="respond"} 12.5',
      'wire_support_bot_jira_requests_total{operation="get_issue",outcome="4xx"} 1',
      'wire_support_bot_jira_request_duration_seconds_bucket{le="0.25",operation="get_issue"} 1',
      'wire_support_bot_watch_checks_total{outcome="ok"} 1',
      'wire_support_bot_watch_checks_total{outcome="error"} 1',
      "wire_support_bot_watch_check_duration_seconds_count 2",
      "wire_support_bot_watched_requests 7",
      'wire_support_bot_support_requests_raised_total{kind="fault"} 1',
      "wire_support_bot_support_replies_sent_total 1",
      "wire_support_bot_support_requests_resolved_total 1",
      'wire_support_bot_offers_total{event="made"} 1',
      'wire_support_bot_button_clicks_total{outcome="not_asked"} 1',
      'wire_support_bot_ratings_total{outcome="refused"} 1',
      "wire_support_bot_pending_offers 3",
      "wire_support_bot_queue_length 0",
    ]) {
      expect(samples).toContain(expected);
    }
    pending = 0;
    metrics.wireConnection("disconnected");
    samples = await appSamples(render);
    expect(samples).toContain("wire_support_bot_pending_offers 0");
    expect(samples).toContain("wire_support_bot_wire_connected 0");
  });

  it("keeps each instance's registry apart", async () => {
    const first = createPrometheusMetrics();
    const second = createPrometheusMetrics();
    first.metrics.supportReplySent();
    expect(await appSamples(second.render)).toContain("wire_support_bot_support_replies_sent_total 0");
  });
});

describe("NO_METRICS", () => {
  it("accepts every call and records nothing", () => {
    const port: MetricsPort = NO_METRICS;
    expect(() => {
      port.wireMessageReceived("other");
      port.modelCall("classify", "error", 1);
      port.jiraRequest("create_issue", "5xx", 1);
      port.watchCheck("ok", 1, 0);
      port.collect("pending_offers", () => { throw new Error("never read"); });
    }).not.toThrow();
  });
});
