#!/usr/bin/env bash
# lane-b-deploy.sh — interactive, resumable automation of deploy/LANE-B-RUNBOOK.md
# (the VPS side). Runs the runbook's numbered steps [1]-[28] plus the kcadm
# equivalent of section 2.4, mints pairing tokens for section 5, and prints
# the Windows/claude.ai steps it cannot perform. The runbook remains the
# reference for every assertion here; step numbers below cite it as [n].
#
# Design rules:
#   - Idempotent: every stage probes real state and skips work already done;
#     abort at any point and re-run, or resume with --from/--only.
#   - As unattended as possible: secrets are generated, not prompted; the
#     only prompts are true decisions (operator username, fluxology-site
#     .env path when not found, Caddyfile confirmation) and every prompt
#     has a default so --yes runs everything non-interactively.
#   - The independently managed fluxology-caddy container is NEVER created,
#     stopped, restarted, or recreated. The Caddyfile edit is
#     backup -> append -> validate -> reload, with automatic restore when
#     validation fails.
#
# Usage:
#   bash deploy/scripts/lane-b-deploy.sh                 # all stages, prompts
#   bash deploy/scripts/lane-b-deploy.sh --yes           # accept all defaults
#   bash deploy/scripts/lane-b-deploy.sh --list-stages
#   bash deploy/scripts/lane-b-deploy.sh --from gateway-env
#   bash deploy/scripts/lane-b-deploy.sh --only pair
#   bash deploy/scripts/lane-b-deploy.sh --only verify
#
# Options:
#   --yes                 non-interactive; accept every default
#   --from STAGE          start at STAGE, run through the end
#   --only STAGE          run exactly one stage
#   --list-stages         print stage names and exit
#   --caddyfile PATH      host path of the VPS-wide Caddyfile (default: auto
#                         from fluxology-caddy's mounts)
#   --site-env PATH       fluxology-site stack .env holding the ingest tokens
#                         (default: /opt/fluxology-site/.env, then prompt)
#   --operator-user NAME  Keycloak operator username (default: operator)
#   --rotate-claude-ai-secret   regenerate the claude-ai secret even if one
#                               was already saved by a previous run
set -euo pipefail
umask 077

# ------------------------------------------------------------------ config --
AUTH_HOST="auth.fluxology.ca"
BRIDGE_HOST="browser-mcp.fluxology.ca"
APEX_HOST="fluxology.ca"
REALM="fluxology"
ACME_WAIT="${ACME_WAIT:-180}"   # seconds to wait for first-issuance TLS on a new hostname
ISSUER="https://${AUTH_HOST}/realms/${REALM}"
JWKS_URI="${ISSUER}/protocol/openid-connect/certs"
BRIDGE_BASE="https://${BRIDGE_HOST}"
OAUTH_AUDIENCE="${BRIDGE_BASE}/mcp"   # /mcp path included — deploy/auth/README.md
CLAUDE_CODE_REDIRECT="http://localhost:18800/callback"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AUTH_DIR="$REPO_ROOT/deploy/auth"
AUTH_ENV="$AUTH_DIR/.env"
AUTH_COMPOSE=(docker compose -f "$AUTH_DIR/compose.auth.yaml")
GW_ENV="$REPO_ROOT/deploy/.env"
GW_COMPOSE=(docker compose -f "$REPO_ROOT/deploy/compose.yaml")
CLAUDE_AI_SECRET_FILE="$AUTH_DIR/.env.claude-ai-secret"   # .gitignore: .env.*

ASSUME_YES=0
FROM_STAGE=""
ONLY_STAGE=""
CADDYFILE=""
SITE_ENV="${SITE_ENV:-/opt/fluxology-site/.env}"
OPERATOR_USER="operator"
ROTATE_SECRET=0

STAGES=(host-preflight dns auth-env auth-up caddy verify-auth keycloak-setup
        gateway-env gateway-up verify-bridge pair verify next-steps)

# ----------------------------------------------------------------- helpers --
c_grn=$'\033[32m'; c_red=$'\033[31m'; c_yel=$'\033[33m'; c_bld=$'\033[1m'; c_off=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s  ok  %s %s\n' "$c_grn" "$c_off" "$*"; }
skip() { printf '%s skip %s %s\n' "$c_yel" "$c_off" "$*"; }
warn() { printf '%s warn %s %s\n' "$c_yel" "$c_off" "$*" >&2; }
die()  { printf '%s FAIL %s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }
hdr()  { printf '\n%s== %s ==%s\n' "$c_bld" "$*" "$c_off"; }

confirm() { # confirm "question" [default_yes=1]
  local q="$1" def="${2:-1}" ans
  if (( ASSUME_YES )); then return $(( def ? 0 : 1 )); fi
  local hint="[Y/n]"; (( def )) || hint="[y/N]"
  read -r -p "$q $hint " ans || true
  case "${ans:-}" in
    [Yy]*) return 0 ;;
    [Nn]*) return 1 ;;
    *) return $(( def ? 0 : 1 )) ;;
  esac
}

