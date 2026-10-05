import { afterEach, describe, it, expect, vi } from "vitest";
import { loadConfig, resolveJiraConfig } from "../../src/app/config";
import { isKeyInProject } from "../../src/domain/ids/jiraLink";

const full = {
  WIRE_SUPPORT_BOT_JIRA_BASE_URL: "https://api.atlassian.com/ex/jira/cloud-id/",
  WIRE_SUPPORT_BOT_JIRA_SITE_URL: "https://example.atlassian.net",
  WIRE_SUPPORT_BOT_JIRA_API_TOKEN: "synthetic-token",
  WIRE_SUPPORT_BOT_JIRA_PROJECT_KEY: "sd",
  WIRE_SUPPORT_BOT_JIRA_SERVICE_DESK_ID: "5",
  WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES: "fault=101",
};

describe("resolveJiraConfig", () => {
  it("fails at startup without any Jira settings, naming every required one", () => {
    expect(() => resolveJiraConfig({})).toThrow(
      "The service desk (Jira) is required; set: WIRE_SUPPORT_BOT_JIRA_BASE_URL, WIRE_SUPPORT_BOT_JIRA_SITE_URL, "
      + "WIRE_SUPPORT_BOT_JIRA_API_TOKEN, WIRE_SUPPORT_BOT_JIRA_PROJECT_KEY, WIRE_SUPPORT_BOT_JIRA_SERVICE_DESK_ID, "
      + "WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES",
    );
  });

  it("resolves a complete configuration with Bearer auth by default", () => {
    const cfg = resolveJiraConfig(full)!;
    expect(cfg.baseUrl).toBe("https://api.atlassian.com/ex/jira/cloud-id");
    expect(cfg.projectKey).toBe("SD");
    expect(cfg.email).toBeUndefined();
    expect(cfg.timeoutMs).toBe(15_000);
  });

  it("fails at startup when only some required keys are set, naming only the missing ones", () => {
    let message = "";
    try { resolveJiraConfig({ WIRE_SUPPORT_BOT_JIRA_API_TOKEN: "t" }); } catch (err) { message = (err as Error).message; }
    expect(message).toMatch(/^The service desk \(Jira\) is required; set: WIRE_SUPPORT_BOT_JIRA_BASE_URL, /);
    expect(message).not.toContain("API_TOKEN");
    const { WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES: _omitted, ...withoutTypes } = full;
    expect(() => resolveJiraConfig({ ...withoutTypes, WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES: "  " }))
      .toThrow("The service desk (Jira) is required; set: WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES");
  });

  it("rejects non-https URLs, non-numeric IDs and malformed project keys", () => {
    expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_BASE_URL: "http://api.atlassian.com/x" })).toThrow(/https/);
    expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_SERVICE_DESK_ID: "desk" })).toThrow(/numeric/);
    expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_PROJECT_KEY: "D-S" })).toThrow(/project key/);
  });

  it("raises a timeout below the documented minimum to 1000 ms", () => {
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_TIMEOUT_MS: "200" })!.timeoutMs).toBe(1000);
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_TIMEOUT_MS: "30000" })!.timeoutMs).toBe(30_000);
  });

  it("does not share ticket content with the model unless explicitly enabled", () => {
    expect(resolveJiraConfig(full)!.shareWithModel).toBe(false);
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_SHARE_WITH_MODEL: "ON" })!.shareWithModel).toBe(true);
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_SHARE_WITH_MODEL: "off" })!.shareWithModel).toBe(false);
  });

  it("maps request kinds to request types and rejects malformed mappings", () => {
    expect(resolveJiraConfig(full)!.requestTypes).toEqual({ fault: "101" });
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES: "question=102, part=103,fault=101" })!.requestTypes)
      .toEqual({ question: "102", part: "103", fault: "101" });
    expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES: "parts=103" })).toThrow(/question=102/);
    expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES: "part=abc" })).toThrow(/question=102/);
    expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES: "question=102,part=103" })).toThrow(/must include fault/);
    expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES: "part=103,part=104" })).toThrow(/question=102/);
    expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES: "part=103=x" })).toThrow(/question=102/);
  });

  it("reads the service scope when set and bounds its length", () => {
    expect(resolveJiraConfig(full)!.serviceScope).toBeUndefined();
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_SERVICE_SCOPE: " printer faults and toner " })!.serviceScope).toBe("printer faults and toner");
    expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_SERVICE_SCOPE: "x".repeat(501) })).toThrow(/500/);
  });

  it("keeps passive service-desk help off unless explicitly switched on", () => {
    expect(resolveJiraConfig(full)!.passive).toBe(false);
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_PASSIVE: "On" })!.passive).toBe(true);
    expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_PASSIVE: "yes" })).toThrow(/on or off/);
    expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_SHARE_WITH_MODEL: "yes" })).toThrow(/on or off/);
  });

  it("watches Jira only when an interval of at least 15 seconds is set", () => {
    expect(resolveJiraConfig(full)!.watchSeconds).toBeUndefined();
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_WATCH_SECONDS: "30" })!.watchSeconds).toBe(30);
    for (const bad of ["14", "0", "-30", "30s", "1.5"]) {
      expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_WATCH_SECONDS: bad })).toThrow(/WATCH_SECONDS/);
    }
  });

  it("reads the lifetime of questions after a desk update in whole hours from 0 to 72, unset leaving the default", () => {
    expect(resolveJiraConfig(full)!.updateQuestionHours).toBeUndefined();
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_UPDATE_QUESTION_HOURS: "0" })!.updateQuestionHours).toBe(0);
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_UPDATE_QUESTION_HOURS: "8" })!.updateQuestionHours).toBe(8);
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_UPDATE_QUESTION_HOURS: "72" })!.updateQuestionHours).toBe(72);
    for (const bad of ["73", "-1", "1.5", "4h"]) {
      expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_UPDATE_QUESTION_HOURS: bad })).toThrow(/UPDATE_QUESTION_HOURS/);
    }
  });

  it("maps desk agents to Wire handles and rejects malformed mappings", () => {
    expect(resolveJiraConfig(full)!.agents).toBeUndefined();
    const cfg = resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_AGENTS: "712020:abc-1=@RobinDesk, 5b10a2=dana.desk" })!;
    expect([...cfg.agents!]).toEqual([["712020:abc-1", "robindesk"], ["5b10a2", "dana.desk"]]);
    for (const bad of ["", "no-handle", "id=", "=handle", "id=bad handle", "a=b,a=c", "id=x"]) {
      expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_AGENTS: bad || " , " })).toThrow(/WIRE_SUPPORT_BOT_JIRA_AGENTS/);
    }
  });

  it("reads the agent conversation mode as ask, auto or off, ask by default", () => {
    expect(resolveJiraConfig(full)!.agentChat).toBe("ask");
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT: "auto" })!.agentChat).toBe("auto");
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT: " OFF " })!.agentChat).toBe("off");
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT: "ask" })!.agentChat).toBe("ask");
    // Off leaves the mapping out, so neither a question nor a group can follow; a malformed one still fails.
    const mapped = { ...full, WIRE_SUPPORT_BOT_JIRA_AGENTS: "5b10a2=dana.desk" };
    expect(resolveJiraConfig({ ...mapped, WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT: "off" })!.agents).toBeUndefined();
    expect([...resolveJiraConfig({ ...mapped, WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT: "auto" })!.agents!]).toEqual([["5b10a2", "dana.desk"]]);
    expect([...resolveJiraConfig(mapped)!.agents!]).toEqual([["5b10a2", "dana.desk"]]);
    expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_AGENTS: "bad", WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT: "off" })).toThrow(/WIRE_SUPPORT_BOT_JIRA_AGENTS/);
    for (const bad of ["on", "yes", "manual"]) {
      expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT: bad })).toThrow("WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT must be ask, auto or off");
    }
  });

  it("reads satisfaction ratings as on or off, off by default", () => {
    expect(resolveJiraConfig(full)!.feedback).toBe(false);
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_FEEDBACK: "on" })!.feedback).toBe(true);
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_FEEDBACK: " OFF " })!.feedback).toBe(false);
    for (const bad of ["yes", "1", "true"]) {
      expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_FEEDBACK: bad })).toThrow("WIRE_SUPPORT_BOT_JIRA_FEEDBACK must be on or off");
    }
  });

  it("reads ticket links as agent or portal, agent by default", () => {
    expect(resolveJiraConfig(full)!.links).toBe("agent");
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_LINKS: " PORTAL " })!.links).toBe("portal");
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_LINKS: "agent" })!.links).toBe("agent");
    for (const bad of ["customer", "on", "browse"]) {
      expect(() => resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_LINKS: bad })).toThrow("WIRE_SUPPORT_BOT_JIRA_LINKS must be agent or portal");
    }
  });

  it("switches to Basic auth when an email is configured", () => {
    expect(resolveJiraConfig({ ...full, WIRE_SUPPORT_BOT_JIRA_EMAIL: "bot@example.com" })!.email).toBe("bot@example.com");
  });
});

