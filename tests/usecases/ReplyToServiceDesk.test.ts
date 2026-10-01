import { describe, it, expect, vi } from "vitest";
import { ReplyToServiceDesk } from "../../src/application/usecases/jira/ReplyToServiceDesk";
import { REPLY_BODY_MAX } from "../../src/application/services/offers";
import { IssueTrackerError } from "../../src/application/ports/IssueTrackerPort";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import { OUT_OF_SCOPE, bob, convId, loggedText, makeAudit, makeLogger, makeRequest, makeRequests, makeTracker, makeWire, sentRefFor } from "./supportRequestFakes";

const BODY_MARKER = "SECRET-BODY-MARKER";

function setup(options: { records?: SupportRequest[]; addCustomerReply?: ReturnType<typeof makeTracker>["addCustomerReply"]; auditError?: Error } = {}) {
  const requests = makeRequests(options.records ?? [makeRequest()]);
  const tracker = makeTracker();
  if (options.addCustomerReply) tracker.addCustomerReply = options.addCustomerReply;
  const { wire, sent } = makeWire();
  const audit = makeAudit();
  if (options.auditError) audit.append.mockRejectedValue(options.auditError);
  const logger = makeLogger();
  const useCase = new ReplyToServiceDesk(requests, tracker, wire, audit, logger);
  return { requests, tracker, wire, sent, audit, logger, useCase };
}

const base = { conversationId: convId, actorId: bob, replyToMessageId: "msg-1" };

describe("ReplyToServiceDesk", () => {
  it("sends the reply with the Wire footer and audits it without the body", async () => {
    const { tracker, wire, sent, audit, useCase } = setup();

    expect(await useCase.execute({ ...base, reference: "sd-6", body: "  It still drops after the reset.  " })).toBe(true);

    expect(tracker.addCustomerReply).toHaveBeenCalledTimes(1);
    expect(tracker.addCustomerReply).toHaveBeenCalledWith("SD-6", "It still drops after the reset.\n\nSent from Wire.");
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: "entity_created",
      entityType: "JiraComment",
      entityId: "SD-6",
      actorId: bob,
      conversationId: convId,
      details: { supportRequest: "SD-6" },
    }));
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain("still drops");
    expect(sent).toEqual(["Sent your reply to **SD-6** in Jira."]);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-1" });
  });

  it("lets any member of the channel reply, not only the requester", async () => {
    const { tracker, useCase } = setup({ records: [makeRequest({ requesterId: { id: "user-9", domain: "example.com" } })] });

    expect(await useCase.execute({ ...base, reference: "SD-6", body: "Hello" })).toBe(true);
    expect(tracker.addCustomerReply).toHaveBeenCalledTimes(1);
  });

  it.each(OUT_OF_SCOPE)("refuses a key %s with the scope wording, without calling the tracker", async (_label, records, key) => {
    const { tracker, sent, audit, useCase } = setup({ records });

    expect(await useCase.execute({ ...base, reference: key, body: "Hello" })).toBe(false);

    expect(sent).toEqual([`I'm afraid **${key}** isn't a support request in this conversation.`]);
    expect(tracker.addCustomerReply).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it.each(["", "   \n\t "])("refuses an empty body %j", async (body) => {
    const { tracker, sent, useCase } = setup();

    expect(await useCase.execute({ ...base, reference: "SD-6", body })).toBe(false);

    expect(sent).toEqual(["I'm afraid there is nothing to send."]);
    expect(tracker.addCustomerReply).not.toHaveBeenCalled();
  });

  it("accepts a body of exactly the limit and refuses one character more", async () => {
    const atLimit = setup();
    expect(await atLimit.useCase.execute({ ...base, reference: "SD-6", body: "x".repeat(REPLY_BODY_MAX) })).toBe(true);
    expect(atLimit.tracker.addCustomerReply).toHaveBeenCalledTimes(1);

    const over = setup();
    expect(await over.useCase.execute({ ...base, reference: "SD-6", body: "x".repeat(REPLY_BODY_MAX + 1) })).toBe(false);
    expect(over.sent).toEqual([`I'm afraid that reply is too long for Jira; please keep it under ${REPLY_BODY_MAX} characters.`]);
    expect(over.tracker.addCustomerReply).not.toHaveBeenCalled();
  });

  it.each([400, 403, 404, 422, 499])("reports a send Jira refused with %i, logs only the error fields and does not audit", async (status) => {
    const { sent, audit, logger, useCase } = setup({
      addCustomerReply: vi.fn().mockRejectedValue(new IssueTrackerError(`failed ${BODY_MARKER}`, status)),
    });

    expect(await useCase.execute({ ...base, reference: "SD-6", body: `Please see ${BODY_MARKER}` })).toBe(false);

    expect(sent).toEqual(["I'm afraid I couldn't send the reply to **SD-6** just now."]);
    expect(audit.append).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("ReplyToServiceDesk: addCustomerReply failed", { err: "IssueTrackerError", status });
  });

  it.each([
    ["a 5xx", new IssueTrackerError("server error", 500)],
    ["a 503", new IssueTrackerError("unavailable", 503)],
    ["a 3xx", new IssueTrackerError("unexpected response", 302)],
    ["a tracker error with no status", new IssueTrackerError("timed out")],
    ["a network error", new TypeError("fetch failed")],
    ["a non-error value", "boom"],
  ])("asks the user to check the ticket after %s, because Jira may have accepted it", async (_label, error) => {
    const { sent, audit, logger, useCase } = setup({ addCustomerReply: vi.fn().mockRejectedValue(error) });

    expect(await useCase.execute({ ...base, reference: "SD-6", body: "Hello" })).toBe(false);

    expect(sent).toEqual(["I'm afraid I couldn't confirm that the reply reached **SD-6**. Please check the ticket before sending it again."]);
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      actorId: bob, conversationId: convId, action: "entity_created", entityType: "JiraComment", entityId: "SD-6",
      details: { supportRequest: "SD-6", outcome: "reply_unconfirmed" },
    }));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("keeps the unconfirmed reply wording when the audit fails", async () => {
    const { sent, logger, useCase } = setup({ addCustomerReply: vi.fn().mockRejectedValue(new IssueTrackerError("server error", 500)), auditError: new Error("audit down") });

    expect(await useCase.execute({ ...base, reference: "SD-6", body: "Hello" })).toBe(false);

    expect(sent).toEqual(["I'm afraid I couldn't confirm that the reply reached **SD-6**. Please check the ticket before sending it again."]);
    expect(logger.error).toHaveBeenCalledWith("ReplyToServiceDesk: audit append failed", { err: "Error" });
  });

  it("still reports success when the audit fails after the reply was sent, logging only the error name", async () => {
    const { tracker, sent, logger, useCase } = setup({ auditError: new Error(`db down ${BODY_MARKER}`) });

    expect(await useCase.execute({ ...base, reference: "SD-6", body: `Reply ${BODY_MARKER}` })).toBe(true);

    expect(tracker.addCustomerReply).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(["Sent your reply to **SD-6** in Jira."]);
    expect(logger.error).toHaveBeenCalledWith("ReplyToServiceDesk: audit append failed", { err: "Error" });
    expect(loggedText(logger)).not.toContain(BODY_MARKER);
  });

  it("never logs the body and sends exactly one Wire message on any path", async () => {
    const paths = [
      setup(),
      setup({ addCustomerReply: vi.fn().mockRejectedValue(new Error(BODY_MARKER)) }),
      setup({ records: [] }),
    ];
    for (const { wire, logger, useCase } of paths) {
      await useCase.execute({ ...base, reference: "SD-6", body: `Reply ${BODY_MARKER}` });
      expect(wire.sendPlainText).toHaveBeenCalledTimes(1);
      expect(loggedText(logger)).not.toContain(BODY_MARKER);
    }
  });
});

