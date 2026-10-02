import { describe, it, expect } from "vitest";
import { FEEDBACK_FAILED, SubmitFeedback } from "../../src/application/usecases/jira/SubmitFeedback";
import { IssueTrackerError } from "../../src/application/ports/IssueTrackerPort";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import {
  OUT_OF_SCOPE, alice, convId, loggedText, makeAudit, makeLogger, makeRequest, makeRequests, makeTracker, makeWire,
} from "./supportRequestFakes";

const T0 = new Date("2026-10-02T10:00:00Z");

function setup(records: SupportRequest[] = [makeRequest({ statusCategory: "done" })]) {
  const requests = makeRequests(records);
  const tracker = makeTracker();
  const { wire, sent } = makeWire();
  const audit = makeAudit();
  const logger = makeLogger();
  const useCase = new SubmitFeedback(requests, tracker, wire, audit, logger, () => T0);
  const run = (rating: number, issueKey = "SD-6") =>
    useCase.execute({ issueKey, rating, conversationId: convId, actorId: alice, replyToMessageId: "click-1" });
  return { requests, tracker, wire, sent, audit, logger, run };
}

describe("SubmitFeedback", () => {
  it.each([1, 2, 3, 4, 5])("sends the rating %s, posts nothing and audits the rating only", async (rating) => {
    const { run, tracker, sent, audit } = setup();
    expect(await run(rating)).toBe(true);
    expect(tracker.submitFeedback).toHaveBeenCalledExactlyOnceWith("SD-6", rating);
    expect(sent).toEqual([]);
    expect(audit.append).toHaveBeenCalledExactlyOnceWith({
      timestamp: T0, actorId: alice, conversationId: convId, action: "entity_created", entityType: "JiraFeedback", entityId: "SD-6",
      details: { rating },
    });
  });

  it.each([
    ["feedback disabled in the project", 404],
    ["not allowed for the bot's account", 403],
    ["a rejected body", 400],
  ])("answers one short text when Jira refuses (%s), logging error name and status only, without an audit entry", async (_label, status) => {
    const { run, tracker, sent, audit, logger, wire } = setup();
    tracker.submitFeedback.mockRejectedValue(new IssueTrackerError(`Jira request failed (${status}) secret detail`, status));
    expect(await run(4)).toBe(false);
    expect(sent).toEqual([FEEDBACK_FAILED]);
    expect(FEEDBACK_FAILED).toBe("I couldn't send the rating to the service desk.");
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, FEEDBACK_FAILED, { replyToMessageId: "click-1" });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("SubmitFeedback: submitFeedback failed", { key: "SD-6", err: "IssueTrackerError", status });
    expect(loggedText(logger)).not.toContain("secret detail");
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("audits a failure that may have reached Jira as unconfirmed", async () => {
    for (const err of [new IssueTrackerError("Jira request timed out"), new IssueTrackerError("Jira request failed (502)", 502)]) {
      const { run, tracker, sent, audit } = setup();
      tracker.submitFeedback.mockRejectedValue(err);
      expect(await run(2)).toBe(false);
      expect(sent).toEqual([FEEDBACK_FAILED]);
      expect(audit.append).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        entityType: "JiraFeedback", entityId: "SD-6", details: { rating: 2, outcome: "feedback_unconfirmed" },
      }));
    }
  });

  it.each([0, 6, 3.5])("sends nothing for the rating %s", async (rating) => {
    const { run, tracker, sent, audit } = setup();
    expect(await run(rating)).toBe(false);
    expect(tracker.submitFeedback).not.toHaveBeenCalled();
    expect(sent).toEqual([FEEDBACK_FAILED]);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it.each(OUT_OF_SCOPE)("sends nothing for a request %s", async (_label, records, key) => {
    const { run, tracker, sent, audit } = setup(records);
    expect(await run(5, key)).toBe(false);
    expect(tracker.submitFeedback).not.toHaveBeenCalled();
    expect(sent).toEqual([FEEDBACK_FAILED]);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("keeps the rating when the audit fails", async () => {
    const { run, audit, sent } = setup();
    audit.append.mockRejectedValue(new Error("db down"));
    expect(await run(5)).toBe(true);
    expect(sent).toEqual([]);
  });

  it("logs no names", async () => {
    const { run, tracker, logger } = setup();
    tracker.submitFeedback.mockRejectedValue(new IssueTrackerError("Jira request failed (404)", 404));
    await run(1);
    expect(loggedText(logger)).not.toContain("Alice");
    expect(loggedText(logger)).not.toContain("user-1");
  });
});
