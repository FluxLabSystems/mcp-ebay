/**
 * Search row → ListingCandidate — docs/COUNTDOWN-API-PLAN.md §3.1, §4.1.
 *
 * Pure. Every rule here rests on a measured fact from §1.3: the item id
 * comes from `link` (epid is sometimes a product id), the currency from the
 * raw price text (no `currency` field), the format ONLY from the filter the
 * row was retrieved under (`is_auction` is false on auctions in an
 * unfiltered search), and a title ending in " to" is a variant listing whose
 * price range the vendor lost.
 */
import {
  canonicalListingUrl,
  cleanTitle,
  itemIdFromUrl,
  parseMoney,
  type ListingCandidate,
  type SellingFormatKind,
} from '@browser-bridge/site-ebay';
import {
  COUNTDOWN_WARNING,
  domainCurrency,
  nonEmpty,
  normalizeCondition,
  readInt,
  readNumber,
  type CountdownDomain,
  type Mapped,
} from './common.js';
import { SearchResponseSchema, parseCountdownBody, type SearchPrice, type SearchRow } from './schemas.js';

/** The vendor filter a set of rows came back under; the ONLY source of a row's format. */
export type RetrievedUnder = 'buy_it_now' | 'auction' | 'accepts_offers' | 'unfiltered';

export interface ApiListingCandidate extends Omit<ListingCandidate, 'isNewListing'> {
  /** API rows carry no badge; the compactor tolerates null. */
  isNewListing: boolean | null;
  /** `shipping_cost` as a number; null when the card showed nothing the vendor could read. Never inferred as free. */
  shippingCost: number | null;
  /** True on a variant listing whose card price was a range or was lost entirely. */
  priceRange: boolean;
  /** The high bound of a two-entry price range; snippetPrice holds the low bound. */
  snippetPriceHigh: { value: number; currency: string } | null;
  /** Condition normalised to eBay's card vocabulary. */
  condition: string | null;
  /** The vendor's condition text when it differed from `condition` (seller subtitle glued in front). */
  conditionRaw: string | null;
  /** Measured false on all 540 demo rows; documented as unreliable. */
  sponsored: boolean | null;
  bestOffer: boolean | null;
  sellerName: string | null;
  sellerReviewCount: number | null;
  sellerPositivePercent: number | null;
  endedType: string | null;
  page: number | null;
  positionOverall: number | null;
}

export interface MapSearchRowsInput {
  /** A decoded search response (the client's `body`, or a fixture). */
  body: unknown;
  domain: CountdownDomain;
  retrievedUnder: RetrievedUnder;
  /** The page requested, used when rows carry no `page` of their own (single-page requests). */
  page?: number;
}

const TRAILING_TO_RE = /\sto$/i;
const LOCATED_IN_RE = /^\s*located\s+in\s+/i;

function formatFor(retrievedUnder: RetrievedUnder): SellingFormatKind {
  switch (retrievedUnder) {
    case 'auction':
      return 'auction';
    case 'buy_it_now':
    case 'accepts_offers':
      return 'fixed_price';
    case 'unfiltered':
      return 'unknown';
  }
}

function readPriceEntry(
  entry: SearchPrice | null | undefined,
  fallbackCurrency: string,
): { value: number; currency: string } | null {
  if (entry === null || entry === undefined) return null;
  const raw = nonEmpty(entry.raw);
  const parsed = raw === null ? null : parseMoney(raw, fallbackCurrency);
  const value =
    typeof entry.value === 'number' && Number.isFinite(entry.value) ? entry.value : (parsed?.value ?? null);
  if (value === null) return null;
  const explicit = nonEmpty(entry.currency);
  const currency = explicit !== null ? explicit.toUpperCase() : (parsed?.currency ?? fallbackCurrency);
  return { value, currency };
}

function readShippingCost(value: SearchRow['shipping_cost'], fallbackCurrency: string): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = parseMoney(value, fallbackCurrency);
  if (parsed !== null) return parsed.value;
  const bare = readNumber(value);
  // undefined: text present but unreadable, so the caller can count it.
  return bare === null ? undefined : bare;
}

