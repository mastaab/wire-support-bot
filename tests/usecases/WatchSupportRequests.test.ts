import { describe, it, expect, vi } from "vitest";
import { WatchSupportRequests } from "../../src/application/usecases/jira/WatchSupportRequests";
import type { WatchGuards } from "../../src/application/usecases/jira/WatchSupportRequests";
import { SupportRequestWrites } from "../../src/application/services/SupportRequestWrites";
import { GetIssueStatus } from "../../src/application/usecases/jira/GetIssueStatus";
import { DeskUpdateQuestions } from "../../src/application/services/deskUpdateQuestions";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import { sweepEndedOfferPrompts } from "../../src/application/services/offerPromptClosing";
import { OpenAgentConversation } from "../../src/application/usecases/jira/OpenAgentConversation";
import { AskForAgentConversation } from "../../src/application/usecases/jira/AskForAgentConversation";
import type { OpenAgentConversationInput, OpenAgentConversationOutcome } from "../../src/application/usecases/jira/OpenAgentConversation";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import type { ChannelConfig } from "../../src/domain/repositories/ChannelConfigRepository";
import type { IssueChange, IssueReply, IssueStatusCategory } from "../../src/application/ports/IssueTrackerPort";
import { IssueTrackerError } from "../../src/application/ports/IssueTrackerPort";
import {
  alice, convId, created, loggedText, makeAudit, makeLogger, makeRequest, makeRequests, makeSnapshot, makeTracker, makeWire, sentRefFor,
} from "./supportRequestFakes";

const T0 = new Date("2026-09-26T10:00:00Z");
const SEEN = new Date("2026-09-26T09:00:00Z");
const LAST_MESSAGE = { messageId: "raised-1", sha256: "a".repeat(64) };
const SECRET = "PRIVATE_REPLY_TEXT";

/** Channel configs by channel ID; a missing entry means no config. */
function makeChannels(configs: Record<string, Partial<ChannelConfig>> = {}) {
  const get = vi.fn(async (channelId: string): Promise<ChannelConfig | null> => {
    const config = configs[channelId];
    return config ? {
      channelId, organisationId: "example.com", timezone: "UTC", ...config,
    } : null;
  });
  return { get, upsert: vi.fn(), setTimezone: vi.fn() };
}

function setTimezone(channels: ReturnType<typeof makeChannels>, timezone: string) {
  channels.get.mockImplementation(async (channelId: string) => ({
    channelId, organisationId: "example.com", timezone,
  }));
}

const change = (key: string, statusCategory: IssueStatusCategory, updated: Date): IssueChange => ({ key, statusCategory, updated });
const reply = (author: string, at: string, body: string, fromThisBot = false): IssueReply =>
  ({ author, created: new Date(at), body, fromThisBot });

/** The `since` the watch passes: two minutes before the previous check, for late search results and clock skew. */
const ago = (d: Date) => new Date(d.getTime() - 2 * 60 * 1000);

/** A clock that returns the given times in order and repeats the last one. */
function clock(...times: Date[]) {
  const queue = [...times];
  return vi.fn(() => (queue.length > 1 ? queue.shift()! : queue[0]));
}

function setup(
  records: SupportRequest[],
  options: { channels?: ReturnType<typeof makeChannels>; now?: () => Date; guards?: WatchGuards } = {},
) {
  const requests = makeRequests(records);
  const tracker = makeTracker();
  // By default the live read confirms the category the latest change check listed.
  tracker.getIssue.mockImplementation(async (key: string) => {
    const listed = tracker.listChangedSince.mock.settledResults.at(-1);
    const found = listed?.type === "fulfilled" ? (listed.value as IssueChange[]).find((c) => c.key === key) : undefined;
    return makeSnapshot({ key, ...(found ? { statusCategory: found.statusCategory } : {}) });
  });
  const { wire, sent } = makeWire();
  const audit = makeAudit();
  const logger = makeLogger();
  const channels = options.channels ?? makeChannels();
  const watcher = new WatchSupportRequests(
    requests, tracker, wire, audit, channels, logger, options.now ?? (() => T0), options.guards,
  );
  return { requests, tracker, wire, sent, audit, logger, channels, watcher };
}

/** A watched request that already has its reply baseline and a stored last message. */
const watched = (overrides: Partial<SupportRequest> = {}) =>
  makeRequest({ lastSeenReplyAt: SEEN, lastMessage: LAST_MESSAGE, ...overrides });

describe("WatchSupportRequests: first check and baseline", () => {
  it("passes no since on the first check and baselines requests without lastSeenReplyAt, without announcing", async () => {
    const { watcher, tracker, requests, wire } = setup([makeRequest(), makeRequest({ key: "SD-7" })]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "todo", T0), change("SD-7", "todo", T0)]);
    tracker.listCustomerReplies.mockImplementation(async (key: string) =>
      key === "SD-6" ? [reply("Dana", "2026-09-25T10:00:00Z", "old"), reply("Dana", "2026-09-25T11:00:00Z", "older news")] : []);

    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });

    expect(tracker.listChangedSince).toHaveBeenCalledWith(["SD-6", "SD-7"], undefined);
    expect(tracker.listCustomerReplies).toHaveBeenCalledWith("SD-6", 10);
    expect(requests.advanceLastSeenReplyAt).toHaveBeenCalledWith("SD-6", new Date("2026-09-25T11:00:00Z"));
    expect(requests.advanceLastSeenReplyAt).toHaveBeenCalledWith("SD-7", created);
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it("asks from two minutes before the previous check and ignores changes at or before that", async () => {
    const t1 = new Date("2026-09-26T10:00:30Z");
    const { watcher, tracker, wire } = setup([watched()], { now: clock(T0, T0, t1) });
    await watcher.check();
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "in_progress", ago(T0))]);
    await watcher.check();
    expect(tracker.listChangedSince).toHaveBeenLastCalledWith(["SD-6"], ago(T0));
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it("still announces a change that reached Jira's search late, within the overlap", async () => {
    const t1 = new Date("2026-09-26T10:00:30Z");
    const { watcher, tracker, sent } = setup([watched()], { now: clock(T0, T0, t1) });
    await watcher.check();
    // Updated just before the previous check, but only searchable now.
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "in_progress", new Date("2026-09-26T09:59:50Z"))]);
    await watcher.check();
    expect(sent).toEqual(["**SD-6** VPN drops every ten minutes\nNow in progress."]);
  });

  it("lists watched requests with resolved ones from the last day", async () => {
    const { watcher, requests } = setup([watched()]);
    await watcher.check();
    expect(requests.listWatched).toHaveBeenCalledWith(new Date("2026-09-25T10:00:00Z"));
  });

  it("advances the check time when there is nothing to watch", async () => {
    const t1 = new Date("2026-09-26T10:01:00Z");
    const records: SupportRequest[] = [];
    const { watcher, tracker } = setup(records, { now: clock(T0, T0, t1) });
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(tracker.listChangedSince).not.toHaveBeenCalled();
    records.push(watched());
    await watcher.check();
    expect(tracker.listChangedSince).toHaveBeenCalledWith(["SD-6"], ago(T0));
  });

  it("leaves out records outside the tracker's project", async () => {
    const { watcher, tracker } = setup([watched(), watched({ key: "OPS-1" })]);
    await watcher.check();
    expect(tracker.listChangedSince).toHaveBeenCalledWith(["SD-6"], undefined);
  });
});

