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