function readBoolean(value: boolean | null | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Map one vendor response's rows. Rows are never re-ordered; dropped rows are counted in warnings. */
export function mapSearchRows(input: MapSearchRowsInput): Mapped<ApiListingCandidate[]> {
  const body = parseCountdownBody(SearchResponseSchema, input.body, 'search');
  const warnings: string[] = [];
  const currency = domainCurrency(input.domain);
  const sellingFormat = formatFor(input.retrievedUnder);
  const rows = (body.search_results ?? []).filter((row): row is SearchRow => row !== null && row !== undefined);

  let excludedRewritten = 0;
  let missingItemId = 0;
  let priceRangeUnparsed = 0;
  let shippingUnparsed = 0;
  const candidates: ApiListingCandidate[] = [];

  rows.forEach((row, index) => {
    if (row.is_rewritten_result === true) {
      excludedRewritten += 1;
      return;
    }
    const link = nonEmpty(row.link);
    const itemId = link === null ? null : itemIdFromUrl(link);
    if (itemId === null) {
      missingItemId += 1;
      return;
    }

    let priceRange = false;
    let title: string | null = null;
    const rawTitle = nonEmpty(row.title);
    if (rawTitle !== null) {
      let cleaned = cleanTitle(rawTitle);
      if (TRAILING_TO_RE.test(cleaned)) {
        cleaned = cleaned.replace(TRAILING_TO_RE, '').trim();
        priceRange = true;
      }
      title = cleaned.length > 0 ? cleaned : null;
    }

    const prices = (row.prices ?? []).filter((entry): entry is SearchPrice => entry !== null && entry !== undefined);
    let snippetPrice = readPriceEntry(row.price, currency) ?? readPriceEntry(prices[0], currency);
    let snippetPriceHigh: ApiListingCandidate['snippetPriceHigh'] = null;
    if (prices.length >= 2) {
      priceRange = true;
      const bounds = prices
        .map((entry) => readPriceEntry(entry, currency))
        .filter((entry): entry is { value: number; currency: string } => entry !== null)
        .sort((a, b) => a.value - b.value);
      const low = bounds[0];
      const high = bounds[bounds.length - 1];
      if (low !== undefined && high !== undefined && bounds.length >= 2) {
        snippetPrice = low;
        snippetPriceHigh = high;
      }
    }
    if (snippetPrice === null && priceRange) priceRangeUnparsed += 1;

    const shippingCost = readShippingCost(row.shipping_cost, currency);
    if (shippingCost === undefined) shippingUnparsed += 1;

    const location = nonEmpty(row.item_location);
    const itemLocationText = location === null ? null : nonEmpty(location.replace(LOCATED_IN_RE, ''));
    const { condition, conditionRaw } = normalizeCondition(row.condition);

    const position = row.position_overall ?? row.position;
    const order = typeof position === 'number' && Number.isFinite(position) && position >= 1 ? position - 1 : index;

    const seller = row.seller_info ?? null;
    candidates.push({
      itemId,
      url: canonicalListingUrl(itemId, `https://www.${input.domain}/itm/${itemId}`),
      title,
      snippetPrice,
      sellingFormat,
      bidCount: null,
      shippingSnippetText: null,
      itemLocationText,
      isNewListing: null,
      order,
      shippingCost: shippingCost ?? null,
      priceRange,
      snippetPriceHigh,
      condition,
      conditionRaw,
      sponsored: readBoolean(row.sponsored),
      bestOffer: readBoolean(row.best_offer),
      sellerName: seller === null ? null : nonEmpty(seller.name),
      sellerReviewCount: seller === null ? null : readInt(seller.review_count),
      sellerPositivePercent: seller === null ? null : readNumber(seller.positive_feedback_percent),
      endedType: row.ended === null || row.ended === undefined ? null : nonEmpty(row.ended.type),
      page: typeof row.page === 'number' ? row.page : (input.page ?? null),
      positionOverall: typeof row.position_overall === 'number' ? row.position_overall : null,
    });
  });

  if (excludedRewritten > 0) {
    warnings.push(
      `${COUNTDOWN_WARNING.EXCLUDED_REWRITTEN}: ${excludedRewritten} row(s) flagged is_rewritten_result ("results matching fewer words") were dropped.`,
    );
  }
  if (missingItemId > 0) {
    warnings.push(
      `${COUNTDOWN_WARNING.CANDIDATE_FIELDS_NULL}: itemId unreadable from link on ${missingItemId} row(s); dropped (epid is never used as an item id).`,
    );
  }
  if (priceRangeUnparsed > 0) {
    warnings.push(
      `${COUNTDOWN_WARNING.PRICE_RANGE_UNPARSED}: ${priceRangeUnparsed} variant listing(s) rendered a price range the source did not carry; kept with snippetPrice null and priceRange true. Open the listing for tier prices; this is not "no price".`,
    );
  }
  if (shippingUnparsed > 0) {
    warnings.push(
      `${COUNTDOWN_WARNING.SHIPPING_COST_UNPARSED}: shipping_cost text unreadable on ${shippingUnparsed} row(s); shippingCost null (unknown, never free).`,
    );
  }
  if (input.retrievedUnder === 'unfiltered' && candidates.length > 0) {
    warnings.push(
      `${COUNTDOWN_WARNING.FORMAT_UNKNOWN_ON_UNFILTERED_SEARCH}: an unfiltered search cannot tell an auction from a fixed price (is_auction reads false on live auctions); sellingFormat is unknown on all ${candidates.length} candidate(s). Retrieve under buy_it_now and auction and merge.`,
    );
  }
  if (candidates.length > 0) {
    warnings.push(
      `${COUNTDOWN_WARNING.BID_COUNT_UNAVAILABLE_FROM_SOURCE}: search rows carry no bid count or time left; bidCount is null on every candidate.`,
    );
  }
  return { value: candidates, warnings };
}

/**
 * Union of a buy-it-now set and an auction set by item id (§3.1). An id in
 * both is `auction_with_bin` when the first set was retrieved under
 * buy_it_now (its rows read fixed_price) and `auction` when the first set
 * was unfiltered (its rows read unknown: the auction twin proves the format,
 * the unfiltered row proves nothing). Auction-only rows are `auction`; rows
 * only in the first set keep their own format (fixed_price under
 * buy_it_now, unknown when unfiltered). The first set's row is the base of a
 * merged entry; `shippingCost` falls back to the auction twin's, which the
 * auction layout carries on nearly every row. `order` is renumbered 0..n-1
 * in output order (first set, then auction-only rows).
 */
export function mergeSplitSearch(
  binRows: readonly ApiListingCandidate[],
  auctionRows: readonly ApiListingCandidate[],
): ApiListingCandidate[] {
  const auctionById = new Map<string, ApiListingCandidate>();
  for (const row of auctionRows) if (!auctionById.has(row.itemId)) auctionById.set(row.itemId, row);
  const seen = new Set<string>();
  const merged: ApiListingCandidate[] = [];
  for (const row of binRows) {
    if (seen.has(row.itemId)) continue;
    seen.add(row.itemId);
    const twin = auctionById.get(row.itemId);
    if (twin === undefined) {
      merged.push({ ...row });
      continue;
    }
    merged.push({
      ...row,
      sellingFormat: row.sellingFormat === 'fixed_price' ? 'auction_with_bin' : 'auction',
      shippingCost: row.shippingCost ?? twin.shippingCost,
    });
  }
  for (const row of auctionRows) {
    if (seen.has(row.itemId)) continue;
    seen.add(row.itemId);
    merged.push({ ...row, sellingFormat: 'auction' });
  }
  return merged.map((row, order) => ({ ...row, order }));
}

export interface CountdownPagination {
  totalResults: number | null;
  /** The last fetched page's flag; null when the vendor gave none. */
  hasNextPage: boolean | null;
  pagesFetched: number;
  /** The last fetched page number; null when unknown. */
  currentPage: number | null;
}

function toInt(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * Fold either pagination shape: the flat object on a single-page request or
 * `pagination.pages[]` (one entry per page) when max_page > 1 (§1.2).
 */
export function readPagination(body: unknown): CountdownPagination {
  const parsed = parseCountdownBody(SearchResponseSchema, body, 'search');
  const pagination = parsed.pagination ?? null;
  const pages = (pagination?.pages ?? []).filter((page) => page !== null && page !== undefined);
  if (pages.length > 0) {
    const last = pages[pages.length - 1]!;
    let totalResults: number | null = null;
    for (const page of pages) {
      const total = toInt(page.total_results);
      if (total !== null && (totalResults === null || total > totalResults)) totalResults = total;
    }
    return {
      totalResults,
      hasNextPage: typeof last.has_next_page === 'boolean' ? last.has_next_page : null,
      pagesFetched: pages.length,
      currentPage: toInt(last.current_page),
    };
  }
  const rows = (parsed.search_results ?? []).length;
  return {
    totalResults: toInt(pagination?.total_results),
    hasNextPage: typeof pagination?.has_next_page === 'boolean' ? pagination.has_next_page : null,
    pagesFetched: pagination !== null || rows > 0 ? 1 : 0,
    currentPage: toInt(pagination?.current_page),
  };
}
