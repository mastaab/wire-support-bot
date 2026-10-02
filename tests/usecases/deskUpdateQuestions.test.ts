import { describe, it, expect } from "vitest";
import {
  DeskUpdateQuestions, deskUpdateChoices, deskUpdateQuestion, replyTextQuestion,
} from "../../src/application/services/deskUpdateQuestions";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import { OFFER_TTL_MS } from "../../src/application/services/offers";
import { matchChoice } from "../../src/application/services/offerButtons";
import { sweepEndedOfferPrompts } from "../../src/application/services/offerPromptClosing";
import { alice, bob, convId, makeLogger, makeRequest, makeWire, sentRefFor } from "./supportRequestFakes";

const now = new Date("2026-10-02T10:00:00Z");
const HOURS_4 = 4 * 60 * 60 * 1000;

function setup(lifetimeMs = HOURS_4) {
  const offers = new InMemoryPendingOfferStore();
  const { wire, sent } = makeWire();
  const logger = makeLogger();
  const questions = new DeskUpdateQuestions({ offers, wireOutbound: wire, lifetimeMs, logger, now: () => now });
  return { offers, wire, sent, logger, questions };
}

describe("deskUpdateQuestion texts and options", () => {
  it("asks after a desk reply whether to reply or close, naming the requester", () => {
    expect(deskUpdateQuestion("reply", "SD-6", "Alice")).toBe(
      "Alice, would you like to reply to the service desk about **SD-6**, or is it solved so I can close it?\n\n(reply, solved or no)?",
    );
    expect(deskUpdateChoices("reply", "SD-6").map((c) => c.label)).toEqual(["Reply", "Solved, close it"]);
  });

  it("asks after a resolve whether it is solved, and words the question without a name when there is none", () => {
    expect(deskUpdateQuestion("resolved", "SD-6", "")).toBe("Is **SD-6** solved for you, or is it still broken?\n\n(solved, still broken or no)?");
    expect(deskUpdateChoices("resolved", "SD-6").map((c) => c.label)).toEqual(["Solved", "Still broken"]);
  });

  it("builds every option in code: [Reply] and [Still broken] ask for text, [Solved, close it] resolves, [Solved] does nothing", () => {
    const [reply, close] = deskUpdateChoices("reply", "SD-6");
    expect(reply).toMatchObject({ command: null, asksReplyText: "reply" });
    expect(close).toMatchObject({ command: { kind: "resolve", issueKey: "SD-6" } });
    const [solved, broken] = deskUpdateChoices("resolved", "SD-6");
    expect(solved).toMatchObject({ command: null });
    expect(solved!.asksReplyText).toBeUndefined();
    expect(broken).toMatchObject({ command: null, asksReplyText: "stillBroken" });
  });

  it("takes the text answers reply, solved and still broken, but no number of a quantity or a bare 'no'", () => {
    const afterReply = deskUpdateChoices("reply", "SD-6");
    const afterResolve = deskUpdateChoices("resolved", "SD-6");
    expect(matchChoice(afterReply, "reply")).toBe(0);
    expect(matchChoice(afterReply, "Solved!")).toBe(1);
    expect(matchChoice(afterReply, "yes")).toBeNull();
    expect(matchChoice(afterReply, "no")).toBeNull();
    expect(matchChoice(afterResolve, "solved, thanks")).toBe(0);
    expect(matchChoice(afterResolve, "Still broken.")).toBe(1);
    expect(matchChoice(afterResolve, "no")).toBeNull();
  });

  it("asks for the reply text, saying nothing is sent before a confirmation", () => {
    expect(replyTextQuestion("SD-6", "reply")).toBe(
      "What shall I send to the service desk? Your next message here becomes the reply to **SD-6**; I'll ask before sending it.",
    );
    expect(replyTextQuestion("SD-6", "stillBroken")).toBe(
      "What is still wrong? Your next message here becomes the reply to **SD-6**; I'll ask before sending it.",
    );
  });
});

