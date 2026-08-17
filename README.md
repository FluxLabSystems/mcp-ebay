# Connected Browser Bridge (mcp-ebay)

Implementation of the **Connected Browser Bridge for ChatGPT — SDD v0.5** (implementation-ready specification, 2026-08-12): a remote MCP gateway on a public-IPv4 VPS plus an outbound Windows browser agent that drives the user-provisioned **branded Google Chrome** through Playwright (channel `chrome`) with a dedicated persistent automation profile. The first site profile is **eBay.ca** with delivery destination **M6H 2W9**.

- MCP protocol **2026-07-28** (modern/stateless profile, TypeScript SDK v2, `legacy: 'reject'` unless compatibility is explicitly enabled)
- OAuth 2.1 resource server with RFC 9728 Protected Resource Metadata
- TLS + Ed25519 challenge-response device pairing; the Windows PC only ever connects **outbound**
- Local policy engine is authoritative: URL/SSRF allowlist, secret-field blocking, protected-action deny rules, transaction-endpoint aborts
- Purchases, bids, offers, seller messages, cart mutation, and credential/security actions are **blocked in MVP**

The MCP tool surface (15 `browser.*` tools), wire envelopes, error catalog, DB schema, and Compose topology follow the SDD's normative Appendix A/B/C shapes exactly.

## Repository layout (SDD §22)

```
apps/
  gateway/           Hono HTTP/MCP server, OAuth resource validation, device routing, artifacts, CLI
  windows-agent/     Outbound WSS client, Playwright owner, local policy engine host, CLI
packages/
  protocol/          MCP tool schemas, agent wire schemas, error catalog, device-auth primitives
  browser-core/      session/tab/snapshot/screenshot/image/wait primitives + launcher/profile lock
  policy/            generic URL/SSRF/secret/protected-action policy
  site-ebay/         ebay.ca.v1 allowlist, deny rules, destination verification, extraction, gallery
  audit/             audit event model/helpers
  config/            typed env/config parsing
db/migrations/       SQL migrations (runner: gateway CLI `migrate`)
deploy/              compose.yaml, caddy-snippet.caddy, env.example, scripts/preflight.sh
scripts/windows/     install/remove logon-task PowerShell scripts
tests/               unit / contract / security / integration / e2e / live + fixtures
.github/workflows/   ci.yml (SDD §28 jobs)
```

## Prerequisites

- Node.js ≥ 22.12, pnpm 10 (`corepack enable`)
- For browser integration/e2e tests: a Playwright Chromium (`pnpm exec playwright install chromium`) — CI does this; the tests use a **test-only** launch plan and never substitute the production channel
- For DB tests: any PostgreSQL 17 reachable via `DATABASE_URL` (optional; tests skip without it)

## Build and test (clean checkout)

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
pnpm test          # build + unit + contract + security + integration + e2e
```

The e2e project (also runnable alone via `pnpm test:e2e`) drives the full stack: MCP client → gateway → WSS → agent → real browser.

Individual layers: `pnpm test:unit`, `pnpm test:contract`, `pnpm test:security`, `pnpm test:integration`.

Migration smoke against an ephemeral PostgreSQL:

```bash
docker run -d --name bridge-pg -e POSTGRES_USER=bridge -e POSTGRES_PASSWORD=bridge \
  -e POSTGRES_DB=browser_bridge_test -p 127.0.0.1:54329:5432 postgres:17-alpine
DATABASE_URL=postgres://bridge:bridge@127.0.0.1:54329/browser_bridge_test pnpm test:integration
DATABASE_URL=postgres://bridge:bridge@127.0.0.1:54329/browser_bridge_test node apps/gateway/dist/cli.js migrate status
```

Live eBay smoke (opt-in, manual, on the Windows test machine only; never runs in CI, never submits a transaction):

```bash
BRIDGE_LIVE_SMOKE=1 BRIDGE_LIVE_LISTINGS="https://www.ebay.ca/itm/... ..." pnpm test:live
```

## Single-machine quickstart (Windows, three commands)

The scripted version of the manual smoke below — same topology (gateway in
dev mode, agent local, everything on localhost), zero terminals to juggle:

```powershell
# once (and again after every git pull):
powershell -ExecutionPolicy Bypass -File scripts\windows\lane-a-setup.ps1
# every session:
powershell -ExecutionPolicy Bypass -File scripts\windows\lane-a-run.ps1
# attach Claude Code once:
claude mcp add --transport http browser-bridge http://127.0.0.1:3000/mcp
```

`lane-a-run.ps1` starts PostgreSQL and the gateway (minimized window), runs
the branded-Chrome preflight, pairs the PC on first run, starts the agent in
its own window, and prints the attach line. First run only: log into eBay in
the automation Chrome window and set your delivery destination. Dev mode
disables OAuth and binds to localhost — never expose it to the network.

## Single-machine smoke (laptop, no VPS — manual steps)

Run the whole bridge on one Windows machine against your provisioned Google Chrome — gateway in dev mode (OAuth disabled; never production), agent local, MCP Inspector as the client.

```powershell
# 0. Once: Node >= 22.12, Docker Desktop, and the clean Chrome install.
corepack enable
pnpm install --frozen-lockfile
pnpm build

