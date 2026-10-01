import { it, expect, vi } from "vitest";
import { AnswerQuestion } from "../../src/application/usecases/general/AnswerQuestion";
import type { RetrievalResult } from "../../src/application/ports/RetrievalPort";

const conversationId = { id: "channel", domain: "wire.test" };

/** The service desk with no support requests in this conversation. */
function emptyDesk() {
  return {
    tracker: {
      projectKey: "SD", createIssue: vi.fn(), getIssue: vi.fn(), resolveIssue: vi.fn(),
      listCustomerReplies: vi.fn(), addCustomerReply: vi.fn(),
    },
    requests: {
      create: vi.fn(), findByKey: vi.fn(async () => null), listByConversation: vi.fn(async () => []),
      updateStatusCategory: vi.fn(), listWatched: vi.fn(async () => []), advanceLastSeenReplyAt: vi.fn(), setLastMessage: vi.fn(),
    },
    auditLog: { append: vi.fn() },
    offers: { put: vi.fn(), take: vi.fn(() => null), has: vi.fn(() => false), clearConversation: vi.fn(), drop: vi.fn(() => null), recentlyDropped: vi.fn(() => null) },
    shareWithModel: false,
  } as never;
}

/** Everything but the channel timezone line, which every answer gets. */
function withoutTimezone(results: RetrievalResult[]): RetrievalResult[] {
  return results.filter((r) => r.id !== "channel-timezone");
}
const requester = { id: "bob", domain: "wire.test", name: "Bob" };
const members = [{ id: "alice", domain: "wire.test", name: "Alice" }, requester];

it("asks the retrieval source in the conversation's scope and passes its results, the caller and the context to the answer", async () => {
  const article: RetrievalResult = { id: "KB-1", type: "knowledge_article", content: "Hold the reset button for ten seconds.", source: "Printer manual", sourceDate: new Date() };
  const general = { answer: vi.fn().mockResolvedValue("Hold the reset button.") };
  const wire = { sendPlainText: vi.fn() };
  const retrieval = { retrieve: vi.fn().mockResolvedValue([article]) };
  const context = ["Alice: The printer is jammed."];
  await new AnswerQuestion(general, wire as never, emptyDesk(), retrieval).execute({
    question: "How do I reset it?", requester, conversationContext: context, conversationId, replyToMessageId: "q", members,
  });
  expect(retrieval.retrieve).toHaveBeenCalledWith({ question: "How do I reset it?", conversationId, requesterId: { id: "bob", domain: "wire.test" } });
  expect(general.answer).toHaveBeenCalledWith("How do I reset it?", context, expect.any(Array), members, requester);
  expect(withoutTimezone(general.answer.mock.calls[0]![2])).toEqual([article]);
  expect(wire.sendPlainText).toHaveBeenCalledWith(conversationId, "Hold the reset button.", expect.objectContaining({ replyToMessageId: "q" }));
});

it("answers without the source's results when retrieval fails, logging the error name only", async () => {
  const general = { answer: vi.fn().mockResolvedValue("Answer.") };
  const retrieval = { retrieve: vi.fn().mockRejectedValue(new TypeError("PRIVATE_MARKER")) };
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() };
  const answer = await new AnswerQuestion(general, { sendPlainText: vi.fn() } as never, emptyDesk(), retrieval, logger).execute({
    question: "Anything?", requester, conversationContext: [], conversationId, replyToMessageId: "q",
  });
  expect(answer).toBe("Answer.");
  expect(withoutTimezone(general.answer.mock.calls[0]![2])).toEqual([]);
  expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { err: "TypeError" });
});

it("answers from the conversation alone without a retrieval source", async () => {
  const general = { answer: vi.fn().mockResolvedValue("Answer.") };
  await new AnswerQuestion(general, { sendPlainText: vi.fn() } as never, emptyDesk()).execute({
    question: "Anything?", conversationContext: [], conversationId, replyToMessageId: "q",
  });
  expect(general.answer).toHaveBeenCalledWith("Anything?", [], expect.any(Array), undefined, undefined);
  expect(withoutTimezone(general.answer.mock.calls[0]![2])).toEqual([]);
});
