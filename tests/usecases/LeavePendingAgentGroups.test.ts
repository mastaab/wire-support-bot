import { describe, it, expect, vi } from "vitest";
import { LeavePendingAgentGroups } from "../../src/application/usecases/jira/LeavePendingAgentGroups";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import { loggedText, makeLogger, makeRequest, makeRequests } from "./supportRequestFakes";

const T1 = new Date("2026-10-01T09:00:00Z");
const group6: QualifiedId = { id: "group-6", domain: "example.com" };
const group7: QualifiedId = { id: "group-7", domain: "example.com" };

class NamedError extends Error {
  constructor(name: string) {
    super("secret detail that must not be logged");
    this.name = name;
  }
}

function makeConversations() {
  return {
    findUserByHandle: vi.fn(),
    createGroup: vi.fn(),
    makeAdmin: vi.fn(),
    leave: vi.fn(async (_c: QualifiedId) => undefined),
    track: vi.fn((_c: QualifiedId) => undefined),
  };
}

function setup(records: SupportRequest[]) {
  const requests = makeRequests(records);
  // The records follow the bookkeeping write, like the database.
  requests.markAgentConversationLeft.mockImplementation(async (key: string, at: Date) => {
    const found = records.find((r) => r.key === key);
    if (found) found.agentConversationLeftAt = at;
  });
  const conversations = makeConversations();
  const logger = makeLogger();
  const useCase = new LeavePendingAgentGroups(requests, conversations, logger, () => T1);
  return { requests, conversations, logger, useCase };
}

const pending = () => [
  makeRequest({ key: "SD-6", agentConversationAt: T1, agentConversationId: group6 }),
  makeRequest({ key: "SD-7", agentConversationAt: T1, agentConversationId: group7 }),
];

describe("LeavePendingAgentGroups: start-up tracking", () => {
  it("tracks every group stored but not left, so the router ignores it after a restart", async () => {
    const records = [...pending(), makeRequest({ key: "SD-8", agentConversationId: { id: "group-8", domain: "example.com" }, agentConversationLeftAt: T1 }), makeRequest({ key: "SD-9" })];
    const { useCase, conversations } = setup(records);
    expect(await useCase.track()).toBe(2);
    expect(conversations.track.mock.calls).toEqual([[group6], [group7]]);
    expect(conversations.leave).not.toHaveBeenCalled();
  });
});

describe("LeavePendingAgentGroups: retrying", () => {
  it("tries each pending group once and stores the left time of every confirmed leave", async () => {
    const { useCase, conversations, requests } = setup(pending());
    expect(await useCase.execute()).toEqual({ left: 2, pending: 0 });
    expect(conversations.leave.mock.calls).toEqual([[group6], [group7]]);
    expect(conversations.track.mock.calls).toEqual([[group6], [group7]]);
    expect(requests.markAgentConversationLeft.mock.calls).toEqual([["SD-6", T1], ["SD-7", T1]]);
  });

  it("keeps a failed group pending and leaves it on a later run; a confirmed leave stops further attempts", async () => {
    const { useCase, conversations, requests, logger } = setup(pending());
    conversations.leave.mockImplementation(async (c: QualifiedId) => {
      if (c.id === "group-6") throw new NamedError("LeaveNotConfirmedError");
    });
    expect(await useCase.execute()).toEqual({ left: 1, pending: 1 });
    expect(requests.markAgentConversationLeft.mock.calls).toEqual([["SD-7", T1]]);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { key: "SD-6", err: "LeaveNotConfirmedError" });

    conversations.leave.mockClear();
    conversations.leave.mockResolvedValue(undefined);
    expect(await useCase.execute()).toEqual({ left: 1, pending: 0 });
    expect(conversations.leave.mock.calls).toEqual([[group6]]);

    conversations.leave.mockClear();
    expect(await useCase.execute()).toEqual({ left: 0, pending: 0 });
    expect(conversations.leave).not.toHaveBeenCalled();
  });

  it("tries again on the next run when storing the left time fails", async () => {
    const { useCase, conversations, requests, logger } = setup([pending()[0]]);
    requests.markAgentConversationLeft.mockRejectedValueOnce(new NamedError("DbError"));
    expect(await useCase.execute()).toEqual({ left: 0, pending: 1 });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { key: "SD-6", err: "DbError" });
    expect(await useCase.execute()).toEqual({ left: 1, pending: 0 });
    expect(conversations.leave).toHaveBeenCalledTimes(2);
  });

  it("does nothing without pending groups", async () => {
    const { useCase, conversations } = setup([makeRequest()]);
    expect(await useCase.execute()).toEqual({ left: 0, pending: 0 });
    expect(conversations.leave).not.toHaveBeenCalled();
    expect(conversations.track).not.toHaveBeenCalled();
  });

  it("lets a failed read reach the caller, which logs it and carries on", async () => {
    const { useCase, requests } = setup(pending());
    requests.listAgentConversationsNotLeft.mockRejectedValue(new NamedError("DbError"));
    await expect(useCase.execute()).rejects.toThrow();
    await expect(useCase.track()).rejects.toThrow();
  });

  it("logs error names and keys only, never group IDs or error messages", async () => {
    const { useCase, conversations, requests, logger } = setup(pending());
    conversations.leave.mockRejectedValueOnce(new NamedError("LeaveError"));
    requests.markAgentConversationLeft.mockRejectedValueOnce(new NamedError("DbError"));
    await useCase.execute();
    const text = loggedText(logger);
    for (const value of ["group-6", "group-7", "example.com", "secret detail"]) expect(text).not.toContain(value);
  });
});
