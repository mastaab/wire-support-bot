import type { PartDetails, SupportRequestKind } from "../../domain/entities/SupportRequest";
/**
 * Port for passive service-desk help: the model reads one unaddressed message and either
 * drafts a support request from it or maps a status question to an open request. It only
 * proposes; code validates the result, and nothing reaches the tracker without a yes.
 */

/** An open support request of the conversation, as shown to the model: key and summary only. */
export interface OpenRequestRef {
  key: string;
  summary: string;
  /** Raised by this message's speaker within the last hour, so a message without its own subject ("it only happens on the 3rd floor") may continue it. */
  raisedBySpeakerRecently?: boolean;
}

export interface SupportDraft {
  /** What the message asks for; decides the request type. */
  requestKind: SupportRequestKind;
  /** For a part order: only the essentials stated in this message, never invented. */
  part?: PartDetails;
  /** One line in the speaker's words. */
  summary: string;
  /** Only the problem stated in the message, never the surrounding conversation. */
  description: string;
  /** Key of an open request that already covers this problem, or null. */
  duplicateOf: string | null;
  /**
   * With `duplicateOf`: the new information this message adds to that request (a detail, a
   * change, "it happened again"), in the speaker's words and from this message only; null when
   * it adds nothing.
   */
  addition: string | null;
  /**
   * Key of a listed open request this message says is solved or can be closed, or null. Takes
   * precedence over `addition` and over raising a new request.
   */
  resolves: string | null;
  /** With `resolves`: the closing remark to add to that request, in the speaker's words and from this message only; null when there is none. */
  closingComment: string | null;
}

export interface SupportTriagePort {
  /** Drafts a request from this single message, or null when it describes no service-desk problem. */
  draftRequest(message: string, openRequests: readonly OpenRequestRef[]): Promise<SupportDraft | null>;
  /** The key of the open request this question asks about, or null when it matches none. */
  matchStatusQuestion(message: string, openRequests: readonly OpenRequestRef[]): Promise<string | null>;
  /**
   * The part-order essentials this single message states (asset, part, quantity, delivery
   * location), each in the speaker's words, never invented; an empty object when it states none.
   */
  extractPartDetails(message: string): Promise<PartDetails>;
}
