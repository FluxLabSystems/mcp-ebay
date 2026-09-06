/**
 * Kijiji search-results traversal support — modeled on the site-ebay
 * FR-15 traversal module. Result-card snippets are traversal hints only
 * and are never accepted as canonical ad evidence; candidates are
 * followed to their VIP pages for extraction.
 *
 * Fluxology contract: the 45 km and 65 km radius searches are INDEPENDENT
 * mandatory passes (see data/deals/README.md and search-profiles.json —
 * run both first, deduplicate afterward). This module only builds search
 * URLs and parses result pages; pass orchestration, dedupe across passes,
 * and search-run audit records live with the caller.
 *
 * Observed live 2026-09-02 (deals fire, fingerprint site-kijiji+
 * extractor_defect+radius-param-ineffective-l1700273): kijiji.ca IGNORES
 * the radius= and address= query parameters. Under k0l1700273, radius=45.0
 * and radius=65.0 returned byte-identical sets (totalResults=3915, same
 * first 40 rows in the same order); the same radius=45.0&address=M6H 2W9
 * with no region id returned 31,536 ads led by Laval, Edmonton and
 * Winnipeg. Location scope comes ONLY from the l<regionId> path segment,
 * so two radius passes are one pass until two verified region ids are
 * pinned. The builders below therefore never emit those parameters, and
 * kijijiSearchUrlWarnings() flags a URL that still carries them.
 */
import { apolloActivationDate, readKijijiApolloCache } from './extract.js';
import { adIdFromUrl, parseKijijiPostedLabel, parseKijijiPostedText, parseKijijiPrice } from './normalize.js';
import type { KijijiPostedPrecision, ParsedKijijiPrice } from './normalize.js';

export interface KijijiSearchResult {
  adId: string;
  /** Absolute VIP URL resolved against the search page URL. */
  url: string;
  title: string | null;
  /** Raw rendered price text from the result card, when present. */
  priceText: string | null;
  /** Snippet price: traversal hint only, never canonical evidence. */
  price: ParsedKijijiPrice | null;
  locationText: string | null;
  /** Raw rendered posted time from the card ("2 hrs ago"), when present. */
  postedText: string | null;
  /**
   * ISO instant the posted time resolves to; null when nothing states one.
   * Read postedAtSource before trusting it: a 'relative_text' value is the
   * ad's last ACTIVATION as the card rounds it ("2 hrs ago"), measured back
   * from the fetch clock and truncated to the label's unit — a bumped or
   * reposted ad reads as new here. It is never the ad's original posting
   * date, which only the ad page's postedAt states (2026-09-06: a card
   * derived 2026-09-06T02:13Z for an ad whose page states 2025-08-29).
   */
  postedAt: string | null;
  /**
   * Where postedAt came from: a datetime attribute on the card
   * ('card_datetime'), the hydration cache's activationDate for this ad
   * ('hydration'), or arithmetic on the rendered relative label
   * ('relative_text'); null when postedAt is null.
   */
  postedAtSource: 'card_datetime' | 'hydration' | 'relative_text' | null;
  /** 'exact' for a stated instant; otherwise the unit of the label postedAt was derived from. */
  postedAtPrecision: KijijiPostedPrecision | null;
}

export interface KijijiSearchContext {
  /** Instant a relative posted time is measured back from. Defaults to now. */
  observedAt?: Date;
}

