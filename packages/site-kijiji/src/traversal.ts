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
import { adIdFromUrl, parseKijijiPostedText, parseKijijiPrice } from './normalize.js';
import type { ParsedKijijiPrice } from './normalize.js';

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
  /** ISO instant the posted time resolves to; null when nothing states one. */
  postedAt: string | null;
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
   * The ad Kijiji redirected away from to land here, when it did. A removed
   * ad renders no banner and keeps no VIP: the ad URL 302s to its category
   * search page carrying ?adRemoved=<id>. That parameter is the removed-ad
   * marker, and this is a search page precisely because the ad is gone.
   */
  removedAdId: string | null;
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

    results.push({
      adId,
      url: absolute.toString(),
      title,
      priceText,
      price: priceText === null ? null : parseKijijiPrice(priceText),
      locationText,
      postedText,
      // The rendered relative time when it parses; otherwise the activation
      // date the page states for this exact ad, which is the only statement
      // of it in server HTML.
      postedAt:
        (postedText === null ? null : parseKijijiPostedText(postedText, observedAt)) ??
        toIsoOrNull(apolloActivationDate(apollo, adId)),
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

  return {
    results,
    hasNextPage: nextPageUrl !== null || moreByCount,
    nextPageUrl,
    totalResults,
    removedAdId: removedAdIdFromUrl(pageUrl),
  };
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