describe("WatchSupportRequests: new replies", () => {
  it("announces a new desk reply once, quoting the last message, then stores the reference and the marker", async () => {
    const { watcher, tracker, requests, wire, sent, audit } = setup([watched()]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "todo", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([
      reply("Dana", "2026-09-26T08:00:00Z", "already seen"),
      reply("Dana", "2026-09-26T09:30:00Z", "Please restart the router."),
    ]);

    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });

    expect(sent).toEqual([[
      "**SD-6** VPN drops every ten minutes",
      "",
      "New reply from the service desk:",
      "",
      "**Dana**, 26 Sept, 09:30 UTC",
      "> Please restart the router.",
    ].join("\n")]);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { quote: LAST_MESSAGE });
    expect(requests.setLastMessage).toHaveBeenCalledWith("SD-6", sentRefFor(1));
    expect(requests.advanceLastSeenReplyAt).toHaveBeenCalledWith("SD-6", new Date("2026-09-26T09:30:00Z"));
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("does not announce the same reply at the next check once the marker has moved", async () => {
    const records = [watched()];
    const t1 = new Date("2026-09-26T10:00:30Z");
    const { watcher, tracker, requests, sent } = setup(records, { now: clock(T0, T0, T0, T0, t1) });
    requests.advanceLastSeenReplyAt.mockImplementation(async (key: string, at: Date) => {
      const record = records.find((r) => r.key === key)!;
      record.lastSeenReplyAt = at;
    });
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "todo", t1)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", "Once")]);
    await watcher.check();
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(sent).toHaveLength(1);
  });

  it("uses the plural heading and shows at most the three newest replies, in the channel's timezone", async () => {
    const channels = makeChannels({ "conv-1@example.com": { timezone: "Europe/Berlin" } });
    const { watcher, tracker, sent } = setup([watched()], { channels });
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "todo", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([
      reply("Dana", "2026-09-26T09:10:00Z", "one"),
      reply("Dana", "2026-09-26T09:20:00Z", "two"),
      reply("Lee", "2026-09-26T09:30:00Z", "three"),
      reply("Dana", "2026-09-26T09:40:00Z", "four"),
    ]);
    await watcher.check();
    expect(sent[0]).toContain("New replies from the service desk:");
    expect(sent[0]).not.toContain("> one");
    expect(sent[0]).toContain("> two");
    expect(sent[0]).toContain("> four");
    expect(sent[0]).toContain("**Dana**, 26 Sept, 11:40 CEST");
  });

  it("does not announce the bot's own replies or replies at or before the marker, but moves the marker past them", async () => {
    const { watcher, tracker, requests, wire } = setup([watched()]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "todo", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([
      reply("Dana", "2026-09-26T09:00:00Z", "at the marker"),
      reply("WireSupportBotApp", "2026-09-26T09:45:00Z", "Sent from Wire.", true),
    ]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(wire.sendPlainText).not.toHaveBeenCalled();
    expect(requests.advanceLastSeenReplyAt).toHaveBeenCalledWith("SD-6", new Date("2026-09-26T09:45:00Z"));
  });

  it("does not move the marker when no newer reply was fetched", async () => {
    const { watcher, tracker, requests } = setup([watched()]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "todo", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T08:00:00Z", "old")]);
    await watcher.check();
    expect(requests.advanceLastSeenReplyAt).not.toHaveBeenCalled();
  });

  it("posts standalone when no last message is stored and skips the reference when the transport returns none", async () => {
    const { watcher, tracker, requests, wire } = setup([watched({ lastMessage: undefined })]);
    wire.sendPlainText.mockResolvedValueOnce(undefined);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "in_progress", T0)]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, "**SD-6** VPN drops every ten minutes\nNow in progress.", undefined);
    expect(requests.setLastMessage).not.toHaveBeenCalled();
  });
});

