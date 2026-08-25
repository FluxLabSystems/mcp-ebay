# Fluxology authorization server (Lane B)

Self-hosted OAuth 2.1 / OIDC authorization server for the Fluxology edge:
**Keycloak 26.x + its own PostgreSQL 17**, joining the existing external
Docker network `fluxology-edge`, published to the internet only through the
independently-managed `fluxology-caddy` container as
**`https://auth.fluxology.ca`**.

It mints the access tokens validated by two OAuth 2.1 **resource servers**:

| Resource server | Audience (must match its `OAUTH_AUDIENCE` exactly) | Scopes it enforces |
| --- | --- | --- |
| Browser-bridge gateway (this repo, `apps/gateway`) | `https://browser-mcp.fluxology.ca/mcp` | `browser:read`, `browser:interact`, `browser:admin` |
| fluxology-mcp (fluxology-site repo, `services/fluxology-mcp`) | `https://mcp.fluxology.ca/mcp` | `dashboards:read`, `office:write`, `deals:write`, `jobs:write` |

Files here:

- `compose.auth.yaml` — the two-container stack (no host ports, healthchecks, realm auto-import).
- `realm-fluxology.json` — the `fluxology` realm, auto-imported on first boot.
- `caddy-auth-snippet.caddy` — site block for the existing VPS Caddyfile.
- `env.auth.example` — template for `deploy/auth/.env` (copy, fill, `chmod 600 .env`).

## What both resource servers actually validate (extracted from code)

Both use `jose` `jwtVerify` against a remote JWKS. The realm in this
directory is shaped so one Keycloak token satisfies both validators.

**Browser-bridge gateway** (`apps/gateway/src/auth/verifier.ts`,
`packages/config/src/index.ts`):

- `iss` must equal `OAUTH_ISSUER` exactly; `OAUTH_ISSUER` and
  `OAUTH_JWKS_URI` must be `https://` URLs; JWKS is taken from
  `OAUTH_JWKS_URI` directly (no discovery).
- `aud` must contain `OAUTH_AUDIENCE` (jose semantics: string equality, or
  membership when `aud` is an array — Keycloak emits an array once the
  audience mappers add values, which matches).
- `exp` is **mandatory** (explicit post-verify check). No clock tolerance is
  configured — keep VPS clocks NTP-synced.
- Scope claim: `scope` **or** `scp`; space-delimited string **or** array of
  strings. Keycloak's space-delimited `scope` string is accepted.
- Client id read from `client_id` then `azp` (Keycloak sets `azp`).
- Scope hierarchy (`packages/protocol/src/catalog.ts`): `browser:interact`
  also satisfies `browser:read`; nothing else implies anything — a token
  needs each scope it will use.

**fluxology-mcp** (`services/fluxology-mcp/src/auth.mjs`, `src/config.mjs`):

- `requiredClaims: ['iss', 'aud', 'sub', 'exp']` — a token **without `exp`
  or without `sub` is refused**. The realm file keeps Keycloak's `basic`
  client scope (which carries the `sub` protocol mapper) attached to both
  clients precisely for this; do not detach it.
- `aud` must contain `OAUTH_AUDIENCE` (same jose semantics as above;
  defaults to `https://mcp.fluxology.ca/mcp` via the fluxology-site
  compose).
- Scope claim: union of `scope`, `scp`, and `scopes`; string or array.
- 30 s clock tolerance (`OAUTH_CLOCK_TOLERANCE_SECONDS`).
- JWKS by discovery from the issuer (RFC 8414 path-insertion, then OIDC
  forms — Keycloak's `/realms/fluxology/.well-known/openid-configuration`
  is the third candidate tried and works). The discovered document's
  `issuer` must equal `OAUTH_ISSUER` and its `jwks_uri` must be on the
  issuer's **origin** — both true for Keycloak. If `OAUTH_JWKS_URI` is
  pinned instead, it must be https and share the issuer origin.
