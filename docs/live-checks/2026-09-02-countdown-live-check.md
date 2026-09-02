# Live check: `ebay_api_*` tools on the redeployed gateway

- **UTC time:** 2026-09-02, calls issued at 22:23:09Z, all results in hand by 2026-09-02T22:24:48.208602269Z (batch bracket 99.0 s; this is an upper bound, because the end stamp was taken after the batch returned and includes the agent turn in between, so the true vendor latency is shorter).
- **Connector as listed by ToolSearch:** the server segment of the tool names is the UUID `7c681ea3-fac7-4d7e-8785-39381428b0bc`, not `FluxLab_Browser_Bridge` or `FluxLab-Browser-Bridge`. The same server also carries the `browser_*`, `dashboard_*` and `deals_run_*` tools, so it is the FluxLab Browser Bridge connector under its internal id.
- **Three tools present:** yes. The keyword probe `ToolSearch("ebay_api")` returned exactly `ebay_api_items`, `ebay_api_search` and `ebay_api_seller` with full schemas. The `select:` probe by the FluxLab-spelled names was therefore not needed and was not run.
- **Credits budget:** 3 allowed, 3 spent by design (1 seller lookup + 1 search page + 1 item page). No retries were needed.
- **Key safety:** no output from any call contained an `api_key` / `apiKey` field or a 32-character hex string. Nothing was redacted.
- **Wall time caveat:** the three calls were issued in parallel in one batch, so only the batch wall time is measurable; per-call figures below are that same bracket.

## Tool descriptions as returned by ToolSearch

### `ebay_api_items`

> Read up to 25 eBay item pages through the Countdown API in one call, by itemId or by https /itm/ URL, and return one browser_extract_many-style result slot per input in input order (mode 'inline', jobId null), so only slots with ok:true are upsert candidates and a LISTING_UNAVAILABLE slot keeps its record as evidence. Each item spends one vendor credit. Item-page shipping from this source is never resolved to a postal code and is not a Canadian figure: the vendor's browser resolves delivery to its own US zip whatever destination says, so every slot carries a DESTINATION_UNVERIFIED warning and the Bridge shipping pass is still required for a landed cost. Pass expectedFormat from the search that found the row: the vendor's item page reports live auctions as fixed price, so an auction slot returns no price, bids or end time (AUCTION_DETAIL_UNAVAILABLE_FROM_SOURCE) — auction prices come only from the Bridge. Without expectedFormat a slot's format is unknown and its price is unconfirmed (PRICE_UNCONFIRMED, confidence 0.4): pass expectedFormat from the search that found the row before treating a price as purchasable. A slot that fails maps its own error and never fails the batch. Requires scope browser:read.

### `ebay_api_search`

> Search eBay (ebay.ca or ebay.com) through the Countdown API instead of the browser, by searchTerm or by your own https eBay /sch/ URL, and return the same compacted candidate list browser_open_and_extract returns for a search page, so the usual audit and filter rules apply unchanged. Every page fetched spends one vendor credit (maxPage is capped at 5), and listingType 'all' costs two vendor requests per page — a buy_it_now search and an auction search merged by item id — because an unfiltered search cannot tell an auction from a fixed price; credits.used reports both. destination is a named value: 'toronto' makes a row's shippingCost eBay's own card estimate for the Toronto postal code, 'forwarder' uses the US forwarder suite, and 'domain_default' sends no location; a shippingCost of null means the card showed nothing readable, never free. Rows carry no bid count or time left: bidCount is always null, and auction bids, end times and prices come only from the Bridge browser tools. With a url, sortBy, listingType, condition, categoryId and page are refused because the vendor ignores them; put them in the URL's query string instead. The returned window defaults to search.limit 240 (a whole page) because paging with search.offset re-issues the vendor requests and spends credits again; narrow or raise search.limit instead of paging. Requires scope browser:read.

### `ebay_api_seller`

> Look up one eBay seller profile through the Countdown API, by loginId or by https /usr/ or /str/ URL, for the seller-confirmation step of the deals rules: name, profile URL, login id or store slug, member-since, positive-feedback percent, followers, location, top-rated flag and a short description, each null when the vendor did not return it. resolved is false when the vendor returned no seller block, and the vendor's message is then in warnings. Each call spends one vendor credit, even when nothing resolves. This tool reads no listing, so it carries no price and no shipping figure; item-page shipping and auction prices are the concern of ebay_api_items and the Bridge. Requires scope browser:read.

## Call 1: `ebay_api_seller`

**Input**

```json
{"loginId": "tweedsidesales", "domain": "ebay.ca"}
```

**Output**

```json
{
  "resolved": true,
  "seller": {
    "name": "Jeremy Doherty",
    "profileUrl": "https://www.ebay.ca/usr/tweedsidesales",
    "loginId": "tweedsidesales",
    "storeSlug": "jeremydoherty",
    "memberSince": null,
    "positivePercent": 99.8,
    "followers": "79 followers",
    "location": null,
    "topRated": null,
    "description": null
  },
  "warnings": [],
  "credits": {"used": 15, "remaining": 85},
  "requestIds": []
}
```