describe("WatchSupportRequests: status changes", () => {
  it("announces work starting and stores the status through the audited refresh", async () => {
    const { watcher, tracker, requests, sent, audit } = setup([watched()]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "in_progress", T0)]);
    await watcher.check();
    expect(sent).toEqual(["**SD-6** VPN drops every ten minutes\nNow in progress."]);
    expect(requests.updateStatusCategory).toHaveBeenCalledWith("SD-6", "in_progress", T0);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: "entity_updated", entityType: "SupportRequest", entityId: "SD-6",
      actorId: { id: "wire-support-bot", domain: "example.com" }, details: { statusCategory: "in_progress" },
    }));
  });

  it("announces a resolve with the SLA lines", async () => {
    const { watcher, tracker, sent } = setup([watched({ statusCategory: "in_progress" })]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "done", T0)]);
    tracker.getIssue.mockResolvedValue(makeSnapshot({ statusCategory: "done", slas: [
      { name: "Time to first response", state: "met", elapsed: "3m", goal: "4h" },
      { name: "Time to done", state: "breached", goal: "16h" },
    ] }));
    await watcher.check();
    expect(sent).toEqual([[
      "**SD-6** VPN drops every ten minutes",
      "Resolved by the service desk.",
      "Time to first response: met in 3m (target 4h)",
      "Time to done: breached (target 16h)",
    ].join("\n")]);
  });

  it("keeps a status change pending when the live read fails, and announces it at the next check", async () => {
    const { watcher, tracker, sent, requests, logger } = setup([watched()]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "done", T0)]);
    const follow = tracker.getIssue.getMockImplementation()!;
    tracker.getIssue.mockRejectedValueOnce(new IssueTrackerError("Jira request failed (500)", 500));
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(sent).toEqual([]);
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { key: "SD-6", err: "IssueTrackerError", status: 500 });
    tracker.getIssue.mockImplementation(follow);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(sent[0]).toContain("Resolved by the service desk.");
  });

  it("trusts the live category over a stale listed one", async () => {
    // Listed as done, but the ticket is back in progress by the time it is read.
    const { watcher, tracker, sent, requests } = setup([watched({ statusCategory: "in_progress" })]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "done", T0)]);
    tracker.getIssue.mockResolvedValue(makeSnapshot({ statusCategory: "in_progress" }));
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(sent).toEqual([]);
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
  });

  it.each([
    ["done", "todo", "Reopened by the service desk."],
    ["done", "in_progress", "Reopened by the service desk."],
    ["in_progress", "todo", "Moved back to To do."],
  ] as const)("announces %s to %s as %s", async (from, to, line) => {
    const { watcher, tracker, sent } = setup([watched({ statusCategory: from })]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", to, T0)]);
    await watcher.check();
    expect(sent).toEqual([`**SD-6** VPN drops every ten minutes\n${line}`]);
  });

  it("puts a status change and a new reply into one message", async () => {
    const { watcher, tracker, sent } = setup([watched({ statusCategory: "in_progress" })]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "done", T0)]);
    tracker.getIssue.mockResolvedValue(makeSnapshot({ statusCategory: "done", slas: [{ name: "Time to done", state: "met", elapsed: "2h", goal: "16h" }] }));
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:50:00Z", "Fixed the tunnel.")]);
    await watcher.check();
    expect(sent).toEqual([[
      "**SD-6** VPN drops every ten minutes",
      "Resolved by the service desk.",
      "Time to done: met in 2h (target 16h)",
      "",
      "New reply from the service desk:",
      "",
      "**Dana**, 26 Sept, 09:50 UTC",
      "> Fixed the tunnel.",
    ].join("\n")]);
  });

  it("stays silent when the status changed inside a category", async () => {
    const { watcher, tracker, wire, requests } = setup([watched({ statusCategory: "in_progress" })]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "in_progress", T0)]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(wire.sendPlainText).not.toHaveBeenCalled();
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(tracker.getIssue).not.toHaveBeenCalled();
  });
});

describe("WatchSupportRequests: channel config", () => {
  it("posts in a channel with a stored config", async () => {
    const channels = makeChannels();
    setTimezone(channels, "Europe/Berlin");
    const { watcher, tracker, sent } = setup([watched()], { channels });
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "in_progress", T0)]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(sent).toEqual(["**SD-6** VPN drops every ten minutes\nNow in progress."]);
  });

  it("drops a pending key that is no longer watched", async () => {
    const records = [watched()];
    const { watcher, tracker, wire } = setup(records);
    wire.sendPlainText.mockRejectedValueOnce(new Error("offline"));
    tracker.listChangedSince.mockResolvedValueOnce([change("SD-6", "in_progress", T0)]).mockResolvedValue([]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    records[0].deleted = true;
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
  });

  it("posts for a channel without a config, with times in UTC", async () => {
    const { watcher, tracker, sent } = setup([watched()], { channels: makeChannels() });
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "in_progress", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", "Looking into it.")]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(sent[0]).toContain("**Dana**, 26 Sept, 09:30 UTC");
  });
});

describe("WatchSupportRequests: failures", () => {
  it("keeps the markers after a failed send and retries at the next check", async () => {
    const t1 = new Date("2026-09-26T10:00:30Z");
    const { watcher, tracker, requests, wire, logger } = setup([watched()], { now: clock(T0, T0, t1) });
    wire.sendPlainText.mockRejectedValueOnce(new Error(`network ${SECRET}`));
    tracker.listChangedSince.mockResolvedValueOnce([change("SD-6", "in_progress", T0)]).mockResolvedValue([]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", SECRET)]);

    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(requests.advanceLastSeenReplyAt).not.toHaveBeenCalled();
    expect(requests.setLastMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { key: "SD-6", err: "Error" });

    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(wire.sendPlainText).toHaveBeenCalledTimes(2);
    // The rejected call bypasses the fake, so the retry is the first message it records.
    expect(requests.setLastMessage).toHaveBeenCalledWith("SD-6", sentRefFor(1));
    expect(requests.updateStatusCategory).toHaveBeenCalledWith("SD-6", "in_progress", t1);
    expect(requests.advanceLastSeenReplyAt).toHaveBeenCalledWith("SD-6", new Date("2026-09-26T09:30:00Z"));
    expect(loggedText(logger)).not.toContain(SECRET);
  });

  it("leaves the last check time after a failed tracker call, so the next check asks from the older time", async () => {
    const t1 = new Date("2026-09-26T10:00:30Z");
    const t2 = new Date("2026-09-26T10:01:00Z");
    const t3 = new Date("2026-09-26T10:01:30Z");
    const { watcher, tracker, logger } = setup([watched()], { now: clock(T0, T0, t1, t1, t2, t2, t3) });
    await watcher.check();
    tracker.listChangedSince.mockRejectedValueOnce(new IssueTrackerError("Jira request failed (503)", 503));
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { err: "IssueTrackerError", status: 503 });
    await watcher.check();
    expect(tracker.listChangedSince.mock.calls.map((c) => c[1])).toEqual([undefined, ago(T0), ago(T0)]);
    await watcher.check();
    expect(tracker.listChangedSince).toHaveBeenLastCalledWith(["SD-6"], ago(t2));
  });

  it("does not let one failing request stop the others", async () => {
    const { watcher, tracker, sent, logger } = setup([watched(), watched({ key: "SD-7", summary: "Printer offline" })]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "in_progress", T0), change("SD-7", "in_progress", T0)]);
    tracker.listCustomerReplies.mockImplementation(async (key: string) => {
      if (key === "SD-6") throw new IssueTrackerError("Jira request failed (500)", 500);
      return [];
    });
    expect(await watcher.check()).toEqual({ announced: 1, pending: 1 });
    expect(sent).toEqual(["**SD-7** Printer offline\nNow in progress."]);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { key: "SD-6", err: "IssueTrackerError", status: 500 });
  });

  it("marks a request pending when its channel config cannot be read", async () => {
    const channels = makeChannels();
    channels.get.mockRejectedValue(new Error("db down"));
    const { watcher, tracker, wire } = setup([watched()], { channels });
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "in_progress", T0)]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it("still counts the update as posted when storing the reference fails", async () => {
    const { watcher, tracker, requests } = setup([watched()]);
    requests.setLastMessage.mockRejectedValue(new Error("db down"));
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "in_progress", T0)]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(requests.updateStatusCategory).toHaveBeenCalled();
  });

  it("never logs reply text or summaries", async () => {
    const { watcher, tracker, requests, wire, logger } = setup([
      watched({ summary: `summary ${SECRET}` }), watched({ key: "SD-7", summary: `other ${SECRET}` }),
    ]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "done", T0), change("SD-7", "in_progress", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", `reply ${SECRET}`)]);
    tracker.getIssue.mockRejectedValue(new Error(SECRET));
    wire.sendPlainText.mockRejectedValue(new Error(SECRET));
    requests.advanceLastSeenReplyAt.mockRejectedValue(new Error(SECRET));
    await watcher.check();
    expect(logger.warn).toHaveBeenCalled();
    expect(loggedText(logger)).not.toContain(SECRET);
  });
});

