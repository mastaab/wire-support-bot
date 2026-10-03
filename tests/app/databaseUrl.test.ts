import { describe, expect, it } from "vitest";
import { databaseUrlErrorLine, resolveDatabaseUrl } from "../../src/app/databaseUrl";

const PASSWORD = "p@ss/w:rd#?%";

const parts = {
  DATABASE_HOST: "postgres.example.com",
  DATABASE_PORT: "5433",
  DATABASE_NAME: "wire_support_bot",
  DATABASE_USER: "wirebot",
  DATABASE_PASSWORD: PASSWORD,
};

describe("resolveDatabaseUrl", () => {
  it("uses DATABASE_URL unchanged when it is set, ignoring the parts", () => {
    const url = "postgres://wirebot:secret@db.example.com:5432/wire_support_bot";
    expect(resolveDatabaseUrl({ DATABASE_URL: url })).toBe(url);
    expect(resolveDatabaseUrl({ ...parts, DATABASE_URL: url })).toBe(url);
  });

  it("builds the URL from the parts when DATABASE_URL is empty", () => {
    expect(resolveDatabaseUrl({ ...parts, DATABASE_URL: "" }))
      .toBe("postgresql://wirebot:p%40ss%2Fw%3Ard%23%3F%25@postgres.example.com:5433/wire_support_bot");
  });

  it("encodes special characters in the user, password and database name", () => {
    const url = resolveDatabaseUrl({ ...parts, DATABASE_USER: PASSWORD, DATABASE_NAME: PASSWORD });
    const encoded = "p%40ss%2Fw%3Ard%23%3F%25";
    expect(url).toBe(`postgresql://${encoded}:${encoded}@postgres.example.com:5433/${encoded}`);
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.username)).toBe(PASSWORD);
    expect(decodeURIComponent(parsed.password)).toBe(PASSWORD);
    expect(decodeURIComponent(parsed.pathname.slice(1))).toBe(PASSWORD);
    expect(parsed.hostname).toBe("postgres.example.com");
  });

  it("uses port 5432 when DATABASE_PORT is unset or empty", () => {
    const { DATABASE_PORT: _port, ...withoutPort } = parts;
    expect(resolveDatabaseUrl(withoutPort)).toContain("@postgres.example.com:5432/");
    expect(resolveDatabaseUrl({ ...parts, DATABASE_PORT: "" })).toContain("@postgres.example.com:5432/");
  });

  it("rejects a port that is not a whole number from 1 to 65535", () => {
    for (const port of ["abc", "0", "65536", "54 32"]) {
      expect(() => resolveDatabaseUrl({ ...parts, DATABASE_PORT: port })).toThrow(/^DATABASE_PORT must be/);
    }
  });

  it("brackets an IPv6 host", () => {
    expect(resolveDatabaseUrl({ ...parts, DATABASE_HOST: "fd00::1" })).toContain("@[fd00::1]:5433/");
    expect(resolveDatabaseUrl({ ...parts, DATABASE_HOST: "[fd00::1]" })).toContain("@[fd00::1]:5433/");
    expect(new URL(resolveDatabaseUrl({ ...parts, DATABASE_HOST: "fd00::1" })).hostname).toBe("[fd00::1]");
  });

  it("appends DATABASE_OPTIONS with ? or &, without a leading ? or &", () => {
    const base = "postgresql://wirebot:p%40ss%2Fw%3Ard%23%3F%25@postgres.example.com:5433/wire_support_bot";
    expect(resolveDatabaseUrl({ ...parts, DATABASE_OPTIONS: "sslmode=require" })).toBe(`${base}?sslmode=require`);
    expect(resolveDatabaseUrl({ ...parts, DATABASE_OPTIONS: "?sslmode=require&connection_limit=5" }))
      .toBe(`${base}?sslmode=require&connection_limit=5`);
    expect(resolveDatabaseUrl({ ...parts, DATABASE_OPTIONS: "&sslmode=require" })).toBe(`${base}?sslmode=require`);
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgres://u:p@db.example.com/db?schema=public", DATABASE_OPTIONS: "?sslmode=require" }))
      .toBe("postgres://u:p@db.example.com/db?schema=public&sslmode=require");
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgres://u:p@db.example.com/db", DATABASE_OPTIONS: "sslmode=require" }))
      .toBe("postgres://u:p@db.example.com/db?sslmode=require");
    expect(resolveDatabaseUrl({ ...parts, DATABASE_OPTIONS: "" })).toBe(base);
  });

  it.each(["DATABASE_HOST", "DATABASE_NAME", "DATABASE_USER", "DATABASE_PASSWORD"])(
    "names %s when it is missing or empty, without the password",
    (name) => {
      for (const env of [{ ...parts, [name]: undefined }, { ...parts, [name]: "" }]) {
        let message = "";
        try {
          resolveDatabaseUrl(env);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toBe(`${name} is required when DATABASE_URL is not set`);
        expect(message).not.toContain(PASSWORD);
      }
    },
  );

  it("names the first missing part when nothing is set", () => {
    expect(() => resolveDatabaseUrl({})).toThrow("DATABASE_HOST is required when DATABASE_URL is not set");
  });
});

describe("databaseUrlErrorLine", () => {
  const TIME = new Date("2026-01-02T03:04:05.000Z");
  const failure = () => {
    try {
      resolveDatabaseUrl({ ...parts, DATABASE_NAME: "" });
    } catch (error) {
      return error;
    }
    throw new Error("expected a failure");
  };

  it("is one json line with severity ERROR and only the message", () => {
    const line = databaseUrlErrorLine(failure(), "json", TIME);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      level: "error", severity: "ERROR", msg: "DATABASE_NAME is required when DATABASE_URL is not set",
      time: TIME.toISOString(), component: "database-url",
    });
  });

  it("is one ecs line with severity ERROR in the ecs format", () => {
    expect(JSON.parse(databaseUrlErrorLine(failure(), "ecs", TIME))).toMatchObject({
      "@timestamp": TIME.toISOString(), "log.level": "error", severity: "ERROR",
      message: "DATABASE_NAME is required when DATABASE_URL is not set",
    });
  });

  it("holds no value of any setting", () => {
    const line = databaseUrlErrorLine(failure(), "json", TIME);
    for (const value of Object.values(parts)) expect(line).not.toContain(value);
    expect(JSON.parse(databaseUrlErrorLine("not an error", "json", TIME)).msg).toBe("Invalid database settings");
  });
});
