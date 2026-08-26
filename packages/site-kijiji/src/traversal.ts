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
 */
import { adIdFromUrl, parseKijijiPrice } from './normalize.js';
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
  postedText: string | null;
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
}

// Card-enrichment selectors are secondary; the anchor-href VIP pattern is
// the primary signal so extraction survives layout churn.
// NEEDS-LIVE-VERIFICATION: data-testid hooks on current Kijiji search cards.
const CARD_CONTAINER_SELECTOR = '[data-testid^="listing-card"], li, article, section';
const CARD_TITLE_SELECTOR = '[data-testid="listing-title"], h3, [class*="title"]';
const CARD_PRICE_SELECTOR = '[data-testid="listing-price"], [class*="price"]';
const CARD_LOCATION_SELECTOR = '[data-testid="listing-location"], [class*="location"]';
const CARD_POSTED_SELECTOR = '[data-testid="listing-date"], time, [class*="datePosted"]';

/** "1 - 40 of 73 Ads", "73 results", "Showing 1-40 of 1,234". */
const RESULT_COUNT_SELECTORS = [
  '[data-testid="srp-results-count"]',
  '[data-testid="results-count"]',
  '[class*="resultsCount"]',
  '[class*="showingResults"]',
  'h1',
  'header',
];
const COUNT_RANGE_RE = /\b([\d,]+)\s*[-\u2013]\s*([\d,]+)\s+of\s+([\d,]+)/i;
const COUNT_TOTAL_RE = /\b([\d,]+)\s+(?:ads?|results?|listings?)\b/i;

function toInt(raw: string): number {
  return Number.parseInt(raw.replace(/,/g, ''), 10);
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
 * Anchor-href-based primary extraction: every link whose href matches the
 * VIP pattern becomes a candidate, deduplicated by ad id in DOM order;
 * card selectors only enrich the snippet fields.
 */
export function extractSearchResults(document: Document, pageUrl: string): KijijiSearchPage {
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

    results.push({
      adId,
      url: absolute.toString(),
      title,
      priceText,
      price: priceText === null ? null : parseKijijiPrice(priceText),
      locationText: cardText(card, CARD_LOCATION_SELECTOR),
      postedText: cardText(card, CARD_POSTED_SELECTOR),
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

  const seenSoFar = shownThrough ?? results.length;
  const moreByCount = totalResults !== null && Number.isFinite(totalResults) && seenSoFar < totalResults;
  if (moreByCount && nextPageUrl === null) nextPageUrl = nextKijijiPageUrl(pageUrl);

  return { results, hasNextPage: nextPageUrl !== null || moreByCount, nextPageUrl, totalResults };
}

export interface KijijiSearchUrlInput {
  /** Free-text search terms; empty string omits the query parameter. */
  query: string;
  /**
   * Caller-provided category/location path segments in "b-buy-sell/canada"
   * style (e.g. "b-buy-sell/city-of-toronto/c10l1700273"). Leading and
   * trailing slashes are tolerated; empty falls back to "b-buy-sell/canada".
   */
  categoryPath: string;
  /** Radius in km. The Fluxology 45 and 65 passes are separate calls. */
  radiusKm: number;
  /** Centre address Kijiji geocodes (e.g. "M6H 2W9"); null omits it. */
  address: string | null;
  sortByNewest: boolean;
}

/**
 * Build a kijiji.ca search URL. Total by construction: every input shape
 * yields a syntactically valid URL, and each parameter is emitted in one
 * obvious place so live adjustments are single-line changes.
 *
 * NEEDS-LIVE-VERIFICATION: current Kijiji radius search uses query params
 * in the ?radius=45&address=... style and sort=dateDesc for newest-first,
 * and the free-text query is passed here as "q"; confirm all four against
 * live search URLs (the live site may embed the query as a path segment
 * before the category code instead of a parameter).
 */
export function buildSearchUrl(input: KijijiSearchUrlInput): string {
  const path = input.categoryPath.replace(/^\/+|\/+$/g, '');
  const url = new URL(`https://www.kijiji.ca/${path.length > 0 ? path : 'b-buy-sell/canada'}`);
  const query = input.query.trim();
  if (query.length > 0) url.searchParams.set('q', query);
  if (Number.isFinite(input.radiusKm) && input.radiusKm > 0) {
    url.searchParams.set('radius', String(input.radiusKm));
  }
  if (input.address !== null && input.address.trim().length > 0) {
    url.searchParams.set('address', input.address.trim());
  }
  if (input.sortByNewest) url.searchParams.set('sort', 'dateDesc');
  return url.toString();
}
