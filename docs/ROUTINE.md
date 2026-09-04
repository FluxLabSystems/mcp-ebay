# Deals routine — run plan and call budget

The scheduled LEGO deal watch runs through this bridge from a chat client
with a **per-turn tool-call budget**. Before the batch tools existed, a run
spent ~50 calls walking pages one at a time and hit the limit *before* its
first `dashboard_upsert` — so a full turn of research was discarded. This
document is the run plan that stops that happening. It is normative for the
`fluxology-deals-run` skill; where it and an older ported task spec
disagree about *how many calls to spend*, this wins.

The rule that matters most is at the bottom of this section, so it is also
at the top:

> **Write after every batch. Never hold results for a final upsert.**
> A run that dies at the budget limit having written twice is a good run.
> A run that dies holding twenty verified records has produced nothing.

## The budget

Target: a full routine — two search passes, ~20 canonical items, diff,
upsert — in **≤ 12 tool calls**, with the **first write by call ~8**.
Amortized cost per canonical item: **≤ 0.2 calls** (batches of ≥ 10).

| # | Call | Purpose |
|---|---|---|
| 1 | `dashboard_feed` `{dashboard:"deals", mode:"ids", filter:{active:true}}` | The diff set. `ids` + `active` is ~7.7 KB where the default `full` is ~40 KB. |
| 2 | `browser_session_open` | |
| 3 | `browser_open_and_extract` — eBay search, with `search.include` | One call, not `navigate`+`extract`. Server-side filter. |
| 4 | `browser_open_and_extract` — second eBay pass or Kijiji search | |
| 5 | `browser_extract_many` — the shortlist + re-validation ids | Up to 25 URLs. Returns a `jobId` above 2 items. |
| 6–7 | `browser_job_status` (`sinceIndex` to read incrementally) | Poll until `status` is `completed`. |
| **8** | **`dashboard_upsert`** | **Write now.** New + materially changed records. |
| 9 | `browser_extract_many` — Kijiji ad batch | |
| 10 | `browser_job_status` | |
| 11 | `dashboard_upsert` | Second write. |
| 12 | `dashboard_upsert` `{touch:[…]}` | lastSeen-only refresh for unchanged re-observations; fold into 11 when it fits. |

If the budget is going to end early, drop calls from the *bottom*. Never
drop the write.

Two calls sit outside that table because they pay for themselves. Open with
**`deals_run_resume`** when a previous turn may have been cut off: if it
returns `pendingIds`, calls 3–4 are already spent and you go straight to
the batch. Fold **`deals_run_checkpoint`** into the same moment as each
`dashboard_upsert` — one extra call that turns a truncated run into a
resumable one. On a clean run with nothing to resume, skip both and the
plan above stands at 12.

## The budget with the eBay API tools

