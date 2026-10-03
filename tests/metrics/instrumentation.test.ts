/**
 * Instrumentation at the places that record metrics, with a fake MetricsPort: the model client,
 * the Jira adapter, the offer store, the support use cases, the watch and the SDK logger bridge.
 * The router's counts are in tests/contract/WireEventRouterButtons.contract.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMClientFactory } from "../../src/infrastructure/llm/LLMClientFactory";
import { JiraServiceManagementAdapter } from "../../src/infrastructure/jira/JiraServiceManagementAdapter";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import { makeSdkLoggerBridge } from "../../src/infrastructure/wire/SdkLoggerBridge";
import { RaiseSupportRequest } from "../../src/application/usecases/jira/RaiseSupportRequest";
import { ReplyToServiceDesk } from "../../src/application/usecases/jira/ReplyToServiceDesk";
import { ResolveSupportRequest } from "../../src/application/usecases/jira/ResolveSupportRequest";
import { SubmitFeedback } from "../../src/application/usecases/jira/SubmitFeedback";
import { WatchSupportRequests } from "../../src/application/usecases/jira/WatchSupportRequests";
import { ConfirmOffer, type ConfirmOfferHandlers } from "../../src/application/usecases/jira/ConfirmOffer";
import { IssueTrackerError } from "../../src/application/ports/IssueTrackerPort";
import type { PendingOffer } from "../../src/application/ports/PendingOfferPort";
import type { JiraConfig, LLMConfig } from "../../src/app/config";
import {
  alice, convId, makeAudit, makeLogger, makeRequest, makeRequests, makeSnapshot, makeTracker, makeWire,
} from "../usecases/supportRequestFakes";
import { fakeMetrics } from "./fakeMetrics";

afterEach(() => vi.unstubAllGlobals());

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
const completion = () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));

describe("LLMClientFactory metrics", () => {
  const config: LLMConfig = {
    baseUrl: "http://model.test", apiKey: "synthetic", timeoutMs: 1000,
    slots: { respond: { model: "primary", fallback: "backup" }, classify: { model: "primary", fallback: "backup" } },
  };
  const call = async (responses: Array<() => Response | Promise<Response>>, slot: "classify" | "respond" = "respond") => {
    const fetch = vi.fn();
    for (const response of responses) fetch.mockImplementationOnce(async () => response());
    vi.stubGlobal("fetch", fetch);
    const { metrics, of, durations } = fakeMetrics();
    const factory = new LLMClientFactory(config, { info: vi.fn(), warn: vi.fn() } as never, metrics);
    const result = await factory.chatCompletion(slot, []).then(() => "resolved", (err: Error) => err.name);
    return { result, calls: of("modelCall"), durations };
  };

  it("records one call per completion by slot: ok, or fallback after an unavailable primary", async () => {
    expect(await call([completion], "classify")).toMatchObject({ result: "resolved", calls: [["classify", "ok"]] });
    const fallback = await call([() => new Response("busy", { status: 503 }), completion]);
    expect(fallback).toMatchObject({ result: "resolved", calls: [["respond", "fallback"]] });
    expect(fallback.durations).toHaveLength(1);
    expect(fallback.durations[0]).toBeGreaterThanOrEqual(0);
  });

  it("records a timeout when the last attempt timed out, and an error otherwise", async () => {
    const timeout = () => { throw abortError(); };
    expect(await call([timeout, timeout])).toMatchObject({ result: "AbortError", calls: [["respond", "timeout"]] });
    expect(await call([() => new Response("{}", { status: 400 })])).toMatchObject({ result: "Error", calls: [["respond", "error"]] });
    expect(await call([timeout, () => new Response("{}", { status: 500 })])).toMatchObject({ result: "Error", calls: [["respond", "error"]] });
    expect(await call([() => new Response(JSON.stringify({ choices: [] }))])).toMatchObject({ calls: [["respond", "error"]] });
  });
});

describe("JiraServiceManagementAdapter metrics", () => {
  const BASE = "https://api.test/ex/jira/cloud";
  const config: JiraConfig = {
    baseUrl: BASE, siteUrl: "https://site.test", apiToken: "synthetic-token", projectKey: "SD", serviceDeskId: "5",
    requestTypes: { fault: "101" }, timeoutMs: 1000, shareWithModel: false, passive: false, agentChat: "ask", feedback: false,
  };
  const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
  const issue = (category: string) => json({ key: "SD-1", fields: { summary: "S", status: { id: category, statusCategory: { key: category } } } });
  function setup(routes: Record<string, Array<() => Response>>) {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const queue = routes[`${init.method} ${url.replace(BASE, "")}`];
      if (!queue) throw new Error("unexpected request");
      return (queue.length > 1 ? queue.shift()! : queue[0]!)();
    }));
    const fake = fakeMetrics();
    const adapter = new JiraServiceManagementAdapter(config, makeLogger(), { sleep: async () => {}, metrics: fake.metrics });
    return { adapter, ...fake };
  }

  it("records every HTTP request under the tracker operation that made it, with its status class", async () => {
    const { adapter, of, durations } = setup({
      "GET /rest/api/3/issue/SD-1?fields=summary,status": [issue("new"), json({}, 404), issue("done")],
      "GET /rest/servicedeskapi/request/SD-1/sla": [json({ values: [] })],
      "GET /rest/api/3/issue/SD-1?fields=status": [issue("indeterminate")],
      "GET /rest/api/3/issue/SD-1/transitions": [json({ transitions: [{ id: "9", to: { id: "done", statusCategory: { key: "done" } } }] })],
      "POST /rest/api/3/issue/SD-1/transitions": [() => new Response(null, { status: 204 })],
    });
    await adapter.getIssue("SD-1");
    expect(await adapter.getIssue("SD-1")).toBeNull();
    await adapter.resolveIssue("SD-1");
    expect(of("jiraRequest")).toEqual([
      ["get_issue", "2xx"], ["get_issue", "2xx"],
      ["get_issue", "4xx"],
      ["resolve_issue", "2xx"], ["resolve_issue", "2xx"], ["resolve_issue", "2xx"], ["resolve_issue", "2xx"], ["resolve_issue", "2xx"],
    ]);
    expect(durations.every((seconds) => seconds >= 0)).toBe(true);
  });

  it("records 4xx and 5xx responses, timeouts and unreachable Jira", async () => {
    const { adapter, of } = setup({
      "POST /rest/servicedeskapi/request/SD-1/comment": [
        json({}, 403), json({}, 502),
        () => { throw abortError(); },
        () => { throw new TypeError("fetch failed"); },
      ],
    });
    for (let i = 0; i < 4; i++) await adapter.addCustomerReply("SD-1", "body").catch(() => undefined);
    expect(of("jiraRequest")).toEqual([
      ["add_customer_reply", "4xx"], ["add_customer_reply", "5xx"], ["add_customer_reply", "timeout"], ["add_customer_reply", "error"],
    ]);
  });

  it("labels the account lookup and the change check with the operation that needs them", async () => {
    const { adapter, of } = setup({
      "GET /rest/servicedeskapi/request/SD-1/comment?public=true&internal=false&start=0&limit=100": [json({
        values: [{ public: true, body: "reply", author: { accountId: "a1" }, created: { epochMillis: 1 } }], isLastPage: true,
      })],
      "GET /rest/api/3/myself": [json({ accountId: "a1" })],
      "POST /rest/api/3/search/jql": [json({ issues: [], isLast: true })],
      "POST /rest/servicedeskapi/request/SD-1/feedback": [() => new Response(null, { status: 204 })],
    });
    await adapter.listCustomerReplies("SD-1", 3);
    await adapter.listChangedSince(["SD-1"]);
    await adapter.submitFeedback("SD-1", 5);
    expect(of("jiraRequest")).toEqual([
      ["list_customer_replies", "2xx"], ["list_customer_replies", "2xx"], ["list_changed_since", "2xx"], ["submit_feedback", "2xx"],
    ]);
  });
});

describe("InMemoryPendingOfferStore metrics", () => {
  const T0 = new Date("2026-10-03T10:00:00Z");
  const offer = (requesterId = alice, minutes = 10): PendingOffer => ({
    command: { kind: "resolve", issueKey: "SD-6" }, conversationId: convId, requesterId, createdAt: T0,
    expiresAt: new Date(T0.getTime() + minutes * 60_000),
  });

  it("counts an offer as made once, also when it is stored again, and as expired once noticed", () => {
    const { metrics, of, readers } = fakeMetrics();
    const store = new InMemoryPendingOfferStore(metrics);
    const first = offer();
    store.put(first);
    store.put(first);
    store.put(offer({ id: "user-2", domain: "example.com" }, 30));
    expect(store.pendingCount(T0)).toBe(2);
    store.sweepExpired(new Date(T0.getTime() + 15 * 60_000));
    expect(of("offer")).toEqual([["made"], ["made"], ["expired"]]);
    expect(store.pendingCount(new Date(T0.getTime() + 15 * 60_000))).toBe(1);
    expect(store.pendingCount(new Date(T0.getTime() + 31 * 60_000))).toBe(0);
    expect(readers.size).toBe(0);
  });

  it("counts an expiry noticed on reading the requester's offer", () => {
    const { metrics, of } = fakeMetrics();
    const store = new InMemoryPendingOfferStore(metrics);
    store.put(offer());
    expect(store.take(convId, alice, new Date(T0.getTime() + 11 * 60_000))).toBeNull();
    expect(of("offer")).toEqual([["made"], ["expired"]]);
  });
});

describe("ConfirmOffer metrics", () => {
  function setup() {
    const { metrics, of } = fakeMetrics();
    const store = new InMemoryPendingOfferStore();
    const handlers = { resolveSupportRequest: { execute: vi.fn().mockResolvedValue(null) } };
    const { wire } = makeWire();
    const useCase = new ConfirmOffer(store, handlers as unknown as ConfirmOfferHandlers, wire, undefined, undefined, [], undefined, metrics);
    const now = new Date();
    store.put({ command: { kind: "resolve", issueKey: "SD-6" }, conversationId: convId, requesterId: alice, createdAt: now, expiresAt: new Date(now.getTime() + 60_000) });
    const answer = (text: string) => useCase.execute({ text, conversationId: convId, requesterId: alice });
    return { of, answer };
  }

  it("counts a yes as accepted and a no as declined, and an acknowledgment as neither", async () => {
    const yes = setup();
    await yes.answer("ok");
    await yes.answer("yes");
    expect(yes.of("offer")).toEqual([["accepted"]]);
    const no = setup();
    await no.answer("no");
    expect(no.of("offer")).toEqual([["declined"]]);
  });
});

describe("support use case metrics", () => {
  it("counts a raised request by kind once Jira has it, and nothing when Jira refuses", async () => {
    const { metrics, of } = fakeMetrics();
    const tracker = makeTracker();
    const useCase = new RaiseSupportRequest(makeRequests([]), tracker, makeWire().wire, makeAudit(), makeLogger(), {}, undefined, metrics);
    const input = { summary: "Printer jams", description: "It jams.", conversationId: convId, requesterId: alice, requestKind: "question" as const };
    tracker.createIssue.mockResolvedValueOnce({ key: "SD-7", url: "https://jira.test/browse/SD-7", fieldsApplied: true });
    await useCase.execute(input);
    tracker.createIssue.mockRejectedValueOnce(new IssueTrackerError("Jira request failed (400)", 400));
    await useCase.execute(input);
    expect(of("supportRequestRaised")).toEqual([["question"]]);
  });

  it("counts a reply only when Jira accepted it", async () => {
    const { metrics, of } = fakeMetrics();
    const tracker = makeTracker();
    const useCase = new ReplyToServiceDesk(makeRequests(), tracker, makeWire().wire, makeAudit(), makeLogger(), metrics);
    const input = { reference: "SD-6", body: "Still broken", conversationId: convId, actorId: alice };
    await useCase.execute(input);
    tracker.addCustomerReply.mockRejectedValueOnce(new IssueTrackerError("Jira request failed (500)", 500));
    await useCase.execute(input);
    expect(of("supportReplySent")).toEqual([[]]);
  });

  it("counts a resolve only when it reached done", async () => {
    const { metrics, of } = fakeMetrics();
    const tracker = makeTracker();
    const useCase = new ResolveSupportRequest(makeRequests(), tracker, makeWire().wire, makeAudit(), makeLogger(), undefined, undefined, metrics);
    tracker.resolveIssue.mockResolvedValueOnce(makeSnapshot({ statusCategory: "in_progress" }));
    await useCase.execute({ issueKey: "SD-6", conversationId: convId, actorId: alice });
    tracker.resolveIssue.mockResolvedValueOnce(makeSnapshot({ statusCategory: "done" }));
    await useCase.execute({ issueKey: "SD-6", conversationId: convId, actorId: alice });
    expect(of("supportRequestResolved")).toEqual([[]]);
  });

  it("counts ratings by outcome: ok, refused, unconfirmed and not sent", async () => {
    const { metrics, of } = fakeMetrics();
    const tracker = makeTracker();
    const useCase = new SubmitFeedback(makeRequests([makeRequest({ statusCategory: "done" })]), tracker, makeWire().wire, makeAudit(), makeLogger(), undefined, metrics);
    const rate = (rating: number, issueKey = "SD-6") => useCase.execute({ issueKey, rating, conversationId: convId, actorId: alice });
    await rate(5);
    tracker.submitFeedback.mockRejectedValueOnce(new IssueTrackerError("Jira request failed (404)", 404));
    await rate(4);
    tracker.submitFeedback.mockRejectedValueOnce(new IssueTrackerError("Jira request timed out"));
    await rate(3);
    await rate(9);
    await rate(2, "SD-99");
    expect(of("ratingSent")).toEqual([["ok"], ["refused"], ["unconfirmed"], ["not_sent"], ["not_sent"]]);
  });
});

describe("WatchSupportRequests metrics", () => {
  const watcher = (requests = makeRequests(), tracker = makeTracker()) => {
    const fake = fakeMetrics();
    const channels = { get: vi.fn().mockResolvedValue(null), upsert: vi.fn(), setTimezone: vi.fn() };
    const watch = new WatchSupportRequests(requests, tracker, makeWire().wire, makeAudit(), channels as never, makeLogger(), undefined, {
      metrics: fake.metrics,
    });
    return { watch, ...fake };
  };

  it("records an ok check with the number of requests watched", async () => {
    const { watch, of, durations } = watcher(makeRequests([makeRequest(), makeRequest({ key: "SD-7" })]));
    await watch.check();
    expect(of("watchCheck")).toEqual([["ok", 2]]);
    expect(durations[0]).toBeGreaterThanOrEqual(0);
    const empty = watcher(makeRequests([]));
    await empty.watch.check();
    expect(empty.of("watchCheck")).toEqual([["ok", 0]]);
  });

  it("records an error when the watched requests or the tracker's changes cannot be read", async () => {
    const requests = makeRequests();
    requests.listWatched.mockRejectedValueOnce(new Error("database down"));
    const tracker = makeTracker();
    tracker.listChangedSince.mockRejectedValueOnce(new IssueTrackerError("Jira request timed out"));
    const { watch, of } = watcher(requests, tracker);
    await watch.check();
    await watch.check();
    await watch.check();
    expect(of("watchCheck")).toEqual([["error"], ["error"], ["ok", 1]]);
  });
});

describe("SDK logger bridge metrics", () => {
  it("counts the SDK's warnings and errors, also below its log level, and nothing else", () => {
    const { metrics, of } = fakeMetrics();
    const logger = makeLogger();
    logger.child.mockReturnValue(logger);
    const bridge = makeSdkLoggerBridge(logger, { level: "off", content: "none", metrics });
    bridge.debug("connecting");
    bridge.info("Websocket Connected");
    bridge.warn("WebSocket Closed");
    bridge.error("Websocket Error:", { type: "error" });
    expect(of("wireSdkProblem")).toEqual([["warn"], ["error"]]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
