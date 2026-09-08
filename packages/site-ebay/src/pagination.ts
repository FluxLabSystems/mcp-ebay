/**
 * Page-level count and pagination reads shared by the eBay candidate pages:
 * the signed-in My eBay surfaces (watch list, bids/offers) and, since
 * 2026-09-08, the /sch/ search page including its _ssn= seller form.
 *
 * These were private to myebay.ts until the 2026-09-07 first full seller
 * drill-down found that an _ssn= page returned NO totalResults, hasNextPage
 * or nextPageUrl at all — only the page-local candidateCount/hasMore — so a
 * 36-seller walk had to append &_pgn=N blind and infer the end from a short
 * page (fingerprint ssn-seller-search-returns-no-totalresults-or-nextpage).
 * The readers are the same ones the watch list already trusted; the
 * warning prefixes differ per page kind.
 */
import { normalizeText } from './traversal.js';

/**
 * A stated total below the rows the page itself rendered cannot be the
 * list's total; it is some other label ("1 item" on one row). Drop it and
 * say so, rather than hand the audit a count it will compare rows against.
 */
export function checkedTotalCount(
  read: { count: number | null; source: string | null },
  renderedRows: number,
  prefix: string,
  warnings: string[],
): { count: number | null; source: string | null; statedCount: number | null; statedCountSource: string | null } {
  const stated = { statedCount: read.count, statedCountSource: read.count === null ? null : read.source };
  if (read.count === null || read.count >= renderedRows) return { ...read, ...stated };
  // The number is rejected as the total, not forgotten: on 2026-09-07 the
  // selected All Categories chip read 314 while the overflow render of the
  // same list carried 318 unique rows (reconciled exactly against stored
  // state), and nulling the count outright left the walk unable to audit
  // the 4-row gap. statedCount keeps what the page said; totalResults
  // stays null because a count below the rows is not the list's total.
  warnings.push(
    `${prefix}: the page's count label "${read.source ?? ''}" reads ${read.count}, below the ${renderedRows} rows this page rendered, so it is not accepted as the list total and totalResults is null; the label's number is kept as statedCount (${read.count}) for the audit. Count coverage as unique item ids after dedupe, and never use the label to decide whether an overflow read got the whole list — it passes a read that is short by the same margin (2026-09-07: "All Categories (314)" against 318 rendered rows). If the label names some other thing (one row's "1 item"), file it through the improvement queue with a browser_snapshot so the real list-count element can be pinned.`,
  );
  return { count: null, source: null, ...stated };
}

/** The page number the URL asks for (?page=, eBay's _pgn=, …); null when it names none. */
export function pageNumberOf(pageUrl: string): number | null {
  try {
    const url = new URL(pageUrl);
    for (const key of ['page', '_pgn', 'pgn', 'pageNumber', 'ipg_page']) {
      const raw = url.searchParams.get(key);
      if (raw !== null && /^\d{1,4}$/.test(raw)) return Number.parseInt(raw, 10);
    }
  } catch {
    return null;
  }
  return null;
}

/** eBay's per-page size parameter (_ipg=240 on a seller sweep); null when the URL names none. */
export function pageSizeOf(pageUrl: string): number | null {
  try {
    const raw = new URL(pageUrl).searchParams.get('_ipg');
    if (raw !== null && /^\d{1,4}$/.test(raw)) return Number.parseInt(raw, 10);
  } catch {
    return null;
  }
  return null;
}

