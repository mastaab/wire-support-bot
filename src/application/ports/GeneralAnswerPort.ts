import type { RetrievalResult } from "./RetrievalPort";

export interface ConversationMemberContext {
  id: string;
  domain?: string;
  name?: string;
}

export interface GeneralAnswerService {
  answer(
    question: string,
    conversationContext: string[],
    retrievalResults: RetrievalResult[],
    members?: ConversationMemberContext[],
    requester?: ConversationMemberContext,
  ): Promise<string>;
}
