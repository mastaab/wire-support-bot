import { SUPPORT_REQUEST_KINDS } from "../../../domain/entities/SupportRequest";
import type { SupportRequest, SupportRequestKind, SupportRequestStatusCategory } from "../../../domain/entities/SupportRequest";
import type {
  SupportRequestListOptions,
  SupportRequestRepository,
} from "../../../domain/repositories/SupportRequestRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { getPrismaClient } from "./PrismaClient";

const STATUS_CATEGORIES: readonly SupportRequestStatusCategory[] = ["todo", "in_progress", "done"];

/** An unknown stored value reads as "todo" so a bad row never counts as resolved. */
function statusCategoryFromRow(value: string): SupportRequestStatusCategory {
  return (STATUS_CATEGORIES as readonly string[]).includes(value) ? (value as SupportRequestStatusCategory) : "todo";
}

export class PrismaSupportRequestRepository implements SupportRequestRepository {
  private prisma = getPrismaClient();

  async create(request: SupportRequest): Promise<SupportRequest> {
    await this.prisma.supportRequest.create({
      data: {
        key: request.key,
        conversationId: request.conversationId.id,
        conversationDom: request.conversationId.domain,
        requesterId: request.requesterId.id,
        requesterDom: request.requesterId.domain,
        requesterName: request.requesterName,
        summary: request.summary,
        kind: request.kind,
        statusCategory: request.statusCategory,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
        deleted: request.deleted,
        version: request.version,
        lastSeenReplyAt: request.lastSeenReplyAt ?? null,
        lastMessageId: request.lastMessage?.messageId ?? null,
        lastMessageSha256: request.lastMessage?.sha256 ?? null,
        assigneeAccountId: request.assigneeAccountId ?? null,
        assigneeSeenAt: request.assigneeSeenAt ?? null,
      },
    });
    return request;
  }

  async findByKey(key: string): Promise<SupportRequest | null> {
    const row = await this.prisma.supportRequest.findUnique({ where: { key } });
    if (!row) return null;
    return this.fromRow(row);
  }

  async listByConversation(
    conversationId: QualifiedId,
    options: SupportRequestListOptions = {},
  ): Promise<SupportRequest[]> {
    const where: Record<string, unknown> = {
      conversationId: conversationId.id,
      conversationDom: conversationId.domain,
      deleted: false,
    };
    if (options.openOnly) where.statusCategory = { not: "done" };
    if (options.requesterId) {
      where.requesterId = options.requesterId.id;
      where.requesterDom = options.requesterId.domain;
    }
    const take = options.limit ?? 50;
    const rows = await this.prisma.supportRequest.findMany({ where, take, orderBy: { createdAt: "desc" } });
    return rows.map((r) => this.fromRow(r));
  }

  async updateStatusCategory(
    key: string,
    statusCategory: SupportRequestStatusCategory,
    updatedAt: Date,
  ): Promise<SupportRequest | null> {
    // updateMany does not throw on a missing key, unlike update.
    const result = await this.prisma.supportRequest.updateMany({
      where: { key },
      data: { statusCategory, updatedAt, version: { increment: 1 } },
    });
    if (result.count === 0) return null;
    return this.findByKey(key);
  }