describe("formatReplies heading", () => {
  it("leaves the status of answer unchanged", async () => {
    const tracker = makeTracker();
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-25T10:00:00Z", "Please restart the router.")]);
    const { wire, sent } = makeWire();
    await new GetIssueStatus(makeRequests(), tracker, wire, makeAudit(), makeLogger())
      .execute({ reference: "SD-6", conversationId: convId });
    expect(sent[0]).toBe([
      "**SD-6** VPN drops every ten minutes",
      "Status: In progress",
      "Time to first response: met in 3m (target 4h)",
      "Time to done: running, 15h left of 16h",
      "",
      "Latest reply on the ticket:",
      "",
      "**Dana**, 25 Sept, 10:00 UTC",
      "> Please restart the router.",
      "",
      "https://jira.test/browse/SD-6",
    ].join("\n"));
  });
});

describe("WatchSupportRequests: review guards", () => {
  it("baselines the status too on first sight, so an old resolve is not announced", async () => {
    const { watcher, tracker, sent, requests } = setup([makeRequest({ statusCategory: "todo" })]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "done", T0)]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(sent).toEqual([]);
    expect(requests.updateStatusCategory).toHaveBeenCalledWith("SD-6", "done", T0);
  });

  it("skips a request the bot is resolving from Wire and keeps it pending", async () => {
    const writes = new SupportRequestWrites();
    const { watcher, tracker, sent, requests } = setup([watched({ statusCategory: "in_progress" })], { guards: { writes } });
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "done", T0)]);
    let finish: () => void = () => {};
    const resolving = writes.during("SD-6", () => new Promise<void>((resolve) => { finish = resolve; }));
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(sent).toEqual([]);
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    finish();
    await resolving;
    expect(writes.has("SD-6")).toBe(false);
  });

  it("does not post when a resolve from Wire starts during the reads", async () => {
    const writes = new SupportRequestWrites();
    const { watcher, tracker, sent } = setup([watched({ statusCategory: "in_progress" })], { guards: { writes } });
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "done", T0)]);
    let finish: () => void = () => {};
    tracker.listCustomerReplies.mockImplementation(async () => {
      void writes.during("SD-6", () => new Promise<void>((resolve) => { finish = resolve; }));
      return [];
    });
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(sent).toEqual([]);
    finish();
  });

  it("uses the record as stored now, so a reply `status of` just showed is not announced again", async () => {
    const records = [watched()];
    const { watcher, tracker, requests, sent } = setup(records);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "todo", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", "Please restart the router.")]);
    // `status of` ran after the watch listed the request and moved the marker past the reply.
    requests.findByKey.mockResolvedValueOnce({ ...records[0]!, lastSeenReplyAt: new Date("2026-09-26T09:30:00Z") });
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(sent).toEqual([]);
  });
});

describe("WatchSupportRequests: conversations it cannot post to", () => {
  it("does not watch requests of a skipped conversation", async () => {
    const cli = { id: "cli-conv", domain: "cli.local" };
    const { watcher, tracker, sent } = setup([watched(), watched({ key: "SD-7", conversationId: cli })], {
      guards: { skipConversation: (c) => c.domain === "cli.local" },
    });
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "in_progress", T0), change("SD-7", "done", T0)]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(tracker.listChangedSince).toHaveBeenCalledWith(["SD-6"], undefined);
    expect(sent).toEqual(["**SD-6** VPN drops every ten minutes\nNow in progress."]);
  });

  it("gives up after ten failed sends, logging once", async () => {
    const { watcher, tracker, wire, logger } = setup([watched()]);
    wire.sendPlainText.mockRejectedValue(new Error("WireApiException"));
    tracker.listChangedSince.mockResolvedValueOnce([change("SD-6", "in_progress", T0)]).mockResolvedValue([]);
    for (let i = 0; i < 9; i++) expect((await watcher.check()).pending).toBe(1);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(wire.sendPlainText).toHaveBeenCalledTimes(10);
    const givingUp = logger.warn.mock.calls.filter(([msg]) => String(msg).includes("giving up"));
    expect(givingUp).toEqual([[expect.any(String), { key: "SD-6", attempts: 10 }]]);
    await watcher.check();
    expect(wire.sendPlainText).toHaveBeenCalledTimes(10);
  });

  it("resets the failure count after a successful send", async () => {
    const { watcher, tracker, wire, sent } = setup([watched()]);
    tracker.listChangedSince.mockResolvedValueOnce([change("SD-6", "in_progress", T0)]).mockResolvedValue([]);
    wire.sendPlainText.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
    await watcher.check();
    await watcher.check();
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(sent).toHaveLength(1);
  });
});

