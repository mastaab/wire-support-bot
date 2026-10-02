import { describe, it, expect, vi } from "vitest";
import {
  AskForAgentConversation, agentChatChoices, agentChatFailed, agentChatQuestion, agentChatRequestDone,
} from "../../src/application/usecases/jira/AskForAgentConversation";
import type { OpenAgentConversation, OpenAgentConversationInput, OpenAgentConversationOutcome } from "../../src/application/usecases/jira/OpenAgentConversation";
import { DeskUpdateQuestions } from "../../src/application/services/deskUpdateQuestions";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import { sweepEndedOfferPrompts } from "../../src/application/services/offerPromptClosing";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { WireUserRef } from "../../src/application/ports/WireConversationPort";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import {
  alice, convId, loggedText, makeLogger, makeRequest, makeRequests, makeWire, sentRefFor,
} from "./supportRequestFakes";

const T0 = new Date("2026-10-02T10:00:00Z");
const HOURS_4 = 4 * 60 * 60 * 1000;
const agentId: QualifiedId = { id: "agent-1", domain: "example.com" };
const QUESTION = "Alice, the service desk assigned Kim Desk to **SD-6**. Would you like a direct conversation with them?";

function setup(options: { agent?: WireUserRef | null; records?: SupportRequest[] } = {}) {
  const records = options.records ?? [makeRequest({ statusCategory: "in_progress" })];
  const requests = makeRequests(records);
  const conversations = {
    findUserByHandle: vi.fn(async (_handle: string) => (options.agent === undefined ? { id: agentId, name: "Kim Desk" } : options.agent)),
    createGroup: vi.fn(),
    makeAdmin: vi.fn(),
    leave: vi.fn(),
    track: vi.fn(),
  };
  const offers = new InMemoryPendingOfferStore();
  const { wire, sent } = makeWire();
  const logger = makeLogger();
  const open = { execute: vi.fn(async (_input: OpenAgentConversationInput): Promise<OpenAgentConversationOutcome> => "opened") };
  const asker = new AskForAgentConversation({
    requests, conversations, offers, wireOutbound: wire, open: open as unknown as OpenAgentConversation,
    projectKey: "SD", lifetimeMs: HOURS_4, logger, now: () => T0,
  });
  const labels = (): string[][] => wire.sendCompositePrompt.mock.calls.map((call) => (call[2] as Array<{ label: string }>).map((b) => b.label));
  return { records, requests, conversations, offers, wire, sent, logger, open, asker, labels };
}

const otherOffer = () => ({
  command: { kind: "resolve" as const, issueKey: "SD-7" }, conversationId: convId, requesterId: alice,
  createdAt: T0, expiresAt: new Date(T0.getTime() + 10 * 60 * 1000),
});

describe("agent conversation question texts", () => {
  it("names the requester and the agent, with a text hint for clients without buttons", () => {
    expect(agentChatQuestion("SD-6", "Kim Desk", "Alice")).toBe(`${QUESTION}\n\n(open or not now)?`);
    expect(agentChatQuestion("SD-6", "Kim Desk")).toBe(
      "The service desk assigned Kim Desk to **SD-6**. Would you like a direct conversation with them?\n\n(open or not now)?");
    expect(agentChatQuestion("SD-6", " ", "Alice")).toContain("assigned an agent to **SD-6**");
  });

  it("offers [Open direct chat], which opens the conversation, and [Not now], which only closes the question", () => {
    const [open, notNow] = agentChatChoices("SD-6", "kim.desk");
    expect(open).toMatchObject({ label: "Open direct chat", command: null, then: { kind: "openAgentChat", issueKey: "SD-6", agentHandle: "kim.desk" } });
    expect(open!.answers).toEqual(expect.arrayContaining(["open", "yes"]));
    expect(notNow).toEqual(expect.objectContaining({ label: "Not now", command: null }));
    expect(notNow!.then).toBeUndefined();
    expect(notNow!.answers).toEqual(expect.arrayContaining(["not now", "no"]));
  });
});

