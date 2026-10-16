#!/usr/bin/env bash
# First-time setup on the server VM: checks prerequisites and creates .env with random secrets.
# Never overwrites an existing .env. Secrets are generated locally and never printed.
#
#   deploy/install.sh                     interactive
#   FS_SITE_ADDRESS=fs.campus.example FS_OIDC_TENANT_ID=... FS_OIDC_CLIENT_ID=... FS_OIDC_CLIENT_SECRET=... \
#     deploy/install.sh --non-interactive
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${FS_ENV_FILE:-$ROOT/.env}"
EXAMPLE="$ROOT/.env.example"
CERT_DIR="$ROOT/deploy/local/certs"
INTERACTIVE=1
[[ "${1:-}" == "--non-interactive" ]] && INTERACTIVE=0

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }
warn() { echo "WARNING: $*" >&2; }

# ---- prerequisites ---------------------------------------------------------------
command -v openssl >/dev/null || die "openssl is required"
if command -v docker >/dev/null; then
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin is required (docker compose ...)"
else
  warn "docker not found: install Docker Engine + Compose v2 before starting the stack"
fi
[[ -f "$EXAMPLE" ]] || die "missing $EXAMPLE (run from a checkout of the repository)"
[[ -e "$ENV_FILE" ]] && die "$ENV_FILE already exists. Not overwriting secrets. Remove it deliberately if you really want a fresh install."

# ---- input -------------------------------------------------------------------------
ask() { # ask VAR "prompt" default secret?
  local var="$1" prompt="$2" def="${3:-}" secret="${4:-}" val="${!1:-}"
  if [[ -z "$val" && "$INTERACTIVE" == 1 ]]; then
    if [[ -n "$secret" ]]; then read -r -s -p "$prompt: " val; echo; else read -r -p "$prompt${def:+ [$def]}: " val; fi
  fi
  printf -v "$var" '%s' "${val:-$def}"
}

