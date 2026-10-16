# FireSafety — Campus Fire Alarm Monitoring

A **supplementary, monitoring-only** graphical management system for Siemens fire alarm panels (BACnet/IP) across a campus, inspired by Siemens Desigo CC. Runs on-premises (VPS inside the organisation's network) with Microsoft Entra ID sign-in.

> ⚠️ This system is **not** a listed fire alarm control or annunciation device. It must never replace the certified fire alarm panels, their annunciators, the monitoring centre or emergency procedures. It never sends commands to panels.

**Status:** Phase 5 (procedures & reports) — per-alarm procedure checklists (building-specific or global, frozen per alarm), alarm/response-time/open-issues reports with safe CSV export and print view, and automatic data retention. Earlier: Phase 4 (notifications) — push, SMS, WhatsApp (official Cloud API) and e-mail to safety officers, with grouping, retries and escalation of unacknowledged fire alarms. Every provider is configured in the admin **Notification settings** screen (secrets encrypted, write-only). Earlier: Phase 3 (floor maps) — floors per building, floor-plan upload with antivirus scanning, point placement (mouse or keyboard), live floor view with an accessible table, "show on map" from alarms, CSV import of point mapping. Builds on Phase 2 (read-only BACnet collector, live alarm board). SMS/WhatsApp/Push notifications arrive in Phase 4.

## Documentation (Hebrew)

- [01 — Desigo research & MVP plan](docs/01-desigo-research-and-mvp-plan.md)
- [02 — Decisions v0.2](docs/02-decisions-v0.2.md)
- [03 — Phase 1 plan](docs/03-phase1-plan.md)
- [04 — Phase 2 plan](docs/04-phase2-plan.md)
- [05 — Phase 3 plan](docs/05-phase3-plan.md)
- [06 — Phase 4 plan](docs/06-phase4-plan.md)
- [07 — Phase 5 plan](docs/07-phase5-plan.md)

## Confidentiality rule for this repository

Do **not** commit: the organisation's name, contractor/vendor-contact details, real hostnames, tenant/client IDs, IP addresses, BACnet device IDs, real building names or floor plans. Keep them in the deployment's private `.env` and in `deploy/local/` (git-ignored). Use `campus.example` / generic names in code, tests and docs.

## Structure

```
packages/shared   Zod schemas, roles and API types shared by server and web
apps/server       Fastify 5 API: Entra OIDC, sessions, RBAC + building scope, audit, SQL migrations
apps/web          React 19 + Vite, Hebrew RTL, accessible UI, live alarm board
apps/collector    Python (BACpypes3) read-only BACnet/IP collector + fs_simulator (dev/test panel)
deploy/           docker-compose (PostgreSQL, server, Caddy), Caddyfile, collector/ (on-site compose)
docs/             Research, decisions and phase plans
```

## Requirements

- Node.js ≥ 22.12, **npm 11** (`npm i -g npm@11.21.0`; npm 10 has an install bug with this workspace layout)
- PostgreSQL 16
- For deployment: Docker Engine + Compose v2

## Local development

```bash
npm ci --ignore-scripts

# PostgreSQL: create a role and two databases (dev + test)
sudo -u postgres psql -c "CREATE ROLE firesafety LOGIN PASSWORD 'devpassword';"
sudo -u postgres createdb -O firesafety firesafety_dev
sudo -u postgres createdb -O firesafety firesafety_test

# .env for development (dev login, no Entra needed)
cat > .env <<'EOF'
NODE_ENV=development
PUBLIC_ORIGIN=http://localhost:5173
DATABASE_URL=postgres://firesafety:devpassword@localhost:5432/firesafety_dev
AUDIT_IP_PEPPER=dev-pepper-dev-pepper-dev-pepper-0000
AUTH_MODE=dev
COOKIE_SECURE=false
EOF

npm run dev:server   # http://localhost:3000 (runs migrations on start)
npm run dev:web      # http://localhost:5173 — open this one
```

`AUTH_MODE=dev` shows a development login form. It is refused at startup when `NODE_ENV=production`.

### Collector + simulator (local)

```bash
cd apps/collector
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt

# 1. In the web UI (FireAdmin): Collectors → create → copy the one-time token.
# 2. Simulated panel (BACnet device 1001, 50 detectors, control API on localhost:8099)
.venv/bin/python -m fs_simulator --address 127.0.0.1/8:47808 --device 1001 --points 50 --notify 127.0.0.1:47809

# 3. Collector (another terminal)
FS_SERVER_URL=http://localhost:3000 FS_ALLOW_INSECURE_HTTP=1 FS_COLLECTOR_TOKEN=fsc_... \
FS_BACNET_ADDRESS=127.0.0.1/8:47809 FS_BACNET_DEVICE_ID=4000001 FS_PANELS=1001@127.0.0.1:47808 \
FS_POLL_INTERVAL=2 .venv/bin/python -m fs_collector

# 4. Trigger states on the simulated panel
curl -X POST localhost:8099/points/7 -d '{"state":"alarm"}'      # alarm|pre-alarm|fault|supervisory|disabled|test-alarm|quiet
curl -X POST localhost:8099/offline -d '{"offline":true}'        # simulate a dead panel link
```

The simulator is for development and testing only.

## Checks

```bash
npm run lint
npm run typecheck
npm test            # needs PostgreSQL; override with TEST_DATABASE_URL
npm run build
npm audit --omit=dev
(cd apps/collector && .venv/bin/python -m pytest -q)
```

The collector suite includes real BACnet/IP integration tests against the simulator (paging, notifications, inventory, panel outage/resync, uplink outage) and a test that forbids any state-changing BACnet service in the collector code.

The server test-suite runs against a real PostgreSQL and covers: collector ingest (auth, idempotency, ordering, reconcile, watchdog), alarm scope and acknowledgement, WebSocket auth/origin/scope, session security, OIDC flow (with a fake provider), tenant/role/MFA policy, open-redirect protection, CSRF origin checks, IDOR/building scope, admin authorization, validation, append-only audit log and security headers.

## Microsoft Entra ID setup (IT department)

1. **App registration** → *Web* platform, redirect URI `https://<SITE_ADDRESS>/auth/callback`. Single tenant.
2. **Certificates & secrets** → client secret (or certificate) → `OIDC_CLIENT_SECRET`.
3. **App roles** (allowed member types: Users/Groups): `FireAdmin`, `SafetyOfficer`, `Operator`, `Viewer`.
4. **Enterprise application** → *Users and groups* → assign groups to roles; enable *Assignment required*.
5. **Token configuration** → optional claim `email` on the ID token.
6. **Conditional Access** → require MFA for this application.
7. Set `OIDC_TENANT_ID`, `OIDC_CLIENT_ID`, `OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`.

Users without an app role are denied. Roles are refreshed from the token at each login; building scope is assigned in *Users & permissions*.

> `OIDC_REQUIRE_MFA=true` additionally checks the `amr` claim for `mfa`. Whether the tenant's ID tokens include it requires verification against Microsoft's documentation and the tenant's configuration; Conditional Access is the primary control.

## Deployment (Docker Compose)

```bash
cp .env.example .env               # fill in real values (never commit)
mkdir -p deploy/local/certs        # cert.pem + key.pem from the organisation's CA
docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
```

- `web` (Caddy) is the only published port (443): TLS, CSP/HSTS and other security headers, static UI, proxy to the API.
- `server` runs read-only, without Linux capabilities, as a non-root user; migrations run on start.
- `db` is on an internal network with no published ports.
- `clamav` scans every uploaded floor plan before it can be viewed (fail-closed: if the scanner is down, uploads are refused). It needs access to the ClamAV signature mirrors, or an internal mirror.

Floor plans: export to PNG/JPEG/WebP (max 10MB). SVG and PDF are intentionally not accepted. Plans are stored in the database (included in DB backups) and are never committed to this repository.

### Notifications

Configure in the UI: **הגדרות התראות** (FireAdmin). Users set their phone, channels and WhatsApp consent under **ההתראות שלי**, and can enable push per device.

- **SMS:** Twilio, or a *generic HTTP* provider (URL / headers / body template with `{{to}}` and `{{text}}`) for any Israeli SMS gateway — fill it in from the vendor's official documentation.
- **WhatsApp:** official WhatsApp Business Cloud API only. Requires an approved template with two parameters (`{{1}}` description, `{{2}}` link), a Phone Number ID and an access token. QR-code (WhatsApp Web) automation is intentionally not supported.
- **E-mail:** SMTP with TLS (STARTTLS required unless port 465).
- **Push:** VAPID keys are generated automatically. iOS requires adding the site to the home screen.
- Links in messages open the alarm page (behind SSO); there is no "ack by link", because messaging apps pre-fetch links.
- The server needs outbound HTTPS to the chosen providers (set `OUTBOUND_PROXY_FROM_ENV=true` to use the organisation's proxy).

### Collector (on-site)

Runs on a small Linux host/VM **inside the fire-panel network**, read-only, outbound HTTPS only:

```bash
cd deploy/collector
cp collector.env.example collector.env     # fill in: token, panel list, BACnet identity (never commit)
mkdir -p local && cp /path/to/org-ca.pem local/ca.pem
docker compose up -d --build
```

Prerequisites from the panel contractor (outside this repo): BACnet/IP enabled on the panel or access point, the required BACnet licence, a unique device id for the collector, and — optionally — the collector registered as a notification recipient for real-time events (otherwise it relies on polling every few seconds).

### Before production

- [ ] Use separate PostgreSQL roles: an owner role for migrations and an app role with `SELECT/INSERT` only on `audit_log` (`TRUNCATE` bypasses the append-only trigger).
- [ ] Encrypted, off-host database backups, with a tested restore.
- [ ] Entra app registration reviewed by IT; MFA enforced via Conditional Access.
- [ ] TLS certificate from the organisation's CA; firewall allows only 443 inbound.
- [ ] Generate `SETTINGS_ENCRYPTION_KEY`, store it in the secret manager, and include it in the backup/restore runbook.
- [ ] Configure and test every notification provider from the settings screen; review the WhatsApp/SMS providers with the privacy officer (DPA, data leaving Israel).
- [ ] Verify ClamAV detection with the EICAR test file on the deployed stack, and that signatures update (freshclam).
- [ ] Verify the BACnet category mapping (`packages/shared/src/alarms.ts`) against the actual Siemens panel object list/PICS.
- [ ] Firewall: collector host → panels UDP 47808; collector host → server 443 only.
- [ ] Penetration test; accessibility review (WCAG 2.1 AA / IS 5568); privacy review; legal review of the draft policy pages.