- Exact scope per tool, no hierarchy: `dashboards:read` for reads,
  `office:write` / `deals:write` / `jobs:write` per category.

Neither server pins JWT algorithms in code; Keycloak's default RS256 works.
Neither requires `azp` to hold a particular value (it is only used as a
client-id fallback).

## First boot

1. Prerequisites: `fluxology-edge` exists and the Caddy container is
   attached to it (see fluxology-site `docs/CADDY-INTEGRATION.md`); DNS
   A/AAAA record for `auth.fluxology.ca` points at the VPS.
2. ```bash
   cd deploy/auth
   cp env.auth.example .env
   # edit .env: set both CHANGE_ME values
   chmod 600 .env
   docker compose -f compose.auth.yaml up -d
   docker compose -f compose.auth.yaml ps   # wait for keycloak: healthy
   ```
   First boot takes a while: Keycloak augments its server image, runs DB
   migrations, and imports `realm-fluxology.json` (`--import-realm` skips
   the import on later boots once the realm exists — post-boot changes are
   made in the admin console, not by editing the JSON).
3. Merge `caddy-auth-snippet.caddy` into the VPS Caddyfile, then
   `caddy validate` and `caddy reload` inside the Caddy container.
4. Log in at `https://auth.fluxology.ca/admin` with the
   `KC_BOOTSTRAP_ADMIN_*` credentials. That account is **temporary**:
   create your permanent admin (master realm → Users), verify it works,
   delete the temporary one.
5. Create your one end user: realm picker → **fluxology** → Users →
   Create user (set a username; set a password under Credentials,
   "Temporary" off). Do not grant any roles — scopes, not roles, gate the
   resource servers.
6. Regenerate the `claude-ai` client secret: fluxology realm → Clients →
   `claude-ai` → Credentials → Regenerate. The value shipped in
   `realm-fluxology.json` is a placeholder and must not survive first boot.
   Copy the new secret into the claude.ai connector configuration.

## Values the resource servers need

- **Issuer**: `https://auth.fluxology.ca/realms/fluxology`
- **JWKS URI**: `https://auth.fluxology.ca/realms/fluxology/protocol/openid-connect/certs`

Browser-bridge (`deploy/.env` of this repo):

```bash
OAUTH_MODE=required
OAUTH_ISSUER=https://auth.fluxology.ca/realms/fluxology
OAUTH_AUDIENCE=https://browser-mcp.fluxology.ca/mcp
OAUTH_JWKS_URI=https://auth.fluxology.ca/realms/fluxology/protocol/openid-connect/certs
```

Note the audience **includes the `/mcp` path** (the gateway's RFC 9728
document also names `PUBLIC_BASE_URL + /mcp` as the resource identifier),
whereas `deploy/env.example` shows a bare-origin placeholder. The realm's
audience mappers emit exactly `https://browser-mcp.fluxology.ca/mcp`;
`OAUTH_AUDIENCE` must be byte-for-byte identical or every token is refused
with an audience error.

fluxology-mcp (fluxology-site `.env`; compose maps `MCP_OAUTH_*` through as
`OAUTH_*`):

```bash
MCP_OAUTH_ISSUER=https://auth.fluxology.ca/realms/fluxology
MCP_OAUTH_AUDIENCE=https://mcp.fluxology.ca/mcp   # its compose default; keep identical to the mapper value
# MCP_OAUTH_JWKS_URI can stay unset — discovery works and is issuer-origin-checked
```

Set the issuer to the **realm** URL, not the bare host: the fluxology-site
`docs/MCP-CONNECTOR.md` example shows `https://auth.fluxology.ca`, which
would fail fluxology-mcp's issuer check against Keycloak tokens.

### Verify with curl (RFC 8414 / OIDC metadata)

