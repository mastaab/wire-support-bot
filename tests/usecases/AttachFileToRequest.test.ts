import { describe, it, expect, vi } from "vitest";
import { AttachFileToRequest } from "../../src/application/usecases/jira/AttachFileToRequest";
import { IssueTrackerError } from "../../src/application/ports/IssueTrackerPort";
import { ATTACHMENT_MAX_BYTES } from "../../src/application/services/attachments";
import type { InboundFile } from "../../src/application/ports/PendingOfferPort";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import {
  OUT_OF_SCOPE, alice, convId, loggedText, makeAudit, makeLogger, makeRequest, makeRequests, makeTracker, makeWire, sentRefFor,
} from "./supportRequestFakes";

const PHOTO: InboundFile = {
  ref: { transport: "wire", data: { assetId: "asset-1", token: "secret-token" } },
  fileKind: "photo",
  name: "IMG_0042.jpg",
  mimeType: "image/jpeg",
  sizeInBytes: 4,
};
const DOCUMENT: InboundFile = { ...PHOTO, fileKind: "file", name: "service-log.pdf", mimeType: "application/pdf; name=service-log.pdf" };
const BYTES = new Uint8Array([1, 2, 3, 4]);

function makeAssets(data: Uint8Array = BYTES) {
  return { download: vi.fn().mockResolvedValue(data) };
}

function setup(records: SupportRequest[] = [makeRequest()]) {
  const requests = makeRequests(records);
  const tracker = makeTracker();
  const assets = makeAssets();
  const { wire, sent } = makeWire();
  const auditLog = makeAudit();
  const logger = makeLogger();
  const useCase = new AttachFileToRequest(requests, tracker, assets, wire, auditLog, logger);
  return { requests, tracker, assets, wire, sent, auditLog, logger, useCase };
}

const input = { issueKey: "SD-6", file: PHOTO, conversationId: convId, actorId: alice, senderName: "Alice", replyToMessageId: "msg-9" };

function expectAudited(auditLog: ReturnType<typeof makeAudit>, mimeType: string, sizeInBytes: number, outcome: string): void {
  expect(auditLog.append).toHaveBeenCalledTimes(1);
  const entry = auditLog.append.mock.calls[0]![0];
  expect(entry).toEqual({
    timestamp: expect.any(Date),
    actorId: alice,
    conversationId: convId,
    action: "entity_updated",
    entityType: "SupportRequest",
    entityId: "SD-6",
    details: { attachment: { mimeType, sizeInBytes }, outcome },
  });
  const serialised = JSON.stringify(entry);
  expect(serialised).not.toContain("IMG_0042");
  expect(serialised).not.toContain("service-log");
  expect(serialised).not.toContain("secret-token");
}

function expectSingleReplyStored(
  { wire, sent, requests }: Pick<ReturnType<typeof setup>, "wire" | "sent" | "requests">, text: string,
): void {
  expect(sent).toEqual([text]);
  expect(wire.sendPlainText).toHaveBeenCalledWith(convId, text, { replyToMessageId: "msg-9" });
  expect(requests.setLastMessage).toHaveBeenCalledTimes(1);
  expect(requests.setLastMessage).toHaveBeenCalledWith("SD-6", sentRefFor(1));
}