ask FS_SITE_ADDRESS "Public host name (FQDN) users will browse to, e.g. firesafety.campus.example"
[[ "$FS_SITE_ADDRESS" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "invalid host name: '$FS_SITE_ADDRESS'"
ask FS_OIDC_TENANT_ID "Entra ID tenant ID (GUID; leave empty to fill in later)"
ask FS_OIDC_CLIENT_ID "Entra ID application (client) ID (GUID; empty = later)"
ask FS_OIDC_CLIENT_SECRET "Entra ID client secret (hidden; empty = later)" "" secret
ask FS_INGEST_CIDRS "Networks allowed to send collector data (space separated CIDRs)" "10.0.0.0/8 172.16.0.0/12 192.168.0.0/16"
ask FS_BREAK_GLASS_CIDRS "Networks allowed to use the emergency login (control room)" "10.0.0.0/8 172.16.0.0/12 192.168.0.0/16"

guid='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
for v in FS_OIDC_TENANT_ID FS_OIDC_CLIENT_ID; do
  [[ -z "${!v}" || "${!v}" =~ $guid ]] || die "$v must be a GUID"
done
[[ "$FS_OIDC_CLIENT_SECRET" =~ ^[A-Za-z0-9~._-]*$ ]] || die "client secret contains unexpected characters"
cidrs='^([0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2})( [0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2})*$'
[[ "$FS_INGEST_CIDRS" =~ $cidrs ]] || die "invalid ingest CIDR list"
[[ "$FS_BREAK_GLASS_CIDRS" =~ $cidrs ]] || die "invalid break-glass CIDR list"

# ---- secrets -----------------------------------------------------------------------
alnum() { openssl rand -hex "$1"; } # hex: safe inside URLs and SQL literals
PG_SUPER="$(alnum 24)"; PG_OWNER="$(alnum 24)"; PG_APP="$(alnum 24)"
PEPPER="$(openssl rand -base64 48 | tr -d '\n')"
ENC_KEY="$(openssl rand -base64 32 | tr -d '\n')"
MON_TOKEN="$(alnum 24)"

# ---- write .env (0600, atomically) ---------------------------------------------------
umask 077
TMP="$(mktemp "$ENV_FILE.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
cp "$EXAMPLE" "$TMP"
set_kv() { # values via the environment: no escaping issues with / + = in base64
  K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    index($0, k "=") == 1 && !done { print k "=" v; done = 1; next } { print }
    END { if (!done) print k "=" v }' "$TMP" > "$TMP.new" && mv "$TMP.new" "$TMP"
}
set_kv NODE_ENV production
set_kv PUBLIC_ORIGIN "https://$FS_SITE_ADDRESS"
set_kv SITE_ADDRESS "$FS_SITE_ADDRESS"
set_kv POSTGRES_PASSWORD "$PG_SUPER"
set_kv FS_OWNER_PASSWORD "$PG_OWNER"
set_kv FS_APP_PASSWORD "$PG_APP"
set_kv DATABASE_URL "postgres://fs_app:$PG_APP@db:5432/firesafety"
set_kv AUDIT_IP_PEPPER "$PEPPER"
set_kv SETTINGS_ENCRYPTION_KEY "$ENC_KEY"
set_kv MONITORING_TOKEN "$MON_TOKEN"
set_kv INGEST_ALLOWED_CIDRS "$FS_INGEST_CIDRS"
set_kv BREAK_GLASS_ALLOWED_CIDRS "$FS_BREAK_GLASS_CIDRS"
set_kv BREAK_GLASS_ENABLED false
if [[ -n "$FS_OIDC_TENANT_ID" ]]; then
  set_kv OIDC_TENANT_ID "$FS_OIDC_TENANT_ID"
  set_kv OIDC_ISSUER "https://login.microsoftonline.com/$FS_OIDC_TENANT_ID/v2.0"
fi
[[ -n "$FS_OIDC_CLIENT_ID" ]] && set_kv OIDC_CLIENT_ID "$FS_OIDC_CLIENT_ID"
[[ -n "$FS_OIDC_CLIENT_SECRET" ]] && set_kv OIDC_CLIENT_SECRET "$FS_OIDC_CLIENT_SECRET"
unset PG_SUPER PG_OWNER PG_APP PEPPER ENC_KEY MON_TOKEN FS_OIDC_CLIENT_SECRET

grep -q 'change-me\|changeMe' "$TMP" && LEFT=1 || LEFT=0
chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"
trap - EXIT
info "Created $ENV_FILE (mode 600) with freshly generated secrets."

mkdir -p "$CERT_DIR"
chmod 700 "$ROOT/deploy/local" 2>/dev/null || true

cat <<NEXT

Next steps
----------
1. BACK UP the new .env (it holds SETTINGS_ENCRYPTION_KEY) in the institution's secret store,
   separately from database backups. Losing the key means re-entering provider secrets and phones.
$( [[ "$LEFT" == 1 ]] && echo "2. Fill in the remaining placeholders in .env (Entra ID values): grep -n 'change-me\\|0000' .env" || echo "2. Entra ID values are set. Verify the redirect URI https://$FS_SITE_ADDRESS/auth/callback in the App Registration." )
3. Put the TLS certificate issued by the institution's CA in:
     $CERT_DIR/cert.pem  and  $CERT_DIR/key.pem   (chmod 600 key.pem)
4. Build and start:
     docker compose -f deploy/docker-compose.yml --env-file .env build
     docker compose -f deploy/docker-compose.yml --env-file .env up -d
5. Check:  curl -fsS https://$FS_SITE_ADDRESS/healthz   and sign in with an Entra account that has the FireAdmin role.
6. Uptime monitoring: point your monitor at https://$FS_SITE_ADDRESS/monitoring/v1/status with the header
   "Authorization: Bearer <MONITORING_TOKEN from .env>" (200 = ok, 503 = degraded). Restrict MONITORING_ALLOWED_CIDRS.
7. Optional (after approval): emergency accounts, see docs/10-user-guide.md, "Break-glass".
NEXT
[[ -f "$CERT_DIR/cert.pem" && -f "$CERT_DIR/key.pem" ]] || warn "TLS certificate not found yet in $CERT_DIR"
