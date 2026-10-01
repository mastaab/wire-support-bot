/**
 * Contract tests for WireEventRouter.
 *
 * These tests verify that the router correctly maps incoming SDK text messages
 * to the expected application use-case calls. They use fully-stubbed use cases
 * and ports: no DB, no network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConversationRole, ConversationType, TextMessage } from "@wireapp/wire-apps-js-sdk";
import type { CompositeButtonAction, Conversation, ConversationMember, Mention } from "@wireapp/wire-apps-js-sdk";
import { WireReplyContext } from "../../src/infrastructure/wire/WireReplyContext";
import { createWireOutboundAdapter } from "../../src/infrastructure/wire/WireOutboundAdapter";
import { WireEventRouter } from "../../src/infrastructure/wire/WireEventRouter";
import type { WireEventRouterDeps } from "../../src/infrastructure/wire/WireEventRouter";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import type { ListSupportRequestsInput } from "../../src/application/usecases/jira/ListSupportRequests";
import { InMemoryMemberCache } from "../../src/infrastructure/services/InMemoryMemberCache";

const convId: QualifiedId = { id: "conv-1", domain: "example.com" };
const sender: QualifiedId = { id: "user-1", domain: "example.com" };

const RECEIVED_AT = new Date("2026-09-25T09:00:00Z");

/** A received text message as the SDK delivers it. */
function makeMessage(text: string, id = "msg-1"): TextMessage {
  return { type: "text", id, text, conversationId: convId, sender, timestamp: RECEIVED_AT };
}

/** A received text message whose mentions the test may inspect or change. */
type MentionedMessage = TextMessage & { mentions: Mention[] };

function customMention(command: string): MentionedMessage {
  const label = "@AI Support Bot 🤖 (test, dev)";
  return { ...makeMessage(`${label} ${command}`), mentions: [
    { userId: { id: "bot-1", domain: "example.com" }, offset: 0, length: label.length },
  ] };
}

function makeConversation(id: string): Conversation {
  return { id, domain: "example.com", name: null, type: ConversationType.GROUP, teamId: null };
}

it("passes the actual caller and cleaned question after a custom bot mention", async () => {
  const caller = { id: "second-user", domain: "example.com" };
  const memberCache = new InMemoryMemberCache();
  memberCache.setMembers(convId, [{ userId: caller, role: "member", name: "Second User" }]);
  const deps = makeDeps({ memberCache });
  await new WireEventRouter(deps).onTextMessageReceived({ ...customMention("What am I responsible for?"), sender: caller });
  expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({
    question: "What am I responsible for?", requester: { ...caller, name: "Second User" },
  }));
});

it("shows the app typing while it answers a mentioned question", async () => {
  const deps = makeDeps();
  let typing = false;
  vi.mocked(deps.wireOutbound.withTyping).mockImplementation(async (_conversationId, work) => {
    typing = true;
    try { return await work(); } finally { typing = false; }
  });
  vi.mocked(deps.answerQuestion.execute).mockImplementation(async () => {
    expect(typing).toBe(true);
    return "answer";
  });
  await new WireEventRouter(deps).onTextMessageReceived(customMention("What am I responsible for?"));
  expect(deps.wireOutbound.withTyping).toHaveBeenCalledWith(convId, expect.any(Function));
  expect(deps.answerQuestion.execute).toHaveBeenCalledOnce();
});

it("does not show typing for an ordinary message nobody asked the bot about", async () => {
  const deps = makeDeps();
  await new WireEventRouter(deps).onTextMessageReceived(makeMessage("lunch at noon?"));
  expect(deps.wireOutbound.withTyping).not.toHaveBeenCalled();
});

it.each(["foreign", "invalid", "nonleading"])("does not strip a %s mention into a command", async variant => {
  const deps = jiraDeps();
  const message = customMention("support requests");
  if (variant === "foreign") message.mentions[0].userId = { ...message.mentions[0].userId, domain: "other.test" };
  if (variant === "invalid") message.mentions[0].length = 10000;
  if (variant === "nonleading") { message.text = `hello ${message.text}`; message.mentions[0].offset = 6; }
  await new WireEventRouter(deps).onTextMessageReceived(message);
  expect(deps.listSupportRequests!.execute).not.toHaveBeenCalled();
});

it("hydrates Wire names and handles into the member cache after restart", async () => {
  const memberCache = new InMemoryMemberCache();
  const member = { id: "second-user", domain: "example.com" };
  const deps = makeDeps({ memberCache });
  deps.wireOutbound.getUserProfile = vi.fn().mockResolvedValue({ id: member, name: "Sam (Test)", handle: "second_test" });
  await new WireEventRouter(deps).hydrateFromSdkStore([convId] as never, async () => [{ userId: member, role: "wire_member" }] as never);
  expect(memberCache.getMembers(convId)).toEqual([expect.objectContaining({ userId: member, name: "Sam (Test)", handle: "second_test" })]);
});