describe("ReplyToServiceDesk: last message reference", () => {
  it("stores the reference of the confirmation as the request's last message", async () => {
    const { requests, useCase } = setup();

    expect(await useCase.execute({ ...base, reference: "sd-6", body: "It still drops." })).toBe(true);

    expect(requests.setLastMessage).toHaveBeenCalledTimes(1);
    expect(requests.setLastMessage).toHaveBeenCalledWith("SD-6", sentRefFor(1));
  });

  it.each([
    ["refused", new IssueTrackerError("bad request", 400), "I'm afraid I couldn't send the reply to **SD-6** just now."],
    ["unconfirmed", new IssueTrackerError("server error", 500), "I'm afraid I couldn't confirm that the reply reached **SD-6**. Please check the ticket before sending it again."],
  ])("stores the reference of a %s reply, which names this conversation's request", async (_label, error, reply) => {
    const { requests, sent, useCase } = setup({ addCustomerReply: vi.fn().mockRejectedValue(error) });

    expect(await useCase.execute({ ...base, reference: "SD-6", body: "It still drops." })).toBe(false);

    expect(sent).toEqual([reply]);
    expect(requests.setLastMessage).toHaveBeenCalledWith("SD-6", sentRefFor(1));
  });

  it.each(OUT_OF_SCOPE)("stores nothing for a key %s", async (_label, records, reference) => {
    const { requests, wire, useCase } = setup({ records });

    expect(await useCase.execute({ ...base, reference, body: "It still drops." })).toBe(false);

    expect(wire.sendPlainText).toHaveBeenCalledTimes(1);
    expect(requests.setLastMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty body", "   "],
    ["a body over the limit", "x".repeat(REPLY_BODY_MAX + 1)],
  ])("stores nothing for %s, since the reply does not name the request", async (_label, body) => {
    const { requests, wire, useCase } = setup();

    expect(await useCase.execute({ ...base, reference: "SD-6", body })).toBe(false);

    expect(wire.sendPlainText).toHaveBeenCalledTimes(1);
    expect(requests.setLastMessage).not.toHaveBeenCalled();
  });

  it("stores nothing when the transport returns no reference", async () => {
    const { requests, wire, useCase } = setup();
    wire.sendPlainText.mockResolvedValueOnce(undefined);

    expect(await useCase.execute({ ...base, reference: "SD-6", body: "It still drops." })).toBe(true);

    expect(requests.setLastMessage).not.toHaveBeenCalled();
  });

  it("keeps the reply and the result when storing the reference fails, logging the error name only", async () => {
    const { requests, sent, logger, useCase } = setup();
    requests.setLastMessage.mockRejectedValueOnce(new Error(`db down ${BODY_MARKER}`));

    expect(await useCase.execute({ ...base, reference: "SD-6", body: "It still drops." })).toBe(true);

    expect(sent).toEqual(["Sent your reply to **SD-6** in Jira."]);
    expect(logger.warn).toHaveBeenCalledWith("ReplyToServiceDesk: storing the last message failed", { key: "SD-6", err: "Error" });
    expect(loggedText(logger)).not.toContain(BODY_MARKER);
  });
});
