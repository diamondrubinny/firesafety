#!/bin/sh
# Runs once, on the first start of an empty PostgreSQL volume (docker-entrypoint-initdb.d).
# Creates the least-privilege roles used by the server (see ../least-privilege.sql).
set -eu
: "${FS_OWNER_PASSWORD:?FS_OWNER_PASSWORD is required}"
: "${FS_APP_PASSWORD:?FS_APP_PASSWORD is required}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$FS_OWNER_PASSWORD" -v app_pw="$FS_APP_PASSWORD" \
  -f /fs-sql/least-privilege.sql