function makeDeps(overrides: Partial<WireEventRouterDeps> = {}): WireEventRouterDeps {
  return {
    logger: { child: vi.fn().mockReturnThis(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    answerQuestion: { execute: vi.fn().mockResolvedValue(undefined) },
    botUserId: { id: "bot-1", domain: "example.com" },
    wireOutbound: {
      sendPlainText: vi.fn().mockResolvedValue(undefined),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
      withTyping: vi.fn((_conversationId: unknown, work: () => Promise<unknown>) => work()),
    },
    messageBuffer: { clear: vi.fn(), push: vi.fn(), getLastN: vi.fn().mockReturnValue([]) },
    memberCache: {
      setMembers: vi.fn(), addMembers: vi.fn(), getMembers: vi.fn().mockReturnValue([]),
      removeMembers: vi.fn(), clearConversation: vi.fn(),
    },
    channelConfig: { get: vi.fn().mockResolvedValue(null), upsert: vi.fn(), setTimezone: vi.fn() },
    // The service desk is required: support commands for project SD, no pending offers.
    raiseSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
    completePartOrder: { execute: vi.fn().mockResolvedValue(false) },
    listSupportRequests: { execute: vi.fn().mockResolvedValue(undefined) },
    resolveSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
    replyToServiceDesk: { execute: vi.fn().mockResolvedValue(undefined) },
    getIssueStatus: { execute: vi.fn().mockResolvedValue(null), projectKey: "SD" },
    pendingOffers: {
      put: vi.fn(), take: vi.fn(() => null), has: vi.fn(() => false), clearConversation: vi.fn(),
      drop: vi.fn(() => null), recentlyDropped: vi.fn(() => null), forgetDropped: vi.fn(),
    },
    confirmOffer: { execute: vi.fn().mockResolvedValue(false) },
    supportWelcome: { projectKey: "SD", passive: false, watching: false },
    ...overrides,
  } as unknown as WireEventRouterDeps;
}

/** Deps with a channel timezone of Europe/Berlin. */
function jiraDeps(overrides: Partial<WireEventRouterDeps> = {}): WireEventRouterDeps {
  return makeDeps({
    channelConfig: { get: vi.fn().mockResolvedValue({ timezone: "Europe/Berlin" }), upsert: vi.fn(), setTimezone: vi.fn() },
    ...overrides,
  } as unknown as Partial<WireEventRouterDeps>);
}

describe("WireEventRouter contract: ordinary chat", () => {
  it("non-command message without bot mention → bot stays silent", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("yes its set up for tomorrow"));
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendCompositePrompt).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// General behaviour
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: general behaviour", () => {
  let deps: WireEventRouterDeps;
  let router: WireEventRouter;

  beforeEach(() => {
    deps = makeDeps();
    router = new WireEventRouter(deps);
  });

  it("pushes every message to the message buffer", async () => {
    await router.onTextMessageReceived(makeMessage("hello world"));
    expect(deps.messageBuffer.push).toHaveBeenCalledWith(convId, expect.objectContaining({ text: "hello world" }));
  });

  it("sends error reply when a use case throws", async () => {
    const d = makeDeps();
    vi.mocked(d.answerQuestion.execute).mockRejectedValueOnce(new Error("boom"));
    const r = new WireEventRouter(d);
    await r.onTextMessageReceived(customMention("crash this"));
    expect(d.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("Something went wrong"),
      expect.anything(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Button action handling
// ─────────────────────────────────────────────────────────────────────────────
function makeButtonAction(buttonId: string, referenceMessageId = "msg-1", id = "btn-1"): CompositeButtonAction {
  return { type: "composite_button_action", id, buttonId, referenceMessageId, conversationId: convId, sender };
}

describe("WireEventRouter contract: button action handling", () => {
  it("unknown button id → gives a supported text alternative", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onButtonClicked(makeButtonAction("unknown_button"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(convId, expect.stringContaining("text command"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Member cache lifecycle
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: member cache lifecycle", () => {
  it("setMembers on app-added", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    const conv = makeConversation("conv-1");
    const members: ConversationMember[] = [{ userId: sender, role: ConversationRole.MEMBER }];
    await router.onAppAddedToConversation(conv, members);
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(convId, expect.stringMatching(/^I'm Wire Support Bot, and I connect this channel with the service desk\./));
    expect(deps.channelConfig.upsert).toHaveBeenCalledWith({ channelId: "conv-1@example.com", organisationId: "example.com", timezone: "UTC" });
    expect(deps.memberCache.setMembers).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conv-1" }),
      expect.any(Array),
    );
  });

  it("explains the service desk first in the welcome when it is configured", async () => {
    const deps = makeDeps({ supportWelcome: { projectKey: "SD", passive: true, watching: true } } as Partial<WireEventRouterDeps>);
    await new WireEventRouter(deps).onAppAddedToConversation(makeConversation("conv-1"), [{ userId: sender, role: ConversationRole.MEMBER }]);
    const text = vi.mocked(deps.wireOutbound.sendPlainText).mock.calls[0]![1];
    expect(text).toMatch(/^I'm Wire Support Bot, and I connect this channel with the service desk\./);
    expect(text).not.toMatch(/decision|action:|pause|secure mode/);
  });

  it("addMembers (not setMembers) on user-joined", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    const members: ConversationMember[] = [{ userId: { id: "user-2", domain: "example.com" }, role: ConversationRole.MEMBER }];
    await router.onUserJoinedConversation(convId, members);
    expect(deps.memberCache.addMembers).toHaveBeenCalledWith(convId, expect.any(Array));
    expect(deps.memberCache.setMembers).not.toHaveBeenCalled();
  });

  it("removeMembers on user-left", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onUserLeftConversation(convId, [sender]);
    expect(deps.memberCache.removeMembers).toHaveBeenCalledWith(convId, [sender]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Pipeline enqueue behaviour
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: passive help enqueue", () => {
  function makeQueueDeps() {
    const enqueueSpy = vi.fn();
    const processSpy = vi.fn().mockResolvedValue(undefined);
    const queue = {
      enqueue: enqueueSpy,
      setWorker: vi.fn(),
      depth: 0,
      concurrency: 0,
    };
    const pipeline = { process: processSpy };
    return { queue, pipeline, enqueueSpy, processSpy };
  }

  it("enqueues a job for an unaddressed message", async () => {
    const { queue, pipeline, enqueueSpy } = makeQueueDeps();
    const deps = makeDeps({
      processingQueue: queue as unknown as WireEventRouterDeps["processingQueue"],
      pipeline: pipeline as unknown as WireEventRouterDeps["pipeline"],
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("hello there"));
    expect(enqueueSpy).toHaveBeenCalledOnce();
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: `${convId.id}@${convId.domain}`,
        payload: expect.objectContaining({ text: "hello there" }),
      }),
    );
  });

  it("does NOT enqueue when pipeline deps are absent", async () => {
    const deps = makeDeps();  // no processingQueue or pipeline
    const router = new WireEventRouter(deps);
    // Just ensure it does not throw
    await expect(router.onTextMessageReceived(makeMessage("hello there"))).resolves.toBeUndefined();
  });


  it("does NOT enqueue mentioned questions or support commands", async () => {
    const { queue, pipeline, enqueueSpy } = makeQueueDeps();
    const deps = jiraDeps({
      processingQueue: queue as unknown as WireEventRouterDeps["processingQueue"],
      pipeline: pipeline as unknown as WireEventRouterDeps["pipeline"],
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(customMention("what is the latest on the printer?"));
    await router.onTextMessageReceived(customMention("support requests"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledOnce();
    expect(deps.listSupportRequests!.execute).toHaveBeenCalledOnce();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

describe("WireEventRouter contract: created groups and channel config", () => {
  const withConfig = (config: { timezone: string } | null, extra: Partial<WireEventRouterDeps> = {}) =>
    jiraDeps({ processingQueue: { enqueue: vi.fn() } as never, pipeline: {} as never, channelConfig: { get: vi.fn().mockResolvedValue(config), upsert: vi.fn(), setTimezone: vi.fn() } as never, ...extra });

  it("handles a conversation with and without a stored config as usual", async () => {
    for (const deps of [withConfig({ timezone: "UTC" }), withConfig(null)]) {
      await new WireEventRouter(deps).onTextMessageReceived(customMention("support requests"));
      expect(deps.listSupportRequests!.execute).toHaveBeenCalledOnce();
    }
  });

  it("ignores a group the app created and is leaving, without reading its channel config", async () => {
    const deps = withConfig({ timezone: "UTC" }, { createdConversations: { has: vi.fn().mockReturnValue(true) } } as never);
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(customMention("support requests"));
    await router.onTextMessageReceived(customMention("what is the latest?"));
    await router.onTextMessageReceived(makeMessage("the printer is broken"));
    expect(deps.listSupportRequests!.execute).not.toHaveBeenCalled();
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
    expect(deps.processingQueue!.enqueue).not.toHaveBeenCalled();
    expect(deps.messageBuffer.push).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalled();
    expect(deps.channelConfig.get).not.toHaveBeenCalled();
  });

  it("welcomes when added and keeps a stored timezone, writing only the timezone and IDs", async () => {
    const deps = withConfig({ timezone: "Europe/Berlin" });
    await new WireEventRouter(deps).onAppAddedToConversation({ id: "conv-1", domain: "example.com" } as never, [{ userId: sender, role: "member" }] as never);
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledOnce();
    expect(deps.channelConfig.upsert).toHaveBeenCalledExactlyOnceWith({ channelId: "conv-1@example.com", organisationId: "example.com", timezone: "Europe/Berlin" });
  });

  it("forgets the conversation's buffer and offers when it is deleted", async () => {
    const pendingOffers = { ...makeDeps().pendingOffers, clearConversation: vi.fn() };
    const processingQueue = { enqueue: vi.fn(), cancelChannel: vi.fn().mockResolvedValue(undefined) };
    const deps = withConfig({ timezone: "UTC" }, { pendingOffers, processingQueue } as never);
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("hello"));
    await router.onConversationDeleted(convId);
    expect(deps.messageBuffer.clear).toHaveBeenCalledWith(convId);
    expect(pendingOffers.clearConversation).toHaveBeenCalledWith(convId);
    expect(processingQueue.cancelChannel).toHaveBeenCalledWith("conv-1@example.com");
    await router.onTextMessageReceived(customMention("support requests"));
    expect(deps.listSupportRequests!.execute).toHaveBeenCalledOnce();
  });
});


it("quotes each actual source across overlapping channels and queued commands", async () => {
  const context = new WireReplyContext();
  const sendMessage = vi.fn().mockResolvedValue("sent");
  const deps = jiraDeps({ replyContext: context });
  const adapter = createWireOutboundAdapter({ current: { manager: { sendMessage, sendAsset: vi.fn(), getUsers: vi.fn().mockResolvedValue([]) } } }, deps.logger, context);
  deps.wireOutbound = adapter;
  let release!: () => void;
  let entered!: () => void;
  const enteredFirst = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  deps.listSupportRequests!.execute = vi.fn(async (input: ListSupportRequestsInput): Promise<SupportRequest[]> => {
    if (input.conversationId.domain === convId.domain && input.replyToMessageId === "first") {
      entered();
      await blocked;
    }
    await adapter.sendPlainText(input.conversationId, `list ${input.replyToMessageId}`, { replyToMessageId: input.replyToMessageId });
    return [];
  });
  const router = new WireEventRouter(deps);
  const source = (id: string, domain = convId.domain) => TextMessage.create({
    conversationId: { ...convId, domain }, messageId: id, text: "@Bot support requests", senderId: sender, mentions: [{ userId: { id: "bot-1", domain: "example.com" }, offset: 0, length: 4 }],
    timestamp: new Date("2026-09-18T09:00:00Z"),
  });
  const first = router.onTextMessageReceived(source("first"));
  await enteredFirst;
  const second = router.onTextMessageReceived(source("second"));
  await router.onTextMessageReceived(source("first", "other.test"));
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(sendMessage.mock.calls[0][0]).toMatchObject({ conversationId: { ...convId, domain: "other.test" }, quotedMessageId: "first" });
  release();
  await Promise.all([first, second]);
  expect(sendMessage.mock.calls.slice(1).map(([m]) => [m.text, m.quotedMessageId])).toEqual([["list first", "first"], ["list second", "second"]]);
  expect(context.get(convId, "first")).toBeUndefined();
  expect(context.get(convId, "second")).toBeUndefined();
});

it("quotes router error responses and clears their source metadata", async () => {
  const context = new WireReplyContext();
  const deps = jiraDeps({ replyContext: context });
  const sendMessage = vi.fn().mockResolvedValue("sent");
  deps.wireOutbound = createWireOutboundAdapter({ current: { manager: { sendMessage, sendAsset: vi.fn(), getUsers: vi.fn().mockResolvedValue([]) } } }, deps.logger, context);
  vi.mocked(deps.listSupportRequests!.execute).mockRejectedValue(new Error("synthetic failure"));
  await new WireEventRouter(deps).onTextMessageReceived(TextMessage.create({ conversationId: convId, messageId: "failed-command", text: "@Bot support requests", senderId: sender, mentions: [{ userId: { id: "bot-1", domain: "example.com" }, offset: 0, length: 4 }] }));
  expect(sendMessage.mock.calls[0][0]).toMatchObject({ text: "Something went wrong. Please try again.", quotedMessageId: "failed-command" });
  expect(context.get(convId, "failed-command")).toBeUndefined();
});



function combinedMentions(first: string, second: string) {
  const a = customMention(first);
  const b = customMention(second);
  return { ...a, text: `${a.text}\n${b.text}`, mentions: [
    ...a.mentions, ...b.mentions.map(m => ({ ...m, offset: m.offset + a.text.length + 1 })),
  ] };
}

it.each([
  makeMessage("status of SD-1\nstatus of SD-2"),
  combinedMentions("support requests", "status of SD-4"),
  combinedMentions("`resolve SD-6`", "`reply to SD-7: thanks`"),
  customMention("status of SD-1; support requests"),
  customMention("status of SD-1 and then resolve SD-1"),
])("rejects multiple commands before writes, buffering or model work: $text", async message => {
  const enqueue = vi.fn();
  const deps = jiraDeps({ processingQueue: { enqueue } as never, pipeline: {} as never });
  await new WireEventRouter(deps).onTextMessageReceived(message);
  expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(convId,
    "Please send one command per message. I have not run any commands from this message.",
    { replyToMessageId: message.id });
  for (const value of Object.values(deps)) {
    if (value && typeof value === "object" && "execute" in value) expect(value.execute).not.toHaveBeenCalled();
  }
  expect(enqueue).not.toHaveBeenCalled();
  expect(deps.messageBuffer.push).not.toHaveBeenCalled();
});

it("passes the conversation timezone to the answer path", async () => {
  const deps = jiraDeps();
  await new WireEventRouter(deps).onTextMessageReceived(customMention("what is the weather like?"));
  expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({ timezone: "Europe/Berlin" }));
});

it.each([
  ["status of SD-4", "getIssueStatus"],
  ["what is the weather like?", "answerQuestion"],
] as const)("falls back to the configured default timezone for %s when the channel has no config", async (command, useCase) => {
  const deps = jiraDeps({ defaultTimezone: "Europe/Lisbon", channelConfig: { get: vi.fn().mockResolvedValue(null), upsert: vi.fn(), setTimezone: vi.fn() } } as unknown as Partial<WireEventRouterDeps>);
  await new WireEventRouter(deps).onTextMessageReceived(customMention(command));
  expect(deps[useCase]!.execute).toHaveBeenCalledWith(expect.objectContaining({ timezone: "Europe/Lisbon" }));
});

describe("WireEventRouter contract: support commands", () => {
  it.each([
    ["support: My VPN drops every ten minutes", "My VPN drops every ten minutes", "My VPN drops every ten minutes"],
    ["Support:  VPN drops\nIt started after the update.", "VPN drops", "VPN drops\nIt started after the update."],
  ])("'%s' → raiseSupportRequest when the bot is mentioned", async (text, summary, description) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.raiseSupportRequest!.execute).toHaveBeenCalledWith(expect.objectContaining({
      summary, description, conversationId: convId, requesterId: sender, replyToMessageId: "msg-1", requestKind: "fault",
    }));
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  });

  it("never raises a support request from chat that does not address the bot", async () => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("support: my VPN drops"));
    expect(deps.raiseSupportRequest!.execute).not.toHaveBeenCalled();
  });

  it("raises a multi-line support request whose description mentions other commands, without running them", async () => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention("support: Printer broken\nstatus of SD-3"));
    expect(deps.raiseSupportRequest!.execute).toHaveBeenCalledWith(expect.objectContaining({
      summary: "Printer broken", description: "Printer broken\nstatus of SD-3",
    }));
    expect(deps.getIssueStatus!.execute).not.toHaveBeenCalled();
  });

  it.each([["resolve SD-6", "SD-6"], ["close sd-6.", "SD-6"]])("'%s' → resolveSupportRequest when the bot is mentioned", async (text, issueKey) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.resolveSupportRequest!.execute).toHaveBeenCalledWith({ issueKey, conversationId: convId, actorId: sender, replyToMessageId: "msg-1" });
  });

  it.each([
    ["resolve SD-6: The tray was fitted, thanks.", "The tray was fitted, thanks."],
    ["close sd-6 : Works again\nsupport requests", "Works again\nsupport requests"],
  ])("'%s' → resolveSupportRequest with a closing comment, never running commands inside it", async (text, comment) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.resolveSupportRequest!.execute).toHaveBeenCalledWith({
      issueKey: "SD-6", conversationId: convId, actorId: sender, comment, replyToMessageId: "msg-1",
    });
    expect(deps.listSupportRequests!.execute).not.toHaveBeenCalled();
  });

  it.each([["resolve OPS-6", true], ["resolve SD-6", false]])("does not resolve '%s' (mentioned: %s) outside the addressed, configured-project form", async (text, mentioned) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(mentioned ? customMention(text) : makeMessage(text));
    expect(deps.resolveSupportRequest!.execute).not.toHaveBeenCalled();
  });

  it.each([["support requests", false], ["open support requests?", false], ["my support requests", true], ["My support request", true]])("'%s' → listSupportRequests when the bot is mentioned (own only: %s)", async (text, own) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.listSupportRequests!.execute).toHaveBeenCalledWith({
      conversationId: convId, ...(own ? { requesterId: sender } : {}), replyToMessageId: "msg-1",
    });
  });

  it.each(["support requests", "my support requests", "status of SD-42"])("needs a mention for the service-desk read '%s'", async (text) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage(text));
    expect(deps.listSupportRequests!.execute).not.toHaveBeenCalled();
    expect(deps.getIssueStatus!.execute).not.toHaveBeenCalled();
  });

  it.each(["ACT-0004 to jira", "raise ACT-0004 in jira", "jira status of ACT-0004"])("runs nothing for keys of another project: '%s'", async (text) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage(text));
    expect(deps.raiseSupportRequest!.execute).not.toHaveBeenCalled();
    expect(deps.getIssueStatus!.execute).not.toHaveBeenCalled();
    expect(deps.resolveSupportRequest!.execute).not.toHaveBeenCalled();
    expect(deps.listSupportRequests!.execute).not.toHaveBeenCalled();
  });

  it.each([["status of SD-42", "SD-42"], ["status of sd-42?", "SD-42"], ["jira status of SD-42", "SD-42"]])("'%s' → getIssueStatus(%s) when the bot is mentioned", async (text, reference) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.getIssueStatus!.execute).toHaveBeenCalledWith({ reference, conversationId: convId, timezone: "Europe/Berlin", replyToMessageId: "msg-1" });
  });

  it.each(["status of ACT-0004", "status of DEC-0001", "status of REM-0001", "status of KB-3", "status of OPS-1234"])("does not look up '%s', which is not a key of the configured project", async (text) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.getIssueStatus!.execute).not.toHaveBeenCalled();
  });

  it("sends a bare 'status' to the answer path, not to a lookup", async () => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention("status"));
    expect(deps.getIssueStatus!.execute).not.toHaveBeenCalled();
    expect(deps.answerQuestion.execute).toHaveBeenCalled();
  });

  it("routes a natural status question to the Jira lookup when the bot is mentioned", async () => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention("whats the status of SD-4 in jira"));
    expect(deps.getIssueStatus!.execute).toHaveBeenCalledWith(expect.objectContaining({ reference: "SD-4", timezone: "Europe/Berlin" }));
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  });

  it("leaves a natural status question between teammates alone", async () => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("any update on SD-4?"));
    expect(deps.getIssueStatus!.execute).not.toHaveBeenCalled();
  });

  it("sends a change request about a ticket to Q&A rather than the read-only lookup", async () => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention("please close SD-4"));
    expect(deps.getIssueStatus!.execute).not.toHaveBeenCalled();
    expect(deps.resolveSupportRequest!.execute).not.toHaveBeenCalled();
    expect(deps.answerQuestion.execute).toHaveBeenCalled();
  });

  it("does not answer other projects' ticket references in ordinary chat", async () => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("status of OPS-1234"));
    expect(deps.getIssueStatus!.execute).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalledWith(convId, expect.stringContaining("SD project"), expect.anything());
  });

  it("refuses a support request that follows another command in one message", async () => {
    const deps = jiraDeps();
    const message = customMention("status of SD-5\nsupport: VPN drops");
    await new WireEventRouter(deps).onTextMessageReceived(message);
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(convId,
      "Please send one command per message. I have not run any commands from this message.", { replyToMessageId: message.id });
    expect(deps.raiseSupportRequest!.execute).not.toHaveBeenCalled();
    expect(deps.getIssueStatus!.execute).not.toHaveBeenCalled();
  });
});

