/**
 * Postal-code and money normalization for ebay.ca.v1 — SDD v0.5 §20.
 */

/** Normalize a Canadian postal code to "A9A 9A9" uppercase form. */
export function normalizePostalCode(raw: string): string | null {
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact)) return null;
  return `${compact.slice(0, 3)} ${compact.slice(3)}`;
}

export function postalCodesMatch(a: string, b: string): boolean {
  const na = normalizePostalCode(a);
  const nb = normalizePostalCode(b);
  return na !== null && na === nb;
}

export interface ParsedMoney {
  value: number;
  currency: string;
  /** True when the source text was a range; value is the low bound. */
  approximate: boolean;
}

/**
 * Parse eBay-rendered money text: "C $35.00", "US $12.00", "CA $1,234.56",
 * "$10.99", "C $8.91 to C $12.00", "Free", "Free shipping".
 * `defaultCurrency` applies to bare "$" amounts (CAD on ebay.ca).
 */
export function parseMoney(rawText: string, defaultCurrency = 'CAD'): ParsedMoney | null {
  const text = rawText.replace(/ /g, ' ').trim();
  if (text.length === 0) return null;
  if (/\bfree\b/i.test(text)) {
    return { value: 0, currency: defaultCurrency, approximate: false };
  }
  const pattern = /(C\s?\$|CA\s?\$|CAD\s?\$?|US\s?\$|USD\s?\$?|\$)\s?([\d,]+(?:\.\d{1,2})?)/gi;
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return null;
  const first = matches[0]!;
  const symbol = first[1]!.toUpperCase().replace(/\s/g, '');
  const currency = symbol.startsWith('US') ? 'USD' : symbol === '$' ? defaultCurrency : 'CAD';
  const value = Number.parseFloat(first[2]!.replace(/,/g, ''));
  if (Number.isNaN(value)) return null;
  const approximate = /\bto\b/i.test(text) && matches.length > 1;
  return { value, currency, approximate };
}

/** Extract the numeric eBay item id from a listing URL, if present. */
export function itemIdFromUrl(url: string): string | null {
  const match = /\/itm\/(?:[^/]+\/)?(\d{9,15})(?:[/?#]|$)/.exec(url);
  return match ? match[1]! : null;
}

/**
 * §20.2: normalize the canonical URL to https://www.ebay.ca/itm/<ITEMID>
 * when the listing lives on eBay.ca; preserve ebay.com canonical hosts.
 */
export function canonicalListingUrl(itemId: string, observedUrl: string | null): string {
  let host = 'www.ebay.ca';
  if (observedUrl !== null) {
    try {
      const parsed = new URL(observedUrl);
      const hostname = parsed.hostname.toLowerCase();
      if (hostname === 'ebay.com' || hostname.endsWith('.ebay.com')) {
        host = 'www.ebay.com';
      }
    } catch {
      // keep default
    }
  }
  return `https://${host}/itm/${itemId}`;
}