# 1. Ephemeral PostgreSQL + schema
docker run -d --name bridge-pg -e POSTGRES_USER=bridge -e POSTGRES_PASSWORD=bridge `
  -e POSTGRES_DB=browser_bridge -p 127.0.0.1:5432:5432 postgres:17-alpine
$env:DATABASE_URL = "postgres://bridge:bridge@127.0.0.1:5432/browser_bridge"
node apps\gateway\dist\cli.js migrate up

# 2. Gateway (terminal A) — dev mode only
$env:NODE_ENV = "development"; $env:OAUTH_MODE = "disabled"
$env:PUBLIC_BASE_URL = "http://localhost:3000"
node apps\gateway\dist\server.js

# 3. Agent (terminal B) — preflight proves branded Chrome (channel "chrome")
$env:AGENT_GATEWAY_URL = "ws://127.0.0.1:3000/agent/ws"
node apps\windows-agent\dist\cli.js preflight
node apps\gateway\dist\cli.js device:pair --name laptop   # prints one-time token
node apps\windows-agent\dist\cli.js pair --token <one-time-token>
node apps\windows-agent\dist\cli.js run

# 4. MCP client (terminal C)
npx @modelcontextprotocol/inspector
# Connect: Streamable HTTP → http://127.0.0.1:3000/mcp
# Call browser.session_open with deviceId "default" (single online device),
# then browser.navigate → https://www.ebay.ca/ , browser.snapshot, etc.
```

First-run eBay state (SDD §32.1 step 11): with the agent's Chrome window open, log into eBay once in that profile and set the delivery destination to M6H 2W9. Then `pnpm test:live` (with `BRIDGE_LIVE_SMOKE=1` and your listing URLs in `BRIDGE_LIVE_LISTINGS`) runs the live P0/P2 checks.

## VPS deployment (SDD §23–§25, §32)

The stack **reuses** the pre-existing `fluxology-caddy` container on the external `fluxology-edge` network. It never creates, replaces, restarts, or reconfigures that Caddy, and no service publishes a host port.

1. DNS A record for the MCP hostname → VPS public IPv4.
2. `cp deploy/env.example deploy/.env`, fill in real values (`chmod 0600 deploy/.env`). Production requires `OAUTH_ISSUER`, `OAUTH_AUDIENCE`, `OAUTH_JWKS_URI`; a static bearer token is never accepted.
3. Add `deploy/caddy-snippet.caddy` (with the real hostname) to the existing Caddy config; validate/reload Caddy with the existing method.
4. `deploy/scripts/preflight.sh` — verifies `fluxology-edge` exists and `fluxology-caddy` is attached.
5. `docker compose -f deploy/compose.yaml up -d --build`
6. Migrations: `docker compose -f deploy/compose.yaml exec mcp-gateway node apps/gateway/dist/cli.js migrate up`
7. Health: `https://<host>/healthz` and `/readyz` through Caddy.
8. Pair a device: `docker compose -f deploy/compose.yaml exec mcp-gateway node apps/gateway/dist/cli.js device:pair --name <device-name>` (prints a one-time token valid 10 minutes).

## Windows agent setup (SDD §11, §13, §32)

On the Windows PC with the **clean Google Chrome installation provisioned for this project** (the agent never installs/replaces Chrome and never falls back to Edge/Chromium/Firefox/WebKit):

```powershell
corepack enable; pnpm install --frozen-lockfile; pnpm build
$env:AGENT_GATEWAY_URL = "wss://browser-mcp.example.com/agent/ws"
node apps\windows-agent\dist\cli.js preflight              # must print Preflight OK (channel "chrome")
node apps\windows-agent\dist\cli.js pair --token <one-time-token>
powershell -ExecutionPolicy Bypass -File scripts\windows\install-logon-task.ps1 `
  -GatewayUrl wss://browser-mcp.example.com/agent/ws       # per-user logon task, no Windows service
```

The dedicated automation profile lives at `%LOCALAPPDATA%\Fluxology\BrowserBridge\profiles\ebay-research` — never Chrome's normal `User Data` directory. Log into eBay once in that profile and set the delivery destination to M6H 2W9 (SDD §32.1 step 11). The device private key is DPAPI-protected (CurrentUser); only the public key leaves the PC.

## MCP endpoint

`POST https://<host>/mcp` speaking MCP `2026-07-28` (self-describing requests; no `initialize`, no `Mcp-Session-Id`). Scopes: `browser:read`, `browser:interact` (includes read), `browser:admin` (diagnostics only). Protected Resource Metadata: `/.well-known/oauth-protected-resource/mcp` (and root fallback). Verify with MCP Inspector or any SDK client — ChatGPT attachment is a deployment gate, not a core dependency (SDD §5, §10.3).

`browser.session_open` requires the paired `deviceId` (printed by `device:list`); when exactly one device is online the literal `"default"` resolves to it.

## Phase status vs SDD §29

| Phase | Scope | Status |
|---|---|---|
| P0 local browser core | launcher/no-fallback preflight, profile lock, URL policy, snapshot/screenshot/gallery, agent CLI | Code + tests complete; the exit criterion's live run (branded Chrome, real eBay.ca, 10 listings) is executed on the Windows machine via `pnpm test:live` |
| P1 remote gateway | MCP v2 modern profile, OAuth, pairing/WSS, Compose/Caddy | Code + tests complete; Inspector-through-Caddy check runs at deployment |
| P2 eBay profile | canonical validation, destination-resolved shipping, gallery, traversal, protected actions | Code + fixture tests complete; live selectors verified during the on-site smoke |
| P3+ | Deals integration, existing-tab extension, generalization | Not started (per §31 ordering) |

Architecture-relevant clarifications and deviations are recorded under `docs/decisions/`.
