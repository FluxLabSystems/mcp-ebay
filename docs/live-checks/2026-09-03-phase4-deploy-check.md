# 2026-09-03 Phase 4 deploy check (Countdown tools + device)

Read-only verification of the FluxLab Browser Bridge gateway after the
operator ran `make bridge` on the VPS at about 2026-09-03T10:50Z. Checkout
was `claude/countdown-api-deals-routine-1cm3of` at `03acf1d` (equal to
`main`). No bid, buy, offer, message, cart, watchlist or navigation action
was taken. At most one vendor credit may have been spent (see step 3).

## Step 1: tool discovery

ToolSearch queries `ebay_api`, `browser_session_open` and `dashboard_feed`
were run at about 2026-09-03T11:06Z. The connector segment is a bare UUID.
Exact full tool names as served:

| Tool | Full name |
| --- | --- |
| ebay_api_search | `mcp__7c681ea3-fac7-4d7e-8785-39381428b0bc__ebay_api_search` |
| ebay_api_items | `mcp__7c681ea3-fac7-4d7e-8785-39381428b0bc__ebay_api_items` |
| ebay_api_seller | `mcp__7c681ea3-fac7-4d7e-8785-39381428b0bc__ebay_api_seller` |
| browser_session_open | `mcp__7c681ea3-fac7-4d7e-8785-39381428b0bc__browser_session_open` |
| dashboard_feed | `mcp__7c681ea3-fac7-4d7e-8785-39381428b0bc__dashboard_feed` |

No other `ebay_api_*` tool is served on the connector. The deferred-tool
listing for the connector shows exactly three: `ebay_api_items`,
`ebay_api_search`, `ebay_api_seller`.

## Step 2: served descriptions (verbatim)

### ebay_api_search

> Search eBay (ebay.ca or ebay.com) through the Countdown API instead of the browser, by searchTerm or by your own https eBay /sch/ URL, and return the same compacted candidate list browser_open_and_extract returns for a search page, so the usual audit and filter rules apply unchanged. Every page fetched spends one vendor credit (maxPage is capped at 5), and listingType 'all' costs two vendor requests per page — a buy_it_now search and an auction search merged by item id — because an unfiltered search cannot tell an auction from a fixed price. What this call spent is credits.usedThisRequest (both requests of a split search); credits.used is the account's month-to-date total, not this call's spend; credits.remaining is the balance to put in the completion report. requestIds is empty when the vendor omits request ids, which it did on every observed response. destination is a named value: 'toronto' makes a row's shippingCost eBay's own card estimate for the Toronto postal code, 'forwarder' uses the US forwarder suite, and 'domain_default' sends no location; a shippingCost of null means the card showed nothing readable, never free. Rows carry no bid count or time left (the default field list omits bidCount, and it is null when search.fields asks for it); bids and end times come only from the Bridge item page, and auction prices only from the Bridge browser tools. With a url, sortBy, listingType, condition, categoryId and page are refused because the vendor ignores them; put them in the URL's query string instead. The returned window defaults to search.limit 240 (a whole page) because paging with search.offset re-issues the vendor requests and spends credits again; narrow or raise search.limit instead of paging. Requires scope browser:read.

### ebay_api_items

> Read up to 25 eBay item pages through the Countdown API in one call, by itemId or by https /itm/ URL, and return one browser_extract_many-style result slot per input in input order (mode 'inline', jobId null), so only slots with ok:true are upsert candidates and a LISTING_UNAVAILABLE slot keeps its record as evidence. Each item spends one vendor credit: what this call spent is credits.usedThisRequest, summed over every item the vendor answered; credits.used is the account's month-to-date total, not this call's spend; credits.remaining is the balance to put in the completion report. requestIds is empty when the vendor omits request ids, which it did on every observed response. Item-page shipping from this source is never resolved to a postal code and is not a Canadian figure: the vendor's browser resolves delivery to its own US zip whatever destination says, so every slot carries a DESTINATION_UNVERIFIED warning and the Bridge shipping pass is still required for a landed cost. Pass expectedFormat from the search that found the row: the vendor's item page reports live auctions as fixed price, so an auction slot returns no price, bids or end time (AUCTION_DETAIL_UNAVAILABLE_FROM_SOURCE) — auction prices come only from the Bridge. Without expectedFormat a slot's format is unknown and its price is unconfirmed (PRICE_UNCONFIRMED, confidence 0.4): pass expectedFormat from the search that found the row before treating a price as purchasable. A slot that fails maps its own error and never fails the batch. Requires scope browser:read.

### ebay_api_seller

