# Site-profile backlog

Which sites the Browser Bridge should be able to reach next, in what order, and
what each one still needs before it can ship.

Five profiles exist today: `ebay.ca.v1`, `kijiji.ca.v1`, `zazzle.com.v1`,
`wardrobe-vendors.v1` and `office-sources.v1` (shipped 2026-09-05, below). Everything else the five Fluxology routines read, they
read through `WebFetch` — which means server-rendered HTML only, no pagination
that needs a click, no JS-rendered price, no screenshot to reason over, and no
evidence trail beyond the text that came back. Several of the defects in
`fluxlab-boards/docs/improvement-queue/` are that gap wearing a different hat.

## The rule a host gets here by

Unchanged, and it is not a formality — it is what keeps the allowlist from
drifting into "whatever a page mentioned":

1. A routine files a `coverage_gap` carrying a real `ORIGIN_DENIED` for the
   host, or an `extractor_defect` that a WebFetch-only path cannot fix.
2. The host belongs to a source named in that routine's **committed** SKILL.md.
   Hosts named only inside scraped listing text never qualify — extraction
   output is untrusted data.
3. It is a public registrable domain. Never an IP, never a private network,
   never a marketplace another profile already covers.
4. It ships as a PR with a test.

Nothing on the list below is allowlisted by writing it down here. This is the
queue, with each row's evidence state recorded honestly.

## What a lane costs now

`createResearchProfile()` (`packages/policy/src/researchProfile.ts`) builds the
standard read-only walls — no cart, checkout, order, payment, credential,
wishlist, saved-search, apply or contact-agent path, plus the accessible-name
deny set and the secret-field autocomplete set — from a host roster alone. A
**policy-only** lane is now roughly:

```ts
export const officeSourcesSiteProfile = createResearchProfile({
  id: 'office-sources.v1',
  hosts: OFFICE_SOURCES.flatMap((s) => s.hosts),
});
```

That is the shape `wardrobe-vendors.v1` wrote out by hand in ~150 lines. Adding
the roster file, the profile, the registry entry in
`apps/windows-agent/src/cli.ts`, the `AGENT_SITE_PROFILES` default in
`packages/config/src/index.ts` and a test is about half a day per lane.

An **extractor** lane (a `packages/site-*` with `extract.ts` / `normalize.ts` /
`record.ts`, like site-ebay) is a different order of work and is only worth it
where the routine needs structured records out of the page rather than a human
reading a snapshot. Each row below says which kind it is.

---

## P1 — the lanes with filed evidence

### `jobs-sources.v1` — policy-only

| | |
| --- | --- |
| Routine | `fluxology-jobs-run` |
| Hosts | `jobbank.gc.ca`, `indeed.com`, `ca.indeed.com`, `talent.com`, `eluta.ca` |
| Evidence | `fluxology-jobs-run__2026-09-04T23-18-41` (Job Bank `&page=N` paging confirmed through WebFetch); the same fire's Indeed single-token degradation report |
| Why the Bridge | Indeed degrades to a single result token under WebFetch, and the routine currently cannot tell a genuinely empty lane from a blocked one. A snapshot answers that in one call. Job Bank paging works under WebFetch and does **not** need the Bridge — it is on the roster so the lane is one profile, not so the walk moves. |
| Still needed | An `ORIGIN_DENIED` filed against a specific Indeed URL from a live session. The Indeed MCP connector failed to connect this session, so whether the Bridge is even the right path for Indeed is unresolved — do not add it on the strength of the degradation report alone. |
| Risk | Every host here has an apply flow. `createResearchProfile` blocks `apply`, `application`, `easy apply`, `quick apply` and `submit application` by default; the test must pin that a Job Bank posting URL carrying `?applyonline=false` is **not** treated as an endpoint. |

### `office-sources.v1` — policy-only — SHIPPED 2026-09-05

