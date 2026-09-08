/**
 * Page-level reads for the eBay /sch/ search page and the /str/ store page:
 * the stated result total, the pagination control, the page the site says
 * it served against the page the URL asked for, and — on the _ssn= seller
 * form — whose rows these are.
 *
 * Two 2026-09-07 deals reports (the first full watched-seller drill-down,
 * 36 sellers, 44 page reads):
 *
 * - ssn-seller-search-returns-no-totalresults-or-nextpage: an _ssn= page
 *   returned only the page-local candidateCount/hasMore, never a total or a
 *   next-page URL, so the walk appended &_pgn=N blind, inferred the end
 *   from a short page, and could not audit its counts against anything.
 *   Worse, a _pgn past the last page SILENTLY re-serves the last page
 *   (treasurequestca _pgn=3 byte-identical to _pgn=2), which a naive walker
 *   counts twice. The watch list already read a total and a next control;
 *   this module reads the search page's.
 * - seller-search-row-attributes-listing-to-wrong-seller: item 227509015721
 *   came back for _ssn=dkbooksandtreasures and was recorded as that
 *   seller's only LEGO listing; its item page names fantasma713. The
 *   extractor never attributed the row to anyone — the query did — so the
 *   page now says which rows state a seller, which state a different one,
 *   and that the rest are query results, not the seller's inventory.
 *
 * Nothing here is canonical listing evidence: the item page still decides
 * every field, the seller included (§20.2).
 */
import { checkedTotalCount, pageNumberOf, pageSizeOf, readPagination, readSelectedPage, withPage } from './pagination.js';
import { normalizeText, type ListingCandidate } from './traversal.js';

/**
 * Where eBay states the result total on a search page: the count heading
 * ("<span class="BOLD">1,113</span> results"). NEEDS-LIVE-VERIFICATION: the
 * class names are the search-results template's as known from earlier
 * captures; no live _ssn= page has been captured as a fixture.
 */
const COUNT_HEADING_SELECTOR =
  '.srp-controls__count-heading, [class*="count-heading"], .srp-controls__count, [class*="results-count"], h1, h2, [role="heading"]';
/** "1,113 results", "10,000+ results", "463 results for lego". */
const RESULTS_COUNT_RE = /\b(\d[\d,]*)\s*(\+?)\s+results?\b/i;

export interface SearchCountRead {
  count: number | null;
  source: string | null;
  /** True when the heading says "N+ results": N is a floor the site chose, not the total. */
  lowerBound: boolean;
}

export function readSearchResultCount(document: Document): SearchCountRead {
  let headings: Element[] = [];
  try {
    headings = Array.from(document.querySelectorAll(COUNT_HEADING_SELECTOR));
  } catch {
    headings = [];
  }
  for (const heading of headings) {
    const text = normalizeText(heading.textContent);
    const match = RESULTS_COUNT_RE.exec(text);
    if (match === null) continue;
    return {
      count: Number.parseInt(match[1]!.replace(/,/g, ''), 10),
      source: text.slice(0, 80),
      lowerBound: match[2] === '+',
    };
  }
  return { count: null, source: null, lowerBound: false };
}

