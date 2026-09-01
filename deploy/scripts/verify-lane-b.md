# verify-lane-b.sh — Lane B post-deploy verification

Proves the full OAuth chain of the Lane B deployment from any shell — no
claude.ai involved:

| Component      | URL                                      |
|----------------|------------------------------------------|
| Keycloak       | `https://auth.fluxology.ca` (realm `fluxology`, issuer `https://auth.fluxology.ca/realms/fluxology`) |
| Browser bridge | `https://browser-mcp.fluxology.ca/mcp` (MCP 2026-07-28 modern profile) |
| fluxology-mcp  | `https://mcp.fluxology.ca/mcp` (MCP Streamable HTTP, SDK 1.30) |

Requirements: `bash`, `curl`, `jq`. The script refuses to start without `jq`
and prints an install hint. Tokens and client secrets are handed to curl via
temp files (never argv) and are never printed.

## What it checks, in order

1. **DNS + TLS** — resolve/connect/verify certificates for all three hosts;
   `/healthz` (200) and `/readyz` (ready) on both resource servers.
2. **AS metadata** — `<issuer>/.well-known/openid-configuration`: `issuer`
   matches exactly, `authorization_endpoint`/`token_endpoint` present,
   `jwks_uri` reachable with at least one key. Also the RFC 8414 document
   (either the path-inserted or Keycloak's path-suffixed location).
3. **Resource metadata (RFC 9728)** — both servers, at
   `/.well-known/oauth-protected-resource/mcp` **and** the root fallback:
   `resource` is the exact `/mcp` URL, `authorization_servers` names the
   issuer, expected scopes advertised.
4. **Unauthenticated probes** — `POST /mcp` without a token must answer 401
   with the exact `WWW-Authenticate` challenge each codebase emits
   (bridge: `Bearer error="invalid_token", …, resource_metadata="…"`;
   connector: `Bearer realm="…", error="invalid_token", …`). A garbage bearer
   must also be rejected; connector `GET /mcp` must be `405 Allow: POST, DELETE`.
5. **Authenticated probes** (when a token source is given) — `tools/list`
   against both: bridge must list its 15 `browser.*` tools; the connector
   lists the subset of its five tools the token's scopes permit (all five with
   `dashboards:read office:write deals:write jobs:write vacation:write`). A wrong-audience
   token must be rejected 401 by both.
6. **Optional browser smoke** (`--device <deviceId>`) —
   `browser_session_open → browser_navigate(https://www.ebay.ca/) →
   browser_snapshot` through the bridge. Needs a paired Windows agent online
   and a bridge token with `browser:interact`. Skipped unless requested.

Every check prints a `PASS`/`FAIL`/`WARN`/`SKIP` line; one failure never
aborts the run. Exit code is `0` only when every executed check passed.

## Token modes

**Mode (a) — bring your own token (always works).** Obtain an access token by
any flow (Keycloak UI/`kcadm`, device flow, an MCP client's token, …) and:

```bash
VERIFY_TOKEN='eyJ…' ./verify-lane-b.sh                 # env (preferred: not in shell history)
./verify-lane-b.sh --token 'eyJ…'                      # flag
./verify-lane-b.sh --bridge-token 'eyJ…' --mcp-token 'eyJ…'   # per-resource tokens
./verify-lane-b.sh --token 'eyJ…' --bad-token 'eyJ…'   # + wrong-audience probe
```

`--bad-token` should be a valid, unexpired token from the same issuer whose
`aud` matches **neither** resource — that is what makes the audience-binding
check meaningful. Without it (and without mode b) the wrong-audience check is
skipped, never faked.

**Mode (b) — optional `verify-cli` service account.** If the operator created
a confidential client, the script mints its own tokens via
`client_credentials`:

```bash
VERIFY_CLIENT_SECRET='…' ./verify-lane-b.sh --client-id verify-cli
```

It requests one token per resource (`--bridge-scopes`, default
`browser:read browser:interact`; `--mcp-scopes`, default
`dashboards:read office:write deals:write jobs:write vacation:write`) plus one **scopeless**
token used as the wrong-audience probe.

Keycloak setup for `verify-cli` (optional, one-time):

1. Clients → Create: `verify-cli`, confidential ("Client authentication" on),
   Service accounts roles enabled, no redirect URIs needed.
2. Client scopes → create the seven scopes above as **optional** client
   scopes and attach them to `verify-cli`.
3. On the `browser:*` scopes add an **audience mapper** for the bridge's
   configured `OAUTH_AUDIENCE`; on the dashboard scopes add one for
   fluxology-mcp's audience (its default is `https://mcp.fluxology.ca/mcp`,
   i.e. `MCP_PUBLIC_URL`). Keeping the mappers on *optional* scopes is what
   makes the scopeless token audience-free, so the wrong-audience check works.

> Audience values must equal what each service was deployed with:
> fluxology-mcp defaults its audience to `MCP_PUBLIC_URL`
> (`https://mcp.fluxology.ca/mcp`); the bridge uses `OAUTH_AUDIENCE` from
> `deploy/.env` (`deploy/env.example` shows the origin form,
> `https://browser-mcp.example.com` — check what the operator actually set,
> and keep the audience mapper identical to it).

## Other options

```
--issuer URL       expected issuer   (default https://auth.fluxology.ca/realms/fluxology)
--bridge-url URL   bridge base       (default https://browser-mcp.fluxology.ca)
--mcp-url URL      connector base    (default https://mcp.fluxology.ca)
--device NAME      run the browser smoke test against this paired deviceId
```

All flags have `VERIFY_*` environment fallbacks (see `--help`).

## Examples

```bash
# Discovery + challenge contracts only (no token needed):
./verify-lane-b.sh

# Full chain with an operator token:
VERIFY_TOKEN="$(pbpaste)" ./verify-lane-b.sh

# Full chain + browser smoke via the verify-cli service account:
VERIFY_CLIENT_SECRET='…' ./verify-lane-b.sh --client-id verify-cli --device win-desk-01
```

## Reading failures

- `AUTH IS NOT ENFORCED if 200` on an unauthenticated probe: stop the rollout.
- `mcp … 503 temporarily_unavailable`: the connector itself cannot reach the
  authorization server from inside its network (its `/readyz` will agree).
- `DEVICE_OFFLINE` in the smoke test: no Windows agent is connected for that
  deviceId — pair/start the agent, then re-run with `--device`.
- Bridge `tools/list` HTTP 429: the gateway's per-client rate limit
  (`RATE_LIMIT_MCP_PER_MINUTE`) — wait a minute and re-run.
