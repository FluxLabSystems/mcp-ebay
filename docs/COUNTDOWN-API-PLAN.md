# Countdown API as a Track A source: implementation and integration plan

Status: **Proposed, ready for execution**
Date: 2026-09-02 (revised the same evening with live demo-key captures and the
Phase 0 keyed captures; see §1.5, `tests/fixtures/countdown/demo/` and
`tests/fixtures/countdown/keyed/`)
Scope: `ethanbissbort/mcp-ebay` (code), `ethanbissbort/FluxLab` (deploy),
`ethanbissbort/fluxlab-boards` (skill and routine data)
Routine affected: the current **FluxLab Deals Dashboard** routine
(`0 7,20 * * *` UTC) and its skill `.claude/skills/fluxology-deals-run/SKILL.md`.
No other routine is in scope, and no retired routine is referenced anywhere in
this plan.

This document is written for a Claude Code session to execute. It is
self-contained: every step names the file it touches, the convention it copies,
and the check that proves it landed. Phases are ordered by dependency and each
ends with acceptance criteria; do not start a phase before the previous one's
acceptance holds. Where a Phase 0 fixture contradicts a fact stated here, the
fixture wins and this document is corrected in the same PR.

---

## 0. Decision and scope

**Decision.** Add Countdown API (Traject Data's eBay scraping API,
`https://api.countdownapi.com/request`) as a second, gateway-served data source
for the deals routine's Track A (eBay). It is used for discovery sweeps,
watched-seller drill-downs, login-id verification and cheap re-validation of
stored eBay records. The Browser Bridge (the paired Windows Chrome) keeps two
jobs the API cannot do: destination-resolved shipping to M6H 2W9 on item pages,
and anything that needs a signed-in eBay session.

**Why.** The routine's two recurring failure modes are eBay bot walls
(`/splashui/challenge` on `_ssn=` searches, HTTP 403 from any dev box) and the
per-turn tool-call budget consumed by page-by-page traversal. One API request
returns up to five pages of 240 structured rows with no DOM scan window, no
challenge page and no Chrome on the path, and the vendor absorbs anti-bot and
layout drift. The open improvement report `usr-profile-page-dispatched-as-item-page`
(blocking) is sidestepped outright by the API's seller-profile request type.
Full analysis: the 2026-09-02 assessment this plan was derived from, summarised
in §1.

**Non-goals (explicitly out of scope for this plan).**

- Replacing the Browser Bridge. Shipping resolution, the signed-in session, and
  final validation of anything surfaced with a landed figure stay on the Bridge.
- Kijiji (Track B). The API is eBay-only; the radius defect is untouched.
- Sold or completed-listing comps. The vendor rejects both parameters because
  eBay now requires a signed-in session for them.