**Wall time:** within the 99.0 s batch bracket (parallel with calls 2 and 3).

**Interpretation:** the seller resolved with name, profile URL, login id, store slug and feedback percent; member-since, location, top-rated and description came back null with no warning explaining why, and `followers` is the raw display string rather than a number.

## Call 2: `ebay_api_search`

**Input**

```json
{
  "domain": "ebay.ca",
  "searchTerm": "lego minifigure lot",
  "listingType": "auction",
  "sortBy": "newly_listed",
  "num": 60,
  "destination": "toronto",
  "search": {"limit": 5}
}
```

**Output**

```json
{
  "source": "countdown",
  "siteProfile": "ebay.api.v1",
  "pageKind": "search",
  "pageUrl": "https://www.ebay.ca/sch/i.html?_nkw=lego+minifigure+lot&_sacat=0&LH_Auction=1&_sop=10&_dmd=1&_ipg=60&_fcid=2&_stpos=M6H2W9",
  "domain": "ebay.ca",
  "destination": "toronto",
  "retrievedUnder": ["auction"],
  "totalResults": 570,
  "candidateCount": 60,
  "pagesFetched": 1,
  "hasNextPage": true,
  "candidates": [
    {
      "itemId": "267774490860",
      "url": "https://www.ebay.ca/itm/267774490860",
      "title": "Lego Prince of Persia Minifigures and printed horse JOB LOT",
      "snippetPrice": {"value": 15.01, "currency": "CAD"},
      "priceRange": false,
      "sellingFormat": "auction",
      "shippingCost": 29.94,
      "condition": "Pre-Owned",
      "itemLocationText": "united kingdom",
      "sellerName": null
    },
    {
      "itemId": "820080005903",
      "url": "https://www.ebay.ca/itm/820080005903",
      "title": "Lego Pirates themed Minifigures and accessories JOB LOT Soldiers, Officers etc",
      "snippetPrice": {"value": 15.01, "currency": "CAD"},
      "priceRange": false,
      "sellingFormat": "auction",
      "shippingCost": 29.94,
      "condition": "Pre-Owned",
      "itemLocationText": "united kingdom",
      "sellerName": null
    },
    {
      "itemId": "267774478624",
      "url": "https://www.ebay.ca/itm/267774478624",
      "title": "Lego Star Wars themed Minifigure parts and accessories JOB LOT various",
      "snippetPrice": {"value": 18.76, "currency": "CAD"},
      "priceRange": false,
      "sellingFormat": "auction",
      "shippingCost": 31.95,
      "condition": "Pre-Owned",
      "itemLocationText": "united kingdom",
      "sellerName": null
    },
    {
      "itemId": "377465923514",
      "url": "https://www.ebay.ca/itm/377465923514",
      "title": "LEGO Elves Bulk Mixed Lot everything there Manuals, Minifigures Friends 14 sets",
      "snippetPrice": {"value": 93.91, "currency": "CAD"},
      "priceRange": false,
      "sellingFormat": "auction",
      "shippingCost": 75.13,
      "condition": "Pre-Owned",
      "itemLocationText": "united kingdom",
      "sellerName": null
    },
    {
      "itemId": "398351511085",
      "url": "https://www.ebay.ca/itm/398351511085",
      "title": "LEGO City Arctic Job Lot Sets 60036 & 60034 Manuals Minifigs Polar Bear G697 C13",
      "snippetPrice": {"value": 16.81, "currency": "CAD"},
      "priceRange": false,
      "sellingFormat": "auction",
      "shippingCost": 66.04,
      "condition": "Pre-Owned",
      "itemLocationText": "united kingdom",
      "sellerName": null
    }
  ],
  "offset": 0,
  "hasMore": true,
  "nextOffset": 5,
  "warnings": [
    "BID_COUNT_UNAVAILABLE_FROM_SOURCE: search rows carry no bid count or time left; bidCount is null on every candidate.",
    "CANDIDATE_FIELDS_NULL: unreadable on some of the 5 returned candidate(s): sellerName on 5.",
    "OFFSET_PAGING_REISSUES_REQUESTS: paging with search.offset re-issues the vendor requests and spends credits again; raise search.limit instead"
  ],
  "credits": {"used": 15, "remaining": 85},
  "requestIds": []
}
```

Summary fields: totalResults 570, candidateCount 60, pagesFetched 1, hasNextPage true, retrievedUnder ["auction"].

**Wall time:** within the 99.0 s batch bracket (parallel with calls 1 and 3).

**Interpretation:** one auction page of 60 rows was fetched for one credit, the Toronto destination reached the vendor (the page URL carries `_stpos=M6H2W9` and `_fcid=2`) and every row has a numeric shipping estimate, but sellerName is null on all five returned rows and the "newly listed" window was entirely UK-located job lots.

## Call 3: `ebay_api_items`

**Input**

