/**
 * Prints the Postgres connection URL (see `databaseUrl.ts`) to stdout for `entrypoint.sh`, which
 * exports it as DATABASE_URL. On a missing or invalid setting it writes one log line in the format
 * of LOG_FORMAT (json when unset or unknown) with only the message to stderr and exits with code 1,
 * so the container stops before the migrations.
 */

import { databaseUrlErrorLine, resolveDatabaseUrl } from "./databaseUrl";
import { parseLogFormat } from "./logging";

try {
  process.stdout.write(`${resolveDatabaseUrl(process.env)}\n`);
} catch (error) {
  process.stderr.write(databaseUrlErrorLine(error, parseLogFormat(process.env.LOG_FORMAT) ?? "json"));
  process.exit(1);
}