prompt_default() { # prompt_default "question" "default" -> REPLY
  local q="$1" def="$2"
  if (( ASSUME_YES )); then REPLY="$def"; return; fi
  read -r -p "$q [$def] " REPLY || true
  REPLY="${REPLY:-$def}"
}

gen_b64() { openssl rand -base64 32; }
gen_hex() { openssl rand -hex 24; }

resolve4() { # resolve4 host -> prints A records (dig, else getent)
  if command -v dig >/dev/null 2>&1; then dig +short A "$1" | grep -E '^[0-9.]+$' || true
  else getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u || true; fi
}

curl_code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$@" || true; }

# Caddy issues a certificate on the FIRST request for a new hostname, so the
# very first HTTPS call after a reload routinely fails the TLS handshake (curl
# reports 000) for tens of seconds. Poll until one of the accepted codes shows
# up rather than dying on ACME latency.
wait_http_code() { # wait_http_code <url> <timeout-seconds> <accepted-code>...
  local url="$1" timeout="$2"; shift 2
  local deadline=$(( SECONDS + timeout )) code accepted
  while :; do
    code="$(curl_code "$url")"
    for accepted in "$@"; do [[ "$code" == "$accepted" ]] && { printf '%s' "$code"; return 0; }; done
    (( SECONDS >= deadline )) && { printf '%s' "$code"; return 1; }
    sleep 5
  done
}

wait_healthy() { # wait_healthy <container-id-or-name> <timeout-seconds> <label>
  local target="$1" timeout="$2" label="$3" t=0 st
  while (( t < timeout )); do
    st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$target" 2>/dev/null || echo missing)"
    case "$st" in
      healthy|running) ok "$label is $st"; return 0 ;;
      missing) die "$label: container not found" ;;
    esac
    sleep 5; t=$(( t + 5 ))
  done
  die "$label not healthy after ${timeout}s (state: $st). Logs: docker logs $target"
}

fill_placeholder() { # fill_placeholder <file> <KEY> <value>  (replaces KEY=CHANGE_ME*)
  local f="$1" key="$2" val="$3"
  grep -q "^${key}=" "$f" || die "$f has no ${key}= line to fill"
  # values are base64/hex/urls — none contain '|'
  sed -i "s|^${key}=.*|${key}=${val}|" "$f"
}

kcadm() { # kcadm <args...> — authenticated kcadm inside the keycloak container
  "${AUTH_COMPOSE[@]}" exec -T \
    -e KC_USER="$KC_BOOT_USER" -e KC_PW="$KC_BOOT_PW" keycloak bash -c '
      /opt/keycloak/bin/kcadm.sh config credentials \
        --server http://localhost:8080 --realm master \
        --user "$KC_USER" --password "$KC_PW" >/dev/null
      /opt/keycloak/bin/kcadm.sh "$@"' -- "$@"
}

load_boot_admin() {
  [[ -f "$AUTH_ENV" ]] || die "$AUTH_ENV missing — run the auth-env stage first"
  KC_BOOT_USER="$(sed -n 's/^KC_BOOTSTRAP_ADMIN_USERNAME=//p' "$AUTH_ENV" | tail -1)"
  KC_BOOT_PW="$(sed -n 's/^KC_BOOTSTRAP_ADMIN_PASSWORD=//p' "$AUTH_ENV" | tail -1)"
  [[ -n "$KC_BOOT_USER" && -n "$KC_BOOT_PW" ]] || die "bootstrap admin credentials not found in $AUTH_ENV"
}

# ------------------------------------------------------------------ stages --

stage_host_preflight() {
  hdr "Stage host-preflight — tools, repo, docker"
  local bin
  for bin in docker curl openssl sed grep awk; do
    command -v "$bin" >/dev/null 2>&1 || die "required binary missing: $bin"
  done
  docker compose version >/dev/null 2>&1 || die "docker compose v2 plugin missing"
  command -v jq >/dev/null 2>&1 || die "jq is required (apt-get install -y jq)"
  command -v dig >/dev/null 2>&1 || warn "dig not found — DNS checks fall back to getent"
  [[ -f "$REPO_ROOT/deploy/compose.yaml" && -f "$AUTH_DIR/compose.auth.yaml" ]] \
    || die "run from an mcp-ebay checkout (looked in $REPO_ROOT)"
  docker info >/dev/null 2>&1 || die "docker daemon unreachable (permissions?)"
  ok "tools present; repo at $REPO_ROOT"
  # Edge contract ([21] / preflight.sh) — checked early so we fail before
  # touching anything when the fluxology-site stack isn't deployed yet.
  docker network inspect fluxology-edge >/dev/null 2>&1 \
    || die "external network fluxology-edge missing — deploy the fluxology-site stack first (its CADDY-INTEGRATION.md §1 creates it)"
  docker inspect -f '{{json .NetworkSettings.Networks}}' fluxology-caddy 2>/dev/null \
    | grep -q fluxology-edge || die "fluxology-caddy is not attached to fluxology-edge"
  ok "fluxology-edge exists and fluxology-caddy is attached"
}