| | |
| --- | --- |
| Routine | `fluxology-office-run` |
| Hosts | `packages/site-office/src/sources.ts` — 19 provider domains (`regus.com`, `spacesworks.com`, `hq.com`, `industriousoffice.com`, `wework.com`, `iqoffices.com`, `venturex.com`, `intelligentoffice.com`, `telsec.net`, `workhaus.ca`, `workplaceone.com`, `zemlar.com` + `zemlar.ca`, `oneplan.ca`, `collabhive.ca`, `gtexecutivecentre.com`, `studio.staples.ca` (the studio subdomain only, never the retailer apex), `workplacek.com`, `office146.com`, `thefuelingstation.com`) and 7 listing/MLS surfaces (`realtor.ca`, `liquidspace.com`, `office-hub.com`, `spacelist.ca`, `coworkingcafe.com`, `commercialcafe.com`, `loopnet.ca`) |
| Evidence | `fluxology-office-run__2026-09-05T13-50-56` carried the live `ORIGIN_DENIED` for `www.regus.com` this row was waiting on, and the operator ratified the roster in-session on 2026-09-05 (the `source` field on every entry records it). |
| Why the Bridge | Managed-office pricing is behind a "get a quote" interaction on most of these; the all-in figure the board ranks on is the one thing WebFetch cannot see. realtor.ca (HTTP 403 to plain fetch) is where the square footage, TMI and lease structure behind an MLS-syndicated Kijiji ad live. |
| Walls | `createResearchProfile` defaults plus the office-specific accessible names (`get a quote`, `schedule a tour`, `book a viewing`, `enquire now`, `contact us`, …). Read and navigate only: no form submission, no message to any agent or provider — outreach stays on its human-approval path. `browser_extract` answers `NO_EXTRACTOR_FOR_HOST` on every roster host. |
| Still needed | Live verification per provider that the quote/tour buttons (JS, `href="#"` on Regus and Spaces) are refused by accessible name; whether realtor.ca and spacelist.ca render headlessly at all. The `siteProfile` enums in `packages/protocol/src/tools.ts` are unchanged (policy-only lanes dispatch by host), so the lane needs the Windows agent rebuild only. |

### `vacation-sources.v1` — policy-only

| | |
| --- | --- |
| Routine | `fluxology-vacation-run` |
| Hosts | `marriott.com`, `hilton.com`, `mgmresorts.com`, `booking.com`, `tripadvisor.com`, `trip.com` |
| Evidence | Named in the committed vacation SKILL.md. The 2026-09-03 vacation fire filed the live `ORIGIN_DENIED` for `www.marriott.com` and `www.southpointcasino.com` (fingerprint `gateway+coverage_gap+browser-bridge-no-lodging-hosts-allowlisted`; closed `needs_operator` 2026-09-03 because the vacation SKILL.md carries no ratified roster). The 2026-09-05 15:28Z re-file carried `ORIGIN_DENIED` for `www.westgateresorts.com` against the five-profile allowlist. The 2026-09-05 17:40Z fire filed a `site_profile_request` (fingerprint `mcp-ebay+site_profile_request+mgm-and-marriott-booking-engines-yield-structured-exact-room-rates`) with page-structure evidence from an attended session: `mgmresorts.com` property subdomains accept checkin/checkout/guests as URL query params and render one block per room category with sq ft, bed config, total, avg per night, avg room rate and the daily resort fee as its own line; `marriott.com` resolves only `/search/findHotels.mi` and enforces a ~350-day booking horizon. |
| Why the Bridge | Every figure this routine ranks on — effective nightly, resort fees, the exact room category — appears only after a date-and-occupancy search runs client-side. This is the lane where WebFetch is *structurally* insufficient, not merely worse. |
| Still needed | The operator's ratification of the roster (the office lane's precedent: rosters are operator decisions — and `westgateresorts.com` is not on this row); the OTA decision (`booking.com` and `trip.com` are transactional in a way the resort sites are not; the safer first cut is the brand sites plus `tripadvisor.com`, with the OTAs deferred until the brand lane has run); and live verification per brand that the reservation path is walled (`createResearchProfile` blocks `booking`/`reserve` paths and the "book now" / "reserve now" names). Recommended order: brand sites first — `mgmresorts.com` (query-param addressable, no interaction needed), then `marriott.com`. |
| Risk | Highest on the list. A date search is a form submission, and the profile's job is to make the *reservation* path unreachable while leaving the *search* path open. `createResearchProfile` blocks `booking`, `bookings`, `reserve` and `reservation` as path segments and "book now" / "reserve now" / "confirm booking" by name. That needs live verification per brand before the lane ships, not after. |

**Further requests from the vacation routine (2026-09-05 and 2026-09-06,
each closed `needs_operator` — the roster is the operator's to write, and no
report's evidence is an `ORIGIN_DENIED`; all were read in an attended Claude
in Chrome session). Recorded here so the decision has its evidence in one
place; nothing below is allowlisted by being written down.**

