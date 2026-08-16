# ADR 0001 — v0.5 implementation notes and deviations

Status: **Proposed — the deviation items require explicit user approval (SDD §31)**
Date: 2026-08-13

The SDD v0.5 execution contract requires every architecture-relevant
deviation to be recorded as an ADR with explicit user approval. Items 1–4
are deviations or spec-latitude choices needing sign-off; items 5–9
document choices the SDD leaves open, recorded for auditability.

## 1. Gallery dedup: normalized URL only (no perceptual hash) — deviation

§20.4 says duplicates are collapsed "by normalized URL **and perceptual
hash** when multiple size variants refer to the same image". eBay serves
size variants under one image key (`/images/g/<key>/s-l<size>.<ext>`), so
normalized-URL dedup (`site-ebay/gallery.ts`) already collapses every
size-variant case deterministically. A perceptual hash would require
decoding image bytes in the agent (native dependency such as sharp, or a
slow pure-JS decoder) for a case eBay's URL structure does not produce.
**Recommended default:** ship URL-based dedup in MVP; add a perceptual
hash behind the same `normalizeImageUrl` hook if a real duplicate source
appears. **Alternative:** add sharp + aHash now (native builds on the
Windows agent). Migration impact: none — the dedup key is internal.

## 2. DPAPI via PowerShell `ProtectedData` — implementation choice

§11.1 requires the device private key to be DPAPI-encrypted
(CurrentUser). The agent invokes
`System.Security.Cryptography.ProtectedData` through PowerShell
(`keystore.ts`) instead of a native Node addon: same DPAPI primitive,
zero native build dependencies. Non-Windows hosts (dev/test only) use a
0600 plain file explicitly marked `plainfile-dev`.

## 3. Profile "named OS mutex" as an exclusive lock file — implementation choice

§13 requires a named OS mutex/lock before launch. Pure Node cannot create
Win32 named mutexes without a native addon; the launcher uses an
`O_EXCL` lock file inside the profile directory with pid liveness
checking (`EPERM` counts as live). Same guarantee (single owner, fail
with `PROFILE_IN_USE`), portable, crash-safe via stale-pid reclaim.

## 4. `browser.session_open` accepts the literal `"default"` device — additive convenience

The schema types `deviceId` as a plain string and an MCP client has no
tool for listing devices (§10.2 keeps admin out of the LLM surface).
When exactly one device is online, the literal `"default"` resolves to
it; otherwise resolution fails with `DEVICE_OFFLINE`. Explicit ids keep
working unchanged. Remove `registry.resolveDeviceId`'s special case to
revert.

## 5. Unmet `browser.wait` conditions raise `CONDITION_TIMEOUT`

The output schema has `satisfied: boolean`, and §17 also catalogs
`CONDITION_TIMEOUT` (retryable). The agent reports an unmet condition at
the deadline as the catalogued error (FR-12 machine-readable), keeping
`satisfied: true` for successful waits.

## 6. Low-consequence state mutations are in the deny list

§19.2 blocks watch/follow/cart in MVP alongside transactions. The
Appendix C pattern list is extended with those labels ("add to cart",
"add to watchlist", "follow this seller", checkout phrasing) and with
watchlist/cart endpoint rules. Blocked-action coverage is fixture-tested.

## 7. Wire artifacts and the reconnect state report

§12 defines the envelopes but leaves the artifact-bytes carrier and the
§12.5 reconnect report unshaped. The wire schema adds
`artifacts[].{dataBase64,transfer}` (inline ≤1 MiB per §12) and a
`state.report` control message (agent → gateway after `device.ready`)
carrying active sessions/tabs for reconciliation. Both are versioned
under wire `protocolVersion 1.0` in `packages/protocol/src/wire.ts`.

## 8. Artifact upload authorization

§16's `PUT /agent/artifacts/{requestId}/{artifactId}` is authenticated
with the §11.5 short-lived `artifactToken` (HMAC, device-bound, 15 min)
plus a pending-request check: uploads are accepted only for a request
currently in flight for that same device.

## 9. Extraction reads the live page serialization

The `ebay.ca.v1` extractor parses `page.content()` (the rendered DOM
serialized after JS) with linkedom in the agent process, while the §20.1
destination indicator is additionally re-read from the live page before
`destinationVerified` may be true. This keeps extractors pure and
fixture-testable (FR-08 "parser acceptance") with no eval inside the
page.
