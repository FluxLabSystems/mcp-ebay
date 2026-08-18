#!/usr/bin/env bash
# verify-lane-b.sh — post-deploy verification for the Fluxology browser-bridge
# deployment ("Lane B"): Keycloak (auth.fluxology.ca, realm fluxology), the
# browser-bridge gateway (browser-mcp.fluxology.ca/mcp), and fluxology-mcp
# (mcp.fluxology.ca/mcp). Proves the whole OAuth chain from any shell with
# curl + jq — no claude.ai involved.
#
# Contract sources (do not change assertions without re-reading these):
#   Bridge:   apps/gateway/src/app.ts (PRM routes, challenge, /healthz /readyz),
#             tests/contract/mcpHttp.test.ts + oauth.test.ts (envelopes),
#             tests/helpers/mcpClient.ts (2026-07-28 modern profile headers/_meta),
#             packages/protocol/src/catalog.ts (15 browser.* tools, scopes).
#   Connector: fluxology-site/services/fluxology-mcp/src/server.mjs + auth.mjs
#             (PRM paths, challenge shape), test/protocol.test.mjs (envelopes).
#
# Usage: see verify-lane-b.md next to this script, or run with --help.
set -euo pipefail
umask 077

# ---------------------------------------------------------------- defaults --
ISSUER_DEFAULT="https://auth.fluxology.ca/realms/fluxology"
BRIDGE_BASE_DEFAULT="https://browser-mcp.fluxology.ca"
FLUX_BASE_DEFAULT="https://mcp.fluxology.ca"
MCP_PROTOCOL_VERSION="2026-07-28"   # packages/protocol/src/limits.ts:72

ISSUER="${VERIFY_ISSUER:-$ISSUER_DEFAULT}"
BRIDGE_BASE="${VERIFY_BRIDGE_URL:-$BRIDGE_BASE_DEFAULT}"
FLUX_BASE="${VERIFY_MCP_URL:-$FLUX_BASE_DEFAULT}"

TOKEN="${VERIFY_TOKEN:-}"                 # mode (a): operator-supplied token
BRIDGE_TOKEN="${VERIFY_BRIDGE_TOKEN:-}"   # optional per-resource override
FLUX_TOKEN="${VERIFY_MCP_TOKEN:-}"        # optional per-resource override
BAD_TOKEN="${VERIFY_BAD_TOKEN:-}"         # mode (a): wrong-audience token
CLIENT_ID="${VERIFY_CLIENT_ID:-}"         # mode (b): confidential client
CLIENT_SECRET="${VERIFY_CLIENT_SECRET:-}"
BRIDGE_SCOPES="${VERIFY_BRIDGE_SCOPES:-browser:read browser:interact}"
FLUX_SCOPES="${VERIFY_MCP_SCOPES:-dashboards:read office:write deals:write jobs:write}"
DEVICE=""
CURL_MAX_TIME=20
SMOKE_MAX_TIME=90

usage() {
  cat <<'EOF'
verify-lane-b.sh — verify Keycloak + browser-bridge + fluxology-mcp after deploy.

Token modes (mode a always works; both may be combined):
  a) --token TOK             Access token used against BOTH resource servers
     --bridge-token TOK      Token for browser-mcp only (overrides --token there)
     --mcp-token TOK         Token for mcp.fluxology.ca only
     --bad-token TOK         A token whose audience matches NEITHER resource
  b) --client-id ID          Confidential client (e.g. verify-cli) with
     --client-secret SEC     service-account (client_credentials) enabled.
                             Tokens are requested per resource with
                             --bridge-scopes / --mcp-scopes, plus one scopeless
                             token used as the wrong-audience probe.

Other options:
  --issuer URL         Expected AS issuer (default https://auth.fluxology.ca/realms/fluxology)
  --bridge-url URL     Bridge base URL (default https://browser-mcp.fluxology.ca)
  --mcp-url URL        Connector base URL (default https://mcp.fluxology.ca)
  --bridge-scopes S    Scopes requested for the bridge token (mode b)
  --mcp-scopes S       Scopes requested for the connector token (mode b)
  --device NAME        Run the optional browser smoke test against this deviceId
  --help               This help

Environment fallbacks: VERIFY_TOKEN, VERIFY_BRIDGE_TOKEN, VERIFY_MCP_TOKEN,
VERIFY_BAD_TOKEN, VERIFY_CLIENT_ID, VERIFY_CLIENT_SECRET, VERIFY_ISSUER,
VERIFY_BRIDGE_URL, VERIFY_MCP_URL, VERIFY_BRIDGE_SCOPES, VERIFY_MCP_SCOPES.
Prefer environment variables for secrets: flag values appear in shell history.
Tokens and secrets are never printed and are passed to curl via files, not argv.

Without any token source, sections 5-6 are skipped; sections 1-4 still run.
Exit status: 0 when every executed check passed, 1 otherwise.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)         TOKEN="$2"; shift 2 ;;
    --bridge-token)  BRIDGE_TOKEN="$2"; shift 2 ;;
    --mcp-token)     FLUX_TOKEN="$2"; shift 2 ;;
    --bad-token)     BAD_TOKEN="$2"; shift 2 ;;
    --client-id)     CLIENT_ID="$2"; shift 2 ;;
    --client-secret) CLIENT_SECRET="$2"; shift 2 ;;
    --bridge-scopes) BRIDGE_SCOPES="$2"; shift 2 ;;
    --mcp-scopes)    FLUX_SCOPES="$2"; shift 2 ;;
    --issuer)        ISSUER="$2"; shift 2 ;;
    --bridge-url)    BRIDGE_BASE="$2"; shift 2 ;;
    --mcp-url)       FLUX_BASE="$2"; shift 2 ;;
    --device)        DEVICE="$2"; shift 2 ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# Normalise: strip trailing slashes on base URLs and the issuer.
