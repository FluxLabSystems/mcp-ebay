# ADR 0003 — Countdown API as a gateway-served eBay data source

Status: Proposed
Date: 2026-09-02

The deals routine's Track A (eBay) has two recurring failure modes that no
extractor fix reaches: eBay's bot wall (`/splashui/challenge` on `_ssn=`
seller searches, HTTP 403 from any dev box) and the per-turn tool-call
budget, most of which page-by-page traversal through the paired Chrome
spends before the first write. This ADR records the decision to add
Countdown API (Traject Data's eBay scraping API,
`https://api.countdownapi.com/request`) as a second, gateway-served data
source for that track, the constraints the vendor was measured to impose
and what each one forces, the alternative not taken, how to roll back, and
what it costs. The execution plan is `docs/COUNTDOWN-API-PLAN.md`; the
measurements behind every constraint below are checked in under
`tests/fixtures/countdown/`.

## 1. Decision

Three tools — `ebay_api_search`, `ebay_api_items`, `ebay_api_seller` — are
served by the gateway itself, exactly like `dashboard_feed` and
`deals_run_resume`: no device on the path, the vendor key only in the
gateway environment (`COUNTDOWN_API_KEY`), and no new connector grant for
the routine. They take over discovery sweeps, watched-seller drill-downs,
login-id verification and cheap re-validation of stored eBay records. One
request returns up to five pages of 240 structured rows with no DOM scan
window and no challenge page, and the vendor absorbs anti-bot and layout
drift. The vendor's `seller_profile` request type also sidesteps outright
the open, blocking improvement report
`usr-profile-page-dispatched-as-item-page` (the DOM extractor dispatching a
`/usr/` profile page as an item page); that defect stays open as an
optional extractor fix instead of blocking the routine.

The Browser Bridge keeps the two jobs the API cannot do: destination-resolved
shipping to M6H 2W9 on item pages, and anything needing a signed-in eBay
session. Nothing surfaced with a landed figure goes `active` without a Bridge
pass. The source is a pure client package (`packages/source-countdown`) that
maps vendor rows onto the Bridge's own `ListingCandidate` and
`ExtractionRecord` shapes (`siteProfile: 'ebay.api.v1'`) and runs the same
compaction function as the agent (`packages/compact`), so the skill's audit
and filter rules apply to both sources unchanged.

## 2. Scope: `browser:read`, not a new realm scope

All three tools require `browser:read` (`SCOPE_READ`), the scope that already
gates `browser_extract`. They are marketplace reads of the same sensitivity,
they are not browser actions, and reusing the scope avoids a Keycloak realm
change and a re-consent of the routine's connector. A dashboard-style
per-source scope was considered and rejected: the dashboards' scopes exist
because their tools write; these do not.

## 3. Constraints the vendor imposes, as measured, and what each forces

