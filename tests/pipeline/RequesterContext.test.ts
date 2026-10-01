import { it, expect, vi } from "vitest";
import { OpenAIGeneralAnswerAdapter } from "../../src/infrastructure/llm/OpenAIGeneralAnswerAdapter";

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