/** The `_ssn=` value of a seller search URL, decoded; null on any other search. */
export function sellerQueryOf(pageUrl: string): string | null {
  try {
    const raw = new URL(pageUrl).searchParams.get('_ssn');
    if (raw === null) return null;
    const value = raw.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export interface SearchPageMeta {
  /** The stated result total; null when the page states none or the label was rejected. */
  totalResults: number | null;
  totalCountSource: string | null;
  /** The count label's number even when rejected as the total (see checkedTotalCount). */
  statedCount: number | null;
  statedCountSource: string | null;
  /** From the pagination control; null when the page renders none the readers know. */
  hasNextPage: boolean | null;
  nextPageUrl: string | null;
  /** The page served: the selected pagination item, else the URL's page number, else null. */
  currentPage: number | null;
  currentPageSource: 'pagination' | 'url' | null;
  /** The page the URL asked for (_pgn=); null when it named none (page 1). */
  requestedPage: number | null;
  /** The `_ssn=` seller of a seller search; null on any other page. */
  sellerQuery: string | null;
}

export interface SearchPageMetaInput {
  document: Document;
  pageUrl: string;
  candidates: readonly ListingCandidate[];
  /** 'search' for /sch/, 'store' for /str/ and /usr/: the warning text names the page kind. */
  pageKind: 'search' | 'store';
  warnings: string[];
}

/**
 * Reads the page-level fields and pushes the warnings that say what the page
 * did NOT state. Every field is what the page rendered; nothing is inferred
 * from the row count except the clamp check, which compares two things the
 * page and the URL each said.
 */
export function extractSearchPageMeta(input: SearchPageMetaInput): SearchPageMeta {
  const { document, pageUrl, candidates, pageKind, warnings } = input;
  const kindLabel = pageKind === 'search' ? 'search page' : 'store page';
  const rendered = candidates.length;

  const read = readSearchResultCount(document);
  const { count: totalResults, source: totalCountSource, statedCount, statedCountSource } = checkedTotalCount(
    { count: read.count, source: read.source },
    rendered,
    'SEARCH_TOTAL_REJECTED',
    warnings,
  );
  if (read.count === null) {
    warnings.push(
      `SEARCH_TOTAL_UNSTATED: no result-count heading was found on this ${kindLabel}, so totalResults is null; audit the walk by unique item ids across pages, never against a total the page has not stated. Capture the count element (browser_snapshot, maxNodes 40, the top of the page) and file it through the improvement queue so the selector can be pinned.`,
    );
  } else if (read.lowerBound && totalResults !== null) {
    warnings.push(
      `SEARCH_TOTAL_LOWER_BOUND: the count heading reads "${read.source ?? ''}" — eBay states a floor, not the total — so totalResults ${totalResults} is the least the result set holds and a walk that reaches it is not necessarily complete.`,
    );
  }

  const pagination = readPagination(document, pageUrl, warnings, { derivedWarningPrefix: 'SEARCH_NEXT_URL_DERIVED' });
  const requestedPage = pageNumberOf(pageUrl);
  const selectedPage = readSelectedPage(document);
  let currentPage: number | null = selectedPage;
  let currentPageSource: SearchPageMeta['currentPageSource'] = selectedPage === null ? null : 'pagination';
  if (currentPage === null && requestedPage !== null) {
    currentPage = requestedPage;
    currentPageSource = 'url';
  }
  let hasNextPage: boolean | null = pagination.controlFound ? pagination.hasNextPage : null;
  let nextPageUrl = pagination.nextPageUrl;

  // The clamp: eBay answers a _pgn past the last page with the last page,
  // status 200, rows and all. Two independent tells, either sufficient —
  // the widget marks a lower page as selected than the URL asked for, or
  // the stated total fits inside the pages before the one requested.
  const pageSize = pageSizeOf(pageUrl);
  const clampedBySelection = requestedPage !== null && selectedPage !== null && selectedPage < requestedPage;
  const clampedByTotal =
    requestedPage !== null &&
    requestedPage > 1 &&
    totalResults !== null &&
    !read.lowerBound &&
    pageSize !== null &&
    totalResults <= (requestedPage - 1) * pageSize;
  if (clampedBySelection || clampedByTotal) {
    const tell = clampedBySelection
      ? `the pagination control marks page ${selectedPage} as the one served`
      : `the stated total ${totalResults} fits in ${Math.ceil((totalResults ?? 0) / (pageSize ?? 1))} page(s) of ${pageSize}`;
    warnings.push(
      `SEARCH_PAGE_CLAMPED: the URL asked for page ${requestedPage} but ${tell}, so eBay re-served its last page rather than an empty one (2026-09-07: _ssn=treasurequestca _pgn=3 returned rows byte-identical to _pgn=2). The rows on this read are the previous page's — count nothing from them, and treat the walk as complete at page ${selectedPage ?? requestedPage - 1}.`,
    );
    hasNextPage = false;
    nextPageUrl = null;
  } else if (hasNextPage === null) {
    const next = withPage(pageUrl, (currentPage ?? 1) + 1);
    warnings.push(
      `SEARCH_PAGINATION_UNSTATED: no next-page control was recognised on this ${kindLabel}, so hasNextPage is null — not false: the page did not say. ${
        pageSize !== null && rendered >= pageSize
          ? `It rendered a full page of ${rendered} (the URL's _ipg is ${pageSize}), so more may follow: `
          : `It rendered ${rendered} row(s): `
      }to continue, open ${next ?? 'the next page number'} and compare its item ids with this page's — an identical set is the clamp, not a new page. Capture the pagination widget (browser_snapshot, maxNodes 40, the bottom of the page) and file it so the control can be pinned.`,
    );
  } else if (totalResults !== null && !read.lowerBound && hasNextPage === false && pageSize !== null) {
    // A last page that the total says is not the last: say so, rather than
    // let a walk stop on a control it may have misread.
    const served = currentPage ?? 1;
    if (totalResults > served * pageSize) {
      warnings.push(
        `SEARCH_PAGINATION_DISAGREES: the next-page control reads disabled on page ${served} while the stated total ${totalResults} needs ${Math.ceil(totalResults / pageSize)} page(s) of ${pageSize}; the walk is not complete on the control's word alone — open ${withPage(pageUrl, served + 1) ?? 'the next page number'} and compare item ids before stopping.`,
      );
    }
  }

  // Whose rows these are. On a seller search every row is a query result;
  // a row is the seller's only when a card (here) or the item page says so.
  const sellerQuery = pageKind === 'search' ? sellerQueryOf(pageUrl) : null;
  const rewriteRows = candidates.filter((row) => row.matchScope === 'rewrite');
  if (rewriteRows.length > 0) {
    const ids = rewriteRows.slice(0, 10).map((row) => row.itemId).join(', ');
    warnings.push(
      `SEARCH_REWRITE_ROWS: ${rewriteRows.length} of ${rendered} row(s) render below eBay's "Results matching fewer words" divider (matchScope "rewrite"; ids: ${ids}${rewriteRows.length > 10 ? ', …' : ''}); they match fewer of the query's words${sellerQuery === null ? '' : ` and are not necessarily ${sellerQuery}'s listings`}. Count them apart from the primary rows.`,
    );
  }
  if (sellerQuery !== null && rendered > 0) {
    const lowered = sellerQuery.toLowerCase();
    const stated = candidates.filter((row) => row.seller !== null);
    const mismatched = stated.filter((row) => row.seller!.toLowerCase() !== lowered);
    const unattributed = candidates.filter((row) => row.seller === null);
    if (mismatched.length > 0) {
      const detail = mismatched
        .slice(0, 10)
        .map((row) => `${row.itemId} → ${row.seller}`)
        .join('; ');
      warnings.push(
        `SELLER_SEARCH_ROW_MISMATCH: ${mismatched.length} of ${rendered} row(s) on the _ssn=${sellerQuery} page name a DIFFERENT seller on their card (${detail}${mismatched.length > 10 ? '; …' : ''}); they are not ${sellerQuery}'s listings and must not count toward that seller's inventory or relevance (2026-09-07: 227509015721 for _ssn=dkbooksandtreasures, item page seller fantasma713).`,
      );
    }
    if (unattributed.length > 0) {
      warnings.push(
        `SELLER_SEARCH_ROWS_UNATTRIBUTED: ${unattributed.length} of ${rendered} row(s) on the _ssn=${sellerQuery} page state no seller on their card (seller null), so each is "a result of the _ssn=${sellerQuery} query", not "${sellerQuery}'s listing", until its item page names the seller. Report a drill-down's count as candidates returned by the query; count a seller's inventory only from item pages (or from rows whose card states the login id).`,
      );
    }
  }

  return {
    totalResults,
    totalCountSource,
    statedCount,
    statedCountSource,
    hasNextPage,
    nextPageUrl,
    currentPage,
    currentPageSource,
    requestedPage,
    sellerQuery,
  };
}
