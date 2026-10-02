import { it, expect, vi } from "vitest";
import { OpenAIGeneralAnswerAdapter, REQUIRE_OFFER_INSTRUCTION } from "../../src/infrastructure/llm/OpenAIGeneralAnswerAdapter";

it("identifies the current requester separately from earlier participants", async () => {
  const llm = { chatCompletion: vi.fn().mockResolvedValue({ content: "SD-4 is yours.", model: "test", usedFallback: false }) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
  const requester = { id: "bob", domain: "wire.test", name: "Bob" };
  const members = [{ id: "alice", domain: "wire.test", name: "Alice" }, requester];
  await new OpenAIGeneralAnswerAdapter(llm as never, logger, { jiraProjectKey: "SD" }).answer(
    "Which request is mine?", ["Alice: I raised the VPN problem for Bob."], [], members, requester,
  );
  const answerMessages = llm.chatCompletion.mock.calls[0][1];
  expect(answerMessages[0].content).toContain("Never infer the current speaker from earlier messages");
  expect(answerMessages[1].content).toContain(`## Current requester\n${JSON.stringify(requester)}`);
});

it("adds the offer instruction after the question only when the use case asks again for an offer", async () => {
  const llm = { chatCompletion: vi.fn().mockResolvedValue({ content: "Done.", model: "test", usedFallback: false }) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
  const adapter = new OpenAIGeneralAnswerAdapter(llm as never, logger, { jiraProjectKey: "SD" });
  await adapter.answer("Please order an air filter for truck 12", [], []);
  await adapter.answer("Please order an air filter for truck 12", [], [], undefined, undefined, { requireOffer: true });
  const [plain, again] = llm.chatCompletion.mock.calls.map((call) => call[1][1].content as string);
  expect(plain).not.toContain(REQUIRE_OFFER_INSTRUCTION);
  expect(plain.endsWith("## User's Question\nPlease order an air filter for truck 12")).toBe(true);
  expect(again.endsWith(`## User's Question\nPlease order an air filter for truck 12\n\n${REQUIRE_OFFER_INSTRUCTION}`)).toBe(true);
  expect(REQUIRE_OFFER_INSTRUCTION).toContain("End the answer with exactly one OFFER: line");
});
