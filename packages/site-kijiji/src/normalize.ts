/**
 * Price, posted-time and identity normalization for kijiji.ca.v1 — mirrors
 * the site-ebay normalize conventions (§20-style), adapted to Kijiji's
 * classified-ad price vocabulary, relative posted times, and URL shapes.
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

/**
 * Milliseconds for one relative-time unit, in both the abbreviated and the
 * spelled-out spellings Kijiji uses. Months are the calendar-free 30 days a
 * "1 mo ago" card can honestly mean.
 */
function postedUnitMs(unit: string): number | null {
  if (/^(?:s|secs?|seconds?|secondes?)$/.test(unit)) return 1_000;
  if (/^(?:mins?|minutes?)$/.test(unit)) return 60_000;
  if (/^(?:hrs?|hours?|heures?|heure)$/.test(unit)) return 3_600_000;
  if (/^(?:d|days?|j|jours?)$/.test(unit)) return 86_400_000;
  if (/^(?:wks?|weeks?|sem|semaines?)$/.test(unit)) return 604_800_000;
  if (/^(?:mos?|months?|mois)$/.test(unit)) return 2_592_000_000;
  return null;
}

/**
 * Parse the relative posted time a search card renders into an ISO instant.
 * The vocabulary is the site's own: listing:activation_time.* ships inline
 * on every search page and reads "1 min ago", "{{minutes}} min ago",
 * "1 hr ago", "{{hours}} hrs ago", "1 day ago", "1 wk ago", "{{weeks}} wks
 * ago", "1 mo ago" -- not the "Posted 2 hours ago" wording the first pass
 * assumed -- so both spellings are accepted, as is the "Published {{...}}"
 * aria-label the same table defines.
 *
 * `now` is the instant the offset is measured back from; the caller passes
 * its own observation time so a record stays reproducible from its fixture.
 * "30+ d" and "over a month ago" state a bound rather than a time and
 * return null, as does anything unrecognized: no postedAt is better than a
 * guessed one.
 *
 * NEEDS-LIVE-VERIFICATION: the French column ("il y a 2 heures", "hier") is
 * carried defensively -- fr_CA activation_time strings have not been seen
 * on a live page, only the en_CA ones.
 */
export function parseKijijiPostedText(rawText: string, now: Date): string | null {
  const text = rawText.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (text.length === 0) return null;
  // An open-ended bound is not an instant.
  if (/\d\+|\bover a\b|\bplus d/.test(text)) return null;
  if (/\b(?:yesterday|hier)\b/.test(text)) return new Date(now.getTime() - 86_400_000).toISOString();
  // Every number-unit pair is tried, not just the first: a card's posted
  // text can trail a postal code ("M5T 1M5") whose "1m" is not a unit.
  for (const match of text.matchAll(/(\d+)\s*([a-z\u00e0-\u00ff]+)/g)) {
    const unitMs = postedUnitMs(match[2]!);
    if (unitMs === null) continue;
    const amount = Number.parseInt(match[1]!, 10);
    if (!Number.isFinite(amount)) continue;
    return new Date(now.getTime() - amount * unitMs).toISOString();
  }
  return null;
}

/** Fluxology deals feed id convention: `kijiji-<marketplaceListingId>`. */
export function dealsFeedId(adId: string): string {
  return `kijiji-${adId}`;
}
