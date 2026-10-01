/**
 * Contract tests for files posted in Wire: which asset events reach the
 * attachment offer, and with what. Uses the SDK's message factories, no network.
 */
import { describe, it, expect, vi } from "vitest";
import { AssetMessage, TextMessage } from "@wireapp/wire-apps-js-sdk";
import { WireEventRouter } from "../../src/infrastructure/wire/WireEventRouter";
import type { WireEventRouterDeps } from "../../src/infrastructure/wire/WireEventRouter";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import { InMemoryMemberCache } from "../../src/infrastructure/services/InMemoryMemberCache";
import { CreatedConversations } from "../../src/infrastructure/wire/CreatedConversations";
import { createWireConversationAdapter } from "../../src/infrastructure/wire/WireConversationAdapter";
import { LeavePendingAgentGroups } from "../../src/application/usecases/jira/LeavePendingAgentGroups";
import { makeRequest, makeRequests } from "../usecases/supportRequestFakes";

const convId: QualifiedId = { id: "conv-1", domain: "example.com" };
const sender: QualifiedId = { id: "user-1", domain: "example.com" };
const bot: QualifiedId = { id: "bot-1", domain: "example.com" };
const remoteData = { otrKey: new Uint8Array([1]), sha256: new Uint8Array([2]), assetId: "asset-1", assetToken: "token", assetDomain: "example.com" };

function asset(overrides: Partial<Parameters<typeof AssetMessage.create>[0]> = {}) {
  return AssetMessage.create({
    messageId: "file-1", conversationId: convId, senderId: sender, sizeInBytes: 2048, name: "jam.jpg",
    mimeType: "image/jpeg", remoteData, ...overrides,
  });
}

function deps(overrides: Partial<WireEventRouterDeps> = {}) {
  const offerAttachment = { execute: vi.fn().mockResolvedValue(true) };
  const all = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() },
    botUserId: bot,
    wireOutbound: { sendPlainText: vi.fn(), sendReaction: vi.fn(), getUserProfile: vi.fn().mockResolvedValue(null), sendCompositePrompt: vi.fn(), sendButtonConfirmation: vi.fn(), sendFile: vi.fn() },
    memberCache: new InMemoryMemberCache(),
    messageBuffer: { push: vi.fn(), getRecent: vi.fn().mockReturnValue([]), clear: vi.fn() },
    channelConfig: {
      get: vi.fn(async () => ({ channelId: "conv-1@example.com", organisationId: "example.com", timezone: "UTC" })),
      upsert: vi.fn(), setTimezone: vi.fn(),
    },
    offerAttachment,
    ...overrides,
  } as unknown as WireEventRouterDeps;
  return { deps: all, offerAttachment };
}

