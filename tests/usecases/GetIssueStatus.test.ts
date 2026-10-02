import { describe, it, expect } from "vitest";
import { GetIssueStatus } from "../../src/application/usecases/jira/GetIssueStatus";
import { formatIssueStatus, formatReplies, formatResolution, formatSla, statusLabel } from "../../src/application/usecases/jira/formatIssue";
import type { IssueSnapshot } from "../../src/application/ports/IssueTrackerPort";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import { OUT_OF_SCOPE, convId, makeAudit, makeLogger, makeRequest, makeRequests, makeSnapshot, makeTracker, makeWire, sentRefFor } from "./supportRequestFakes";

const snapshot = makeSnapshot();

function setup(records: SupportRequest[] = [makeRequest()]) {
  const requests = makeRequests(records);
  const tracker = makeTracker();
  const { wire, sent } = makeWire();
  const audit = makeAudit();
  const logger = makeLogger();
  const useCase = new GetIssueStatus(requests, tracker, wire, audit, logger);
  return { requests, tracker, wire, sent, audit, logger, useCase };
}

describe("GetIssueStatus", () => {
  it("reads a support request of this conversation and replies once", async () => {
    const { tracker, wire, sent, useCase } = setup();

    const result = await useCase.execute({ reference: "sd-6", conversationId: convId, replyToMessageId: "msg-1" });

    expect(result).toEqual(snapshot);
    expect(tracker.getIssue).toHaveBeenCalledWith("SD-6");
    expect(sent).toEqual([formatIssueStatus(snapshot, "No replies from the service desk yet.")]);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-1" });
  });

  it("stores and audits a changed status category", async () => {
    const { requests, audit, useCase } = setup();

    await useCase.execute({ reference: "SD-6", conversationId: convId });

    expect(requests.updateStatusCategory).toHaveBeenCalledWith("SD-6", "in_progress", expect.any(Date));
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      actorId: { id: "wire-support-bot", domain: "example.com" }, conversationId: convId,
      action: "entity_updated", entityType: "SupportRequest", entityId: "SD-6", details: { statusCategory: "in_progress" },
    }));
  });

  it("writes nothing when the status category is unchanged", async () => {
    const { requests, audit, useCase } = setup([makeRequest({ statusCategory: "in_progress" })]);

    await useCase.execute({ reference: "SD-6", conversationId: convId });

    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("still replies when the status refresh fails", async () => {
    const { requests, sent, logger, useCase } = setup();
    requests.updateStatusCategory.mockRejectedValue(new Error("db down"));

    expect(await useCase.execute({ reference: "SD-6", conversationId: convId })).toEqual(snapshot);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Status: In progress");
    expect(logger.warn).toHaveBeenCalledWith("Support request status refresh failed", { key: "SD-6", err: "Error" });
  });

  it("shows the three latest customer replies in the conversation's timezone", async () => {
    const replies = [
      { author: "Dana Agent", created: new Date("2026-09-25T14:55:00Z"), body: "We have reset your VPN profile.\nPlease try again." },
    ];
    const { tracker, sent, useCase } = setup();
    tracker.listCustomerReplies.mockResolvedValue(replies);

    await useCase.execute({ reference: "SD-6", conversationId: convId, timezone: "Europe/Berlin" });

    expect(tracker.listCustomerReplies).toHaveBeenCalledWith("SD-6", 3);
    expect(sent[0]).toContain([
      "Latest reply on the ticket:",
      "",
      "**Dana Agent**, 25 Sept, 16:55 CEST",
      "> We have reset your VPN profile.",
      "> Please try again.",
    ].join("\n"));
    expect(sent[0]!.endsWith(snapshot.url)).toBe(true);
  });

  it("keeps the status and says so when the replies cannot be read", async () => {
    const { tracker, sent, logger, useCase } = setup();
    tracker.listCustomerReplies.mockRejectedValue(new Error("SECRET-REPLY-BODY"));

    await useCase.execute({ reference: "SD-6", conversationId: convId });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Status: In progress");
    expect(sent[0]).toContain("I'm afraid I couldn't load the replies from Jira just now.");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("SECRET-REPLY-BODY");
  });

  it.each(OUT_OF_SCOPE)("refuses a key %s with the scope wording, without calling the tracker", async (_label, records, key) => {
    const { tracker, sent, audit, useCase } = setup(records);

    expect(await useCase.execute({ reference: key, conversationId: convId })).toBeNull();

    expect(sent).toEqual([`I'm afraid **${key}** isn't a support request in this conversation.`]);
    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(tracker.listCustomerReplies).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("exposes the configured project key for command matching", () => {
    expect(setup().useCase.projectKey).toBe("SD");
  });

  it("reports a ticket Jira cannot find without refreshing", async () => {
    const { tracker, requests, sent, useCase } = setup();
    tracker.getIssue.mockResolvedValue(null);

    expect(await useCase.execute({ reference: "SD-6", conversationId: convId })).toBeNull();

    expect(sent).toEqual(["I'm afraid I couldn't find **SD-6** in Jira."]);
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
  });

  it("reports an unreachable tracker", async () => {
    const { tracker, sent, logger, useCase } = setup();
    tracker.getIssue.mockRejectedValue(new Error("timeout"));

    expect(await useCase.execute({ reference: "SD-6", conversationId: convId })).toBeNull();

    expect(sent).toEqual(["I'm afraid I couldn't reach Jira just now."]);
    expect(logger.warn).toHaveBeenCalledWith("GetIssueStatus: getIssue failed", { err: "Error" });
  });
});

describe("GetIssueStatus: watch markers", () => {
  const replies = [
    { author: "Dana Agent", created: new Date("2026-09-25T14:55:00Z"), body: "We have reset your VPN profile." },
    { author: "Lee Agent", created: new Date("2026-09-25T16:10:00Z"), body: "Any better?" },
    { author: "Bot", created: new Date("2026-09-25T15:30:00Z"), body: "Still drops.\n\nSent from Wire.", fromThisBot: true },
  ];

  it("stores the reference of the status answer as the request's last message", async () => {
    const { requests, useCase } = setup();

    await useCase.execute({ reference: "sd-6", conversationId: convId });

    expect(requests.setLastMessage).toHaveBeenCalledTimes(1);
    expect(requests.setLastMessage).toHaveBeenCalledWith("SD-6", sentRefFor(1));
  });

  it("marks the newest reply shown as seen, whoever wrote it", async () => {
    const { requests, tracker, useCase } = setup();
    tracker.listCustomerReplies.mockResolvedValue(replies);

    await useCase.execute({ reference: "SD-6", conversationId: convId });

    expect(requests.advanceLastSeenReplyAt).toHaveBeenCalledTimes(1);
    expect(requests.advanceLastSeenReplyAt).toHaveBeenCalledWith("SD-6", new Date("2026-09-25T16:10:00Z"));
  });

  it("does not advance the marker when no reply was shown or the replies could not be read", async () => {
    const none = setup();
    await none.useCase.execute({ reference: "SD-6", conversationId: convId });
    expect(none.requests.advanceLastSeenReplyAt).not.toHaveBeenCalled();

    const failed = setup();
    failed.tracker.listCustomerReplies.mockRejectedValue(new Error("timeout"));
    await failed.useCase.execute({ reference: "SD-6", conversationId: convId });
    expect(failed.requests.advanceLastSeenReplyAt).not.toHaveBeenCalled();
    // The status answer still names the request.
    expect(failed.requests.setLastMessage).toHaveBeenCalledWith("SD-6", sentRefFor(1));
  });

  it("stores the reference of the not-found reply, which names this conversation's request", async () => {
    const { requests, tracker, useCase } = setup();
    tracker.getIssue.mockResolvedValue(null);

    await useCase.execute({ reference: "SD-6", conversationId: convId });

    expect(requests.setLastMessage).toHaveBeenCalledWith("SD-6", sentRefFor(1));
    expect(requests.advanceLastSeenReplyAt).not.toHaveBeenCalled();
  });

  it("stores nothing when the tracker is unreachable, since the reply does not name the request", async () => {
    const { requests, tracker, useCase } = setup();
    tracker.getIssue.mockRejectedValue(new Error("timeout"));

    await useCase.execute({ reference: "SD-6", conversationId: convId });

    expect(requests.setLastMessage).not.toHaveBeenCalled();
    expect(requests.advanceLastSeenReplyAt).not.toHaveBeenCalled();
  });

  it.each(OUT_OF_SCOPE)("stores nothing for a key %s", async (_label, records, key) => {
    const { requests, useCase } = setup(records);

    await useCase.execute({ reference: key, conversationId: convId });

    expect(requests.setLastMessage).not.toHaveBeenCalled();
    expect(requests.advanceLastSeenReplyAt).not.toHaveBeenCalled();
  });

  it("stores no reference when the transport returns none, but still marks the replies seen", async () => {
    const { requests, tracker, wire, useCase } = setup();
    wire.sendPlainText.mockResolvedValueOnce(undefined);
    tracker.listCustomerReplies.mockResolvedValue(replies);

    await useCase.execute({ reference: "SD-6", conversationId: convId });

    expect(requests.setLastMessage).not.toHaveBeenCalled();
    expect(requests.advanceLastSeenReplyAt).toHaveBeenCalledWith("SD-6", new Date("2026-09-25T16:10:00Z"));
  });

  it("keeps the answer and the result when both marker writes fail, logging error names only", async () => {
    const { requests, tracker, sent, logger, useCase } = setup();
    tracker.listCustomerReplies.mockResolvedValue(replies);
    requests.setLastMessage.mockRejectedValueOnce(new Error("SECRET-DB-DETAIL"));
    requests.advanceLastSeenReplyAt.mockRejectedValueOnce(new TypeError("SECRET-DB-DETAIL"));

    expect(await useCase.execute({ reference: "SD-6", conversationId: convId })).toEqual(snapshot);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Latest replies on the ticket:");
    expect(logger.warn).toHaveBeenCalledWith("GetIssueStatus: storing the last message failed", { key: "SD-6", err: "Error" });
    expect(logger.warn).toHaveBeenCalledWith("GetIssueStatus: advancing the last seen reply failed", { key: "SD-6", err: "TypeError" });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("SECRET-DB-DETAIL");
  });
});

describe("formatIssue", () => {
  it("formats replies oldest first, cuts long ones visibly and falls back to UTC for a bad timezone", () => {
    const text = formatReplies([
      { author: "Dana", created: new Date("2026-09-25T09:00:00Z"), body: "First" },
      { author: "Lee", created: new Date("2026-09-25T10:00:00Z"), body: "x".repeat(600) },
    ], "Not/AZone");
    expect(text.startsWith("Latest replies on the ticket:\n\n**Dana**, 25 Sept, 09:00 UTC\n> First\n\n**Lee**, 25 Sept, 10:00 UTC\n> ")).toBe(true);
    expect(text.endsWith(`${"x".repeat(497)}...`)).toBe(true);
  });

  it("says when there are no replies yet", () => {
    expect(formatReplies([], "UTC")).toBe("No replies from the service desk yet.");
  });

  it("says 'under a minute' instead of Jira's rounded 0m", () => {
    expect(formatSla({ name: "Time to done", state: "met", elapsed: "0m", goal: "16h" })).toBe("Time to done: met in under a minute (target 16h)");
    expect(formatSla({ name: "Time to done", state: "met", elapsed: "3m", goal: "16h" })).toBe("Time to done: met in 3m (target 16h)");
  });

  it("labels status categories in English", () => {
    expect(statusLabel("todo")).toBe("To do");
    expect(statusLabel("in_progress")).toBe("In progress");
    expect(statusLabel("done")).toBe("Done");
  });

  it.each([
    [{ name: "TTD", state: "met", elapsed: "3m", goal: "16h" }, "TTD: met in 3m (target 16h)"],
    [{ name: "TTD", state: "met", goal: "16h" }, "TTD: met (target 16h)"],
    [{ name: "TTD", state: "met", elapsed: "3m" }, "TTD: met in 3m"],
    [{ name: "TTD", state: "met" }, "TTD: met"],
    [{ name: "TTD", state: "breached", goal: "16h" }, "TTD: breached (target 16h)"],
    [{ name: "TTD", state: "breached" }, "TTD: breached"],
    [{ name: "TTD", state: "running", remaining: "15h", goal: "16h" }, "TTD: running, 15h left of 16h"],
    [{ name: "TTD", state: "running", remaining: "15h" }, "TTD: running, 15h left"],
    [{ name: "TTD", state: "running", goal: "16h" }, "TTD: running (target 16h)"],
    [{ name: "TTD", state: "running" }, "TTD: running"],
    [{ name: "TTD", state: "paused", remaining: "15h", goal: "16h" }, "TTD: paused"],
  ] as const)("formats SLA %j", (sla, expected) => {
    const line = formatSla(sla);
    expect(line).toBe(expected);
    expect(line).not.toContain("undefined");
  });

  it("formats an issue status without the tracker's localized status name", () => {
    expect(formatIssueStatus(snapshot)).toBe([
      "**SD-6** VPN drops every ten minutes",
      "Status: In progress",
      "Time to first response: met in 3m (target 4h)",
      "Time to done: running, 15h left of 16h",
      "https://jira.test/browse/SD-6",
    ].join("\n"));
  });

  it("formats a successful resolution with its SLA outcome", () => {
    const done: IssueSnapshot = { ...snapshot, statusCategory: "done", slas: [{ name: "Time to done", state: "met", elapsed: "3m", goal: "16h" }] };
    expect(formatResolution(done)).toBe("Resolved **SD-6** with the service desk.\nTime to done: met in 3m (target 16h)");
  });

  it("reports the actual state when Done was not reached", () => {
    expect(formatResolution(snapshot)).toBe("I'm afraid I couldn't resolve **SD-6** with the service desk; it is now In progress.");
  });
});

