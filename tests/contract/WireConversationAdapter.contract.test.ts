import { describe, it, expect, vi } from "vitest";
import { ConversationRole } from "@wireapp/wire-apps-js-sdk";
import { createWireConversationAdapter } from "../../src/infrastructure/wire/WireConversationAdapter";
import { CreatedConversations } from "../../src/infrastructure/wire/CreatedConversations";

const group = { id: "group-1", domain: "wire.example.com" };
const requester = { id: "requester-1", domain: "wire.example.com" };

function setup() {
  const manager = {
    searchUsers: vi.fn().mockResolvedValue([
      { id: { id: "other", domain: "wire.example.com" }, name: "Robin D.", handle: "robindesk2" },
      { id: { id: "agent-1", domain: "wire.example.com" }, name: "Robin", handle: "RobinDesk" },
    ]),
    createGroupConversation: vi.fn().mockResolvedValue(group),
    updateConversationMemberRole: vi.fn().mockResolvedValue(undefined),
    leaveConversation: vi.fn().mockResolvedValue(undefined),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    getMembersInConversation: vi.fn().mockResolvedValue([{ userId: requester }, { userId: { id: "app", domain: "wire.example.com" } }]),
    getAllConversations: vi.fn().mockResolvedValue([]),
  };
  const created = new CreatedConversations();
  const adapter = createWireConversationAdapter({ current: { manager: manager as never } }, "wire.example.com", created);
  return { manager, created, adapter };
}

describe("WireConversationAdapter contract", () => {
  it("finds a user by exact handle on the bot's domain, ignoring similar handles", async () => {
    const { manager, adapter } = setup();
    expect(await adapter.findUserByHandle("@robindesk")).toEqual({ id: { id: "agent-1", domain: "wire.example.com" }, name: "Robin" });
    expect(manager.searchUsers).toHaveBeenCalledWith("robindesk", "wire.example.com", 10);
    expect(await adapter.findUserByHandle("nobody")).toBeNull();
  });

  it("creates a group, registers it until the app has left, and makes members admins", async () => {
    const { manager, created, adapter } = setup();
    const id = await adapter.createGroup("SD-25 Paper jam", [requester]);
    expect(id).toEqual(group);
    expect(manager.createGroupConversation.mock.calls[0]![0]).toBe("SD-25 Paper jam");
    expect(manager.createGroupConversation.mock.calls[0]![1][0]).toMatchObject(requester);
    expect(created.has(group)).toBe(true);
    await adapter.makeAdmin(group, requester);
    expect(manager.updateConversationMemberRole).toHaveBeenCalledWith(expect.objectContaining(group), expect.objectContaining(requester), ConversationRole.ADMIN);
    manager.getAllConversations.mockResolvedValueOnce([group]).mockResolvedValueOnce([]);
    await adapter.leave(group);
    expect(manager.leaveConversation).toHaveBeenCalledWith(expect.objectContaining(group));
    expect(created.has(group)).toBe(false);
  });

  it("keeps the group registered when leaving fails, so the router keeps ignoring it", async () => {
    const { manager, created, adapter } = setup();
    manager.leaveConversation.mockRejectedValue(new Error("offline"));
    manager.getAllConversations.mockResolvedValue([group]);
    await adapter.createGroup("SD-25", [requester]);
    await expect(adapter.leave(group)).rejects.toThrow("offline");
    expect(created.has(group)).toBe(true);
  });

  it("removes a group again when a member could not be added, and fails", async () => {
    const { manager, adapter } = setup();
    manager.getMembersInConversation.mockResolvedValue([{ userId: { id: "app", domain: "wire.example.com" } }]);
    await expect(adapter.createGroup("SD-25", [requester])).rejects.toThrow("Not every member could be added");
    expect(manager.deleteConversation).toHaveBeenCalledWith(expect.objectContaining(group));
  });

  it("does not trust a silent leave: still listed means not left", async () => {
    const { manager, created, adapter } = setup();
    await adapter.createGroup("SD-25", [requester]);
    manager.getAllConversations.mockResolvedValue([group]);
    await expect(adapter.leave(group)).rejects.toThrow("still in the conversation");
    expect(created.has(group)).toBe(true);
  });

  it("counts a group the app no longer lists as left, without calling leave, and stops tracking it", async () => {
    const { manager, created, adapter } = setup();
    adapter.track(group);
    expect(created.has(group)).toBe(true);
    await adapter.leave(group);
    expect(manager.leaveConversation).not.toHaveBeenCalled();
    expect(created.has(group)).toBe(false);
  });

  it("tracks a group after a restart until a confirmed leave", async () => {
    const { manager, created, adapter } = setup();
    adapter.track(group);
    manager.getAllConversations.mockResolvedValue([group]);
    await expect(adapter.leave(group)).rejects.toThrow("still in the conversation");
    expect(created.has(group)).toBe(true);
    manager.getAllConversations.mockResolvedValueOnce([group]).mockResolvedValueOnce([]);
    await adapter.leave(group);
    expect(manager.leaveConversation).toHaveBeenCalledTimes(2);
    expect(created.has(group)).toBe(false);
  });

  it("ignores a matching handle on another domain", async () => {
    const { manager, adapter } = setup();
    manager.searchUsers.mockResolvedValue([{ id: { id: "x", domain: "other.example" }, name: "Robin", handle: "robindesk" }]);
    expect(await adapter.findUserByHandle("robindesk")).toBeNull();
  });

  it("fails plainly without a connection", async () => {
    const adapter = createWireConversationAdapter({ current: null }, "wire.example.com", new CreatedConversations());
    await expect(adapter.createGroup("x", [requester])).rejects.toThrow("Wire is not connected");
  });
});