describe("DeskUpdateQuestions.ask", () => {
  it("sends the question with buttons and without the hint, and stores it for the requester for the configured lifetime", async () => {
    const { offers, wire, sent, questions } = setup();

    expect(await questions.ask(makeRequest(), "reply")).toBe(true);

    expect(sent).toEqual(["Alice, would you like to reply to the service desk about **SD-6**, or is it solved so I can close it?"]);
    const stored = offers.find(convId, alice, now)!;
    expect(wire.sendCompositePrompt).toHaveBeenCalledWith(convId, sent[0], [
      { id: `${stored.id}:0`, label: "Reply" }, { id: `${stored.id}:1`, label: "Solved, close it" },
    ], { replyToMessageId: undefined });
    expect(wire.sendPlainText).not.toHaveBeenCalled();
    expect(stored).toMatchObject({
      requesterId: alice,
      messageId: sentRefFor(1).messageId,
      question: sent[0],
      deskUpdate: { issueKey: "SD-6", summary: "VPN drops every ten minutes" },
      expiresAt: new Date(now.getTime() + HOURS_4),
    });
    expect(stored.choices!.map((c) => c.label)).toEqual(["Reply", "Solved, close it"]);
  });

  it("asks only the request's requester", async () => {
    const { offers, questions } = setup();
    await questions.ask(makeRequest({ requesterId: bob, requesterName: "Bob" }), "resolved");
    expect(offers.find(convId, alice, now)).toBeNull();
    expect(offers.find(convId, bob, now)?.deskUpdate?.issueKey).toBe("SD-6");
  });

  it("asks nothing while the requester has another open question, which stays", async () => {
    const { offers, wire, questions, logger } = setup();
    const other = {
      command: { kind: "resolve" as const, issueKey: "SD-7" }, conversationId: convId, requesterId: alice,
      createdAt: now, expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
    };
    offers.put(other);

    expect(await questions.ask(makeRequest(), "reply")).toBe(false);

    expect(wire.sendCompositePrompt).not.toHaveBeenCalled();
    expect(offers.find(convId, alice, now)).toEqual(other);
    expect(logger.info).toHaveBeenCalled();
  });

  it("replaces an earlier desk-update question to the requester and closes it at once", async () => {
    const { offers, wire, sent, questions } = setup();
    await questions.ask(makeRequest(), "reply");
    await questions.ask(makeRequest(), "resolved");

    expect(wire.closeButtonPrompt).toHaveBeenCalledOnce();
    expect(wire.closeButtonPrompt).toHaveBeenCalledWith(convId, sentRefFor(1).messageId, `${sent[0]}\n\nThis question was replaced by a newer one.`);
    expect(offers.find(convId, alice, now)!.choices!.map((c) => c.label)).toEqual(["Solved", "Still broken"]);
  });

  it("closes an unanswered question as expired after its lifetime", async () => {
    const { wire, sent, questions, offers } = setup();
    await questions.ask(makeRequest(), "resolved");

    await sweepEndedOfferPrompts({ offers, wireOutbound: wire }, new Date(now.getTime() + HOURS_4 - 1));
    expect(wire.closeButtonPrompt).not.toHaveBeenCalled();
    await sweepEndedOfferPrompts({ offers, wireOutbound: wire }, new Date(now.getTime() + HOURS_4));
    expect(wire.closeButtonPrompt).toHaveBeenCalledWith(convId, sentRefFor(1).messageId, `${sent[0]}\n\nThis question has expired.`);
  });

  it("asks nothing with a lifetime of 0", async () => {
    const { wire, questions } = setup(0);
    expect(await questions.ask(makeRequest(), "reply")).toBe(false);
    expect(wire.sendCompositePrompt).not.toHaveBeenCalled();
  });

  it("logs a failed send by error name and stores nothing", async () => {
    const { offers, wire, logger, questions } = setup();
    wire.sendCompositePrompt.mockRejectedValueOnce(new TypeError("socket closed"));
    expect(await questions.ask(makeRequest(), "reply")).toBe(false);
    expect(offers.find(convId, alice, now)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith("DeskUpdateQuestions: sending the question failed", { key: "SD-6", err: "TypeError" });
  });

  it("keeps a question asked meanwhile and closes its own message at once", async () => {
    const { offers, wire, questions } = setup();
    const other = {
      command: { kind: "resolve" as const, issueKey: "SD-7" }, conversationId: convId, requesterId: alice,
      createdAt: now, expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
    };
    wire.sendCompositePrompt.mockImplementationOnce(async () => {
      offers.put(other);
      return sentRefFor(1);
    });

    expect(await questions.ask(makeRequest(), "reply")).toBe(false);

    expect(offers.find(convId, alice, now)).toEqual(other);
    expect(wire.closeButtonPrompt).toHaveBeenCalledWith(
      convId, sentRefFor(1).messageId,
      "Alice, would you like to reply to the service desk about **SD-6**, or is it solved so I can close it?\n\nThis question was replaced by a newer one.",
    );
  });
});