stage_dns() {
  hdr "Stage dns — [1]-[3] A records must match the apex"
  local apex auth bridge tries=0
  # Bounded: under --yes, confirm() returns the default without prompting, so
  # an unbounded retry loop spins forever on DNS that never propagates.
  local max_tries="${DNS_MAX_TRIES:-20}"
  while :; do
    apex="$(resolve4 "$APEX_HOST" | head -1)"
    auth="$(resolve4 "$AUTH_HOST" | head -1)"
    bridge="$(resolve4 "$BRIDGE_HOST" | head -1)"
    say "  $APEX_HOST -> ${apex:-<none>}   $AUTH_HOST -> ${auth:-<none>}   $BRIDGE_HOST -> ${bridge:-<none>}"
    [[ -n "$apex" ]] || die "$APEX_HOST does not resolve — check VPS DNS/resolver"
    if [[ "$auth" == "$apex" && "$bridge" == "$apex" ]]; then
      ok "all three hostnames resolve to $apex"; return 0
    fi
    warn "auth/bridge records missing or stale. Create both A records -> $apex, then retry."
    warn "Proceeding to the Caddy stage with bad DNS triggers rate-limited ACME failures (runbook §1)."
    tries=$(( tries + 1 ))
    (( tries >= max_tries )) \
      && die "DNS still not propagated after $tries checks (~$(( tries * 15 ))s). Create the auth/bridge A records -> $apex and re-run: $0 --from dns"
    if confirm "Retry DNS check now (n = abort)?" 1; then sleep 15; else die "DNS not propagated"; fi
  done
}

stage_auth_env() {
  hdr "Stage auth-env — [4]-[7] deploy/auth/.env with generated secrets"
  # Note: compose.auth.yaml reads ./.env — the runbook's '.env.auth' name is
  # historical. Migrate a legacy file rather than ignoring it.
  if [[ ! -f "$AUTH_ENV" && -f "$AUTH_DIR/.env.auth" ]]; then
    mv "$AUTH_DIR/.env.auth" "$AUTH_ENV"
    warn "migrated legacy deploy/auth/.env.auth -> .env (the name compose actually reads)"
  fi
  if [[ -f "$AUTH_ENV" ]] && ! grep -q '^[^#]*CHANGE_ME' "$AUTH_ENV"; then
    chmod 0600 "$AUTH_ENV"; skip "deploy/auth/.env exists with no placeholders"; return 0
  fi
  [[ -f "$AUTH_ENV" ]] || cp "$AUTH_DIR/env.auth.example" "$AUTH_ENV"
  chmod 0600 "$AUTH_ENV"
  fill_placeholder "$AUTH_ENV" KC_BOOTSTRAP_ADMIN_PASSWORD "$(gen_b64)"
  fill_placeholder "$AUTH_ENV" POSTGRES_PASSWORD "$(gen_b64)"
  ! grep -q '^[^#]*CHANGE_ME' "$AUTH_ENV" || die "CHANGE_ME placeholders remain in $AUTH_ENV"
  ok "secrets generated ([6]); no CHANGE_ME left ([7] = 0)"
  say "  Bootstrap admin password lives only in $AUTH_ENV (KC_BOOTSTRAP_ADMIN_PASSWORD)."
}

stage_auth_up() {
  hdr "Stage auth-up — [8]-[9] Keycloak + auth-db, realm import"
  "${AUTH_COMPOSE[@]}" up -d
  # First boot: image augmentation + migrations + realm import (start_period 120s).
  wait_healthy fluxology-auth-db 120 "fluxology-auth-db"
  wait_healthy fluxology-auth 420 "fluxology-auth (healthy = /health/ready = DB + realm loaded)"
  if "${AUTH_COMPOSE[@]}" logs keycloak 2>/dev/null | grep -qiE "Realm '?${REALM}'? (imported|already exists)"; then
    ok "realm '${REALM}' imported (or already present)"
  else
    warn "no realm-import log line found — verified via discovery in verify-auth instead"
  fi
}

locate_caddyfile() {
  [[ -n "$CADDYFILE" ]] && return 0
  CADDYFILE="$(docker inspect -f \
    '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' \
    fluxology-caddy 2>/dev/null || true)"
  if [[ -z "$CADDYFILE" || ! -f "$CADDYFILE" ]]; then
    prompt_default "Host path of the VPS-wide Caddyfile?" "/opt/fluxology-site/docker/caddy/Caddyfile"
    CADDYFILE="$REPLY"
  fi
  [[ -f "$CADDYFILE" ]] || die "Caddyfile not found at $CADDYFILE (pass --caddyfile PATH)"
}

