import type { QualifiedId } from "../../domain/ids/QualifiedId";

export interface OutboundMention {
  userId: QualifiedId;
  /** UTF-16 offset of the `@Name` token, as specified by Wire protobuf. */
  offset: number;
  /** UTF-16 length of the `@Name` token. */
  length: number;
}

/**
 * A message the bot sent: its Wire message ID and the integrity hash (SHA-256, lower-case hex)
 * that a later reply quoting it must carry. Never holds message text.
 */
export interface SentMessageRef {
  messageId: string;
  sha256: string;
}

export interface OutboundTextOptions {
  /** Reply to the matching incoming message while its handler is active, if Wire permits it. */
  replyToMessageId?: string;
  /** Reply to an earlier message the bot sent (outlives the handler). Ignored when `replyToMessageId` is set. */
  quote?: SentMessageRef;
  mentions?: OutboundMention[];
}

export interface CompositeButton {
  id: string;
  label: string;
}

/** The prompt's leading text can quote the matching incoming message. */
export interface CompositePromptOptions {
  replyToMessageId?: string;
}

export interface UserProfile {
  id: QualifiedId;
  name: string;
  handle?: string;
}

export interface WireOutboundPort {
  /** Fetch a user's display name from the Wire backend. Returns null on failure. */
  getUserProfile(userId: QualifiedId): Promise<UserProfile | null>;

  /**
   * Returns a reference to the sent message, for a later quote, or undefined when the transport
   * cannot provide one (no connection, a self-deleting message, a transport without IDs).
   */
  sendPlainText(
    conversationId: QualifiedId,
    text: string,
    options?: OutboundTextOptions,
  ): Promise<SentMessageRef | undefined>;

  /**
   * Sends a question with buttons. Clients that cannot show buttons show the text, so the text
   * must say how to answer it. Returns a reference to the sent message (a click names it), or
   * undefined like `sendPlainText`.
   */
  sendCompositePrompt(
    conversationId: QualifiedId,
    text: string,
    buttons: CompositeButton[],
    options?: CompositePromptOptions,
  ): Promise<SentMessageRef | undefined>;

  /**
   * Marks `buttonId` as the answer to the button message `referenceMessageId`. Clients apply it
   * to the message for every member, so it is sent at most once per message.
   */
  sendButtonConfirmation(conversationId: QualifiedId, referenceMessageId: string, buttonId: string): Promise<void>;

  /**
   * Replaces the bot's button message `messageId` with `text` and no buttons, for every member,
   * so a question that has ended stops inviting clicks. The whole message is replaced: clients
   * ignore a text-only edit of a button message.
   */
  closeButtonPrompt(conversationId: QualifiedId, messageId: string, text: string): Promise<void>;

  /**
   * Runs `work` while the conversation shows the app as typing, and returns its result. The
   * indicator never delays, blocks or breaks the work, and it is cleared when the work ends,
   * however it ends; refreshing and overlapping work are the transport's concern.
   */
  withTyping<T>(conversationId: QualifiedId, work: () => Promise<T>): Promise<T>;

  sendReaction(
    conversationId: QualifiedId,
    messageId: string,
    emoji: string | readonly string[],
  ): Promise<void>;

  /**
   * Send a file to a conversation.
   * @param fileStream - Readable stream of file bytes.
   * @param name - File name shown to recipients.
   * @param mimeType - MIME type of the file.
   * @param retention - Optional retention hint (e.g. "volatile", "persistent").
   */
  sendFile(
    conversationId: QualifiedId,
    fileStream: NodeJS.ReadableStream,
    name: string,
    mimeType: string,
    retention?: string,
  ): Promise<void>;
}