export function withPage(pageUrl: string, page: number): string | null {
  try {
    const url = new URL(pageUrl);
    // The URL's own page key when it carries one; otherwise eBay's search
    // key on a /sch/ URL (its page 1 carries no _pgn) and the My eBay key
    // elsewhere.
    const key =
      ['page', '_pgn', 'pgn', 'pageNumber'].find((name) => url.searchParams.has(name)) ??
      (/\/sch\//.test(url.pathname) ? '_pgn' : 'page');
    url.searchParams.set(key, String(page));
    return url.toString();
  } catch {
    return null;
  }
}

export function isDisabled(el: Element): boolean {
  return (
    el.hasAttribute('disabled') ||
    el.getAttribute('aria-disabled') === 'true' ||
    /\b(?:disabled|is-disabled)\b/.test(el.getAttribute('class') ?? '')
  );
}

export interface PaginationRead {
  hasNextPage: boolean;
  nextPageUrl: string | null;
  currentPage: number | null;
  /**
   * Whether any next-page control was recognised at all. False means the
   * page rendered no pagination the readers know — which is not the same
   * as a last page, and the search reader says so rather than reporting
   * hasNextPage false on a page that simply did not state it.
   */
  controlFound: boolean;
}

/**
 * The next-page control, from the site's own markup: a rel=next anchor, an
 * aria-labelled control, or the pagination widget's next button. An anchor
 * gives the URL outright; a button (client-side pagination) gives only the
 * fact that there is a next page, so the URL is derived from the current
 * page number and said to be derived.
 */
export function readPagination(
  document: Document,
  pageUrl: string,
  warnings: string[],
  options: { derivedWarningPrefix?: string } = {},
): PaginationRead {
  const prefix = options.derivedWarningPrefix ?? 'WATCHLIST_NEXT_URL_DERIVED';
  const currentPage = pageNumberOf(pageUrl);
  let controls: Element[] = [];
  try {
    controls = Array.from(
      document.querySelectorAll(
        'a[rel="next"], link[rel="next"], [aria-label="Next page" i], [aria-label="Next" i], [aria-label*="next page" i], a.pagination__next, button.pagination__next, .pagination__next a, .pagination__next button, a[class*="next"], button[class*="next"]',
      ),
    );
  } catch {
    controls = [];
  }
  for (const control of controls) {
    const label = normalizeText(control.textContent).toLowerCase();
    const aria = (control.getAttribute('aria-label') ?? '').toLowerCase();
    // "next" has to be about pagination: a card's "next day delivery" span
    // matches the class selector and must not become a page.
    const looksLikeNext =
      control.getAttribute('rel') === 'next' ||
      /\bnext\b/.test(aria) ||
      /^(?:next|next page|›|»|>)$/.test(label) ||
      /\bpagination\b/.test(control.getAttribute('class') ?? '') ||
      /\bpagination\b/.test(control.parentElement?.getAttribute('class') ?? '');
    if (!looksLikeNext) continue;
    if (isDisabled(control)) return { hasNextPage: false, nextPageUrl: null, currentPage, controlFound: true };
    const href = control.getAttribute('href');
    if (href !== null && href.length > 0 && !/^(?:#|javascript:)/i.test(href)) {
      try {
        return { hasNextPage: true, nextPageUrl: new URL(href, pageUrl).toString(), currentPage, controlFound: true };
      } catch {
        // fall through to derivation
      }
    }
    const derived = withPage(pageUrl, (currentPage ?? 1) + 1);
    warnings.push(
      `${prefix}: the page's next control carries no href (client-side pagination), so nextPageUrl was derived from the current page number as ${derived ?? 'nothing'}; confirm the derived page renders different rows before counting it.`,
    );
    return { hasNextPage: true, nextPageUrl: derived, currentPage, controlFound: true };
  }
  return { hasNextPage: false, nextPageUrl: null, currentPage, controlFound: false };
}

/**
 * The page the pagination widget marks as selected — what the site says it
 * served, as opposed to what the URL asked for. Null when no item is marked.
 * NEEDS-LIVE-VERIFICATION: eBay's search pagination renders the selected
 * item as `a.pagination__item[aria-current="page"]` on the captured
 * templates this was written against; no live _ssn= page has been captured.
 */
export function readSelectedPage(document: Document): number | null {
  let items: Element[] = [];
  try {
    items = Array.from(
      document.querySelectorAll(
        '.pagination__item[aria-current="page"], .pagination [aria-current="page"], .pagination__item.selected, .pagination__item[aria-selected="true"], [class*="pagination"] [aria-current="page"]',
      ),
    );
  } catch {
    items = [];
  }
  for (const item of items) {
    const text = normalizeText(item.textContent).replace(/[^\d]/g, '');
    if (/^\d{1,4}$/.test(text)) return Number.parseInt(text, 10);
  }
  return null;
}
