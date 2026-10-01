/**
 * Integration tests for the support-request repository against Postgres.
 * Require DATABASE_URL and a running Postgres. Skip when INTEGRATION_TESTS is not "1".
 */
import { afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaSupportRequestRepository } from "../../src/infrastructure/persistence/postgres/PrismaSupportRequestRepository";
import { getPrismaClient } from "../../src/infrastructure/persistence/postgres/PrismaClient";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";

describe.skipIf(process.env.INTEGRATION_TESTS !== "1")("SupportRequestRepository integration", () => {
  const repo = new PrismaSupportRequestRepository();
  const runId = randomUUID().slice(0, 8).toUpperCase();
  const conv: QualifiedId = { id: `sr-conv-${runId}`, domain: "synthetic.test" };
  const otherDomainConv: QualifiedId = { id: conv.id, domain: "other.synthetic.test" };
  const alice: QualifiedId = { id: "alice", domain: conv.domain };
  const bob: QualifiedId = { id: "bob", domain: conv.domain };
  const aliceElsewhere: QualifiedId = { id: "alice", domain: "other.synthetic.test" };
  let seq = 0;

  function request(overrides: Partial<SupportRequest> = {}): SupportRequest {
    seq += 1;
    const createdAt = new Date(Date.UTC(2026, 8, 25, 9, seq));
    return {
      key: `ZZTEST-${runId}-${seq}`,
      conversationId: conv,
      requesterId: alice,
      requesterName: "Alice",
      summary: `Printer offline ${seq}`,
      kind: "fault",
      statusCategory: "todo",
      createdAt,
      updatedAt: createdAt,
      deleted: false,
      version: 1,
      ...overrides,
    };
  }

  afterAll(async () => {
    const db = getPrismaClient();
    await db.supportRequest.deleteMany({ where: { key: { startsWith: `ZZTEST-${runId}-` } } });
    await db.$disconnect();
  });

  it("round-trips a record through create and findByKey", async () => {
    const created = request({ requesterName: "", statusCategory: "in_progress" });
    await repo.create(created);
    expect(await repo.findByKey(created.key)).toEqual(created);
    expect(await repo.findByKey(`ZZTEST-${runId}-missing`)).toBeNull();
  });

  it("stores the watch markers given at creation, as RaiseSupportRequest sets them", async () => {
    const created = request();
    await repo.create({ ...created, lastSeenReplyAt: created.createdAt, assigneeSeenAt: created.createdAt });
    const found = await repo.findByKey(created.key);
    expect(found?.lastSeenReplyAt).toEqual(created.createdAt);
    expect(found?.assigneeSeenAt).toEqual(created.createdAt);
    expect(found?.assigneeAccountId).toBeUndefined();
  });

  it("keeps a non-default kind through create, a status update and reading back", async () => {
    const part = await repo.create(request({ kind: "part" }));
    await repo.updateStatusCategory(part.key, "in_progress", new Date());
    expect((await repo.findByKey(part.key))?.kind).toBe("part");
  });

  it("lists by qualified conversation, newest first, without deleted records", async () => {
    const older = await repo.create(request());
    const newer = await repo.create(request({ requesterId: bob, requesterName: "Bob" }));
    const foreign = await repo.create(request({ conversationId: otherDomainConv }));
    const deleted = await repo.create(request({ deleted: true }));

    const listed = (await repo.listByConversation(conv)).map((r) => r.key);
    expect(listed.indexOf(newer.key)).toBeLessThan(listed.indexOf(older.key));
    expect(listed).toContain(older.key);
    expect(listed).not.toContain(foreign.key);
    expect(listed).not.toContain(deleted.key);
    expect((await repo.findByKey(deleted.key))?.deleted).toBe(true);

    const foreignListed = (await repo.listByConversation(otherDomainConv)).map((r) => r.key);
    expect(foreignListed).toEqual([foreign.key]);

    const limited = await repo.listByConversation(conv, { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].createdAt.getTime()).toBeGreaterThanOrEqual(newer.createdAt.getTime());
  });

  it("filters open requests and by requester on id and domain", async () => {
    const open = await repo.create(request({ requesterId: bob, requesterName: "Bob" }));
    const done = await repo.create(request({ requesterId: bob, requesterName: "Bob", statusCategory: "done" }));
    const mine = await repo.create(request({ requesterId: alice }));

    const openKeys = (await repo.listByConversation(conv, { openOnly: true })).map((r) => r.key);
    expect(openKeys).toContain(open.key);
    expect(openKeys).toContain(mine.key);
    expect(openKeys).not.toContain(done.key);

    const bobsOpen = (await repo.listByConversation(conv, { openOnly: true, requesterId: bob })).map((r) => r.key);
    expect(bobsOpen).toContain(open.key);
    expect(bobsOpen).not.toContain(done.key);
    expect(bobsOpen).not.toContain(mine.key);

    const alicesElsewhere = await repo.listByConversation(conv, { requesterId: aliceElsewhere });
    expect(alicesElsewhere).toEqual([]);
  });

  it("updates the status category, bumps the version and returns null for a missing key", async () => {
    const created = await repo.create(request());
    const updatedAt = new Date(Date.UTC(2026, 8, 25, 12, 0));

    const updated = await repo.updateStatusCategory(created.key, "done", updatedAt);
    expect(updated).toEqual({ ...created, statusCategory: "done", updatedAt, version: 2 });
    expect(await repo.findByKey(created.key)).toEqual(updated);
    const openKeys = (await repo.listByConversation(conv, { openOnly: true })).map((r) => r.key);
    expect(openKeys).not.toContain(created.key);

    expect(await repo.updateStatusCategory(`ZZTEST-${runId}-missing`, "done", updatedAt)).toBeNull();
  });

  it("keeps the watch and agent markers: last message, last seen reply, assignee and the agent conversation claim", async () => {
    const created = await repo.create(request());
    const seen = new Date(Date.UTC(2026, 8, 25, 13, 0));
    await repo.setLastMessage(created.key, { messageId: "msg-1", sha256: "a".repeat(64) });
    await repo.advanceLastSeenReplyAt(created.key, seen);
    await repo.advanceLastSeenReplyAt(created.key, new Date(seen.getTime() - 60_000));
    await repo.setAssignee(created.key, "agent-1");
    expect(await repo.markAgentConversation(created.key, seen)).toBe(true);
    expect(await repo.markAgentConversation(created.key, new Date())).toBe(false);

    const found = await repo.findByKey(created.key);
    expect(found?.lastMessage).toEqual({ messageId: "msg-1", sha256: "a".repeat(64) });
    expect(found?.lastMessageAt).toBeInstanceOf(Date);
    expect(found?.lastSeenReplyAt).toEqual(seen);
    expect(found?.assigneeAccountId).toBe("agent-1");
    expect(found?.assigneeSeenAt).toBeInstanceOf(Date);
    expect(found?.agentConversationAt).toEqual(seen);
    expect((await repo.listWatched(seen)).map((r) => r.key)).toContain(created.key);
  });

  it("stores the agent group and its left time as bookkeeping, and lists groups not yet left", async () => {
    const group: QualifiedId = { id: `group-${runId}`, domain: "other.synthetic.test" };
    const opened = await repo.create(request());
    const deletedOpen = await repo.create(request({ deleted: true }));
    const left = await repo.create(request());
    const without = await repo.create(request());
    const ours = (rows: SupportRequest[]) => rows.map((r) => r.key).filter((k) => k.startsWith(`ZZTEST-${runId}-`));

    await repo.setAgentConversation(opened.key, group);
    await repo.setAgentConversation(deletedOpen.key, { ...group, id: `${group.id}-d` });
    await repo.setAgentConversation(left.key, { ...group, id: `${group.id}-l` });
    const leftAt = new Date(Date.UTC(2026, 9, 1, 8, 30));
    await repo.markAgentConversationLeft(left.key, leftAt);

    const found = await repo.findByKey(opened.key);
    expect(found?.agentConversationId).toEqual(group);
    expect(found?.agentConversationLeftAt).toBeUndefined();
    // Bookkeeping: neither write is a record update.
    expect(found?.version).toBe(opened.version);
    expect(found?.updatedAt).toEqual(opened.updatedAt);
    const leftRow = await repo.findByKey(left.key);
    expect(leftRow?.agentConversationLeftAt).toEqual(leftAt);
    expect(leftRow?.version).toBe(left.version);
    expect(leftRow?.updatedAt).toEqual(left.updatedAt);
    expect((await repo.findByKey(without.key))?.agentConversationId).toBeUndefined();

    // Oldest first, deleted requests included (their group still has to be left).
    expect(ours(await repo.listAgentConversationsNotLeft())).toEqual([opened.key, deletedOpen.key]);
    const rows = await repo.listAgentConversationsNotLeft();
    expect(rows.find((r) => r.key === opened.key)?.agentConversationId).toEqual(group);

    await repo.markAgentConversationLeft(opened.key, leftAt);
    expect(ours(await repo.listAgentConversationsNotLeft())).toEqual([deletedOpen.key]);
  });

  it("reads an unknown stored category as todo", async () => {
    const created = await repo.create(request());
    await getPrismaClient().supportRequest.update({ where: { key: created.key }, data: { statusCategory: "weird" } });
    expect((await repo.findByKey(created.key))?.statusCategory).toBe("todo");
  });
});