caddy_has_block() { grep -Eq "^[[:space:]]*${1//./\\.}[[:space:]]*\{" "$CADDYFILE"; }

stage_caddy() {
  hdr "Stage caddy — merge both site blocks, validate, reload ([13]-[16])"
  locate_caddyfile
  say "  Caddyfile: $CADDYFILE"
  local need_auth=1 need_bridge=1
  caddy_has_block "$AUTH_HOST"   && { skip "block for $AUTH_HOST already present"; need_auth=0; }
  caddy_has_block "$BRIDGE_HOST" && { skip "block for $BRIDGE_HOST already present"; need_bridge=0; }
  if (( need_auth || need_bridge )); then
    confirm "Append the missing site block(s) to $CADDYFILE?" 1 \
      || die "declined — merge the snippets manually per runbook §3, then re-run --from verify-auth"
    local backup
    backup="${CADDYFILE}.lane-b.bak.$(date +%Y%m%d%H%M%S)"
    cp "$CADDYFILE" "$backup"; ok "backup: $backup"
    if (( need_auth )); then
      { printf '\n'; cat "$AUTH_DIR/caddy-auth-snippet.caddy"; } >> "$CADDYFILE"
      ok "appended $AUTH_HOST block (deploy/auth/caddy-auth-snippet.caddy)"
    fi
    if (( need_bridge )); then
      { printf '\n'; sed "s/browser-mcp\.example\.com/${BRIDGE_HOST}/" "$REPO_ROOT/deploy/caddy-snippet.caddy"; } >> "$CADDYFILE"
      ok "appended $BRIDGE_HOST block (deploy/caddy-snippet.caddy, hostname substituted)"
    fi
    # [13] validate BEFORE [14] reload — a broken reload takes down every host.
    if ! docker exec fluxology-caddy caddy validate --config /etc/caddy/Caddyfile; then
      cp "$backup" "$CADDYFILE"
      die "caddy validate failed — Caddyfile restored from $backup; nothing was reloaded"
    fi
    ok "caddy validate: valid configuration"
    docker exec fluxology-caddy caddy reload --config /etc/caddy/Caddyfile
    ok "caddy reloaded"
  else
    docker exec fluxology-caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null \
      && ok "existing Caddyfile still validates"
  fi
  # [15]/[16]
  local code
  say "  waiting for TLS/ACME on the new hostnames (first issuance can take a minute)…"
  code="$(wait_http_code "https://${AUTH_HOST}/realms/${REALM}/.well-known/openid-configuration" "$ACME_WAIT" 200)" \
    || die "[15] expected 200 from auth discovery through Caddy within ${ACME_WAIT}s, got $code (000 = TLS/ACME never completed: check DNS [1]-[3] and 'docker logs fluxology-caddy')"
  ok "[15] auth discovery through the edge: 200"
  code="$(wait_http_code "${BRIDGE_BASE}/healthz" "$ACME_WAIT" 200 502)" || true
  case "$code" in
    200) ok "[16] bridge healthz: 200 (gateway already deployed)" ;;
    502) ok "[16] bridge answers 502 — TLS + routing up, gateway not deployed yet (expected)" ;;
    *)   die "[16] expected 200 or 502 from ${BRIDGE_BASE}/healthz within ${ACME_WAIT}s, got $code (DNS, ACME or merge problem)" ;;
  esac
}

stage_verify_auth() {
  hdr "Stage verify-auth — [10]-[12] discovery, RFC 8414, JWKS"
  local doc iss
  doc="$(curl -fsS --max-time 20 "https://${AUTH_HOST}/realms/${REALM}/.well-known/openid-configuration")" \
    || die "[10] OIDC discovery unreachable"
  iss="$(jq -r '.issuer' <<<"$doc")"
  [[ "$iss" == "$ISSUER" ]] || die "[10] issuer is '$iss', expected exactly '$ISSUER' — fix KC_HOSTNAME in deploy/auth/.env"
  ok "[10] issuer exact: $ISSUER"
  # RFC 8414 section 3.1 INSERTS the well-known path before the issuer's
  # path; Keycloak only serves the APPENDED form. Requiring the inserted one
  # made this stage unsatisfiable against a stock Keycloak. Probe the same
  # candidate list, in the same order, as scripts/verify-lane-b.sh and
  # services/fluxology-mcp/src/auth.mjs -- either satisfies the connector.
  local inserted="https://${AUTH_HOST}/.well-known/oauth-authorization-server/realms/${REALM}"
  local suffixed="${ISSUER}/.well-known/oauth-authorization-server"
  local cand served=""
  for cand in "$inserted" "$suffixed"; do
    iss="$(curl -fsS --max-time 20 "$cand" 2>/dev/null | jq -r '.issuer // empty' 2>/dev/null || true)"
    if [[ "${iss%/}" == "$ISSUER" ]]; then served="$cand"; break; fi
  done
  [[ -n "$served" ]] || die "[11] RFC 8414 metadata: neither $inserted nor $suffixed returned issuer '$ISSUER' (enable the path-insertion shim in deploy/auth/caddy-auth-snippet.caddy, then re-run --from verify-auth)"
  ok "[11] RFC 8414 discovery: same issuer (served at $served)"
  if [[ "$served" == "$suffixed" ]]; then
    warn "[11] the RFC 8414 path-inserted form ($inserted) is not served. fluxology-mcp falls back to the appended form, but an MCP client that only implements path-insertion will fail discovery. Enable the shim in deploy/auth/caddy-auth-snippet.caddy and reload Caddy."
  fi
  local keys
  keys="$(curl -fsS --max-time 20 "$JWKS_URI" | jq '.keys | length')"
  [[ "$keys" =~ ^[0-9]+$ && "$keys" -ge 1 ]] || die "[12] JWKS has no keys"
  ok "[12] JWKS reachable: $keys key(s)"
}

