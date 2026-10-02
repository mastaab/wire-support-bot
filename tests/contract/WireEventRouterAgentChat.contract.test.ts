/**
 * Contract tests for the agent conversation as an opt-in: the router with the real offer store, the
 * real ConfirmOffer and the real AskForAgentConversation, with a mocked open flow, mocked support
 * use cases and ports. No DB, network or SDK.
 */
import { describe, it, expect, vi } from "vitest";
import type { CompositeButtonAction, TextMessage } from "@wireapp/wire-apps-js-sdk";
import { WireEventRouter } from "../../src/infrastructure/wire/WireEventRouter";
import type { WireEventRouterDeps } from "../../src/infrastructure/wire/WireEventRouter";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import { InMemoryMemberCache } from "../../src/infrastructure/services/InMemoryMemberCache";
import { ConfirmOffer } from "../../src/application/usecases/jira/ConfirmOffer";
import type { ConfirmOfferHandlers } from "../../src/application/usecases/jira/ConfirmOffer";
import { AskForAgentConversation } from "../../src/application/usecases/jira/AskForAgentConversation";
import type { OpenAgentConversation, OpenAgentConversationInput, OpenAgentConversationOutcome } from "../../src/application/usecases/jira/OpenAgentConversation";
import type { CompositeButton, SentMessageRef } from "../../src/application/ports/WireOutboundPort";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const convId: QualifiedId = { id: "conv-1", domain: "example.com" };
const alice: QualifiedId = { id: "user-1", domain: "example.com" };
const bob: QualifiedId = { id: "user-2", domain: "example.com" };
const botId: QualifiedId = { id: "bot-1", domain: "example.com" };
const HOURS_4 = 4 * 60 * 60 * 1000;

const REQUEST: SupportRequest = {
  key: "SD-6", conversationId: convId, requesterId: alice, requesterName: "Alice", summary: "VPN drops every ten minutes",
  kind: "fault", statusCategory: "in_progress", createdAt: new Date("2026-10-01T09:00:00Z"), updatedAt: new Date("2026-10-01T09:00:00Z"),
  deleted: false, version: 1,
};

const QUESTION = "Alice, the service desk assigned Kim Desk to **SD-6**. Would you like a direct conversation with them?";