**Role first (2026-09-03).** The gateway runs the Countdown source as a
**secondary pathway** by default (`COUNTDOWN_ROLE=secondary`, the
operator's standing instruction until they say otherwise): the Browser
Bridge table above is the plan for every fire, and an `ebay_api_search`,
`ebay_api_items` or `ebay_api_seller` call is admitted only when it
declares `fallbackReason` — `device_offline`, `bridge_unreachable`,
`challenge_blocked`, `extractor_gap` or `operator_request`, with the detail
in `fallbackNote` — naming why the Bridge could not do that step. An
undeclared call is refused with `SOURCE_REJECTED` (`details.reason`
`secondary_role`) at no cost, and the answer is the Bridge. `ebay_api_status`
reports `role.name`; read it once, free, and treat the table below as the
plan only when it says `primary`. Under `secondary` the table is what a
declared fallback follows for the steps the Bridge genuinely could not do,
and `gate.spendable` is that fallback's ceiling, never the fire's budget.

When the gateway serves `ebay_api_search`, `ebay_api_items`,
`ebay_api_seller` and `ebay_api_status` — they exist only while
`COUNTDOWN_API_KEY` is set and `COUNTDOWN_ROLE` is not `off`, so probe for
them; an unloaded schema is not absence — and runs them as `primary`,
Track A's sweeps and its first validation pass leave the browser
entirely. The table above stays the plan for a run without them and for
Kijiji. Target: **first write by call 6**, with the browser session opened
only for the shipping pass. Every API call answers within 50 s (the client
allows 60) or names what to re-request.

| # | Call | Purpose |
|---|---|---|
| 0 | `ebay_api_status` | **Free; not in the count.** Read the budget before asking for a credit: `gate.spendable` is what the reserve gate will admit this fire (`credits.remaining` minus the reserve it holds back), and `gate.open:false` names why nothing will be admitted — `below_reserve`, `reserve_not_below_plan_limit`, `account_suspended` — so a shut gate costs one free call, not a zero-coverage fire. Plan calls 2–5 against `gate.spendable`. |
| 1 | `dashboard_feed` `{dashboard:"deals", mode:"ids", filter:{active:true}}` | The diff set, as above. |
| 2–3 | `ebay_api_search` — broad sweeps, one call per domain, with `search.include` | Up to 240 rows a page and `maxPage` up to 5 in one call: no scan window, no challenge page. `listingType:"all"` is **two vendor requests** (`buy_it_now` and `auction`, merged by item id) but **one tool call**; an unfiltered vendor search is never issued. |
| 4 | `ebay_api_search` — watched-seller sweeps | The roster's `_ssn=` search URLs pass through the `url` argument, `_sop=10&_ipg=240` and all; a second call when the roster spans both domains. Two to four searches in all. |
| 5 | `ebay_api_items` — the shortlist + re-validation ids | Up to 25 items, inline, no job to poll. A slot with `ok:true` is a current canonical fetch: id, title, availability, and price on a fixed-price row. **Auction slots return no price** — identity and availability only. |
| **6** | **`dashboard_upsert`** | **Write now.** Fixed-price finds and re-validations from call 5; everything stays `shippingResolved:false`. |
| 7 | `browser_session_open` | Only now. |
| 8 | `browser_extract_many` — the shortlist that needs a landed figure, plus **every auction** | The shipping pass: M6H 2W9-resolved shipping, bids, end times, max-bid math. |
| 9 | `browser_job_status` | Poll until `completed`. |
| 10 | `dashboard_upsert` | Second write: landed figures and auction fields, `shippingResolved:true` only where the page proved the number. |
| 11 | `ebay_api_items` — re-validation overflow, or the Kijiji batch | A second item call when the active eBay set is over 25. |
| 12 | `dashboard_upsert` (+ `{touch:[…]}`) | Third write; lastSeen refresh folded in. |

`ebay_api_seller` — the `/usr/<loginId>` confirmation for the login-id
rules — costs one credit and fits wherever a roster entry needs it; it is
not in the count. When a call answers `SOURCE_UNAVAILABLE`,
`SOURCE_CREDITS_EXHAUSTED` or `SOURCE_REJECTED`, that step falls back to the
Bridge path in the table above and the completion report says so.

What the API never provides, so no call above waits for it:

- **Postal-code shipping.** The vendor rejects a zip on item requests and
  resolves item pages to its own U.S. zip, so every API item carries
  `DESTINATION_UNVERIFIED`. A search row's `shippingCost` under
  `destination:"toronto"` is eBay's card-level estimate for M6H 2W9 — use it
  for triage and a provisional max bid, never as the resolved figure; `null`
  means the card showed nothing readable, not free shipping.
- **Auction bids and end times.** Search rows carry no bid count and item
  pages report live auctions as fixed price. Every bid, `endsAt` and
  `timeLeftText` comes from the Bridge item page (call 8).
- **Sold comps.** `sold_items` / `completed_items` are refused by the vendor
  (eBay requires a signed-in session for them).
- **Kijiji.** eBay only; Track B runs exactly as in the table above.

Every API response carries `credits {used, remaining, usedThisRequest}`:
`usedThisRequest` is what that call spent, `used` is the account's
month-to-date total (not the call's spend), and the last `credits.remaining`
of the run goes into the completion report next to the call count. Plan the
fire against `ebay_api_status`'s `gate.spendable`, never against `remaining`
alone: the gate holds back `COUNTDOWN_CREDIT_RESERVE` (5% of the plan's
credit limit by default) and refuses search and item calls below it, and it
reads the account before the first charged call of a process, so nothing is
spent on an unknown balance. A search the vendor has not answered inside the
50 s deadline fails with `SOURCE_UNAVAILABLE` and `details.possiblyCharged`;
an item batch returns the slots it has with a `BATCH_TRUNCATED_BY_DEADLINE`
warning naming the ids to re-request (`requested:false` slots were never
charged). A `SOURCE_REJECTED` whose `details.reason` is `account_suspended`
means the vendor suspended the account: no top-up helps, every API call is
refused for five minutes, so report it and take the Bridge path.

## Why each call is one call

- **`browser_open_and_extract`** navigates and extracts in one call. On a
  search or store page an omitted `search` argument means *compact with the
  defaults* — canonical `/itm/<id>` URLs with the `_skw`, `itmmeta`, `hash`
  and `itmprp` tracking params stripped, plus a bounded window. A 240-row
  page measures **186,477 bytes raw against 12,890 compact**. The raw form
  exceeded the client's inline limit, spilled to a file, and then cost five
  shell calls to read back; the compact form does not.
- **`search.include`** filters server-side: `{titleRegex, minPrice,
  maxPrice, formats}`. The ~200 rows that do not matter never enter
  context. Rows dropped for *lacking* the filtered field are counted in
  `warnings` (`EXCLUDED_NO_PRICE`, `EXCLUDED_UNKNOWN_FORMAT`) — read those
  counts before concluding a marketplace had nothing. `titleRegex` is
  already matched case-insensitively; write plain patterns without inline
  flags — JS regex has no `(?i)`, so it is rejected as an invalid group.
- **`search.fields`** resolves both profiles' spellings: asking for
  `price`, `format` or `location` returns eBay's `snippetPrice`,
  `sellingFormat` and `itemLocationText` under the name you asked for, so
  one field list serves eBay and Kijiji pages alike.
- **The candidate scan ceiling is 1000 rows per page** (240 until
  2026-09-04, when a 328-row watch-list render proved the slice ran before
  `search.offset` and `search.include`, leaving the last 88 rows unreachable
  through any argument of the call). A page that renders more than the
  ceiling says so with `CANDIDATES_TRUNCATED`, and `search.offset` pages
  only through the matched set *inside* the scanned rows — it cannot reach
  a row past the ceiling. For a deeper scan, narrow the query or follow the
  marketplace's own pagination (Kijiji's `nextPageUrl`; eBay's
  `_pgn`/`_ipg` URL parameters), which loads a fresh page with a fresh
  window.
- **`browser_extract_many`** traverses up to 25 URLs per call with a
  per-URL error slot. One dead listing is one error, not a failed batch.
  A page that loads but is not a listing — an eBay error/removed-item
  page, a deleted Kijiji ad — is `ok:false` with `error.code
  LISTING_UNAVAILABLE` and keeps its record as evidence: retire the stored
  id it was meant to re-validate, and never upsert a slot that is not
  `ok`. Batches above 2 items promote to a job; polling costs 1–2 calls,
  not one per page.
- **There is no `browser.batch`.** Multi-tool batching does not exist on
  the bridge; the batch surface is `browser_open_and_extract` (navigate +
  extract, one call) and `browser_extract_many` + `browser_job_status`.
- **Candidates now carry `sellingFormat` and `bidCount`**, so a row no
  longer has to be opened just to learn whether it is an auction. Open only
  what the shortlist justifies. `sellingFormat: "unknown"` is a real
  answer — a card that states no format is genuinely ambiguous, and reading
  silence as fixed price would price a live bid as purchasable.

## When the budget ends anyway

Writing early means a truncated run still produced something. Checkpointing
means the *next* turn does not start from zero.

- **`deals_run_checkpoint(runId, {searched, verifiedIds, pendingIds, notes})`**
  — fold it into the same moment as each upsert. `searched` and
  `verifiedIds` union with what is stored; `pendingIds` replaces. Omitted
  fields are left alone, which is what makes a mid-turn checkpoint cheap
  enough to be worth writing.
- **`deals_run_resume()`** — call it *before* searching. With no `runId` it
  returns the most recent resumable run for this caller. If it comes back
  with `verifiedIds`, those items are already done: extract the
  `pendingIds` and skip the search that produced them.
- A run is resumable while its `status` is `running` and it was
  checkpointed within **12 hours**. That window is deliberately shorter
  than a day: a daily routine must never resume across two scheduled fires,
  because replaying yesterday's prices as today's evidence is worse than
  re-searching.
- A checkpoint holds **ids and counts**, never page content, and is capped
  at 16 KiB. Over the cap the oldest ids are trimmed and the trim is
  reported in `warnings` — losing the oldest ids costs less than losing the
  whole checkpoint, but it is never silent.

Naming a `runId` that exists but is finished returns `found: true,
resumable: false`, so "already completed" is distinguishable from "never
existed". Do not re-run a completed run's searches on the strength of an
empty resume.

## Coverage audits under a call budget

The skill requires exact coverage counts — records inspected, per seller,
per radius — and "potentially hundreds per track". That is **not** in
tension with ≤12 calls: server-side filtering still *inspects* every row and
reports what it saw and what it dropped. Take audit counts from the
extraction response's own totals (`candidateCount`, `totalResults`, the
`warnings` exclusion counts), not from rows the model personally read.
Reporting "240 inspected, 18 shortlisted" from those fields is accurate.
Inventing a number because the rows were not in context is not.

