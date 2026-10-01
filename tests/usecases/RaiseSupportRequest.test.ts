import { describe, it, expect } from "vitest";
import { RaiseSupportRequest } from "../../src/application/usecases/jira/RaiseSupportRequest";
import { PART_DETAIL_MAX, SUPPORT_DESCRIPTION_MAX, SUPPORT_SUMMARY_MAX } from "../../src/domain/entities/SupportRequest";
import { IssueTrackerError } from "../../src/application/ports/IssueTrackerPort";
import { alice, bob, convId, loggedText, makeAudit, makeLogger, makeRequests, makeTracker, makeWire, sentRefFor } from "./supportRequestFakes";

const BODY_MARKER = "SECRET-DESCRIPTION-MARKER";

function setup() {
  const requests = makeRequests([]);
  const tracker = makeTracker();
  tracker.createIssue.mockResolvedValue({ key: "SD-6", url: "https://jira.test/browse/SD-6", fieldsApplied: true });
  const { wire, sent } = makeWire();
  const audit = makeAudit();
  const logger = makeLogger();
  const useCase = new RaiseSupportRequest(requests, tracker, wire, audit, logger);
  return { requests, tracker, wire, sent, audit, logger, useCase };
}

const base = {
  summary: "my VPN drops every ten minutes",
  description: "My VPN drops every ten minutes since this morning.",
  conversationId: convId,
  requesterId: alice,
  requesterName: "Alice",
  replyToMessageId: "msg-1",
};

