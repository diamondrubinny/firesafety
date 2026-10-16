#!/usr/bin/env bash
# Restores an encrypted backup into a database (default: a NEW scratch database for verification).
#   PASSPHRASE_FILE=/etc/firesafety/backup.pass ./restore.sh /srv/backups/firesafety-....dump.gpg [target_db]
# Restoring over the production database is a deliberate, manual decision: stop the server first.
set -euo pipefail
umask 077
file="${1:?usage: restore.sh <backup.dump.gpg> [target_db]}"
target="${2:-firesafety_restore_check}"
PASSPHRASE_FILE="${PASSPHRASE_FILE:?PASSPHRASE_FILE is required}"

if [[ -f "$file.sha256" ]]; then sha256sum --check --quiet "$file.sha256"; fi

if [[ "$target" == "firesafety_restore_check" ]]; then
  dropdb --if-exists "$target"
  createdb "$target"
fi

gpg --batch --quiet --decrypt --pinentry-mode loopback --passphrase-file "$PASSPHRASE_FILE" "$file" \
  | pg_restore --no-owner --no-privileges --exit-on-error --dbname "$target"

# Sanity check: core tables and migration state.
psql -d "$target" -tA -c "SELECT 'migrations=' || count(*) FROM schema_migrations" \
                     -c "SELECT 'buildings=' || count(*) FROM building" \
                     -c "SELECT 'alarms=' || count(*) FROM alarm" \
                     -c "SELECT 'audit_rows=' || count(*) FROM audit_log"
echo "restore OK into database: $target"