function setup() {
  const pendingOffers = new InMemoryPendingOfferStore();
  const memberCache = new InMemoryMemberCache();
  memberCache.setMembers(convId, [
    { userId: alice, role: "member", name: "Alice" },
    { userId: bob, role: "member", name: "Bob" },
  ]);
  let sentCount = 0;
  const typing = { count: 0 };
  const prompts: Array<{ messageId: string; text: string; buttons: CompositeButton[] }> = [];
  const wireOutbound = {
    sendPlainText: vi.fn(async (): Promise<SentMessageRef> => ({ messageId: `text-msg-${++sentCount}`, sha256: "a".repeat(64) })),
    sendCompositePrompt: vi.fn(async (_c: QualifiedId, text: string, buttons: CompositeButton[]): Promise<SentMessageRef> => {
      const messageId = `prompt-msg-${++sentCount}`;
      prompts.push({ messageId, text, buttons });
      return { messageId, sha256: "b".repeat(64) };
    }),
    sendButtonConfirmation: vi.fn().mockResolvedValue(undefined),
    closeButtonPrompt: vi.fn().mockResolvedValue(undefined),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    getUserProfile: vi.fn().mockResolvedValue(null),
    withTyping: <T>(_c: QualifiedId, work: () => Promise<T>): Promise<T> => {
      typing.count += 1;
      return work();
    },
  };
  const logger = { child: vi.fn().mockReturnThis(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const requests = {
    findByKey: vi.fn(async (key: string) => (key === REQUEST.key ? { ...REQUEST } : null)),
    markAgentConversation: vi.fn().mockResolvedValue(true),
  };
  const open = { execute: vi.fn(async (_input: OpenAgentConversationInput): Promise<OpenAgentConversationOutcome> => "opened") };
  const conversations = {
    findUserByHandle: vi.fn(async () => ({ id: { id: "agent-1", domain: "example.com" }, name: "Kim Desk" })),
    createGroup: vi.fn(), makeAdmin: vi.fn(), leave: vi.fn(), track: vi.fn(),
  };
  const asker = new AskForAgentConversation({
    requests: requests as never, conversations, offers: pendingOffers, wireOutbound, open: open as unknown as OpenAgentConversation,
    projectKey: "SD", lifetimeMs: HOURS_4, logger,
  });
  const handlers = {
    raiseSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
    replyToServiceDesk: { execute: vi.fn().mockResolvedValue(true) },
    resolveSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
    agentConversation: asker,
  };
  const confirmOffer = new ConfirmOffer(pendingOffers, handlers as unknown as ConfirmOfferHandlers, wireOutbound, undefined, undefined, [], logger);
  const deps = {
    logger,
    answerQuestion: { execute: vi.fn().mockResolvedValue("") },
    botUserId: botId,
    wireOutbound,
    messageBuffer: { clear: vi.fn(), push: vi.fn(), getLastN: vi.fn().mockReturnValue([]) },
    memberCache,
    channelConfig: { get: vi.fn().mockResolvedValue(null), upsert: vi.fn(), setTimezone: vi.fn() },
    raiseSupportRequest: handlers.raiseSupportRequest,
    completePartOrder: { execute: vi.fn().mockResolvedValue(false) },
    listSupportRequests: { execute: vi.fn() },
    resolveSupportRequest: handlers.resolveSupportRequest,
    replyToServiceDesk: handlers.replyToServiceDesk,
    getIssueStatus: { execute: vi.fn().mockResolvedValue(undefined), projectKey: "SD" },
    pendingOffers,
    confirmOffer,
    supportWelcome: { projectKey: "SD", passive: false, watching: true },
  } as unknown as WireEventRouterDeps;
  const router = new WireEventRouter(deps);

  /** Asks as the watch does in ask mode; returns the question's message ID and button IDs. */
  const ask = async (): Promise<{ messageId: string; buttons: string[] }> => {
    expect(await asker.ask(REQUEST, "kim.desk")).toBe("asked");
    const prompt = prompts.at(-1)!;
    return { messageId: prompt.messageId, buttons: prompt.buttons.map((b) => b.id) };
  };
  const texts = (): string[] => wireOutbound.sendPlainText.mock.calls.map((call) => (call as unknown[])[1] as string);
  const closes = (): Array<[string, string]> => wireOutbound.closeButtonPrompt.mock.calls.map((call) => [call[1] as string, call[2] as string]);
  return { router, pendingOffers, handlers, wireOutbound, prompts, ask, texts, closes, open, requests, deps, typing };
}

let eventCount = 0;
function click(sender: QualifiedId, buttonId: string, referenceMessageId: string): CompositeButtonAction {
  eventCount += 1;
  return { type: "composite_button_action", id: `click-${eventCount}`, conversationId: convId, sender, buttonId, referenceMessageId };
}

function text(sender: QualifiedId, body: string): TextMessage {
  eventCount += 1;
  return { type: "text", id: `text-${eventCount}`, text: body, conversationId: convId, sender, timestamp: new Date() };
}

describe("WireEventRouter contract: the agent conversation question", () => {
  it("[Open direct chat] runs the existing open flow once, confirms the click and closes the question", async () => {
    const { router, ask, prompts, wireOutbound, closes, texts, open, typing } = setup();
    const { messageId, buttons } = await ask();
    expect(prompts[0]!.text).toBe(QUESTION);
    expect(prompts[0]!.buttons.map((b) => b.label)).toEqual(["Open direct chat", "Not now"]);

    await router.onButtonClicked(click(alice, buttons[0]!, messageId));
    await router.onButtonClicked(click(alice, buttons[0]!, messageId));

    expect(wireOutbound.sendButtonConfirmation).toHaveBeenCalledOnce();
    expect(wireOutbound.sendButtonConfirmation).toHaveBeenCalledWith(convId, messageId, buttons[0]);
    expect(closes()).toEqual([[messageId, `${QUESTION}\n\nAnswered by Alice: Open direct chat`]]);
    expect(open.execute).toHaveBeenCalledOnce();
    expect(open.execute).toHaveBeenCalledWith({ request: expect.objectContaining({ key: "SD-6" }), agentHandle: "kim.desk", claimed: true });
    // The open flow posts its own notice; the late click is silent.
    expect(texts()).toEqual([]);
    // Opening is work the requester waits for, so the bot shows it is typing.
    expect(typing.count).toBe(1);
  });

  it("[Not now] only closes the question", async () => {
    const { router, ask, closes, texts, open, pendingOffers } = setup();
    const { messageId, buttons } = await ask();
    await router.onButtonClicked(click(alice, buttons[1]!, messageId));
    expect(closes()).toEqual([[messageId, `${QUESTION}\n\nAnswered by Alice: Not now`]]);
    expect(texts()).toEqual([]);
    expect(open.execute).not.toHaveBeenCalled();
    expect(pendingOffers.has(convId, alice)).toBe(false);
  });

  it.each(["open", "yes", "Open direct chat", "yes please"])("takes the text answer %j as [Open direct chat]", async (answer) => {
    const { router, ask, closes, open } = setup();
    const { messageId } = await ask();
    await router.onTextMessageReceived(text(alice, answer));
    expect(closes()).toEqual([[messageId, `${QUESTION}\n\nAnswered by Alice: Open direct chat`]]);
    expect(open.execute).toHaveBeenCalledOnce();
  });

  it.each(["not now", "no", "No thanks", "later"])("takes the text answer %j as [Not now]", async (answer) => {
    const { router, ask, closes, open, texts } = setup();
    const { messageId } = await ask();
    await router.onTextMessageReceived(text(alice, answer));
    expect(closes()).toEqual([[messageId, `${QUESTION}\n\nAnswered by Alice: Not now`]]);
    expect(open.execute).not.toHaveBeenCalled();
    expect(texts()).toEqual([]);
  });

  it("answers another member's click once, opens nothing, and still takes the requester's click", async () => {
    const { router, ask, wireOutbound, texts, open, closes } = setup();
    const { messageId, buttons } = await ask();
    await router.onButtonClicked(click(bob, buttons[0]!, messageId));
    await router.onButtonClicked(click(bob, buttons[1]!, messageId));
    expect(texts()).toEqual(["Only Alice can answer this."]);
    expect(wireOutbound.sendButtonConfirmation).not.toHaveBeenCalled();
    expect(open.execute).not.toHaveBeenCalled();
    expect(closes()).toEqual([]);

    await router.onButtonClicked(click(alice, buttons[0]!, messageId));
    expect(open.execute).toHaveBeenCalledOnce();
  });

  it("another member's text answer is not an answer", async () => {
    const { router, ask, open, pendingOffers } = setup();
    await ask();
    await router.onTextMessageReceived(text(bob, "open"));
    expect(open.execute).not.toHaveBeenCalled();
    expect(pendingOffers.has(convId, alice)).toBe(true);
  });

  it("closes the question when the requester's next message is not an answer, opening nothing", async () => {
    const { router, ask, closes, open, pendingOffers } = setup();
    const { messageId, buttons } = await ask();
    await router.onTextMessageReceived(text(alice, "The VPN works again for now."));
    expect(closes()).toEqual([[messageId, `${QUESTION}\n\nClosed, as the next message was not an answer.`]]);
    expect(pendingOffers.has(convId, alice)).toBe(false);
    await router.onButtonClicked(click(alice, buttons[0]!, messageId));
    expect(open.execute).not.toHaveBeenCalled();
  });

  it("says so when opening fails after [Open direct chat]", async () => {
    const { router, ask, open, texts } = setup();
    open.execute.mockResolvedValue("failed");
    const { messageId, buttons } = await ask();
    await router.onButtonClicked(click(alice, buttons[0]!, messageId));
    expect(texts()).toEqual(["I'm afraid I couldn't open the direct conversation for **SD-6**."]);
  });
});
