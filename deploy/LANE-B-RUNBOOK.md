# Lane B Runbook — VPS Gateway, Real OAuth, Two Windows Agents

This is the operator guide for promoting the Connected Browser Bridge from the
Lane A single-machine setup to production: the gateway on the Fluxology VPS
behind the existing `fluxology-caddy` edge, OAuth 2.1 against a self-hosted
Keycloak at `auth.fluxology.ca`, both Windows PCs (laptop + desktop) paired as
browser agents, and both claude.ai and Claude Code attached as OAuth clients.

Companion documents:

- `README.md` — sections *VPS deployment (SDD §23–§25, §32)* and *Windows agent setup*
- `deploy/auth/README.md` — the Keycloak stack's own deployment guide (authoritative for its env-file variable names and compose invocation)
- fluxology-site repo: `docs/DEPLOYMENT-VPS.md`, `docs/CADDY-INTEGRATION.md`, `docs/MCP-CONNECTOR.md` — the house deployment style this runbook follows

Assumptions, fixed for the whole runbook:

- This repository is checked out on the VPS at `/opt/mcp-ebay`. Adjust paths if yours differs.
- The fluxology-site stack is already deployed from its own checkout on the same VPS, per its `docs/DEPLOYMENT-VPS.md`.
- The edge is the independently managed `fluxology-caddy` container: it owns 80/443 and TLS for every hostname on the machine, and it is attached to the external Docker network `fluxology-edge`. **Nothing in this runbook creates, replaces, restarts, or recreates that container** — only `caddy validate` / `caddy reload` inside it.
- Every command in this document is numbered `# [n]` in order. Run them in order; each step's verification must pass before the next step.

Two facts in this document **cannot** be pinned down in advance and are marked
**VERIFY LIVE** where they occur:

1. **The claude.ai OAuth callback URL** (section 6.2). The redirect URI claude.ai uses for custom connectors is shown in its *Add custom connector* dialog at attach time. Copy it from the dialog into Keycloak; do not trust any value written down here or anywhere else.
2. **Keycloak redirect-URI exactness** (sections 6.1 and 6.2). Keycloak matches Valid Redirect URIs literally — scheme, host, port, and path, byte for byte (a `*` wildcard is possible but do not use one). `http://localhost:18800/callback` does **not** match `http://127.0.0.1:18800/callback`. Confirm the exact URI each client actually sends during the first live authorization and register precisely that.

---

## 0. Topology

```text
            claude.ai                          Claude Code (CLI)
  OAuth client: claude-ai            OAuth client: claude-code
  (confidential, id + secret)        (public, PKCE,
            │                         redirect http://localhost:18800/callback)
            │        public Internet          │
            └───────────────┬─────────────────┘
                            │ HTTPS (Bearer JWT, iss = auth realm)
                            ▼
              ┌─────────────────────────────┐
              │  fluxology-caddy (80/443)   │   independently managed;
              │  network: fluxology-edge    │   never touched by this stack
              └──┬──────────┬──────────┬────┘
                 │          │          │
   auth.fluxology.ca  browser-mcp.   mcp.fluxology.ca
                 │    fluxology.ca        │
                 ▼          │             ▼
        ┌────────────┐      │      ┌───────────────┐
        │  Keycloak  │      │      │ fluxology-mcp │  (fluxology-site stack,
        │ deploy/auth│      │      │     :8083     │   + apache, contact-api,
        │  realm:    │      │      └───────────────┘   dashboard-api)
        │ fluxology  │      ▼
        └────────────┘  ┌──────────────────────┐   ┌────────────┐
     issuer:            │  browser-mcp-gateway │──▶│ postgres:17│
     https://auth.      │        :3000         │   │ (internal  │
     fluxology.ca/      │  (deploy/compose.yaml│   │  backend   │
     realms/fluxology   │   this repository)   │   │  network)  │
                        └──────────▲───────────┘   └────────────┘
                                   │ outbound wss://…/agent/ws only —
                 ┌─────────────────┴───────────────┐  no inbound ports
                 │                                 │  on either PC
        ┌────────┴────────┐               ┌────────┴────────┐
        │ Windows "laptop"│               │ Windows "desktop"│
        │  windows-agent  │               │  windows-agent   │
        │  branded Chrome │               │  branded Chrome  │
        └─────────────────┘               └──────────────────┘
```

Fixed identifiers used throughout:

| Thing | Value |
| --- | --- |
| Gateway hostname | `browser-mcp.fluxology.ca` |
| Auth hostname | `auth.fluxology.ca` |
| Keycloak realm | `fluxology` |
| OAuth issuer | `https://auth.fluxology.ca/realms/fluxology` |
| JWKS | `https://auth.fluxology.ca/realms/fluxology/protocol/openid-connect/certs` |
| Confidential client (claude.ai) | `claude-ai` |
| Public client (Claude Code, PKCE) | `claude-code`, redirect `http://localhost:18800/callback` |
| Bridge scopes | `browser:read`, `browser:interact`, `browser:admin` |
| Dashboard-connector scopes | `dashboards:read`, `office:write`, `deals:write`, `jobs:write` |
| Second resource (section 7) | `mcp.fluxology.ca` (fluxology-mcp) |