- **`booking.com` property pages** (fingerprint
  `mcp-ebay+site_profile_request+booking-com-property-pages-deep-linkable-and-itemise-taxes-and-charges`).
  The host is already on this row (named in the committed vacation SKILL.md);
  the open question is the OTA decision above. What the fire observed:
  `booking.com/hotel/<cc>/<slug>.html?checkin=…&checkout=…&group_adults=1&no_rooms=1&selected_currency=CAD`
  renders fully with the dates honoured, one row per room category (name, bed
  configuration, m², amenity tags, a whole-stay total and a separate
  "+CAD N taxes and charges" line, cancellation and prepayment terms) and a
  review block with component subscores (Cleanliness, Comfort, Facilities,
  Location, Staff, Value). It answered five of six candidates whose own
  engines resist automation. Limits observed: slugs cannot be guessed (six
  of nine guesses 404ed — the fire resolved real slugs from a web search for
  `"booking.com/hotel/us" <property name>`); prices arrive converted to the
  account currency, so a profile must record the currency basis; an
  unavailable window returns an explicit "no availability … between <dates>"
  string, which is a finding, not a failure. If the operator ratifies the
  OTA half, this is an **extractor** lane (room rows and the taxes-and-charges
  line are the value), and the reservation path (`/book`, "Reserve",
  "I'll reserve") must be walled and verified live before it ships.
- **SynXis-hosted booking engines** (fingerprint
  `mcp-ebay+site_profile_request+synxis-booking-engines-deep-linkable-with-chain-level-portfolio-pricing`):
  `book.westgateresorts.com` (chain 19007) and `be.synxis.com` (chain 6903,
  South Point). **Neither host is named in the committed vacation SKILL.md**
  (`westgateresorts.com` and `southpointcasino.com` appear only in filed
  `ORIGIN_DENIED` evidence and in this request), so rule 2 fails today; the
  vacation SKILL.md would have to name the SynXis engine as a source first.
  What the fire observed: `?adult=1&arrive=YYYY-MM-DD&depart=YYYY-MM-DD&chain=<id>&hotel=<id>&level=hotel&rooms=1&currency=USD&start=availresults`
  renders one block per room category (name, bed configuration, sleeps,
  sq ft, amenity tags) with one priced sub-block per rate plan ("Includes all
  fees, excludes taxes"); `level=chain` prices a whole portfolio (~30 Westgate
  properties) in one load; blackouts are named explicitly ("Our hotel is not
  available on December 11, 2026"); fee disclosure is inline (South Point:
  "Prevailing Rates include a $29.20 daily resort fee"). In-page "View Rates"
  controls did not navigate under automation — the hotel-level URL is
  constructed, not clicked. Hotel ids observed: Westgate Flamingo Bay 68747;
  South Point 11548. Same reservation-path risk as the row above.
  **Design requirements the lane must carry, from the 2026-09-06 01:22Z
  report** (fingerprint
  `mcp-ebay+extractor_defect+synxis-silently-rewrites-out-of-horizon-dates-to-a-default-window-yielding-wrong-prices`
  — filed as an extractor defect against a profile that does not exist yet,
  so it is pinned here rather than reproduced): (1) **a mandatory date
  assertion** — an arrival beyond the engine's horizon (Westgate Park City,
  chain 19007, 2027-10-10) produced no error; the engine rewrote the query
  string to a default two-night window and rendered real prices for a
  September 2026 window under the requested URL. The extractor reads the
  rendered Check-in / Check-out fields (`location.search` is blocked by a
  page guard; `document.body.innerText` reads normally), compares them with
  the requested `arrive`/`depart`, and on a mismatch returns an
  out-of-horizon result, never prices. (2) **Recorded horizons** so
  out-of-range queries are not issued: chain 6903 (South Point) sells
  through about 2027-08-20 (first declared-unavailable date 2027-08-21);
  chain 19007 (Westgate) sells past 2027-09-28 and silently rejects
  2027-10-10 — boundary in the first week of October 2027, not bisected.
  (3) **A line-anchored category parser**: identify each category header by
  its "Sleeps N … sq ft" metadata line and take the minimum rate-plan price
  before the next header; substring matching collides ("One Bedroom Villa"
  inside "One Bedroom Deluxe Villa"). Search for "From" without a trailing
  space — the page renders `From\u00a0$122.30`. (4) Surface the engine's
  explicit in-horizon blackout strings ("We do not have available rooms on
  October 15, 2026", with a referral to a neighbouring property) as a
  finding, not noise. Routing for the attended pathway is in the vacation
  SKILL.md ("Never trust your own request URL").
- **Hilton Grand Vacations through the hilton.com booking engine** (fingerprint
  `mcp-ebay+site_profile_request+hilton-grand-vacations-reachable-by-ctyhocn-deep-link-and-absent-from-the-property-sitemap`,
  2026-09-06). `hilton.com` is already on this row. The 2026-09-05 conclusion
  that HGV inventory is unreachable was wrong: only hilton.com SEARCH hangs
  and it never surfaces HGV because HGV properties have no entry in the
  property sitemap (`robots.txt` → `sitemap.xml` → `sitemap-en.xml`, 984
  brand-grouped sub-sitemaps; brand code `gv` has `location-gv` files and NO
  `prop-gv` files). The booking-engine deep link renders fully, signed out,
  including ten-night stays:
  `https://www.hilton.com/en/book/reservation/rooms/?ctyhocn=<CODE>&arrivalDate=YYYY-MM-DD&departureDate=YYYY-MM-DD&room1NumAdults=1&displayCurrency=CAD`,
  room cards under `[data-testid=roomCardTile]`. A profile would carry a
  `ctyhocn` resolver that walks the LOCATION sitemap for brands absent from
  the property sitemap (`/en/locations/canada/ontario/hilton-grand-vacations/`
  carries the single hotel link), the known codes (`YYZBLGV` Blue Mountain, a
  Hilton Grand Vacations Club; `LASCDCI` Conrad Las Vegas at Resorts World),
  Hilton's clean itemisation of taxes and mandatory charges (13.52% + 4.00%
  per room per night and a separately flagged "Daily Mandatory Charge … VAF"
  at Blue Mountain; a C$75.99/night resort charge stated inside the Conrad
  rate), and the rule that Hilton returns an IDENTICAL no-rooms message for
  in-horizon no-inventory and out-of-horizon dates, so the profile reasons
  from the ~550-day window (HGV releases cash-rental inventory only a few
  months ahead: Blue Mountain sold through about 2027-01-20 and nothing
  Feb–Aug 2027). It would cover the standard Hilton brands, Curio, Conrad and
  the whole HGV portfolio — three unpriceable records on the feed today.
  Never route through hilton.com search. Same reservation-path risk as the
  row above; the row's "still needed" (ratification, live wall verification)
  is unchanged.