stage_keycloak_setup() {
  hdr "Stage keycloak-setup — section 2.4 via kcadm (operator user, claude-ai secret)"
  load_boot_admin
  prompt_default "Operator username (authorizes claude.ai / Claude Code)?" "$OPERATOR_USER"
  OPERATOR_USER="$REPLY"

  # Operator user (create once; never resets an existing password).
  local count
  count="$(kcadm get "users" -r "$REALM" -q "username=$OPERATOR_USER" -q exact=true | jq 'length')"
  if [[ "$count" != 0 ]]; then
    skip "operator user '$OPERATOR_USER' already exists (password untouched)"
  else
    kcadm create users -r "$REALM" -s "username=$OPERATOR_USER" -s enabled=true >/dev/null
    local op_pw; op_pw="$(gen_b64)"
    kcadm set-password -r "$REALM" --username "$OPERATOR_USER" --new-password "$op_pw" >/dev/null
    local op_file="$AUTH_DIR/.env.operator-credentials"
    { echo "OPERATOR_USERNAME=$OPERATOR_USER"; echo "OPERATOR_PASSWORD=$op_pw"; } > "$op_file"
    chmod 0600 "$op_file"
    ok "operator '$OPERATOR_USER' created; permanent password written to $op_file (0600, gitignored)"
    say "  You will type this password on every Keycloak consent screen (6.1/6.2)."
  fi

  # claude-ai secret — the committed realm value has lived in git history:
  # regenerate on first run, keep thereafter unless --rotate-claude-ai-secret.
  if [[ -f "$CLAUDE_AI_SECRET_FILE" && $ROTATE_SECRET == 0 ]]; then
    skip "claude-ai secret already regenerated ($CLAUDE_AI_SECRET_FILE; --rotate-claude-ai-secret to rotate)"
  else
    local cid secret
    cid="$(kcadm get clients -r "$REALM" -q clientId=claude-ai | jq -r '.[0].id')"
    [[ -n "$cid" && "$cid" != null ]] || die "client 'claude-ai' not found in realm $REALM (realm import broken?)"
    kcadm create "clients/$cid/client-secret" -r "$REALM" >/dev/null
    secret="$(kcadm get "clients/$cid/client-secret" -r "$REALM" | jq -r '.value')"
    [[ -n "$secret" && "$secret" != null ]] || die "could not read regenerated claude-ai secret"
    printf 'CLAUDE_AI_CLIENT_SECRET=%s\n' "$secret" > "$CLAUDE_AI_SECRET_FILE"
    chmod 0600 "$CLAUDE_AI_SECRET_FILE"
    ok "claude-ai client secret regenerated -> $CLAUDE_AI_SECRET_FILE (0600, gitignored)"
    say "  Paste it into the claude.ai connector dialog (6.2) — never leave the committed placeholder live."
  fi

  # claude-code client sanity ([2.4].4): public + PKCE S256 + exact redirect.
  local cc
  cc="$(kcadm get clients -r "$REALM" -q clientId=claude-code | jq '.[0]')"
  [[ "$(jq -r '.publicClient' <<<"$cc")" == true ]] || die "claude-code is not a public client"
  jq -e --arg u "$CLAUDE_CODE_REDIRECT" '.redirectUris | index($u)' <<<"$cc" >/dev/null \
    || die "claude-code lacks redirect URI $CLAUDE_CODE_REDIRECT"
  [[ "$(jq -r '.attributes["pkce.code.challenge.method"] // empty' <<<"$cc")" == "S256" ]] \
    || warn "claude-code has no explicit PKCE S256 attribute — confirm in the console"
  ok "claude-code client: public, redirect $CLAUDE_CODE_REDIRECT"
  say "  Reminder (auth README): the bootstrap admin is temporary — create a permanent"
  say "  master-realm admin in the console and delete the temporary one."
}