```json
{
  "domain": "ebay.ca",
  "destination": "toronto",
  "items": [{"itemId": "331982822376", "expectedFormat": "fixed_price"}]
}
```

**Output**

```json
{
  "mode": "inline",
  "jobId": null,
  "status": "completed",
  "requested": 1,
  "completed": 1,
  "succeeded": 1,
  "failed": 0,
  "compact": true,
  "resultsFrom": 0,
  "results": [
    {
      "url": "https://www.ebay.ca/itm/331982822376",
      "finalUrl": "https://www.ebay.ca/itm/331982822376?_fcid=2",
      "ok": true,
      "siteProfile": "ebay.api.v1",
      "pageRevision": 0,
      "record": {
        "itemId": "331982822376",
        "canonicalUrl": "https://www.ebay.ca/itm/331982822376",
        "title": "LEGO - Printed Tiles Lot 1x1 1x2 2x2 - Decorated Flat Plate Smooth Round Square",
        "seller": null,
        "itemLocationText": "Reno, Nevada, United States",
        "sellingFormat": {"kind": "fixed_price", "bidCount": null},
        "listingStatus": "active",
        "endsAt": null,
        "itemPrice": {"value": 2.29, "currency": "CAD"},
        "shipping": {
          "value": 7.95,
          "currency": "CAD",
          "destinationVerified": false,
          "serviceText": "7.95 (Standard Shipping)"
        },
        "offerAvailable": false,
        "quantityAvailable": 5,
        "quantitySold": 121,
        "watcherCount": null,
        "warnings": [
          "SELLER_LOGIN_ID_UNAVAILABLE: the seller link is a store page (/str/almtshop88); a store slug is not a login id. Resolve it with the seller tool before matching the roster.",
          "DESTINATION_UNVERIFIED: item-page shipping from this source is resolved to the vendor's own location, never to a postal code"
        ]
      },
      "warnings": [
        "SELLER_LOGIN_ID_UNAVAILABLE: the seller link is a store page (/str/almtshop88); a store slug is not a login id. Resolve it with the seller tool before matching the roster.",
        "DESTINATION_UNVERIFIED: item-page shipping from this source is resolved to the vendor's own location, never to a postal code"
      ],
      "error": null
    }
  ],
  "warnings": [],
  "source": "countdown",
  "credits": {"used": 15, "remaining": 85},
  "requestIds": []
}
```

Summary fields: status completed, requested 1, completed 1, succeeded 1, failed 0; slot ok true, siteProfile `ebay.api.v1`, error null.

**Wall time:** within the 99.0 s batch bracket (parallel with calls 1 and 2).

**Interpretation:** the item resolved as an active fixed-price listing with a CAD price and an unverified shipping figure, exactly the shape the description promises, and the seller slot is null with an explanatory warning because the page links a store slug instead of a login id.

## Findings

1. **`credits` is not a per-call figure.** All three calls, each expected to spend exactly one credit, returned the identical `{"used": 15, "remaining": 85}`. Either the block is an account-level snapshot read before the call's own spend landed, or the three parallel calls all read the same stale counter. `credits.used` did not report "1" for any call, which contradicts the search tool's own description ("credits.used reports both" vendor requests). Worth a follow-up call in isolation to see whether `remaining` moves to 82.
2. **`requestIds` is an empty array on every call**, so there is no vendor request id to quote back to the vendor if a result is disputed.
3. **Seller block is sparse with no warning:** `memberSince`, `location`, `topRated` and `description` are null on a real, resolved store seller, and `warnings` is empty, so the caller cannot tell "vendor omitted it" from "the seller has none".
4. **`followers` is a display string** (`"79 followers"`), not a number, on the seller result.
5. **`sellerName` is null on every search row** (5 of 5, flagged by CANDIDATE_FIELDS_NULL). Roster matching from a Countdown search therefore always needs the seller tool or the Bridge.
6. **Search rows carry no `bidCount` key at all** in compact form, while the BID_COUNT_UNAVAILABLE_FROM_SOURCE warning says "bidCount is null on every candidate". Harmless, but the warning text and the shape disagree.
7. **`candidateCount` is the whole page (60), not the returned window (5)**, with `hasMore` / `nextOffset` describing the window. This matches the browser search shape but is easy to misread.
8. **Item-page warnings are duplicated** verbatim at `results[].warnings` and `results[].record.warnings`, while the top-level `warnings` is empty.
9. **The `_fcid=2` parameter is appended to `finalUrl` and to the search `pageUrl`**, confirming the vendor is being asked for the Canadian site; the Toronto postal code appears only on the search URL (`_stpos=M6H2W9`), not on the item page, consistent with DESTINATION_UNVERIFIED.
10. **Latency:** all three calls completed within a 99.0 s parallel batch bracket that also includes agent turn overhead after the batch returned, so the slowest of the three was at most that long and likely well under it. No timeouts, no errors, no retries.
11. **No key leakage:** no `api_key` / `apiKey` field and no 32-character hex string in any output.

`credits.remaining` from the last successful call: **85**.