The realm ships both scope families with audience mappers (see
`deploy/auth/realm-fluxology.json` and `deploy/auth/README.md`), so **one**
issuer serves **both** MCP resources.

---

## 1. DNS

Create two A records at the DNS provider, pointing at the VPS public IPv4 —
the same address `fluxology.ca` already resolves to:

| Record | Type | Value |
| --- | --- | --- |
| `auth.fluxology.ca` | A | VPS public IPv4 |
| `browser-mcp.fluxology.ca` | A | VPS public IPv4 |

Verify propagation before touching Caddy — Caddy issues certificates on the
first request for a hostname, and issuance fails (and is rate-limited by Let's
Encrypt) while DNS still points nowhere:

```bash
# [1]
dig +short A auth.fluxology.ca
# [2]
dig +short A browser-mcp.fluxology.ca
# [3]
dig +short A fluxology.ca
```

All three must print the same IPv4 address. If [1] or [2] print nothing or a
stale address, stop and wait for propagation.

**Failure mode:** proceeding to section 3 with unpropagated DNS leaves Caddy
retrying ACME challenges. The site block is harmless, but the hostname serves
a TLS error until DNS resolves and issuance succeeds on a later retry.

---

## 2. Auth stack first (Keycloak at auth.fluxology.ca)

The auth stack lives in `deploy/auth/` — `compose.auth.yaml`,
`realm-fluxology.json` (imported on first boot), `caddy-auth-snippet.caddy`,
`env.auth.example`, and its own `README.md`. **That README is authoritative
for this section's exact variable names and flags**; the shape of the
procedure is:

### 2.1 Environment file

```bash
# [4]
cd /opt/mcp-ebay
# [5]
cp deploy/auth/env.auth.example deploy/auth/.env.auth && chmod 0600 deploy/auth/.env.auth
# [6]  Generate real secrets for every CHANGE_ME in the file (one call per secret):
openssl rand -base64 32
```

Edit `deploy/auth/.env.auth` and replace every placeholder — at minimum the
first-boot admin password and the Keycloak database password — with output
from [6]. The repo's `.gitignore` covers `.env.*`, so this file never enters
git. Verify:

```bash
# [7]
grep -c CHANGE_ME deploy/auth/.env.auth
```

Expected output: `0`.

### 2.2 Start and watch the realm import

```bash
# [8]
docker compose -f deploy/auth/compose.auth.yaml up -d
# [9]
docker compose -f deploy/auth/compose.auth.yaml logs -f
```

Watch [9] until Keycloak reports the realm import and startup, then Ctrl-C.
Expected log lines (wording varies slightly by Keycloak version):

```text
... Realm 'fluxology' imported
... Keycloak ... started in ...s. Listening on: http://0.0.0.0:8080
```

**Failure mode — import failed:** a malformed or conflicting
`realm-fluxology.json` logs a stack trace during import and either crash-loops
the container or leaves the realm missing (step [10] below then returns 404).
See troubleshooting, section 8.2.

### 2.3 Verify OIDC + RFC 8414 discovery (inside the network, pre-Caddy)

Caddy is not wired yet, so verify from inside the container first. Skipping
ahead is fine if you prefer to verify through Caddy after section 3 — but do
not continue past section 3 until both documents answer:

```bash
# [10]  OIDC discovery — the document claude.ai/Claude Code and both resource
#       servers depend on. Through Caddy after section 3:
curl -fsS https://auth.fluxology.ca/realms/fluxology/.well-known/openid-configuration \
  | jq '{issuer, authorization_endpoint, token_endpoint, jwks_uri}'
```

Expected:

```json
{
  "issuer": "https://auth.fluxology.ca/realms/fluxology",
  "authorization_endpoint": "https://auth.fluxology.ca/realms/fluxology/protocol/openid-connect/auth",
  "token_endpoint": "https://auth.fluxology.ca/realms/fluxology/protocol/openid-connect/token",
  "jwks_uri": "https://auth.fluxology.ca/realms/fluxology/protocol/openid-connect/certs"
}
```

The `issuer` value must be **exactly** `https://auth.fluxology.ca/realms/fluxology`
— with the realm path, no trailing slash. Every token carries this as `iss`
and both resource servers compare it byte for byte. If it comes back as an
internal hostname or `http://`, the Keycloak hostname setting in
`deploy/auth/.env.auth` is wrong; fix it before continuing.

```bash
# [11]  RFC 8414 path-inserted form — what spec-compliant MCP clients
#       (Claude Code included) construct from the issuer:
curl -fsS https://auth.fluxology.ca/.well-known/oauth-authorization-server/realms/fluxology \
  | jq '{issuer, registration_endpoint}'
# [12]  JWKS reachable (this exact URL goes into both resource servers' env):
curl -fsS https://auth.fluxology.ca/realms/fluxology/protocol/openid-connect/certs | jq '.keys | length'
```

[11] must return the same `issuer`; [12] must print a number ≥ 1.

