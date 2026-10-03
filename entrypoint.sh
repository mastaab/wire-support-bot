#!/bin/sh
set -e

# One log line on stdout in the bot's format (LOG_FORMAT: json, or ecs as in src/app/logging.ts),
# at level info. The message must be a fixed string without quotes or backslashes.
log() {
  time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  case "$LOG_FORMAT" in
    [Ee][Cc][Ss])
      printf '{"@timestamp":"%s","log.level":"info","message":"%s","ecs.version":"9.0.0","severity":"INFO","component":"entrypoint"}\n' "$time" "$1"
      ;;
    *)
      printf '{"level":"info","severity":"INFO","msg":"%s","time":"%s","component":"entrypoint"}\n' "$1" "$time"
      ;;
  esac
}

# DATABASE_URL as set (Docker Compose, a Secret key), or built from the DATABASE_* parts, with
# DATABASE_OPTIONS appended. A missing setting stops the container here. Never echo the URL.
DATABASE_URL="$(node dist/app/printDatabaseUrl.js)"
export DATABASE_URL

log "Running database migrations"
node node_modules/.bin/prisma migrate deploy

log "Starting Wire Support Bot"
exec node dist/app/main.js
