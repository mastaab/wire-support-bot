/**
 * The Postgres connection URL for Prisma, from DATABASE_URL or from its parts. The container's
 * entry point (`entrypoint.sh`, through `printDatabaseUrl.ts`) exports the result as DATABASE_URL
 * before the migrations, so a Kubernetes Secret of a managed database or an operator can supply
 * the host, user and password separately. Dependency free, so it runs before anything else.
 *
 *  DATABASE_URL       complete URL; when set, the parts below are ignored
 *  DATABASE_HOST      host name or IP address (an IPv6 literal is bracketed); required without a URL
 *  DATABASE_PORT      port; default 5432
 *  DATABASE_NAME      database name; required without a URL
 *  DATABASE_USER      user name; required without a URL
 *  DATABASE_PASSWORD  password; required without a URL
 *  DATABASE_OPTIONS   query parameters appended to the URL in both cases, for example sslmode=require
 *
 * An empty value counts as unset. Error messages name the setting and never contain a value.
 */

export type DatabaseEnv = Readonly<Record<string, string | undefined>>;

const DEFAULT_PORT = "5432";

function optional(env: DatabaseEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function required(env: DatabaseEnv, name: string): string {
  const value = optional(env, name);
  if (value === undefined) {
    throw new Error(`${name} is required when DATABASE_URL is not set`);
  }
  return value;
}

/** An IPv6 literal (it contains a colon) in brackets, as a URL needs it; anything else unchanged. */
function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function urlFromParts(env: DatabaseEnv): string {
  const host = required(env, "DATABASE_HOST");
  const name = required(env, "DATABASE_NAME");
  const user = required(env, "DATABASE_USER");
  const password = required(env, "DATABASE_PASSWORD");
  const port = optional(env, "DATABASE_PORT") ?? DEFAULT_PORT;
  if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("DATABASE_PORT must be a whole number from 1 to 65535");
  }
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${urlHost(host)}:${port}/${encodeURIComponent(name)}`;
}

/**
 * DATABASE_URL when set, else the URL built from the DATABASE_* parts, with DATABASE_OPTIONS
 * appended. Throws an Error naming the missing or invalid setting.
 */
export function resolveDatabaseUrl(env: DatabaseEnv): string {
  const url = optional(env, "DATABASE_URL") ?? urlFromParts(env);
  const options = optional(env, "DATABASE_OPTIONS")?.replace(/^[?&]+/, "");
  if (!options) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${options}`;
}
