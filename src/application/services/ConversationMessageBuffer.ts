import type { QualifiedId } from "../../domain/ids/QualifiedId";

export interface BufferedMessage {
  messageId: string;
  senderId: QualifiedId;
  senderName: string;
  text: string;
  timestamp: Date;
}

const DEFAULT_CAPACITY = 50;

/**
 * In-memory rolling buffer of recent messages per conversation, the context for answers and passive help.
 */
export class ConversationMessageBuffer {
  private buffers = new Map<string, BufferedMessage[]>();
  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  private key(conversationId: QualifiedId): string {
    return `${conversationId.id}@${conversationId.domain}`;
  }

  push(conversationId: QualifiedId, message: BufferedMessage): void {
    const k = this.key(conversationId);
    let list = this.buffers.get(k);
    if (!list) {
      list = [];
      this.buffers.set(k, list);
    }
    list.push(message);
    if (list.length > this.capacity) {
      list.shift();
    }
  }

  getLastN(conversationId: QualifiedId, n: number): BufferedMessage[] {
    const list = this.buffers.get(this.key(conversationId)) ?? [];
    return list.slice(-n);
  }

  clear(conversationId: QualifiedId): void {
    this.buffers.delete(this.key(conversationId));
  }
}
