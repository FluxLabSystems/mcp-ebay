# Deals-routine call budget — before/after analysis

The scheduled LEGO deal watch ran out of its per-turn tool-call budget
before reaching `dashboard_upsert`. On the 2026-08-29 run it spent ~50 calls
and wrote **nothing**. This is what was measured, what was confirmed, what
was rejected, and what could not be established from a dev box.

Reproduce with `pnpm build && node tools/measure/ledger.ts` (before) and
`node tools/measure/after.ts` (after). Captures are
`tools/measure/baseline-ledger.json` and `tools/measure/after-ledger.json`.

## How to read a number

Every figure carries a **basis**, and they are not interchangeable:

| basis | means |
| --- | --- |
| `measured` | real code, real checked-in input, on this box |
| `modelled` | real code, input constructed here; construction parameters reported so it can be rescaled |
| `derived` | follows from the tool catalog, not from a stopwatch |
| `reported` | the operator's 2026-08-29 run — never measured here, never mixed into a measured row |
| `unmeasurable` | needs something this box does not have; carries a reason instead of a number |

**`www.ebay.ca` answers this box with HTTP 403** (bot wall); `www.kijiji.ca`
answers 200. Both are probed at capture time and recorded. No eBay figure
here comes off a live page, and no eBay extractor fix is verified against
one.

## The ledger

Same tree, same Node, same fixtures. The before side is produced by
*running* the before harness in a subprocess, not retyped.

| phase | calls | → | bytes | → | Δ bytes |
|---|---|---|---|---|---|
| Preamble (feed + session_open) | 2 | 2 | 41,348 | 3,683 | **−91.1%** |
| One eBay search page | 2 | 1 | 159,652 | 10,594 | **−93.4%** |
| 17 canonical item pages | 34 | 2 | 26,934 | 13,941 | −48.2% |
| `dashboard_upsert` | 1 | 1 | 3,341 | 3,341 | 0% |
| **total** | **39** | **6** | **231,275** | **31,559** | **−86.4%** |

Calls are `derived` from the catalog constants (`MAX_INLINE_BATCH_ITEMS`=2,
`EXTRACT_MANY_MAX_URLS`=25, `DEFAULT_SEARCH_COMPACTION.limit`=40), read out
of the *built* protocol package. Bytes are read back out of the telemetry
NDJSON the harness writes. Seconds are extractor/compactor CPU on this box
only and are noise below ~10 ms.

Calls per canonical item: **2.000 → 0.118** (target was ≤ 0.2), at the
one-poll floor.

The operator's reported run — 5 / 8 / 37 / 0 calls, a 160 KB search page,
zero writes — is carried in its own table in both captures and is never
merged into a measured row or diffed against.

### The 160 KB claim

| what | bytes | basis |
|---|---|---|
| checked-in fixture (2 candidates) | 670 | measured |
| that fixture scaled linearly to 240 rows | 78,500 | arithmetic, and **wrong** — the fixture has no tracking params |
| 240-row page modelled on live href shape (mean href 373 chars) | 128,800 | modelled |
| same page, hrefs cut to `/itm/<id>` | 49,800 | modelled — **61.3% smaller** |
| the live run | 163,840 | **reported, not measured** |

The model lands at 0.81× the reported figure, and 0.97× once the enriched
candidate fields landed. So 160 KB is *consistent* with 240 tracked hrefs —
but it was never captured here, and the harness never says otherwise.

## Root causes: confirmed vs rejected

All five were **confirmed**, each against a line that was read, not assumed.

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | No composite/batch tools; the LLM is the loop | **CONFIRMED** | 15 single-page tools in `catalog.ts`; `browser_extract` took no URL list, no limit, no offset. N pages cost 2N calls. |
| 2 | Search extracts oversized | **CONFIRMED** | `site-ebay/src/traversal.ts` stored the absolutized href verbatim, `_skw`/`itmmeta`/`hash`/`itmprp` intact; the candidate array was returned uncapped. 61.3% of the payload was query string the traversal then discarded — it only ever navigates to `/itm/<id>`. |
| 3 | Extractor defects force fallback calls | **CONFIRMED** | `site-ebay/src/extract.ts` scanned only `body.textContent.slice(0, 2000)` — nav chrome on a real page — then **failed open** to `'active'` when a title and price existed. An ended listing has both. |
| 4 | `dashboard_feed` defaults to `full`, no `active` filter | **CONFIRMED** | `tools.ts` `mode: …default('full')`; the client fetched the whole feed with no filter parameter. 40.1 KB where 7.7 KB would do. |
| 5 | No resumability | **CONFIRMED** | No run entity in the gateway `Store`; `AuditStore` is **insert-only with no read path**, so even the audit trail could not answer "what did this run already verify". |

### Sub-claims that were wrong

Two specifics in the brief did not survive contact with the evidence, and
the fixes follow the evidence instead:

- **Kijiji `listingStatus: "deleted"` did not reproduce.** Against live
  server HTML all four repro ads returned `unknown` — equally wrong, a
  different cause (selector rot: the price selector led with a *search-card*
  testid, and the live-ad selectors named nodes a Kijiji VIP does not have).
  If the Chrome run genuinely saw `deleted`, the trigger is in the hydrated
  DOM, which cannot be observed from here. The fix closes both paths.
