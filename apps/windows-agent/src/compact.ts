/**
 * Compact projections — SDD v0.5 Appendix A (compact record shapes) and the
 * Phase 2 call-budget work.
 *
 * Two different reductions live here, both evaluated on the agent so the
 * bytes never cross the wire:
 *
 *   - compactItemRecord() flattens one provenance-wrapped extraction record
 *     to the flat field set a deals run scores on. The provenance and
 *     confidence a record carries are what make it auditable, and they are
 *     also most of its size; a batch of 20 items cannot afford to ship them.
 *   - compactSearchPage() reduces a candidate list: canonical URLs, an
 *     offset/limit window, a field allow-list and title/price/format
 *     filters. A measured 2026-08-29 eBay search page returned 160 KB of
 *     candidates and spilled to a file the model then spent five shell
 *     calls parsing.
 *
 * Every reader below is deliberately shape-tolerant. The site packages
 * revise their record shapes on their own cadence (eBay gained endsAt,
 * itemLocationText, watcherCount and the quantity fields while this module
 * was being written), and a projection that throws — or worse, invents a
 * value — when a field is not there yet is a projection that turns a schema
 * addition into an outage. A field this module cannot read is null.
 */
import { canonicalListingUrl, itemIdFromUrl } from '@browser-bridge/site-ebay';
import { adIdFromUrl, canonicalAdUrl } from '@browser-bridge/site-kijiji';
import {
  ACK_DEADLINE_MS,
  BridgeError,
  compileTitleRegex,
  SEARCH_TITLE_MATCH_MAX_CHARS,
  type SearchCompaction,
} from '@browser-bridge/protocol';

type Unknown = Record<string, unknown>;

function asObject(value: unknown): Unknown | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Unknown) : null;
}

/**
 * Read a value that a record may carry either bare or wrapped in the
 * `{ value, source, confidence }` provenance envelope the site packages
 * use. Both forms appear in practice — `postedAt` is a bare ISO string
 * while `endsAt` is wrapped — and which one a given field uses is the site
 * package's business, not this module's.
 */
function unwrap(value: unknown): unknown {
  const object = asObject(value);
  if (object === null) return value;
  if ('value' in object) return object.value;
  // Kijiji's location is `{ text, source, confidence }`.
  if ('text' in object) return object.text;
  return null;
}