ISSUER="${ISSUER%/}"
BRIDGE_BASE="${BRIDGE_BASE%/}"
FLUX_BASE="${FLUX_BASE%/}"
BRIDGE_MCP="$BRIDGE_BASE/mcp"
FLUX_MCP="$FLUX_BASE/mcp"

# Split the issuer into origin + path (Keycloak: origin + /realms/<realm>).
ISSUER_SCHEME="${ISSUER%%://*}"
ISSUER_REST="${ISSUER#*://}"
AUTH_ORIGIN="$ISSUER_SCHEME://${ISSUER_REST%%/*}"
ISSUER_PATH=""
[[ "$ISSUER_REST" == */* ]] && ISSUER_PATH="/${ISSUER_REST#*/}"

# ------------------------------------------------------------ prerequisites --
for bin in curl jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "ERROR: '$bin' is required. Install it first, e.g.:" >&2
    echo "  Debian/Ubuntu: sudo apt-get install -y $bin" >&2
    echo "  RHEL/Fedora:   sudo dnf install -y $bin" >&2
    echo "  Alpine:        sudo apk add $bin" >&2
    echo "  macOS:         brew install $bin" >&2
    exit 2
  fi
done

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/verify-lane-b.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT
RESP_BODY="$WORKDIR/body"
RESP_HEADERS="$WORKDIR/headers"

# Token material lives only in 0600 files inside WORKDIR (umask 077), and is
# handed to curl via `-H @file` / `--data-urlencode key@file` so it never
# appears in argv or in any output line.
mk_auth_header_file() { # $1=token $2=outfile
  printf 'Authorization: Bearer %s\n' "$1" > "$2"
}
BRIDGE_HDR=""   # path to header file for the bridge token, when available
FLUX_HDR=""     # path to header file for the connector token, when available
BAD_HDR=""      # path to header file for the wrong-audience token

# ---------------------------------------------------------------- reporting --
PASS_COUNT=0; FAIL_COUNT=0; WARN_COUNT=0; SKIP_COUNT=0
FAILED_CHECKS=()
pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); FAILED_CHECKS+=("$1"); printf 'FAIL  %s\n' "$1"; }
warn() { WARN_COUNT=$((WARN_COUNT + 1)); printf 'WARN  %s\n' "$1"; }
skip() { SKIP_COUNT=$((SKIP_COUNT + 1)); printf 'SKIP  %s\n' "$1"; }
note() { printf '      %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }

# --------------------------------------------------------------- http utils --
HTTP_STATUS=""
CURL_ERR=""
http_request() { # method url [curl args...] -> sets HTTP_STATUS, RESP_BODY/HEADERS
  local method="$1" url="$2"; shift 2
  HTTP_STATUS=""; CURL_ERR=""
  : > "$RESP_BODY"; : > "$RESP_HEADERS"
  local rc=0
  HTTP_STATUS="$(curl -sS --max-time "$CURL_MAX_TIME" -o "$RESP_BODY" -D "$RESP_HEADERS" \
      -w '%{http_code}' -X "$method" "$@" "$url" 2>"$WORKDIR/curl.err")" || rc=$?
  if (( rc != 0 )); then
    CURL_ERR="curl exit $rc: $(head -c 200 "$WORKDIR/curl.err" | tr -d '\n')"
  fi
  return "$rc"
}

curl_diagnosis() { # translate the last curl failure into a DNS/TLS verdict
  local rc="$1"
  case "$rc" in
    6)  echo "DNS resolution failed" ;;
    7)  echo "TCP connection refused/failed" ;;
    28) echo "timed out" ;;
    35) echo "TLS handshake failed" ;;
    51|60|61) echo "TLS certificate verification failed" ;;
    *)  echo "request failed" ;;
  esac
}

response_header() { # $1=header name (case-insensitive); prints its value
  grep -i "^$1:" "$RESP_HEADERS" | tail -n 1 | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r'
}

json_of_response() {
  # Emit the response as JSON: plain JSON body, or the first SSE `data:` frame
  # (the modern bridge profile may answer over SSE; the connector answers JSON
  # because it sets enableJsonResponse — see server.mjs:300-303).
  if jq -e . "$RESP_BODY" >/dev/null 2>&1; then
    cat "$RESP_BODY"
  else
    sed -n 's/^data:[[:space:]]*//p' "$RESP_BODY" | head -n 1
  fi
}