### 2.4 First-boot admin, operator user, real claude-ai secret

In a browser: `https://auth.fluxology.ca` → **Administration Console** → log
in with the first-boot admin credentials from `deploy/auth/.env.auth` (after
section 3 wires Caddy; before that, per `deploy/auth/README.md`).

1. Switch the realm selector from `master` to **fluxology**.
2. **Users → Add user** — create the operator account that will authorize
   claude.ai and Claude Code. Set a username and email, then **Credentials →
   Set password** with *Temporary* off. This is the account you will log in
   with during every OAuth consent screen below.
3. **Clients → claude-ai → Credentials → Regenerate** the client secret, and
   copy it somewhere transient (you need it in sections 6.2 and 7). Any secret
   value that shipped inside the committed `realm-fluxology.json` is a
   placeholder that has been in git history — never leave it live.
4. **Clients → claude-code** — confirm it is a **public** client with PKCE
   (S256) and Valid Redirect URI `http://localhost:18800/callback`. Do not
   add a secret to it.

**Failure mode:** skipping the secret regeneration means the claude.ai
connector authenticates with a secret sitting in a git repository. Treat that
as a leaked credential.

---

## 3. Caddy: both site blocks into the VPS Caddyfile

Same method as fluxology-site `docs/CADDY-INTEGRATION.md` §3: merge blocks
into the one VPS-wide Caddyfile, then validate and reload **inside** the
existing container. Two snippets, two new hostnames:

1. `deploy/auth/caddy-auth-snippet.caddy` → the `auth.fluxology.ca` block.
2. `deploy/caddy-snippet.caddy` → the `browser-mcp.fluxology.ca` block, with
   the placeholder hostname replaced. After substitution it reads:

```caddyfile
browser-mcp.fluxology.ca {
    encode zstd gzip
    reverse_proxy browser-mcp-gateway:3000 {
        # Keep agent WebSockets alive across Caddy config reloads (SDD §24).
        stream_close_delay 5m
    }
}
```

Merge rules (all learned the hard way in the house docs):

- **One block per hostname, ever.** A duplicate `auth.fluxology.ca { … }` or
  `browser-mcp.fluxology.ca { … }` makes the *entire* Caddyfile invalid —
  `ambiguous site definition` — and since this file serves every site on the
  machine, a bad reload threatens all of them. `caddy validate` catches it;
  that is why [13] always runs before [14].
- Keep `stream_close_delay 5m` — without it every Caddy reload (including the
  one you are about to do for section 7) drops both agents' WebSockets
  simultaneously.
- Do not add auth directives at the edge for `browser-mcp.fluxology.ca`; the
  gateway is its own OAuth resource server and must see the `Authorization`
  header untouched.

```bash
# [13]
docker exec fluxology-caddy caddy validate --config /etc/caddy/Caddyfile
# [14]
docker exec fluxology-caddy caddy reload --config /etc/caddy/Caddyfile
```

[13] must end with `Valid configuration`. If it errors, fix the Caddyfile
before ever running [14] — reload with a broken config takes down every
hostname on the VPS. (If the VPS deployment mounts the Caddyfile elsewhere,
use its real path — same caveat as the house doc.)

Verify:

```bash
# [15]  Auth host serves TLS + discovery through the edge:
curl -fsSI https://auth.fluxology.ca/realms/fluxology/.well-known/openid-configuration | head -1
# [16]  Bridge host answers TLS. 502 IS EXPECTED here — the gateway
#       container does not exist until section 4:
curl -sSI https://browser-mcp.fluxology.ca/healthz | head -1
```

[15]: `HTTP/2 200`. [16]: `HTTP/2 502` for now — that proves TLS and routing
work and only the upstream is missing. Anything else (TLS error, timeout, 404
from a different site block) means DNS or the merge went wrong; fix before
continuing.

---

## 4. Bridge gateway (deploy/compose.yaml)

### 4.1 Environment

```bash
# [17]
cd /opt/mcp-ebay
# [18]
cp deploy/env.example deploy/.env && chmod 0600 deploy/.env
# [19]  DB password:
openssl rand -hex 24
# [20]  Artifact URL signing secret (>=16 chars; production refuses to boot without it):
openssl rand -base64 32
```

Edit `deploy/.env` to exactly this (substituting the two generated values):

