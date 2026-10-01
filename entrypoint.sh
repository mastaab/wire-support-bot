#!/bin/sh
set -e

echo "Running database migrations..."
node node_modules/.bin/prisma migrate deploy

echo "Starting Wire Support Bot..."
exec node dist/app/main.js