stage_gateway_env() {
  hdr "Stage gateway-env — [17]-[20] deploy/.env"
  # Commented-out lines don't count: a previous run may have disabled the
  # dashboard block, and re-templating would regenerate the DB password
  # against an already-initialized postgres volume.
  if [[ -f "$GW_ENV" ]] && ! grep -q '^[^#]*CHANGE_ME' "$GW_ENV"; then
    chmod 0600 "$GW_ENV"; skip "deploy/.env exists with no placeholders"; return 0
  fi
  [[ -f "$GW_ENV" ]] || cp "$REPO_ROOT/deploy/env.example" "$GW_ENV"
  chmod 0600 "$GW_ENV"
  local db_pw art_secret
  db_pw="$(gen_hex)"; art_secret="$(gen_b64)"
  fill_placeholder "$GW_ENV" PUBLIC_BASE_URL "$BRIDGE_BASE"
  fill_placeholder "$GW_ENV" DATABASE_URL "postgres://bridge:${db_pw}@postgres:5432/browser_bridge"
  fill_placeholder "$GW_ENV" OAUTH_ISSUER "$ISSUER"
  fill_placeholder "$GW_ENV" OAUTH_AUDIENCE "$OAUTH_AUDIENCE"
  fill_placeholder "$GW_ENV" OAUTH_JWKS_URI "$JWKS_URI"
  fill_placeholder "$GW_ENV" ARTIFACT_URL_SECRET "$art_secret"
  fill_placeholder "$GW_ENV" POSTGRES_PASSWORD "$db_pw"

  # Dashboard write-path tokens: copy from the fluxology-site stack ([4.1]);
  # never mint new ones here.
  if [[ ! -f "$SITE_ENV" ]]; then
    prompt_default "Path to the fluxology-site stack .env (ingest tokens)? ('skip' disables dashboard tools)" "$SITE_ENV"
    SITE_ENV="$REPLY"
  fi
  local tok found=0 missing=0
  if [[ "$SITE_ENV" != skip && -f "$SITE_ENV" ]]; then
    for key in DEALS_INGEST_TOKEN OFFICE_INGEST_TOKEN JOBS_INGEST_TOKEN VACATION_INGEST_TOKEN; do
      tok="$(sed -n "s/^${key}=//p" "$SITE_ENV" | tail -1)"
      # An upgraded deployment's .env predates a newly added token key, so add
      # the line rather than dying on a missing placeholder.
      grep -q "^${key}=" "$GW_ENV" || printf '%s=CHANGE_ME\n' "$key" >> "$GW_ENV"
      if [[ -n "$tok" ]]; then fill_placeholder "$GW_ENV" "$key" "$tok"; found=1
      else warn "$key not found in $SITE_ENV"; missing=1; fi
    done
    (( missing )) || ok "ingest tokens copied from $SITE_ENV"
  else
    [[ "$SITE_ENV" == skip ]] || warn "$SITE_ENV not found"
    missing=1
  fi
  # A PARTIAL token set must never comment out DASHBOARD_API_BASE_URL: the
  # gateway refuses to boot when any *_INGEST_TOKEN is set without a base URL,
  # so disabling the URL while leaving real tokens behind bricks the stack.
  # The gateway accepts a subset — a dashboard whose token is absent simply
  # refuses its own upsert with a message naming the missing variable.
  if (( found )); then
    # Drop only the placeholders that were never filled.
    sed -i -E 's~^((DEALS|OFFICE|JOBS|VACATION)_INGEST_TOKEN=CHANGE_ME.*)$~# \1~' "$GW_ENV"
    (( missing )) && warn "some ingest tokens were absent; their dashboards stay read-only until you add them and re-up"
  elif (( missing )); then
    # Nothing to write with: unset the whole block (env.example contract).
    sed -i -E 's~^(DASHBOARD_API_BASE_URL=.*)$~# \1~; s~^((DEALS|OFFICE|JOBS|VACATION)_INGEST_TOKEN=CHANGE_ME.*)$~# \1~' "$GW_ENV"
    warn "dashboard block commented out — dashboard.feed/upsert disabled until you fill the tokens and re-up"
  fi
  ! grep -q '^[^#]*CHANGE_ME' "$GW_ENV" || die "CHANGE_ME placeholders remain in $GW_ENV"
  ok "deploy/.env written (issuer=$ISSUER, audience=$OAUTH_AUDIENCE)"
}