describe("AskForAgentConversation.ask", () => {
  it("asks the requester with buttons, claims the request and stores the question for the requester's slot", async () => {
    const { asker, wire, sent, requests, offers, labels, conversations } = setup();
    expect(await asker.ask(makeRequest(), "kim.desk")).toBe("asked");
    expect(conversations.findUserByHandle).toHaveBeenCalledWith("kim.desk");
    expect(sent).toEqual([QUESTION]);
    expect(labels()).toEqual([["Open direct chat", "Not now"]]);
    // A separate message, not a reply, and not stored as the request's last message.
    expect(wire.sendCompositePrompt.mock.calls[0][3]).toEqual({ replyToMessageId: undefined });
    expect(requests.setLastMessage).not.toHaveBeenCalled();
    expect(requests.markAgentConversation).toHaveBeenCalledWith("SD-6", T0);
    expect(offers.find(convId, alice, T0)).toMatchObject({
      messageId: sentRefFor(1).messageId, deskUpdate: { issueKey: "SD-6" }, keepsSlot: true,
      expiresAt: new Date(T0.getTime() + HOURS_4), question: QUESTION,
    });
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it("is busy, sending and claiming nothing, while the requester has another open question", async () => {
    const { asker, wire, requests, offers, conversations } = setup();
    offers.put(otherOffer());
    expect(await asker.ask(makeRequest(), "kim.desk")).toBe("busy");
    expect(conversations.findUserByHandle).not.toHaveBeenCalled();
    expect(wire.sendCompositePrompt).not.toHaveBeenCalled();
    expect(requests.markAgentConversation).not.toHaveBeenCalled();
    expect(offers.find(convId, alice, T0)).toEqual(otherOffer());
  });

  it("is busy while another agent conversation question is open", async () => {
    const { asker, wire } = setup();
    expect(await asker.ask(makeRequest(), "kim.desk")).toBe("asked");
    expect(await asker.ask(makeRequest({ key: "SD-7" }), "kim.desk")).toBe("busy");
    expect(wire.sendCompositePrompt).toHaveBeenCalledOnce();
  });

  it("replaces an open desk-update question, which is closed at once, and is not replaced by a later one", async () => {
    const { asker, wire, offers, logger } = setup();
    const desk = new DeskUpdateQuestions({ offers, wireOutbound: wire, lifetimeMs: HOURS_4, logger, now: () => T0 });
    expect(await desk.ask(makeRequest(), "reply")).toBe(true);
    expect(await asker.ask(makeRequest(), "kim.desk")).toBe("asked");
    expect(wire.closeButtonPrompt).toHaveBeenCalledWith(convId, sentRefFor(1).messageId,
      "Alice, would you like to reply to the service desk about **SD-6**, or is it solved so I can close it?\n\nThis question was replaced by a newer one.");
    // A later desk-update question does not take the slot.
    expect(await desk.ask(makeRequest(), "resolved")).toBe(false);
    expect(offers.find(convId, alice, T0)).toMatchObject({ keepsSlot: true, messageId: sentRefFor(2).messageId });
  });

  it("skips an agent handle that does not resolve and an agent who is the requester, asking nothing", async () => {
    for (const agent of [null, { id: alice, name: "Alice" }]) {
      const { asker, wire, requests } = setup({ agent });
      expect(await asker.ask(makeRequest(), "kim.desk")).toBe("skipped");
      expect(wire.sendCompositePrompt).not.toHaveBeenCalled();
      expect(requests.markAgentConversation).not.toHaveBeenCalled();
    }
  });

  it("fails without claiming when resolving the agent or sending the question fails, logging error names only", async () => {
    const resolving = setup();
    resolving.conversations.findUserByHandle.mockRejectedValue(new Error("search down"));
    expect(await resolving.asker.ask(makeRequest(), "kim.desk")).toBe("failed");
    expect(resolving.requests.markAgentConversation).not.toHaveBeenCalled();

    const sending = setup();
    sending.wire.sendCompositePrompt.mockRejectedValueOnce(new Error("offline"));
    expect(await sending.asker.ask(makeRequest(), "kim.desk")).toBe("failed");
    expect(sending.requests.markAgentConversation).not.toHaveBeenCalled();
    expect(sending.offers.find(convId, alice, T0)).toBeNull();
    expect(sending.logger.warn).toHaveBeenCalledWith("AskForAgentConversation: sending the question failed", { key: "SD-6", err: "Error" });
    for (const text of [loggedText(resolving.logger), loggedText(sending.logger)]) {
      expect(text).not.toContain("Kim Desk");
      expect(text).not.toContain("kim.desk");
      expect(text).not.toContain("Alice");
    }
  });

  it("closes the sent question when the request was already claimed, storing nothing", async () => {
    const { asker, wire, requests, offers } = setup();
    requests.markAgentConversation.mockResolvedValue(false);
    expect(await asker.ask(makeRequest(), "kim.desk")).toBe("skipped");
    expect(wire.closeButtonPrompt).toHaveBeenCalledWith(convId, sentRefFor(1).messageId, `${QUESTION}\n\nThis question was replaced by a newer one.`);
    expect(offers.find(convId, alice, T0)).toBeNull();
  });

  it("closes an unanswered question when its lifetime is over", async () => {
    const { asker, wire, offers } = setup();
    await asker.ask(makeRequest(), "kim.desk");
    await sweepEndedOfferPrompts({ offers, wireOutbound: wire }, new Date(T0.getTime() + HOURS_4 - 1));
    expect(wire.closeButtonPrompt).not.toHaveBeenCalled();
    await sweepEndedOfferPrompts({ offers, wireOutbound: wire }, new Date(T0.getTime() + HOURS_4));
    expect(wire.closeButtonPrompt).toHaveBeenCalledWith(convId, sentRefFor(1).messageId, `${QUESTION}\n\nThis question has expired.`);
    expect(offers.find(convId, alice, new Date(T0.getTime() + HOURS_4))).toBeNull();
  });
});

describe("AskForAgentConversation.accept", () => {
  const input = { issueKey: "SD-6", agentHandle: "kim.desk", conversationId: convId, requesterId: alice, replyToMessageId: "click-1" };

  it("runs the existing open flow for the re-read request, as already claimed, and posts nothing itself", async () => {
    const { asker, open, wire } = setup();
    await asker.accept(input);
    expect(open.execute).toHaveBeenCalledExactlyOnceWith({
      request: expect.objectContaining({ key: "SD-6", statusCategory: "in_progress" }), agentHandle: "kim.desk", claimed: true,
    });
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it.each(["skipped", "failed"] as const)("says so when the open flow is %s", async (outcome) => {
    const { asker, open, sent } = setup();
    open.execute.mockResolvedValue(outcome);
    await asker.accept(input);
    expect(sent).toEqual([agentChatFailed("SD-6")]);
    expect(agentChatFailed("SD-6")).toBe("I'm afraid I couldn't open the direct conversation for **SD-6**.");
  });

  it("says so when the open flow throws", async () => {
    const { asker, open, sent, logger } = setup();
    open.execute.mockRejectedValue(new Error("boom"));
    await asker.accept(input);
    expect(sent).toEqual([agentChatFailed("SD-6")]);
    expect(logger.warn).toHaveBeenCalledWith("AskForAgentConversation: opening the conversation failed", { key: "SD-6", err: "Error" });
  });

  it("opens nothing for a request resolved meanwhile", async () => {
    const { asker, open, sent } = setup({ records: [makeRequest({ statusCategory: "done" })] });
    await asker.accept(input);
    expect(open.execute).not.toHaveBeenCalled();
    expect(sent).toEqual([agentChatRequestDone("SD-6")]);
    expect(agentChatRequestDone("SD-6")).toBe("**SD-6** is already resolved, so I haven't opened a direct conversation.");
  });

  it.each([
    ["deleted", [makeRequest({ deleted: true })]],
    ["in another conversation", [makeRequest({ conversationId: { id: "conv-2", domain: "example.com" } })]],
    ["unknown", []],
    ["raised by someone else", [makeRequest({ requesterId: { id: "user-2", domain: "example.com" } })]],
  ])("opens nothing for a request %s", async (_label, records) => {
    const { asker, open, sent } = setup({ records: records as SupportRequest[] });
    await asker.accept(input);
    expect(open.execute).not.toHaveBeenCalled();
    expect(sent).toEqual([agentChatFailed("SD-6")]);
  });
});
