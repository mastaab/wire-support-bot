import { describe, it, expect, vi } from "vitest";
import { ResolveSupportRequest } from "../../src/application/usecases/jira/ResolveSupportRequest";
import { REPLY_BODY_MAX } from "../../src/application/services/offers";
import { SupportRequestWrites } from "../../src/application/services/SupportRequestWrites";
import { IssueTrackerError } from "../../src/application/ports/IssueTrackerPort";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import { OUT_OF_SCOPE, alice, bob, convId, makeAudit, makeLogger, makeRequest, makeRequests, makeSnapshot, makeTracker, makeWire, sentRefFor } from "./supportRequestFakes";

const done = makeSnapshot({ statusCategory: "done", slas: [{ name: "Time to done", state: "met", elapsed: "3m", goal: "16h" }] });

function setup(records: SupportRequest[] = [makeRequest()]) {
  const requests = makeRequests(records);
  const tracker = makeTracker();
  tracker.resolveIssue.mockResolvedValue(done);
  const { wire, sent } = makeWire();
  const audit = makeAudit();
  const logger = makeLogger();
  const useCase = new ResolveSupportRequest(requests, tracker, wire, audit, logger);
  return { requests, tracker, wire, sent, audit, logger, useCase };
}

const base = { issueKey: "sd-6", conversationId: convId, actorId: bob, replyToMessageId: "msg-1" };

