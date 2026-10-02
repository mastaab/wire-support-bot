/**
 * Port: classify one unaddressed message for passive service-desk help. Returns the categories
 * that apply, not a single intent; the passive-help use case decides what to do with them.
 */

export type MessageCategory =
  /** Someone brings the service desk something it handles (a fault, a question, a part order), adds to a reported problem, or says one is solved. */
  | "service_request"
  /** Someone asks about the state of a problem or service request. */
  | "request_status"
  /** News about ongoing work, such as a change to a problem already reported; may add to an open request. */
  | "update"
  /** Progress is blocked by an impediment; may add to an open request. */
  | "blocker"
  /** Anything else: chat, greetings, acknowledgments, questions to colleagues. */
  | "other";

export interface ClassifyResult {
  /** One or more applicable categories: a message may be both a service request and a blocker. */
  categories: MessageCategory[];
  /** Model confidence in the classification (0 to 1). */
  confidence: number;
}

export interface ChannelContext {
  channelId: string;
}

export interface ClassifierPort {
  /**
   * Classify a single message.
   * @param text     The message text.
   * @param context  The conversation it was sent in.
   * @param recent   Recent messages of the conversation, oldest first, for context.
   */
  classify(text: string, context: ChannelContext, recent: string[]): Promise<ClassifyResult>;
}