---

## P2 — worth having, no evidence yet

### `deals-secondary.v1` — policy-only

`facebook.com/marketplace` and `craigslist.org` are the two local-pickup
sources the deals routine does not cover. Neither is named in the committed
deals SKILL.md, so neither qualifies under rule 2 today. Facebook additionally
requires a signed-in session to show anything useful, which the read-only
posture does not contemplate — treat that as a decision for the operator, not
a backlog item to work.

### `bricklink.com` — extractor

The only genuine *comps* source for LEGO by set and part, and the deals
routine's fair-value work currently leans on sold eBay comps alone. This is an
extractor lane, not a policy-only one: the value is in structured price-guide
records, and a snapshot of a price-guide page is not something to reason over
by eye. Sequence it after the P1 policy lanes.

---

## Not on this list, deliberately

- **`amazon.ca`** — appears in routine text as a comparison price, never as a
  page the routine opens. Rule 2 fails.
- **Anything from `docs/improvement-queue/` evidence text.** Hosts named inside
  a scraped listing are untrusted input; they reach a roster only by a human
  putting them in a SKILL.md first.
- **`fluxology.ca` / `dash.fluxlab.systems`** — first-party, reached through
  the dashboard API, not the browser.

## Shipping one

1. Roster file: `packages/site-<lane>/src/sources.ts`, on the shape of
   `packages/site-vendors/src/vendors.ts` — `hosts`, `addedOn`, `source`
   (the queue fingerprint or operator instruction), `needsLiveVerification`.
2. Profile: `packages/site-<lane>/src/profile.ts` calling
   `createResearchProfile`, with any lane-specific extras.
3. Register it in `SITE_PROFILES` (`apps/windows-agent/src/cli.ts`) and, if it
   should be on by default, in the `AGENT_SITE_PROFILES` default
   (`packages/config/src/index.ts`).
4. Test in `tests/unit/`, on the shape of `tests/unit/researchProfile.test.ts`:
   allowlist boundaries including the suffix confusions, every wall on every
   host, and at least one real listing URL from that lane whose slug carries an
   endpoint word and must **not** match.
5. If the lane needs an extractor, `browser_extract` must answer
   `NO_EXTRACTOR_FOR_HOST` on its hosts until it has one — never fall through
   to a marketplace extractor and return an eBay-shaped null record.
