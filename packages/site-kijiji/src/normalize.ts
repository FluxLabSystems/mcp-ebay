/**
 * Price and identity normalization for kijiji.ca.v1 — mirrors the
 * site-ebay normalize conventions (§20-style), adapted to Kijiji's
 * classified-ad price vocabulary and URL shapes.
 */

export type KijijiPriceKind = 'amount' | 'free' | 'contact' | 'swap';

export interface ParsedKijijiPrice {
  kind: KijijiPriceKind;
  /** Numeric amount for kind "amount"; 0 for "free"; null for "contact"/"swap". */
  value: number | null;
  /** Kijiji is Canada-only; all listed prices are CAD. */
  currency: 'CAD';
  /** Whitespace-normalized source text the price was parsed from. */
  rawText: string;
}

/**
 * Parse Kijiji-rendered price text: "$1,234.56", "$60", "Free",
 * "Please Contact", "Swap / Trade" (also "Swap/Trade"). NBSP / narrow
 * no-break spaces are normalized like ebay's parseMoney. Unrecognized
 * text returns null rather than a guessed amount.
 */
export function parseKijijiPrice(rawText: string): ParsedKijijiPrice | null {
  // Kijiji renders prices with NBSP / narrow no-break spaces.
  const text = rawText.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  if (/\bfree\b/i.test(text)) {
    return { kind: 'free', value: 0, currency: 'CAD', rawText: text };
  }
  if (/\bplease\s+contact\b/i.test(text)) {
    return { kind: 'contact', value: null, currency: 'CAD', rawText: text };
  }
  if (/\bswap\s*\/\s*trade\b/i.test(text)) {
    return { kind: 'swap', value: null, currency: 'CAD', rawText: text };
  }
  const match = /\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(text);
  if (!match) return null;
  const value = Number.parseFloat(match[1]!.replace(/,/g, ''));
  if (Number.isNaN(value)) return null;
  return { kind: 'amount', value, currency: 'CAD', rawText: text };
}

/**
 * Extract the numeric Kijiji ad id from a VIP URL, if present. VIP URLs
 * end in a numeric ad id: .../<slug>/<digits> with an optional query.
 * The trailing 7-12 digit id is read from the last path segment.
 *
 * NEEDS-LIVE-VERIFICATION: the legacy mobile/share form
 * .../v-view-details.html?adId=<digits> is also accepted via the adId
 * query parameter; confirm against currently issued share links.
 */
export function adIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  if (last !== undefined) {
    const match = /^(\d{7,12})$/.exec(last);
    if (match) return match[1]!;
  }
  const adIdParam = parsed.searchParams.get('adId');
  if (adIdParam !== null && /^\d{7,12}$/.test(adIdParam)) return adIdParam;
  return null;
}

/**
 * Canonical VIP URL. Unlike eBay's canonicalListingUrl, the Kijiji
 * canonical is NOT reconstructible from the ad id alone: the served
 * canonical path is /v-<category-slug>/<location-slug>/<title-slug>/<id>
 * and the slug segments matter (historically they were required for the
 * page to resolve). So instead of rebuilding a URL, this preserves the
 * observed path: if observedUrl parses and is on the kijiji.ca host
 * family, return it stripped of query/fragment (scheme forced to https);
 * else null.
 */
export function canonicalAdUrl(adId: string, observedUrl: string | null): string | null {
  void adId; // identity is carried by the preserved path; see doc comment.
  if (observedUrl === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(observedUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'kijiji.ca' && !host.endsWith('.kijiji.ca')) return null;
  return `https://${host}${parsed.pathname}`;
}

/** Fluxology deals feed id convention: `kijiji-<marketplaceListingId>`. */
export function dealsFeedId(adId: string): string {
  return `kijiji-${adId}`;
}
