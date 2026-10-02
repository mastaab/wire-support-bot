import type { RetrievalResult } from "./RetrievalPort";

export interface ConversationMemberContext {
  id: string;
  domain?: string;
  name?: string;
}

/** Options of one answer call. */
export interface GeneralAnswerOptions {
  /**
   * The requester asked to raise, order, reply to or resolve something and the previous answer
   * made no offer: the model is told so and that the answer must end with the offer marker.
   */
  requireOffer?: boolean;
}

export interface GeneralAnswerService {
  answer(
    question: string,
    conversationContext: string[],
    retrievalResults: RetrievalResult[],
    members?: ConversationMemberContext[],
    requester?: ConversationMemberContext,
    options?: GeneralAnswerOptions,
  ): Promise<string>;
}
