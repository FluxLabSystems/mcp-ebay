# Countdown API keyed captures (Phase 0)

Live responses captured on 2026-09-02 with the operator's free-trial key,
following `docs/COUNTDOWN-API-PLAN.md` §5. The key never appears here: each
file's `request_info` has its credit counters nulled and no request echoes the
key. Total spend: 14 credits (86 of the trial's 100 remain); every failed call
was uncharged. These are eBay marketplace data as the vendor returned it and
will drift; refresh with the Phase 0 capture script.

| File | Request | What it answers |
|---|---|---|
| `search-ca-lego-minifig-newly-listed.json` | `type=search ebay_domain=ebay.ca search_term="lego minifigure lot" sort_by=newly_listed num=240 customer_location=ca customer_zipcode=M6H2W9` | 240 rows of 31,000; `_sop=10&_ipg=240&_stpos=M6H2W9`; **`is_auction` is false on every row, including the 30 that the auction-filtered twin below proves are auctions**; `seller_info` absent on this layout; `shipping_cost` on 115 rows |
| `search-ca-lego-minifig-auction-newly-listed.json` | same plus `listing_type=auction` | 240 of 565 rows, `LH_Auction=1`; `is_auction: true` on all; `prices` is the current bid (`C $1.00` floors are common); `shipping_cost` on 234 rows; took three attempts (two 120-second timeouts, then 60 s) |
| `search-ca-seller-ssn-tweedsidesales.json` | `type=search url=https://www.ebay.ca/sch/i.html?_ssn=tweedsidesales&_nkw=lego&_sop=10&_ipg=240` + Toronto zip | seller-scoped passthrough works: 31 rows of 31, zip appended as `_stpos` |
| `search-com-lego-printed-tiles-forwarder.json` | `type=search ebay_domain=ebay.com search_term="lego printed tiles lot" customer_location=us customer_zipcode=34249 num=60` | ebay.com rows with `seller_info` on 50 of 60 and `shipping_cost` on 52 |
| `search-com-seller-ssn-thelegolady.json` | `url=https://www.ebay.com/sch/i.html?_ssn=theLEGOlady&_nkw=lego&_sop=10&_ipg=60` + forwarder zip | 13 rows, all `located in united kingdom`, `shipping_cost` on all 13 |
| `product-ca-331982822376-active-tiers.json` | `type=product url=https://www.ebay.ca/itm/331982822376 customer_location=ca` | live fixed-price quantity-tier lot (Bluebird Brick Designs): `offer {price 2.29, currency CAD}` is the lowest tier, `variants` empty (tiers not captured), `stock_status {in_stock, quantity_available 5, quantity_sold 121}`, `seller.link` is the store slug `/str/almtshop88`, `shipping.price` is the bare string `"7.95 "` |
| `product-ca-287557851282.json` | `type=product url=https://www.ebay.ca/itm/287557851282 customer_location=ca` | the item the 2026-09-02 run recorded as `auction_with_bin` now reads `is_auction: false`, `offer 15 CAD`, `promotion.why_buy` "listed in the last 3 days"; `seller.link` is the third link form, `/sch/bageltremors/m.html?item=…`; `shipping.price` `"GBP 21.56 "` |
| `product-ca-287557851282-with-html.json` + `html/ebay-ca-itm-287557851282.html` | same with `include_html=true` | the raw ebay.ca item page (650 KB) the DOM extractor's selectors match (`ux-labels-values--shipping`, `d-shipping-minview`, `x-price-primary`, `x-bid-count`, JSON-LD); its delivery line reads "Estimated between … **to 91722**": the vendor's browser resolves item pages to its own California zip, whatever `customer_location` says |
| `product-ca-168658364834-live-auction.json` | first row of the auction-filtered search, `customer_location=ca` | **a live auction the vendor reports as `is_auction: false` with no `auction` block and `offer.price 19.99 CAD`, while the search row showed a `C $37.54` current bid**; the item page cannot be trusted for auction format or price |
| `product-ca-needs-revalidation-398236132742.json` | a dashboard `needs_revalidation` record | sold listing: `stock_status {OutOfStock, not_in_stock, quantity_available 0, message "This listing sold on Sun, Aug 30 at 3:03."}`, no `end_date`; `offer` and `shipping` still populated (`"C $68.71"`, service "UPS Standard United States" on a Quebec seller viewed from Canada) |
| `product-ca-198589141532-ended.json`, `product-ca-800523282681-ended-or-sold.json` | the two ended-versus-sold ids from `ANALYSIS.md` | both `OutOfStock` / `not_in_stock` with no `message` and no `end_date`: ended without a sale is signalled only by stock status; `shipping.price` `"Free"` and `"19.85 "` |
| `product-com-167665350336-thelegolady-us.json` | theLEGOlady item, `customer_location=us` | `ships_to: "Worldwide"` for a seller the roster records as excluding Canada, so `ships_to` is not route evidence; `seller.link` `/sch/thelegolady/m.html`; `offer.currency USD`; `shipping.price "GBP 12.00 "` |
| `seller-profile-ca-usr-tweedsidesales.json` | `type=seller_profile url=https://www.ebay.ca/usr/tweedsidesales` | `seller {name "Jeremy Doherty", link /str/jeremydoherty, positive_ratings_percent 99.8, followers "79 followers"}`: the `/usr/` login id resolves to the roster's display name, and the store slug differs from the login id |

Not captured: `seller_profile` for `/usr/audi2005store` (three vendor 500s; the
profile rendered an eBay error page in the 2026-09-02 run, and the vendor
returns its generic uncharged failure rather than a structured "not found")
and the `seller_name=The_Brick_World` form (two 500s and a timeout). No
`redirected` example was found: the needs-revalidation id had sold rather than
been removed. The account read showed no zip-code limit fields on the free
plan.
