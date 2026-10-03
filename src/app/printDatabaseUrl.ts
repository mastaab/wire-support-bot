/**
 * Prints the Postgres connection URL (see `databaseUrl.ts`) to stdout for `entrypoint.sh`, which
 * exports it as DATABASE_URL. On a missing or invalid setting it prints only the message to stderr
 * and exits with code 1, so the container stops before the migrations.
 */

import { resolveDatabaseUrl } from "./databaseUrl";

try {
  process.stdout.write(`${resolveDatabaseUrl(process.env)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Invalid database settings"}\n`);
  process.exit(1);
}