describe("WatchSupportRequests: direct conversation with the desk agent", () => {
  const AGENT = "jira-agent-1";
  const OTHER = "jira-agent-2";
  const NOTICE_REF = { messageId: "notice-1", sha256: "b".repeat(64) };
  const withAssignee = (key: string, statusCategory: IssueStatusCategory, updated: Date, assigneeAccountId?: string): IssueChange =>
    ({ ...change(key, statusCategory, updated), ...(assigneeAccountId ? { assigneeAccountId } : {}) });

  /** Guards with a mapped agent and a mocked use case; the records follow the bookkeeping writes. */
  function agentSetup(
    records: SupportRequest[],
    options: { channels?: ReturnType<typeof makeChannels>; now?: () => Date; assigneeUnseen?: boolean } = {},
  ) {
    // A watched record has had its assignee seen before, unless a test says otherwise.
    if (!options.assigneeUnseen) for (const r of records) if (r.lastSeenReplyAt && !r.assigneeSeenAt) r.assigneeSeenAt = SEEN;
    const open = {
      execute: vi.fn(async (input: OpenAgentConversationInput): Promise<OpenAgentConversationOutcome> => {
        const found = records.find((r) => r.key === input.request.key)!;
        found.agentConversationAt = T0;
        found.lastMessage = NOTICE_REF;
        return "opened";
      }),
    };
    const guards: WatchGuards = {
      agents: { handles: new Map([[AGENT, "kim.desk"]]), open: open as unknown as OpenAgentConversation },
    };
    const ctx = setup(records, { ...options, guards });
    ctx.requests.setAssignee.mockImplementation(async (key: string, accountId: string | null) => {
      const found = records.find((r) => r.key === key);
      if (found) {
        found.assigneeAccountId = accountId ?? undefined;
        found.assigneeSeenAt ??= T0;
      }
    });
    return { ...ctx, open };
  }

  it("writes no channel configuration when opening the conversation, even when leaving the group fails", async () => {
    const records = [watched({ assigneeSeenAt: SEEN })];
    const guards: WatchGuards = {};
    const ctx = setup(records, { guards });
    const conversations = {
      findUserByHandle: vi.fn().mockResolvedValue({ id: { id: "agent-1", domain: "example.com" }, name: "Kim Desk" }),
      createGroup: vi.fn().mockResolvedValue({ id: "group-1", domain: "example.com" }),
      makeAdmin: vi.fn().mockResolvedValue(undefined),
      leave: vi.fn().mockRejectedValue(new Error("still there")),
      track: vi.fn(),
    };
    const open = new OpenAgentConversation(ctx.requests, conversations, ctx.wire, ctx.audit, ctx.logger, () => T0, async () => undefined);
    guards.agents = { handles: new Map([[AGENT, "kim.desk"]]), open };
    ctx.tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "todo", T0, AGENT)]);
    await ctx.watcher.check();
    expect(conversations.createGroup).toHaveBeenCalledOnce();
    expect(conversations.leave).toHaveBeenCalledTimes(4);
    expect(ctx.requests.setAgentConversation).toHaveBeenCalledWith("SD-6", { id: "group-1", domain: "example.com" });
    expect(ctx.channels.upsert).not.toHaveBeenCalled();
    expect(ctx.channels.setTimezone).not.toHaveBeenCalled();
  });

  it("takes an assignee baseline for records from before the assignee was stored, even with replies seen", async () => {
    const { watcher, tracker, requests, open } = agentSetup([watched()], { assigneeUnseen: true });
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "todo", T0, AGENT)]);
    await watcher.check();
    expect(requests.setAssignee).toHaveBeenCalledWith("SD-6", AGENT);
    expect(open.execute).not.toHaveBeenCalled();
  });

  it("does not store the new assignee when a read fails, so the next check still opens", async () => {
    const { watcher, tracker, requests, open } = agentSetup([watched()]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "todo", T0, AGENT)]);
    tracker.listCustomerReplies.mockRejectedValueOnce(new Error("timeout"));
    await watcher.check();
    expect(requests.setAssignee).not.toHaveBeenCalled();
    await watcher.check();
    expect(open.execute).toHaveBeenCalledTimes(1);
    expect(requests.setAssignee).toHaveBeenCalledWith("SD-6", AGENT);
  });

  it("keeps the assignee unstored after a failed open and retries it", async () => {
    const { watcher, tracker, requests, open } = agentSetup([watched()]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "todo", T0, AGENT)]);
    open.execute.mockResolvedValueOnce("failed");
    expect((await watcher.check()).pending).toBe(1);
    expect(requests.setAssignee).not.toHaveBeenCalled();
    await watcher.check();
    expect(open.execute).toHaveBeenCalledTimes(2);
  });

  it("stores the assignee on first sight without opening anything", async () => {
    const { watcher, tracker, requests, open } = agentSetup([makeRequest()]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "todo", T0, AGENT)]);
    await watcher.check();
    expect(requests.setAssignee).toHaveBeenCalledWith("SD-6", AGENT);
    expect(open.execute).not.toHaveBeenCalled();
  });

  it("stores null on first sight when unassigned", async () => {
    const { watcher, tracker, requests, open } = agentSetup([makeRequest()]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "todo", T0)]);
    await watcher.check();
    expect(requests.setAssignee).toHaveBeenCalledWith("SD-6", null);
    expect(open.execute).not.toHaveBeenCalled();
  });

  it("opens once for a newly assigned mapped agent, before the other update, which quotes the notice", async () => {
    const t1 = new Date("2026-09-26T10:00:30Z");
    const { watcher, tracker, requests, wire, open } = agentSetup([watched()], { now: clock(T0, T0, t1) });
    tracker.listChangedSince.mockResolvedValueOnce([withAssignee("SD-6", "in_progress", T0, AGENT)]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(requests.setAssignee).toHaveBeenCalledWith("SD-6", AGENT);
    expect(open.execute).toHaveBeenCalledTimes(1);
    expect(open.execute).toHaveBeenCalledWith({ request: expect.objectContaining({ key: "SD-6" }), agentHandle: "kim.desk" });
    expect(open.execute.mock.invocationCallOrder[0]).toBeLessThan(wire.sendPlainText.mock.invocationCallOrder[0]);
    expect(wire.sendPlainText.mock.calls[0][2]).toEqual({ quote: NOTICE_REF });

    // Jira reports the issue again with the same assignee: nothing more is opened.
    tracker.listChangedSince.mockResolvedValueOnce([withAssignee("SD-6", "in_progress", t1, AGENT)]);
    await watcher.check();
    expect(open.execute).toHaveBeenCalledTimes(1);
  });

  it("opens for a mapped agent assigned to a request the bot raised before the watch's first check", async () => {
    // As RaiseSupportRequest stores it: replies and assignee seen at creation, nobody assigned.
    const raised = makeRequest({ lastSeenReplyAt: SEEN, assigneeSeenAt: SEEN, lastMessage: LAST_MESSAGE });
    const { watcher, tracker, requests, open } = agentSetup([raised], { assigneeUnseen: true });
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "in_progress", T0, AGENT)]);
    await watcher.check();
    expect(open.execute).toHaveBeenCalledTimes(1);
    expect(open.execute).toHaveBeenCalledWith({ request: expect.objectContaining({ key: "SD-6" }), agentHandle: "kim.desk" });
    expect(requests.setAssignee).toHaveBeenCalledWith("SD-6", AGENT);
  });

  it("opens when there is no status or reply update, posting nothing else", async () => {
    const { watcher, tracker, open, wire } = agentSetup([watched()]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "todo", T0, AGENT)]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(open.execute).toHaveBeenCalledTimes(1);
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it("only stores an unmapped assignee", async () => {
    const { watcher, tracker, requests, open } = agentSetup([watched()]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "todo", T0, OTHER)]);
    await watcher.check();
    expect(requests.setAssignee).toHaveBeenCalledWith("SD-6", OTHER);
    expect(open.execute).not.toHaveBeenCalled();
  });

  it("does not reopen for a request that already has a conversation, after a change of assignee", async () => {
    const { watcher, tracker, requests, open } = agentSetup([watched({ assigneeAccountId: OTHER, agentConversationAt: SEEN })]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "todo", T0, AGENT)]);
    await watcher.check();
    expect(requests.setAssignee).toHaveBeenCalledWith("SD-6", AGENT);
    expect(open.execute).not.toHaveBeenCalled();
  });

  it("does not open for an unchanged assignee", async () => {
    const { watcher, tracker, requests, open } = agentSetup([watched({ assigneeAccountId: AGENT })]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "in_progress", T0, AGENT)]);
    await watcher.check();
    expect(requests.setAssignee).not.toHaveBeenCalled();
    expect(open.execute).not.toHaveBeenCalled();
  });

  it("does not open for a request that is done", async () => {
    const { watcher, tracker, requests, open, sent } = agentSetup([watched()]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "done", T0, AGENT)]);
    await watcher.check();
    expect(tracker.getIssue).toHaveBeenCalledWith("SD-6");
    expect(requests.setAssignee).toHaveBeenCalledWith("SD-6", AGENT);
    expect(open.execute).not.toHaveBeenCalled();
    expect(sent[0]).toContain("Resolved by the service desk.");
  });

  it("does not open when the live read shows the request done although the change listed it open", async () => {
    const { watcher, tracker, open } = agentSetup([watched({ statusCategory: "in_progress" })]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "todo", T0, AGENT)]);
    tracker.getIssue.mockResolvedValue(makeSnapshot({ statusCategory: "done" }));
    await watcher.check();
    expect(open.execute).not.toHaveBeenCalled();
  });

  it("stores a cleared assignee as null without opening", async () => {
    const { watcher, tracker, requests, open } = agentSetup([watched({ assigneeAccountId: AGENT })]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "todo", T0)]);
    await watcher.check();
    expect(requests.setAssignee).toHaveBeenCalledWith("SD-6", null);
    expect(open.execute).not.toHaveBeenCalled();
  });

  it("still posts the status and reply update when opening throws", async () => {
    const { watcher, tracker, open, sent, logger, requests, wire } = agentSetup([watched()]);
    open.execute.mockRejectedValue(new Error("boom"));
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "in_progress", T0, AGENT)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", "Looking into it.")]);
    // The update is posted; the request stays pending so opening is retried at the next check.
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Now in progress.");
    expect(sent[0]).toContain("Looking into it.");
    expect(wire.sendPlainText.mock.calls[0][2]).toEqual({ quote: LAST_MESSAGE });
    expect(requests.updateStatusCategory).toHaveBeenCalledWith("SD-6", "in_progress", T0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("agent conversation"), { key: "SD-6", err: "Error" });
  });

  it("carries on when storing the assignee fails", async () => {
    const { watcher, tracker, requests, open, sent, logger } = agentSetup([watched()]);
    requests.setAssignee.mockRejectedValue(new Error("db down"));
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "in_progress", T0, AGENT)]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(open.execute).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("setAssignee"), { key: "SD-6", err: "Error" });
  });

  it("stores the assignee without the agents setting", async () => {
    const { watcher, tracker, requests } = setup([watched()]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "todo", T0, AGENT)]);
    await watcher.check();
    expect(requests.setAssignee).toHaveBeenCalledWith("SD-6", AGENT);
  });
});

