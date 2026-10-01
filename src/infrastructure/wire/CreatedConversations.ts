import type { QualifiedId } from "../../domain/ids/QualifiedId";
import { toChannelId } from "../../domain/ids/channelId";

/**
 * Groups the app created for someone else and has not yet left. The router ignores them (no
 * welcome, no processing) until the app has left. In memory; refilled at start-up from the
 * requests whose group is not yet left (see `LeavePendingAgentGroups`).
 */
export class CreatedConversations {
  private readonly ids = new Set<string>();

  add(conversationId: QualifiedId): void {
    this.ids.add(toChannelId(conversationId));
  }

  has(conversationId: QualifiedId): boolean {
    return this.ids.has(toChannelId(conversationId));
  }

  remove(conversationId: QualifiedId): void {
    this.ids.delete(toChannelId(conversationId));
  }
}
