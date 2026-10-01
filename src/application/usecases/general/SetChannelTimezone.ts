import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { ChannelConfig, ChannelConfigRepository } from "../../../domain/repositories/ChannelConfigRepository";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import { canonicalTimeZone } from "../../../domain/services/timeZone";
import type { Logger } from "../../ports/Logger";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import { formatTimeInZone } from "../../services/formatTimeInZone";

/** Input of `SetChannelTimezone`. */
export interface SetChannelTimezoneInput {
  conversationId: QualifiedId;
  /** Canonical channel ID used by `ChannelConfigRepository`. */
  channelId: string;
  actorId: QualifiedId;
  /** The requested IANA name; absent to show the current timezone. */
  timezone?: string;
  replyToMessageId?: string;
}

const SAVE_FAILED = "I'm afraid I couldn't save the timezone just now. Please try again.";
const READ_FAILED = "I'm afraid I couldn't read the timezone just now. Please try again.";

/**
 * Shows or sets the channel's timezone, which decides how times such as service-desk reply times
 * are shown. Stored instants do not move when the zone changes.
 */
export class SetChannelTimezone {
  constructor(
    private readonly channelConfig: ChannelConfigRepository,
    private readonly auditLog: AuditLogRepository,
    private readonly wireOutbound: WireOutboundPort,
    private readonly defaultTimezone: string,
    private readonly now: () => Date = () => new Date(),
    private readonly logger?: Logger,
  ) {}

  async execute(input: SetChannelTimezoneInput): Promise<void> {
    if (input.timezone === undefined) {
      let config: ChannelConfig | null;
      try {
        config = await this.channelConfig.get(input.channelId);
      } catch {
        await this.reply(input, READ_FAILED);
        return;
      }
      const zone = config?.timezone ?? this.defaultTimezone;
      await this.reply(input, `This channel's timezone is **${zone}** (currently ${this.currentTime(zone)}).`);
      return;
    }

    const zone = canonicalTimeZone(input.timezone);
    if (!zone) {
      await this.reply(input, `I'm afraid I don't know the timezone "${input.timezone.trim()}". Please use a name such as Europe/Berlin or America/New_York.`);
      return;
    }

    let existing: ChannelConfig | null;
    try {
      existing = await this.channelConfig.get(input.channelId);
    } catch {
      await this.reply(input, SAVE_FAILED);
      return;
    }
    const from = existing?.timezone ?? this.defaultTimezone;
    if (from === zone) {
      await this.reply(input, `This channel's timezone is already **${zone}**.`);
      return;
    }
    try {
      // Only the timezone column changes; a channel without a record gets the same minimal
      // config the router creates for one.
      await this.channelConfig.setTimezone(input.channelId, zone, { organisationId: input.conversationId.domain });
    } catch {
      await this.reply(input, SAVE_FAILED);
      return;
    }

    try {
      await this.auditLog.append({
        timestamp: this.now(),
        actorId: input.actorId,
        conversationId: input.conversationId,
        action: "config_changed",
        entityType: "ChannelConfig",
        entityId: input.channelId,
        details: { timezone: { from, to: zone } },
      });
    } catch (err) {
      this.logger?.error("SetChannelTimezone: audit failed after saving the timezone", { err: err instanceof Error ? err.name : "UnknownError" });
    }
    await this.reply(input, `This channel's timezone is now **${zone}** (currently ${this.currentTime(zone)}).`);
  }

  private currentTime(zone: string): string {
    return formatTimeInZone(this.now(), zone, "time");
  }

  private async reply(input: SetChannelTimezoneInput, text: string): Promise<void> {
    await this.wireOutbound.sendPlainText(input.conversationId, text, { replyToMessageId: input.replyToMessageId });
  }
}