stage_gateway_up() {
  hdr "Stage gateway-up — [21]-[24] preflight, build, migrate"
  bash "$REPO_ROOT/deploy/scripts/preflight.sh"
  "${GW_COMPOSE[@]}" up -d --build
  local gw_id pg_id
  pg_id="$("${GW_COMPOSE[@]}" ps -q postgres)"
  gw_id="$("${GW_COMPOSE[@]}" ps -q mcp-gateway)"
  wait_healthy "$pg_id" 120 "postgres"
  wait_healthy "$gw_id" 300 "mcp-gateway"
  # NFR-09: the gateway must publish no host port.
  [[ -z "$(docker port "$gw_id" 2>/dev/null)" ]] || die "mcp-gateway publishes a host port — compose.yaml was modified (NFR-09)"
  "${GW_COMPOSE[@]}" exec -T mcp-gateway node apps/gateway/dist/cli.js migrate up
  ok "migrations applied ([24])"
}

stage_verify_bridge() {
  hdr "Stage verify-bridge — [25]-[28] through the edge"
  local body code
  body="$(curl -fsS --max-time 20 "${BRIDGE_BASE}/healthz")" || die "[25] healthz failed"
  jq -e '.status == "ok"' <<<"$body" >/dev/null || die "[25] healthz body: $body"
  ok "[25] healthz ok"
  body="$(curl -fsS --max-time 20 "${BRIDGE_BASE}/readyz")" || die "[26] readyz failed (db down? check DATABASE_URL)"
  jq -e '.status == "ready"' <<<"$body" >/dev/null || die "[26] readyz body: $body"
  ok "[26] readyz ready"
  body="$(curl -fsS --max-time 20 "${BRIDGE_BASE}/.well-known/oauth-protected-resource/mcp")" || die "[27] PRM failed"
  [[ "$(jq -r '.resource' <<<"$body")" == "$OAUTH_AUDIENCE" ]] || die "[27] PRM resource != $OAUTH_AUDIENCE"
  jq -e --arg i "$ISSUER" '.authorization_servers | index($i)' <<<"$body" >/dev/null \
    || die "[27] PRM authorization_servers missing $ISSUER"
  if jq -e '.scopes_supported | index("deals:write")' <<<"$body" >/dev/null; then
    ok "[27] PRM ok (browser + dashboard scopes advertised)"
  else
    warn "[27] PRM ok, but dashboard scopes absent — expected when the dashboard block is unset"
  fi
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X POST "${BRIDGE_BASE}/mcp" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
  [[ "$code" == 401 ]] || die "[28] unauthenticated /mcp answered $code, expected 401 — OAuth is NOT enforced, stop and check deploy/.env"
  ok "[28] unauthenticated /mcp challenged with 401"
}