jwt_claim() { # $1=token-file $2=jq filter; best-effort decode, "" if opaque
  local payload pad
  payload="$(cut -d. -f2 < "$1" | tr '_-' '/+' | tr -d '\n')"
  [[ -n "$payload" ]] || { echo ""; return 0; }
  pad=$(( (4 - ${#payload} % 4) % 4 ))
  while (( pad > 0 )); do payload+="="; pad=$((pad - 1)); done
  printf '%s' "$payload" | base64 -d 2>/dev/null | jq -r "$2 // empty" 2>/dev/null || true
}

host_of() { local h="${1#*://}"; h="${h%%/*}"; echo "${h%%:*}"; }

# ------------------------------------------------------------- MCP requests --
# Bridge (2026-07-28 modern profile — self-describing POST, no initialize):
# per tests/helpers/mcpClient.ts the request needs the MCP-Protocol-Version and
# Mcp-Method headers (Mcp-Name too on tools/call) and a params._meta envelope.
bridge_rpc() { # $1=method $2=params-json $3=tool-name-or-"" $4=auth-header-file-or-""
  local method="$1" params="$2" tool="${3:-}" hdr="${4:-}"
  local body
  body="$(jq -cn --arg m "$method" --argjson p "$params" --arg v "$MCP_PROTOCOL_VERSION" '
    {jsonrpc: "2.0", id: 1, method: $m,
     params: ($p + {"_meta": {
       "io.modelcontextprotocol/protocolVersion": $v,
       "io.modelcontextprotocol/clientInfo": {name: "verify-lane-b", version: "1.0.0"},
       "io.modelcontextprotocol/clientCapabilities": {}}})}')"
  local -a args=(
    -H 'content-type: application/json'
    -H 'accept: application/json, text/event-stream'
    -H "MCP-Protocol-Version: $MCP_PROTOCOL_VERSION"
    -H "Mcp-Method: $method"
    --data "$body"
  )
  [[ -n "$tool" ]] && args+=( -H "Mcp-Name: $tool" )
  [[ -n "$hdr" ]] && args+=( -H @"$hdr" )
  http_request POST "$BRIDGE_MCP" "${args[@]}"
}

# Connector (Streamable HTTP, SDK 1.30, stateless + JSON responses): a raw
# JSON-RPC POST with no initialize and no session header is the documented
# envelope — see test/protocol.test.mjs:133-137 and 373-379.
flux_rpc() { # $1=method $2=params-json-or-"" $3=auth-header-file-or-""
  local method="$1" params="${2:-}" hdr="${3:-}"
  local body
  if [[ -n "$params" ]]; then
    body="$(jq -cn --arg m "$method" --argjson p "$params" '{jsonrpc: "2.0", id: 1, method: $m, params: $p}')"
  else
    body="$(jq -cn --arg m "$method" '{jsonrpc: "2.0", id: 1, method: $m}')"
  fi
  local -a args=(
    -H 'content-type: application/json'
    -H 'accept: application/json, text/event-stream'
    --data "$body"
  )
  [[ -n "$hdr" ]] && args+=( -H @"$hdr" )
  http_request POST "$FLUX_MCP" "${args[@]}"
}

# ============================================================================
printf 'verify-lane-b: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '  issuer:  %s\n' "$ISSUER"
printf '  bridge:  %s\n' "$BRIDGE_MCP"
printf '  mcp:     %s\n' "$FLUX_MCP"

# --------------------------------------------------------- 1. DNS + TLS ----
section "1. DNS + TLS"

check_endpoint_reachable() { # $1=label $2=url $3=acceptable-status-regex
  local label="$1" url="$2" ok_re="$3" rc=0
  http_request GET "$url" || rc=$?
  if (( rc != 0 )); then
    fail "$label: $(curl_diagnosis "$rc") ($CURL_ERR)"
    return 0
  fi
  if [[ "$HTTP_STATUS" =~ $ok_re ]]; then
    pass "$label: TLS OK, HTTP $HTTP_STATUS"
  else
    fail "$label: TLS OK but unexpected HTTP $HTTP_STATUS (wanted $ok_re)"
  fi
}

# Keycloak root: 200 welcome page or a redirect, depending on version/config.
check_endpoint_reachable "auth ($(host_of "$ISSUER"))" "$AUTH_ORIGIN/" '^(200|30[1278])$' || true
# Bridge liveness: app.ts:246 answers {"status":"ok"} 200.
check_endpoint_reachable "bridge $BRIDGE_BASE/healthz" "$BRIDGE_BASE/healthz" '^200$' || true
# Connector liveness: server.mjs:329-337 answers {"status":"ok"} 200.
check_endpoint_reachable "mcp $FLUX_BASE/healthz" "$FLUX_BASE/healthz" '^200$' || true

check_readyz() { # $1=label $2=url  (503 is a real deploy problem: report FAIL)
  local label="$1" url="$2" rc=0 status
  http_request GET "$url" || rc=$?
  if (( rc != 0 )); then fail "$label: $(curl_diagnosis "$rc") ($CURL_ERR)"; return 0; fi
  status="$(jq -r '.status // empty' "$RESP_BODY" 2>/dev/null || true)"
  if [[ "$HTTP_STATUS" == "200" ]]; then
    pass "$label: ready (status=${status:-unknown})"
  else
    fail "$label: HTTP $HTTP_STATUS status=${status:-unknown} — service is up but not ready"
  fi
}
# Bridge readiness: app.ts:247-253 ({"status":"ready"} / 503 unavailable).
check_readyz "bridge $BRIDGE_BASE/readyz" "$BRIDGE_BASE/readyz" || true
# Connector readiness: server.mjs:339-371 (anonymous callers get the verdict).
check_readyz "mcp $FLUX_BASE/readyz" "$FLUX_BASE/readyz" || true

# ------------------------------------------------- 2. AS metadata (OIDC) ----
section "2. Authorization-server metadata"

TOKEN_ENDPOINT=""

check_oidc_discovery() {
  local url="$ISSUER/.well-known/openid-configuration" rc=0
  http_request GET "$url" -H 'accept: application/json' || rc=$?
  if (( rc != 0 )); then fail "OIDC discovery: $(curl_diagnosis "$rc") ($CURL_ERR)"; return 0; fi
  if [[ "$HTTP_STATUS" != "200" ]]; then fail "OIDC discovery: HTTP $HTTP_STATUS from $url"; return 0; fi
  local doc_issuer authz token jwks
  doc_issuer="$(jq -r '.issuer // empty' "$RESP_BODY")"
  authz="$(jq -r '.authorization_endpoint // empty' "$RESP_BODY")"
  token="$(jq -r '.token_endpoint // empty' "$RESP_BODY")"
  jwks="$(jq -r '.jwks_uri // empty' "$RESP_BODY")"
  if [[ "${doc_issuer%/}" == "$ISSUER" ]]; then
    pass "OIDC discovery: issuer matches exactly ($doc_issuer)"
  else
    fail "OIDC discovery: issuer mismatch — document says '${doc_issuer:-<missing>}', expected '$ISSUER'"
  fi
  if [[ -n "$authz" && -n "$token" ]]; then
    pass "OIDC discovery: authorization_endpoint and token_endpoint present"
    TOKEN_ENDPOINT="$token"
  else
    fail "OIDC discovery: authorization_endpoint or token_endpoint missing"
  fi
  if [[ -z "$jwks" ]]; then
    fail "OIDC discovery: jwks_uri missing"
    return 0
  fi
  local jrc=0
  http_request GET "$jwks" -H 'accept: application/json' || jrc=$?
  if (( jrc != 0 )); then fail "jwks_uri unreachable: $(curl_diagnosis "$jrc") ($CURL_ERR)"; return 0; fi
  local keycount
  keycount="$(jq -r '.keys | length' "$RESP_BODY" 2>/dev/null || echo 0)"
  if [[ "$HTTP_STATUS" == "200" && "$keycount" -ge 1 ]]; then
    pass "jwks_uri reachable with $keycount key(s)"
  else
    fail "jwks_uri: HTTP $HTTP_STATUS with ${keycount:-0} keys ($jwks)"
  fi
}
check_oidc_discovery || true

check_rfc8414() {
  # RFC 8414 path-insertion form first; fall back to Keycloak's path-suffix
  # form. fluxology-mcp itself probes the same candidate list, in this order
  # (services/fluxology-mcp/src/auth.mjs:116-130), so either satisfies it.
  local inserted="$AUTH_ORIGIN/.well-known/oauth-authorization-server$ISSUER_PATH"
  local suffixed="$ISSUER/.well-known/oauth-authorization-server"
  local -a candidates=("$inserted")
  [[ "$suffixed" != "$inserted" ]] && candidates+=("$suffixed")
  local candidate
  for candidate in "${candidates[@]}"; do
    local rc=0
    http_request GET "$candidate" -H 'accept: application/json' || rc=$?
    if (( rc == 0 )) && [[ "$HTTP_STATUS" == "200" ]]; then
      local doc_issuer
      doc_issuer="$(jq -r '.issuer // empty' "$RESP_BODY" 2>/dev/null || true)"
      if [[ "${doc_issuer%/}" == "$ISSUER" ]]; then
        pass "RFC 8414 metadata served at $candidate (issuer matches)"
        [[ "$candidate" == "$suffixed" ]] && \
          note "path-inserted variant ($inserted) was not served; the connector falls through to this one"
        return 0
      fi
    fi
  done
  fail "RFC 8414 metadata: neither $inserted nor $suffixed served a document with issuer $ISSUER"
}
check_rfc8414 || true

# ------------------------------------- 3. Protected Resource Metadata (PRM) --
section "3. RFC 9728 Protected Resource Metadata"

check_prm() { # $1=label $2=url $3=expected-resource $4=required-scope
  local label="$1" url="$2" resource="$3" reqscope="$4" rc=0
  http_request GET "$url" -H 'accept: application/json' || rc=$?
  if (( rc != 0 )); then fail "$label: $(curl_diagnosis "$rc") ($CURL_ERR)"; return 0; fi
  if [[ "$HTTP_STATUS" != "200" ]]; then fail "$label: HTTP $HTTP_STATUS"; return 0; fi
  local got_resource as_ok scope_ok
  got_resource="$(jq -r '.resource // empty' "$RESP_BODY")"
  as_ok="$(jq -r --arg iss "$ISSUER" \
    '[.authorization_servers // [] | .[] | rtrimstr("/")] | index($iss) != null' "$RESP_BODY")"
  scope_ok="$(jq -r --arg s "$reqscope" '(.scopes_supported // []) | index($s) != null' "$RESP_BODY")"
  if [[ "$got_resource" == "$resource" ]]; then
    pass "$label: resource is $resource"
  else
    fail "$label: resource is '${got_resource:-<missing>}', expected '$resource'"
  fi
  if [[ "$as_ok" == "true" ]]; then
    pass "$label: authorization_servers names $ISSUER"
  else
    fail "$label: authorization_servers does not name $ISSUER (got: $(jq -c '.authorization_servers // []' "$RESP_BODY"))"
  fi
  if [[ "$scope_ok" == "true" ]]; then
    pass "$label: scopes_supported includes $reqscope"
  else
    fail "$label: scopes_supported missing $reqscope (got: $(jq -c '.scopes_supported // []' "$RESP_BODY"))"
  fi
}

# Bridge PRM routes: endpoint-specific and root fallback (app.ts:120-121);
# document shape from app.ts:64-73 (resource = PUBLIC_BASE_URL + /mcp).
check_prm "bridge PRM /mcp"  "$BRIDGE_BASE/.well-known/oauth-protected-resource/mcp" "$BRIDGE_MCP" "browser:read" || true
check_prm "bridge PRM root"  "$BRIDGE_BASE/.well-known/oauth-protected-resource"     "$BRIDGE_MCP" "browser:read" || true
# Connector PRM routes: root + path-suffixed for mcpPath (server.mjs:117,
# auth.mjs:17-20); document shape from auth.mjs:22-32 (resource = MCP_PUBLIC_URL).
check_prm "mcp PRM /mcp"     "$FLUX_BASE/.well-known/oauth-protected-resource/mcp"   "$FLUX_MCP" "dashboards:read" || true
check_prm "mcp PRM root"     "$FLUX_BASE/.well-known/oauth-protected-resource"       "$FLUX_MCP" "dashboards:read" || true

# ------------------------------------------- 4. Unauthenticated challenges --
section "4. Unauthenticated probes"

check_bridge_challenge() {
  local rc=0
  bridge_rpc "tools/list" '{}' "" "" || rc=$?
  if (( rc != 0 )); then fail "bridge unauth POST /mcp: $(curl_diagnosis "$rc") ($CURL_ERR)"; return 0; fi
  local challenge expected_md
  challenge="$(response_header 'www-authenticate')"
  expected_md="resource_metadata=\"$BRIDGE_BASE/.well-known/oauth-protected-resource/mcp\""
  if [[ "$HTTP_STATUS" == "401" ]]; then
    pass "bridge unauth POST /mcp: 401"
  else
    fail "bridge unauth POST /mcp: expected 401, got HTTP $HTTP_STATUS — AUTH IS NOT ENFORCED if 200"
    return 0
  fi
  # Exact shape from the SDK's buildWwwAuthenticateHeader (used by
  # requireBearerAuth, app.ts:91-94) and asserted in tests/contract/oauth.test.ts:81-83:
  #   Bearer error="invalid_token", error_description="...", resource_metadata="<url>"
  if [[ "$challenge" == Bearer\ error=\"invalid_token\"* && "$challenge" == *"$expected_md"* ]]; then
    pass "bridge challenge: Bearer error=\"invalid_token\" with $expected_md"
  else
    fail "bridge challenge malformed: got '$challenge'"
  fi
}
check_bridge_challenge || true

check_flux_challenge() {
  local rc=0
  flux_rpc "tools/list" "" "" || rc=$?
  if (( rc != 0 )); then fail "mcp unauth POST /mcp: $(curl_diagnosis "$rc") ($CURL_ERR)"; return 0; fi
  local challenge expected_md body_err
  challenge="$(response_header 'www-authenticate')"
  expected_md="resource_metadata=\"$FLUX_BASE/.well-known/oauth-protected-resource/mcp\""
  body_err="$(jq -r '.error // empty' "$RESP_BODY" 2>/dev/null || true)"
  if [[ "$HTTP_STATUS" == "401" && "$body_err" == "invalid_token" ]]; then
    pass "mcp unauth POST /mcp: 401 invalid_token"
  else
    fail "mcp unauth POST /mcp: expected 401 invalid_token, got HTTP $HTTP_STATUS error='${body_err:-}' — AUTH IS NOT ENFORCED if 200"
    return 0
  fi
  # Exact shape from buildChallenge (auth.mjs:43-51), asserted in
  # test/protocol.test.mjs:139-143:
  #   Bearer realm="...", error="invalid_token", error_description="...", resource_metadata="<url>"
  if [[ "$challenge" == Bearer\ realm=\"* && "$challenge" == *'error="invalid_token"'* && "$challenge" == *"$expected_md"* ]]; then
    pass "mcp challenge: Bearer realm=... error=\"invalid_token\" with $expected_md"
  else
    fail "mcp challenge malformed: got '$challenge'"
  fi
}
check_flux_challenge || true

check_garbage_token_rejected() { # a syntactically invalid bearer must never pass
  mk_auth_header_file "invalid.invalid.invalid" "$WORKDIR/garbage.hdr"
  local rc=0
  bridge_rpc "tools/list" '{}' "" "$WORKDIR/garbage.hdr" || rc=$?
  if (( rc == 0 )) && [[ "$HTTP_STATUS" == "401" ]]; then
    pass "bridge rejects a garbage bearer token: 401"
  elif (( rc != 0 )); then
    fail "bridge garbage-token probe: $(curl_diagnosis "$rc") ($CURL_ERR)"
  else
    fail "bridge garbage-token probe: expected 401, got HTTP $HTTP_STATUS"
  fi
  rc=0
  flux_rpc "tools/list" "" "$WORKDIR/garbage.hdr" || rc=$?
  if (( rc != 0 )); then
    fail "mcp garbage-token probe: $(curl_diagnosis "$rc") ($CURL_ERR)"
  elif [[ "$HTTP_STATUS" == "401" ]]; then
    pass "mcp rejects a garbage bearer token: 401"
  elif [[ "$HTTP_STATUS" == "503" ]]; then
    # server.mjs/auth.mjs: 503 temporarily_unavailable means the CONNECTOR
    # cannot reach the authorization server's metadata — a deploy problem.
    fail "mcp garbage-token probe: 503 temporarily_unavailable — the connector cannot reach $ISSUER from inside its network"
  else
    fail "mcp garbage-token probe: expected 401, got HTTP $HTTP_STATUS"
  fi
}
check_garbage_token_rejected || true

check_flux_get_405() {
  local rc=0
  http_request GET "$FLUX_MCP" -H 'accept: application/json, text/event-stream' || rc=$?
  if (( rc != 0 )); then fail "mcp GET /mcp: $(curl_diagnosis "$rc") ($CURL_ERR)"; return 0; fi
  local allow
  allow="$(response_header 'allow')"
  # server.mjs:214-218: stateless endpoint refuses GET with 405 Allow: POST, DELETE.
  if [[ "$HTTP_STATUS" == "405" && "$allow" == *POST* ]]; then
    pass "mcp GET /mcp: 405 with Allow: $allow (stateless, no SSE stream)"
  else
    warn "mcp GET /mcp: expected 405 Allow: POST, DELETE; got HTTP $HTTP_STATUS Allow: '${allow:-}'"
  fi
}
check_flux_get_405 || true

# ------------------------------------------------ 5. Authenticated probes ---
section "5. Authenticated probes"

fetch_token() { # $1=scope ("" = none) $2=token-outfile $3=label -> 0 on success
  local scope="$1" outfile="$2" label="$3"
  if [[ -z "$TOKEN_ENDPOINT" ]]; then
    # Discovery failed earlier; fall back to Keycloak's conventional layout.
    TOKEN_ENDPOINT="$ISSUER/protocol/openid-connect/token"
  fi
  printf '%s' "$CLIENT_SECRET" > "$WORKDIR/client_secret"
  local -a args=(
    --data-urlencode "grant_type=client_credentials"
    --data-urlencode "client_id=$CLIENT_ID"
    --data-urlencode "client_secret@$WORKDIR/client_secret"
  )
  [[ -n "$scope" ]] && args+=( --data-urlencode "scope=$scope" )
  local rc=0
  http_request POST "$TOKEN_ENDPOINT" "${args[@]}" || rc=$?
  if (( rc != 0 )); then fail "token request ($label): $(curl_diagnosis "$rc") ($CURL_ERR)"; return 1; fi
  if [[ "$HTTP_STATUS" != "200" ]]; then
    fail "token request ($label): HTTP $HTTP_STATUS $(jq -r '"\(.error // "?"): \(.error_description // "")"' "$RESP_BODY" 2>/dev/null || true)"
    return 1
  fi
  jq -r '.access_token // empty' "$RESP_BODY" > "$outfile"
  if [[ ! -s "$outfile" ]]; then fail "token request ($label): 200 but no access_token in response"; return 1; fi
  local aud scp
  aud="$(jwt_claim "$outfile" '.aud | if type == "array" then join(" ") else . end')"
  scp="$(jwt_claim "$outfile" '.scope')"
  pass "token acquired ($label): aud=[${aud:-?}] scope=[${scp:-?}]"
  return 0
}

# Resolve token sources. Explicit tokens (mode a) win over client_credentials.
HAVE_AUTH=0
if [[ -n "$BRIDGE_TOKEN" || -n "$TOKEN" ]]; then
  printf '%s' "${BRIDGE_TOKEN:-$TOKEN}" > "$WORKDIR/bridge.token"
  mk_auth_header_file "$(cat "$WORKDIR/bridge.token")" "$WORKDIR/bridge.hdr"
  BRIDGE_HDR="$WORKDIR/bridge.hdr"
fi
if [[ -n "$FLUX_TOKEN" || -n "$TOKEN" ]]; then
  printf '%s' "${FLUX_TOKEN:-$TOKEN}" > "$WORKDIR/flux.token"
  mk_auth_header_file "$(cat "$WORKDIR/flux.token")" "$WORKDIR/flux.hdr"
  FLUX_HDR="$WORKDIR/flux.hdr"
fi
if [[ -n "$BAD_TOKEN" ]]; then
  mk_auth_header_file "$BAD_TOKEN" "$WORKDIR/bad.hdr"
  BAD_HDR="$WORKDIR/bad.hdr"
fi

if [[ -n "$CLIENT_ID" && -n "$CLIENT_SECRET" ]]; then
  if [[ -z "$BRIDGE_HDR" ]]; then
    if fetch_token "$BRIDGE_SCOPES" "$WORKDIR/bridge.token" "bridge, scope='$BRIDGE_SCOPES'"; then
      mk_auth_header_file "$(cat "$WORKDIR/bridge.token")" "$WORKDIR/bridge.hdr"
      BRIDGE_HDR="$WORKDIR/bridge.hdr"
    fi
  fi
  if [[ -z "$FLUX_HDR" ]]; then
    if fetch_token "$FLUX_SCOPES" "$WORKDIR/flux.token" "mcp, scope='$FLUX_SCOPES'"; then
      mk_auth_header_file "$(cat "$WORKDIR/flux.token")" "$WORKDIR/flux.hdr"
      FLUX_HDR="$WORKDIR/flux.hdr"
    fi
  fi
  if [[ -z "$BAD_HDR" ]]; then
    # A scopeless client_credentials token: with the documented verify-cli
    # setup (audience mappers attached to the OPTIONAL client scopes only)
    # this token carries neither resource audience.
    if fetch_token "" "$WORKDIR/bad.token" "wrong-audience probe, no scopes"; then
      mk_auth_header_file "$(cat "$WORKDIR/bad.token")" "$WORKDIR/bad.hdr"
      BAD_HDR="$WORKDIR/bad.hdr"
    fi
  fi
fi
[[ -n "$BRIDGE_HDR" || -n "$FLUX_HDR" ]] && HAVE_AUTH=1

BRIDGE_SESSION_OK=0
check_bridge_tools_list() {
  local rc=0
  bridge_rpc "tools/list" '{}' "" "$BRIDGE_HDR" || rc=$?
  if (( rc != 0 )); then fail "bridge tools/list: $(curl_diagnosis "$rc") ($CURL_ERR)"; return 0; fi
  if [[ "$HTTP_STATUS" != "200" ]]; then
    fail "bridge tools/list: HTTP $HTTP_STATUS (www-authenticate: $(response_header 'www-authenticate'))"
    return 0
  fi
  local names count nonbrowser
  names="$(json_of_response | jq -r '[.result.tools[]?.name] | sort | join(",")')"
  count="$(json_of_response | jq -r '.result.tools | length')"
  nonbrowser="$(json_of_response | jq -r '[.result.tools[]?.name | select(startswith("browser.") | not)] | join(",")')"
  # Contract: exactly 15 browser.* tools incl. browser.extract
  # (tests/contract/mcpHttp.test.ts:23-32; packages/protocol/src/catalog.ts).
  if [[ "$count" == "15" && "$names" == *browser.extract* && -z "$nonbrowser" ]]; then
    pass "bridge tools/list: 15 browser.* tools (browser.extract present)"
    BRIDGE_SESSION_OK=1
  else
    fail "bridge tools/list: expected 15 browser.* tools, got ${count:-0} [$names]"
  fi
}

check_flux_tools_list() {
  local rc=0
  flux_rpc "tools/list" "" "$FLUX_HDR" || rc=$?
  if (( rc != 0 )); then fail "mcp tools/list: $(curl_diagnosis "$rc") ($CURL_ERR)"; return 0; fi
  if [[ "$HTTP_STATUS" != "200" ]]; then
    fail "mcp tools/list: HTTP $HTTP_STATUS error='$(jq -r '.error // empty' "$RESP_BODY" 2>/dev/null || true)'"
    return 0
  fi
  local names count scopes expected
  names="$(json_of_response | jq -r '[.result.tools[]?.name] | sort | join(",")')"
  count="$(json_of_response | jq -r '.result.tools | length')"
  # The connector advertises only what the token's scopes may invoke
  # (src/mcp.mjs:51-53, tools/index.mjs:89-93), so derive the expectation from
  # the token's scope claim when it is decodable.
  scopes="$(jwt_claim "$WORKDIR/flux.token" '.scope')"
  if [[ -n "$scopes" ]]; then
    expected="$(
      {
        [[ " $scopes " == *" dashboards:read "* ]] && printf '%s\n' get_dashboard_listing get_dashboard_summary
        [[ " $scopes " == *" office:write "* ]] && printf '%s\n' upsert_office_listings
        [[ " $scopes " == *" deals:write "* ]] && printf '%s\n' upsert_deal_listings
        [[ " $scopes " == *" jobs:write "* ]] && printf '%s\n' upsert_job_listings
        true
      } | sort | paste -sd, -
    )"
    if [[ "$names" == "$expected" ]]; then
      if [[ "$count" == "5" ]]; then
        pass "mcp tools/list: all five tools listed [$names]"
      else
        pass "mcp tools/list: lists exactly the $count tool(s) the token's scopes allow [$names]"
        note "token scope=[$scopes] — grant all of: dashboards:read office:write deals:write jobs:write to see all five"
      fi
    else
      fail "mcp tools/list: for scope=[$scopes] expected [$expected], got [$names]"
    fi
  else
    # Opaque token: cannot derive the exact expectation; require a sane subset.
    local bogus
    bogus="$(json_of_response | jq -r '[.result.tools[]?.name
      | select(IN("get_dashboard_summary","get_dashboard_listing","upsert_office_listings","upsert_deal_listings","upsert_job_listings") | not)] | join(",")')"
    if [[ "$count" -ge 1 && -z "$bogus" ]]; then
      pass "mcp tools/list: $count of the five designed tools listed [$names]"
      [[ "$count" != "5" ]] && note "listing is scope-filtered (mcp.mjs:51-53); token scopes not decodable, so exact set not asserted"
    else
      fail "mcp tools/list: got ${count:-0} tools [$names] (unexpected names: [$bogus])"
    fi
  fi
}

check_wrong_audience() {
  local rc=0
  bridge_rpc "tools/list" '{}' "" "$BAD_HDR" || rc=$?
  if (( rc == 0 )) && [[ "$HTTP_STATUS" == "401" ]]; then
    pass "bridge rejects wrong-audience token: 401"
  else
    fail "bridge wrong-audience token: expected 401, got ${HTTP_STATUS:-transport error} — audience binding is NOT enforced if 200"
  fi
  rc=0
  flux_rpc "tools/list" "" "$BAD_HDR" || rc=$?
  if (( rc == 0 )) && [[ "$HTTP_STATUS" == "401" ]]; then
    pass "mcp rejects wrong-audience token: 401 ($(jq -r '.error_description // empty' "$RESP_BODY" 2>/dev/null | head -c 80))"
  else
    fail "mcp wrong-audience token: expected 401, got ${HTTP_STATUS:-transport error} — audience binding is NOT enforced if 200"
  fi
}

if (( HAVE_AUTH )); then
  if [[ -n "$BRIDGE_HDR" ]]; then check_bridge_tools_list || true; else skip "bridge tools/list (no bridge token)"; fi
  if [[ -n "$FLUX_HDR" ]]; then check_flux_tools_list || true; else skip "mcp tools/list (no mcp token)"; fi
  if [[ -n "$BAD_HDR" ]]; then
    check_wrong_audience || true
  else
    skip "wrong-audience rejection (supply --bad-token, or --client-id/--client-secret to mint one)"
  fi
else
  skip "authenticated probes: no token source (--token, or --client-id/--client-secret)"
fi

# ------------------------------------------------- 6. Browser smoke test ----
section "6. Optional browser smoke test (--device)"

smoke_call() { # $1=tool $2=arguments-json ; on success prints structuredContent
  local tool="$1" args_json="$2" rc=0
  local params
  params="$(jq -cn --arg n "$tool" --argjson a "$args_json" '{name: $n, arguments: $a}')"
  local saved_max="$CURL_MAX_TIME"
  CURL_MAX_TIME="$SMOKE_MAX_TIME"
  bridge_rpc "tools/call" "$params" "$tool" "$BRIDGE_HDR" || rc=$?
  CURL_MAX_TIME="$saved_max"
  if (( rc != 0 )); then echo "TRANSPORT:$(curl_diagnosis "$rc") ($CURL_ERR)"; return 1; fi
  if [[ "$HTTP_STATUS" != "200" ]]; then echo "HTTP:$HTTP_STATUS"; return 1; fi
  local is_error
  is_error="$(json_of_response | jq -r '.result.isError // false')"
  if [[ "$is_error" == "true" ]]; then
    echo "TOOL_ERROR:$(json_of_response | jq -r '.result.content[0].text // "{}"' | jq -r '.error.code // "unknown"' 2>/dev/null || echo unknown)"
    return 1
  fi
  json_of_response | jq -c '.result.structuredContent // {}'
  return 0
}

run_smoke() {
  local out handle tab_id
  note "device: $DEVICE — session_open -> navigate(https://www.ebay.ca/) -> snapshot"
  if ! out="$(smoke_call "browser.session_open" "$(jq -cn --arg d "$DEVICE" '{deviceId: $d}')")"; then
    fail "smoke session_open: $out (DEVICE_OFFLINE means no agent is connected for '$DEVICE')"
    return 0
  fi
  handle="$(jq -r '.browserSessionHandle // empty' <<<"$out")"
  tab_id="$(jq -r '.tabs[0].tabId // empty' <<<"$out")"
  if [[ -z "$handle" ]]; then fail "smoke session_open: no browserSessionHandle in result"; return 0; fi
  pass "smoke session_open: session ready (status=$(jq -r '.status // "?"' <<<"$out"), ${handle:0:6}…)"
  if [[ -z "$tab_id" ]]; then fail "smoke: session has no tabs to navigate"; return 0; fi

  if ! out="$(smoke_call "browser.navigate" "$(jq -cn --arg h "$handle" --arg t "$tab_id" '{browserSessionHandle: $h, tabId: $t, url: "https://www.ebay.ca/"}')")"; then
    fail "smoke navigate: $out"
    return 0
  fi
  local final_url nav_status
  final_url="$(jq -r '.finalUrl // empty' <<<"$out")"
  nav_status="$(jq -r '.navigationStatus // empty' <<<"$out")"
  if [[ "$nav_status" == "committed" || "$nav_status" == "same_document" ]]; then
    pass "smoke navigate: $nav_status -> $final_url"
  else
    fail "smoke navigate: navigationStatus='$nav_status' finalUrl='$final_url'"
    return 0
  fi

  if ! out="$(smoke_call "browser.snapshot" "$(jq -cn --arg h "$handle" --arg t "$tab_id" '{browserSessionHandle: $h, tabId: $t}')")"; then
    fail "smoke snapshot: $out"
    return 0
  fi
  local nodes url
  nodes="$(jq -r '.snapshot | length' <<<"$out")"
  url="$(jq -r '.url // empty' <<<"$out")"
  if [[ "$nodes" -ge 1 && "$url" == *ebay* ]]; then
    pass "smoke snapshot: $nodes semantic node(s) from $url"
  else
    fail "smoke snapshot: $nodes node(s), url='$url'"
  fi
}

if [[ -z "$DEVICE" ]]; then
  skip "browser smoke test (pass --device <deviceId> when a Windows agent is online)"
elif [[ -z "$BRIDGE_HDR" ]]; then
  skip "browser smoke test (needs a bridge token with browser:interact)"
elif (( ! BRIDGE_SESSION_OK )); then
  skip "browser smoke test (bridge tools/list did not pass; fix that first)"
else
  run_smoke || true
fi

# -------------------------------------------------------------- summary ----
section "Summary"
printf 'PASS %d   FAIL %d   WARN %d   SKIP %d\n' "$PASS_COUNT" "$FAIL_COUNT" "$WARN_COUNT" "$SKIP_COUNT"
if (( FAIL_COUNT > 0 )); then
  echo "Failed checks:"
  for f in "${FAILED_CHECKS[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
echo "Lane B verification passed."
exit 0
