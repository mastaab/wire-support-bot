import { sameQualifiedId } from "../../../domain/ids/QualifiedId";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { isKeyInProject } from "../../../domain/ids/jiraLink";
import type { SupportRequest } from "../../../domain/entities/SupportRequest";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";

/**
 * The support request with this key, when it belongs to the configured project, is not
 * deleted and was raised in this conversation (qualified ID match). Otherwise null, so a
 * key from another channel is treated exactly like an unknown key.
 */
export async function findSupportRequestInConversation(
  requests: SupportRequestRepository,
  key: string,
  conversationId: QualifiedId,
  projectKey: string,
): Promise<SupportRequest | null> {
  const normalized = key.trim().toUpperCase();
  if (!isKeyInProject(normalized, projectKey)) return null;
  const request = await requests.findByKey(normalized);
  if (!request || request.deleted || !sameQualifiedId(request.conversationId, conversationId)) return null;
  return request;
}