export interface KijijiSearchPage {
  results: KijijiSearchResult[];
  /**
   * Whether more results exist beyond this page. Deliberately NOT derived
   * from nextPageUrl: a 73-result search rendering 40 reported false purely
   * because no known "next" selector matched, silently truncating a
   * traversal at page one. The stated result count settles it even when the
   * link cannot be found; the link is best-effort on top.
   */
  hasNextPage: boolean;
  nextPageUrl: string | null;
  /** Total results the page claims, when it states one. */
  totalResults: number | null;
  /**
   * The rendered document <title>, verbatim. The deals and office SKILLs make
   * the rendered page title the sole accepted proof of which region an
   * l<regionId> path segment actually scopes ("12,543 ads for lego … in
   * Toronto (GTA)" vs "… in City of Toronto"), so a search record that omits
   * it cannot satisfy the one verification the routines are told to perform.
   */
  pageTitle: string | null;
  /**
   * The keyword the page says it searched for — the hydration cache's
   * searchQuery.keywords, the quoted term in the h1 ('"lego" in Toys &
   * Games in City of Toronto'), or the <title> ("3,386 ads for lego in …");
   * null on a category browse that applied none. The 2026-09-02 deals fire
   * requested /b-lego/gta-greater-toronto-area/k0l1700273 and got 77
   * plumbers, painters and mattresses back as an ordinary search page with
   * no signal that "lego" was never the query the site ran. This is that
   * signal: compare it with the keyword you meant (kijijiKeywordWarnings
   * does, for the keyword the URL carries).
   */
  searchTerm: string | null;
  /**
   * The ad Kijiji redirected away from to land here, when it did. A removed
   * ad renders no banner and keeps no VIP: the ad URL 302s to its category
   * search page carrying ?adRemoved=<id>. That parameter is the removed-ad
   * marker, and this is a search page precisely because the ad is gone.
   */
  removedAdId: string | null;
  /**
   * What this page could NOT say about the result set, so the caller never
   * reads the absence of a count or a next link as the end of it. Observed
   * 2026-09-04 (office fire): a category URL carrying ?sort=dateDesc renders
   * no result count and no pagination control at all, which used to come
   * back as the exact shape of a genuine last page (hasNextPage:false,
   * nextPageUrl:null, totalResults:null) while the unsorted URL for the
   * same 1579-ad category reported all three. The same sorted page was not
   * date-ordered either. Neither is fixable here; both are named.
   */
  warnings: string[];
}

export const PAGINATION_METADATA_ABSENT_WARNING_PREFIX = 'PAGINATION_METADATA_ABSENT';
export const SORT_NOT_HONOURED_WARNING_PREFIX = 'SORT_NOT_HONOURED';
export const POSTED_AT_FROM_RELATIVE_LABEL_WARNING_PREFIX = 'POSTED_AT_FROM_RELATIVE_LABEL';

/** Sorting parameters kijiji.ca accepts on a category or search URL. */
const SORT_PARAM_KEYS = ['sort'] as const;

/**
 * The same page without its sort parameter. On 2026-09-04 the unsorted
 * category URL was the one that rendered a count and a next link, so it is
 * the route the warning names; the sorted page's /page-2/ is not derived
 * here because no fire has yet shown that a sorted second page renders.
 */
function unsortedPageUrl(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    let changed = false;
    for (const key of SORT_PARAM_KEYS) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? url.toString() : null;
  } catch {
    return null;
  }
}

