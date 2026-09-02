/**
 * Shared vocabulary for the Countdown API source — docs/COUNTDOWN-API-PLAN.md §4.
 * Pure helpers only; no I/O.
 */

/** The two marketplaces the gateway is allowed to query (§2: destinations are named, never free text). */
export type CountdownDomain = 'ebay.ca' | 'ebay.com';

/** Every mapper returns its value beside the warnings it accumulated. */
export interface Mapped<T> {
  value: T;
  warnings: string[];
}

/**
 * Warning codes emitted by this package. They prefix a warning string as
 * `CODE: human text` so the routine's audit rules can grep them the way they
 * grep the compactor's EXCLUDED_* codes.
 */
export const COUNTDOWN_WARNING = {
  // map-search
  EXCLUDED_REWRITTEN: 'EXCLUDED_REWRITTEN',
  CANDIDATE_FIELDS_NULL: 'CANDIDATE_FIELDS_NULL',
  PRICE_RANGE_UNPARSED: 'PRICE_RANGE_UNPARSED',
  FORMAT_UNKNOWN_ON_UNFILTERED_SEARCH: 'FORMAT_UNKNOWN_ON_UNFILTERED_SEARCH',
  BID_COUNT_UNAVAILABLE_FROM_SOURCE: 'BID_COUNT_UNAVAILABLE_FROM_SOURCE',
  SHIPPING_COST_UNPARSED: 'SHIPPING_COST_UNPARSED',
  // map-item
  DESTINATION_UNVERIFIED: 'DESTINATION_UNVERIFIED',
  AUCTION_DETAIL_UNAVAILABLE_FROM_SOURCE: 'AUCTION_DETAIL_UNAVAILABLE_FROM_SOURCE',
  AUCTION_PRICE: 'AUCTION_PRICE',
  ITEM_ID_MISMATCH: 'ITEM_ID_MISMATCH',
  LISTING_UNAVAILABLE: 'LISTING_UNAVAILABLE',
  LISTING_REDIRECTED: 'LISTING_REDIRECTED',
  FORMAT_UNKNOWN_FROM_SOURCE: 'FORMAT_UNKNOWN_FROM_SOURCE',
  PRICE_UNCONFIRMED: 'PRICE_UNCONFIRMED',
  SELLER_LOGIN_ID_UNAVAILABLE: 'SELLER_LOGIN_ID_UNAVAILABLE',
  // map-seller
  SELLER_UNRESOLVED: 'SELLER_UNRESOLVED',
  SELLER_FIELDS_ABSENT_FROM_SOURCE: 'SELLER_FIELDS_ABSENT_FROM_SOURCE',
} as const;

export type CountdownWarningCode = (typeof COUNTDOWN_WARNING)[keyof typeof COUNTDOWN_WARNING];

/** Exact text every item record carries (docs/COUNTDOWN-API-PLAN.md §3.2, §4.2). */
export const DESTINATION_UNVERIFIED_WARNING =
  "DESTINATION_UNVERIFIED: item-page shipping from this source is resolved to the vendor's own location, never to a postal code";

/** Search rows carry no `currency` field (§1.3); the domain is the fallback. */
export function domainCurrency(domain: CountdownDomain): 'CAD' | 'USD' {
  return domain === 'ebay.com' ? 'USD' : 'CAD';
}

/** The marketplace a URL belongs to, or null when it is not an eBay host this source supports. */
export function domainFromUrl(url: string | null | undefined): CountdownDomain | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'ebay.com' || host.endsWith('.ebay.com')) return 'ebay.com';
    if (host === 'ebay.ca' || host.endsWith('.ebay.ca')) return 'ebay.ca';
    return null;
  } catch {
    return null;
  }
}

export type SellerLinkKind = 'usr' | 'sch' | 'str';

export interface ParsedSellerLink {
  kind: SellerLinkKind | null;
  /** The eBay login id; only the /usr/<id> and /sch/<id>/m.html forms carry one. */
  loginId: string | null;
  /** The /str/<slug> segment. A store slug is NOT a login id (§1.3: tweedsidesales is /str/jeremydoherty). */
  storeSlug: string | null;
  host: string | null;
}

