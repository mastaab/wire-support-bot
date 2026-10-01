import type { ChannelConfig, ChannelConfigRepository } from "../../../domain/repositories/ChannelConfigRepository";
import { getPrismaClient } from "./PrismaClient";

function toChannelConfig(row: {
  channelId: string;
  organisationId: string;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
}): ChannelConfig {
  return {
    channelId: row.channelId,
    organisationId: row.organisationId,
    timezone: row.timezone,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaChannelConfigRepository implements ChannelConfigRepository {
  private readonly prisma = getPrismaClient();

  async get(channelId: string): Promise<ChannelConfig | null> {
    const row = await this.prisma.channelConfig.findUnique({ where: { channelId } });
    return row ? toChannelConfig(row) : null;
  }

  async upsert(config: ChannelConfig): Promise<ChannelConfig> {
    const row = await this.prisma.channelConfig.upsert({
      where: { channelId: config.channelId },
      create: {
        channelId: config.channelId,
        organisationId: config.organisationId,
        timezone: config.timezone,
      },
      update: {
        organisationId: config.organisationId,
        timezone: config.timezone,
      },
    });
    return toChannelConfig(row);
  }

  async setTimezone(channelId: string, timezone: string, whenMissing: { organisationId: string }): Promise<void> {
    await this.prisma.channelConfig.upsert({
      where: { channelId },
      create: { channelId, organisationId: whenMissing.organisationId, timezone },
      update: { timezone },
    });
  }
}
