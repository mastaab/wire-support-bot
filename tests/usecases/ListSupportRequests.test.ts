import { describe, it, expect } from "vitest";
import { ListSupportRequests } from "../../src/application/usecases/jira/ListSupportRequests";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import { IssueTrackerError } from "../../src/application/ports/IssueTrackerPort";
import { alice, bob, convId, makeAudit, makeLogger, makeRequest, makeRequests, makeSnapshot, makeTracker, makeWire } from "./supportRequestFakes";

function setup(records: SupportRequest[]) {
  const requests = makeRequests(records);
  const tracker = makeTracker();
  const { wire, sent } = makeWire();
  const audit = makeAudit();
  const logger = makeLogger();
  const useCase = new ListSupportRequests(requests, tracker, wire, audit, logger);
  return { requests, tracker, wire, sent, audit, logger, useCase };
}

const vpn = makeRequest();
const printer = makeRequest({ key: "SD-7", summary: "Printer is jammed", requesterId: bob, requesterName: "Bob", statusCategory: "in_progress" });

describe("ListSupportRequests", () => {
  it("lists the open requests of the channel with key, summary, requester and live status", async () => {
    const { requests, tracker, wire, sent, useCase } = setup([vpn, printer]);
    tracker.getIssue.mockImplementation(async (key: string) => makeSnapshot({ key, statusCategory: key === "SD-6" ? "todo" : "in_progress" }));

    const shown = await useCase.execute({ conversationId: convId, replyToMessageId: "msg-1" });

    expect(requests.listByConversation).toHaveBeenCalledWith(convId, { requesterId: undefined, limit: 10 });
    expect(shown.map((r) => r.key)).toEqual(["SD-6", "SD-7"]);
    expect(sent).toEqual([[
      "Open support requests in this channel:",
      "- Fault **SD-6** VPN drops every ten minutes (Alice): To do",
      "- Fault **SD-7** Printer is jammed (Bob): In progress",
    ].join("\n")]);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-1" });
  });

  it("lists only the caller's requests for 'my support requests'", async () => {
    const { requests, sent, useCase } = setup([vpn]);

    await useCase.execute({ conversationId: convId, requesterId: alice });

    expect(requests.listByConversation).toHaveBeenCalledWith(convId, { requesterId: alice, limit: 10 });
    expect(sent[0]!.startsWith("Your open support requests in this channel:\n")).toBe(true);
  });

  it("omits the requester when no name was resolved", async () => {
    const { sent, useCase } = setup([makeRequest({ requesterName: "" })]);

    await useCase.execute({ conversationId: convId });

    expect(sent[0]).toContain("- Fault **SD-6** VPN drops every ten minutes: In progress");
  });

  it("refreshes a changed status, leaves out a request found done live and audits only changes", async () => {
    const { requests, tracker, sent, audit, useCase } = setup([vpn, printer]);
    tracker.getIssue.mockImplementation(async (key: string) => makeSnapshot({ key, statusCategory: key === "SD-6" ? "done" : "in_progress" }));

    const shown = await useCase.execute({ conversationId: convId });

    expect(shown.map((r) => r.key)).toEqual(["SD-7"]);
    expect(sent).toEqual(["Open support requests in this channel:\n- Fault **SD-7** Printer is jammed (Bob): In progress"]);
    expect(requests.updateStatusCategory).toHaveBeenCalledTimes(1);
    expect(requests.updateStatusCategory).toHaveBeenCalledWith("SD-6", "done", expect.any(Date));
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: "entity_updated", entityType: "SupportRequest", entityId: "SD-6", details: { statusCategory: "done" },
    }));
  });

  it("shows the last known status, marked as such, when a read fails or the ticket is gone", async () => {
    const { requests, tracker, sent, logger, useCase } = setup([vpn, printer]);
    tracker.getIssue.mockImplementation(async (key: string) => {
      if (key === "SD-6") throw new IssueTrackerError("unavailable", 503);
      return null;
    });

    const shown = await useCase.execute({ conversationId: convId });

    expect(shown).toHaveLength(2);
    expect(sent).toEqual([[
      "Open support requests in this channel:",
      "- Fault **SD-6** VPN drops every ten minutes (Alice): To do (last known)",
      "- Fault **SD-7** Printer is jammed (Bob): In progress (last known)",
    ].join("\n")]);
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("ListSupportRequests: getIssue failed", { key: "SD-6", err: "IssueTrackerError", status: 503 });
  });

  it("shows a request the desk reopened and refreshes its stored category", async () => {
    const { requests, tracker, sent, audit, useCase } = setup([makeRequest({ statusCategory: "done" })]);
    tracker.getIssue.mockResolvedValue(makeSnapshot({ statusCategory: "in_progress" }));

    const shown = await useCase.execute({ conversationId: convId });

    expect(shown.map((r) => r.key)).toEqual(["SD-6"]);
    expect(sent).toEqual(["Open support requests in this channel:\n- Fault **SD-6** VPN drops every ten minutes (Alice): In progress"]);
    expect(requests.updateStatusCategory).toHaveBeenCalledWith("SD-6", "in_progress", expect.any(Date));
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ entityId: "SD-6", details: { statusCategory: "in_progress" } }));
  });

  it("leaves out a request last known as done when its live read fails", async () => {
    const { tracker, sent, useCase } = setup([makeRequest({ statusCategory: "done" }), printer]);
    tracker.getIssue.mockRejectedValue(new IssueTrackerError("unavailable", 503));

    const shown = await useCase.execute({ conversationId: convId });

    expect(shown.map((r) => r.key)).toEqual(["SD-7"]);
    expect(sent).toEqual(["Open support requests in this channel:\n- Fault **SD-7** Printer is jammed (Bob): In progress (last known)"]);
  });

  it("skips a stored record whose key is outside the configured project, without reading it", async () => {
    const { tracker, sent, useCase } = setup([makeRequest({ key: "OPS-6" }), printer]);

    const shown = await useCase.execute({ conversationId: convId });

    expect(shown.map((r) => r.key)).toEqual(["SD-7"]);
    expect(tracker.getIssue).toHaveBeenCalledTimes(1);
    expect(tracker.getIssue).toHaveBeenCalledWith("SD-7");
    expect(sent[0]).not.toContain("OPS-6");
  });

  it.each([
    [undefined, "There are no open support requests in this channel."],
    [alice, "You have no open support requests in this channel."],
  ])("says when there is nothing open (requester %j)", async (requesterId, expected) => {
    const { tracker, sent, useCase } = setup([]);

    expect(await useCase.execute({ conversationId: convId, requesterId })).toEqual([]);

    expect(sent).toEqual([expected]);
    expect(tracker.getIssue).not.toHaveBeenCalled();
  });

  it("says nothing is open when every stored request turns out done", async () => {
    const { tracker, sent, useCase } = setup([vpn]);
    tracker.getIssue.mockResolvedValue(makeSnapshot({ statusCategory: "done" }));

    await useCase.execute({ conversationId: convId });

    expect(sent).toEqual(["There are no open support requests in this channel."]);
  });

  it("opens each line with the request's kind", async () => {
    const { tracker, sent, useCase } = setup([
      makeRequest({ key: "SD-12", summary: "Toner cartridges for printer 17", kind: "part" }),
      makeRequest({ key: "SD-11", summary: "Service interval for printer 17", kind: "question" }),
      makeRequest({ key: "SD-10", summary: "Error light on", kind: "fault" }),
    ]);
    tracker.getIssue.mockImplementation(async (key: string) => makeSnapshot({ key, statusCategory: "todo" }));

    await useCase.execute({ conversationId: convId });

    expect(sent).toEqual([[
      "Open support requests in this channel:",
      "- Part order **SD-12** Toner cartridges for printer 17 (Alice): To do",
      "- Question **SD-11** Service interval for printer 17 (Alice): To do",
      "- Fault **SD-10** Error light on (Alice): To do",
    ].join("\n")]);
  });
});
