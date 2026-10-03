import type { QualifiedId } from "../../domain/ids/QualifiedId";

/**
 * What a retrieval result holds, which decides the section of the answer prompt it appears in.
 * - `support_request`: a stored support request of this conversation (key, summary, kind, requester, last known status).
 * - `live_ticket`: live ticket data (status, SLAs, service-desk replies); only produced when sharing it with the model is on.
 * - `knowledge_article`: an excerpt from curated knowledge such as a manual or FAQ, with its source; produced by the document index when it is on.
 * - `context`: a short fact about the conversation for the model, such as its timezone or the offer being amended.
 */
export type RetrievalResultKind = "support_request" | "live_ticket" | "knowledge_article" | "context";

export interface RetrievalResult {
  /** Stable identifier within its kind, such as a ticket key or an article ID. */
  id: string;
  type: RetrievalResultKind;
  content: string;
  /** Where the content comes from, for a citation (an article title or link); absent for conversation records. */
  source?: string;
  /** When the content was created or last read. */
  sourceDate: Date;
}

/** The question a retrieval source is asked, always scoped to one conversation. */
export interface RetrievalQuery {
  question: string;
  conversationId: QualifiedId;
  /** The member who asked, when known. */
  requesterId?: QualifiedId;
}

/**
 * A source of context for the answer path, such as a knowledge base. `AnswerQuestion` adds its
 * results to the conversation's own support requests; a failing source is logged and ignored.
 */
export interface RetrievalPort {
  retrieve(query: RetrievalQuery): Promise<RetrievalResult[]>;
}