const USR_RE = /^\/usr\/([^/?#]+)/i;
const SCH_RE = /^\/sch\/([^/?#]+)\/m\.html/i;
const STR_RE = /^\/str\/([^/?#]+)/i;

function decodeSegment(segment: string): string | null {
  let text = segment;
  try {
    text = decodeURIComponent(segment);
  } catch {
    // keep the raw segment
  }
  text = text.trim();
  return text.length > 0 ? text : null;
}

/**
 * The three seller-link forms the vendor returns (§1.3): `/usr/<loginId>`,
 * `/sch/<loginId>/m.html?item=…` and `/str/<storeSlug>`.
 */
export function parseSellerLink(url: string | null | undefined): ParsedSellerLink {
  const empty: ParsedSellerLink = { kind: null, loginId: null, storeSlug: null, host: null };
  if (typeof url !== 'string' || url.trim().length === 0) return empty;
  let parsed: URL;
  try {
    parsed = new URL(url, 'https://www.ebay.ca/');
  } catch {
    return empty;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  const usr = USR_RE.exec(path);
  if (usr !== null) return { kind: 'usr', loginId: decodeSegment(usr[1]!), storeSlug: null, host };
  const sch = SCH_RE.exec(path);
  if (sch !== null) return { kind: 'sch', loginId: decodeSegment(sch[1]!), storeSlug: null, host };
  const str = STR_RE.exec(path);
  if (str !== null) return { kind: 'str', loginId: null, storeSlug: decodeSegment(str[1]!), host };
  return { kind: null, loginId: null, storeSlug: null, host };
}

/**
 * eBay's card-condition vocabulary. The vendor sometimes concatenates the
 * seller's subtitle in FRONT of the condition with no separator
 * ("Shop With Confidence, Buy From NeweggBrand New"), so the match is on the
 * trailing token. Longest tokens are tried first so "Very Good - Refurbished"
 * wins over "Good - Refurbished" and "Brand New" over "New". Single-word
 * tokens require a boundary before them so "Renew" is not read as "New";
 * multi-word tokens do not, because the measured rows glue them on.
 */
const CONDITION_VOCABULARY: readonly string[] = [
  'For parts or not working',
  'Parts Only',
  'Certified - Refurbished',
  'Excellent - Refurbished',
  'Very Good - Refurbished',
  'Good - Refurbished',
  'Seller refurbished',
  'Manufacturer refurbished',
  'Certified refurbished',
  'New with tags',
  'New without tags',
  'New with defects',
  'New with box',
  'New without box',
  'New other (see details)',
  'New (Other)',
  'Open Box',
  'Open box',
  'Brand New',
  'Like New',
  'Pre-Owned',
  'Pre-owned',
  'Very Good',
  'Refurbished',
  'Acceptable',
  'Good',
  'Used',
  'New',
];

const CONDITION_TOKENS = [...CONDITION_VOCABULARY].sort((a, b) => b.length - a.length);

export interface NormalizedCondition {
  /** The known token, or the raw text when no token matched; null when empty. */
  condition: string | null;
  /** The raw text when it differed from `condition`; null otherwise. */
  conditionRaw: string | null;
}

export function normalizeCondition(raw: string | null | undefined): NormalizedCondition {
  if (typeof raw !== 'string') return { condition: null, conditionRaw: null };
  const collapsed = raw.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return { condition: null, conditionRaw: null };
  const lower = collapsed.toLowerCase();
  for (const token of CONDITION_TOKENS) {
    const tokenLower = token.toLowerCase();
    if (!lower.endsWith(tokenLower)) continue;
    const start = lower.length - tokenLower.length;
    const singleWord = !/[\s\-()]/.test(token);
    if (singleWord && start > 0 && /[a-z0-9]/i.test(lower.charAt(start - 1))) continue;
    const canonical = CONDITION_VOCABULARY.find((entry) => entry.toLowerCase() === tokenLower) ?? token;
    return { condition: canonical, conditionRaw: collapsed === canonical ? null : raw };
  }
  return { condition: collapsed, conditionRaw: collapsed === raw ? null : raw };
}

/** Parse an integer the vendor may send as a number or a string ("126", "1,234", "79 followers"). */
export function readInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value !== 'string') return null;
  const match = /-?\d[\d,]*/.exec(value);
  if (match === null) return null;
  const parsed = Number.parseInt(match[0].replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = /-?\d[\d,]*(?:\.\d+)?/.exec(value);
  if (match === null) return null;
  const parsed = Number.parseFloat(match[0].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
}

/** Union of warning lists with exact duplicates removed, first occurrence kept. */
export function mergeWarnings(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const warning of list) {
      if (seen.has(warning)) continue;
      seen.add(warning);
      out.push(warning);
    }
  }
  return out;
}
