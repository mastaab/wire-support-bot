import { ConversationRole, QualifiedId as SdkQualifiedId } from "@wireapp/wire-apps-js-sdk";
import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { WireConversationPort, WireUserRef } from "../../application/ports/WireConversationPort";
import type { HandlerManagerRef } from "./WireOutboundAdapter";
import type { CreatedConversations } from "./CreatedConversations";

/** The manager calls this adapter needs; kept narrow so tests need no SDK. */
export interface ConversationManagerHandle {
  searchUsers(query: string, domain: string, numberOfResults?: number): Promise<Array<{ id: QualifiedId; name: string; handle?: string | null }>>;
  createGroupConversation(name: string, userIds: QualifiedId[]): Promise<QualifiedId>;
  updateConversationMemberRole(conversationId: QualifiedId, userId: QualifiedId, role: ConversationRole): Promise<void>;
  leaveConversation(conversationId: QualifiedId): Promise<void>;
  deleteConversation(conversationId: QualifiedId): Promise<void>;
  getMembersInConversation(conversationId: QualifiedId): Promise<Array<{ userId: QualifiedId }>>;
  getAllConversations(): Promise<Array<{ id: string; domain: string }>>;
}

/** Not every member could be added (no MLS device, another team); the group was removed again. */
export class GroupMembersMissingError extends Error {
  constructor() {
    super("Not every member could be added to the group");
    this.name = "GroupMembersMissingError";
  }
}

/** The SDK returned from leaving, but the app still lists the conversation. */
export class LeaveNotConfirmedError extends Error {
  constructor() {
    super("The app is still in the conversation after leaving");
    this.name = "LeaveNotConfirmedError";
  }
}

export class WireNotConnectedError extends Error {
  constructor() {
    super("Wire is not connected");
    this.name = "WireNotConnectedError";
  }
}

const sdkId = (q: QualifiedId): SdkQualifiedId => new SdkQualifiedId(q.id, q.domain);

/**
 * Implements WireConversationPort over the SDK. Groups it creates or is asked to track are
 * registered in `created` until the app has left them, so the router does not treat them as
 * channels meanwhile.
 */
export function createWireConversationAdapter(
  handlerRef: HandlerManagerRef, domain: string, created: CreatedConversations,
): WireConversationPort {
  const manager = (): ConversationManagerHandle => {
    const m = handlerRef.current?.manager as Partial<ConversationManagerHandle> | undefined;
    if (!m?.createGroupConversation || !m.searchUsers || !m.updateConversationMemberRole || !m.leaveConversation
        || !m.deleteConversation || !m.getMembersInConversation || !m.getAllConversations) throw new WireNotConnectedError();
    return m as ConversationManagerHandle;
  };
  return {
    async findUserByHandle(handle: string): Promise<WireUserRef | null> {
      const wanted = handle.replace(/^@/, "").toLowerCase();
      const found = (await manager().searchUsers(wanted, domain, 10))
        .find((u) => u.handle?.toLowerCase() === wanted && u.id.domain === domain);
      return found ? { id: { id: found.id.id, domain: found.id.domain }, name: found.name } : null;
    },
    async createGroup(name: string, members: readonly QualifiedId[]): Promise<QualifiedId> {
      const m = manager();
      const id = await m.createGroupConversation(name, members.map(sdkId));
      const conversationId = { id: id.id, domain: id.domain };
      created.add(conversationId);
      // The SDK adds members through their devices and reports none it could not add, so check.
      const present = await m.getMembersInConversation(sdkId(conversationId));
      const missing = members.some((u) => !present.some((p) => p.userId.id === u.id && p.userId.domain === u.domain));
      if (missing) {
        await m.deleteConversation(sdkId(conversationId)).catch(() => m.leaveConversation(sdkId(conversationId)));
        throw new GroupMembersMissingError();
      }
      return conversationId;
    },
    async makeAdmin(conversationId: QualifiedId, userId: QualifiedId): Promise<void> {
      await manager().updateConversationMemberRole(sdkId(conversationId), sdkId(userId), ConversationRole.ADMIN);
    },
    async leave(conversationId: QualifiedId): Promise<void> {
      const m = manager();
      const listed = async () => (await m.getAllConversations()).some((c) => c.id === conversationId.id && c.domain === conversationId.domain);
      // A group the app no longer lists (left earlier, or removed) counts as left.
      if (await listed()) {
        await m.leaveConversation(sdkId(conversationId));
        // The SDK returns without an error in some cases where it did not leave; confirm it.
        if (await listed()) throw new LeaveNotConfirmedError();
      }
      created.remove(conversationId);
    },
    track(conversationId: QualifiedId): void {
      created.add(conversationId);
    },
  };
}
