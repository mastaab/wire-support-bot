import { describe, expect, it, vi } from "vitest";
import { SetChannelTimezone } from "../../src/application/usecases/general/SetChannelTimezone";
import type { ChannelConfig } from "../../src/domain/repositories/ChannelConfigRepository";

const conversationId = { id: "conv", domain: "example.com" };
const actorId = { id: "alice", domain: "example.com" };
const channelId = "conv@example.com";
const now = new Date("2026-09-26T16:40:00Z");

const stored: ChannelConfig = {
  channelId, organisationId: "example.com", timezone: "UTC",
};

const whenMissing = { organisationId: "example.com" };

function setup(config: ChannelConfig | null = stored, setTimezone = vi.fn(async () => undefined)) {
  const channelConfig = { get: vi.fn().mockResolvedValue(config), upsert: vi.fn(), setTimezone };
  const audit = { append: vi.fn() };
  const wire = { sendPlainText: vi.fn() };
  const logger = { child: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const useCase = new SetChannelTimezone(channelConfig as never, audit, wire as never, "Europe/Berlin", () => now, logger);
  const reply = () => wire.sendPlainText.mock.calls.at(-1)?.[1];
  return { channelConfig, audit, wire, logger, useCase, reply };
}

describe("SetChannelTimezone", () => {
  it("shows the stored timezone with the current time", async () => {
    const { useCase, wire, channelConfig } = setup();
    await useCase.execute({ conversationId, channelId, actorId, replyToMessageId: "m" });
    expect(wire.sendPlainText).toHaveBeenCalledWith(conversationId, "This channel's timezone is **UTC** (currently 16:40 UTC).", { replyToMessageId: "m" });
    expect(channelConfig.setTimezone).not.toHaveBeenCalled();
  });

  it("shows the default timezone when the channel has no config", async () => {
    const { useCase, reply } = setup(null);
    await useCase.execute({ conversationId, channelId, actorId });
    expect(reply()).toBe("This channel's timezone is **Europe/Berlin** (currently 18:40 CEST).");
  });

  it("sets only the timezone, audits and confirms", async () => {
    const { useCase, channelConfig, audit, wire } = setup();
    await useCase.execute({ conversationId, channelId, actorId, timezone: "Europe/Berlin", replyToMessageId: "m" });
    expect(channelConfig.setTimezone).toHaveBeenCalledExactlyOnceWith(channelId, "Europe/Berlin", whenMissing);
    expect(channelConfig.upsert).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledExactlyOnceWith({
      timestamp: now, actorId, conversationId, action: "config_changed", entityType: "ChannelConfig", entityId: channelId,
      details: { timezone: { from: "UTC", to: "Europe/Berlin" } },
    });
    expect(wire.sendPlainText).toHaveBeenCalledWith(conversationId, "This channel's timezone is now **Europe/Berlin** (currently 18:40 CEST).", { replyToMessageId: "m" });
  });

  it("canonicalises a lower-case name", async () => {
    const { useCase, channelConfig, reply } = setup();
    await useCase.execute({ conversationId, channelId, actorId, timezone: "america/new_york" });
    expect(channelConfig.setTimezone).toHaveBeenCalledWith(channelId, "America/New_York", whenMissing);
    expect(reply()).toBe("This channel's timezone is now **America/New_York** (currently 12:40 GMT-4).");
  });

  it.each(["Mars/Olympus", "CEST"])("rejects the unknown name %s without reading or writing", async (name) => {
    const { useCase, channelConfig, audit, reply } = setup();
    await useCase.execute({ conversationId, channelId, actorId, timezone: name });
    expect(reply()).toBe(`I'm afraid I don't know the timezone "${name}". Please use a name such as Europe/Berlin or America/New_York.`);
    expect(channelConfig.get).not.toHaveBeenCalled();
    expect(channelConfig.setTimezone).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("does not save or audit an unchanged zone", async () => {
    const { useCase, channelConfig, audit, reply } = setup();
    await useCase.execute({ conversationId, channelId, actorId, timezone: "utc" });
    expect(reply()).toBe("This channel's timezone is already **UTC**.");
    expect(channelConfig.setTimezone).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("passes the minimal config for a channel that has none", async () => {
    const { useCase, channelConfig, audit } = setup(null);
    await useCase.execute({ conversationId, channelId, actorId, timezone: "Europe/London" });
    expect(channelConfig.setTimezone).toHaveBeenCalledExactlyOnceWith(channelId, "Europe/London", whenMissing);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ details: { timezone: { from: "Europe/Berlin", to: "Europe/London" } } }));
  });

  it("replies clearly and does not audit when saving fails", async () => {
    const { useCase, audit, reply } = setup(stored, vi.fn().mockRejectedValue(new Error("db down")));
    await useCase.execute({ conversationId, channelId, actorId, timezone: "Europe/Berlin" });
    expect(reply()).toBe("I'm afraid I couldn't save the timezone just now. Please try again.");
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("replies clearly and does not write when reading the config fails", async () => {
    const { useCase, channelConfig, audit, reply } = setup();
    channelConfig.get.mockRejectedValue(new Error("db down"));
    await useCase.execute({ conversationId, channelId, actorId, timezone: "Europe/Berlin" });
    expect(reply()).toBe("I'm afraid I couldn't save the timezone just now. Please try again.");
    expect(channelConfig.setTimezone).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("still confirms and logs the error name when the audit fails after saving", async () => {
    const { useCase, audit, logger, reply } = setup();
    audit.append.mockRejectedValue(new TypeError("audit down"));
    await useCase.execute({ conversationId, channelId, actorId, timezone: "Europe/Berlin" });
    expect(reply()).toBe("This channel's timezone is now **Europe/Berlin** (currently 18:40 CEST).");
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), { err: "TypeError" });
  });

  it("replies clearly when reading the config fails on the show path", async () => {
    const { useCase, channelConfig, reply } = setup();
    channelConfig.get.mockRejectedValue(new Error("db down"));
    await useCase.execute({ conversationId, channelId, actorId });
    expect(reply()).toBe("I'm afraid I couldn't read the timezone just now. Please try again.");
  });
});
