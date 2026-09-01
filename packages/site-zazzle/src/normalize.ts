/**
 * Zazzle normalization helpers. Structure verified against live zazzle.com
 * pages on 2026-08-31 (category /c/tshirts, search /s/…, and two product
 * pages) via a real browser session:
 *
 *   - Product URLs are https://www.zazzle.com/<slug>-<18-digit id>.
 *   - link[rel=canonical] on a product page can point at a DIFFERENT
 *     product (a style variant), so the canonical URL must come from
 *     og:url / the JSON-LD offer URL, never from the canonical link tag.
 *   - Prices render as "$19.31" with the currency STATED only in JSON-LD
 *     (priceCurrency: USD). A bare "$" is not a currency statement, so
 *     DOM-only money carries currency null and the raw text.
 */

export const ZAZZLE_PRODUCT_ID_RE = /-(\d{18})(?:[/?#]|$)/;

export function productIdFromUrl(rawUrl: string): string | null {
  const match = ZAZZLE_PRODUCT_ID_RE.exec(rawUrl);
  return match === null ? null : match[1]!;
}

/** Slug-and-id product URL with tracking payload dropped. */
export function canonicalProductUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (productIdFromUrl(url.pathname) === null) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export interface ParsedZazzleMoney {
  value: number;
  /**
   * Only set when the TEXT states it: an explicit "C$"/"CA$" prefix
   * (zazzle.ca rendering) is CAD and "US$" is USD. A bare "$" stays null,
   * never inferred; the original rule, unchanged.
   */
  currency: string | null;
  rawText: string;
}

const MONEY_RE = /(C\s?\$|CA\s?\$|US\s?\$|\$)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/;

export function parseZazzleMoney(raw: string | null | undefined): ParsedZazzleMoney | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.replace(/[\u00a0\u202f]/g, ' ').trim();
  const match = MONEY_RE.exec(text);
  if (match === null) return null;
  const value = Number.parseFloat(match[2]!.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const symbol = match[1]!.toUpperCase().replace(/\s/g, '');
  const currency = symbol === 'C$' || symbol === 'CA$' ? 'CAD' : symbol === 'US$' ? 'USD' : null;
  return { value, currency, rawText: match[0]!.trim() };
}

/** "You save 10%" / "Save 10%" → 10. Only when the page states it. */
export function parseSavePercent(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const match = /save\s+(\d{1,2})\s?%/i.exec(raw);
  if (match === null) return null;
  return Number.parseInt(match[1]!, 10);
}

export function collapseWhitespace(raw: string | null | undefined): string {
  return (raw ?? '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
}
