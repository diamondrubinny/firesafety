# FireSafety — Campus Fire Alarm Monitoring

A **supplementary, monitoring-only** graphical management system for Siemens fire alarm panels (BACnet/IP) across a campus, inspired by Siemens Desigo CC. Runs on-premises (VPS inside the organisation's network) with Microsoft Entra ID sign-in.

> ⚠️ This system is **not** a listed fire alarm control or annunciation device. It must never replace the certified fire alarm panels, their annunciators, the monitoring centre or emergency procedures. It never sends commands to panels.

**Status:** Phase 1 (foundation) — auth, RBAC, building scope, audit, admin UI, deployment. BACnet collector and events arrive in Phase 2.

## Documentation (Hebrew)

- [01 — Desigo research & MVP plan](docs/01-desigo-research-and-mvp-plan.md)
- [02 — Decisions v0.2](docs/02-decisions-v0.2.md)
- [03 — Phase 1 plan](docs/03-phase1-plan.md)

## Confidentiality rule for this repository

Do **not** commit: the organisation's name, contractor/vendor-contact details, real hostnames, tenant/client IDs, IP addresses, BACnet device IDs, real building names or floor plans. Keep them in the deployment's private `.env` and in `deploy/local/` (git-ignored). Use `campus.example` / generic names in code, tests and docs.

## Structure

```
packages/shared   Zod schemas, roles and API types shared by server and web
apps/server       Fastify 5 API: Entra OIDC, sessions, RBAC + building scope, audit, SQL migrations
apps/web          React 19 + Vite, Hebrew RTL, accessible UI
deploy/           docker-compose (PostgreSQL, server, Caddy) and Caddyfile
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

## Checks

```bash
npm run lint
npm run typecheck
npm test            # needs PostgreSQL; override with TEST_DATABASE_URL
npm run build
npm audit --omit=dev
```

The server test-suite runs against a real PostgreSQL and covers: session security, OIDC flow (with a fake provider), tenant/role/MFA policy, open-redirect protection, CSRF origin checks, IDOR/building scope, admin authorization, validation, append-only audit log and security headers.

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

### Before production (Phase 1 items)

- [ ] Use separate PostgreSQL roles: an owner role for migrations and an app role with `SELECT/INSERT` only on `audit_log` (`TRUNCATE` bypasses the append-only trigger).
- [ ] Encrypted, off-host database backups, with a tested restore.
- [ ] Entra app registration reviewed by IT; MFA enforced via Conditional Access.
- [ ] TLS certificate from the organisation's CA; firewall allows only 443 inbound.
- [ ] Penetration test; accessibility review (WCAG 2.1 AA / IS 5568); privacy review; legal review of the draft policy pages.