- **`customer_zipcode` is rejected on item requests, and item pages resolve
  to the vendor's own zip.** `type=product` answers 400 to any
  `customer_zipcode` (re-verified in the `url` and `epid` forms with both
  zips; the vendor's playground drops the field when Type is Product), and
  the raw HTML behind a keyed capture reads "Estimated between … to 91722",
  the vendor's California zip, whatever `customer_location` says. An
  item-page shipping figure from this source is therefore not even a
  country-level Canadian figure. Forced: every `ebay_api_items` slot carries
  `DESTINATION_UNVERIFIED`, its record has `destinationVerified: false` and
  no destination postal code, the figure is kept as observed text plus the
  service name, and a landed figure exists only after the Bridge pass on the
  shortlist. Searches do accept the zip (it reaches eBay as `_stpos`), so a
  search row's `shipping_cost` under `destination: 'toronto'` is eBay's own
  card-level estimate for M6H 2W9 — enough for triage and a provisional max
  bid, never for `shippingResolved: true`. Destinations are named
  (`toronto`, `forwarder`, `domain_default`) and resolved in the gateway to
  the two configured zips, never free text, which also keeps the account
  under its distinct-zip cap; the postal code is sent uppercase with no
  space because the vendor forwards it unnormalised.
- **Sold and completed listings are unsupported.** `completed_items` and
  `sold_items` are refused with "eBay now requires a signed-in session".
  Forced: no comps from this source, and none promised; a comp, if the
  routine ever needs one, is signed-in Bridge work.
- **Auctions are invisible outside an auction-filtered search and misreported
  on item pages.** On an unfiltered search `is_auction` was false on every
  row, including the thirty that the `listing_type=auction` twin proved were
  live auctions, so a `C $1.00` current bid there is indistinguishable from a
  purchasable price; and a live ebay.ca auction came back from `type=product`
  as `is_auction: false` with no `auction` block and `offer.price 19.99 CAD`
  while its search row showed a `C $37.54` current bid. Forced: the gateway
  never issues an unfiltered search — `listingType: 'all'` is two vendor
  requests (`buy_it_now` and `auction`) merged by item id, and a row's format
  comes only from the filter it was retrieved under; `ebay_api_items` takes
  `expectedFormat` from the caller, ignores the item page's flag, and returns
  an auction slot with `itemPrice`, `endsAt` and `timeLeftText` null under
  `AUCTION_DETAIL_UNAVAILABLE_FROM_SOURCE`. Every bid, end time and max-bid
  figure comes from the Bridge item page.
- **Price-range rows are damaged.** A multi-variant listing (LEGO lots sold
  in 10/25/50/100-piece tiers are exactly this shape) renders a price range;
  the vendor's title for it ends in a stray ` to`, and its `prices` are a
  two-entry range or missing entirely — 159 of 480 ebay.ca rows over two
  pages had no price at all. Forced: the mapper strips the marker, sets
  `priceRange: true`, keeps the row with `snippetPrice: null` and counts it
  in `PRICE_RANGE_UNPARSED`; the skill opens such rows before any price-based
  exclusion, because a price-less row is a variant listing, never "no price".

Smaller findings that shaped the mappers rather than the design: `epid` on a
search row is sometimes an eBay product id (the item id is always taken from
`link`); rows carry no `currency` field (parsed from the raw string, the
domain as fallback); `sponsored` was false on all 540 measured rows; an
absent `shipping_cost` means unknown, never free; and the vendor's uncharged
transient 500 cleared on retry every time it was seen, so the client retries
twice before reporting `SOURCE_UNAVAILABLE`.

## 4. Alternative considered: eBay's Browse API

eBay's official Browse API was the other candidate. It is free within its
call limits, its item summaries are destination-aware through the
contextual-location header (which would remove the first constraint above
for summaries), and they carry bid counts and current bids the scraping
source lacks. It was not chosen now because it needs an eBay developer
application with its own key and OAuth token lifecycle to manage and a
compliance review before production volumes, none of which the Countdown
path requires beyond a key and a plan; the operator chose Countdown. It
remains a legitimate future source: the seam is the source-package boundary
(vendor rows in, `ListingCandidate` / `ExtractionRecord` out), and a Browse
API package would register the same tool contracts behind it.

## 5. Rollback

Unset or blank `COUNTDOWN_API_KEY` and redeploy. `config.countdown` is then
`null`, the three tools are not registered, and the skill's tool probe finds
them absent and takes the Bridge path it already has, reporting the fallback
in its completion report. Nothing else needs undoing: the scope is
unchanged, the record-schema additions are nullable fields behind an
additive `siteProfile` value, and the dashboard schema was never touched.
The same fallback applies at run time when a call answers a `SOURCE_*`
error.

## 6. Cost

Starter plan, $66 for 10,000 requests a month. Because `listingType: 'all'`
is two vendor requests, the split sweeps dominate: ten broad queries × two
domains × two requests, one request per watched seller per domain, and 30
to 60 item pages for the shortlist and re-validation — roughly 120 to 150
requests a fire, 7,000 to 9,000 a month at two fires a day (plan §11,
modelled, not yet measured). Guardrails: the credit reserve gate
(`COUNTDOWN_CREDIT_RESERVE`, default 500), `maxPage ≤ 5` and 25 items per
batch in the schemas, and a credits line in every completion report.
Sweeping watched sellers once a day instead of every fire saves about 1,400
requests a month if the cap is ever in reach.

Non-goals, recorded to bound the surface: the Bridge is not replaced; Kijiji
(Track B) is untouched; no comps; no gateway cache (the run checkpoint
already records what was searched); the vendor's Collections batch runner
only if a supervised fire shows wall-clock or credit pressure; and no change
to the deals dashboard schema.

## Addendum 2026-09-03 — plan-relative reserve, the status tool, and the client's 60 s

The first fire on this source (2026-09-03T07:13Z) had zero coverage: the
reserve gate refused every search and item call, because
`COUNTDOWN_CREDIT_RESERVE` defaulted to 500 while the account was the
vendor's one-time 100-request free trial with 83 credits left. The routine
also read `credits.used` (the account's month-to-date total) as the cost of
one seller lookup, and had no way to learn the budget before planning
instead of from a refusal. Three decisions follow, implemented together:

1. **The reserve is plan-relative by default.** `COUNTDOWN_CREDIT_RESERVE`
   accepts a percentage of the plan's `credits_limit` (`5%`, the default,
   an integer 0–50%) or an absolute count. The limit comes from the vendor's
   free account endpoint and is remembered with the plan name and reset
   date; the gate reads the account before it can refuse anything under a
   percent reserve, and an absolute reserve at or above the known limit —
   which can never be satisfied — is refused as such, naming the fix. A
   "soft floor" (admitting calls below the reserve with a warning) was
   considered and rejected: the reserve exists to keep the last credits for
   seller confirmations and re-validation, a floor that bends is not a
   reserve, and the percentage form removes the reason a floor would have
   been wanted.
2. **`ebay_api_status`** is a fourth, credit-free tool the routine calls
   first: the account probe as a tool, returning the plan, the credits, the
   configured and effective reserve, the gate's verdict with
   `gate.spendable`, the account's suspension state and the gateway build
   (`GATEWAY_BUILD_SHA`). And nothing is spent on an unknown balance any
   more: the gate reads the account before the first charged request of a
   process — the 2026-09-03 restart had sent a search straight upstream
   against 82 credits and a 500 reserve because an empty memory was not
   "below reserve".
3. **Every source tool answers inside the MCP client's 60 s.** The client
   (Claude Code in the cloud, the routine's runtime) reported
   `tool "ebay_api_search" timed out after 60s` against 120 s catalog
   deadlines and a 90 s per-request timeout, losing the result while the
   vendor may still have charged it. Deadlines are now 50 s (search, items),
   25 s (seller) and 30 s (status); `COUNTDOWN_TIMEOUT_MS` defaults to 45 s
   and may not exceed the deadline less 2 s; a retry needs 10 s of budget;
   an item batch launches nothing the remaining budget cannot hold, returns
   what it has at the deadline and names the ids to re-request (never-sent
   slots were never charged, in-flight ones possibly were); a search
   abandoned at the deadline says the credit may have been charged.

Two vendor behaviours seen on the 2026-09-03T11:27Z manual fire are handled
alongside. A 402 whose message says the account is suspended — the trial was
suspended mid-fire, "removed when you subscribe to a Plan" — maps to
`SOURCE_REJECTED` (`reason: account_suspended`) rather than "out of
credits", is never counted as a charge, is remembered for five minutes
during which every tool including seller lookups is refused without a round
trip, and is reported by the status tool. And the gate's account probe runs
on its own terms — 8 s, no retry, one in flight shared by concurrent
callers, and the account never asked more than once a minute — because
awaiting a probe on the charged request's 90 s terms and retry ladder is
what held three consecutive searches past the client's 60 s.