describe("WireEventRouter contract: offers and service-desk replies", () => {
  const offerDeps = (pending: boolean, handled = true, recent: unknown = null) => makeDeps({
    getIssueStatus: { execute: vi.fn().mockResolvedValue(null), projectKey: "SD" },
    replyToServiceDesk: { execute: vi.fn().mockResolvedValue(undefined) },
    pendingOffers: {
      has: vi.fn().mockReturnValue(pending), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(),
      drop: vi.fn().mockReturnValue(pending ? { kind: "support", requestKind: "fault", summary: "VPN drops", description: "VPN drops" } : null),
      recentlyDropped: vi.fn().mockReturnValue(recent), forgetDropped: vi.fn(),
    },
    processingQueue: { enqueue: vi.fn() },
    pipeline: {},
    confirmOffer: { execute: vi.fn().mockResolvedValue(handled) },
    channelConfig: { get: vi.fn().mockResolvedValue({ timezone: "Europe/Berlin" }), upsert: vi.fn(), setTimezone: vi.fn() },
  } as unknown as Partial<WireEventRouterDeps>);

  it("hands a reply to a pending offer to ConfirmOffer before any follow-up or Q&A handling", async () => {
    const deps = offerDeps(true);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("yes"));
    expect(deps.pendingOffers!.has).toHaveBeenCalledWith(convId, sender);
    expect(deps.confirmOffer!.execute).toHaveBeenCalledWith({
      text: "yes", conversationId: convId, requesterId: sender, requesterName: undefined, replyToMessageId: "msg-1",
    });
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  });

  it("does not consult ConfirmOffer when the sender has no pending offer", async () => {
    const deps = offerDeps(false);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("yes"));
    expect(deps.confirmOffer!.execute).not.toHaveBeenCalled();
  });

  it("continues normal routing when ConfirmOffer does not handle the message", async () => {
    const deps = offerDeps(true, false);
    await new WireEventRouter(deps).onTextMessageReceived(customMention("status of SD-1"));
    expect(deps.confirmOffer!.execute).toHaveBeenCalled();
    expect(deps.getIssueStatus!.execute).toHaveBeenCalledWith(expect.objectContaining({ reference: "SD-1" }));
  });

  it("drops the pending offer when the requester's next message is not a yes or no", async () => {
    const deps = offerDeps(true, false);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("what is due today?"));
    expect(deps.pendingOffers!.drop).toHaveBeenCalledWith(convId, sender);
  });

  it("records a bot entry after a handled offer answer, so the offer question stops counting as the latest", async () => {
    const deps = offerDeps(true, true);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("yes"));
    const pushed = vi.mocked(deps.messageBuffer.push).mock.calls.map(([, message]) => message);
    expect(pushed.map((m) => m.text)).toEqual(["yes", "(Answered the offer above.)"]);
    expect(pushed[1]!.senderId).toEqual(deps.botUserId);
  });

  it("keeps the offer when it was handled by the confirmation", async () => {
    const deps = offerDeps(true, true);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("yes"));
    expect(deps.pendingOffers!.drop).not.toHaveBeenCalled();
  });

  it("hands a yes to ConfirmOffer when the sender's offer was dropped recently", async () => {
    const deps = offerDeps(false, true, { kind: "resolve", issueKey: "SD-8" });
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("yes"));
    expect(deps.confirmOffer!.execute).toHaveBeenCalled();
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  });

  it("passes the dropped offer to the answer path so a correction can revise it", async () => {
    const deps = offerDeps(true, false);
    await new WireEventRouter(deps).onTextMessageReceived(customMention("the description should mention the office Wi-Fi"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({
      pendingOffer: { kind: "support", requestKind: "fault", summary: "VPN drops", description: "VPN drops" },
    }));
  });

  it("sends an unmentioned correction to a passive offer to the answer path, not the pipeline", async () => {
    const deps = offerDeps(true, false);
    (deps.answerQuestion.execute as ReturnType<typeof vi.fn>).mockResolvedValue("Shall I raise this with the service desk?");
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("the description should mention the office Wi-Fi"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({
      question: "the description should mention the office Wi-Fi",
      pendingOffer: { kind: "support", requestKind: "fault", summary: "VPN drops", description: "VPN drops" },
      amendOnly: true,
    }));
    expect(deps.processingQueue!.enqueue).not.toHaveBeenCalled();
  });

  it("passes unmentioned chat that did not revise the offer on to passive help", async () => {
    const deps = offerDeps(true, false);
    (deps.answerQuestion.execute as ReturnType<typeof vi.fn>).mockResolvedValue("");
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("I'll send the logs by Friday"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({ amendOnly: true }));
    expect(deps.processingQueue!.enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: "msg-1" }));
  });

  it("does not mark a mentioned correction as amend-only", async () => {
    const deps = offerDeps(true, false);
    await new WireEventRouter(deps).onTextMessageReceived(customMention("the description should mention the office Wi-Fi"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.not.objectContaining({ amendOnly: true }));
  });

  it("forgets a recently dropped offer when the requester's next message is not a yes", async () => {
    const deps = offerDeps(false, false, { kind: "resolve", issueKey: "SD-8" });
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("sounds good, see you at the call"));
    expect(deps.pendingOffers!.forgetDropped).toHaveBeenCalledWith(convId, sender);
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  });

  it("sends an unmentioned correction of a resolve offer with a comment to the answer path", async () => {
    const deps = makeDeps({
      pendingOffers: {
        has: vi.fn().mockReturnValue(true), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(), forgetDropped: vi.fn(),
        drop: vi.fn().mockReturnValue({ kind: "resolve", issueKey: "SD-8", comment: "Works again." }), recentlyDropped: vi.fn().mockReturnValue(null),
      },
      confirmOffer: { execute: vi.fn().mockResolvedValue(false) },
      processingQueue: { enqueue: vi.fn() },
      pipeline: {},
    } as unknown as Partial<WireEventRouterDeps>);
    (deps.answerQuestion.execute as ReturnType<typeof vi.fn>).mockResolvedValue("Shall I resolve **SD-8** …?");
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("say it works on both printers"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({
      pendingOffer: { kind: "resolve", issueKey: "SD-8", comment: "Works again." }, amendOnly: true,
    }));
  });

  it("sends an unmentioned message after a dropped plain resolve offer to the answer path as amend-only", async () => {
    const deps = makeDeps({
      pendingOffers: {
        has: vi.fn().mockReturnValue(true), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(),
        drop: vi.fn().mockReturnValue({ kind: "resolve", issueKey: "SD-8" }), recentlyDropped: vi.fn().mockReturnValue(null), forgetDropped: vi.fn(),
      },
      confirmOffer: { execute: vi.fn().mockResolvedValue(false) },
      processingQueue: { enqueue: vi.fn() },
      pipeline: {},
    } as unknown as Partial<WireEventRouterDeps>);
    (deps.answerQuestion.execute as ReturnType<typeof vi.fn>).mockResolvedValue("");
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("also add the comment 'thanks'"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({
      pendingOffer: { kind: "resolve", issueKey: "SD-8" }, amendOnly: true,
    }));
    // Not a revision: the message continues to passive help.
    expect(deps.processingQueue!.enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: "msg-1" }));
  });

  it("shows the app typing while it completes a part order the requester is answering", async () => {
    const pending = { kind: "support", requestKind: "part", summary: "Tray", description: "Need a tray.", part: { asset: "printer 7", part: "paper tray" } };
    const deps = makeDeps({
      pendingOffers: {
        has: vi.fn().mockReturnValue(true), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(), forgetDropped: vi.fn(),
        drop: vi.fn().mockReturnValue(pending), recentlyDropped: vi.fn().mockReturnValue(null),
      },
      confirmOffer: { execute: vi.fn().mockResolvedValue(false) },
      completePartOrder: { execute: vi.fn().mockResolvedValue(true) },
    } as unknown as Partial<WireEventRouterDeps>);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("two, deliver to depot north"));
    expect(deps.wireOutbound.withTyping).toHaveBeenCalledOnce();
    expect(deps.wireOutbound.withTyping).toHaveBeenCalledWith(convId, expect.any(Function));
    expect(deps.completePartOrder!.execute).toHaveBeenCalledOnce();
  });

  it.each([["yes", true], ["no", false], ["actually three", false]])("shows typing for the confirmation %j only when it is a yes", async (text, typing) => {
    const deps = makeDeps({
      pendingOffers: {
        has: vi.fn().mockReturnValue(true), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(), forgetDropped: vi.fn(),
        drop: vi.fn().mockReturnValue(null), recentlyDropped: vi.fn().mockReturnValue(null),
      },
      confirmOffer: { execute: vi.fn().mockResolvedValue(true) },
    } as unknown as Partial<WireEventRouterDeps>);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage(text));
    expect(vi.mocked(deps.wireOutbound.withTyping).mock.calls.map(([c]) => c)).toEqual(typing ? [convId] : []);
    expect(deps.confirmOffer!.execute).toHaveBeenCalledOnce();
  });

  it("completes a pending part order in code before the answer path", async () => {
    const pending = { kind: "support", requestKind: "part", summary: "Tray", description: "Need a tray.", part: { asset: "printer 7", part: "paper tray" } };
    const deps = makeDeps({
      pendingOffers: {
        has: vi.fn().mockReturnValue(true), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(), forgetDropped: vi.fn(),
        drop: vi.fn().mockReturnValue(pending), recentlyDropped: vi.fn().mockReturnValue(null),
      },
      confirmOffer: { execute: vi.fn().mockResolvedValue(false) },
      completePartOrder: { execute: vi.fn().mockResolvedValue(true) },
      processingQueue: { enqueue: vi.fn() },
      pipeline: {},
    } as unknown as Partial<WireEventRouterDeps>);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("two, deliver to depot north"));
    expect(deps.completePartOrder!.execute).toHaveBeenCalledWith({
      text: "two, deliver to depot north", conversationId: convId, requesterId: sender, pending, replyToMessageId: "msg-1",
    });
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
    expect(deps.processingQueue!.enqueue).not.toHaveBeenCalled();
  });

  it("continues to the amend path when the part order could not be completed from the message", async () => {
    const pending = { kind: "support", requestKind: "part", summary: "Tray", description: "Need a tray.", part: { asset: "printer 7" } };
    const deps = makeDeps({
      pendingOffers: {
        has: vi.fn().mockReturnValue(true), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(), forgetDropped: vi.fn(),
        drop: vi.fn().mockReturnValue(pending), recentlyDropped: vi.fn().mockReturnValue(null),
      },
      confirmOffer: { execute: vi.fn().mockResolvedValue(false) },
      completePartOrder: { execute: vi.fn().mockResolvedValue(false) },
      processingQueue: { enqueue: vi.fn() },
      pipeline: {},
    } as unknown as Partial<WireEventRouterDeps>);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("lunch at noon?"));
    expect(deps.completePartOrder!.execute).toHaveBeenCalled();
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({ pendingOffer: pending, amendOnly: true }));
  });

  it("does not treat a message to the bot as an answer to a part-order draft", async () => {
    const pending = { kind: "support", requestKind: "part", summary: "Tray", description: "Need a tray.", part: { asset: "printer 7" } };
    const completePartOrder = { execute: vi.fn().mockResolvedValue(true) };
    const deps = makeDeps({
      pendingOffers: {
        has: vi.fn().mockReturnValue(true), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(), forgetDropped: vi.fn(),
        drop: vi.fn().mockReturnValue(pending), recentlyDropped: vi.fn().mockReturnValue(null),
      },
      confirmOffer: { execute: vi.fn().mockResolvedValue(false) },
      completePartOrder,
    } as unknown as Partial<WireEventRouterDeps>);
    await new WireEventRouter(deps).onTextMessageReceived(customMention("what is the latest?"));
    expect(completePartOrder.execute).not.toHaveBeenCalled();
  });

  it("records a bot entry after completing a part-order draft", async () => {
    const pending = { kind: "support", requestKind: "part", summary: "Tray", description: "Need a tray.", part: { asset: "printer 7" } };
    const deps = makeDeps({
      pendingOffers: {
        has: vi.fn().mockReturnValue(true), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(), forgetDropped: vi.fn(),
        drop: vi.fn().mockReturnValue(pending), recentlyDropped: vi.fn().mockReturnValue(null),
      },
      confirmOffer: { execute: vi.fn().mockResolvedValue(false) },
      completePartOrder: { execute: vi.fn().mockResolvedValue(true) },
    } as unknown as Partial<WireEventRouterDeps>);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("two, to depot north"));
    const pushed = vi.mocked(deps.messageBuffer.push).mock.calls.map(([, message]) => message);
    expect(pushed.map((m) => m.text)).toEqual(["two, to depot north", "(Updated the part order draft.)"]);
  });

  it("does not try to complete an offer that is not a part order", async () => {
    const completePartOrder = { execute: vi.fn() };
    const deps = offerDeps(true, false);
    Object.assign(deps, { completePartOrder });
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("the description should mention the office Wi-Fi"));
    expect(completePartOrder.execute).not.toHaveBeenCalled();
  });

  it("does not pass an offer to the answer path when none was dropped", async () => {
    const deps = offerDeps(false);
    await new WireEventRouter(deps).onTextMessageReceived(customMention("what is the latest on the printer?"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.not.objectContaining({ pendingOffer: expect.anything() }));
  });

  it.each([
    ["reply to SD-4: The draft is attached.", "SD-4", "The draft is attached."],
    ["reply to sd-4:the draft is attached", "SD-4", "the draft is attached"],
    ["reply to SD-10: Line one\nLine two", "SD-10", "Line one\nLine two"],
  ])("routes '%s' to ReplyToServiceDesk when the bot is mentioned", async (text, reference, body) => {
    const deps = offerDeps(false);
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.replyToServiceDesk!.execute).toHaveBeenCalledWith({
      reference, body, conversationId: convId, actorId: sender, replyToMessageId: "msg-1",
    });
  });

  it("never posts a service-desk reply from chat that does not address the bot", async () => {
    const deps = offerDeps(false);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("reply to SD-4: I think we should wait until the contract is signed"));
    expect(deps.replyToServiceDesk!.execute).not.toHaveBeenCalled();
  });

  it("drops a pending offer when the requester's next message is rejected as several commands", async () => {
    const deps = offerDeps(true, false);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("status of SD-1\nstatus of SD-2"));
    expect(deps.pendingOffers!.drop).toHaveBeenCalledWith(convId, sender);
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(convId,
      "Please send one command per message. I have not run any commands from this message.", expect.anything());
  });

  it.each(["reply to OPS-12: thanks", "reply to SD-4 thanks", "reply to Bob: thanks", "reply to KB-10: thanks"])("does not treat '%s' as a service-desk reply", async (text) => {
    const deps = offerDeps(false);
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.replyToServiceDesk!.execute).not.toHaveBeenCalled();
  });

  it("refuses a service-desk reply combined with another command in one message", async () => {
    const deps = offerDeps(false);
    const message = customMention("status of SD-5\nreply to SD-4: done");
    await new WireEventRouter(deps).onTextMessageReceived(message);
    expect(deps.replyToServiceDesk!.execute).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(convId,
      "Please send one command per message. I have not run any commands from this message.", { replyToMessageId: message.id });
  });
});