describe("RaiseSupportRequest", () => {
  it("creates the ticket, stores the record, audits it and replies with the link", async () => {
    const { requests, tracker, wire, sent, audit, useCase } = setup();

    const result = await useCase.execute(base);

    expect(tracker.createIssue).toHaveBeenCalledWith({
      summary: "My VPN drops every ten minutes",
      description: "My VPN drops every ten minutes since this morning.\n\nRequested by Alice via Wire.",
      labels: ["wire-support-bot"],
    });
    expect(requests.create).toHaveBeenCalledWith(expect.objectContaining({
      key: "SD-6", conversationId: convId, requesterId: alice, requesterName: "Alice",
      summary: "My VPN drops every ten minutes", statusCategory: "todo", deleted: false, version: 1,
    }));
    expect(result).toMatchObject({ key: "SD-6", statusCategory: "todo" });
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      actorId: alice, conversationId: convId, action: "entity_created", entityType: "SupportRequest", entityId: "SD-6",
    }));
    expect(sent).toEqual(["Raised **SD-6** with the service desk: https://jira.test/browse/SD-6"]);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-1" });
  });

  it("does not store the description", async () => {
    const { requests, audit, useCase } = setup();

    await useCase.execute({ ...base, description: `Details ${BODY_MARKER}` });

    expect(JSON.stringify(requests.create.mock.calls)).not.toContain(BODY_MARKER);
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain(BODY_MARKER);
  });

  it.each([
    ["a missing name", undefined],
    ["an empty name", "   "],
    ["a raw user ID", "0f7c2b1e-4a5d-4c3b-9e8f-1a2b3c4d5e6f"],
    ["a qualified raw user ID", "0F7C2B1E-4A5D-4C3B-9E8F-1A2B3C4D5E6F@example.com"],
  ])("ends the description with 'Requested via Wire.' for %s", async (_label, requesterName) => {
    const { requests, tracker, useCase } = setup();

    await useCase.execute({ ...base, requesterName });

    expect(tracker.createIssue.mock.calls[0]![0].description).toBe("My VPN drops every ten minutes since this morning.\n\nRequested via Wire.");
    expect(requests.create.mock.calls[0]![0].requesterName).toBe("");
  });

  it("collapses whitespace in the summary", async () => {
    const { tracker, useCase } = setup();

    await useCase.execute({ ...base, summary: "  printer\n  is  jammed " });

    expect(tracker.createIssue.mock.calls[0]![0].summary).toBe("Printer is jammed");
  });

  it.each([
    ["an empty summary", { summary: "  " }],
    ["an empty description", { description: "\n\t" }],
  ])("refuses %s without calling the tracker", async (_label, overrides) => {
    const { tracker, sent, useCase } = setup();

    expect(await useCase.execute({ ...base, ...overrides })).toBeNull();

    expect(sent).toEqual(["I'm afraid there is nothing to raise; please describe the problem."]);
    expect(tracker.createIssue).not.toHaveBeenCalled();
  });

  it("accepts a summary and description at the limits and refuses one character more", async () => {
    const atLimit = setup();
    await atLimit.useCase.execute({ ...base, summary: "x".repeat(SUPPORT_SUMMARY_MAX), description: "y".repeat(SUPPORT_DESCRIPTION_MAX) });
    expect(atLimit.tracker.createIssue).toHaveBeenCalledTimes(1);

    const longSummary = setup();
    expect(await longSummary.useCase.execute({ ...base, summary: "x".repeat(SUPPORT_SUMMARY_MAX + 1) })).toBeNull();
    expect(longSummary.sent).toEqual([`I'm afraid that summary is too long; please keep it under ${SUPPORT_SUMMARY_MAX} characters.`]);
    expect(longSummary.tracker.createIssue).not.toHaveBeenCalled();

    const longDescription = setup();
    expect(await longDescription.useCase.execute({ ...base, description: "y".repeat(SUPPORT_DESCRIPTION_MAX + 1) })).toBeNull();
    expect(longDescription.sent).toEqual([`I'm afraid that description is too long; please keep it under ${SUPPORT_DESCRIPTION_MAX} characters.`]);
    expect(longDescription.tracker.createIssue).not.toHaveBeenCalled();
  });

  it("stops a double submit from the same requester while the first is in flight", async () => {
    const { tracker, sent, useCase } = setup();
    let finish: (value: unknown) => void = () => {};
    tracker.createIssue.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));

    const first = useCase.execute(base);
    expect(await useCase.execute(base)).toBeNull();
    expect(sent).toEqual(["Your support request is already being raised with the service desk."]);

    // Another member in the same conversation is not blocked.
    tracker.createIssue.mockResolvedValueOnce({ key: "SD-7", url: "https://jira.test/browse/SD-7", fieldsApplied: true });
    expect(await useCase.execute({ ...base, requesterId: bob })).toMatchObject({ key: "SD-7" });

    finish({ key: "SD-6", url: "https://jira.test/browse/SD-6", fieldsApplied: true });
    expect(await first).toMatchObject({ key: "SD-6" });
    expect(tracker.createIssue).toHaveBeenCalledTimes(2);

    // The guard is released afterwards.
    tracker.createIssue.mockResolvedValueOnce({ key: "SD-8", url: "https://jira.test/browse/SD-8", fieldsApplied: true });
    expect(await useCase.execute(base)).toMatchObject({ key: "SD-8" });
  });

  it.each([400, 403, 422])("says nothing was raised after a refused create (%i), audits it and releases the guard", async (status) => {
    const { tracker, requests, sent, audit, logger, useCase } = setup();
    tracker.createIssue.mockRejectedValueOnce(new IssueTrackerError(`failed ${BODY_MARKER}`, status));

    expect(await useCase.execute(base)).toBeNull();

    expect(sent).toEqual(["I'm afraid I couldn't raise the request with the service desk just now."]);
    expect(requests.create).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      actorId: alice, conversationId: convId, action: "entity_created", entityType: "JiraIssue", entityId: "unknown",
      details: { outcome: "create_refused" },
    }));
    expect(logger.warn).toHaveBeenCalledWith("RaiseSupportRequest: createIssue failed", { err: "IssueTrackerError", status });
    expect(await useCase.execute(base)).toMatchObject({ key: "SD-6" });
  });

  it.each([
    ["a 5xx", new IssueTrackerError("server error", 500)],
    ["a 3xx", new IssueTrackerError("unexpected response", 302)],
    ["a tracker error with no status", new IssueTrackerError("timed out")],
    ["a network error", new TypeError("fetch failed")],
    ["a non-error value", "boom"],
  ])("asks to check the queue after %s, because the ticket may exist, and audits it", async (_label, error) => {
    const { tracker, requests, sent, audit, useCase } = setup();
    tracker.createIssue.mockRejectedValueOnce(error);

    expect(await useCase.execute(base)).toBeNull();

    expect(sent).toEqual(["I'm afraid I couldn't confirm that the request reached the service desk. Please check the SD queue before raising it again."]);
    expect(requests.create).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      actorId: alice, action: "entity_created", entityType: "JiraIssue", entityId: "unknown", details: { outcome: "create_unconfirmed" },
    }));
  });

  it("keeps the failure reply when auditing a failed create fails", async () => {
    const { tracker, sent, audit, logger, useCase } = setup();
    tracker.createIssue.mockRejectedValueOnce(new IssueTrackerError("server error", 500));
    audit.append.mockRejectedValueOnce(new Error("audit down"));

    expect(await useCase.execute(base)).toBeNull();

    expect(sent).toEqual(["I'm afraid I couldn't confirm that the request reached the service desk. Please check the SD queue before raising it again."]);
    expect(logger.error).toHaveBeenCalledWith("RaiseSupportRequest: audit append failed", { err: "Error" });
  });

  it("does not store a created key outside the project, audits it and gives the link", async () => {
    const { tracker, requests, sent, audit, useCase } = setup();
    tracker.createIssue.mockResolvedValueOnce({ key: "OPS-3", url: "https://jira.test/browse/OPS-3", fieldsApplied: true });

    expect(await useCase.execute(base)).toBeNull();

    expect(requests.create).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      actorId: alice, action: "entity_created", entityType: "JiraIssue", entityId: "OPS-3", details: { outcome: "unexpected_key" },
    }));
    expect(sent).toEqual(["Raised the request with the service desk (https://jira.test/browse/OPS-3), but I'm afraid I can't track it from Wire."]);
  });

  it("gives the link and says so when storing fails after the ticket was created", async () => {
    const { requests, sent, audit, logger, useCase } = setup();
    requests.create.mockRejectedValueOnce(new Error(`db down ${BODY_MARKER}`));

    expect(await useCase.execute(base)).toBeNull();

    expect(sent).toEqual([
      "Raised **SD-6** with the service desk (https://jira.test/browse/SD-6), but I'm afraid I couldn't record it here, so I can't follow it from this channel.",
    ]);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: "entity_created", entityType: "JiraIssue", entityId: "SD-6", details: { outcome: "store_failed" },
    }));
    expect(loggedText(logger)).not.toContain(BODY_MARKER);
  });

  it("still reports success when the audit fails", async () => {
    const { sent, audit, logger, useCase } = setup();
    audit.append.mockRejectedValueOnce(new Error("audit down"));

    expect(await useCase.execute(base)).toMatchObject({ key: "SD-6" });

    expect(sent).toEqual(["Raised **SD-6** with the service desk: https://jira.test/browse/SD-6"]);
    expect(logger.error).toHaveBeenCalledWith("RaiseSupportRequest: audit append failed", { err: "Error" });
  });

  it("mentions a label that could not be set", async () => {
    const { tracker, sent, useCase } = setup();
    tracker.createIssue.mockResolvedValueOnce({ key: "SD-6", url: "https://jira.test/browse/SD-6", fieldsApplied: false });

    await useCase.execute(base);

    expect(sent).toEqual(["Raised **SD-6** with the service desk: https://jira.test/browse/SD-6\nI'm afraid I couldn't set the label on the ticket."]);
  });

  it("never logs the description and sends exactly one Wire message on every path", async () => {
    const paths = [setup(), setup(), setup()];
    paths[1]!.tracker.createIssue.mockRejectedValueOnce(new Error(BODY_MARKER));
    paths[2]!.requests.create.mockRejectedValueOnce(new Error(BODY_MARKER));
    for (const { wire, logger, useCase } of paths) {
      await useCase.execute({ ...base, description: `Details ${BODY_MARKER}` });
      expect(wire.sendPlainText).toHaveBeenCalledTimes(1);
      expect(loggedText(logger)).not.toContain(BODY_MARKER);
    }
  });
});

