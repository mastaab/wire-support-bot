/**
 * Integration tests for the channel config and audit log repositories against Postgres.
 * Require DATABASE_URL and a running Postgres with the migrations applied. Skip when
 * INTEGRATION_TESTS is not "1".
 */
import { afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaChannelConfigRepository } from "../../src/infrastructure/persistence/postgres/PrismaChannelConfigRepository";
import { PrismaAuditLogRepository } from "../../src/infrastructure/persistence/postgres/PrismaAuditLogRepository";
import { getPrismaClient } from "../../src/infrastructure/persistence/postgres/PrismaClient";

describe.skipIf(process.env.INTEGRATION_TESTS !== "1")("ChannelConfigRepository and AuditLogRepository integration", () => {
  const channels = new PrismaChannelConfigRepository();
  const audit = new PrismaAuditLogRepository();
  const runId = randomUUID().slice(0, 8);
  const channelId = (n: number) => `zztest-${runId}-${n}@synthetic.test`;

  afterAll(async () => {
    const db = getPrismaClient();
    await db.channelConfig.deleteMany({ where: { channelId: { startsWith: `zztest-${runId}-` } } });
    await db.auditLog.deleteMany({ where: { entityId: { startsWith: `zztest-${runId}-` } } });
    await db.$disconnect();
  });

  it("round-trips a config through upsert and get, with store timestamps, and returns null for a missing one", async () => {
    const id = channelId(1);
    expect(await channels.get(id)).toBeNull();
    const stored = await channels.upsert({ channelId: id, organisationId: "synthetic.test", timezone: "Europe/Berlin" });
    expect(stored).toMatchObject({ channelId: id, organisationId: "synthetic.test", timezone: "Europe/Berlin" });
    expect(Object.keys(stored).sort()).toEqual(["channelId", "createdAt", "organisationId", "timezone", "updatedAt"]);
    expect(stored.createdAt).toBeInstanceOf(Date);
    expect(await channels.get(id)).toEqual(stored);
  });

  it("keeps the organisation on a timezone change of an existing config", async () => {
    const id = channelId(2);
    await channels.upsert({ channelId: id, organisationId: "synthetic.test", timezone: "UTC" });
    await channels.setTimezone(id, "America/New_York", { organisationId: "other.synthetic.test" });
    expect(await channels.get(id)).toMatchObject({ organisationId: "synthetic.test", timezone: "America/New_York" });
  });

  it("creates a minimal config when setting the timezone of a channel without one", async () => {
    const id = channelId(3);
    await channels.setTimezone(id, "Asia/Tokyo", { organisationId: "synthetic.test" });
    expect(await channels.get(id)).toMatchObject({ channelId: id, organisationId: "synthetic.test", timezone: "Asia/Tokyo" });
  });

  it("appends an audit entry with its qualified actor and conversation", async () => {
    const entityId = `zztest-${runId}-SD-1`;
    const timestamp = new Date(Date.UTC(2026, 9, 1, 8, 0));
    await audit.append({
      timestamp, actorId: { id: "alice", domain: "synthetic.test" }, conversationId: { id: "conv", domain: "synthetic.test" },
      action: "entity_created", entityType: "SupportRequest", entityId, details: { statusCategory: "todo", kind: "fault" },
    });
    const rows = await getPrismaClient().auditLog.findMany({ where: { entityId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      timestamp, actorId: "alice", actorDom: "synthetic.test", conversationId: "conv", conversationDom: "synthetic.test",
      action: "entity_created", entityType: "SupportRequest", details: { statusCategory: "todo", kind: "fault" },
    });
  });
});