describe("WatchSupportRequests: the agent conversation as an opt-in (ask)", () => {
  const AGENT = "jira-agent-1";
  const HOURS_4 = 4 * 60 * 60 * 1000;
  const QUESTION = "Alice, the service desk assigned Kim Desk to **SD-6**. Would you like a direct conversation with them?";
  const withAssignee = (key: string, statusCategory: IssueStatusCategory, updated: Date, assigneeAccountId?: string): IssueChange =>
    ({ ...change(key, statusCategory, updated), ...(assigneeAccountId ? { assigneeAccountId } : {}) });

  /** The watch in ask mode with the real question over a real offer store; the open flow is mocked. */
  function askSetup(records: SupportRequest[], options: { now?: () => Date } = {}) {
    for (const r of records) if (r.lastSeenReplyAt && !r.assigneeSeenAt) r.assigneeSeenAt = SEEN;
    const offers = new InMemoryPendingOfferStore();
    const guards: WatchGuards = {};
    const env = setup(records, { guards, ...options });
    const now = options.now ?? (() => T0);
    const open = { execute: vi.fn(async (): Promise<OpenAgentConversationOutcome> => "opened") };
    const conversations = {
      findUserByHandle: vi.fn(async () => ({ id: { id: "agent-1", domain: "example.com" }, name: "Kim Desk" })),
      createGroup: vi.fn(), makeAdmin: vi.fn(), leave: vi.fn(), track: vi.fn(),
    };
    env.requests.markAgentConversation.mockImplementation(async (key: string, at: Date) => {
      const found = records.find((r) => r.key === key)!;
      if (found.agentConversationAt) return false;
      found.agentConversationAt = at;
      return true;
    });
    env.requests.setAssignee.mockImplementation(async (key: string, accountId: string | null) => {
      const found = records.find((r) => r.key === key);
      if (found) found.assigneeAccountId = accountId ?? undefined;
    });
    // The records follow the stored category and replies, as the database would.
    env.requests.updateStatusCategory.mockImplementation(async (key: string, statusCategory: SupportRequest["statusCategory"], updatedAt: Date) => {
      const found = records.find((r) => r.key === key)!;
      Object.assign(found, { statusCategory, updatedAt, version: found.version + 1 });
      return { ...found };
    });
    env.requests.advanceLastSeenReplyAt.mockImplementation(async (key: string, at: Date) => {
      records.find((r) => r.key === key)!.lastSeenReplyAt = at;
    });
    const ask = new AskForAgentConversation({
      requests: env.requests, conversations, offers, wireOutbound: env.wire, open: open as unknown as OpenAgentConversation,
      projectKey: "SD", lifetimeMs: HOURS_4, logger: env.logger, now,
    });
    guards.agents = { handles: new Map([[AGENT, "kim.desk"]]), open: open as unknown as OpenAgentConversation, ask };
    guards.questions = new DeskUpdateQuestions({ offers, wireOutbound: env.wire, lifetimeMs: HOURS_4, logger: env.logger, now });
    const labels = (): string[][] => env.wire.sendCompositePrompt.mock.calls.map((call) => (call[2] as Array<{ label: string }>).map((b) => b.label));
    return { ...env, offers, open, ask, labels, conversations };
  }

  it("asks the requester instead of opening the group, once, and stores the assignee", async () => {
    const t1 = new Date("2026-09-26T10:00:30Z");
    const { watcher, tracker, requests, sent, labels, open, offers } = askSetup([watched()], { now: clock(T0, T0, t1) });
    tracker.listChangedSince.mockResolvedValueOnce([withAssignee("SD-6", "todo", T0, AGENT)]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(open.execute).not.toHaveBeenCalled();
    expect(sent).toEqual([QUESTION]);
    expect(labels()).toEqual([["Open direct chat", "Not now"]]);
    expect(requests.markAgentConversation).toHaveBeenCalledOnce();
    expect(requests.setAssignee).toHaveBeenCalledWith("SD-6", AGENT);
    expect(offers.find(convId, alice, T0)).toMatchObject({ keepsSlot: true, deskUpdate: { issueKey: "SD-6" } });

    tracker.listChangedSince.mockResolvedValueOnce([withAssignee("SD-6", "todo", t1, AGENT)]);
    await watcher.check();
    expect(labels()).toHaveLength(1);
  });

  it("asks after the request's other update, which still quotes the last message, and asks no desk-update question then", async () => {
    const { watcher, tracker, wire, sent, labels } = askSetup([watched()]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "in_progress", T0, AGENT)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", "I'm on it.")]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(sent[0]).toContain("Now in progress.");
    expect(wire.sendPlainText.mock.calls[0][2]).toEqual({ quote: LAST_MESSAGE });
    expect(sent[1]).toBe(QUESTION);
    expect(wire.sendPlainText.mock.invocationCallOrder[0]).toBeLessThan(wire.sendCompositePrompt.mock.invocationCallOrder[0]);
    expect(labels()).toEqual([["Open direct chat", "Not now"]]);
  });

  it("keeps the agent question when a later desk reply comes in", async () => {
    const t1 = new Date("2026-09-26T10:00:30Z");
    const { watcher, tracker, labels, offers, wire } = askSetup([watched()], { now: clock(T0, T0, t1) });
    tracker.listChangedSince.mockResolvedValueOnce([withAssignee("SD-6", "todo", T0, AGENT)]);
    await watcher.check();
    tracker.listChangedSince.mockResolvedValueOnce([withAssignee("SD-6", "todo", t1, AGENT)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T10:00:10Z", "Please restart the router.")]);
    expect((await watcher.check()).announced).toBe(1);
    expect(labels()).toHaveLength(1);
    expect(wire.closeButtonPrompt).not.toHaveBeenCalled();
    expect(offers.find(convId, alice, T0)).toMatchObject({ keepsSlot: true });
  });

  it("waits while the requester has another open question and asks at the next check once it is answered", async () => {
    const { watcher, tracker, requests, offers, labels } = askSetup([watched()]);
    offers.put({
      command: { kind: "resolve", issueKey: "SD-7" }, conversationId: convId, requesterId: alice,
      createdAt: T0, expiresAt: new Date(T0.getTime() + 10 * 60 * 1000),
    });
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "todo", T0, AGENT)]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(labels()).toEqual([]);
    expect(requests.setAssignee).not.toHaveBeenCalled();
    expect(requests.markAgentConversation).not.toHaveBeenCalled();

    // Still busy: still waiting.
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    offers.take(convId, alice, T0);
    tracker.listChangedSince.mockResolvedValue([]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(labels()).toEqual([["Open direct chat", "Not now"]]);
    expect(requests.setAssignee).toHaveBeenCalledWith("SD-6", AGENT);
  });

  it("posts the update while waiting, without posting it again at the next check", async () => {
    const { watcher, tracker, offers, sent } = askSetup([watched()]);
    offers.put({
      command: { kind: "resolve", issueKey: "SD-7" }, conversationId: convId, requesterId: alice,
      createdAt: T0, expiresAt: new Date(T0.getTime() + 10 * 60 * 1000),
    });
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "in_progress", T0, AGENT)]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Now in progress.");
    await watcher.check();
    expect(sent).toHaveLength(1);
  });

  it("gives up after the question's lifetime of waiting, storing the assignee and asking nothing later", async () => {
    const later = new Date(T0.getTime() + HOURS_4);
    let now = T0;
    const { watcher, tracker, requests, offers, labels, logger } = askSetup([watched()], { now: () => now });
    offers.put({
      command: { kind: "resolve", issueKey: "SD-7" }, conversationId: convId, requesterId: alice,
      createdAt: T0, expiresAt: new Date(T0.getTime() + 2 * HOURS_4),
    });
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "todo", T0, AGENT)]);
    expect((await watcher.check()).pending).toBe(1);
    now = later;
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(requests.setAssignee).toHaveBeenCalledWith("SD-6", AGENT);
    expect(requests.markAgentConversation).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("stayed busy"), { key: "SD-6" });
    offers.take(convId, alice, later);
    await watcher.check();
    expect(labels()).toEqual([]);
  });

  it("retries a failed question at the next check", async () => {
    const { watcher, tracker, requests, wire, labels } = askSetup([watched()]);
    wire.sendCompositePrompt.mockRejectedValueOnce(new Error("offline"));
    tracker.listChangedSince.mockResolvedValue([withAssignee("SD-6", "todo", T0, AGENT)]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(requests.setAssignee).not.toHaveBeenCalled();
    await watcher.check();
    expect(labels()).toHaveLength(2);
    expect(requests.setAssignee).toHaveBeenCalledWith("SD-6", AGENT);
  });

  it("keeps the trigger rules: no question at the assignee baseline, for a done request, an unmapped agent or a request already handled", async () => {
    const cases: Array<[SupportRequest, IssueChange]> = [
      [makeRequest(), withAssignee("SD-6", "todo", T0, AGENT)],
      [watched(), withAssignee("SD-6", "done", T0, AGENT)],
      [watched(), withAssignee("SD-6", "todo", T0, "jira-agent-2")],
      [watched({ agentConversationAt: SEEN }), withAssignee("SD-6", "todo", T0, AGENT)],
      [watched({ assigneeAccountId: AGENT }), withAssignee("SD-6", "todo", T0, AGENT)],
    ];
    for (const [record, listed] of cases) {
      const { watcher, tracker, wire, open, conversations } = askSetup([record]);
      tracker.listChangedSince.mockResolvedValue([listed]);
      await watcher.check();
      expect(conversations.findUserByHandle).not.toHaveBeenCalled();
      expect(wire.sendCompositePrompt.mock.calls.filter((call) => (call[1] as string).includes("direct conversation"))).toEqual([]);
      expect(open.execute).not.toHaveBeenCalled();
    }
  });
});

