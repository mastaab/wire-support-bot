import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Keeps the Helm chart's ConfigMap, Secret and database environment in step with the settings the
 * app reads, by plain text parsing of `.env.example`, `src/` and the chart templates.
 */

const ROOT = path.resolve(__dirname, "../..");
const TEMPLATES = path.join(ROOT, "charts/wire-support-bot/templates");
const read = (file: string) => readFileSync(file, "utf8");

/** Only for scripts/register-app.mjs, never read by the bot. */
const SCRIPT_ONLY = /^WIRE_ADMIN_/;

/** Credentials, which belong in the Secret and never in the ConfigMap. */
const SECRET_NAMES = [
  "WIRE_SDK_API_TOKEN",
  "WIRE_SDK_CRYPTO_KEY",
  "WIRE_SUPPORT_BOT_JIRA_API_TOKEN",
  "WIRE_SUPPORT_BOT_JIRA_EMAIL",
  "WIRE_SUPPORT_BOT_LLM_API_KEY",
];

/**
 * The Postgres connection, set in the Deployment's env from database.* (the `databaseEnv` helper)
 * and read by `src/app/databaseUrl.ts`, which the container's entry point runs.
 */
const DATABASE_NAMES = [
  "DATABASE_URL",
  "DATABASE_HOST",
  "DATABASE_PORT",
  "DATABASE_NAME",
  "DATABASE_USER",
  "DATABASE_PASSWORD",
  "DATABASE_OPTIONS",
];

/** Settings in `.env.example`, commented or not. */
function envExampleNames(): Set<string> {
  const names = new Set<string>();
  for (const line of read(path.join(ROOT, ".env.example")).split("\n")) {
    const m = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/);
    if (m && !SCRIPT_ONLY.test(m[1]!)) names.add(m[1]!);
  }
  return names;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Quoted UPPER_SNAKE names (such as "DATABASE_HOST") in a source file under `src/`. */
function quotedNames(file: string): Set<string> {
  return new Set([...read(path.join(ROOT, file)).matchAll(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"/g)].map((m) => m[1]!));
}

/**
 * Settings the app reads: in `src/app/config.ts` every `WIRE_SDK_*` and `WIRE_SUPPORT_BOT_*` name,
 * every quoted UPPER_SNAKE name (such as "DATABASE_URL") and every `env.NAME`; in
 * `src/app/databaseUrl.ts` every quoted name; anywhere in `src/` every `process.env.NAME` or
 * `process.env["NAME"]` (such as LOG_LEVEL in `src/app/logging.ts`).
 */
function appNames(): Set<string> {
  const names = new Set<string>([...quotedNames("src/app/config.ts"), ...quotedNames("src/app/databaseUrl.ts")]);
  const config = read(path.join(ROOT, "src/app/config.ts"));
  for (const m of config.matchAll(/\b(?:WIRE_SDK|WIRE_SUPPORT_BOT)_[A-Z0-9][A-Z0-9_]*\b/g)) names.add(m[0]);
  for (const m of config.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) names.add(m[1]!);
  for (const file of sourceFiles(path.join(ROOT, "src"))) {
    for (const m of read(file).matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*"([A-Z][A-Z0-9_]*)"\s*\])/g)) {
      names.add((m[1] ?? m[2])!);
    }
  }
  return names;
}

/**
 * Environment names in a chart template: YAML keys (`NAME:`), quoted names (`"NAME"`) and EnvVar
 * names (`- name: NAME`).
 */
function templateNames(file: string): Set<string> {
  const names = new Set<string>();
  const text = read(path.join(TEMPLATES, file));
  for (const m of text.matchAll(/^\s*([A-Z][A-Z0-9_]*):/gm)) names.add(m[1]!);
  for (const m of text.matchAll(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"/g)) names.add(m[1]!);
  for (const m of text.matchAll(/^\s*- name: "?([A-Z][A-Z0-9_]*)"?\s*$/gm)) names.add(m[1]!);
  return names;
}

const sorted = (names: Iterable<string>) => [...names].sort();

describe("Helm chart configuration", () => {
  const configMap = templateNames("configmap.yaml");
  const secret = templateNames("secret.yaml");
  const databaseEnv = templateNames("_helpers.tpl");
  const chart = new Set([...configMap, ...secret, ...databaseEnv]);
  const app = appNames();
  const envExample = envExampleNames();

  it("finds the settings it compares, so a parser change cannot pass silently", () => {
    for (const name of ["WIRE_SDK_API_HOST", "DATABASE_URL", "DATABASE_HOST", "LOG_LEVEL", "MESSAGE_BUFFER_SIZE", "WIRE_SUPPORT_BOT_JIRA_FEEDBACK"]) {
      expect(app).toContain(name);
      expect(envExample).toContain(name);
      expect(chart).toContain(name);
    }
    expect(app.size).toBeGreaterThan(30);
  });

  it("has every setting of .env.example", () => {
    expect(sorted([...envExample].filter((name) => !chart.has(name)))).toEqual([]);
  });

  it("has every setting the app reads", () => {
    expect(sorted([...app].filter((name) => !chart.has(name)))).toEqual([]);
  });

  it("names no environment variable the app does not read", () => {
    expect(sorted([...chart].filter((name) => !app.has(name)))).toEqual([]);
  });

  it("keeps the credentials in the Secret and everything else in the ConfigMap", () => {
    expect(sorted(secret)).toEqual(sorted(SECRET_NAMES));
    expect(sorted([...configMap].filter((name) => secret.has(name)))).toEqual([]);
  });

  it("sets the database settings in the Deployment's env, matching what src/app/databaseUrl.ts reads", () => {
    expect(sorted(databaseEnv)).toEqual(sorted(DATABASE_NAMES));
    expect(sorted(quotedNames("src/app/databaseUrl.ts"))).toEqual(sorted(DATABASE_NAMES));
    expect(read(path.join(TEMPLATES, "deployment.yaml"))).toContain('include "wire-support-bot.databaseEnv"');
    expect(sorted([...databaseEnv].filter((name) => configMap.has(name) || secret.has(name)))).toEqual([]);
  });
});
