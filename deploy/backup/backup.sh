#!/usr/bin/env bash
# Encrypted PostgreSQL backup for FireSafety.
#   BACKUP_DIR=/srv/backups PASSPHRASE_FILE=/etc/firesafety/backup.pass ./backup.sh
# Requires: pg_dump, gpg. Connection via standard libpq env vars (PGHOST, PGUSER, PGDATABASE, PGPASSWORD/.pgpass)
# or run inside the db container:  docker compose exec -T db pg_dump ... (see README).
# The passphrase file must be readable only by the backup user (chmod 600) and stored separately
# from the backups (e.g. the organisation's secret manager). Copy backups off-host.
set -euo pipefail
umask 077

BACKUP_DIR="${BACKUP_DIR:?BACKUP_DIR is required}"
PASSPHRASE_FILE="${PASSPHRASE_FILE:?PASSPHRASE_FILE is required}"
KEEP_DAYS="${KEEP_DAYS:-30}"

[[ -r "$PASSPHRASE_FILE" ]] || { echo "passphrase file not readable" >&2; exit 1; }
if [[ "$(stat -c %a "$PASSPHRASE_FILE")" != "600" && "$(stat -c %a "$PASSPHRASE_FILE")" != "400" ]]; then
  echo "refusing: $PASSPHRASE_FILE must be chmod 600 or 400" >&2
  exit 1
fi
mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/firesafety-$stamp.dump.gpg"
tmp="$out.partial"

# Custom format (compressed, selective restore), encrypted with AES-256 (authenticated via MDC).
pg_dump --format=custom --no-owner --no-privileges \
  | gpg --batch --yes --symmetric --cipher-algo AES256 --pinentry-mode loopback \
        --passphrase-file "$PASSPHRASE_FILE" --output "$tmp"
mv "$tmp" "$out"
sha256sum "$out" > "$out.sha256"
echo "backup written: $out ($(du -h "$out" | cut -f1))"

# Rotation
find "$BACKUP_DIR" -name 'firesafety-*.dump.gpg*' -type f -mtime +"$KEEP_DAYS" -delete