function readString(value: unknown): string | null {
  const raw = unwrap(value);
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function readNumber(value: unknown): number | null {
  const raw = unwrap(value);
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function readBoolean(value: unknown): boolean | null {
  const raw = unwrap(value);
  return typeof raw === 'boolean' ? raw : null;
}

// ---------------------------------------------------------------------------
// Item / ad record projections (Appendix A)
// ---------------------------------------------------------------------------

export interface CompactEbayItem {
  itemId: string | null;
  canonicalUrl: string | null;
  title: string | null;
  seller: string | null;
  itemLocationText: string | null;
  sellingFormat: { kind: string | null; bidCount: number | null };
  listingStatus: string | null;
  endsAt: string | null;
  itemPrice: { value: number | null; currency: string | null } | null;
  shipping: {
    value: number | null;
    currency: string | null;
    destinationVerified: boolean | null;
    serviceText: string | null;
  } | null;
  offerAvailable: boolean | null;
  quantityAvailable: number | null;
  quantitySold: number | null;
  watcherCount: number | null;
  warnings: string[];
}

export function compactEbayItem(record: unknown, warnings: readonly string[] = []): CompactEbayItem {
  const item = asObject(record) ?? {};
  const price = asObject(item.itemPrice);
  const shipping = asObject(item.shipping);
  const format = asObject(item.sellingFormat) ?? {};
  const offer = asObject(item.offer) ?? {};
  return {
    itemId: readString(item.itemId),
    canonicalUrl: readString(item.canonicalUrl),
    title: readString(item.title),
    seller: readString(item.seller),
    itemLocationText: readString(item.itemLocationText),
    sellingFormat: {
      kind: readString(format.kind),
      bidCount: readNumber(format.bidCount),
    },
    listingStatus: readString(item.listingStatus),
    endsAt: readString(item.endsAt),
    itemPrice:
      price === null ? null : { value: readNumber(price.value), currency: readString(price.currency) },
    shipping:
      shipping === null
        ? null
        : {
            value: readNumber(shipping.value),
            currency: readString(shipping.currency),
            destinationVerified: readBoolean(shipping.destinationVerified),
            // The record calls the rendered shipping line observedText; a
            // later revision may name it serviceText. Read either.
            serviceText: readString(shipping.serviceText) ?? readString(shipping.observedText),
          },
    offerAvailable: readBoolean(offer.available),
    quantityAvailable: readNumber(item.quantityAvailable),
    quantitySold: readNumber(item.quantitySold),
    watcherCount: readNumber(item.watcherCount),
    warnings: [...warnings],
  };
}

export interface CompactKijijiAd {
  adId: string | null;
  canonicalUrl: string | null;
  title: string | null;
  price: { kind: string | null; value: number | null } | null;
  location: string | null;
  postedAt: string | null;
  sellerName: string | null;
  description: string | null;
  imageCount: number | null;
  listingStatus: string | null;
}

export function compactKijijiAd(record: unknown): CompactKijijiAd {
  const ad = asObject(record) ?? {};
  const price = asObject(ad.price);
  return {
    adId: readString(ad.adId),
    canonicalUrl: readString(ad.canonicalUrl),
    title: readString(ad.title),
    price: price === null ? null : { kind: readString(price.kind), value: readNumber(price.value) },
    location: readString(ad.location),
    postedAt: readString(ad.postedAt),
    sellerName: readString(ad.sellerName),
    description: readString(ad.description),
    imageCount: readNumber(ad.imageCount),
    listingStatus: readString(ad.listingStatus),
  };
}

/**
 * Project one extraction record by the site profile that produced it. An
 * unrecognised profile is returned untouched rather than mangled — a bridge
 * that ships a third site profile before this module learns about it should
 * degrade to "uncompacted", not to "empty".
 */
export function compactItemRecord(
  siteProfile: string | null,
  record: unknown,
  warnings: readonly string[] = [],
): Record<string, unknown> {
  if (siteProfile !== null && siteProfile.startsWith('kijiji')) {
    return compactKijijiAd(record) as unknown as Record<string, unknown>;
  }
  if (siteProfile !== null && siteProfile.startsWith('ebay')) {
    return compactEbayItem(record, warnings) as unknown as Record<string, unknown>;
  }
  return (asObject(record) ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Search / candidate page compaction
// ---------------------------------------------------------------------------

/**
 * Candidate keys kept when the caller names no `fields`. These are the ones
 * a triage decision actually reads — is this the right kind of lot, roughly
 * what price, auction or not, and where is it. Everything else on a row is
 * available by naming it explicitly, and a row's full detail is one
 * browser.extract_many away.
 */
const DEFAULT_EBAY_CANDIDATE_FIELDS = [
  'itemId',
  'url',
  'title',
  'snippetPrice',
  'sellingFormat',
  'bidCount',
  'itemLocationText',
  'isNewListing',
] as const;

const DEFAULT_KIJIJI_CANDIDATE_FIELDS = [
  'adId',
  'url',
  'title',
  'price',
  'locationText',
  'postedText',
] as const;

/** Root keys of a candidate record that survive compaction verbatim. */
const PRESERVED_ROOT_FIELDS = [
  'siteProfile',
  'pageKind',
  'pageUrl',
  'hasNextPage',
  'nextPageUrl',
  'totalResults',
] as const;

/**
 * Rows are only ever scanned up to this many; a page that somehow renders
 * more candidates than the largest window the schema can ask for is not a
 * reason to run a caller-supplied regex an unbounded number of times.
 */
const MAX_SCANNED_CANDIDATES = 240;

export interface SearchCompactionResult {
  record: Record<string, unknown>;
  warnings: string[];
}

type Site = 'ebay' | 'kijiji';

function siteOfProfile(siteProfile: unknown): Site {
  return typeof siteProfile === 'string' && siteProfile.startsWith('kijiji') ? 'kijiji' : 'ebay';
}

/**
 * eBay hangs `_skw`, `itmmeta`, `hash`, `itmprp` and friends off every
 * result link, which is most of a 160 KB search payload and none of its
 * meaning. Reduce a candidate URL to the canonical item/ad URL when the id
 * is recoverable, and otherwise to the same URL with its query and fragment
 * dropped — never to nothing, because a row the caller cannot open is worse
 * than a long URL.
 */
export function canonicalizeCandidateUrl(rawUrl: string, site: Site): string {
  try {
    if (site === 'ebay') {
      const itemId = itemIdFromUrl(rawUrl);
      if (itemId !== null) return canonicalListingUrl(itemId, rawUrl);
    } else {
      const adId = adIdFromUrl(rawUrl);
      if (adId !== null) {
        const canonical = canonicalAdUrl(adId, rawUrl);
        if (canonical !== null) return canonical;
      }
    }
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl;
  }
}

function readCandidatePrice(row: Unknown): number | null {
  const snippet = asObject(row.snippetPrice);
  if (snippet !== null) {
    const value = readNumber(snippet.value);
    if (value !== null) return value;
  }
  const price = asObject(row.price);
  if (price !== null) {
    const value = readNumber(price.value);
    if (value !== null) return value;
  }
  return readNumber(row.priceValue);
}

function readCandidateFormat(row: Unknown): string | null {
  const direct = readString(row.sellingFormat);
  if (direct !== null) return direct;
  const wrapped = asObject(row.sellingFormat);
  if (wrapped !== null) {
    const kind = readString(wrapped.kind);
    if (kind !== null) return kind;
  }
  return readString(row.listingType);
}

/**
 * Reduce a candidate/search extraction record in place of returning it
 * whole. Filtering runs before the offset/limit window so paging walks the
 * matched set rather than the raw page.
 *
 * Two exclusions are reported rather than silent, because both are the kind
 * of omission that would otherwise read as "the marketplace had nothing":
 * a price bound drops rows whose price could not be read, and a format
 * filter drops rows whose format could not be read. Both are the right
 * default — "under $100" should not hand back unpriced rows — but a caller
 * has to be able to see it happened, and can ask for 'unknown' back.
 */
export function compactSearchPage(
  record: unknown,
  options: SearchCompaction,
): SearchCompactionResult {
  const source = asObject(record);
  const warnings: string[] = [];
  if (source === null || !Array.isArray(source.candidates)) {
    // Not a candidate record (an item page, or an extractor that returned
    // something else): nothing to compact, and refusing would be worse.
    return { record: (source ?? {}) as Record<string, unknown>, warnings };
  }

  const site = siteOfProfile(source.siteProfile);
  const rows = (source.candidates as unknown[]).slice(0, MAX_SCANNED_CANDIDATES);
  if ((source.candidates as unknown[]).length > MAX_SCANNED_CANDIDATES) {
    warnings.push(
      `CANDIDATES_TRUNCATED: the page rendered ${(source.candidates as unknown[]).length} candidates; only the first ${MAX_SCANNED_CANDIDATES} were considered.`,
    );
  }

  const include = options.include;
  let titleRegex: RegExp | null = null;
  if (include?.titleRegex !== undefined) {
    try {
      titleRegex = compileTitleRegex(include.titleRegex);
    } catch (err) {
      // The schema screens this at the gateway; reaching here means an
      // agent-side call bypassed it, and a bad filter is a bad request.
      throw new BridgeError('ACTION_BLOCKED', err instanceof Error ? err.message : String(err), {
        titleRegex: include.titleRegex,
      });
    }
  }

  const matched: Unknown[] = [];
  let excludedNoPrice = 0;
  let excludedUnknownFormat = 0;
  const filterStartedAt = Date.now();
  let filterBudgetExceeded = false;

  for (let index = 0; index < rows.length; index += 1) {
    // A screened pattern is bounded but not free; check a wall clock every
    // 32 rows so a slow-but-legal filter cannot eat the command's deadline.
    if (index % 32 === 0 && index > 0 && Date.now() - filterStartedAt > ACK_DEADLINE_MS) {
      filterBudgetExceeded = true;
      warnings.push(
        `SEARCH_FILTER_BUDGET_EXCEEDED: stopped filtering after ${index} of ${rows.length} candidates; narrow include.titleRegex or drop it.`,
      );
      break;
    }
    const row = asObject(rows[index]);
    if (row === null) continue;

    if (titleRegex !== null) {
      const title = readString(row.title);
      if (title === null) continue;
      if (!titleRegex.test(title.slice(0, SEARCH_TITLE_MATCH_MAX_CHARS))) continue;
    }
    if (include?.minPrice !== undefined || include?.maxPrice !== undefined) {
      const price = readCandidatePrice(row);
      if (price === null) {
        excludedNoPrice += 1;
        continue;
      }
      if (include.minPrice !== undefined && price < include.minPrice) continue;
      if (include.maxPrice !== undefined && price > include.maxPrice) continue;
    }
    if (include?.formats !== undefined) {
      const format = readCandidateFormat(row);
      if (format === null) {
        if (!include.formats.includes('unknown')) {
          excludedUnknownFormat += 1;
          continue;
        }
      } else if (!(include.formats as readonly string[]).includes(format)) {
        continue;
      }
    }
    matched.push(row);
  }

  if (excludedNoPrice > 0) {
    warnings.push(
      `EXCLUDED_NO_PRICE: ${excludedNoPrice} candidate(s) were dropped by a price bound because their price could not be read from the result card.`,
    );
  }
  if (excludedUnknownFormat > 0) {
    warnings.push(
      `EXCLUDED_UNKNOWN_FORMAT: ${excludedUnknownFormat} candidate(s) were dropped by include.formats because their selling format could not be read; add "unknown" to keep them.`,
    );
  }

  const allowed =
    options.fields ?? (site === 'kijiji' ? DEFAULT_KIJIJI_CANDIDATE_FIELDS : DEFAULT_EBAY_CANDIDATE_FIELDS);
  const window = matched.slice(options.offset, options.offset + options.limit);
  const candidates = window.map((row) => projectCandidate(row, allowed, site, options.canonicalizeUrls));

  const out: Record<string, unknown> = {};
  for (const key of PRESERVED_ROOT_FIELDS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  // candidateCount keeps meaning what it meant: how many the page rendered.
  out.candidateCount = typeof source.candidateCount === 'number' ? source.candidateCount : rows.length;
  out.matchedCount = matched.length;
  out.returnedCount = candidates.length;
  out.offset = options.offset;
  out.hasMore = !filterBudgetExceeded && options.offset + candidates.length < matched.length;
  out.nextOffset = out.hasMore === true ? options.offset + candidates.length : null;
  out.compacted = true;
  out.candidates = candidates;
  out.note =
    'Candidate snippets are traversal hints; open each URL and extract it for canonical evidence — browser.extract_many does both in one call.';
  return { record: out, warnings };
}

function projectCandidate(
  row: Unknown,
  allowed: readonly string[],
  site: Site,
  canonicalize: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = row[key];
    if (value === undefined || value === null) continue;
    out[key] = key === 'url' && canonicalize && typeof value === 'string'
      ? canonicalizeCandidateUrl(value, site)
      : value;
  }
  // A row the caller can neither identify nor open is not a saving. If the
  // allow-list left out the URL, put the canonical one back.
  if (out.url === undefined && typeof row.url === 'string') {
    out.url = canonicalize ? canonicalizeCandidateUrl(row.url, site) : row.url;
  }
  return out;
}