## Valuation

- Current target: **C$10/lb landed**. On an auction, **max bid = target −
  shipping**, using destination-resolved shipping only.
- `closeInspectionTriggerCadPerLb` is **7** in
  `data/deals/search-profiles.json` (`fluxlab-boards` repo root; ported
  there from `fluxology-site` with the boards) — that file and
  `multi-path-shipping-policy.json` beside it are authoritative for routing
  and qualification; the figures here are the run-level summary, not a
  replacement.
- **Toronto destination caveat.** Shipping is only destination-verified
  when the page actually shows **M6H 2W9**. The extraction record carries
  `shipping.destinationVerified` and a `DESTINATION_UNVERIFIED` warning —
  honour them. Never substitute a U.S.-destination quote for a Toronto one,
  and keep `shippingResolved` false until a destination-resolved page
  proves the number used.
- eBay auctions now expose `endsAt` / `timeLeftText` where the page states
  them. Both are `null` when the page states neither: that is "unknown",
  not "no deadline".

## Report extractor defects, with ids

Extractor defects are why the routine burned calls on recovery snapshots.
When a record looks wrong, say so in the run report **with the exact item
or ad id**, so it can be turned into a fixture and a regression test:

- an eBay item whose `listingStatus` disagrees with the page
- an auction with no `endsAt` *and* no `timeLeftText`
- a Kijiji ad reporting `deleted`/`unknown` while plainly live
- a search page whose `candidateCount` is far below its stated total
- any field that is `null` on every row of a page

One near-miss to know before reporting it: an old Kijiji `postedAt`
beside a null `postedText` is usually not a defect. With no rendered
relative time to parse, `postedAt` is the activation date the page itself
states, and that is the ad's *original* posting date — a reposted or
bumped ad keeps it.

Ids matter because `www.ebay.ca` refuses automated fetches from the dev box
(HTTP 403), so a fix can only be pinned against a page someone captured
from a real browser session. A defect reported without an id usually cannot
be reproduced.

## Hard limits

Read-only research. Never bid, buy, make an offer, message a seller, or
mutate a cart or watchlist — the agent's local policy blocks those controls
and nothing in the run plan needs them. Credentials never appear in task
text or output; the gateway holds them.

## Degraded runs

If the bridge is not attached or no device is online, do not fabricate.
Report exactly which capability was missing, complete whatever does not need
it, and still emit the full completion report. The NO-SILENCE rule applies
to failures too.