> Look up one eBay seller profile through the Countdown API, by loginId or by https /usr/ or /str/ URL, for the seller-confirmation step of the deals rules: name, profile URL, login id or store slug, member-since, positive-feedback percent, followers, location, top-rated flag and a short description, each null when the vendor did not return it; when member-since, location, top-rated and description are all missing, warnings carries SELLER_FIELDS_ABSENT_FROM_SOURCE so omission is not mistaken for absence. resolved is false when the vendor returned no seller block, and the vendor's message is then in warnings. Each call spends one vendor credit, even when nothing resolves: what this call spent is credits.usedThisRequest; credits.used is the account's month-to-date total, not this call's spend; credits.remaining is the balance to put in the completion report. requestIds is empty when the vendor omits request ids, which it did on every observed response. This tool reads no listing, so it carries no price and no shipping figure; item-page shipping and auction prices are the concern of ebay_api_items and the Bridge. Requires scope browser:read.

### credits output schema

The served tool definitions carry an input schema only. No output schema
(and therefore no `credits` object with `used`, `remaining`,
`usedThisRequest` property descriptions) is exposed through ToolSearch for
any of the three tools. The only served text about `credits` is the
sentence repeated in each description above:

> What this call spent is credits.usedThisRequest ...; credits.used is the account's month-to-date total, not this call's spend; credits.remaining is the balance to put in the completion report.

Served input schemas, for the record:

- `ebay_api_search`: `allowRewrittenResults`, `categoryId`, `condition`
  (all|new|used), `destination` (toronto|forwarder|domain_default),
  `domain` (ebay.ca|ebay.com), `listingType`
  (all|buy_it_now|auction|accepts_offers), `maxPage` (1..5), `num`
  (60|120|240), `page`, `search` {canonicalizeUrls, fields, include
  {formats, maxPrice, minPrice, titleRegex}, limit (1..240), offset},
  `searchTerm`, `sortBy`, `url`.
- `ebay_api_items`: `compact`, `destination`, `domain`, `items` (1..25 of
  {itemId, expectedFormat} or {url, expectedFormat}).
- `ebay_api_seller`: `domain`, `loginId`, `url`.
- `browser_session_open`: `deviceId` (required), `profileName`
  (default `ebay-research`).

## Step 3: ebay_api_search (one call)

Issued at about 2026-09-03T11:07:44Z with exactly:

```json
{"searchTerm":"lego minifigure lot","domain":"ebay.ca","destination":"toronto","listingType":"buy_it_now","search":{"limit":5}}
```

Result: neither the expected `SOURCE_CREDITS_EXHAUSTED` gate refusal nor a
success. The MCP client timed out at about 2026-09-03T11:08:44Z. Full
error text as received (no JSON body was returned):

```text
MCP server "7c681ea3-fac7-4d7e-8785-39381428b0bc" tool "ebay_api_search" timed out after 60s
```

A gate refusal is a local check and returns immediately, so a 60 s hang
indicates the request passed the gate and went upstream to the vendor (or
the gateway stalled before answering). Whether the vendor served the page
and charged one credit is unknown from this side. The call was not
retried.

## Step 4: ebay_api_seller

Skipped. Step 4 was conditioned on step 3 being refused by the gate. Step 3
was not refused, and it may already have spent one credit, so a seller
call could have taken the total past the one-credit cap. No seller lookup
was made.

## Step 5: browser_session_open (one call)

Issued at about 2026-09-03T11:07:44Z with `{"deviceId":"default"}`.
Result (success):

```json
{"browserSessionHandle":"bs_RDwlRYff-MW3iJK3PdxTeA","deviceId":"dev_01M0Z171ZYZADPN9371VYSZEEG","profileName":"ebay-research","status":"ready","tabs":[{"tabId":"tab_01M1HVMET99SKZ4D2Q73MPZ84M","url":"https://www.kijiji.ca/b-city-of-toronto/lego/k0l1700273?sort=dateDesc","title":"3,925 ads for lego in All Categories in City of Toronto | Kijiji Marketplaces","active":true,"pageRevision":96}]}
```

No other `browser_*` tool was called afterwards. The existing tab was left
as found.

## Findings

- **(a) Served build.** The served descriptions of all three
  `ebay_api_*` tools document `credits.used` as "the account's
  month-to-date total, not this call's spend" and name
  `credits.usedThisRequest` as this call's spend. That is the 2026-09-03
  wording; the older "credits.used reports both" / bare "Each call spends
  one vendor credit" phrasing is not present. No output schema is served,
  so the `credits` property descriptions could not be checked from a
  schema, only from the description text.
- **(b) Live reserve and remaining credits.** Not established. The one
  permitted search call timed out at the client after 60 s without a
  gate refusal, so no `credits`, `creditsRemaining` or `creditReserve`
  value was observed. The seller call was skipped to honour the
  one-credit cap. A follow-up check should first confirm with the operator
  whether the timed-out request was charged.
- **(c) Windows device.** Online. `browser_session_open` for
  `deviceId: "default"` resolved to device `dev_01M0Z171ZYZADPN9371VYSZEEG`
  with status `ready`, profile `ebay-research`, and one open tab.
- **Note on the timeout.** A 60 s client timeout on a gated Countdown call
  is itself a deploy finding: either the gate is not refusing on an
  exhausted balance (the expected outcome), or the vendor round-trip is
  slower than the MCP client budget. Worth checking the gateway logs for
  the 11:07Z request.
