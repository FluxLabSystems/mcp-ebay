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
import { canonicalProductUrl as canonicalZazzleProductUrl } from '@browser-bridge/site-zazzle';
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
  price: { kind: string | null; value: number | null; currency: string | null } | null;
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
    // currency survives compaction: search candidates carry it, and the
    // canonical record is the one a deals upsert prices from — a bare
    // {kind, value} made the CAD figure a guess exactly where it mattered.
    price:
      price === null
        ? null
        : { kind: readString(price.kind), value: readNumber(price.value), currency: readString(price.currency) },
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
export interface CompactZazzleProduct {
  productId: string | null;
  canonicalUrl: string | null;
  title: string | null;
  vendor: string | null;
  listedPrice: { value: number | null; currency: string | null } | null;
  originalPrice: { value: number | null; currency: string | null } | null;
  priceBasis: string | null;
  priceQuantityTier: number | null;
  moq1Supported: boolean | null;
  personalizationOffered: boolean | null;
  discountPct: number | null;
  promoExpires: string | null;
  ratingValue: number | null;
  ratingCount: number | null;
  listingStatus: string | null;
  warnings: string[];
}

export function compactZazzleProduct(
  record: unknown,
  warnings: readonly string[] = [],
): CompactZazzleProduct {
  const product = asObject(record) ?? {};
  const listed = asObject(product.listedPrice);
  const original = asObject(product.originalPrice);
  return {
    productId: readString(product.productId),
    canonicalUrl: readString(product.canonicalUrl),
    title: readString(product.title),
    vendor: readString(product.vendor),
    listedPrice:
      listed === null ? null : { value: readNumber(listed.value), currency: readString(listed.currency) },
    originalPrice:
      original === null
        ? null
        : { value: readNumber(original.value), currency: readString(original.currency) },
    priceBasis: readString(product.priceBasis),
    priceQuantityTier: readNumber(product.priceQuantityTier),
    moq1Supported: readBoolean(product.moq1Supported),
    personalizationOffered: readBoolean(product.personalizationOffered),
    discountPct: readNumber(product.discountPct),
    promoExpires: readString(product.promoExpires),
    ratingValue: readNumber(product.ratingValue),
    ratingCount: readNumber(product.ratingCount),
    listingStatus: readString(product.listingStatus),
    warnings: [...warnings],
  };
}