```dotenv
NODE_ENV=production
PUBLIC_BASE_URL=https://browser-mcp.fluxology.ca
PORT=3000

# [19] output in BOTH places — the gateway's DSN and the postgres bootstrap:
DATABASE_URL=postgres://bridge:<output-of-19>@postgres:5432/browser_bridge

OAUTH_MODE=required
OAUTH_ISSUER=https://auth.fluxology.ca/realms/fluxology
OAUTH_AUDIENCE=https://browser-mcp.fluxology.ca/mcp
OAUTH_JWKS_URI=https://auth.fluxology.ca/realms/fluxology/protocol/openid-connect/certs

ARTIFACT_DIR=/var/lib/browser-bridge/artifacts
ARTIFACT_TTL_SECONDS=900
ARTIFACT_URL_SECRET=<output-of-20>

DEVICE_HEARTBEAT_SECONDS=20
RATE_LIMIT_MCP_PER_MINUTE=120
RATE_LIMIT_PAIR_PER_MINUTE=10
EBAY_DESTINATION_POSTAL_CODE=M6H 2W9

# Dashboard write-path (dashboard.feed / dashboard.upsert served by THIS
# gateway). The three token values already exist in the fluxology-site
# stack's .env on this VPS — copy them from there; do not mint new ones.
DASHBOARD_API_BASE_URL=http://fluxology-dashboard-api:8082
DEALS_INGEST_TOKEN=<from fluxology-site .env>
OFFICE_INGEST_TOKEN=<from fluxology-site .env>
JOBS_INGEST_TOKEN=<from fluxology-site .env>

LOG_LEVEL=info

POSTGRES_USER=bridge
POSTGRES_PASSWORD=<output-of-19>
POSTGRES_DB=browser_bridge
```

Two values deserve a second look:

- `OAUTH_ISSUER` — realm path included, matching [10] exactly. The gateway
  fails every token whose `iss` differs by one character.