describe("ResolveSupportRequest", () => {
  it("marks the key as being written from the resolve until the new category is stored", async () => {
    const records = [makeRequest()];
    const requests = makeRequests(records);
    const tracker = makeTracker();
    const writes = new SupportRequestWrites();
    const during: boolean[] = [];
    tracker.resolveIssue.mockImplementation(async () => { during.push(writes.has("SD-6")); return done; });
    const store = requests.updateStatusCategory.getMockImplementation()!;
    requests.updateStatusCategory.mockImplementation(async (...args) => { during.push(writes.has("SD-6")); return store(...args); });
    const useCase = new ResolveSupportRequest(requests, tracker, makeWire().wire, makeAudit(), makeLogger(), writes);

    await useCase.execute(base);

    expect(during).toEqual([true, true]);
    expect(writes.has("SD-6")).toBe(false);
  });

  it("resolves the request, stores the category, audits the actor and reports the SLA outcome", async () => {
    const { requests, tracker, wire, sent, audit, useCase } = setup();

    expect(await useCase.execute(base)).toEqual(done);

    expect(tracker.resolveIssue).toHaveBeenCalledWith("SD-6");
    expect(requests.updateStatusCategory).toHaveBeenCalledWith("SD-6", "done", expect.any(Date));
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      actorId: bob, conversationId: convId, action: "entity_updated", entityType: "SupportRequest", entityId: "SD-6",
      details: { statusCategory: "done" },
    }));
    expect(sent).toEqual(["Resolved **SD-6** with the service desk.\nTime to done: met in 3m (target 16h)"]);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-1" });
  });

  it("reports the actual state when the workflow did not reach done, auditing without a store write for an unchanged category", async () => {
    const { requests, tracker, sent, audit, useCase } = setup([makeRequest({ statusCategory: "in_progress" })]);
    tracker.resolveIssue.mockResolvedValue(makeSnapshot({ statusCategory: "in_progress" }));

    await useCase.execute(base);

    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ details: { statusCategory: "in_progress" } }));
    expect(sent).toEqual(["I'm afraid I couldn't resolve **SD-6** with the service desk; it is now In progress."]);
  });

  it("says a request done by its last known category and live is already resolved, without resolving", async () => {
    const { requests, tracker, sent, audit, useCase } = setup([makeRequest({ statusCategory: "done" })]);
    tracker.getIssue.mockResolvedValue(done);

    expect(await useCase.execute(base)).toBeNull();

    expect(tracker.getIssue).toHaveBeenCalledWith("SD-6");
    expect(sent).toEqual(["**SD-6** is already resolved."]);
    expect(tracker.resolveIssue).not.toHaveBeenCalled();
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("does not read live for a request not last known as done", async () => {
    const { tracker, useCase } = setup();

    await useCase.execute(base);

    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(tracker.resolveIssue).toHaveBeenCalledTimes(1);
  });

  it("resolves a request the desk reopened, refreshing the stored category first", async () => {
    const { requests, tracker, sent, audit, useCase } = setup([makeRequest({ statusCategory: "done" })]);
    tracker.getIssue.mockResolvedValue(makeSnapshot({ statusCategory: "in_progress" }));

    expect(await useCase.execute(base)).toEqual(done);

    expect(requests.updateStatusCategory.mock.calls.map((call) => call[1])).toEqual(["in_progress", "done"]);
    expect(audit.append).toHaveBeenCalledTimes(2);
    expect(audit.append).toHaveBeenNthCalledWith(1, expect.objectContaining({
      actorId: { id: "wire-support-bot", domain: "example.com" }, entityId: "SD-6", details: { statusCategory: "in_progress" },
    }));
    expect(audit.append).toHaveBeenNthCalledWith(2, expect.objectContaining({
      actorId: bob, action: "entity_updated", entityType: "SupportRequest", entityId: "SD-6", details: { statusCategory: "done" },
    }));
    expect(tracker.resolveIssue).toHaveBeenCalledWith("SD-6");
    expect(sent).toEqual(["Resolved **SD-6** with the service desk.\nTime to done: met in 3m (target 16h)"]);
  });

  it.each([
    ["the read fails", (tracker: ReturnType<typeof makeTracker>) => tracker.getIssue.mockRejectedValue(new IssueTrackerError("unavailable", 503))],
    ["the ticket is not found", (tracker: ReturnType<typeof makeTracker>) => tracker.getIssue.mockResolvedValue(null)],
  ])("says Jira could not be reached for a request last known as done when %s", async (_label, arrange) => {
    const { requests, tracker, sent, audit, useCase } = setup([makeRequest({ statusCategory: "done" })]);
    arrange(tracker);

    expect(await useCase.execute(base)).toBeNull();

    expect(sent).toEqual(["I'm afraid I couldn't reach Jira to check **SD-6** just now; please try again later."]);
    expect(tracker.resolveIssue).not.toHaveBeenCalled();
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it.each(OUT_OF_SCOPE)("refuses a key %s with the scope wording, without calling the tracker", async (_label, records, key) => {
    const { tracker, sent, audit, useCase } = setup(records);

    expect(await useCase.execute({ ...base, issueKey: key })).toBeNull();

    expect(sent).toEqual([`I'm afraid **${key}** isn't a support request in this conversation.`]);
    expect(tracker.resolveIssue).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("audits a failed resolve with the actor and asks to check the ticket", async () => {
    const { requests, tracker, sent, audit, logger, useCase } = setup();
    tracker.resolveIssue.mockRejectedValue(new IssueTrackerError("transition failed", 409));

    expect(await useCase.execute(base)).toBeNull();

    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      actorId: bob, action: "entity_updated", entityType: "SupportRequest", entityId: "SD-6", details: { outcome: "resolve_failed" },
    }));
    expect(sent).toEqual(["I'm afraid I couldn't resolve **SD-6** with the service desk; please check the ticket."]);
    expect(logger.warn).toHaveBeenCalledWith("ResolveSupportRequest: resolveIssue failed", { key: "SD-6", err: "IssueTrackerError", status: 409 });
  });

  it("still reports the outcome when storing the category or the audit fails", async () => {
    const { requests, audit, sent, logger, useCase } = setup();
    requests.updateStatusCategory.mockRejectedValue(new Error("db down"));
    audit.append.mockRejectedValue(new Error("audit down"));

    expect(await useCase.execute(base)).toEqual(done);

    expect(sent).toEqual(["Resolved **SD-6** with the service desk.\nTime to done: met in 3m (target 16h)"]);
    expect(logger.warn).toHaveBeenCalledWith("Support request status refresh failed", { key: "SD-6", err: "Error" });
    expect(logger.error).toHaveBeenCalledWith("ResolveSupportRequest: audit append failed", { err: "Error" });
  });

  describe("with a closing comment", () => {
    const withComment = { ...base, comment: "  The tray was fitted, thanks.\nAll good now.  " };
    const commentBody = "The tray was fitted, thanks.\nAll good now.\n\nSent from Wire.";

    it("sends the comment with the footer before resolving, audits both and says the comment was added", async () => {
      const { tracker, sent, audit, logger, useCase } = setup();

      expect(await useCase.execute(withComment)).toEqual(done);

      expect(tracker.addCustomerReply).toHaveBeenCalledWith("SD-6", commentBody);
      expect(tracker.addCustomerReply.mock.invocationCallOrder[0]!).toBeLessThan(tracker.resolveIssue.mock.invocationCallOrder[0]!);
      expect(audit.append).toHaveBeenCalledTimes(2);
      expect(audit.append).toHaveBeenNthCalledWith(1, expect.objectContaining({
        actorId: bob, conversationId: convId, action: "entity_created", entityType: "JiraComment", entityId: "SD-6",
        details: { supportRequest: "SD-6" },
      }));
      expect(audit.append).toHaveBeenNthCalledWith(2, expect.objectContaining({
        actorId: bob, action: "entity_updated", entityType: "SupportRequest", details: { statusCategory: "done" },
      }));
      expect(sent).toEqual(["Resolved **SD-6** with the service desk.\nAdded your comment before resolving.\nTime to done: met in 3m (target 16h)"]);
      expect(JSON.stringify([...logger.warn.mock.calls, ...logger.info.mock.calls, ...logger.error.mock.calls])).not.toContain("tray");
    });

    it("does not send the comment for a request that is already resolved live", async () => {
      const { tracker, sent, useCase } = setup([makeRequest({ statusCategory: "done" })]);
      tracker.getIssue.mockResolvedValue(done);

      expect(await useCase.execute(withComment)).toBeNull();

      expect(tracker.getIssue).toHaveBeenCalledWith("SD-6");
      expect(tracker.addCustomerReply).not.toHaveBeenCalled();
      expect(sent).toEqual(["**SD-6** is already resolved, so I haven't added your comment."]);
    });

    it("sends the comment and resolves a request the desk reopened, after the live read", async () => {
      const { tracker, useCase } = setup([makeRequest({ statusCategory: "done" })]);
      tracker.getIssue.mockResolvedValue(makeSnapshot({ statusCategory: "in_progress" }));

      await useCase.execute(withComment);

      expect(tracker.getIssue.mock.invocationCallOrder[0]!).toBeLessThan(tracker.addCustomerReply.mock.invocationCallOrder[0]!);
      expect(tracker.resolveIssue).toHaveBeenCalledWith("SD-6");
    });

    it.each(OUT_OF_SCOPE)("refuses a key %s before sending the comment", async (_label, records, key) => {
      const { tracker, useCase } = setup(records);

      expect(await useCase.execute({ ...withComment, issueKey: key })).toBeNull();

      expect(tracker.addCustomerReply).not.toHaveBeenCalled();
      expect(tracker.resolveIssue).not.toHaveBeenCalled();
    });

    it("does not resolve when the comment is refused", async () => {
      const { tracker, sent, audit, logger, useCase } = setup();
      tracker.addCustomerReply.mockRejectedValue(new IssueTrackerError("bad request", 400));

      expect(await useCase.execute(withComment)).toBeNull();

      expect(tracker.resolveIssue).not.toHaveBeenCalled();
      expect(audit.append).not.toHaveBeenCalled();
      expect(sent).toEqual(["I'm afraid I couldn't add the comment to **SD-6**, so I haven't resolved it."]);
      expect(logger.warn).toHaveBeenCalledWith("ResolveSupportRequest: addCustomerReply failed", { key: "SD-6", err: "IssueTrackerError", status: 400 });
    });

    it.each([
      ["a server error", new IssueTrackerError("unavailable", 503)],
      ["a timeout", new IssueTrackerError("timeout")],
      ["an unexpected error", new Error("socket hang up")],
    ])("does not resolve and audits the unconfirmed comment after %s", async (_label, error) => {
      const { tracker, sent, audit, useCase } = setup();
      tracker.addCustomerReply.mockRejectedValue(error);

      expect(await useCase.execute(withComment)).toBeNull();

      expect(tracker.resolveIssue).not.toHaveBeenCalled();
      expect(audit.append).toHaveBeenCalledTimes(1);
      expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
        actorId: bob, action: "entity_created", entityType: "JiraComment", entityId: "SD-6",
        details: { supportRequest: "SD-6", outcome: "reply_unconfirmed" },
      }));
      expect(sent).toEqual(["I'm afraid I couldn't confirm that the comment reached **SD-6**, so I haven't resolved it. Please check the ticket."]);
    });

    it.each([
      ["empty", "   \n ", "I'm afraid the comment is empty, so I haven't resolved **SD-6**."],
      ["too long", "c".repeat(REPLY_BODY_MAX + 1), `I'm afraid that comment is too long for Jira, so I haven't resolved **SD-6**; please keep it under ${REPLY_BODY_MAX} characters.`],
    ])("refuses a comment that is %s without calling the tracker", async (_label, comment, expected) => {
      const { tracker, sent, audit, useCase } = setup([makeRequest({ statusCategory: "done" })]);

      expect(await useCase.execute({ ...base, comment })).toBeNull();

      expect(sent).toEqual([expected]);
      expect(tracker.getIssue).not.toHaveBeenCalled();
      expect(tracker.addCustomerReply).not.toHaveBeenCalled();
      expect(tracker.resolveIssue).not.toHaveBeenCalled();
      expect(audit.append).not.toHaveBeenCalled();
    });

    it("accepts a comment at the limit", async () => {
      const { tracker, useCase } = setup();
      const comment = "c".repeat(REPLY_BODY_MAX);

      expect(await useCase.execute({ ...base, comment })).toEqual(done);

      expect(tracker.addCustomerReply).toHaveBeenCalledWith("SD-6", `${comment}\n\nSent from Wire.`);
    });

    it("says the comment is on the ticket when the resolve then fails or stops short of done", async () => {
      const failed = setup();
      failed.tracker.resolveIssue.mockRejectedValue(new IssueTrackerError("transition failed", 409));
      expect(await failed.useCase.execute(withComment)).toBeNull();
      expect(failed.sent).toEqual(["I'm afraid I couldn't resolve **SD-6** with the service desk; please check the ticket.\nYour comment was added to the ticket."]);

      const partial = setup();
      partial.tracker.resolveIssue.mockResolvedValue(makeSnapshot({ statusCategory: "in_progress" }));
      await partial.useCase.execute(withComment);
      expect(partial.sent).toEqual(["I'm afraid I couldn't resolve **SD-6** with the service desk; it is now In progress.\nYour comment was added to the ticket."]);
    });

    it("still resolves when auditing the comment fails", async () => {
      const { tracker, audit, sent, useCase } = setup();
      audit.append.mockRejectedValueOnce(new Error("audit down"));

      expect(await useCase.execute(withComment)).toEqual(done);

      expect(tracker.resolveIssue).toHaveBeenCalledWith("SD-6");
      expect(sent[0]).toContain("Added your comment before resolving.");
    });
  });
});