export function compactItemRecord(
  siteProfile: string | null,
  record: unknown,
  warnings: readonly string[] = [],
): Record<string, unknown> {
  if (siteProfile !== null && siteProfile.startsWith('kijiji')) {
    return compactKijijiAd(record) as unknown as Record<string, unknown>;
  }
  if (siteProfile !== null && siteProfile.startsWith('zazzle')) {
    return compactZazzleProduct(record, warnings) as unknown as Record<string, unknown>;
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

const DEFAULT_ZAZZLE_CANDIDATE_FIELDS = [
  'productId',
  'url',
  'title',
  'price',
  'originalPrice',
  'discountText',
] as const;

/**
 * Caller-named fields resolved across both site profiles' candidate shapes,
 * tried left to right when the row lacks the exact key. The filter path has
 * always read prices and formats shape-tolerantly (readCandidatePrice,
 * readCandidateFormat below), but the projection demanded the site's exact
 * spelling — so `fields: ["price"]` on an eBay page silently dropped the
 * very price the same call had just filtered on (eBay spells it
 * snippetPrice, Kijiji spells it price). The value comes back under the
 * name the caller asked for; a key the row carries verbatim always wins.
 */
const CANDIDATE_FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  price: ['snippetPrice'],
  snippetPrice: ['price'],
  format: ['sellingFormat', 'listingType'],
  sellingFormat: ['listingType'],
  listingType: ['sellingFormat'],
  location: ['locationText', 'itemLocationText'],
  locationText: ['itemLocationText'],
  itemLocationText: ['locationText'],
};

/** Root keys of a candidate record that survive compaction verbatim. */
const PRESERVED_ROOT_FIELDS = [
  'siteProfile',
  'pageKind',
  'pageUrl',
  'hasNextPage',
  'nextPageUrl',
  'totalResults',
  // Kijiji's removed-ad marker: a deleted ad's VIP URL 302s to its category
  // search page carrying ?adRemoved=<id>. Compacting it away would turn
  // "this ad was removed" back into "an ordinary search page".
  'removedAdId',
  // Zazzle's empty-results shell marker: a /s/ deep link can render "did
  // not match any products" for a query the search box answers with a full
  // page. Compacting it away would turn "retry via the search box" back
  // into "the marketplace had nothing".
  'noResultsShell',
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

type Site = 'ebay' | 'kijiji' | 'zazzle';

function siteOfProfile(siteProfile: unknown): Site {
  if (typeof siteProfile === 'string' && siteProfile.startsWith('kijiji')) return 'kijiji';
  if (typeof siteProfile === 'string' && siteProfile.startsWith('zazzle')) return 'zazzle';
  return 'ebay';
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
    } else if (site === 'zazzle') {
      const canonical = canonicalZazzleProductUrl(rawUrl);
      if (canonical !== null) return canonical;
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
    options.fields ??
    (site === 'kijiji'
      ? DEFAULT_KIJIJI_CANDIDATE_FIELDS
      : site === 'zazzle'
        ? DEFAULT_ZAZZLE_CANDIDATE_FIELDS
        : DEFAULT_EBAY_CANDIDATE_FIELDS);

  // B3: a caller-named field that resolves to NO key on any scanned row —
  // directly or through an alias — is a typo or a wrong-profile name, and
  // silently returning rows without it hid a real defect for two rounds of
  // testing. Skipped when the page rendered no rows at all: an empty page
  // proves nothing about field names.
  if (options.fields !== undefined && rows.length > 0) {
    const emittedKeys = new Set<string>();
    for (const raw of rows) {
      const row = asObject(raw);
      if (row !== null) for (const key of Object.keys(row)) emittedKeys.add(key);
    }
    const resolvable = (name: string): boolean =>
      emittedKeys.has(name) || (CANDIDATE_FIELD_ALIASES[name] ?? []).some((alias) => emittedKeys.has(alias));
    const unknown = options.fields.filter((name) => !resolvable(name));
    if (unknown.length > 0) {
      warnings.push(
        `UNKNOWN_FIELDS_IGNORED: ${unknown.map((name) => `"${name}"`).join(', ')} match no candidate key on this page (aliases included) and were omitted; keys this page emits: ${[...emittedKeys].sort().join(', ')}.`,
      );
    }
  }

  const window = matched.slice(options.offset, options.offset + options.limit);
  const candidates = window.map((row) => projectCandidate(row, allowed, site, options.canonicalizeUrls));

  // C3: absent is explicit, never silent. projectCandidate now emits null
  // for a known-but-unreadable field; summarize the gaps once per page so a
  // routine can SEE partial enrichment instead of inferring it from missing
  // keys (the shape of defect B1's symptom).
  if (candidates.length > 0) {
    const nullCounts = new Map<string, number>();
    for (const candidate of candidates) {
      for (const [key, value] of Object.entries(candidate)) {
        if (value === null) nullCounts.set(key, (nullCounts.get(key) ?? 0) + 1);
      }
    }
    if (nullCounts.size > 0) {
      const parts = [...nullCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, count]) => `${key} on ${count}`);
      warnings.push(
        `CANDIDATE_FIELDS_NULL: unreadable on some of the ${candidates.length} returned candidate(s): ${parts.join(', ')}.`,
      );
    }
  }

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
    let value = row[key];
    let known = key in row;
    if (value === undefined || value === null) {
      for (const alias of CANDIDATE_FIELD_ALIASES[key] ?? []) {
        known = known || alias in row;
        const fallback = row[alias];
        if (fallback !== undefined && fallback !== null) {
          value = fallback;
          break;
        }
      }
    }
    if (value === undefined || value === null) {
      // C3: a key the row carries (directly or via alias) whose value could
      // not be read comes back as an EXPLICIT null — "the extractor looked
      // and the page did not say" — never as a silently missing key. A name
      // the row does not know at all is omitted here and reported once per
      // page by the UNKNOWN_FIELDS_IGNORED warning.
      if (known) out[key] = null;
      continue;
    }
    out[key] = key === 'url' && canonicalize && typeof value === 'string'
      ? canonicalizeCandidateUrl(value, site)
      : value;
  }
  // A row the caller can neither identify nor open is not a saving. If the
  // allow-list left out the URL, put the canonical one back.
  if (out.url === undefined || out.url === null) {
    if (typeof row.url === 'string') {
      out.url = canonicalize ? canonicalizeCandidateUrl(row.url, site) : row.url;
    }
  }
  return out;
}
