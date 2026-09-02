# @browser-bridge/source-countdown

The Countdown API (Traject Data) eBay data source for the Browser Bridge
gateway: `CountdownClient` (injectable `fetch`, one timeout, bounded retries,
vendor status codes mapped to `BridgeError` codes, API key redacted from every
error), loose zod schemas for the three response types, and three pure mappers
onto the shapes the deals routine already consumes. No I/O beyond `fetch`.
The authoritative plan is `docs/COUNTDOWN-API-PLAN.md`; §1.3 holds the
measurements, §4 the field rules, and `tests/unit/countdownMappers.test.ts`
proves them against `tests/fixtures/countdown/`.

## Measured facts the mappers depend on (2026-09-02)

- **Item id comes from `link`, never `epid`.** A search row's `epid` is
  sometimes an eBay product id (the docs pair `epid 8030522363` with an
  `/itm/…/332050873554` link). `mapSearchRows` drops a row whose link yields
  no id and counts it in `CANDIDATE_FIELDS_NULL`. Item pages fetched by URL
  carry no `product.link` or `product.epid` at all, so `mapItem` falls back
  to the vendor's resolved `request_metadata.ebay_url`, then the requested URL.
- **Search prices carry no currency.** `prices[]` entries have `value` and
  `raw` only (`C $20.00` on ebay.ca, `$40.61` on ebay.com); currency is parsed
  from `raw` with the domain as the fallback (`CAD` / `USD`).
- **`is_auction` and `buy_it_now` say nothing on an unfiltered search.** Both
  read false on every row, live auctions included (30 proven auctions in the
  keyed LEGO sweep). Format comes ONLY from the filter a row was retrieved
  under (`retrievedUnder`); `mergeSplitSearch` unions a buy-it-now set with an
  auction set by item id. The flags are never read.
- **Price-range rows are damaged.** A variant listing's title ends in a stray
  ` to` and its `prices` are a two-entry range or missing entirely (21 of 60
  ebay.ca rows). The marker is stripped, `priceRange` is set, a two-entry
  range is split into `snippetPrice` (low) and `snippetPriceHigh`, and a
  price-less range row is kept with `snippetPrice: null` and counted once in
  `PRICE_RANGE_UNPARSED`. It is a listing to open, never "no price".
- **`shipping_cost` absent means unknown, never free** (40 of 60 ebay.ca rows,
  3 of 60 ebay.com rows carry one). `shippingSnippetText` is always null.
- **Search rows carry no bid count or time left.** `bidCount` is null on every
  candidate with one `BID_COUNT_UNAVAILABLE_FROM_SOURCE` warning.
- **`condition` can have the seller's subtitle glued in front** with no
  separator ("…Buy From NeweggBrand New"); it is normalised to the trailing
  token of eBay's vocabulary with the raw kept in `conditionRaw`.
- **`item_location` is prefixed `located in ` on ebay.com** and bare on
  ebay.ca; the prefix is stripped.
- **An item page reports a live auction as `is_auction: false` with an
  `offer.price`** (19.99 CAD against a 37.54 current bid on the search row).
  `mapItem` takes the format from the caller's `expectedFormat`, nulls
  `itemPrice`, `endsAt` and `timeLeftText` on an auction kind, and warns
  `AUCTION_DETAIL_UNAVAILABLE_FROM_SOURCE`.
- **`shipping.price` is a string in mixed forms** (`"C $68.71"`,
  `"GBP 21.56 "`, `"7.95 "`, `"Free"`) resolved by the vendor's browser to its
  own zip (91722 seen in the raw HTML) whatever `customer_location` says. It
  is stored as observed text with `destinationPostalCode: null`,
  `destinationVerified: false`, a bare number at confidence 0.4, and every
  record carries the `DESTINATION_UNVERIFIED` warning. `customer_zipcode` is
  rejected on product requests, so the client never sends it there.
- **Ended and sold are signalled by `stock_status`, not `end_date`:**
  `not_in_stock` is `sold` when `message` reads "This listing sold on …",
  otherwise `ended`. `quantity_available: 0` on an in-stock listing means
  "not shown" and maps to null.
- **Seller links come in three forms.** `/usr/<loginId>` and
  `/sch/<loginId>/m.html` yield the login id; `/str/<slug>` is a store slug
  that is NOT a login id (`tweedsidesales` is `/str/jeremydoherty`) and is
  stored as `sellerStoreSlug` with `seller: null`. A seller profile fetched by
  `/usr/` URL returns a `/str/` link, so `loginId` comes from the requested URL.
- **"Product not found." arrives as HTTP 200** with `success: true` and no
  `product` block; `redirected: true` is the other unavailable case. Both map
  to `status: 'unavailable'`, `listingStatus: 'unavailable'`.
- **The transient `(G)` 500 is uncharged** and cleared by the identical retry
  every time; the client retries 5xx, network errors and timeouts twice
  (2 s, 6 s) before `SOURCE_UNAVAILABLE`.

## Exports

`CountdownClient` (`search`, `product`, `sellerProfile`, `account`),
`mapSearchRows`, `mergeSplitSearch`, `readPagination`, `mapItem`,
`mapSellerProfile`, the response schemas, `parseCountdownBody`,
`parseSellerLink`, `normalizeCondition`, `domainCurrency`, `mergeWarnings`,
and the `COUNTDOWN_WARNING` code table. Records carry
`siteProfile: 'ebay.api.v1'`, `profileRevision: EBAY_API_PROFILE_REVISION`
and `pageRevision: 0`.
