import type { InboundFile } from "../ports/PendingOfferPort";
import { REPLY_FOOTER } from "../usecases/jira/formatIssue";

/** Largest file the bot offers to attach. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const PHOTO_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"]);
const DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/** "photo" or "file" for a type the bot attaches, null for any other type (archives, executables, video). */
export function attachableKind(mimeType: string): InboundFile["fileKind"] | null {
  const type = mimeType.split(";")[0]!.trim().toLowerCase();
  if (PHOTO_TYPES.has(type)) return "photo";
  if (DOCUMENT_TYPES.has(type)) return "file";
  return null;
}

/** "this photo" or "this file (<name>)", for offers and confirmations. */
export function describeFile(file: Pick<InboundFile, "fileKind" | "name">): string {
  return file.fileKind === "photo" ? "this photo" : `this file (${plainName(file.name)})`;
}

/** A posted file name as plain text in a Wire message: no Markdown, links or line breaks. */
export function plainName(name: string): string {
  return name.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/[\\`*_~[\]()<>#|]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "file";
}

/** The offer, as a reply to the posted file: the target request and "(yes or no)?". */
export function formatAttachQuestion(key: string, summary: string, file: Pick<InboundFile, "fileKind" | "name">): string {
  return `Shall I add ${describeFile(file)} to **${key}** "${summary.replace(/\s+/g, " ").trim()}"?\n\n(yes or no)?`;
}

/** The public reply that carries the attachment in the tracker. */
export function attachmentComment(file: Pick<InboundFile, "fileKind">, senderName: string | undefined): string {
  const what = file.fileKind === "photo" ? "Photo" : "File";
  const by = senderName?.trim() ? `, sent by ${senderName.trim()}` : "";
  return `${what} from Wire${by}. ${REPLY_FOOTER}`;
}