  async listWatched(resolvedSince: Date, limit = 500): Promise<SupportRequest[]> {
    const rows = await this.prisma.supportRequest.findMany({
      where: {
        deleted: false,
        OR: [{ statusCategory: { not: "done" } }, { updatedAt: { gte: resolvedSince } }],
      },
      take: limit,
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => this.fromRow(r));
  }

  async advanceLastSeenReplyAt(key: string, at: Date): Promise<void> {
    await this.prisma.supportRequest.updateMany({
      where: { key, OR: [{ lastSeenReplyAt: null }, { lastSeenReplyAt: { lt: at } }] },
      data: { lastSeenReplyAt: at },
    });
  }

  async setAssignee(key: string, accountId: string | null): Promise<void> {
    await this.prisma.supportRequest.updateMany({ where: { key }, data: { assigneeAccountId: accountId } });
    await this.prisma.supportRequest.updateMany({ where: { key, assigneeSeenAt: null }, data: { assigneeSeenAt: new Date() } });
  }

  async markAgentConversation(key: string, at: Date): Promise<boolean> {
    const result = await this.prisma.supportRequest.updateMany({
      where: { key, agentConversationAt: null },
      data: { agentConversationAt: at },
    });
    return result.count === 1;
  }

  async setLastMessage(key: string, ref: { messageId: string; sha256: string }): Promise<void> {
    await this.prisma.supportRequest.updateMany({
      where: { key },
      data: { lastMessageId: ref.messageId, lastMessageSha256: ref.sha256, lastMessageAt: new Date() },
    });
  }

  async setAgentConversation(key: string, conversationId: QualifiedId): Promise<void> {
    await this.prisma.supportRequest.updateMany({
      where: { key },
      data: { agentConversationId: conversationId.id, agentConversationDom: conversationId.domain },
    });
  }

  async markAgentConversationLeft(key: string, at: Date): Promise<void> {
    await this.prisma.supportRequest.updateMany({ where: { key }, data: { agentConversationLeftAt: at } });
  }

  async listAgentConversationsNotLeft(limit = 500): Promise<SupportRequest[]> {
    const rows = await this.prisma.supportRequest.findMany({
      where: { agentConversationId: { not: null }, agentConversationDom: { not: null }, agentConversationLeftAt: null },
      take: limit,
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => this.fromRow(r));
  }

  private fromRow(row: {
    key: string;
    conversationId: string;
    conversationDom: string;
    requesterId: string;
    requesterDom: string;
    requesterName: string;
    summary: string;
    kind: string;
    statusCategory: string;
    createdAt: Date;
    updatedAt: Date;
    deleted: boolean;
    version: number;
    lastSeenReplyAt: Date | null;
    lastMessageId: string | null;
    lastMessageSha256: string | null;
    lastMessageAt: Date | null;
    assigneeAccountId: string | null;
    assigneeSeenAt: Date | null;
    agentConversationAt: Date | null;
    agentConversationId: string | null;
    agentConversationDom: string | null;
    agentConversationLeftAt: Date | null;
  }): SupportRequest {
    return {
      key: row.key,
      conversationId: { id: row.conversationId, domain: row.conversationDom },
      requesterId: { id: row.requesterId, domain: row.requesterDom },
      requesterName: row.requesterName,
      summary: row.summary,
      kind: kindFromRow(row.kind),
      statusCategory: statusCategoryFromRow(row.statusCategory),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deleted: row.deleted,
      version: row.version,
      ...(row.lastSeenReplyAt ? { lastSeenReplyAt: row.lastSeenReplyAt } : {}),
      ...(row.lastMessageId && row.lastMessageSha256
        ? { lastMessage: { messageId: row.lastMessageId, sha256: row.lastMessageSha256 } }
        : {}),
      ...(row.lastMessageAt ? { lastMessageAt: row.lastMessageAt } : {}),
      ...(row.assigneeAccountId ? { assigneeAccountId: row.assigneeAccountId } : {}),
      ...(row.assigneeSeenAt ? { assigneeSeenAt: row.assigneeSeenAt } : {}),
      ...(row.agentConversationAt ? { agentConversationAt: row.agentConversationAt } : {}),
      ...(row.agentConversationId && row.agentConversationDom
        ? { agentConversationId: { id: row.agentConversationId, domain: row.agentConversationDom } }
        : {}),
      ...(row.agentConversationLeftAt ? { agentConversationLeftAt: row.agentConversationLeftAt } : {}),
    };
  }
}

/** A stored kind the code does not know reads as a fault, the general request type. */
function kindFromRow(value: string): SupportRequestKind {
  return (SUPPORT_REQUEST_KINDS as readonly string[]).includes(value) ? (value as SupportRequestKind) : "fault";
}