```bash
# OIDC discovery — must answer 200 with "issuer" exactly
# https://auth.fluxology.ca/realms/fluxology and a same-origin "jwks_uri":
curl -fsS https://auth.fluxology.ca/realms/fluxology/.well-known/openid-configuration | \
  jq '{issuer, jwks_uri, authorization_endpoint, token_endpoint, code_challenge_methods_supported}'

# Signing keys:
curl -fsS https://auth.fluxology.ca/realms/fluxology/protocol/openid-connect/certs | jq '.keys[].alg'

# RFC 8414 path-insertion form (needs-live-verification — see below):
curl -fsS https://auth.fluxology.ca/.well-known/oauth-authorization-server/realms/fluxology | jq .issuer
```

To inspect what a token will contain **before** wiring any client: fluxology
realm → Clients → `claude-code` → Client scopes tab → **Evaluate**, pick the
user and type the scopes (e.g. `browser:interact dashboards:read`), then view
"Generated access token" — check `aud`, `scope`, `sub`, `exp`, `azp`.

End-to-end, an unauthenticated MCP request must still be challenged:

```bash
curl -isS -X POST https://browser-mcp.fluxology.ca/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -5
# expect 401 + WWW-Authenticate: Bearer ... resource_metadata="..."
```

## How scope → audience mapping works

Keycloak has no RFC 8707 `resource` parameter support; the token's `aud` is
produced by **protocol mappers on client scopes**. Each of the seven custom
scopes carries an *Audience* mapper (`oidc-audience-mapper`,
`included.custom.audience`) naming the resource server that owns it:

- `browser:read`, `browser:interact`, `browser:admin` →
  `https://browser-mcp.fluxology.ca/mcp`
- `dashboards:read`, `office:write`, `deals:write`, `jobs:write`,
  `vacation:write` → **both** `https://browser-mcp.fluxology.ca/mcp` **and**
  `https://mcp.fluxology.ca/mcp`

The dashboard scopes carry two audience mappers because two resource servers
now serve the same dashboards: the Browser Bridge gateway (`dashboard.feed` /
`dashboard.upsert`) and the standalone fluxology-mcp connector
(`upsert_*_listings`), which hard-requires `https://mcp.fluxology.ca/mcp` and
is already deployed by the fluxology-site stack. A single audience would have
silently 401'd whichever server was not named.

So a token requested with `scope=browser:interact office:write` carries
`aud: ["https://browser-mcp.fluxology.ca/mcp", "https://mcp.fluxology.ca/mcp"]`
plus that `scope` string, and each server accepts it (jose array-membership
`aud` match) while still enforcing its own scopes. Request only the scopes a
session needs and the audience narrows automatically. If a resource server's
`OAUTH_AUDIENCE` ever changes, change the corresponding mapper values (Client
scopes → scope → Mappers → "audience: …") to the identical string.

All seven scopes are **optional** client scopes on both clients: they appear
in the token only when the client asks for them. The `basic`, `profile`,
`email`, `roles`, `web-origins`, `acr` built-in scopes stay attached as
defaults — `basic` is what puts the **`sub`** claim in access tokens
(Keycloak 25+ behavior), and fluxology-mcp hard-requires `sub`.

## Token lifetimes (chosen defaults)

| Setting | Value | Why |
| --- | --- | --- |
| Access token lifespan | 15 min | Short-lived JWTs; both servers verify statelessly, so revocation is only as fast as expiry. |
| SSO session idle | 30 days | The refresh token stays usable as long as the connector refreshes at least monthly — covers intermittent claude.ai / claude-code use without re-login. |
| SSO session max | 90 days | Absolute cap; after this a re-login is forced regardless of activity. |
| Refresh token rotation | On (`revokeRefreshToken: true`, max reuse 0) | Every refresh issues a new refresh token and kills the old one; a replayed refresh token revokes the session. |
| Offline session idle | 30 days | Only relevant if you later grant `offline_access`; the realm does not attach that scope to either client by default. |

If a connector client turns out not to tolerate rotation (refresh failures
after network races), relax it in Realm settings → Sessions/Tokens rather
than lengthening the access token.