describe("ResolveSupportRequest: last message reference", () => {
  it("stores the reference of the resolution reply as the request's last message", async () => {
    const { requests, useCase } = setup();

    expect(await useCase.execute(base)).toEqual(done);

    expect(requests.setLastMessage).toHaveBeenCalledTimes(1);
    expect(requests.setLastMessage).toHaveBeenCalledWith("SD-6", sentRefFor(1));
  });

  it("stores the reference of every other reply that names this conversation's request", async () => {
    const already = setup([makeRequest({ statusCategory: "done" })]);
    already.tracker.getIssue.mockResolvedValue(done);
    expect(await already.useCase.execute(base)).toBeNull();

    const unreachable = setup([makeRequest({ statusCategory: "done" })]);
    unreachable.tracker.getIssue.mockRejectedValue(new Error("timeout"));
    expect(await unreachable.useCase.execute(base)).toBeNull();

    const failed = setup();
    failed.tracker.resolveIssue.mockRejectedValue(new IssueTrackerError("transition failed", 409));
    expect(await failed.useCase.execute(base)).toBeNull();

    const refused = setup();
    refused.tracker.addCustomerReply.mockRejectedValue(new IssueTrackerError("bad request", 400));
    expect(await refused.useCase.execute({ ...base, comment: "Fitted." })).toBeNull();

    const unconfirmed = setup();
    unconfirmed.tracker.addCustomerReply.mockRejectedValue(new IssueTrackerError("server error", 500));
    expect(await unconfirmed.useCase.execute({ ...base, comment: "Fitted." })).toBeNull();

    const empty = setup();
    expect(await empty.useCase.execute({ ...base, comment: "  " })).toBeNull();

    for (const path of [already, unreachable, failed, refused, unconfirmed, empty]) {
      expect(path.sent).toHaveLength(1);
      expect(path.sent[0]).toContain("**SD-6**");
      expect(path.requests.setLastMessage).toHaveBeenCalledTimes(1);
      expect(path.requests.setLastMessage).toHaveBeenCalledWith("SD-6", sentRefFor(1));
    }
  });

  it.each(OUT_OF_SCOPE)("stores nothing for a key %s", async (_label, records, key) => {
    const { requests, wire, useCase } = setup(records);

    expect(await useCase.execute({ ...base, issueKey: key })).toBeNull();

    expect(wire.sendPlainText).toHaveBeenCalledTimes(1);
    expect(requests.setLastMessage).not.toHaveBeenCalled();
  });

  it("stores nothing when the transport returns no reference", async () => {
    const { requests, wire, useCase } = setup();
    wire.sendPlainText.mockResolvedValueOnce(undefined);

    expect(await useCase.execute(base)).toEqual(done);

    expect(requests.setLastMessage).not.toHaveBeenCalled();
  });

  it("keeps the reply and the result when storing the reference fails, logging the error name only", async () => {
    const { requests, sent, logger, useCase } = setup();
    requests.setLastMessage.mockRejectedValueOnce(new Error("SECRET-DB-DETAIL"));

    expect(await useCase.execute(base)).toEqual(done);

    expect(sent).toEqual(["Resolved **SD-6** with the service desk.\nTime to done: met in 3m (target 16h)"]);
    expect(logger.warn).toHaveBeenCalledWith("ResolveSupportRequest: storing the last message failed", { key: "SD-6", err: "Error" });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("SECRET-DB-DETAIL");
  });
});