describe("loadConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  const wire = {
    WIRE_SDK_API_TOKEN: "synthetic-token", WIRE_SDK_API_HOST: "https://wire.invalid",
    WIRE_SDK_APP_ID: "test-bot", WIRE_SDK_APP_DOMAIN: "test.invalid", WIRE_SDK_CRYPTO_KEY: "01".repeat(32),
    DATABASE_URL: "postgres://synthetic.invalid/db",
  };
  const stub = (env: Record<string, string>) => { for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value); };
  const clearJira = () => { for (const key of Object.keys(full)) vi.stubEnv(key, ""); };

  it("refuses to start without the service desk, naming the missing settings", () => {
    stub(wire);
    clearJira();
    expect(() => loadConfig()).toThrow(/^The service desk \(Jira\) is required; set: WIRE_SUPPORT_BOT_JIRA_BASE_URL, .*WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES$/);
  });

  it("starts with a complete Jira configuration", () => {
    stub({ ...wire, ...full });
    expect(loadConfig().jira.projectKey).toBe("SD");
  });
});

describe("jira keys", () => {
  it("scopes keys to the configured project", () => {
    expect(isKeyInProject("SD-42", "SD")).toBe(true);
    expect(isKeyInProject("SDX-42", "SD")).toBe(false);
    expect(isKeyInProject("OPS-42", "SD")).toBe(false);
  });
});
