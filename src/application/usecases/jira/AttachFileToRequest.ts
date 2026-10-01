import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { InboundFile } from "../../ports/PendingOfferPort";
import type { WireAssetPort } from "../../ports/WireAssetPort";
import type { SentMessageRef, WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { ATTACHMENT_MAX_BYTES, attachmentComment, plainName } from "../../services/attachments";
import { findSupportRequestInConversation } from "./supportRequestScope";
import { appendAuditSafely, notInConversation, wasRefused } from "./supportRequestStatus";
import { rememberLastMessage } from "./supportRequestMarkers";

/** Input of `AttachFileToRequest`. */
export interface AttachFileToRequestInput {
  issueKey: string;
  file: InboundFile;
  conversationId: QualifiedId;
  /** The member who confirmed; recorded in the audit entry. */
  actorId: QualifiedId;
  /** Display name for the attachment comment ("Photo from Wire, sent by <name>."). */
  senderName?: string;
  replyToMessageId?: string;
}

/** Audit outcome of an attach that reached the tracker. */
type AttachOutcome = "attached" | "attach_refused" | "attach_unconfirmed";

/**
 * Runs a confirmed `attach` offer: re-checks that the request belongs to this conversation
 * (`findSupportRequestInConversation`), downloads the file from Wire, attaches it to the
 * request as a public reply (`attachmentComment`), audits the attach (MIME type and size, never
 * the name or bytes), replies "Added the photo to **KEY** in Jira." and stores that reply as
 * the request's last message. The bytes stay in memory only. A failed download or upload is
 * reported plainly; an upload that may have been accepted does not invite a retry
 * (`wasRefused`). Returns true when the file was attached.
 */
export class AttachFileToRequest {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly assets: WireAssetPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /** Exactly one Wire message is sent either way. */
  async execute(input: AttachFileToRequestInput): Promise<boolean> {
    const reply = (text: string): Promise<SentMessageRef | undefined> =>
      this.wireOutbound.sendPlainText(input.conversationId, text, { replyToMessageId: input.replyToMessageId });

    const request = await findSupportRequestInConversation(
      this.requests, input.issueKey, input.conversationId, this.tracker.projectKey,
    );
    if (!request) {
      await reply(notInConversation(input.issueKey));
      return false;
    }
    const key = request.key;
    // A message naming this conversation's request becomes its last message, quoted by the next watch update.
    const replyAbout = async (text: string): Promise<void> =>
      rememberLastMessage(this.requests, key, await reply(text), "AttachFileToRequest", this.logger);

    const { file } = input;
    const noun = file.fileKind === "photo" ? "the photo" : "the file";
    if (request.statusCategory === "done") {
      await replyAbout(`**${key}** is already resolved, so I haven't added ${noun}.`);
      return false;
    }

    const notFetched = `I'm afraid I couldn't fetch ${noun} from Wire, so I haven't added it to **${key}**.`;
    // The router checks the posted size; a larger file is not downloaded at all.
    if (file.sizeInBytes > ATTACHMENT_MAX_BYTES) {
      await replyAbout(notFetched);
      return false;
    }
    let data: Uint8Array;
    try {
      data = await this.assets.download(file.ref);
    } catch (err) {
      this.logger?.warn("AttachFileToRequest: download failed", { key, err: errorName(err) });
      await replyAbout(notFetched);
      return false;
    }
    if (data.byteLength > ATTACHMENT_MAX_BYTES) {
      this.logger?.warn("AttachFileToRequest: download over the size limit", { key });
      await replyAbout(notFetched);
      return false;
    }

    const sizeInBytes = data.byteLength;
    try {
      await this.tracker.addCustomerAttachment(
        key,
        { name: file.name, mimeType: file.mimeType, data },
        attachmentComment(file, input.senderName),
      );
    } catch (err) {
      this.logger?.warn("AttachFileToRequest: addCustomerAttachment failed", { key, ...trackerErrorFields(err) });
      if (wasRefused(err)) {
        await this.audit(input, key, sizeInBytes, "attach_refused");
        await replyAbout(`I'm afraid the service desk didn't accept ${noun} for **${key}**.`);
        return false;
      }
      // Jira may have accepted the file, so the reply does not invite a retry.
      await this.audit(input, key, sizeInBytes, "attach_unconfirmed");
      await replyAbout(`I'm afraid I couldn't confirm that ${noun} reached **${key}**; please check the ticket before sending it again.`);
      return false;
    }

    // The file is public in Jira now, so an audit failure must not suggest otherwise.
    await this.audit(input, key, sizeInBytes, "attached");
    await replyAbout(file.fileKind === "photo"
      ? `Added the photo to **${key}** in Jira.`
      : `Added the file (${plainName(file.name)}) to **${key}** in Jira.`);
    return true;
  }

  /** The attach as an update of the request: MIME type and size only, never the name or bytes. */
  private audit(input: AttachFileToRequestInput, key: string, sizeInBytes: number, outcome: AttachOutcome): Promise<void> {
    return appendAuditSafely(this.auditLog, {
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "SupportRequest",
      entityId: key,
      details: { attachment: { mimeType: baseType(input.file.mimeType), sizeInBytes }, outcome },
    }, "AttachFileToRequest", this.logger);
  }
}

/** The MIME type without parameters. */
function baseType(mimeType: string): string {
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