describe("ResolveSupportRequest: the rating question", () => {
  function withFeedback(records: SupportRequest[] = [makeRequest()]) {
    const requests = makeRequests(records);
    const tracker = makeTracker();
    tracker.resolveIssue.mockResolvedValue(done);
    const { wire, sent } = makeWire();
    const logger = makeLogger();
    const feedback = { ask: vi.fn().mockResolvedValue(true) };
    const useCase = new ResolveSupportRequest(requests, tracker, wire, makeAudit(), logger, new SupportRequestWrites(), feedback);
    return { requests, tracker, wire, sent, logger, feedback, useCase };
  }
  const askedRequester = {
    target: { issueKey: "SD-6", summary: "VPN drops every ten minutes" }, conversationId: convId, requesterId: alice, requesterName: "Alice",
  };

  it("asks the request's requester after a resolve that reached done, also when another member resolved it, after the resolution reply", async () => {
    const { wire, feedback, useCase } = withFeedback();

    expect(await useCase.execute(base)).toEqual(done);

    expect(feedback.ask).toHaveBeenCalledExactlyOnceWith(askedRequester);
    expect(wire.sendPlainText.mock.invocationCallOrder[0]!).toBeLessThan(feedback.ask.mock.invocationCallOrder[0]!);
  });

  it("asks after a resolve with a closing comment", async () => {
    const { feedback, useCase } = withFeedback();

    await useCase.execute({ ...base, comment: "Works again." });

    expect(feedback.ask).toHaveBeenCalledExactlyOnceWith(askedRequester);
  });

  it("asks without a name when the request has none", async () => {
    const { feedback, useCase } = withFeedback([makeRequest({ requesterName: "" })]);

    await useCase.execute(base);

    expect(feedback.ask).toHaveBeenCalledExactlyOnceWith({ target: askedRequester.target, conversationId: convId, requesterId: alice });
  });

  it("asks after resolving a request the desk reopened", async () => {
    const { tracker, feedback, useCase } = withFeedback([makeRequest({ statusCategory: "done" })]);
    tracker.getIssue.mockResolvedValue(makeSnapshot({ statusCategory: "in_progress" }));

    await useCase.execute(base);

    expect(feedback.ask).toHaveBeenCalledOnce();
  });

  it("asks nothing when the request is already resolved", async () => {
    const { tracker, feedback, useCase } = withFeedback([makeRequest({ statusCategory: "done" })]);
    tracker.getIssue.mockResolvedValue(done);

    expect(await useCase.execute(base)).toBeNull();

    expect(feedback.ask).not.toHaveBeenCalled();
  });

  it("asks nothing when the resolve failed or stopped short of done", async () => {
    const failed = withFeedback();
    failed.tracker.resolveIssue.mockRejectedValue(new IssueTrackerError("conflict", 409));
    await failed.useCase.execute(base);
    expect(failed.feedback.ask).not.toHaveBeenCalled();

    const short = withFeedback();
    short.tracker.resolveIssue.mockResolvedValue(makeSnapshot({ statusCategory: "in_progress" }));
    await short.useCase.execute(base);
    expect(short.feedback.ask).not.toHaveBeenCalled();
  });

  it("asks nothing when the closing comment is refused, empty or the key is out of scope", async () => {
    const refused = withFeedback();
    refused.tracker.addCustomerReply.mockRejectedValue(new IssueTrackerError("bad request", 400));
    await refused.useCase.execute({ ...base, comment: "Works again." });
    expect(refused.feedback.ask).not.toHaveBeenCalled();

    const empty = withFeedback();
    await empty.useCase.execute({ ...base, comment: "   " });
    expect(empty.feedback.ask).not.toHaveBeenCalled();

    const outside = withFeedback();
    await outside.useCase.execute({ ...base, issueKey: "SD-99" });
    expect(outside.feedback.ask).not.toHaveBeenCalled();
  });

  it("keeps the resolve when asking fails, logging the error name only", async () => {
    const { feedback, logger, sent, useCase } = withFeedback();
    feedback.ask.mockRejectedValue(new TypeError("boom"));

    expect(await useCase.execute(base)).toEqual(done);

    expect(sent).toEqual(["Resolved **SD-6** with the service desk.\nTime to done: met in 3m (target 16h)"]);
    expect(logger.warn).toHaveBeenCalledWith("ResolveSupportRequest: asking for a rating failed", { key: "SD-6", err: "TypeError" });
  });
});