- Collections (the vendor's scheduled batch runner). Optional Phase 5, only if
  Phase 4 shows wall-clock or credit pressure.
- A caching layer in the gateway. Real-time requests only; the run checkpoint
  already records what was searched.
- Any change to the deals dashboard schema (`public/deals/data/schema.json`).

**Alternative recorded in the ADR, not chosen.** eBay's official Browse API
offers destination-aware item summaries via a contextual-location header and is
free within its call limits, but needs an eBay developer application, its own
key management and compliance review. It is a legitimate future option and the
ADR in Phase 1 must list it so the decision is auditable; this plan targets
Countdown per the operator's choice.

---

## 1. Established facts (verified 2026-09-02)

Sources: `docs.trajectdata.com/countdownapi` sub-pages and parameter-validation
probes with the documented `demo` key. The demo key answers the Account API and
runs parameter validation; every data call returns HTTP 401 until a plan or the
free trial is active. A 400 therefore means "rejected by validation", a 401
means "accepted, needs a plan". Both are free.

### 1.1 Endpoints and request types

| Item | Value |
|---|---|
| Data endpoint | `GET https://api.countdownapi.com/request` with `api_key` and `type` |
| Account endpoint | `GET https://api.countdownapi.com/account?api_key=…` (free, no credits) |
| Request types | `search`, `product`, `reviews`, `seller_profile`, `seller_feedback` |
| Domains | 20 supported; `ebay.ca` and `ebay.com` both listed |
| URL passthrough | `url=` accepts a full eBay search, item or `/usr/` URL; then `ebay_domain`, `sort_by`, `search_term`, `listing_type`, `condition`, `page` are ignored |
| Output | JSON (default), CSV, or raw HTML; `include_html=true` adds raw page HTML to JSON |
| Field trimming | `include_fields` / `exclude_fields` in dot notation |
| Demo key | `api_key=demo` serves live, uncharged responses (`request_info.demo: true`) for the docs' example term `memory cards` on any domain, with or without a zip, and for `type=product` / `type=reviews` on the docs' example epid; any other term returns 401. Enough for response-shape work at zero credits, not for LEGO-specific captures. |
| Zip mechanism | `customer_zipcode` is applied by appending `_stpos=<zip>` (with `_fcid=<country id>`) to the eBay search URL, so eBay itself renders each card's shipping for that postal code; on 2026-09-02, 3 of 59 rows shared between a zip-scoped and an unscoped ebay.ca search carried a different shipping figure. The value passes through unnormalised (`M6H 2W9` becomes `_stpos=M6H+2W9`, lowercase stays lowercase); the gateway sends it uppercase with no space. |
| Transient 500s | "Countdown API was unable to fulfil your request at this time, please retry. You have not been charged for this request. (G)" hit 6 of 19 demo calls; the identical retry succeeded every time. |

### 1.2 Search parameters that matter here

| Parameter | Values / notes |
|---|---|
| `sort_by` | `best_match`, `price_high_to_low`, `price_low_to_high`, `price_high_to_low_plus_postage`, `price_low_to_high_plus_postage`, `newly_listed`, `ending_soonest` |
| `listing_type` | `all`, `buy_it_now`, `auction` (reaches eBay as `LH_Auction=1`), `accepts_offers` |
| `condition` | `all`, `new`, `used`, `open_box`, … |
| `category_id` | eBay `_sacat` value |
| `num` | `60`, `120`, `240` |
| `page`, `max_page` | `max_page` ≤ 5 on real-time requests; each page costs one credit. With `max_page` > 1 the response shape changes: `pagination` becomes `{pages: [...]}` with one entry per page, `request_metadata.ebay_url` is absent, and every row gains `page` and `position_overall`. Measured: `num=240&max_page=2` returned 480 distinct rows in 273 KB (about 570 bytes a row). |
| `customer_location` | ISO country code; `ca` and `us` both support `customer_zipcode` |
| `customer_zipcode` | accepted on `type=search` (probe: 401); **rejected on `type=product`** (probe: 400 "should not be specified when type=product", re-verified in the `url` and `epid` forms with the Canadian and U.S. zips; the vendor's playground confirms it from the UI side: switching the Type selector to Product removes the Customer Zipcode field while Customer Location stays) |
| `completed_items`, `sold_items` | **rejected**: "no longer supported, eBay now requires a signed-in session" |
| `facets`, `allow_rewritten_results` | facet filters in eBay's own vocabulary; `allow_rewritten_results=false` drops the "results matching fewer words" rows |

### 1.3 Response shapes

Search (`search_results[]`), documented: `position`, `title`, `epid`, `link`,
`image`, `condition`, `is_auction`, `buy_it_now`, `best_offer`,
`best_offer_accepted`, `free_returns`, `sponsored`, `is_rewritten_result`,
`item_location`, `shipping_cost`, `prices[] {value, currency, raw, name}`,
`price`, `seller_info {name, review_count, positive_feedback_percent}` when
shown, `hotness`, `ended {type, date}` when shown. Root: `pagination
{current_page, total_results, has_next_page, next_page}`, `facets[]`,
`request_info {credits_used, credits_remaining}`, `request_metadata.ebay_url`.

Search rows, **as measured** on 2026-09-02 (ebay.ca with the Toronto zip, 60 and
480 rows; ebay.ca without a zip, 60 rows; ebay.com with the forwarder zip, 60
rows; fixtures in `tests/fixtures/countdown/demo/`):

- `prices[]` entries carry `value` and `raw` only. **No `currency` field on
  either domain**; the raw string is `C $20.00` on ebay.ca and `$40.61` on
  ebay.com. Currency is parsed from `raw`, with the domain as the fallback.
- **`is_auction` is false on every row of an unfiltered search, auctions
  included.** The keyed newly-listed sweep for `lego minifigure lot` carried 30
  rows that its auction-filtered twin (`listing_type=auction`, which reaches
  eBay as `LH_Auction=1`) proves are live auctions, and every one of them read
  `is_auction: false` on the unfiltered page. `buy_it_now` is false on every
  fixed-price row too. So neither flag on an unfiltered page says anything, and
  a `C $1.00` current bid there is indistinguishable from a purchasable price.
  On an auction-filtered search the flag is true on every row. Format therefore
  comes only from the filter a row was retrieved under (§3.1, §4.1).
- **Price-range rows are damaged.** A multi-variant listing (quantity tiers,
  sizes) renders its price as a range, and the vendor's title for such a row
  ends in a stray ` to` (titles up to 83 characters against eBay's 80-character
  cap). Its `prices` are either a two-entry low/high range or **missing
  entirely**: on ebay.ca, 21 of the 30 range rows on page 1 and 159 of 480 rows
  over two pages had no price at all; on ebay.com all 44 range rows parsed as
  two prices. LEGO lots sold in 10/25/50/100-piece tiers are exactly this
  shape, so a price-less row is a variant listing to open, never "no price".
- `shipping_cost` is sparse on default searches: 40 of 60 ebay.ca rows with or
  without the zip, 3 of 60 ebay.com rows; 60 of 60 on the auction-filtered
  layout. **Absent means unknown, never free.**
- `seller_info` is present on nearly every row of a default search (60 of 60
  ebay.ca, 46 of 60 ebay.com) and on **no** row of the auction-filtered layout;
  `review_count` is a string.
- `condition` sometimes carries the seller's subtitle concatenated in front of
  the condition ("100% GENUINE Kingston✔Shipped from USA✔Brand New").
- `item_location` is bare on ebay.ca (`china`) and prefixed on ebay.com
  (`located in china`).
- `sponsored` was `false` on all 540 rows, so it cannot be relied on to drop
  promoted rows. `hotness`, `ended` and `facets` did not appear at all.

**Caution.** `epid` on a search row is sometimes an eBay *product* id, not the
item number (the docs' own example pairs `epid 8030522363` with an
`/itm/…/332050873554` link; the 540 measured rows all matched). The item id is
always derived from `link`, never from `epid`.

Search rows carry **no bid count and no time left**.

Product, individual listing (`is_master=false`): `is_auction`, `make_offer`,
`product {title, epid (item id), link, description, images, image_count,
attributes[], categories[], variants[], last_updated}`, `auction {bids,
winning_bid_price, winning_bid_price_raw, winning_bid_price_converted,
time_left.raw, end_date.utc, buy_it_now}`, `offer {price, currency,
best_offer_accepted, sale_date}`, `stock_status {status, quantity_available,
quantity_sold}`, `condition {raw, name, is_new, is_used}`, `returns_policy`,
`seller {name, link, feedback_score, positive_feedback_percent}`, `shipping
{price, service, ships_to, location, delivery_estimate}`, `payment_methods`,
`end_date` (present when the listing is flagged ended), `redirected`,
`redirected_link`, `redirected_epid` (when eBay redirected an unavailable item).
An item eBay no longer serves comes back **HTTP 200** with
`request_info.success: true`, no `product` block and
`message: "Product not found."` (measured on the docs' example epid on both
domains); `redirected` is a separate case.

Item pages, **as measured** on 2026-09-02 (nine ebay.ca and ebay.com item
pages; fixtures in `tests/fixtures/countdown/keyed/`):

- **A live ebay.ca auction came back as `is_auction: false` with no `auction`
  block and `offer.price 19.99 CAD`**, while the auction-filtered search row
  for the same item showed a `C $37.54` current bid. The item page cannot be
  trusted for auction format, bids, end time or price; auctions stay on the
  Bridge for everything but identity and availability.
- `offer` carries `price` and `currency` (`CAD` on ebay.ca, `USD` on ebay.com).
- `shipping.price` is a **string**, not a number, in mixed forms: `"C $68.71"`,
  `"GBP 21.56 "`, `"7.95 "`, `"19.85 "`, `"Free"`. The delivery-estimate key is
  camel-cased `deliveryEstimate`. The raw HTML behind one capture reads
  "Estimated between … to 91722": the vendor's browser resolves item pages
  to its own California zip whatever `customer_location` says, so an item-page
  shipping figure is not even a country-level Canadian figure.
- `shipping.ships_to` is a truncated alphabetical list ("Albania, Algeria,
  American Samoa, and many other countries") or "Worldwide" on a seller the
  roster records as excluding Canada. It is not route evidence.
- Ended and sold are signalled by `stock_status`, not `end_date` (absent on all
  three ended items): `raw` `https://schema.org/OutOfStock`, `status`
  `not_in_stock`, `quantity_available 0`, plus `message` "This listing sold on
  Sun, Aug 30 at 3:03." when it sold. `quantity_available: 0` also appears on
  live single-quantity listings, so it means "not shown" unless the status is
  `not_in_stock`.
- `seller.link` comes in three forms: `/usr/<loginId>`, `/str/<storeSlug>` and
  `/sch/<loginId>/m.html?item=…`. Store slugs differ from login ids
  (`tweedsidesales` is `/str/jeremydoherty`; Bluebird Brick Designs is
  `/str/almtshop88`). `seller` carries no feedback fields on ebay.ca.
- `variants` is empty on a quantity-tier lot; `offer.price` is the lowest tier.
- `condition.name` is normalised lowercase (`used`); `product.is_master` sits
  inside `product`, not at the top level.
- `seller_profile` by `/usr/` URL returned name, store link, positive percent
  and followers only (no `member_since`, `location` or `top_rated_seller`); an
  unavailable profile and the `seller_name` form both hit the vendor's generic
  uncharged 500 on every attempt.
- `include_html=true` returns the full rendered item page (650 KB) with the DOM
  extractor's selectors present, so the vendor can supply the ebay.ca fixtures
  a dev box cannot fetch.

Seller profile (`type=seller_profile`, by `seller_name` or `url`): `seller
{name, link, member_since, positive_ratings_percent, followers, location,
image, description, top_rated_seller}`. The `url` form returns the fuller set.

### 1.4 Limits, errors, pricing

| Item | Value |
|---|---|
| Real-time `max_page` | 5 |
| Collections | ≤ 15,000 requests each, `max_page` ≤ 100, result sets kept 14 days, daily/weekly/monthly schedules with `schedule_hours`, webhook on completion, management API free |
| Response codes | 200; 400 invalid params; 401 bad key; 402 out of credits — or, with a message saying the account is suspended (seen 2026-09-03 on the trial mid-fire), a suspension that only subscribing to a plan lifts; 429 rate limit (plan-dependent, not published); 500 retry after delay; 503 parsing incident, uncharged, carries `retry_after`; opt out with `skip_on_incident` |
| Zip codes | per-plan cap on distinct `customer_zipcode` values (10 on the demo account); this routine needs two |
| Pricing | free trial 100 requests, no card; $18/500; **Starter $66/10,000** (+$0.0118 per extra); Production $375/250,000; annual billing up to 20 % off |
| Cache | GTIN→epid mapping only; searches and products are real-time |
| MCP client tool timeout | 60 s (Claude Code in the cloud, the routine's runtime; observed 2026-09-03 as `tool "ebay_api_search" timed out after 60s`). Every gateway source tool answers inside it: search and items 50 s, seller 25 s, status 30 s |
| Vendor latency | up to and past 120 s observed in Phase 0 on a 240-row auction search (two 120-second timeouts, then 60 s); the per-request timeout is 45 s by default and at most 48 s, so a slow request fails on its own before the tool deadline does |
| Account endpoint | `GET /account?api_key=…` is free and returns `account_info {plan, credits_used, credits_limit, credits_remaining, credits_reset_at, …}` (plus the key and email, which the client strips). The trial is a one-time 100 requests; paid plans are monthly: Hobbyist 500, Starter 10,000, Production 250,000 |

Plan sizing: modelled spend is roughly 100 to 130 requests per fire at two fires
a day, so 6,000 to 8,000 a month. Starter is the right tier. See §11.

---

## 2. Architecture

```
claude.ai routine ── MCP ──> gateway (apps/gateway)
                              ├─ browser_* tools ──> WSS ──> Windows agent ──> Chrome   (unchanged)
                              ├─ dashboard_*, deals_run_* (gateway-served)            (unchanged)
                              └─ ebay_api_* tools (gateway-served, NEW)
                                    └─ packages/source-countdown ── HTTPS ──> api.countdownapi.com
```

**Placement.** The new tools are gateway-served on the existing Browser Bridge
connector, exactly like `dashboard_feed` and `deals_run_resume`: no device on
the path, the API key lives only in the gateway environment, and the routine
needs no new connector grant (the repos' `.claude/settings.json` allow the whole
server, and the routine's stored connector list is unchanged).

**Packages.**

- `packages/compact` (new, moved): `apps/windows-agent/src/compact.ts` moves
  here unchanged and the agent re-exports it. The API search tool must apply
  the *same* `search.include` / `fields` / `limit` / `offset` semantics and emit
  the same warning codes (`EXCLUDED_NO_PRICE`, `EXCLUDED_UNKNOWN_FORMAT`,
  `CANDIDATES_TRUNCATED`, `CANDIDATE_FIELDS_NULL`), and the only way to
  guarantee that is to run the same function. Its imports (`site-ebay`,
  `site-kijiji`, `site-zazzle`, `protocol`) are all workspace packages with no
  Playwright dependency, so the gateway can depend on it.
- `packages/source-countdown` (new): a pure client with injectable `fetch`,
  request builders, response validators (zod, loose), and three mappers:
  search row → `ListingCandidate`, product → `ExtractionRecord`
  (`siteProfile: 'ebay.api.v1'`), seller profile → `SellerProfile`. No I/O
  beyond `fetch`. Scaffold from `packages/site-zazzle` (manifest, `tsconfig`
  extending `../../tsconfig.base.json`, `exports` to `dist`).
- `apps/gateway/src/countdown/` (new): tool handlers, credit reserve gate,
  audit inserts, and the concurrency limiter for item batches.
- `packages/protocol`: schemas, catalog entries, error codes.
- `packages/site-ebay`: additive record-schema changes (see §4.2).

**Scope.** All four tools require `browser:read` (`SCOPE_READ`), the scope
that already gates `browser_extract`. They are marketplace reads of the same
sensitivity, they are not browser actions, and reusing the scope avoids a
Keycloak realm change. Record this in the ADR.

**Configuration** (`packages/config/src/index.ts`, mirrored in
`deploy/env.example` and FluxLab's `vps/bridge/.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `COUNTDOWN_API_KEY` | unset | When unset or empty the `ebay_api_*` tools are not registered (same behaviour as `DASHBOARD_API_BASE_URL`). Empty string must parse as unset: FluxLab's `ensure_env_keys` copies `.env.example` lines verbatim and refuses `CHANGE_ME` placeholders, so the example line is `COUNTDOWN_API_KEY=`. |
| `COUNTDOWN_API_BASE_URL` | `https://api.countdownapi.com` | Overridable for the integration stub only |
| `COUNTDOWN_CREDIT_RESERVE` | `5%` | The credits the gate holds back: a percentage of the plan's `credits_limit` (`N%`, an integer 0–50, resolved from the free account endpoint: 5 on the 100-request trial, 25 on Hobbyist, 500 on Starter) or an absolute count (`500`). Search and item calls are refused with `SOURCE_CREDITS_EXHAUSTED` (`details.reason` `below_reserve`) once the last observed `credits_remaining` is below it; seller-profile calls (one credit, rare) are still allowed. An absolute reserve at or above the plan's limit can never be satisfied and is refused as such (`reserve_not_below_plan_limit`, the 2026-09-03 zero-coverage fire). Blank is the default; any other spelling fails validation naming the two forms |
| `COUNTDOWN_MAX_CONCURRENCY` | `4` | Parallel product requests inside one `ebay_api_items` call |
| `COUNTDOWN_TIMEOUT_MS` | `45000` | Per vendor request, at most 48000: the 50 s search/items deadline less 2 s, so a request times out on its own before the tool does (§1.4: the MCP client allows 60 s) |
| `EBAY_FORWARDER_ZIPCODE` | `34249` | The MyUS Sarasota suite from `data/deals/multi-path-shipping-policy.json`; paired with `EBAY_DESTINATION_POSTAL_CODE` (`M6H 2W9`) as the only two zip codes the gateway will ever send |
| `GATEWAY_BUILD_SHA` | `unknown` | The commit the gateway image was built from, set by the Dockerfile from a build argument and reported by `ebay_api_status` as `build.gateway`; never an active line in an env file (it would override the image's value) |

**Destinations are named, never free text.** Tool inputs take
`destination: 'toronto' | 'forwarder' | 'domain_default'`, mapped in the
gateway to (`customer_location=ca`, `customer_zipcode=M6H 2W9`),
(`customer_location=us`, `customer_zipcode=34249`) and (no location
parameters). This keeps the account's zip-code cap at two values and keeps the
skill's "never invent a destination" rule enforceable in code. The gateway
normalises the postal code to uppercase with no space before sending it. On a
search, the zip reaches eBay as `_stpos`, so a row's `shipping_cost` under
`destination: 'toronto'` is eBay's own rendered estimate for M6H 2W9: card-level
and sparse, but not a country-level proxy. On an item page `destination` only
sets `customer_location`; the vendor's browser still resolves delivery to its own
zip (91722 observed), so item-page shipping is recorded as observed text with
no destination at all.

**URL policy.** When a caller passes `url`, the gateway accepts only
`https://www.ebay.ca/…`, `https://www.ebay.com/…` (and the bare-host forms) with
a path under `/sch/`, `/itm/`, `/usr/` or `/str/`; anything else is
`ORIGIN_DENIED`. The gateway never fetches that URL itself; it forwards it to
the vendor as the `url` parameter. Query strings pass through verbatim so the
routine's existing `_ssn=`, `_sop=10`, `_ipg=240`, `LH_PrefLoc=2` conventions
keep working.

**Errors** (add to `ERROR_CATALOG` in `packages/protocol/src/errors.ts`):

| Code | Retryable | When |
|---|---|---|
| `SOURCE_UNAVAILABLE` | yes | 503 parsing incident (carry `retryAfter`), 5xx after two retries, network timeout |
| `SOURCE_CREDITS_EXHAUSTED` | no | 402 from the vendor, or the reserve gate |
| `SOURCE_REJECTED` | no | 400 or 401; the vendor's message is passed through with the key stripped |

429 maps to the existing `RATE_LIMITED`. Vendor error messages are quoted as
data; the outbound URL is never included in an error or log with its query
string attached.

**Credits.** Every response carries `credits: {used, remaining, usedThisRequest}`
from the vendor's `request_info`: `usedThisRequest` is what the call spent,
summed over its vendor requests; `used` is the account's month-to-date total,
not the call's spend (2026-09-02 live check: three parallel one-credit calls all
reported `used: 15`). The gateway keeps the last `remaining` in memory for
the reserve gate and writes one audit row per upstream call (tool name, vendor
request id, credits used, HTTP status), using `store.audit.insert` as
`broker.ts` does. Extend the pino `redact` list in `apps/gateway/src/server.ts`
with `api_key`, `*.api_key`, `apiKey`, `*.apiKey`.

**The gate (2026-09-03).** Nothing is spent on an unknown balance: before the
first charged request of a process — and under a percent reserve before the
plan limit is known — the gate reads the free account endpoint, then decides.
The probe runs on its own terms (8 s, no retry, one in flight shared by every
concurrent caller, the account never asked more than once a minute), so the
gate answers in seconds whatever the account endpoint is doing; a shut gate
re-reads the account at most once a minute so a top-up or a plan upgrade
reopens it. What a probe cannot resolve does not block: the reserve counts
as 0, the call carries `CREDIT_RESERVE_UNRESOLVED`, and the vendor's own 402
is the backstop. A 402 whose message says the account is suspended is
`SOURCE_REJECTED` (`reason: account_suspended`), never a charge, and is
remembered for five minutes during which every tool, seller lookups
included, is refused without a round trip. `ebay_api_status` (§3.4) is the
same probe as a tool.

**Security.** The key never appears in tool input, output, audit rows or logs.
The only outbound host is the configured base URL. `tests/security/ssrf.test.ts`
gains cases proving a non-eBay or private-network `url` is refused before any
outbound call is made.

---

## 3. Tool contracts

Names are dot-free (the 2026-09-02 rename made dotted names unusable for
permission matching). All four return `structuredContent` like the dashboard
tools do; the three charged tools carry `credits`, `requestIds` (the vendor's
`request_metadata.id` per request) and `warnings[]`, and every tool answers
inside a deadline under the MCP client's 60 s (§1.4).

### 3.1 `ebay_api_search`

Input (strict object):

```
domain:        'ebay.ca' | 'ebay.com'            (default 'ebay.ca'; ignored when url is given)
searchTerm?:   string (1..200)
url?:          string  (eBay search URL; mutually exclusive with searchTerm/sortBy/listingType/condition/categoryId/page)
sortBy?:       'best_match' | 'newly_listed' | 'ending_soonest' | 'price_low_to_high' | 'price_high_to_low'
listingType?:  'all' | 'buy_it_now' | 'auction' | 'accepts_offers'   (default 'all'; 'all' costs two vendor requests, see below)
condition?:    'all' | 'new' | 'used'                                (default 'all')
categoryId?:   string
num?:          60 | 120 | 240                                         (default 240)
page?:         int ≥ 1                                                (default 1)
maxPage?:      int 1..5                                               (default 1)
destination:   'toronto' | 'forwarder' | 'domain_default'             (default 'domain_default')
allowRewrittenResults?: boolean                                       (default false)
search?:       SearchCompactionInput   (the existing include/fields/limit/offset object, same defaults)
```

Output: the same shape `browser_open_and_extract` returns for an eBay search
page after compaction, so the skill's audit and filter rules apply unchanged:

```
source: 'countdown', siteProfile: 'ebay.api.v1', pageKind: 'search',
pageUrl (vendor's request_metadata.ebay_url), domain, destination,
totalResults (pagination.total_results as int|null), candidateCount (rows received),
pagesFetched, hasNextPage, candidates[], offset, hasMore, nextOffset,
warnings[], credits {used, remaining, usedThisRequest}, requestId
```

Each candidate is a `ListingCandidate` (from `packages/site-ebay/src/traversal.ts`)
plus API-only fields, mapped per §4.1. `bidCount` is always `null` and a single
`BID_COUNT_UNAVAILABLE_FROM_SOURCE` warning says so; the item tool carries bids.
`listingType: 'all'` is served as **two vendor requests**, `buy_it_now` and
`auction`, merged and de-duplicated by item id: a row in both sets is
`auction_with_bin`, auction-only is `auction`, buy-it-now-only is `fixed_price`.
An unfiltered vendor search is never issued, because its `is_auction` flag is
false on auctions (§1.3). `credits.usedThisRequest` reports both requests;
`credits.used` is the account's month-to-date total.

Candidates also carry `shippingCost` (a number, or `null` when the card showed
nothing the vendor could read; never inferred as free), `priceRange` (true on a
variant listing whose card price is a range or was lost), `page` and
`positionOverall`. When `maxPage` > 1 the handler folds the vendor's
`pagination.pages[]` into `totalResults`, `pagesFetched` and `hasNextPage`
(the last page's flag).

### 3.2 `ebay_api_items`

Input:

```
items:        array 1..25 of { itemId: string (10..14 digits), expectedFormat?: 'auction' | 'auction_with_bin' | 'fixed_price' } | { url: string, expectedFormat?: … }
domain:       'ebay.ca' | 'ebay.com'                     (default 'ebay.ca'; per-item url overrides)
destination:  'domain_default' | 'toronto' | 'forwarder'  (sets customer_location only; see warnings)
compact:      boolean (default true)
```

Output: the `ExtractManyOutput` shape verbatim, `mode: 'inline'`, `jobId: null`,
one `BatchExtractItem` slot per input in input order, so "only upsert slots with
`ok:true`" and "a `LISTING_UNAVAILABLE` slot keeps its record as evidence" hold
without any new rule. `record` is `compactItemRecord(...)` of the mapped
`ExtractionRecord` when `compact` is true, otherwise the full record with
`source:'api'` provenance. Every slot carries the warning
`DESTINATION_UNVERIFIED: item-page shipping from this source is never resolved
to a postal code` (the vendor rejects `customer_zipcode` on product requests),
and auction slots carry the same `AUCTION_PRICE` warning the DOM extractor
emits. `expectedFormat` is the format the search that found the row
established (§3.1); the vendor's item-page `is_auction` is ignored because it
reads false on live auctions. A slot whose `expectedFormat` is an auction kind
returns `sellingFormat.kind` from the caller, `itemPrice: null`, `endsAt` and
`timeLeftText` null, and the warning `AUCTION_DETAIL_UNAVAILABLE_FROM_SOURCE`:
the Bridge is the only source for a bid, an end time or a landed figure on an
auction. Requests run with the configured concurrency; a slot that fails maps
its own error and never fails the batch.

### 3.3 `ebay_api_seller`

Input: `{ loginId: string } | { url: string }` plus `domain` (default
`ebay.ca`). `url` must be a `/usr/` or `/str/` page on an allowed host.

Output:

```
resolved: boolean            (false when the vendor returned no seller block)
seller: { name, profileUrl, loginId (path segment of profileUrl, or null), memberSince,
          positivePercent, followers, location, topRated, description (≤ 500 chars) } | null
warnings[], credits, requestId
```

This is the `/usr/` confirmation step in `data/deals/README.md` rules 1 and 4.
What the vendor returns for a suspended or nonexistent profile is a Phase 0
question; until answered, `resolved:false` plus the vendor message in
`warnings` is the honest output.

### 3.4 `ebay_api_status`

Input: `{}` (a strict, empty object). No credit is spent: the tool is the
free account probe, made fresh on every call (8 s, no retry) because a stale
figure is what a run must not plan against.

Output (`EbayApiStatusOutput`, strict):

```
source: 'countdown', siteProfile: 'ebay.api.v1', probedAt (ISO),
probe:   { ok, httpStatus | null, error: {code, message} | null }
plan:    { name | null, creditsLimit | null, creditsResetAt | null }
account: { suspended, vendorMessage | null }
credits: { used | null, remaining | null }          used is the month-to-date total
reserve: { configured ("5%" | "500"), effective | null, basis: 'absolute' | 'plan_limit' | 'unknown_limit' }
gate:    { open, reason: 'below_reserve' | 'reserve_not_below_plan_limit' | 'account_suspended'
                         | 'balance_unknown' | 'reserve_unresolved' | null,
           spendable: max(0, remaining − effective) | null }
build:   { gateway: GATEWAY_BUILD_SHA | 'unknown' }
warnings[]
```

`gate.spendable` is what the reserve gate will admit from here, with an
unresolved reserve counting as 0 exactly as the gate counts it, and null
while the balance is unknown. When the probe fails, `probe.ok` is false and
the figures are the last remembered ones (`ACCOUNT_PROBE_FAILED` in
warnings); when nothing is remembered at all the call fails with
`SOURCE_UNAVAILABLE` — except a suspension answer, which is returned as
status. The routine calls it first, plans the fire against `gate.spendable`,
and puts `credits.remaining` in the completion report.

---

## 4. Field mapping

### 4.1 Search row → `ListingCandidate`

| Candidate field | Source | Rule |
|---|---|---|
| `itemId` | `link` | `itemIdFromUrl(link)`; a row whose link yields no id is dropped and counted in `CANDIDATE_FIELDS_NULL` |
| `url` | `link` | `canonicalListingUrl` for the row's domain (`/itm/<id>`) |
| `title` | `title` | `cleanTitle`, then strip one trailing ` to` and set `priceRange: true` when it was present (the vendor leaks the range separator into the title) |
| `snippetPrice` | `price` else `prices[0]` | `{value, currency}`; currency from `parseMoney(raw)`, falling back to the domain's currency (`CAD` for ebay.ca, `USD` for ebay.com) because the rows carry no `currency` field; on a two-entry range keep the low value and put the high in `snippetPriceHigh` |
| `priceRange` | title marker or `prices.length === 2` | a price-less range row keeps `snippetPrice: null`, `priceRange: true`, and is counted once per response in `PRICE_RANGE_UNPARSED`; the compactor's `EXCLUDED_NO_PRICE` count still reports it when a price bound drops it |
| `sellingFormat` | the filter the row was retrieved under (§3.1) | in both the `buy_it_now` and `auction` sets → `auction_with_bin`; auction set only → `auction`; buy-it-now set only → `fixed_price`. The row's own `is_auction` and `buy_it_now` flags are never read: both are false on auctions in an unfiltered search |
| `bidCount` | none | `null` always |
| `shippingSnippetText` | none | `null`; the numeric `shippingCost` from `shipping_cost` replaces it, `null` when absent |
| `itemLocationText` | `item_location` | strip a leading `located in ` |
| `condition` | `condition` | normalise to the last token from the known vocabulary (`Brand New`, `New (Other)`, `Open Box`, `Pre-Owned`, `Used`, `For parts or not working`, refurbished variants); keep the raw string in `conditionRaw` when it differed |
| `isNewListing` | none | `null` (API rows carry no badge); the compactor already tolerates null |
| `order` | `position_overall` else `position` | zero-based |
| API-only | `sponsored` (unreliable, documented), `bestOffer`, `sellerName`, `sellerReviewCount` (parsed to int), `sellerPositivePercent`, `endedType`, `page` | pass-through, present only when the row has them |

Rows with `is_rewritten_result: true` are excluded by default
(`allowRewrittenResults=false` sends the vendor parameter and also filters
defensively) and counted in a `EXCLUDED_REWRITTEN` warning.

### 4.2 Product → `ExtractionRecord` (`siteProfile: 'ebay.api.v1'`)

Additive schema changes in `packages/site-ebay/src/record.ts`:
`FieldSourceSchema` gains `'api'`; `siteProfile` becomes
`z.enum(['ebay.ca.v1', 'ebay.api.v1'])`; new nullable fields `shipsToText`,
`deliveryEstimateText`, `conditionText`, `sellerFeedbackScore`,
`sellerPositivePercent`, `sellerProfileUrl`, `makeOffer`, `imageCount`,
`attributes` (≤ 40 name/value pairs), `categories` (names only). The browser
tools' `siteProfile` enums in `packages/protocol/src/tools.ts` are unchanged:
the Bridge never produces `ebay.api.v1`. `profileRevision` is bumped.

| Record field | Source | Rule |
|---|---|---|
| `itemId` | `product.epid` cross-checked against `itemIdFromUrl(product.link)` | the link wins on disagreement; add `ITEM_ID_MISMATCH` warning |
| `canonicalUrl` | `product.link` | canonicalised |
| `title` | `product.title` | |
| `seller` | `seller.link` | `/usr/<id>` and `/sch/<id>/m.html` yield the login id; `/str/<slug>` yields a store slug that is **not** a login id (`tweedsidesales` is `/str/jeremydoherty`) and is stored as `sellerStoreSlug` with `seller: null`; `seller.name` kept in `sellerDisplayName` |
| `itemPrice` | fixed price only: `offer.price` / `offer.currency` | null with `AUCTION_DETAIL_UNAVAILABLE_FROM_SOURCE` when `expectedFormat` is an auction kind; the vendor reported a live auction as a fixed price at a different figure |
| `offer` | `make_offer`, `offer.best_offer_accepted` | `available = make_offer === true` |
| `shipping` | `shipping.price` is a string (`"C $68.71"`, `"GBP 21.56 "`, `"7.95 "`, `"Free"`) parsed with `parseMoney`; a bare number takes the domain currency at confidence 0.4 | `destinationPostalCode: null`, `destinationVerified: false`, `observedText` = the raw string plus `shipping.service`; the figure is resolved to the vendor's own zip, so it is evidence of the service offered, never of a Toronto or Canadian cost; `shipsToText` kept but never used for route eligibility |
| `listingStatus` | `message: "Product not found."` with no `product`, or `redirected` → `unavailable` (slot `ok:false`, `LISTING_UNAVAILABLE`); `stock_status.status: not_in_stock` (raw `OutOfStock`) → `sold` when `stock_status.message` says "This listing sold on …", otherwise `ended`; `end_date` present → `ended`; `in_stock` with a price → `active`; else `unknown` | the `sold` branch is confirmed or corrected by the Phase 0 sold-item fixture |
| `sellingFormat` | `expectedFormat` from the caller | the item page's `is_auction` is ignored (false on live auctions); `bidCount` null |
| `endsAt`, `timeLeftText` | `auction.end_date.utc`, `auction.time_left.raw` when the vendor ever returns them | null on every auction captured; source `api`, confidence 0.95 if present |
| `itemLocationText` | `shipping.location` | |
| `quantityAvailable`, `quantitySold` | `stock_status` | `quantity_available: 0` on an `in_stock` listing means "not shown" and maps to null, not zero |
| `watcherCount` | none | `null` |
| `variants` | `product.variants` | name/attributes only |
| `observedAt`, `pageRevision` | now, `0` | API records have no page revision; `0` marks that |

### 4.3 Seller profile → `SellerProfile`

Straight field rename; `loginId` derived from `seller.link`'s path segment, and
`resolved` is false when `seller` is missing or `name` is empty.

---

## 5. Phase 0: trial fixtures and open questions

**Status: executed on 2026-09-02** at 14 credits. The captures are in
`tests/fixtures/countdown/keyed/` with a README that answers the questions
below; §1.3 and §4 carry the corrections they forced. The capture script in
deliverable 1 is still to be written so the set can be refreshed; two profile
requests (an unavailable `/usr/` page and the `seller_name` form) never got past
the vendor's transient 500 and stay unverified.

Operator prerequisites: sign up at `https://app.countdownapi.com/signup` (free
trial, 100 requests, no card), create an API key, and export it into the
executing shell as `COUNTDOWN_API_KEY` only for the duration of this phase. The
key is never committed, echoed or written to a file under the repository.

Already done at zero credits (2026-09-02, checked in under
`tests/fixtures/countdown/demo/` with a README): the demo key's live responses
for ebay.ca search with and without the Toronto zip, ebay.ca search at
`num=240&max_page=2`, ebay.com search with the forwarder zip, and the
product-not-found shape on both domains. Those fixtures already back the §4.1
mapping rules; the keyed captures below add what the demo cannot: LEGO-specific
rows, live and ended item pages, and seller profiles. The capture script must
support `--demo` to refresh the demo set without a key.

Claude Code deliverables (branch `claude/countdown-api-deals-routine-1cm3of`
in mcp-ebay):

1. `tools/countdown/capture-fixtures.mjs`: reads the key from the environment,
   runs the request list below, scrubs `request_info` (credits) and any echo of
   the key, and writes `tests/fixtures/countdown/<name>.json`. Refuses to run
   without the key. Prints total credits spent.
2. The fixtures, checked in. Item ids below come from the routine's own
   improvement reports and from `ANALYSIS.md`'s "may still misbehave" list.
3. `docs/COUNTDOWN-API-PLAN.md` §1 corrected where a fixture disagrees.

Request list (credits in brackets; total ≤ 18):

| Fixture | Request | Question it answers |
|---|---|---|
| `search-ca-newly-listed.json` | `type=search ebay_domain=ebay.ca search_term="lego minifigure lot" sort_by=newly_listed num=240 customer_location=ca customer_zipcode="M6H 2W9"` [1] | row shape on ebay.ca; whether `shipping_cost` reflects the Toronto zip |
| `search-ca-seller-ssn.json` | `type=search url=https://www.ebay.ca/sch/i.html?_ssn=tweedsidesales&_nkw=lego&_sop=10&_ipg=240` [1] | seller-scoped passthrough; `epid` vs link item id |
| `search-com-forwarder.json` | `type=search ebay_domain=ebay.com search_term="lego printed tiles lot" customer_location=us customer_zipcode=34249 num=60` [1] | U.S. pass shape |
| `product-auction-with-bin.json` | `type=product url=https://www.ebay.ca/itm/287557851282` [1] | `auction` block, `end_date.utc`, currency handling |
| `product-ended.json` | `type=product url=https://www.ebay.ca/itm/198589141532` [1] | `end_date` shape on an ended listing |
| `product-sold-or-ended-2.json` | `type=product url=https://www.ebay.ca/itm/800523282681` [1] | whether a sold listing differs from an ended one (`offer.sale_date`?) |
| `product-redirected.json` | `type=product ebay_domain=ebay.ca epid=<a removed id from the dashboard's needs_revalidation set>` [1] | `redirected` shape |
| `product-com-ships-to.json` | `type=product url=https://www.ebay.com/itm/<a known Canada-excluding listing> customer_location=us` [1] | `shipping.ships_to` text for route eligibility |
| `product-with-html.json` | first product request again with `include_html=true` [1] | raw ebay.ca item HTML for the DOM extractor's fixture set |
| `seller-profile-url.json` | `type=seller_profile url=https://www.ebay.ca/usr/tweedsidesales` [1] | full profile shape |
| `seller-profile-unavailable.json` | `type=seller_profile url=https://www.ebay.ca/usr/audi2005store` [1] | what an unavailable profile returns (rendered an eBay error page in-run on 2026-09-02) |
| `seller-profile-name.json` | `type=seller_profile ebay_domain=ebay.ca seller_name=The_Brick_World` [1] | name-form shape |
| `account.json` | `/account` [0] | `zipcodes_limit`, plan fields |

Also record, in a short `tests/fixtures/countdown/README.md`: per-request wall
time, credits per request, whether any request returned 503, and the answers to
the questions above. Latency decides the tool timeouts in §2.

Acceptance: all fixtures present and scrubbed (grep for the key's first six
characters returns nothing), README written, credits spent ≤ 18, and §1 and §4
updated where needed. Commit as `P0:`-prefixed commits on the branch.

---

## 6. Phase 1: mcp-ebay implementation (one PR)

**Status: executed 2026-09-02** in mcp-ebay PR #36 (eight commits, one per work
package, plus the fixes from an adversarial review of the combined diff) and
PR #37 (per-call credit accounting after the live check).

Work on `claude/countdown-api-deals-routine-1cm3of`. Keep the compaction move
as its own commit so it is reviewable as a no-behaviour-change refactor.

### 6.1 Compaction package move

- Create `packages/compact/` (`@browser-bridge/compact`) scaffolded from
  `packages/site-zazzle`; move `apps/windows-agent/src/compact.ts` to
  `packages/compact/src/index.ts` byte-for-byte except import paths.
- `apps/windows-agent/src/compact.ts` becomes `export * from '@browser-bridge/compact';`
  so `executors.ts`, `jobs.ts` and `index.ts` need no edits; add the dependency
  to the agent's and the gateway's `package.json` and to `tests/package.json`.
- `tests/unit/compact.test.ts` must pass unchanged.

### 6.2 `packages/source-countdown`

- `src/client.ts`: `CountdownClient({ apiKey, baseUrl, fetchImpl, timeoutMs })`
  with `search(params)`, `product(params)`, `sellerProfile(params)`,
  `account()`. Builds the query with `URLSearchParams`, sets a request timeout
  with `AbortSignal.timeout`, retries twice on 5xx and network errors (2 s then
  6 s backoff; the vendor's transient `(G)` failure is uncharged and cleared on
  retry every time it was seen), maps status codes to the §2 error codes, strips the key from any error text, and
  returns `{ body, credits, requestId }`.
- `src/schemas.ts`: loose zod schemas for the three response types (every
  field optional; unknown fields allowed). Validation failures become
  `EXTRACTION_INCOMPLETE` with the failing path, never a crash.
- `src/map-search.ts`, `src/map-item.ts`, `src/map-seller.ts`: the §4 mappers,
  pure functions over the parsed body, returning `{ value, warnings }`.
- `src/index.ts` re-exports; `README.md` in the package states the facts from
  §1 the mappers depend on.

### 6.3 Protocol

- `packages/protocol/src/tools.ts`: `EbayApiSearchInput/Output`,
  `EbayApiItemsInput/Output` (output reuses `BatchExtractProgressShape`),
  `EbayApiSellerInput/Output`, a shared `EbayApiDestinationSchema`, and a
  `screenEbayUrl()` helper enforcing the §2 URL policy. Item-id shape is a
  10–14 digit string.
- `packages/protocol/src/catalog.ts`: `SOURCE_TOOL_CATALOG` with a
  `SourceToolCatalogEntry` type (`name`, `scope: SCOPE_READ`, `timeoutMs`,
  description, schemas) and `getSourceToolEntry()`. Timeouts: search
  `120_000` (five pages), items `120_000`, seller `30_000`. Do **not** add
  these to `TOOL_CATALOG`: the contract test pins that list at 18 browser
  tools, and these are not browser tools.
- `packages/protocol/src/errors.ts`: the three new codes.
- Descriptions must say, in one sentence each: what the tool is for, that
  shipping is never postal-code resolved, and that credits are spent.

### 6.4 Config

`packages/config/src/index.ts`: the §2 variables, with `COUNTDOWN_API_KEY`
transformed from `''` to `undefined`, a `countdown: {...} | null` block on
`GatewayConfig` derived the same way `dashboards` is, and a cross-field check
that `EBAY_FORWARDER_ZIPCODE` is five digits. Mirror the keys into
`deploy/env.example` with a comment block matching the dashboard section's tone.

### 6.5 Gateway

- `apps/gateway/src/countdown/tools.ts`: `registerSourceTools(server, deps, authInfo)`
  following `registerDashboardTool` in `apps/gateway/src/mcp/server.ts`:
  parse input defensively, assert `scopeSatisfies(scopes, SCOPE_READ)`, run the
  handler, return `content` + `structuredContent`, wrap failures with
  `errorResult(BridgeError.from(err))`. Annotations: `readOnlyHint: true`,
  `destructiveHint: false`, `idempotentHint: false` (credits are spent),
  `openWorldHint: true`.
- Credit reserve gate and last-known-credits memory live here; the items
  handler runs requests through a small promise pool bounded by
  `COUNTDOWN_MAX_CONCURRENCY` and preserves input order in the slots.
- One audit row per upstream call via `deps.store.audit.insert`, shaped like
  the broker's rows, never containing the key or the full outbound URL.
- `apps/gateway/src/app.ts`: construct `CountdownClient` when
  `config.countdown !== null`, pass it into `buildMcpServer`, and register the
  tools only then (absent tools are the documented "unconfigured" state).
- `apps/gateway/src/server.ts`: extend the pino `redact` paths.
- `tests/helpers/gatewayHarness.ts`: add `countdownFetch?: typeof fetch` and
  the config plumbing so integration tests can stub the vendor.

### 6.6 Tests

| Layer | File | Must prove |
|---|---|---|
| unit | `tests/unit/countdownMappers.test.ts` | every §4 rule against the demo and Phase 0 fixtures: item id from link not epid; currency parsed from `raw` with the domain fallback; `buy_it_now: false` never read as auction and priced rows read as fixed price; range rows (trailing ` to` stripped, two-entry ranges split, price-less rows kept with `priceRange: true`); condition normalisation; `located in ` stripped; `pagination.pages[]` folded; product-not-found → `unavailable`; auction price warning; `DESTINATION_UNVERIFIED` on every item; ended/sold/redirected statuses; seller login id from `/usr/` and `/str/` links; rewritten-row exclusion |
| unit | `tests/unit/countdownClient.test.ts` | query building; key never in thrown errors; 400/401→`SOURCE_REJECTED`, 402→`SOURCE_CREDITS_EXHAUSTED`, 429→`RATE_LIMITED`, 503→`SOURCE_UNAVAILABLE` with `retryAfter`, one retry on 500, timeout; `credits` parsed |
| unit | `tests/unit/countdownTools.test.ts` | reserve gate refuses at the threshold and lets seller calls through; destination mapping sends exactly the two configured zips; concurrency pool keeps slot order |
| unit | `tests/unit/compact.test.ts` | unchanged after the package move |
| contract | `tests/contract/toolSchemas.test.ts` | new `describe` for `SOURCE_TOOL_CATALOG`: three names, `browser:read`, valid inputs accepted with defaults, unknown fields rejected, `url` and `searchTerm` mutually exclusive, `maxPage` ≤ 5, `items` ≤ 25, bad hosts rejected; `TOOL_CATALOG` still 18 |
| security | `tests/security/ssrf.test.ts` | a non-eBay `url`, a private-network host and an `http://` URL are refused before any outbound call (assert the stub fetch was never invoked) |
| integration | `tests/integration/countdownTools.test.ts` | modelled on `dashboardTools.test.ts`: OAuth token with `browser:read` calls all three tools through the harness with a stubbed vendor; the key appears only in the outbound query string; a token lacking `browser:read` gets `ACTION_BLOCKED`; audit rows are written; `ebay_api_items` output validates against `ExtractManyOutput`; tools are absent when the key is unset |
| live | `tests/live/countdown.live.test.ts` | gated by `COUNTDOWN_LIVE=1` and the key; three requests, asserts shapes only; never in CI |

Run `pnpm build && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:contract && pnpm test:security && pnpm test:integration`
before pushing. `pnpm test:e2e` is unaffected but run it once.

### 6.7 Docs in this PR

- `docs/decisions/0003-countdown-api-source.md` (ADR, `Status: Proposed`):
  decision, scope reuse, the rejected `customer_zipcode` on products and the
  removed sold/completed parameters as constraints, the eBay Browse API as the
  alternative considered, and rollback (unset the key; tools vanish; the skill
  falls back to the Bridge path).
- `docs/ROUTINE.md`: a new budget table for a run that has the API tools.
  Target: `dashboard_feed` (1), `ebay_api_search` × 2 to 4 (broad sweeps and
  seller sweeps, one call per domain), `ebay_api_items` × 1 to 2 (shortlist and
  re-validation), `browser_session_open` + `browser_extract_many` +
  `browser_job_status` for the shipping pass on the shortlist (3), then the
  upserts. First write by call 6. Keep the "write after every batch" rule at the
  top.
- `README.md`: tool surface paragraph gains "three gateway-served `ebay_api_*`
  tools", the layout block gains the two packages, and the env section names
  the new variables.
- `deploy/env.example`: as in §6.4.

### 6.8 Acceptance

CI green on the PR; `pnpm test` green locally; the PR description lists the
fixture-backed answers from Phase 0 and any §1 correction. Open the PR against
`main` in mcp-ebay and subscribe to it.

---

## 7. Phase 2: FluxLab deploy config and operator rollout (one PR + operator steps)

**Status: executed 2026-09-02.** Repository side in FluxLab PR #121 (merged);
the operator rotated the key, put it in `vps/bridge/.env` and redeployed with
`make bridge`; the live check in `docs/live-checks/2026-09-02-countdown-live-check.md`
(mcp-ebay PR #37, merged) confirmed all three tools on the connector.

Claude Code, on `claude/countdown-api-deals-routine-1cm3of` in FluxLab:

1. `vps/bridge/.env.example`: add a `# ---- eBay API source (Countdown) ----`
   block after the site-profile section with `COUNTDOWN_API_KEY=` (empty, not a
   placeholder: `ensure_env_keys` refuses `CHANGE_ME`), and the optional knobs
   commented with their defaults. `EBAY_FORWARDER_ZIPCODE=34249`.
2. `vps/bridge/deploy.sh`: add `COUNTDOWN_API_KEY` and `EBAY_FORWARDER_ZIPCODE`
   to the `ensure_env_keys` list in `stage_env` so an existing `.env` gains the
   lines on the next deploy. The gateway service uses `env_file: .env`, so
   `docker-compose.yml` needs no change.
3. `docs/BUILD-SPEC.md` §10 (Browser Bridge): one paragraph naming the source,
   the env keys, and the rule that the key lives only in `vps/bridge/.env`.
4. `docs/BUILD-PROGRESS.md`: an entry under the bridge phase with NEXT ACTION
   set to the operator steps below.
5. `boards/` submodule pointer: unchanged in this PR (Phase 3 bumps it).

Operator steps (cannot be done by Claude Code; list them verbatim in the PR):

1. Choose the plan on `app.countdownapi.com` (Starter recommended; the trial
   key keeps working until its 100 requests are spent).
2. On the VPS: `printf 'COUNTDOWN_API_KEY=<key>\n' >> vps/bridge/.env` (or edit
   the empty line), then `make bridge` or `vps/bridge/deploy.sh`.
3. Confirm: gateway logs show the source tools registered; from an interactive
   Claude session attached to the connector, `ebay_api_seller` with
   `loginId: tweedsidesales` returns `resolved: true` and one credit is
   consumed (visible in `credits.remaining`).

Acceptance: PR merged, deploy done, the three tools visible on the connector,
one live call verified.

---

## 8. Phase 3: skill and routine integration (fluxlab-boards, one PR)

**Status: implemented 2026-09-03** in fluxlab-boards PR #25 (skill bullet, prompt
step 4 and 9, README rules 1 and 4, queue-contract component); the operator's
re-save of the routine prompt and the FluxLab submodule bump follow the merge.

Claude Code, on `claude/countdown-api-deals-routine-1cm3of` in fluxlab-boards.
Gate: Phase 2 acceptance holds; the skill must never reference tools the
connector does not serve.

1. `.claude/skills/fluxology-deals-run/SKILL.md`, OPERATIONS section, new
   bullet **"eBay API source (added <date>)"** placed before "Call budget":
   - Track A sweeps, watched-seller drill-downs and login-id verification go
     through `ebay_api_search`, `ebay_api_items` and `ebay_api_seller` when the
     tools are present; the Bridge path in the existing bullets is the fallback
     when they are absent or answer `SOURCE_*` errors, and the fallback is
     reported as such in the completion report.
   - Audit counts come from `totalResults`, `candidateCount` and the warning
     counts of the API response, same rule as today.
   - An `ebay_api_items` slot with `ok:true` is a current direct canonical fetch
     of the item page and satisfies canonical validation for item id, title and
     availability status, and for price on a fixed-price row
     (`validationStatus: live_canonical_verified`). It establishes nothing about
     an auction beyond identity and availability: the vendor reports live
     auctions as fixed price, so every bid, end time and max-bid figure comes
     from the Bridge item page.
   - Shipping from this source is never destination-resolved: every API item
     carries `DESTINATION_UNVERIFIED`, `shippingResolved` stays false, and no
     record may go `active:true` with a landed figure until the Bridge pass on
     the shortlist proves the number on an M6H 2W9-resolved page. The
     `US_FORWARDER_MYUS` route may cite the API's U.S. domestic rate only as the
     policy's "domestic proxy", never as the MyUS-address quote.
   - `ebay_api_seller` on `/usr/<loginId>` is the profile confirmation of
     login-id rules 1 and 4; `loginIdEvidence` is that `/usr/` URL.
   - A search row's `shippingCost` under `destination: 'toronto'` is eBay's own
     rendered estimate for M6H 2W9 (the zip reaches eBay as `_stpos`). It may
     drive triage and a provisional max-bid figure and is recorded as a
     card-level observation with `shippingResolved: false`; a null means the
     card showed nothing readable, never free shipping.
   - A row with `priceRange: true` and no `snippetPrice` is a variant listing
     whose card price the source lost, not a listing without a price: open it
     with `ebay_api_items` before any price-based exclusion, and read the
     `PRICE_RANGE_UNPARSED` and `EXCLUDED_NO_PRICE` counts into the audit.
   - The completion report gains one line: credits used this fire and credits
     remaining, read from the last response.
   - The challenge-wall bullet applies to Bridge navigation only.
2. `docs/routines/fluxology-deals-run.prompt.txt`, step 4: name the API tools
   first and the Bridge second, with the same "an unloaded schema is not
   absence" probe rule. Keep every other step verbatim.
3. `data/deals/README.md`, "Seller-watch login ids" rules 1 and 4: an
   `ebay_api_seller` result for the `/usr/` URL counts as the profile page;
   `tools/check-seller-watch.mjs` needs no change (it validates an https URL).
4. `docs/improvement-queue/`: nothing is filed by this PR. Note in the PR body
   that the open report `usr-profile-page-dispatched-as-item-page` is
   sidestepped, not fixed; the improvement pass records the resolution in the
   ledger when it processes the queue, and the extractor fix stays optional.
5. Operator step, after merge: open the **FluxLab Deals Dashboard** routine in
   the claude.ai routine editor and paste the updated prompt from
   `docs/routines/fluxology-deals-run.prompt.txt`. The routine was created in
   the web UI and must stay web-managed (see `docs/routines/CONNECTOR-APPROVALS.md`);
   do not recreate it through the API.

Acceptance: data-validators workflow green; SKILL.md diff reviewed against the
rules above; routine prompt re-saved by the operator; FluxLab `boards/`
submodule bumped in a follow-up commit on the FluxLab branch.

---

## 9. Phase 4: first supervised fire and tuning

1. Let the next scheduled fire run (or fire the routine from the web UI) and
   read its completion report.
2. Compare against `docs/ROUTINE.md`'s ledger: tool calls to first write, calls
   total, records inspected per track, credits used, any `SOURCE_*` error, any
   Bridge fallback.
3. File one improvement-queue report per new defect under fingerprint component
   `source-countdown` (add that component to `IMPROVEMENT-QUEUE-CONTRACT.md`'s
   table in the Phase 3 PR).
4. Tune in a follow-up PR on the same branches: seller-sweep cadence (once a
   day versus every fire), `maxPage` for broad sweeps, the credit reserve, and
   whether the ebay.com seller pass is worth its credits for Canadian sellers.

Acceptance: two consecutive fires with a first write by call 8 or earlier, no
Bridge fallback on the sweep phase, and monthly credit projection under the
plan's cap.

**Phase 4 status (2026-09-03).** The first fire on the eBay API path
(2026-09-03T07:13Z) was zero-coverage: the Windows device was offline for the
whole fire, so the Bridge fallback had nothing either; the reserve gate
refused every `ebay_api_search` and `ebay_api_items` call because the 500
reserve was above the trial balance of 83; one `ebay_api_seller` lookup
spent one credit, leaving 82. The manual fire at 11:27Z then met the
vendor's suspension of the trial account after one seller lookup (80 left),
and three searches hung past the client's 60 s on the gate's account probe.
What this change ships: the plan-relative reserve (`5%` default, the
unsatisfiable-absolute refusal), the credit-free `ebay_api_status` tool and
the never-spend-on-unknown rule, deadlines under the client's 60 s with
partial item batches, the suspension mapping and memory, and the probe on
its own 8 s terms. Acceptance still needs two consecutive fires. On the
budget: the trial's one-time 100 requests cannot fund a single fire at the
§11 model (120–150 requests); Hobbyist's 500 a month funds about three
fires; Starter (10,000) is the plan for two fires a day.

## 10. Phase 5 (optional): Collections pre-run

Only if Phase 4 shows wall-clock pressure (a five-page search near the tool
timeout) or the credit projection benefits from batching:

- Gateway CLI subcommand `countdown:collection sync` that builds one collection
  per fire window from `data/deals/seller-watch.json` and the sweep vocabulary,
  scheduled `daily` at `schedule_hours` matching the routine's cron in the
  account's timezone, with the webhook pointed at a new gateway endpoint.
- A read tool `ebay_api_collection_results` that returns the latest result set
  in the `ebay_api_search` output shape.
- Credits are identical; the win is zero sweep calls inside the routine.

---

## 11. Budget model and guardrails

Modelled from the current roster (23 watched sellers, 15 with recorded login
ids), the two-domain rule in `multi-path-shipping-policy.json`, two fires a day
and single 240-row pages. Not measured; Phase 4 replaces it with a measured row.

| Step | Requests per fire |
|---|---|
| Broad sweeps: ten queries × two domains × two vendor requests each (`buy_it_now` + `auction`) | 40 |
| Watched-seller sweeps: 23 sellers × two domains | 46 |
| Item pages: shortlist plus re-validation of active eBay records | 30 to 60 |
| Seller-profile verifications | 0 to 2 |
| **Per fire** | **≈ 120 to 150** |
| **Per month at two fires a day** | **≈ 7,000 to 9,000** |

Guardrails: the reserve gate (`COUNTDOWN_CREDIT_RESERVE`), the `maxPage ≤ 5`
schema bound, the 25-item batch bound, and the completion-report credits line.
Sweeping sellers once a day instead of every fire saves roughly 1,400 requests
a month if the cap is ever in reach.

Measured: none yet — the 2026-09-03 fires spent one credit each before the
gate and then the suspension stopped them (§9).

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `epid` mistaken for the item id | item id always from the link; unit test on the docs' own counter-example |
| Vendor parse defects on range rows (lost prices, ` to` titles) | mapper marks `priceRange`, keeps the row, counts it; skill opens such rows before excluding on price |
| Auctions invisible to the vendor (unfiltered rows and item pages both read fixed price) | format only from split searches; item tool takes `expectedFormat` and nulls auction prices; the Bridge owns bids, end times and landed math |
| Item-page shipping resolved to the vendor's own zip | recorded as observed text with no destination; never a Canadian figure; `ships_to` never used for route eligibility |
| Unreliable flags (`sponsored` always false, `buy_it_now` false on fixed-price rows) | neither is used as a signal; format comes from `is_auction` plus price presence |
| Transient vendor 500s (`(G)`), uncharged | two retries with backoff in the client; `SOURCE_UNAVAILABLE` only after both fail |
| Response shape changes with `max_page` > 1 | handler accepts both `pagination` shapes; fixture-backed test |
| Vendor parse drift or incident | 503 maps to `SOURCE_UNAVAILABLE` with `retryAfter`; the skill falls back to the Bridge and says so; `skip_on_incident` is sent |
| Shipping figures read as Toronto quotes | `DESTINATION_UNVERIFIED` on every API item, `destinationVerified:false` in the record, skill rule in §8 |
| Currency on ebay.ca rows for U.S. sellers | `parseMoney` on raw strings; `winning_bid_price_converted` kept as a separate field; fixture-backed |
| Latency on multi-page searches | `maxPage` default 1; tool timeout 120 s; Phase 0 records real latency |
| Key leakage | env-only, redact list, error text scrubbed, tests assert the key appears only in the outbound query |
| Zip-code cap on the plan | only two zips are ever sent, both from config |
| Credit exhaustion mid-run | reserve gate plus explicit error; the routine's NO-SILENCE rule reports it |
| Skill references tools that are not deployed | Phase 3 gated on Phase 2 acceptance; skill keeps the Bridge fallback |
| Vendor slower than the client budget (60 s; §1.4) | every tool answers inside its deadline: an item batch returns partial with the ids to re-request, a search fails naming `possiblyCharged` and may need a narrower `num`; per-request timeout ≤ 48 s so a slow request fails on its own terms first |
| Reserve unsatisfiable by the plan, or the vendor suspends the account | percent reserve by default and an explicit `reserve_not_below_plan_limit` refusal naming the fix; a suspension 402 is `SOURCE_REJECTED` (`account_suspended`), remembered five minutes, reported by `ebay_api_status` — never "top up" |

---

## 13. Kickoff prompts for Claude Code

Phase 0 (operator exports `COUNTDOWN_API_KEY` in the shell first):

> Read `docs/COUNTDOWN-API-PLAN.md` in mcp-ebay and execute Phase 0 on branch
> `claude/countdown-api-deals-routine-1cm3of`: write
> `tools/countdown/capture-fixtures.mjs`, capture the fixtures in §5 with the
> key from the environment, scrub them, write the fixtures README with the
> answers to §5's questions, correct §1 and §4 where a fixture disagrees, commit
> with a `P0:` prefix and push. Spend at most 18 credits.

Phase 1:

> Read `docs/COUNTDOWN-API-PLAN.md` in mcp-ebay and execute Phase 1 on branch
> `claude/countdown-api-deals-routine-1cm3of`: the compaction package move as
> its own commit, then the source package, protocol, config, gateway, tests and
> docs in §6. Run the full check list in §6.6 before pushing, open the PR
> against main, and subscribe to it.

Phase 2:

> Read `docs/COUNTDOWN-API-PLAN.md` in the mcp-ebay checkout and execute Phase 2
> in FluxLab on branch `claude/countdown-api-deals-routine-1cm3of`; list the
> operator steps from §7 verbatim in the PR body.

Phase 3:

> Phase 2 acceptance holds. Read `docs/COUNTDOWN-API-PLAN.md` in the mcp-ebay
> checkout and execute Phase 3 in fluxlab-boards on branch
> `claude/countdown-api-deals-routine-1cm3of`; do not touch any routine other
> than the current FluxLab Deals Dashboard routine's prompt file.
