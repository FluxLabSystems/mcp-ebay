# Countdown API demo-key captures

Live responses from `https://api.countdownapi.com/request` captured on
2026-09-02 with the vendor's public `api_key=demo`. The demo key serves real,
uncharged responses (`request_info.demo: true`) for the documentation's example
search term `memory cards` on any supported domain and for `type=product` /
`type=reviews` on the documentation's example epid; every other request returns
HTTP 401 until a plan or the free trial is active. Nothing here carries a
credential: the demo key is public and the responses echo only
`request_parameters` without it.

These files back the mapping rules in `docs/COUNTDOWN-API-PLAN.md` §4.1 and
the unit tests planned in §6.6. They are eBay marketplace data as the vendor
returned it; titles, seller names and prices are whatever eBay rendered at
capture time and will drift. Refresh them with the Phase 0 capture script's
`--demo` mode rather than by hand.

| File | Request | Rows | What it shows |
|---|---|---|---|
| `search-ca-memory-zip-M6H2W9.json` | `type=search ebay_domain=ebay.ca search_term=memory cards customer_location=ca customer_zipcode=M6H2W9` | 60 | ebay.ca row shape; the zip applied as `_stpos=M6H2W9&_fcid=2` in `request_metadata.ebay_url`; `C $` raw prices with no `currency` field; 21 price-less range rows with titles ending in ` to`; `shipping_cost` on 40 rows |
| `search-ca-memory-nozip.json` | same without `customer_location`/`customer_zipcode` | 60 | baseline for the zip comparison: 3 of 59 shared rows carry a different `shipping_cost` with the zip |
| `search-ca-memory-zip-num240-max2.json` | first request plus `num=240 max_page=2` (stored compact, 273 KB) | 480 | multi-page shape: `pagination.pages[]`, per-row `page` and `position_overall`, no `request_metadata.ebay_url`; 159 price-less range rows |
| `search-com-memory-zip-34249.json` | `type=search ebay_domain=ebay.com search_term=memory cards customer_location=us customer_zipcode=34249` | 60 | ebay.com row shape; `$` raw prices; all 44 range rows parsed as two prices; `item_location` prefixed `located in`; `shipping_cost` on 3 rows only |
| `search-ca-memory-zip-auction-newly-listed.json` | first request plus `listing_type=auction sort_by=newly_listed` | 60 | the filter and sort reach eBay as `LH_Auction=1&_sop=10`; every row has `is_auction: true` and `buy_it_now: false`; `shipping_cost` on all 60 rows; `seller_info` absent on every row of this layout; no bid counts anywhere |
| `product-not-found-ca.json` | `type=product ebay_domain=ebay.ca epid=233599133856 customer_location=ca` | n/a | HTTP 200, `success: true`, `message: "Product not found."`, no `product` block |
| `product-not-found-com.json` | `type=product ebay_domain=ebay.com epid=233599133856` | n/a | same shape on ebay.com |

Observed but not captured: `customer_zipcode=M6H 2W9` (with the space) and
`m6h2w9` both pass through unnormalised into `_stpos`. The docs'
`type=seller_profile` example hit the vendor's transient "unable to fulfil your
request … (G)" HTTP 500 twice and then timed out, so the seller-profile shape
is not verified here. Seven of twenty-two demo calls returned that 500 or
timed out; the auction-sorted search needed three attempts, and every other
identical retry succeeded.