describe("RaiseSupportRequest: request kinds and part orders", () => {
  const types = { question: "102", part: "103" };
  const part = { asset: "Printer 17", part: "Toner cartridges, black", quantity: "2", deliverTo: "Depot North" };

  function kindSetup(requestTypes?: Record<string, string>) {
    const requests = makeRequests([]);
    const tracker = makeTracker();
    tracker.createIssue.mockResolvedValue({ key: "SD-12", url: "https://jira.test/browse/SD-12", fieldsApplied: true });
    const { wire, sent } = makeWire();
    const audit = makeAudit();
    const useCase = new RaiseSupportRequest(requests, tracker, wire, audit, makeLogger(), requestTypes);
    return { requests, tracker, sent, audit, useCase };
  }

  it("uses the mapped request type for the kind", async () => {
    const { tracker, useCase } = kindSetup(types);

    await useCase.execute({ ...base, requestKind: "question" });

    expect(tracker.createIssue.mock.calls[0]![0].requestTypeId).toBe("102");
  });

  it.each([
    ["a kind without a mapping", types, "fault" as const],
    ["no mapping at all", undefined, "question" as const],
  ])("sends no request type for %s, so the tracker's default applies", async (_label, requestTypes, requestKind) => {
    const { tracker, useCase } = kindSetup(requestTypes);

    await useCase.execute({ ...base, requestKind });

    expect(tracker.createIssue.mock.calls[0]![0]).not.toHaveProperty("requestTypeId");
  });

  it("defaults to a fault: stored, audited and typed as one", async () => {
    const { tracker, requests, audit, useCase } = kindSetup({ fault: "101" });

    const result = await useCase.execute(base);

    expect(tracker.createIssue.mock.calls[0]![0].requestTypeId).toBe("101");
    expect(requests.create.mock.calls[0]![0].kind).toBe("fault");
    expect(result?.kind).toBe("fault");
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: "entity_created", entityType: "SupportRequest", details: { statusCategory: "todo", kind: "fault" },
    }));
  });

  it("puts the part lines above the requester's description and stores the kind", async () => {
    const { tracker, requests, audit, sent, useCase } = kindSetup(types);

    await useCase.execute({
      ...base, summary: "Toner cartridges for printer 17", description: "The black toner is nearly empty.", requestKind: "part",
      part: { ...part, asset: "  Printer\n 17 " },
    });

    expect(tracker.createIssue).toHaveBeenCalledWith({
      summary: "Toner cartridges for printer 17",
      description: "Asset: Printer 17\nPart: Toner cartridges, black\nQuantity: 2\nDeliver to: Depot North\n\nThe black toner is nearly empty.\n\nRequested by Alice via Wire.",
      labels: ["wire-support-bot"],
      requestTypeId: "103",
    });
    expect(requests.create.mock.calls[0]![0].kind).toBe("part");
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ details: { statusCategory: "todo", kind: "part" } }));
    // The details go to the ticket only, never to the record or the audit log.
    expect(JSON.stringify(requests.create.mock.calls)).not.toContain("Depot North");
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain("Depot North");
    expect(sent).toEqual(["Raised **SD-12** with the service desk: https://jira.test/browse/SD-12"]);
  });

  it("ignores part details for other kinds", async () => {
    const { tracker, useCase } = kindSetup();

    await useCase.execute({ ...base, requestKind: "fault", part });

    expect(tracker.createIssue.mock.calls[0]![0].description).toBe("My VPN drops every ten minutes since this morning.\n\nRequested by Alice via Wire.");
  });

  it.each([
    ["no details", undefined, "I haven't ordered anything yet: I still need the item the part is for (for example a serial number), the part (name or number), the quantity and the delivery location."],
    ["an empty asset and no delivery location", { part: "Tray", quantity: "1", asset: "  " }, "I haven't ordered anything yet: I still need the item the part is for (for example a serial number) and the delivery location."],
    ["an overlong quantity", { ...part, quantity: "9".repeat(PART_DETAIL_MAX + 1) }, "I haven't ordered anything yet: I still need the quantity."],
  ])("refuses a part order with %s and raises nothing", async (_label, details, reply) => {
    const { tracker, requests, audit, sent, useCase } = kindSetup(types);

    const result = await useCase.execute({ ...base, requestKind: "part", ...(details ? { part: details } : {}) });

    expect(result).toBeNull();
    expect(tracker.createIssue).not.toHaveBeenCalled();
    expect(requests.create).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    expect(sent).toEqual([reply]);
  });
});

