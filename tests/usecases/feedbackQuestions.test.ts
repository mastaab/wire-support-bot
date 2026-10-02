import { describe, it, expect } from "vitest";
import { FeedbackQuestions, feedbackChoices, feedbackQuestion } from "../../src/application/services/feedbackQuestions";
import { AskForAgentConversation } from "../../src/application/usecases/jira/AskForAgentConversation";
import type { OpenAgentConversation } from "../../src/application/usecases/jira/OpenAgentConversation";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import { sweepEndedOfferPrompts } from "../../src/application/services/offerPromptClosing";
import { matchChoice } from "../../src/application/services/offerButtons";
import { alice, convId, makeLogger, makeRequest, makeRequests, makeWire, sentRefFor } from "./supportRequestFakes";

const T0 = new Date("2026-10-02T10:00:00Z");
const HOURS_4 = 4 * 60 * 60 * 1000;
const QUESTION = "Alice, how did the service desk do on **SD-6**? 1 is poor, 5 is great.";
const target = { issueKey: "SD-6", summary: "VPN drops every ten minutes" };

function setup() {
  const offers = new InMemoryPendingOfferStore();
  const { wire, sent } = makeWire();
  const logger = makeLogger();
  const questions = new FeedbackQuestions({ offers, wireOutbound: wire, lifetimeMs: HOURS_4, logger, now: () => T0 });
  const ask = () => questions.ask({ target, conversationId: convId, requesterId: alice, requesterName: "Alice" });
  const labels = (): string[][] => wire.sendCompositePrompt.mock.calls.map((call) => (call[2] as Array<{ label: string }>).map((b) => b.label));
  return { offers, wire, sent, logger, questions, ask, labels };
}

describe("feedback question texts", () => {
  it("names the requester and explains the scale, with a text hint for clients without buttons", () => {
    expect(feedbackQuestion("SD-6", "Alice")).toBe(`${QUESTION}\n\n(1 to 5, or no)?`);
    expect(feedbackQuestion("SD-6")).toBe("How did the service desk do on **SD-6**? 1 is poor, 5 is great.\n\n(1 to 5, or no)?");
  });

  it("offers [1] to [5], each sending its rating", () => {
    const choices = feedbackChoices("SD-6");
    expect(choices.map((c) => c.label)).toEqual(["1", "2", "3", "4", "5"]);
    choices.forEach((choice, index) => {
      expect(choice.command).toBeNull();
      expect(choice.then).toEqual({ kind: "rate", issueKey: "SD-6", rating: index + 1 });
    });
    expect(matchChoice(choices, "4")).toBe(3);
    expect(matchChoice(choices, "five")).toBe(4);
    expect(matchChoice(choices, "1/5")).toBe(0);
    expect(matchChoice(choices, "no")).toBeNull();
  });
});

describe("FeedbackQuestions.ask", () => {
  it("asks the requester with [1] to [5] and stores the question with the desk-update lifetime", async () => {
    const { ask, sent, labels, offers, wire } = setup();
    expect(await ask()).toBe(true);
    expect(sent).toEqual([QUESTION]);
    expect(labels()).toEqual([["1", "2", "3", "4", "5"]]);
    expect(wire.sendPlainText).not.toHaveBeenCalled();
    expect(offers.find(convId, alice, T0)).toMatchObject({
      messageId: sentRefFor(1).messageId, deskUpdate: target, expiresAt: new Date(T0.getTime() + HOURS_4), question: QUESTION,
    });
  });

  it("does not ask over the requester's other open question or an agent conversation question", async () => {
    const { ask, offers, wire, logger } = setup();
    offers.put({
      command: { kind: "resolve", issueKey: "SD-7" }, conversationId: convId, requesterId: alice,
      createdAt: T0, expiresAt: new Date(T0.getTime() + 10 * 60 * 1000),
    });
    expect(await ask()).toBe(false);
    expect(wire.sendCompositePrompt).not.toHaveBeenCalled();

    const other = setup();
    const asker = new AskForAgentConversation({
      requests: makeRequests(), offers: other.offers, wireOutbound: other.wire, open: {} as OpenAgentConversation, projectKey: "SD",
      conversations: {
        findUserByHandle: async () => ({ id: { id: "agent-1", domain: "example.com" }, name: "Kim Desk" }),
        createGroup: async () => convId, makeAdmin: async () => undefined, leave: async () => undefined, track: () => undefined,
      },
      lifetimeMs: HOURS_4, logger, now: () => T0,
    });
    expect(await asker.ask(makeRequest(), "kim.desk")).toBe("asked");
    expect(await other.ask()).toBe(false);
    expect(other.wire.sendCompositePrompt).toHaveBeenCalledOnce();
  });

  it("logs a failed send by error name and stores nothing", async () => {
    const { ask, wire, offers, logger } = setup();
    wire.sendCompositePrompt.mockRejectedValueOnce(new Error("offline"));
    expect(await ask()).toBe(false);
    expect(offers.find(convId, alice, T0)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith("FeedbackQuestions: sending the question failed", { key: "SD-6", err: "Error" });
  });

  it("closes an unanswered question when its lifetime is over", async () => {
    const { ask, wire, offers } = setup();
    await ask();
    await sweepEndedOfferPrompts({ offers, wireOutbound: wire }, new Date(T0.getTime() + HOURS_4));
    expect(wire.closeButtonPrompt).toHaveBeenCalledWith(convId, sentRefFor(1).messageId, `${QUESTION}\n\nThis question has expired.`);
  });
});