## Adjusting redirect URIs

Clients → (`claude-ai` | `claude-code`) → Settings → Valid redirect URIs.

- `claude-ai` ships with `https://claude.ai/api/mcp/auth_callback`. This
  value is operationally reported, not verified from code — on first attach,
  if claude.ai shows or logs a different callback (Keycloak will answer
  `invalid_redirect_uri` at the authorize step and log the offending URI in
  `docker logs fluxology-auth`), replace the entry with the exact URL shown.
  Keep it exact; do not resort to `https://claude.ai/*` wildcards.
- `claude-code` ships with `http://localhost:18800/callback` and
  `http://127.0.0.1:18800/callback` because Keycloak cannot wildcard ports
  and the runbook standardizes `--callback-port 18800`. If a different port
  or path is ever used, add that exact URI too.

## Realm import format notes

`realm-fluxology.json` is a Keycloak partial realm representation (top-level
realm attributes + `clientScopes` + `clients`, no users), consumed by
`--import-realm` from `/opt/keycloak/data/import/`. Two deliberate choices:

- **The built-in client scopes are included.** Keycloak (verified against
  the 26.3.0 source, `RealmManager.importRealm`) creates its default client
  scopes only when the representation has **no** `clientScopes` key at all;
  since this file must define seven custom scopes, the built-ins it relies
  on (`basic` — carrier of `sub` — plus `profile`, `email`, `roles`,
  `web-origins`, `acr`) are declared too, mirroring the definitions in
  Keycloak's `OIDCLoginProtocolFactory`. `profile` is trimmed to its four
  materially useful mappers (full/given/family name, username); the omitted
  ones (picture, locale, …) only add optional claims. `offline_access` is
  created by Keycloak itself regardless.
- **Everything else is left to Keycloak defaults** (authentication flows,
  keys, required actions, remaining realm attributes): the import fills
  them in, and pinning them here would only drift from the running server.

No user accounts are exported or imported — the operator creates the single
real user in the admin console (step 5 above).

## Needs-live-verification

Things not provable from the code in these two repositories; check on first
deployment:

1. **claude.ai callback URL** `https://claude.ai/api/mcp/auth_callback` —
   operationally reported. Verify on first attach; adjust per the section
   above if claude.ai presents a different one.
2. **How claude.ai supplies client credentials** — the realm pre-creates a
   confidential `claude-ai` client on the assumption the connector UI
   accepts a manually configured client id + secret. If claude.ai instead
   insists on RFC 7591 dynamic client registration, either create an
   initial-access token (fluxology realm → Client registration) or check
   the connector's advanced settings for manual client entry.
3. **RFC 8414 path-insertion discovery**
   (`/.well-known/oauth-authorization-server/realms/fluxology` at the
   origin) — not confirmed that Keycloak 26.x serves this form natively.
   Both resource servers are unaffected (the gateway never discovers;
   fluxology-mcp falls through to OIDC discovery, which Keycloak serves),
   and MCP clients are specified to fall back to OIDC discovery too. If a
   client refuses the fallback, enable the commented shim in
   `caddy-auth-snippet.caddy`.
4. **Keycloak image tag** — `quay.io/keycloak/keycloak:26.3` was current
   stable 26.x when written; check quay.io for the newest 26.x and bump the
   tag in `compose.auth.yaml` before first deploy.
5. **Container healthcheck** — the bash `/dev/tcp` probe assumes the stock
   Keycloak image (bash present, management interface on 9000 with
   `KC_HEALTH_ENABLED=true`). If `docker compose ps` shows keycloak
   permanently unhealthy while `/realms/fluxology` answers, test the probe
   manually with `docker exec fluxology-auth bash -c '...'`.
6. **claude-code loopback flow details** — port 18800 and path `/callback`
   come from the Lane B runbook, not from code in either repository; if the
   CLI's real loopback listener differs, add its exact redirect URI.