describe("RaiseSupportRequest: watch markers", () => {
  it("creates the record with lastSeenReplyAt equal to createdAt", async () => {
    const { requests, useCase } = setup();

    await useCase.execute(base);

    const stored = requests.create.mock.calls[0]![0];
    expect(stored.lastSeenReplyAt).toBeInstanceOf(Date);
    expect(stored.lastSeenReplyAt!.getTime()).toBe(stored.createdAt.getTime());
  });

  it("creates the record as seen unassigned, so a quick assignment is a change for the watch", async () => {
    const { requests, useCase } = setup();

    await useCase.execute(base);

    const stored = requests.create.mock.calls[0]![0];
    expect(stored.assigneeSeenAt).toBeInstanceOf(Date);
    expect(stored.assigneeSeenAt!.getTime()).toBe(stored.createdAt.getTime());
    expect(stored.assigneeAccountId).toBeUndefined();
  });

  it("stores the reference of the Raised confirmation as the request's last message", async () => {
    const { requests, useCase } = setup();

    await useCase.execute(base);

    expect(requests.setLastMessage).toHaveBeenCalledTimes(1);
    expect(requests.setLastMessage).toHaveBeenCalledWith("SD-6", sentRefFor(1));
  });

  it("stores nothing when the transport returns no reference", async () => {
    const { requests, wire, useCase } = setup();
    wire.sendPlainText.mockResolvedValueOnce(undefined);

    expect(await useCase.execute(base)).toMatchObject({ key: "SD-6" });

    expect(wire.sendPlainText).toHaveBeenCalledTimes(1);
    expect(requests.setLastMessage).not.toHaveBeenCalled();
  });

  it("keeps the confirmation and the result when storing the reference fails, logging the error name only", async () => {
    const { requests, sent, logger, useCase } = setup();
    requests.setLastMessage.mockRejectedValueOnce(new Error(`db down ${BODY_MARKER}`));

    expect(await useCase.execute(base)).toMatchObject({ key: "SD-6" });

    expect(sent).toEqual(["Raised **SD-6** with the service desk: https://jira.test/browse/SD-6"]);
    expect(logger.warn).toHaveBeenCalledWith("RaiseSupportRequest: storing the last message failed", { key: "SD-6", err: "Error" });
    expect(loggedText(logger)).not.toContain(BODY_MARKER);
  });

  it("stores no reference when nothing was recorded: refused, unconfirmed, outside the project or not stored", async () => {
    const paths = [setup(), setup(), setup(), setup()];
    paths[0]!.tracker.createIssue.mockRejectedValueOnce(new IssueTrackerError("bad request", 400));
    paths[1]!.tracker.createIssue.mockRejectedValueOnce(new IssueTrackerError("server error", 500));
    paths[2]!.tracker.createIssue.mockResolvedValueOnce({ key: "OPS-3", url: "https://jira.test/browse/OPS-3", fieldsApplied: true });
    paths[3]!.requests.create.mockRejectedValueOnce(new Error("db down"));
    for (const { requests, wire, useCase } of paths) {
      expect(await useCase.execute(base)).toBeNull();
      expect(wire.sendPlainText).toHaveBeenCalledTimes(1);
      expect(requests.setLastMessage).not.toHaveBeenCalled();
    }
  });

  it("stores no reference for an input error", async () => {
    const { requests, wire, useCase } = setup();

    expect(await useCase.execute({ ...base, description: " " })).toBeNull();

    expect(wire.sendPlainText).toHaveBeenCalledTimes(1);
    expect(requests.setLastMessage).not.toHaveBeenCalled();
  });
});

