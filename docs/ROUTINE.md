# Deals routine — run plan and call budget

The scheduled LEGO deal watch runs through this bridge from a chat client
with a **per-turn tool-call budget**. Before the batch tools existed, a run
spent ~50 calls walking pages one at a time and hit the limit *before* its
first `dashboard.upsert` — so a full turn of research was discarded. This
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
| 1 | `dashboard.feed` `{dashboard:"deals", mode:"ids", filter:{active:true}}` | The diff set. `ids` + `active` is ~7.7 KB where the default `full` is ~40 KB. |
| 2 | `browser.session_open` | |
| 3 | `browser.open_and_extract` — eBay search, with `search.include` | One call, not `navigate`+`extract`. Server-side filter. |
| 4 | `browser.open_and_extract` — second eBay pass or Kijiji search | |
| 5 | `browser.extract_many` — the shortlist + re-validation ids | Up to 25 URLs. Returns a `jobId` above 2 items. |
| 6–7 | `browser.job_status` (`sinceIndex` to read incrementally) | Poll until `status` is `completed`. |
| **8** | **`dashboard.upsert`** | **Write now.** New + materially changed records. |
| 9 | `browser.extract_many` — Kijiji ad batch | |
| 10 | `browser.job_status` | |
| 11 | `dashboard.upsert` | Second write. |
| 12 | `dashboard.upsert` `{touch:[…]}` | lastSeen-only refresh for unchanged re-observations; fold into 11 when it fits. |

If the budget is going to end early, drop calls from the *bottom*. Never
drop the write.

Two calls sit outside that table because they pay for themselves. Open with
**`deals.run_resume`** when a previous turn may have been cut off: if it
returns `pendingIds`, calls 3–4 are already spent and you go straight to
the batch. Fold **`deals.run_checkpoint`** into the same moment as each
`dashboard.upsert` — one extra call that turns a truncated run into a
resumable one. On a clean run with nothing to resume, skip both and the
plan above stands at 12.

## Why each call is one call

- **`browser.open_and_extract`** navigates and extracts in one call. On a
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
  counts before concluding a marketplace had nothing.
- **`browser.extract_many`** traverses up to 25 URLs per call with a
  per-URL error slot. One dead listing is one error, not a failed batch.
  Batches above 2 items promote to a job; polling costs 1–2 calls, not one
  per page.
- **Candidates now carry `sellingFormat` and `bidCount`**, so a row no
  longer has to be opened just to learn whether it is an auction. Open only
  what the shortlist justifies. `sellingFormat: "unknown"` is a real
  answer — a card that states no format is genuinely ambiguous, and reading
  silence as fixed price would price a live bid as purchasable.

## When the budget ends anyway

Writing early means a truncated run still produced something. Checkpointing
means the *next* turn does not start from zero.

- **`deals.run_checkpoint(runId, {searched, verifiedIds, pendingIds, notes})`**
  — fold it into the same moment as each upsert. `searched` and
  `verifiedIds` union with what is stored; `pendingIds` replaces. Omitted
  fields are left alone, which is what makes a mid-turn checkpoint cheap
  enough to be worth writing.
- **`deals.run_resume()`** — call it *before* searching. With no `runId` it
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
  `data/deals/search-profiles.json` (fluxology-site) — that file and
  `multi-path-shipping-policy.json` are authoritative for routing and
  qualification; the figures here are the run-level summary, not a
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
