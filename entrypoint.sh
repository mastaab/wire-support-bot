#!/bin/sh
set -e

# DATABASE_URL as set (Docker Compose, a Secret key), or built from the DATABASE_* parts, with
# DATABASE_OPTIONS appended. A missing setting stops the container here. Never echo the URL.
DATABASE_URL="$(node dist/app/printDatabaseUrl.js)"
export DATABASE_URL

echo "Running database migrations..."
node node_modules/.bin/prisma migrate deploy

echo "Starting Wire Support Bot..."
exec node dist/app/main.js