describe("WireEventRouter contract: posted files", () => {
  it("offers an uploaded photo once, with its download reference and what it is, and notes it as context", async () => {
    const { deps: d, offerAttachment } = deps();
    await new WireEventRouter(d).onAssetMessageReceived(asset());
    expect(offerAttachment.execute).toHaveBeenCalledWith({
      conversationId: convId, senderId: sender, messageId: "file-1",
      file: { ref: { transport: "wire", data: remoteData }, fileKind: "photo", name: "jam.jpg", mimeType: "image/jpeg", sizeInBytes: 2048 },
    });
    expect(vi.mocked(d.messageBuffer.push)).toHaveBeenCalledWith(convId, expect.objectContaining({ messageId: "file-1", text: "(photo)" }));
  });

  it("ignores the preview without download data and a repeat of the same message", async () => {
    const { deps: d, offerAttachment } = deps();
    const router = new WireEventRouter(d);
    await router.onAssetMessageReceived(asset({ remoteData: null }));
    expect(offerAttachment.execute).not.toHaveBeenCalled();
    await router.onAssetMessageReceived(asset());
    await router.onAssetMessageReceived(asset());
    expect(offerAttachment.execute).toHaveBeenCalledTimes(1);
  });

  it("completes a bare upload event with its preview's type, name, size and time", async () => {
    const replyContext = { withMessage: vi.fn((_m: unknown, handle: () => Promise<unknown>) => handle()), get: vi.fn() };
    const { deps: d, offerAttachment } = deps({ replyContext } as never);
    const router = new WireEventRouter(d);
    const previewTime = new Date("2026-09-28T10:00:00Z");
    await router.onAssetMessageReceived(asset({ remoteData: null, timestamp: previewTime }));
    // As the SDK maps an upload-only event: no original part, so an unknown type, no name, size 0.
    await router.onAssetMessageReceived(asset({ mimeType: "*/*", name: null, sizeInBytes: 0, timestamp: new Date("2026-09-28T10:00:05Z") }));
    expect(offerAttachment.execute).toHaveBeenCalledWith(expect.objectContaining({
      file: expect.objectContaining({ fileKind: "photo", name: "jam.jpg", mimeType: "image/jpeg", sizeInBytes: 2048 }),
    }));
    const quoted = replyContext.withMessage.mock.calls.at(-1)![0] as { timestamp: Date };
    expect(quoted.timestamp).toEqual(previewTime);
  });

  it("keeps a self-deleting preview's timer for the upload event", async () => {
    const { deps: d, offerAttachment } = deps();
    const router = new WireEventRouter(d);
    await router.onAssetMessageReceived(asset({ remoteData: null, expiresAfterMillis: 30_000 }));
    await router.onAssetMessageReceived(asset({ mimeType: "*/*", name: null, sizeInBytes: 0 }));
    expect(offerAttachment.execute).not.toHaveBeenCalled();
  });

  it("does not use another sender's preview", async () => {
    const { deps: d, offerAttachment } = deps();
    const router = new WireEventRouter(d);
    await router.onAssetMessageReceived(asset({ remoteData: null, senderId: { id: "user-2", domain: "example.com" } }));
    await router.onAssetMessageReceived(asset({ mimeType: "*/*", name: null, sizeInBytes: 0 }));
    expect(offerAttachment.execute).not.toHaveBeenCalled();
  });

  it("offers a document as a file", async () => {
    const { deps: d, offerAttachment } = deps();
    await new WireEventRouter(d).onAssetMessageReceived(asset({ mimeType: "application/pdf", name: "delivery-note.pdf" }));
    expect(offerAttachment.execute).toHaveBeenCalledWith(expect.objectContaining({
      file: expect.objectContaining({ fileKind: "file", name: "delivery-note.pdf" }),
    }));
  });

  it.each([
    ["a self-deleting file", { expiresAfterMillis: 60_000 }],
    ["an unsupported type", { mimeType: "application/zip" }],
    ["a video", { mimeType: "video/mp4" }],
    ["a file over 10 MB", { sizeInBytes: 10 * 1024 * 1024 + 1 }],
    ["an empty file", { sizeInBytes: 0 }],
    ["the bot's own file", { senderId: bot }],
  ])("ignores %s", async (_label, overrides) => {
    const { deps: d, offerAttachment } = deps();
    await new WireEventRouter(d).onAssetMessageReceived(asset(overrides as never));
    expect(offerAttachment.execute).not.toHaveBeenCalled();
    expect(vi.mocked(d.messageBuffer.push)).not.toHaveBeenCalled();
  });

  it("does nothing without the attachment offer (passive help off)", async () => {
    const { deps: d } = deps({ offerAttachment: undefined });
    await new WireEventRouter(d).onAssetMessageReceived(asset());
    expect(vi.mocked(d.messageBuffer.push)).not.toHaveBeenCalled();
  });

  it("names a photo without a name generically", async () => {
    const { deps: d, offerAttachment } = deps();
    await new WireEventRouter(d).onAssetMessageReceived(asset({ name: null }));
    expect(offerAttachment.execute).toHaveBeenCalledWith(expect.objectContaining({ file: expect.objectContaining({ name: "photo" }) }));
  });

  it("keeps the channel's message order with text messages", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const offerAttachment = { execute: vi.fn(() => new Promise<boolean>((resolve) => { release = () => { order.push("file"); resolve(true); }; })) };
    const { deps: d } = deps({ offerAttachment } as never);
    const router = new WireEventRouter(d);
    const file = router.onAssetMessageReceived(asset());
    const text = router.onTextMessageReceived(TextMessage.create({ conversationId: convId, text: "hello", senderId: sender } as never)).then(() => order.push("text"));
    await vi.waitFor(() => expect(offerAttachment.execute).toHaveBeenCalled());
    release();
    await Promise.all([file, text]);
    expect(order).toEqual(["file", "text"]);
  });

  it("ignores text, files and the app-added event in a group the app created and is leaving", async () => {
    const created = new CreatedConversations();
    created.add(convId);
    const { deps: d, offerAttachment } = deps({ createdConversations: created } as never);
    const router = new WireEventRouter(d);
    await router.onAppAddedToConversation({ id: convId.id, domain: convId.domain } as never, []);
    await router.onTextMessageReceived(TextMessage.create({ conversationId: convId, text: "hello", senderId: sender } as never));
    await router.onAssetMessageReceived(asset());
    expect(d.wireOutbound.sendPlainText).not.toHaveBeenCalled();
    expect(vi.mocked(d.channelConfig.upsert)).not.toHaveBeenCalled();
    expect(offerAttachment.execute).not.toHaveBeenCalled();
    expect(vi.mocked(d.messageBuffer.push)).not.toHaveBeenCalled();
  });

  it("after a restart, ignores a group still owed a leave once start-up has tracked it, until the leave is confirmed", async () => {
    // A fresh process: the in-memory list is empty, the request stores the group as not left.
    const created = new CreatedConversations();
    const manager = {
      searchUsers: vi.fn(), createGroupConversation: vi.fn(), updateConversationMemberRole: vi.fn(), deleteConversation: vi.fn(),
      getMembersInConversation: vi.fn(),
      leaveConversation: vi.fn().mockRejectedValue(new Error("offline")),
      getAllConversations: vi.fn().mockResolvedValue([convId]),
    };
    const conversations = createWireConversationAdapter({ current: { manager: manager as never } }, "example.com", created);
    const requests = makeRequests([makeRequest({ agentConversationId: convId })]);
    const leavePending = new LeavePendingAgentGroups(requests, conversations);
    const { deps: d, offerAttachment } = deps({ createdConversations: created } as never);
    const router = new WireEventRouter(d);

    expect(await leavePending.track()).toBe(1);
    expect(await leavePending.execute()).toEqual({ left: 0, pending: 1 });
    await router.onAppAddedToConversation({ id: convId.id, domain: convId.domain } as never, []);
    await router.onTextMessageReceived(TextMessage.create({ conversationId: convId, text: "@Wire Support Bot support: paper jam", senderId: sender } as never));
    await router.onAssetMessageReceived(asset());
    expect(d.wireOutbound.sendPlainText).not.toHaveBeenCalled();
    expect(vi.mocked(d.channelConfig.upsert)).not.toHaveBeenCalled();
    expect(offerAttachment.execute).not.toHaveBeenCalled();
    expect(vi.mocked(d.messageBuffer.push)).not.toHaveBeenCalled();
    expect(requests.markAgentConversationLeft).not.toHaveBeenCalled();

    // A later run leaves; the group is no longer tracked (the bot receives nothing from it any more).
    manager.leaveConversation.mockResolvedValue(undefined);
    manager.getAllConversations.mockResolvedValueOnce([convId]).mockResolvedValueOnce([]);
    expect(await leavePending.execute()).toEqual({ left: 1, pending: 0 });
    expect(requests.markAgentConversationLeft).toHaveBeenCalledWith("SD-6", expect.any(Date));
    expect(created.has(convId)).toBe(false);
  });
});
