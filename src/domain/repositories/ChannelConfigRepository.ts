/** Per-conversation settings the bot keeps. */
export interface ChannelConfig {
  /** "{conversationId}@{conversationDomain}" */
  channelId: string;
  /** Wire domain string, e.g. "example.com" */
  organisationId: string;
  /** Canonical IANA timezone for reply times. */
  timezone: string;
  /** When the record was created; set by the store. */
  createdAt?: Date;
  /** When the record last changed; set by the store. */
  updatedAt?: Date;
}

export interface ChannelConfigRepository {
  get(channelId: string): Promise<ChannelConfig | null>;
  upsert(config: ChannelConfig): Promise<ChannelConfig>;
  /**
   * Set only the timezone of an existing channel, leaving the rest as stored. Creates a minimal
   * config from `whenMissing` only when the channel has none.
   */
  setTimezone(channelId: string, timezone: string, whenMissing: { organisationId: string }): Promise<void>;
}