- **The "Please Contact" ad was not losing its price to a missing `offers`
  path.** For a non-amount price Kijiji serves an *entirely empty*
  `ld+json` script — no Product node at all — so description and `postedAt`
  were never in JSON-LD to begin with.

### Found beyond the brief

- **eBay carousel rows vanished entirely.** The candidate scan took the
  first selector that matched anything and stopped, so on a page mixing
  carousel and legacy templates the carousel rows were dropped from the
  list — silent inventory loss, not the reported null titles.
- **Kijiji `sellerName` stored `"View Jessica's profile"`** — the profile
  anchor's `aria-label` read verbatim.
- **Kijiji `sellerType` was always `unknown`**, derived from an attribute
  list a VIP never populates, while the page rendered `Owner` a few nodes
  away.

## What is *not* established

Eleven quantities are recorded as `null` with a reason rather than guessed.
The load-bearing ones:

- **`client.inline_response_limit`** — the chat client's spill-to-file
  threshold lives in the client; nothing here observes it. Consequently
  **the reported run's 5 shell parse calls are not counted as saved
  anywhere**, even though the compacted response is ~13× smaller.
- **`call.wall_time.end_to_end`** — no Chrome, no paired Windows agent.
  Every second in the ledger is extractor CPU on this box.
- **`batch.job_poll_count`** — real polls are job wall-clock ÷ caller
  cadence; neither exists here. The ledger charges the structural floor of
  one poll and prints a sensitivity table at 1/2/4/8 polls.
- **`after.recovery_calls`** — per-URL error slots are meant to remove the
  3 recovery snapshots the reported run spent. Every fixture succeeds, so
  the saving is described and never counted.
- **`live.ebay.search.bytes`** — HTTP 403.

## Where the after story is weaker than it looks

- **The 2-call item phase assumes one poll landing after the job finished.**
  A promoted batch returns `results: []` immediately, so ≥1 `job_status` is
  structural. At 1/2/4/8 polls the total is 6/7/9/13 calls.
- **`MAX_INLINE_BATCH_ITEMS` is 2**, so *every* real traversal promotes to a
  job — the extra poll is the common case, not an edge case. The threshold
  charges each item a `SNAPSHOT_TIMEOUT_MS` ceiling; a measured per-item
  cost would raise it and delete the poll.
- **The search call returns 40 of 240 rows** — a smaller *answer*, not only
  a smaller payload. All 240 in one call is 59,769 bytes (−62.5%); paging to
  240 at the default window costs **6 calls**, more than the before
  surface's 2.
- **On a small page, compaction adds bytes** (eBay fixture 898 → 963) — the
  fixed envelope only pays off on a long page.
- **Most of the preamble win predates this work**: `mode:"ids"` alone is
  −80.8%; `filter{active}` + `fields` add −57.8% on top, and only the second
  figure belongs to Phase 2.
- **Agent CPU rises.** Bytes are traded for compactor work on the machine
  that owns the browser, and only one side of that trade was measured.

## Could not fix, and why

- **eBay ended-vs-sold on the interstitial.** Detection returns `'ended'`.
  If `198589141532`, `800523282681` or `206468265940` actually *sold* and
  renders its sold text outside the status selectors, it reports `ended`
  rather than `sold`. Far better than `active`; not exact. Only a real
  capture closes this.
- **eBay `endsAt` when the page states no end time.** `endsAt` and
  `timeLeftText` are both `null` rather than invented. Which of
  `366630546269` / `227489965462` carry a machine-readable end time could
  not be confirmed — ebay.ca is 403 here.
- **Kijiji `postedText` on search candidates is not live-verified.** Kijiji
  hydrates the card's posted time client-side, so no server fetch can show
  it; the element shape is reconstructed and marked synthetic. `postedAt`
  *is* live-verified, from the date the page states.
- **Kijiji `attributes` is `[]` on both live ads**, so `sellerType` falls
  back to the about-seller block. This is **not** recorded as a defect: the
  `Condition` strings on those pages belong to the inline i18n bundle, not
  to rendered markup, so there is no attribute list to read and no way to
  tell from these captures whether an ad that has one parses.
- **French Kijiji relative-time wording** is carried defensively and marked
  `NEEDS-LIVE-VERIFICATION`; the French request returned the en_CA bundle.
- **`deals.routine_run` was deliberately not built.** It needs a diff engine
  against the deals dashboard's v3 record semantics, which this repo only
  guarantees as `{ id }`. Inventing those semantics to emit a "proposed
  upsert" would reimplement the deals skill's judgment in the wrong place,
  and a proposal with wrong field semantics is worse than no proposal.

## Ids that may still misbehave

`198589141532`, `800523282681`, `206468265940` (ended-vs-sold precision) ·
`366630546269`, `227489965462` (auction end time, if the page states none) ·
any Kijiji search candidate's `postedText` (hydration) · a Kijiji ad in
French (relative-time wording).

Report defects with ids — a defect without one usually cannot be
reproduced, because ebay.ca refuses this box and only a real browser
session can capture the page.
