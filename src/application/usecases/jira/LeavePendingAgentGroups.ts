import type { SupportRequest } from "../../../domain/entities/SupportRequest";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import type { WireConversationPort } from "../../ports/WireConversationPort";
import type { Logger } from "../../ports/Logger";

const SOURCE = "LeavePendingAgentGroups";

export interface LeavePendingResult {
  /** Groups whose leave was confirmed in this run (including ones the app no longer lists). */
  left: number;
  /** Groups still owed a leave after this run. */
  pending: number;
}

/**
 * Finishes leaving the direct conversations `OpenAgentConversation` could not leave: the groups
 * stored with a request but not yet marked left. `track` registers them with the conversation
 * port so the router ignores them; it runs at start-up, before events are received. `execute`
 * tracks them too (catching up a failed start-up read) and tries to leave each once; a confirmed
 * leave (the port also confirms one for a group the app no longer lists) stores the left time.
 * It runs once at start-up and at the start of each Jira watch check. Logs carry error names and
 * request keys only.
 */
export class LeavePendingAgentGroups {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly conversations: WireConversationPort,
    private readonly logger?: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Registers every pending group with the port; returns how many there are. */
  async track(): Promise<number> {
    const pending = await this.listPending();
    for (const request of pending) this.conversations.track(request.agentConversationId!);
    return pending.length;
  }

  async execute(): Promise<LeavePendingResult> {
    const pending = await this.listPending();
    let left = 0;
    for (const request of pending) {
      const key = request.key;
      const groupId = request.agentConversationId!;
      this.conversations.track(groupId);
      try {
        await this.conversations.leave(groupId);
      } catch (err) {
        this.logger?.warn(`${SOURCE}: leaving the group failed; it is retried later`, { key, err: errorName(err) });
        continue;
      }
      try {
        await this.requests.markAgentConversationLeft(key, this.now());
        left++;
      } catch (err) {
        this.logger?.error(`${SOURCE}: storing the leave failed; it is confirmed again later`, { key, err: errorName(err) });
      }
    }
    if (left > 0) this.logger?.info(`${SOURCE}: left pending groups`, { left });
    return { left, pending: pending.length - left };
  }

  private async listPending(): Promise<SupportRequest[]> {
    return (await this.requests.listAgentConversationsNotLeft()).filter((request) => request.agentConversationId);
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