function sortParamOf(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    for (const key of SORT_PARAM_KEYS) {
      const value = url.searchParams.get(key);
      if (value !== null && value.length > 0) return `${key}=${value}`;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The rendered posted times, in page order, are older-first at some point
 * even though the URL asked for newest-first. Relative posted texts round
 * ("3 hours ago"), so an inversion has to exceed an hour to count.
 */
function newestFirstViolated(results: readonly KijijiSearchResult[]): boolean {
  const TOLERANCE_MS = 60 * 60_000;
  let previous: number | null = null;
  for (const result of results) {
    if (result.postedAt === null) continue;
    const ms = Date.parse(result.postedAt);
    if (Number.isNaN(ms)) continue;
    if (previous !== null && ms > previous + TOLERANCE_MS) return true;
    previous = ms;
  }
  return false;
}

// Card-enrichment selectors are secondary; the anchor-href VIP pattern is
// the primary signal so extraction survives layout churn.
// NEEDS-LIVE-VERIFICATION: data-testid hooks on current Kijiji search cards.
const CARD_CONTAINER_SELECTOR = '[data-testid^="listing-card"], li, article, section';
const CARD_TITLE_SELECTOR = '[data-testid="listing-title"], h3, [class*="title"]';
const CARD_PRICE_SELECTOR = '[data-testid="listing-price"], [class*="price"]';
const CARD_LOCATION_SELECTOR = '[data-testid="listing-location"], [class*="location"]';
const CARD_POSTED_SELECTOR =
  '[data-testid="listing-date"], [aria-label^="Published"], time, [class*="datePosted"]';
/** The card's location and posted time share one block, and only the
 *  location half carries a name of its own. */
const CARD_DETAILS_SELECTOR = '[data-testid="listing-details"]';

/** "1 - 40 of 73 Ads", "73 results", "Showing 1-40 of 1,234". */
const RESULT_COUNT_SELECTORS = [
  '[data-testid="srp-results-count"]',
  '[data-testid="results-count"]',
  '[class*="resultsCount"]',
  '[class*="showingResults"]',
  'h1',
  'header',
  // Live search pages state the count in the document title
  // ("3,386 ads for lego in Toys & Games in City of Toronto") and in no
  // rendered element at all; the h1 above names the query, not a number.
  'title',
];
const COUNT_RANGE_RE = /\b([\d,]+)\s*[-\u2013]\s*([\d,]+)\s+of\s+([\d,]+)/i;
const COUNT_TOTAL_RE = /\b([\d,]+)\s+(?:ads?|results?|listings?)\b/i;

function toInt(raw: string): number {
  return Number.parseInt(raw.replace(/,/g, ''), 10);
}

function toIsoOrNull(raw: string | null): string | null {
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Increment /page-N/ in a Kijiji search URL, or insert /page-2/ before the
 *  trailing category segment. Returns null when the shape is unrecognised --
 *  hasNextPage still stands on the count alone. */
function nextKijijiPageUrl(pageUrl: string): string | null {
  const seller = nextKijijiSellerPageUrl(pageUrl);
  if (seller !== null) return seller;
  try {
    const url = new URL(pageUrl);
    const paged = url.pathname.match(/\/page-(\d+)(\/|$)/);
    if (paged) {
      url.pathname = url.pathname.replace(/\/page-\d+(\/|$)/, `/page-${toInt(paged[1]!) + 1}$1`);
      return url.toString();
    }
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    if (segments.length < 2) return null;
    segments.splice(segments.length - 1, 0, 'page-2');
    url.pathname = `/${segments.join('/')}`;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The next page of a poster's listings: /o-profile/<posterId>/<n> → <n+1>,
 * and a bare /o-profile/<posterId> → /2. Null for any other path. Both live
 * VIP captures link the first page as /o-profile/<id>/1, so the trailing
 * segment is read as the page number. The site answers that link with a
 * redirect to /o-profile/<posterId>/listings/<n> (observed live 2026-09-04,
 * poster 1046282996), and the tab ends on the redirect form, so it pages
 * the same way and keeps its /listings/ segment. NEEDS-LIVE-VERIFICATION:
 * no second seller page has been captured under either form.
 */
export function nextKijijiSellerPageUrl(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    const match = /^\/o-profile\/(\d{1,16})(\/listings)?(?:\/(\d+))?\/?$/.exec(url.pathname);
    if (match === null) return null;
    const page = match[3] === undefined ? 1 : toInt(match[3]);
    url.pathname = `/o-profile/${match[1]}${match[2] ?? ''}/${page + 1}`;
    return url.toString();
  } catch {
    return null;
  }
}

/** The poster's listings page, as every VIP links it ("View all listings (N)"). */
export function buildSellerListingsUrl(sellerId: string, page = 1): string {
  const id = sellerId.trim().replace(/\D/g, '');
  return `https://www.kijiji.ca/o-profile/${id}/${Math.max(1, Math.trunc(page))}`;
}

const NEXT_PAGE_SELECTORS = [
  'link[rel="next"]',
  'a[rel="next"]',
  'a[data-testid="pagination-next-link"]',
  '[data-testid="pagination-next-link"] a',
  'a[title="Next"]',
  'a[aria-label*="next" i]',
];

function cardText(card: Element, selector: string): string | null {
  try {
    const text = card.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * The card's posted time. Kijiji hydrates it client-side into the same
 * listing-details block as the location, with no name of its own, so when no
 * named element matches it is read as whatever is left of that block after
 * the location text and the bullet separator. Server HTML ships the location
 * and the bullet and nothing else, so this is empty on a raw fetch and
 * populated in the browser the agent drives.
 */
function cardPostedText(card: Element, locationText: string | null, observedAt: Date): string | null {
  const named = cardText(card, CARD_POSTED_SELECTOR);
  if (named !== null) return named;
  const details = cardText(card, CARD_DETAILS_SELECTOR);
  if (details === null) return null;
  const rest = (locationText !== null && details.startsWith(locationText) ? details.slice(locationText.length) : details)
    .replace(/^[\s\u2022\u00b7|,\u2013\u2014-]+/, '')
    .trim();
  // Unlike the named elements above, this text is only positionally the
  // posted time: some card layouts trail a distance and a seller rating in
  // the same block. Anonymous text has to read as a time to be taken as one.
  return rest.length > 0 && parseKijijiPostedText(rest, observedAt) !== null ? rest : null;
}

/**
 * A machine-readable posted time the card itself carries (<time datetime>,
 * or any element in the details block with a datetime attribute), as an ISO
 * instant. NEEDS-LIVE-VERIFICATION: no live card has rendered one — the
 * hydrated posted node is a <p aria-label="Published …"> — so this is read
 * ahead of the label because a stated instant beats arithmetic, not because
 * a live page has been seen to state one.
 */
function cardPostedDatetime(card: Element): string | null {
  let el: Element | null;
  try {
    el = card.querySelector('time[datetime], [data-testid="listing-details"] [datetime], [data-testid="listing-date"][datetime]');
  } catch {
    return null;
  }
  return toIsoOrNull(el?.getAttribute('datetime') ?? null);
}

/** The removed-ad marker: see KijijiSearchPage.removedAdId. */
function removedAdIdFromUrl(pageUrl: string): string | null {
  try {
    const value = new URL(pageUrl).searchParams.get('adRemoved');
    return value !== null && /^\d{7,12}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * offset/totalCount for this page out of the hydration cache. The entry is
 * keyed by the path it was rendered for, and only that path is read: a cache
 * left behind by a client-side route change must not be reported as this
 * page's count.
 */
function apolloPagination(
  cache: Record<string, unknown> | null,
  pageUrl: string,
): { offset: number; totalCount: number } | null {
  if (cache === null) return null;
  const root = cache.ROOT_QUERY;
  if (typeof root !== 'object' || root === null) return null;
  let path: string;
  try {
    path = new URL(pageUrl).pathname;
  } catch {
    return null;
  }
  const prefix = 'searchResultsPageByUrl:';
  for (const [key, page] of Object.entries(root as Record<string, unknown>)) {
    if (!key.startsWith(prefix) || key.slice(prefix.length) !== path) continue;
    if (typeof page !== 'object' || page === null) continue;
    const pagination = (page as Record<string, unknown>).pagination;
    if (typeof pagination !== 'object' || pagination === null) continue;
    const { offset, totalCount } = pagination as Record<string, unknown>;
    if (typeof offset !== 'number' || typeof totalCount !== 'number') continue;
    return { offset, totalCount };
  }
  return null;
}

/** searchQuery.keywords for THIS page's path out of the hydration cache. */
function apolloSearchKeywords(cache: Record<string, unknown> | null, pageUrl: string): string | null {
  if (cache === null) return null;
  const root = cache.ROOT_QUERY;
  if (typeof root !== 'object' || root === null) return null;
  let path: string;
  try {
    path = new URL(pageUrl).pathname;
  } catch {
    return null;
  }
  const prefix = 'searchResultsPageByUrl:';
  for (const [key, page] of Object.entries(root as Record<string, unknown>)) {
    if (!key.startsWith(prefix) || key.slice(prefix.length) !== path) continue;
    if (typeof page !== 'object' || page === null) continue;
    const query = (page as Record<string, unknown>).searchQuery;
    if (typeof query !== 'object' || query === null) continue;
    const keywords = (query as Record<string, unknown>).keywords;
    if (typeof keywords === 'string' && keywords.trim().length > 0) return keywords.trim();
  }
  return null;
}

/** '"lego" in Toys & Games in City of Toronto' (live h1, 2026-09-02 capture). */
const H1_QUOTED_TERM_RE = /^\s*["\u201c]([^"\u201d]+)["\u201d]\s+in\b/;
/** "3,386 ads for lego in Toys & Games in City of Toronto | Kijiji" (live <title>). */
const TITLE_TERM_RE = /^\s*[\d,]+\s+ads?\s+for\s+(.+?)\s+in\b/i;

/**
 * The keyword the page states it applied, in the order the statement can be
 * trusted: the hydration cache for this exact path, the quoted h1, the
 * title. Null when none states one, which is what a category browse says.
 */
function readSearchTerm(document: Document, apollo: Record<string, unknown> | null, pageUrl: string): string | null {
  const fromCache = apolloSearchKeywords(apollo, pageUrl);
  if (fromCache !== null) return fromCache;
  const h1 = (document.querySelector('h1')?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const quoted = H1_QUOTED_TERM_RE.exec(h1);
  if (quoted !== null && quoted[1]!.trim().length > 0) return quoted[1]!.trim();
  const title = (document.querySelector('title')?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const titled = TITLE_TERM_RE.exec(title);
  if (titled !== null && titled[1]!.trim().length > 0) return titled[1]!.trim();
  return null;
}

/**
 * Anchor-href-based primary extraction: every link whose href matches the
 * VIP pattern becomes a candidate, deduplicated by ad id in DOM order;
 * card selectors only enrich the snippet fields.
 */
export function extractSearchResults(
  document: Document,
  pageUrl: string,
  context: KijijiSearchContext = {},
): KijijiSearchPage {
  const apollo = readKijijiApolloCache(document);
  const observedAt = context.observedAt ?? new Date();
  const seen = new Set<string>();
  const results: KijijiSearchResult[] = [];
  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    let absolute: URL;
    try {
      absolute = new URL(href, pageUrl);
    } catch {
      continue;
    }
    const host = absolute.hostname.toLowerCase();
    if (host !== 'kijiji.ca' && !host.endsWith('.kijiji.ca')) continue;
    if (/^\/b-/.test(absolute.pathname)) continue; // pagination/category links
    const adId = adIdFromUrl(absolute.toString());
    if (!adId || seen.has(adId)) continue;
    seen.add(adId);

    const card = anchor.closest(CARD_CONTAINER_SELECTOR) ?? anchor;
    const anchorText = anchor.textContent?.replace(/\s+/g, ' ').trim();
    const title = cardText(card, CARD_TITLE_SELECTOR) ?? (anchorText && anchorText.length > 0 ? anchorText : null);
    const priceText = cardText(card, CARD_PRICE_SELECTOR);
    const locationText = cardText(card, CARD_LOCATION_SELECTOR);
    const postedText = cardPostedText(card, locationText, observedAt);

    // A stated instant before arithmetic on a label: the datetime the card
    // carries, then the activation date the hydration cache states for this
    // exact ad (the only statement of it in server HTML), and only then the
    // rendered relative label — truncated to its own unit and marked as
    // derived, so the fetch clock never leaks into a card (2026-09-06).
    const cardDatetime = cardPostedDatetime(card);
    const hydrationDate = toIsoOrNull(apolloActivationDate(apollo, adId));
    const label = postedText === null ? null : parseKijijiPostedLabel(postedText, observedAt);
    let postedAt: string | null = null;
    let postedAtSource: KijijiSearchResult['postedAtSource'] = null;
    let postedAtPrecision: KijijiPostedPrecision | null = null;
    if (cardDatetime !== null) {
      postedAt = cardDatetime;
      postedAtSource = 'card_datetime';
      postedAtPrecision = 'exact';
    } else if (hydrationDate !== null) {
      postedAt = hydrationDate;
      postedAtSource = 'hydration';
      postedAtPrecision = 'exact';
    } else if (label !== null) {
      postedAt = label.postedAt;
      postedAtSource = 'relative_text';
      postedAtPrecision = label.precision;
    }

    results.push({
      adId,
      url: absolute.toString(),
      title,
      priceText,
      price: priceText === null ? null : parseKijijiPrice(priceText),
      locationText,
      postedText,
      postedAt,
      postedAtSource,
      postedAtPrecision,
    });
  }

  let nextPageUrl: string | null = null;
  for (const selector of NEXT_PAGE_SELECTORS) {
    let el: Element | null;
    try {
      el = document.querySelector(selector);
    } catch {
      continue;
    }
    const href = el?.getAttribute('href');
    if (!href) continue;
    try {
      nextPageUrl = new URL(href, pageUrl).toString();
      break;
    } catch {
      continue;
    }
  }

  // Result count: the authoritative signal for "is there more".
  let totalResults: number | null = null;
  let shownThrough: number | null = null;
  for (const selector of RESULT_COUNT_SELECTORS) {
    let elements: Element[];
    try {
      elements = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    for (const el of elements) {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ');
      const range = COUNT_RANGE_RE.exec(text);
      if (range) {
        shownThrough = toInt(range[2]!);
        totalResults = toInt(range[3]!);
        break;
      }
      const total = COUNT_TOTAL_RE.exec(text);
      if (total && totalResults === null) totalResults = toInt(total[1]!);
    }
    if (totalResults !== null && shownThrough !== null) break;
  }

  // Live pages render no count element and no pagination link at all; both
  // are hydrated. What the page ships is a title stating the total and a
  // hydration cache stating offset/limit/totalCount, so the cache fills
  // whatever the rendered scan above could not.
  const pagination = apolloPagination(apollo, pageUrl);
  if (totalResults === null && pagination !== null) totalResults = pagination.totalCount;
  if (shownThrough === null && pagination !== null) shownThrough = pagination.offset + results.length;

  const seenSoFar = shownThrough ?? results.length;
  const moreByCount = totalResults !== null && Number.isFinite(totalResults) && seenSoFar < totalResults;
  if (moreByCount && nextPageUrl === null) nextPageUrl = nextKijijiPageUrl(pageUrl);

  const pageTitle = (document.querySelector('title')?.textContent ?? '').replace(/\s+/g, ' ').trim();

  const warnings: string[] = [];
  const hasNextPage = nextPageUrl !== null || moreByCount;
  const sortParam = sortParamOf(pageUrl);
  if (results.length > 0 && totalResults === null && nextPageUrl === null) {
    // A page that rendered ads but states no count and links no next page
    // has said nothing about the result set; hasNextPage:false here is the
    // absence of evidence, not a last page. Say which fields are missing and
    // which URL form has been seen to carry them.
    const unsorted = unsortedPageUrl(pageUrl);
    warnings.push(
      `${PAGINATION_METADATA_ABSENT_WARNING_PREFIX}: ${pageUrl} rendered ${results.length} candidate(s) but stated no result count and linked no next page, so totalResults:null, nextPageUrl:null and hasNextPage:false describe what the page withheld, not the end of the result set${
        sortParam === null ? '' : ` (a category URL carrying ${sortParam} renders neither; observed 2026-09-04)`
      }. Walk the category without the sort parameter${unsorted === null ? '' : ` — ${unsorted} — which does carry both`}, and never count this page as the whole category.`,
    );
  }
  const derivedFromLabel = results.filter((result) => result.postedAtSource === 'relative_text').length;
  if (derivedFromLabel > 0) {
    // 2026-09-06 deals fire: three live pages carried the fetch clock's
    // sub-second component on nearly every card, and one card-derived
    // postedAt was 373 days newer than the same ad's page. Say how many
    // cards are arithmetic, what the arithmetic measures, and what is not
    // evidence of freshness.
    warnings.push(
      `${POSTED_AT_FROM_RELATIVE_LABEL_WARNING_PREFIX}: ${derivedFromLabel} of ${results.length} card(s) carry a postedAt derived from the card's relative label ("2 hrs ago") measured back from the fetch clock at ${observedAt.toISOString()} and truncated to the label's unit (postedAtSource "relative_text", postedAtPrecision minute|hour|day|week|month). That figure is the ad's last ACTIVATION as the card rounds it — a bumped or reposted ad reads as new here — and is not the ad's original posting date; only the ad page's postedAt is evidence of freshness, so open the ad before calling it new this fire. Cards with postedAtSource "hydration" or "card_datetime" state their instant.`,
    );
  }
  if (sortParam !== null && /^sort=dateDesc$/i.test(sortParam) && newestFirstViolated(results)) {
    warnings.push(
      `${SORT_NOT_HONOURED_WARNING_PREFIX}: ${pageUrl} asked for newest first (${sortParam}) but the rendered posted times are not in newest-first order, so this page is not "everything since the last fire"; filter by postedAt yourself and do not treat page 1 of a sorted sweep as the recent delta.`,
    );
  }

  return {
    results,
    hasNextPage,
    nextPageUrl,
    totalResults,
    pageTitle: pageTitle.length > 0 ? pageTitle : null,
    searchTerm: readSearchTerm(document, apollo, pageUrl),
    removedAdId: removedAdIdFromUrl(pageUrl),
    warnings,
  };
}

/** Kijiji's own slug form: lower case, runs of anything else become '-'. */
function kijijiSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The keyword a Kijiji search URL asks for, or null when it asks for none.
 * Two forms carry one: ?q=<keyword> (buildSearchUrl), and the keyword-in-
 * path form, where the keyword is the LAST slug before the id segment —
 * /b-<location>/<keyword>/k0l<regionId> under all categories (k…), or
 * /b-<category>/<location>/<keyword>/c<cat>l<regionId> (an id segment
 * naming a category, c…, spends its first two slugs on category and
 * location). A path with fewer slugs than that is a category or location
 * browse and asks for no keyword.
 */
export function kijijiRequestedKeyword(pageUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  const q = url.searchParams.get('q');
  if (q !== null && q.trim().length > 0) return q.trim();
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0 && !/^page-\d+$/.test(segment));
  if (segments.length < 2 || !segments[0]!.startsWith('b-')) return null;
  const last = segments[segments.length - 1]!;
  const id = /^(k\d+)?(c\d+)?l\d+(?:r\d+)?$/i.exec(last);
  if (id === null) return null;
  const slugs = [segments[0]!.slice(2), ...segments.slice(1, -1)];
  const slugsBeforeKeyword = id[2] === undefined ? 1 : 2;
  if (slugs.length <= slugsBeforeKeyword) return null;
  return slugs[slugs.length - 1]!;
}

/** Warning-code prefix for a search page that ran a different keyword than its URL asked for. */
export const KEYWORD_NOT_APPLIED_WARNING_PREFIX = 'KEYWORD_NOT_APPLIED';

/**
 * Warnings for a search page whose stated keyword is not the one its URL
 * asked for. Observed live 2026-09-02 (deals fire, fingerprint site-kijiji+
 * extractor_defect+b-keyword-path-silently-drops-keyword): a keyword put in
 * the FIRST path segment is read by the site as a location/category slug
 * and the page runs a different query, or none — and reports a perfectly
 * ordinary result set for it. Both sides are compared as Kijiji slugs, so
 * "Lego bulk lot" and lego-bulk-lot agree.
 */
export function kijijiKeywordWarnings(
  pageUrl: string,
  page: Pick<KijijiSearchPage, 'searchTerm' | 'pageTitle'>,
): string[] {
  const requested = kijijiRequestedKeyword(pageUrl);
  if (requested === null) return [];
  if (page.searchTerm !== null && kijijiSlug(page.searchTerm) === kijijiSlug(requested)) return [];
  const stated =
    page.searchTerm === null
      ? 'the page states no keyword at all (it rendered as a category or location browse)'
      : `the page states it searched for "${page.searchTerm}"`;
  const title = page.pageTitle === null ? '' : ` Page title: "${page.pageTitle}".`;
  return [
    `${KEYWORD_NOT_APPLIED_WARNING_PREFIX}: the URL asked for keyword "${requested}" but ${stated}, so these results are not for your query — do not count them as coverage of it.${title} Kijiji's keyword-in-path form is /b-<location-slug>/<keyword>/k0l<regionId> (the keyword LAST before the id segment); a keyword in the first segment is read as a location/category slug and dropped (observed live 2026-09-02).`,
  ];
}

export interface KijijiSearchUrlInput {
  /** Free-text search terms; empty string omits the query parameter. */
  query: string;
  /**
   * Caller-provided category/location path segments in "b-buy-sell/canada"
   * style (e.g. "b-buy-sell/city-of-toronto/c10l1700273"). Leading and
   * trailing slashes are tolerated; empty falls back to "b-buy-sell/canada".
   * The l<regionId> segment is the ONLY location scope Kijiji honours.
   */
  categoryPath: string;
  sortByNewest: boolean;
}

/**
 * Build a kijiji.ca search URL. Total by construction: every input shape
 * yields a syntactically valid URL, and each parameter is emitted in one
 * obvious place so live adjustments are single-line changes.
 *
 * Deliberately no radius or address: both parameters are ignored by the
 * live site (module header). A caller that wants a wider or narrower area
 * changes the l<regionId> in categoryPath, and only to an id whose rendered
 * page header was confirmed live — l1700273 renders "City of Toronto"
 * (office fire, 2026-09-02), not the GTA.
 *
 * NEEDS-LIVE-VERIFICATION: sort=dateDesc for newest-first was observed
 * live on 2026-09-02; the free-text query as "q" has NOT been, and the
 * observed working form puts the keyword in the path instead — see
 * buildKeywordSearchUrl(). Prefer that builder for keyword searches.
 */
export function buildSearchUrl(input: KijijiSearchUrlInput): string {
  const path = input.categoryPath.replace(/^\/+|\/+$/g, '');
  const url = new URL(`https://www.kijiji.ca/${path.length > 0 ? path : 'b-buy-sell/canada'}`);
  const query = input.query.trim();
  if (query.length > 0) url.searchParams.set('q', query);
  if (input.sortByNewest) url.searchParams.set('sort', 'dateDesc');
  return url.toString();
}

export interface KijijiKeywordSearchUrlInput {
  /** Free-text keyword; whitespace runs become '-' like Kijiji's own slugs. */
  keyword: string;
  /** Location slug as Kijiji renders it, e.g. "gta-greater-toronto-area". Decorative: the id scopes. */
  locationSlug: string;
  /** Region id, digits only ("1700273"); a leading "l" is tolerated. */
  regionId: string;
  sortByNewest: boolean;
}

/**
 * The keyword-in-path search form observed live on 2026-09-02:
 * https://www.kijiji.ca/b-gta-greater-toronto-area/lego/k0l1700273?sort=dateDesc
 * returned totalResults=3915 of genuine LEGO ads. k0 is "all categories";
 * the region id after the l is the only location scope. The keyword MUST be
 * the second segment: the same fire saw /b-lego/gta-greater-toronto-area/
 * k0l1700273 silently drop the keyword and return 77 unrelated ads.
 */
export function buildKeywordSearchUrl(input: KijijiKeywordSearchUrlInput): string {
  const keyword = input.keyword
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const location = input.locationSlug.replace(/^\/+|\/+$/g, '').replace(/^b-/, '');
  const regionId = input.regionId.trim().replace(/^l/i, '');
  const url = new URL(`https://www.kijiji.ca/b-${location}/${keyword}/k0l${regionId}`);
  if (input.sortByNewest) url.searchParams.set('sort', 'dateDesc');
  return url.toString();
}

/** Warning-code prefix for a search URL carrying the inert radius/address parameters. */
export const RADIUS_PARAM_INERT_WARNING_PREFIX = 'RADIUS_PARAM_INERT';

/**
 * Warnings for a search URL as it was actually requested. A URL carrying
 * radius= or address= reads like a radius sweep and is not one: the site
 * ignores both (module header). Naming the region id in the text keeps the
 * reader looking at the one segment that does scope the results.
 */
export function kijijiSearchUrlWarnings(pageUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return [];
  }
  const inert: string[] = [];
  for (const name of ['radius', 'address'] as const) {
    const value = url.searchParams.get(name);
    if (value !== null) inert.push(`${name}=${value}`);
  }
  if (inert.length === 0) return [];
  // Trailing segment shapes: k0l1700273 (all categories), c10l1700273 (a category).
  const region = /\/[a-z]\d*(l\d+)(?:[/?#]|$)/i.exec(url.pathname);
  const scope = region === null ? 'no l<regionId> path segment (all of Canada)' : `the ${region[1]} path segment alone`;
  return [
    `${RADIUS_PARAM_INERT_WARNING_PREFIX}: kijiji.ca ignores ${inert.join(' and ')} (observed live 2026-09-02: identical result sets for radius=45 and radius=65, and Edmonton/Winnipeg ads for a 45 km radius around M6H 2W9 without a region id). Results are scoped by ${scope}; do not report this as a radius pass.`,
  ];
}