describe("AttachFileToRequest", () => {
  it("attaches a photo with the sender's comment, audits it, replies and stores the reply", async () => {
    const { requests, tracker, assets, wire, sent, auditLog, useCase } = setup();

    expect(await useCase.execute(input)).toBe(true);

    expect(assets.download).toHaveBeenCalledWith(PHOTO.ref);
    expect(tracker.addCustomerAttachment).toHaveBeenCalledWith(
      "SD-6", { name: "IMG_0042.jpg", mimeType: "image/jpeg", data: BYTES }, "Photo from Wire, sent by Alice. Sent from Wire.",
    );
    expectAudited(auditLog, "image/jpeg", 4, "attached");
    expectSingleReplyStored({ wire, sent, requests }, "Added the photo to **SD-6** in Jira.");
  });

  it("attaches a document by name and names it in the reply", async () => {
    const { requests, tracker, wire, sent, auditLog, useCase } = setup();

    expect(await useCase.execute({ ...input, file: DOCUMENT })).toBe(true);

    expect(tracker.addCustomerAttachment).toHaveBeenCalledWith(
      "SD-6", { name: "service-log.pdf", mimeType: "application/pdf; name=service-log.pdf", data: BYTES }, "File from Wire, sent by Alice. Sent from Wire.",
    );
    expectAudited(auditLog, "application/pdf", 4, "attached");
    expectSingleReplyStored({ wire, sent, requests }, "Added the file (service-log.pdf) to **SD-6** in Jira.");
  });

  it("writes the comment without a name when none was resolved", async () => {
    const { tracker, useCase } = setup();

    expect(await useCase.execute({ ...input, senderName: undefined })).toBe(true);

    expect(tracker.addCustomerAttachment).toHaveBeenCalledWith("SD-6", expect.anything(), "Photo from Wire. Sent from Wire.");
  });

  it("normalises the key before the scope check", async () => {
    const { tracker, useCase } = setup();

    expect(await useCase.execute({ ...input, issueKey: " sd-6 " })).toBe(true);

    expect(tracker.addCustomerAttachment).toHaveBeenCalledWith("SD-6", expect.anything(), expect.any(String));
  });

  it.each(OUT_OF_SCOPE)("refuses a request %s without downloading, attaching, auditing or storing", async (_label, records, key) => {
    const { requests, tracker, assets, wire, sent, auditLog, useCase } = setup(records);

    expect(await useCase.execute({ ...input, issueKey: key })).toBe(false);

    expect(sent).toEqual([`I'm afraid **${key}** isn't a support request in this conversation.`]);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-9" });
    expect(assets.download).not.toHaveBeenCalled();
    expect(tracker.addCustomerAttachment).not.toHaveBeenCalled();
    expect(auditLog.append).not.toHaveBeenCalled();
    expect(requests.setLastMessage).not.toHaveBeenCalled();
  });

  it.each([
    [PHOTO, "**SD-6** is already resolved, so I haven't added the photo."],
    [DOCUMENT, "**SD-6** is already resolved, so I haven't added the file."],
  ])("does not attach to a request last known as done", async (file, text) => {
    const { requests, tracker, assets, wire, sent, auditLog, useCase } = setup([makeRequest({ statusCategory: "done" })]);

    expect(await useCase.execute({ ...input, file })).toBe(false);

    expect(assets.download).not.toHaveBeenCalled();
    expect(tracker.addCustomerAttachment).not.toHaveBeenCalled();
    expect(auditLog.append).not.toHaveBeenCalled();
    expectSingleReplyStored({ wire, sent, requests }, text);
  });

  describe("download", () => {
    it.each([
      [PHOTO, "I'm afraid I couldn't fetch the photo from Wire, so I haven't added it to **SD-6**."],
      [DOCUMENT, "I'm afraid I couldn't fetch the file from Wire, so I haven't added it to **SD-6**."],
    ])("reports a failed download plainly and logs the error name only", async (file, text) => {
      const { requests, tracker, assets, wire, sent, auditLog, logger, useCase } = setup();
      assets.download.mockRejectedValueOnce(new TypeError("could not decrypt IMG_0042.jpg secret-token"));

      expect(await useCase.execute({ ...input, file })).toBe(false);

      expect(tracker.addCustomerAttachment).not.toHaveBeenCalled();
      expect(auditLog.append).not.toHaveBeenCalled();
      expectSingleReplyStored({ wire, sent, requests }, text);
      expect(logger.warn).toHaveBeenCalledWith("AttachFileToRequest: download failed", { key: "SD-6", err: "TypeError" });
      const logged = loggedText(logger);
      expect(logged).not.toContain("IMG_0042");
      expect(logged).not.toContain("secret-token");
    });

    it("refuses a download larger than the limit", async () => {
      const { requests, tracker, assets, wire, sent, auditLog, useCase } = setup();
      assets.download.mockResolvedValueOnce(new Uint8Array(ATTACHMENT_MAX_BYTES + 1));

      expect(await useCase.execute(input)).toBe(false);

      expect(tracker.addCustomerAttachment).not.toHaveBeenCalled();
      expect(auditLog.append).not.toHaveBeenCalled();
      expectSingleReplyStored({ wire, sent, requests }, "I'm afraid I couldn't fetch the photo from Wire, so I haven't added it to **SD-6**.");
    });

    it("accepts a download of exactly the limit", async () => {
      const { tracker, assets, auditLog, useCase } = setup();
      assets.download.mockResolvedValueOnce(new Uint8Array(ATTACHMENT_MAX_BYTES));

      expect(await useCase.execute(input)).toBe(true);

      expect(tracker.addCustomerAttachment).toHaveBeenCalledTimes(1);
      expectAudited(auditLog, "image/jpeg", ATTACHMENT_MAX_BYTES, "attached");
    });

    it("does not download a file whose posted size is over the limit", async () => {
      const { requests, tracker, assets, wire, sent, useCase } = setup();

      expect(await useCase.execute({ ...input, file: { ...PHOTO, sizeInBytes: ATTACHMENT_MAX_BYTES + 1 } })).toBe(false);

      expect(assets.download).not.toHaveBeenCalled();
      expect(tracker.addCustomerAttachment).not.toHaveBeenCalled();
      expectSingleReplyStored({ wire, sent, requests }, "I'm afraid I couldn't fetch the photo from Wire, so I haven't added it to **SD-6**.");
    });
  });

  describe("upload", () => {
    it.each([
      [PHOTO, "I'm afraid the service desk didn't accept the photo for **SD-6**.", "image/jpeg"],
      [DOCUMENT, "I'm afraid the service desk didn't accept the file for **SD-6**.", "application/pdf"],
    ])("reports a refused upload and audits the attempt", async (file, text, mimeType) => {
      const { requests, tracker, wire, sent, auditLog, logger, useCase } = setup();
      tracker.addCustomerAttachment.mockRejectedValueOnce(new IssueTrackerError("Jira refused the attachment", 415));

      expect(await useCase.execute({ ...input, file })).toBe(false);

      expectAudited(auditLog, mimeType, 4, "attach_refused");
      expectSingleReplyStored({ wire, sent, requests }, text);
      expect(logger.warn).toHaveBeenCalledWith("AttachFileToRequest: addCustomerAttachment failed", { key: "SD-6", err: "IssueTrackerError", status: 415 });
    });

    it.each([
      ["a 5xx", new IssueTrackerError("Jira failed", 502)],
      ["a timeout", new IssueTrackerError("Jira timed out")],
      ["an unexpected error", new Error("socket hang up")],
    ])("reports %s as unconfirmed without inviting a retry, and audits it", async (_label, err) => {
      const { requests, tracker, wire, sent, auditLog, useCase } = setup();
      tracker.addCustomerAttachment.mockRejectedValueOnce(err);

      expect(await useCase.execute(input)).toBe(false);

      expectAudited(auditLog, "image/jpeg", 4, "attach_unconfirmed");
      expectSingleReplyStored({ wire, sent, requests },
        "I'm afraid I couldn't confirm that the photo reached **SD-6**; please check the ticket before sending it again.");
    });

    it("words the unconfirmed reply for a document", async () => {
      const { tracker, sent, useCase } = setup();
      tracker.addCustomerAttachment.mockRejectedValueOnce(new IssueTrackerError("Jira failed", 500));

      expect(await useCase.execute({ ...input, file: DOCUMENT })).toBe(false);

      expect(sent).toEqual(["I'm afraid I couldn't confirm that the file reached **SD-6**; please check the ticket before sending it again."]);
    });

    it("still reports success when the audit append fails", async () => {
      const { tracker, sent, auditLog, logger, useCase } = setup();
      auditLog.append.mockRejectedValueOnce(new RangeError("audit down"));

      expect(await useCase.execute(input)).toBe(true);

      expect(tracker.addCustomerAttachment).toHaveBeenCalledTimes(1);
      expect(sent).toEqual(["Added the photo to **SD-6** in Jira."]);
      expect(logger.error).toHaveBeenCalledWith("AttachFileToRequest: audit append failed", { err: "RangeError" });
    });
  });

  it("stores nothing when the transport returns no reference", async () => {
    const { requests, wire, useCase } = setup();
    wire.sendPlainText.mockResolvedValueOnce(undefined);

    expect(await useCase.execute(input)).toBe(true);

    expect(requests.setLastMessage).not.toHaveBeenCalled();
  });

  it("never logs the file name, bytes or download reference", async () => {
    const { tracker, logger, useCase } = setup();
    tracker.addCustomerAttachment.mockRejectedValueOnce(new Error("upload of service-log.pdf failed"));

    await useCase.execute({ ...input, file: DOCUMENT });

    const logged = loggedText(logger);
    expect(logged).not.toContain("service-log");
    expect(logged).not.toContain("secret-token");
    expect(logged).not.toContain("[1,2,3,4]");
  });
});