describe("WatchSupportRequests: questions after a desk update", () => {
  const HOURS_4 = 4 * 60 * 60 * 1000;

  /** The watch with real desk-update questions over a real offer store, sharing the Wire mock. */
  function withQuestions(records: SupportRequest[]) {
    const offers = new InMemoryPendingOfferStore();
    // The guards need the questions before the watch exists, and the questions need the watch's Wire mock.
    const guards: WatchGuards = {};
    const env = setup(records, { guards });
    guards.questions = new DeskUpdateQuestions({ offers, wireOutbound: env.wire, lifetimeMs: HOURS_4, logger: env.logger, now: () => T0 });
    const labels = (): string[][] => env.wire.sendCompositePrompt.mock.calls.map((call) => (call[2] as Array<{ label: string }>).map((b) => b.label));
    return { ...env, offers, labels };
  }

  it("asks the requester [Reply] [Solved, close it] after a desk reply, in a separate message that is not the last message", async () => {
    const { watcher, tracker, requests, wire, sent, offers, labels } = withQuestions([watched()]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "todo", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", "Please restart the router.")]);

    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });

    // The update is posted as before: quoted, and stored as the request's last message.
    expect(wire.sendPlainText).toHaveBeenCalledOnce();
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { quote: LAST_MESSAGE });
    expect(requests.setLastMessage).toHaveBeenCalledOnce();
    expect(requests.setLastMessage).toHaveBeenCalledWith("SD-6", sentRefFor(1));
    // The question follows separately, unquoted, and is never stored as the last message.
    expect(sent[1]).toBe("Alice, would you like to reply to the service desk about **SD-6**, or is it solved so I can close it?");
    expect(labels()).toEqual([["Reply", "Solved, close it"]]);
    expect(offers.find(convId, alice, T0)).toMatchObject({ messageId: sentRefFor(2).messageId, deskUpdate: { issueKey: "SD-6" } });
    // Nothing is written to Jira by asking.
    expect(tracker.addCustomerReply).not.toHaveBeenCalled();
    expect(tracker.resolveIssue).not.toHaveBeenCalled();
  });

  it("asks [Solved] [Still broken] after the desk resolved the request", async () => {
    const { watcher, tracker, requests, sent, labels } = withQuestions([watched({ statusCategory: "in_progress" })]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "done", T0)]);

    await watcher.check();

    expect(sent[0]).toContain("Resolved by the service desk.");
    expect(sent[1]).toBe("Alice, is **SD-6** solved for you, or is it still broken?");
    expect(labels()).toEqual([["Solved", "Still broken"]]);
    expect(requests.setLastMessage).toHaveBeenCalledOnce();
    expect(requests.setLastMessage).toHaveBeenCalledWith("SD-6", sentRefFor(1));
  });

  it("asks [Solved] [Still broken] when a resolve and a reply come in one update, and after a reply on a resolved request", async () => {
    const both = withQuestions([watched({ statusCategory: "in_progress" })]);
    both.tracker.listChangedSince.mockResolvedValue([change("SD-6", "done", T0)]);
    both.tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:50:00Z", "Fixed the tunnel.")]);
    await both.watcher.check();
    expect(both.labels()).toEqual([["Solved", "Still broken"]]);

    const resolved = withQuestions([watched({ statusCategory: "done" })]);
    resolved.tracker.listChangedSince.mockResolvedValue([change("SD-6", "done", T0)]);
    resolved.tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:50:00Z", "One more note.")]);
    await resolved.watcher.check();
    expect(resolved.labels()).toEqual([["Solved", "Still broken"]]);
  });

  it.each([
    ["todo", "in_progress"],
    ["in_progress", "todo"],
    ["done", "todo"],
    ["done", "in_progress"],
  ] as const)("asks nothing for a status change from %s to %s without a reply", async (from, to) => {
    const { watcher, tracker, sent, wire } = withQuestions([watched({ statusCategory: from })]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", to, T0)]);
    await watcher.check();
    expect(sent).toHaveLength(1);
    expect(wire.sendCompositePrompt).not.toHaveBeenCalled();
  });

  it("asks nothing at a baseline, and nothing when the update could not be posted", async () => {
    const baseline = withQuestions([makeRequest()]);
    baseline.tracker.listChangedSince.mockResolvedValue([change("SD-6", "done", T0)]);
    baseline.tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", "old")]);
    await baseline.watcher.check();
    expect(baseline.wire.sendCompositePrompt).not.toHaveBeenCalled();

    const failing = withQuestions([watched()]);
    failing.tracker.listChangedSince.mockResolvedValue([change("SD-6", "todo", T0)]);
    failing.tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", "Please restart the router.")]);
    failing.wire.sendPlainText.mockRejectedValueOnce(new Error("offline"));
    expect(await failing.watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(failing.wire.sendCompositePrompt).not.toHaveBeenCalled();
  });

  it("still counts the update as announced when the question cannot be sent", async () => {
    const { watcher, tracker, wire, offers, logger } = withQuestions([watched()]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "todo", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", "Please restart the router.")]);
    wire.sendCompositePrompt.mockRejectedValueOnce(new Error("offline"));
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(offers.find(convId, alice, T0)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith("DeskUpdateQuestions: sending the question failed", { key: "SD-6", err: "Error" });
  });

  it("does not ask over the requester's open question", async () => {
    const { watcher, tracker, wire, offers } = withQuestions([watched()]);
    const open = {
      command: { kind: "resolve" as const, issueKey: "SD-7" }, conversationId: convId, requesterId: alice,
      createdAt: T0, expiresAt: new Date(T0.getTime() + 10 * 60 * 1000),
    };
    offers.put(open);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "todo", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", "Please restart the router.")]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(wire.sendCompositePrompt).not.toHaveBeenCalled();
    expect(offers.find(convId, alice, T0)).toEqual(open);
  });

  it("closes an unanswered question when it expires", async () => {
    const { watcher, tracker, wire, sent, offers } = withQuestions([watched()]);
    tracker.listChangedSince.mockResolvedValue([change("SD-6", "todo", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", "Please restart the router.")]);
    await watcher.check();
    await sweepEndedOfferPrompts({ offers, wireOutbound: wire }, new Date(T0.getTime() + HOURS_4));
    expect(wire.closeButtonPrompt).toHaveBeenCalledWith(convId, sentRefFor(2).messageId, `${sent[1]}\n\nThis question has expired.`);
  });
});
