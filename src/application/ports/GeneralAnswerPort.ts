import type { RetrievalResult } from "./RetrievalPort";

export interface ConversationMemberContext {
  id: string;
  domain?: string;
  name?: string;
}

/** Answered when the model returned nothing usable. */
export const NO_ANSWER_TEXT = "I wasn't able to generate a response.";
/** Answered when the model call failed. */
export const ANSWER_FAILED_TEXT = "I wasn't able to generate a response just now.";
/** Answered when the model call timed out. */
export const ANSWER_TIMEOUT_TEXT = "I'm afraid I wasn't able to respond in time; the request timed out.";

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