stage_pair() {
  hdr "Stage pair — section 5: mint one-time tokens, print the Windows steps"
  local devices
  devices="$("${GW_COMPOSE[@]}" exec -T mcp-gateway node apps/gateway/dist/cli.js device:list 2>/dev/null || true)"
  [[ -n "$devices" ]] && { say "Currently paired devices:"; say "$devices"; }
  local name
  for name in laptop desktop; do
    if grep -qE "\b${name}\b" <<<"$devices"; then
      skip "'$name' already paired — skipping (revoke + re-pair manually if intended)"; continue
    fi
    confirm "Mint a pairing token for '$name' now (valid 10 min, single use)?" 1 || { skip "$name"; continue; }
    say ""
    "${GW_COMPOSE[@]}" exec -T mcp-gateway node apps/gateway/dist/cli.js device:pair --name "$name"
    cat <<EOF

  --- On the $name (PowerShell, in the repo checkout), within 10 minutes ---
  # [29] only if this PC ever ran Lane A:
  Remove-Item "\$env:LOCALAPPDATA\\Fluxology\\BrowserBridge\\state\\device.json" -ErrorAction SilentlyContinue
  # [31] first setup or after git pull:
  corepack enable; pnpm install --frozen-lockfile; pnpm build
  \$env:AGENT_GATEWAY_URL = "wss://${BRIDGE_HOST}/agent/ws"
  node apps\\windows-agent\\dist\\cli.js preflight                     # [33] must prove branded Chrome
  node apps\\windows-agent\\dist\\cli.js pair --token <token-above> --name $name   # [34]
  powershell -ExecutionPolicy Bypass -File scripts\\windows\\install-logon-task.ps1 \`
    -GatewayUrl wss://${BRIDGE_HOST}/agent/ws                          # [35]
  Start-ScheduledTask -TaskName FluxologyBrowserBridgeAgent            # [36]
  ---------------------------------------------------------------------------
EOF
  done
  say ""
  say "Verify with: ${GW_COMPOSE[*]} exec mcp-gateway node apps/gateway/dist/cli.js device:list   # [38]"
  say "(two rows, both active, last_seen advancing every 20 s)"
}

stage_verify() {
  hdr "Stage verify — tokenless sections of scripts/verify-lane-b.sh"
  if confirm "Run scripts/verify-lane-b.sh (sections 1-4, no tokens) now?" 1; then
    bash "$REPO_ROOT/deploy/scripts/verify-lane-b.sh" || die "verify-lane-b.sh reported failures"
    ok "verify-lane-b.sh sections 1-4 passed"
  else
    skip "verification script"
  fi
}

stage_next_steps() {
  hdr "Remaining manual steps (cannot be done from the VPS)"
  # Name the credentials file, never print its contents: it is 0600 and
  # gitignored, and this block is routinely pasted into chats and issues.
  local OPERATOR_CREDENTIALS_HINT="${AUTH_DIR#$REPO_ROOT/}/.env.operator-credentials"
  if [[ ! -f "$AUTH_DIR/.env.operator-credentials" ]]; then
    OPERATOR_CREDENTIALS_HINT="unchanged (the operator user pre-existed)"
  fi
  cat <<EOF
1. Windows pairing runs (section 5): execute the printed PowerShell blocks on
   each PC. On a PC that never ran Lane A: after [36], log into eBay once in
   the Chrome automation profile and set delivery destination M6H 2W9.
2. Claude Code attach (6.1), on any workstation. This is TWO steps -- the
   command only writes config, it does not log anything in.
   a) In a shell:
        claude mcp add --transport http --client-id claude-code --callback-port 18800 \\
          browser-bridge ${BRIDGE_BASE}/mcp
   b) Start an interactive Claude Code session (run: claude) and type /mcp at
      the prompt. /mcp is a slash command INSIDE the session, not a shell
      command. Pick browser-bridge from the list, then choose Authenticate.
      A browser opens on ${AUTH_HOST}. Sign in as the OPERATOR user -- the
      realm user this script created, NOT the Keycloak admin and NOT your
      claude.ai account:
        username: ${OPERATOR_USER}
        password: ${OPERATOR_CREDENTIALS_HINT}
      Approve the scopes. The browser then lands on
      http://localhost:18800/callback, which Claude Code is serving locally
      to capture the code; back in the session, /mcp shows browser-bridge
      authenticated with the browser.* tools.
   VERIFY LIVE: if Keycloak answers invalid_redirect_uri, register the EXACT
   redirect_uri from the failing URL on the claude-code client (localhost vs
   127.0.0.1 is the known variant).
3. claude.ai attach (6.2): Settings -> Connectors -> Add custom connector,
   name "Browser Bridge", URL ${BRIDGE_BASE}/mcp, Advanced: Client ID
   claude-ai + the secret in ${CLAUDE_AI_SECRET_FILE#$REPO_ROOT/}.
   VERIFY LIVE: copy the callback URL shown in the dialog into
   Keycloak -> Clients -> claude-ai -> Valid redirect URIs BEFORE finishing.
4. Smoke per device (6.3) with the dev_... ids from device:list — with two
   devices online, "default" intentionally fails; always name the device.
5. Full checklist: runbook section 8.1 (V1-V18).
EOF
  ok "Lane B VPS side complete"
}

# ------------------------------------------------------------------ runner --
list_stages() { printf '%s\n' "${STAGES[@]}"; }

run_stage() {
  local s="$1"
  case "$s" in
    host-preflight) stage_host_preflight ;;
    dns)            stage_dns ;;
    auth-env)       stage_auth_env ;;
    auth-up)        stage_auth_up ;;
    caddy)          stage_caddy ;;
    verify-auth)    stage_verify_auth ;;
    keycloak-setup) stage_keycloak_setup ;;
    gateway-env)    stage_gateway_env ;;
    gateway-up)     stage_gateway_up ;;
    verify-bridge)  stage_verify_bridge ;;
    pair)           stage_pair ;;
    verify)         stage_verify ;;
    next-steps)     stage_next_steps ;;
    *) die "unknown stage: $s (see --list-stages)" ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)          ASSUME_YES=1; shift ;;
    --from)            FROM_STAGE="$2"; shift 2 ;;
    --only)            ONLY_STAGE="$2"; shift 2 ;;
    --list-stages)     list_stages; exit 0 ;;
    --caddyfile)       CADDYFILE="$2"; shift 2 ;;
    --site-env)        SITE_ENV="$2"; shift 2 ;;
    --operator-user)   OPERATOR_USER="$2"; shift 2 ;;
    --rotate-claude-ai-secret) ROTATE_SECRET=1; shift ;;
    --help|-h)         sed -n '2,46p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

if [[ -n "$ONLY_STAGE" ]]; then
  # Stages that talk to Keycloak need the bootstrap credentials loaded even
  # when their prerequisite stages are skipped this run.
  run_stage "$ONLY_STAGE"
  exit 0
fi

started=1
[[ -n "$FROM_STAGE" ]] && started=0
for s in "${STAGES[@]}"; do
  if (( ! started )); then
    [[ "$s" == "$FROM_STAGE" ]] && started=1 || continue
  fi
  run_stage "$s"
done
(( started )) || die "unknown --from stage: $FROM_STAGE (see --list-stages)"