describe("WireEventRouter contract: channel timezone", () => {
  const tzDeps = () => makeDeps({ setChannelTimezone: { execute: vi.fn().mockResolvedValue(undefined) } } as unknown as Partial<WireEventRouterDeps>);

  it.each([
    ["timezone Europe/Berlin", "Europe/Berlin"],
    ["set the timezone to america/new_york", "america/new_york"],
    ["time zone UTC.", "UTC"],
    ["change our time zone to Europe/London", "Europe/London"],
    ["set this channel's timezone Europe/Paris", "Europe/Paris"],
    ["change the channel's timezone to America/Argentina/Buenos_Aires", "America/Argentina/Buenos_Aires"],
    ["timezone: Asia/Tokyo", "Asia/Tokyo"],
    ["timezone to Europe/Berlin!", "Europe/Berlin"],
    ["timezone Etc/GMT+1", "Etc/GMT+1"],
  ])("'%s' → setChannelTimezone(%s) when the bot is mentioned", async (text, timezone) => {
    const deps = tzDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.setChannelTimezone!.execute).toHaveBeenCalledWith(expect.objectContaining({ conversationId: convId, actorId: sender, timezone }));
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  });

  it("shows the current timezone for a bare 'timezone'", async () => {
    const deps = tzDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention("timezone?"));
    expect(deps.setChannelTimezone!.execute).toHaveBeenCalledWith(expect.not.objectContaining({ timezone: expect.anything() }));
  });

  it.each(["timezone differences?", "timezone of the customer is different", "time zone +01:00"])(
    "lets '%s' continue to normal routing", async (text) => {
      const deps = tzDeps();
      await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
      expect(deps.setChannelTimezone!.execute).not.toHaveBeenCalled();
      expect(deps.answerQuestion.execute).toHaveBeenCalled();
    });

  it("never changes the timezone from chat that does not mention the bot", async () => {
    const deps = tzDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("timezone Europe/Berlin"));
    expect(deps.setChannelTimezone!.execute).not.toHaveBeenCalled();
  });
});