- `OAUTH_AUDIENCE` — must equal, byte for byte, the audience value the
  realm's **audience mapper** stamps into access tokens for this resource
  (`deploy/auth/realm-fluxology.json`). The convention across this VPS is the
  MCP endpoint URL (`https://browser-mcp.fluxology.ca/mcp`, mirroring
  fluxology-mcp's `https://mcp.fluxology.ca/mcp`). If tokens later bounce
  with an audience error, this line vs. the mapper is the first thing to
  diff — troubleshooting 8.1 shows how to decode a live token.

### 4.2 Preflight, up, migrate

```bash
# [21]  Verifies fluxology-edge exists, fluxology-caddy is attached, compose parses:
bash deploy/scripts/preflight.sh
```

Expected output:

```text
Preflight OK: external edge exists and fluxology-caddy is attached.
```

**Failure mode:** a non-zero exit means the edge contract is broken — the
network is missing (`docker network create fluxology-edge` belongs to the
fluxology-site deployment, its `docs/CADDY-INTEGRATION.md` §1) or Caddy was
never connected to it. Do not `compose up` around this; fix the edge.

```bash
# [22]
docker compose -f deploy/compose.yaml up -d --build
# [23]
docker compose -f deploy/compose.yaml ps
```

[23] must show `mcp-gateway` and `postgres` both `Up (healthy)`. The gateway
publishes **no** host port (only `expose: 3000` on `fluxology-edge`, alias
`browser-mcp-gateway`) — if `ps` shows a published port, the compose file was
modified; that violates NFR-09.

```bash
# [24]
docker compose -f deploy/compose.yaml exec mcp-gateway node apps/gateway/dist/cli.js migrate up
```

Expected output: `Applied: 0001_init` (or `No pending migrations.` on a
re-run).

### 4.3 Verify through Caddy — health, readiness, discovery, challenge

All four run from anywhere on the public internet, through the edge:

```bash
# [25]
curl -fsS https://browser-mcp.fluxology.ca/healthz
# [26]
curl -fsS https://browser-mcp.fluxology.ca/readyz
# [27]  RFC 9728 Protected Resource Metadata:
curl -fsS https://browser-mcp.fluxology.ca/.well-known/oauth-protected-resource/mcp | jq
# [28]  Unauthenticated MCP call must be CHALLENGED, not served:
curl -isS -X POST https://browser-mcp.fluxology.ca/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -5
```

Expected:

```text
[25]  {"status":"ok"}
[26]  {"status":"ready"}
[27]  {
        "resource": "https://browser-mcp.fluxology.ca/mcp",
        "authorization_servers": ["https://auth.fluxology.ca/realms/fluxology"],
        "scopes_supported": ["browser:read", "browser:interact", "browser:admin",
                             "dashboards:read", "office:write", "deals:write", "jobs:write"],
        "bearer_methods_supported": ["header"],
        "resource_name": "Connected Browser Bridge MCP"
      }
      (the four dashboard scopes appear only when 4.1's dashboard block is set)
[28]  HTTP/2 401
      www-authenticate: Bearer ... resource_metadata="https://browser-mcp.fluxology.ca/.well-known/oauth-protected-resource/mcp"
```

A `200` from [28] means OAuth is not being enforced — stop immediately and
check `OAUTH_MODE`/`NODE_ENV` in `deploy/.env` (the config layer refuses
`OAUTH_MODE` ≠ `required` under `NODE_ENV=production`, so a 200 here implies
the env file is not the one the container loaded). `[26]` returning 503 with
`{"db":false}` means the gateway cannot reach PostgreSQL; check [23] and the
`DATABASE_URL` password.

---

## 5. Pair BOTH Windows PCs

Each PC is its own device: its own Ed25519 keypair (DPAPI-protected, never
leaves the machine), its own one-time pairing token, its own `dev_…` id. Both
run the agent from a repo checkout with the **clean branded Google Chrome**
install (`channel "chrome"` — the agent never falls back to Edge/Chromium).

### 5.0 Lane A leftover — do this FIRST on any PC that was paired locally

A PC that ran Lane A (`lane-a-run.ps1`, or the manual single-machine smoke)
paired against its **local** gateway's database. That identity —
`{deviceId, publicKeyPem}` in `device.json` — is meaningless to the VPS
gateway: different gateway, different device identity. Delete it so pairing
mints a fresh keypair and id:

```powershell
# [29]  (PowerShell, on each previously-Lane-A PC)
Remove-Item "$env:LOCALAPPDATA\Fluxology\BrowserBridge\state\device.json" -ErrorAction SilentlyContinue
```

This does **not** touch the Chrome automation profile
(`%LOCALAPPDATA%\Fluxology\BrowserBridge\profiles\ebay-research`), so the
eBay login and the M6H 2W9 delivery destination set during Lane A survive.
Also make sure the Lane A local gateway/agent windows are closed — the
profile takes an exclusive lock, and a still-running Lane A agent would hold
it (`PROFILE_IN_USE`).

**Failure mode if skipped:** the agent presents a `deviceId` the VPS gateway
has never issued, and the WSS handshake is rejected; the agent log shows an
auth failure loop.

### 5.1 Laptop

**On the VPS** — mint a one-time token (valid 10 minutes, single use):

```bash
# [30]
docker compose -f deploy/compose.yaml exec mcp-gateway \
  node apps/gateway/dist/cli.js device:pair --name laptop
```

Expected output:

```text
One-time pairing token (valid 10 minutes, single use):

  <token>

On the Windows PC run:
  browser-bridge-agent pair --token <token> --name "laptop"
```

**On the laptop** (PowerShell, in the repo checkout; [31] only on first setup
or after `git pull`):

```powershell
# [31]
corepack enable; pnpm install --frozen-lockfile; pnpm build
# [32]
$env:AGENT_GATEWAY_URL = "wss://browser-mcp.fluxology.ca/agent/ws"
# [33]  Must prove branded Chrome before anything else:
node apps\windows-agent\dist\cli.js preflight
# [34]  Token from [30], within its 10-minute window:
node apps\windows-agent\dist\cli.js pair --token <token> --name laptop
# [35]  Per-user logon task (no Windows service), persists AGENT_GATEWAY_URL:
powershell -ExecutionPolicy Bypass -File scripts\windows\install-logon-task.ps1 `
  -GatewayUrl wss://browser-mcp.fluxology.ca/agent/ws
# [36]  Start now without re-logon:
Start-ScheduledTask -TaskName FluxologyBrowserBridgeAgent
```

Expected outputs:

```text
[33]  Preflight OK: branded Google Chrome (channel "chrome") launched with the dedicated automation profile.
[34]  Paired. deviceId=dev_...
[35]  Installed logon task 'FluxologyBrowserBridgeAgent'.
      AGENT_GATEWAY_URL set to wss://browser-mcp.fluxology.ca/agent/ws (user environment).
```

**Failure modes:**

- [33] prints `BROWSER_UNAVAILABLE: …` — branded Chrome is missing on this
  PC. Install real Google Chrome; the agent will not substitute another
  browser, by design.
- [34] fails with an invalid/expired token — more than 10 minutes elapsed or
  the token was already consumed. Mint a new one with [30]; tokens are single
  use.
- [34] succeeds but the agent never shows online — see troubleshooting 8.3.

### 5.2 Desktop

Repeat the sequence with a fresh token and the other name — **on the VPS**:

```bash
# [37]
docker compose -f deploy/compose.yaml exec mcp-gateway \
  node apps/gateway/dist/cli.js device:pair --name desktop
```

**On the desktop:** run [29] (if it ever ran Lane A), then [31]–[36] exactly
as above, substituting the token from [37] and `--name desktop` in the pair
command. First-run eBay state on a PC that never ran Lane A: after [36], a
Chrome window with the automation profile is available — log into eBay once
in that profile and set the delivery destination to M6H 2W9 (SDD §32.1
step 11).

### 5.3 Verify both devices

```bash
# [38]
docker compose -f deploy/compose.yaml exec mcp-gateway \
  node apps/gateway/dist/cli.js device:list
```

Expected — two rows, both `active`, both with a recent `last_seen`
(heartbeats run every 20 s):

```text
dev_a1b2...	active	laptop	SHA256:...	last_seen=2026-08-18T14:03:21.000Z
dev_c3d4...	active	desktop	SHA256:...	last_seen=2026-08-18T14:03:25.000Z
```

Record both `dev_…` ids — the smoke test in 6.3 needs them, because with two
devices online the `"default"` shorthand no longer resolves. A `last_seen`
that stops advancing means that agent has dropped its WSS connection
(troubleshooting 8.3).

---

## 6. Attach Claude Code and claude.ai

### 6.1 Claude Code

Claude Code speaks RFC 9728/8414 discovery and can either dynamically
register or use a pre-configured client. Use the pre-provisioned `claude-code`
public client (PKCE, callback port 18800 — matching the redirect URI baked
into the realm):

```bash
# [39]  On any workstation where Claude Code runs:
claude mcp add --transport http --client-id claude-code --callback-port 18800 \
  browser-bridge https://browser-mcp.fluxology.ca/mcp
```

Then open a Claude Code session and run `/mcp` → select `browser-bridge` →
**Authenticate**. A browser opens on the Keycloak login page — sign in as the
operator user from 2.4, approve the requested `browser:*` and dashboard
(`dashboards:read`, `*:write`) scopes, and the browser lands on
`http://localhost:18800/callback`, which Claude Code serves locally to
capture the code.

> **VERIFY LIVE — Keycloak redirect-URI exactness.** If Keycloak answers the
> authorization redirect with `invalid_redirect_uri` instead of a login page,
> the URI Claude Code sent is not byte-identical to the one registered on the
> `claude-code` client. Read the exact `redirect_uri` out of the failing
> authorization URL in the browser's address bar, and register precisely that
> string in Keycloak (**Clients → claude-code → Valid redirect URIs**) — the
> known variant is `http://127.0.0.1:18800/callback` vs
> `http://localhost:18800/callback`; add the observed one alongside if
> needed. Path and port must match too.

Verify:

```bash
# [40]
claude mcp list
```

Expected: `browser-bridge: https://browser-mcp.fluxology.ca/mcp (HTTP) - ✓ Connected`.
Inside a session, `/mcp` should show the connector authenticated with 15
`browser.*` tools.

### 6.2 claude.ai

In claude.ai (workspace with custom connectors enabled):

1. **Settings → Connectors → Add custom connector**.
2. Name: `Browser Bridge`. URL: `https://browser-mcp.fluxology.ca/mcp`.
3. Open **Advanced settings** and enter OAuth **Client ID** `claude-ai` and
   the **Client secret** regenerated in step 2.4.3.
4. **VERIFY LIVE — the claude.ai OAuth callback URL.** The add-connector
   dialog states the callback (redirect) URL claude.ai will use. Copy that
   exact URL into Keycloak: **Clients → claude-ai → Valid redirect URIs**,
   before finishing the dialog. It is commonly
   `https://claude.ai/api/mcp/auth_callback`, but the dialog is the source of
   truth — Keycloak's exact matching (see 6.1) applies here identically, and
   Anthropic can change the value.
5. Complete the flow: **Add** → claude.ai redirects to
   `auth.fluxology.ca` → log in as the operator user → consent → back to
   claude.ai with the connector showing **Connected**.

**Failure mode:** an immediate `invalid_redirect_uri` error page from
Keycloak means step 4's URI does not match — fix the client's Valid Redirect
URIs, no other setting causes that page. An `unauthorized_client` /
`invalid_client_credentials` error means the secret pasted into Advanced
settings is not the regenerated one.

### 6.3 First-session smoke — one session per device

In claude.ai (and again in Claude Code — both clients should pass), with both
agents online and the two `dev_…` ids from [38]:

Prompt, laptop first:

```text
Using the browser-bridge tools: call browser.session_open with deviceId
"dev_a1b2..." (laptop), then browser.navigate that session's tab to
https://www.ebay.ca/ , then browser.extract the current page.
```

Expected behavior:

1. `browser.session_open` returns a `browserSessionHandle`; Chrome visibly
   opens on the **laptop** with the `ebay-research` automation profile.
2. `browser.navigate` returns the final `https://www.ebay.ca/` URL, title,
   and a `pageRevision`.
3. `browser.extract` returns structured listing/page data with prices in CAD
   and shipping computed against destination M6H 2W9.

Repeat with the desktop's `dev_…` id and confirm Chrome opens on the
**desktop**. That proves per-device routing, not just connectivity.

Notes:

- With two devices online, `deviceId: "default"` fails with `DEVICE_OFFLINE`
  by design (ADR 0001 §4) — the literal only resolves when exactly one device
  is online. Always name the device in Lane B.
- `session_open` and `navigate` require `browser:interact`; if the model
  reports an authorization failure naming a scope, see troubleshooting 8.1.
- Purchases, bids, offers, cart mutation and credential actions are blocked
  by the agent-side policy engine in MVP — a refusal there is correct
  behavior, not a fault.

---

## 7. Dashboard write-path — now served by the bridge itself

**The bridge gateway serves `dashboard.feed` and `dashboard.upsert`
directly** once 4.1's dashboard block is filled in: the realm's dashboard
scopes (`dashboards:read`, `office:write`, `deals:write`, `jobs:write`) have
their audience mappers pointed at `https://browser-mcp.fluxology.ca/mcp`, so
the ONE connector from section 6 covers browsing **and** dashboard writes.
Smoke it after 6.2: in a session with the connector, call `dashboard.feed`
with `{"dashboard":"deals","mode":"ids"}` — it must return the stored
listing ids, and `dashboard.upsert` without the matching gateway token must
name the missing `*_INGEST_TOKEN` in its error.

Everything below is the OPTIONAL legacy alternative — the standalone
`fluxology-mcp` connector from the fluxology-site stack. Skip it unless you
specifically want that second connector; if you do use it, note its tokens
now expect the audience `https://browser-mcp.fluxology.ca/mcp` realm-side,
so its `MCP_OAUTH_AUDIENCE` no longer matches the realm mappers without
re-adding a mapper for `https://mcp.fluxology.ca/mcp`.

In the **fluxology-site checkout** on the VPS (wherever that stack deploys
from), edit `.env` — note all three URLs carry the **realm path**, which the
`.env.example` placeholder comments predate:

```dotenv
MCP_PUBLIC_URL=https://mcp.fluxology.ca/mcp
MCP_OAUTH_ISSUER=https://auth.fluxology.ca/realms/fluxology
MCP_OAUTH_AUDIENCE=https://mcp.fluxology.ca/mcp
MCP_OAUTH_JWKS_URI=https://auth.fluxology.ca/realms/fluxology/protocol/openid-connect/certs
```

```bash
# [41]  From the fluxology-site checkout:
docker compose up -d --force-recreate mcp
# [42]
docker compose ps mcp
# [43]  Readiness includes "authorization-server metadata reachable":
curl -fsS https://mcp.fluxology.ca/readyz | jq .
# [44]  Challenge still enforced:
curl -isS -X POST https://mcp.fluxology.ca/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -5
```

Expected: [42] healthy; [43] `status: ready` (a 503 here with the container
healthy means the connector cannot fetch the issuer's metadata — check the
issuer URL for the realm path, and that the container can resolve
`auth.fluxology.ca`); [44] `HTTP/2 401` with a `WWW-Authenticate` header.

Then attach it as a **second claude.ai connector**, exactly as in 6.2:

1. **Settings → Connectors → Add custom connector**.
2. Name: `Fluxology Dashboards`. URL: `https://mcp.fluxology.ca/mcp`.
3. Advanced settings: Client ID `claude-ai`, the same regenerated secret.
   The claude.ai callback URL is already registered on the client from 6.2.
4. Authorize, consenting to the `dashboards:*`/`*:write` scopes.
5. Verify the tool scan shows the five dashboard tools (three category
   upserts + reads) and **no** delete or feed-replacement tool — the same
   gate as fluxology-site `docs/MCP-CONNECTOR.md` step 4.

`fluxology-mcp` is not attached to Claude Code in this lane; add it later
with another `claude mcp add … --client-id claude-code` against
`https://mcp.fluxology.ca/mcp` if wanted — the realm's `claude-code` client
already covers it.

---

## 8. Verification checklist and troubleshooting

### 8.1 Full-system checklist

Run top to bottom; every row must match before Lane B is declared done.

| # | Check (command ref) | Expected |
| --- | --- | --- |
| V1 | `dig +short A auth.fluxology.ca` [1] | VPS IPv4 |
| V2 | `dig +short A browser-mcp.fluxology.ca` [2] | VPS IPv4 |
| V3 | `GET https://auth.fluxology.ca/realms/fluxology/.well-known/openid-configuration` [10] | 200; `issuer` exactly `https://auth.fluxology.ca/realms/fluxology` |
| V4 | `GET https://auth.fluxology.ca/.well-known/oauth-authorization-server/realms/fluxology` [11] | 200; same issuer (RFC 8414 form) |
| V5 | `GET https://auth.fluxology.ca/realms/fluxology/protocol/openid-connect/certs` [12] | 200; ≥ 1 key |
| V6 | `GET https://browser-mcp.fluxology.ca/healthz` [25] | 200 `{"status":"ok"}` |
| V7 | `GET https://browser-mcp.fluxology.ca/readyz` [26] | 200 `{"status":"ready"}` |
| V8 | `GET https://browser-mcp.fluxology.ca/.well-known/oauth-protected-resource/mcp` [27] | 200; `resource` = `…/mcp`, `authorization_servers` = the issuer, three `browser:*` + four dashboard scopes |
| V9 | Unauthenticated `POST https://browser-mcp.fluxology.ca/mcp` [28] | **401** + `WWW-Authenticate: Bearer … resource_metadata="…"` |
| V10 | `device:list` on the gateway [38] | Two rows (`laptop`, `desktop`), both `active`, `last_seen` advancing |
| V11 | `claude mcp list` [40] | `browser-bridge … ✓ Connected` |
| V12 | claude.ai → Settings → Connectors | `Browser Bridge` **Connected** (a second `Fluxology Dashboards` connector is optional — section 7) |
| V13 | Smoke on laptop device (6.3) | session opens on laptop; ebay.ca navigated; extract returns data |
| V14 | Smoke on desktop device (6.3) | same, visibly on the desktop |
| V15 | `GET https://mcp.fluxology.ca/healthz` | 200 |
| V16 | `GET https://mcp.fluxology.ca/readyz` [43] | 200 `status: ready` |
| V17 | Unauthenticated `POST https://mcp.fluxology.ca/mcp` [44] | **401** + `WWW-Authenticate` challenge |
| V18 | `GET https://mcp.fluxology.ca/.well-known/oauth-protected-resource` | 200; audience/resource `https://mcp.fluxology.ca/mcp` |

### 8.2 Troubleshooting

**401 on /mcp with a valid login — audience mismatch.**
Symptom: OAuth completes, but every tool call is rejected with
`invalid_token`; gateway log (`docker compose -f deploy/compose.yaml logs
mcp-gateway`) shows an audience/`aud` validation failure. The token's `aud`
claim and the resource's `OAUTH_AUDIENCE` differ. Decode a live token to see
what Keycloak actually stamped:

```bash
# [45]  Paste an access token (never a refresh token) into TOKEN first;
#       this prints its claims locally, nothing is sent anywhere:
python3 -c "import base64,json,sys; p=sys.argv[1].split('.')[1]; print(json.dumps(json.loads(base64.urlsafe_b64decode(p+'='*(-len(p)%4))), indent=2))" "$TOKEN" | jq '{iss, aud, scope, azp}'
```

Fix whichever side is wrong: the audience mapper in the realm
(`deploy/auth/realm-fluxology.json` / admin console → Client scopes) or
`OAUTH_AUDIENCE` in `deploy/.env` (then `docker compose -f
deploy/compose.yaml up -d mcp-gateway` to re-read it). Same procedure for
fluxology-mcp with `MCP_OAUTH_AUDIENCE`. Also confirm `iss` in the decoded
token matches V3 exactly — an issuer mismatch presents identically.

**401/403 `insufficient_scope` on a specific tool.**
Symptom: some tools work, others answer with a scope challenge naming the
missing scope (e.g. `Tool browser.session_open requires scope
browser:interact`). The token simply lacks it — [45] shows the granted
`scope`. In Keycloak: **Clients → claude-ai (or claude-code) → Client
scopes** — the `browser:*` scopes must be assigned (default, or optional
*and* requested). After changing scope assignments, disconnect and
re-authorize the client so a fresh token is minted; old tokens keep their old
scopes until expiry. Read-only tools need `browser:read`; anything that
opens, navigates, clicks, or fills needs `browser:interact`; `browser:admin`
is diagnostics only and is never needed by the model surface.

**Agent offline (`DEVICE_OFFLINE` from `browser.session_open`).**
Check in this order:

```powershell
# [46]  On the affected PC — is the logon task actually running?
Get-ScheduledTask -TaskName FluxologyBrowserBridgeAgent | Select TaskName,State
# [47]  Restart it and watch:
Start-ScheduledTask -TaskName FluxologyBrowserBridgeAgent
```

Then on the VPS, [38] again — `last_seen` must start advancing within one
heartbeat (20 s). Still offline: (a) `AGENT_GATEWAY_URL` on that PC must be
exactly `wss://browser-mcp.fluxology.ca/agent/ws` (check the *user*
environment, which the logon task inherits); (b) the device row in [38] must
be `active`, not `revoked`; (c) a device paired before a Lane A cleanup
([29]) presents a stale identity and is rejected at the WSS handshake — run
[29] and re-pair with a fresh token; (d) corporate/AV firewalls must allow
outbound 443 WebSockets. Remember the PC only ever connects outbound; there
is nothing to open inbound.

**Caddy 502 on browser-mcp.fluxology.ca.**
Caddy cannot reach `browser-mcp-gateway:3000`. In order:

```bash
# [48]  Is the gateway container up and healthy?
docker compose -f deploy/compose.yaml ps
# [49]  Are BOTH the gateway and fluxology-caddy on fluxology-edge?
docker network inspect fluxology-edge --format '{{range .Containers}}{{.Name}} {{end}}'
```

[49] must list `fluxology-caddy` and the gateway container together. If the
gateway is missing, `compose up` was run against a different project/network
— re-run [21] then [22]. If the container is healthy and attached but 502
persists, confirm the Caddyfile proxies to `browser-mcp-gateway:3000` (the
network alias from `deploy/compose.yaml`), not to a container name or
localhost. A 502 *only during* `docker compose up -d --build` is just the
rebuild window; re-check after [23] goes healthy.

**Keycloak realm import failed.**
Symptoms: [10] returns 404 for the realm, or the Keycloak container
crash-loops. Read the import error:

```bash
# [50]
docker compose -f deploy/auth/compose.auth.yaml logs | grep -iA5 -m1 'error.*import\|import.*failed'
```

Typical causes: malformed JSON in `realm-fluxology.json` (the log names the
line), or a previous partial import leaving a conflicting realm. Keycloak's
default import strategy skips an existing realm — so a realm created broken
stays broken until removed: delete the `fluxology` realm in the admin console
(realm settings → action menu) or reset the auth stack's DB volume (auth
stack only — never `down -v` anything else on this VPS), fix the JSON, and
`docker compose -f deploy/auth/compose.auth.yaml up -d` again. Afterwards
re-run V3–V5 **and** re-check 2.4 (operator user and regenerated secret do
not survive a volume reset).

**Everything worked yesterday, agents dropped at a config change.**
A Caddy reload closes proxied WebSockets after `stream_close_delay` (5 m
grace). The agents reconnect on their own backoff; [38] shows `last_seen`
resuming. If a reload is needed during an active browser session, expect the
session to survive the grace window or fail with a retryable error the model
can re-open.
