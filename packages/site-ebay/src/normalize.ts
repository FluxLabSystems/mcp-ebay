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
  /**
   * True when the text carried an explicit free-shipping phrase AND a
   * separate amount. The free phrase wins; this says the cell was mixed.
   */
  ambiguousFree: boolean;
  /**
   * The page's own "(approx C $4.97)" conversion of a foreign quote, when it
   * rendered one. Present only beside a quote in another currency; the
   * `value`/`currency` pair above is always the amount as quoted.
   */
  conversion?: { value: number; currency: string };
}

/**
 * Parse eBay-rendered money text: "C $35.00", "US $12.00", "CA $1,234.56",
 * "$10.99", "C $8.91 to C $12.00", "Free", "Free shipping".
 * `defaultCurrency` applies to bare "$" amounts (CAD on ebay.ca).
 *
 * Foreign quotes (2026-09-04 deals fire, shipping-currency-mislabelled-on-
 * foreign-quotes): an overseas seller's cell reads "AU $5.00 (approx C
 * $4.97)" or "GBP 33.05 (approx C $61.66)". The bare "$" alternative used to
 * match inside "AU $" and take the .ca default, so the foreign figure wore
 * the domestic label; an ISO-coded quote matched nothing and only its
 * conversion was read, silently. The quote is now parsed under its own
 * currency and the conversion is carried beside it for the caller to prefer.
 */
/**
 * "Free shipping", "Free standard delivery", "Free 2-day postage" -- the word
 * free ATTACHED TO SHIPPING. Deliberately not a bare /\bfree\b/: an eBay
 * International Shipping block renders "free returns" (and "free 30-day
 * returns") right beside the real shipping figure, and a bare test there
 * zeroed a real cost while observedText still showed it. Silent zeros
 * corrupt landed-cost arithmetic instead of failing loudly, so the word only
 * wins when it actually modifies shipping.
 */
const FREE_SHIPPING_RE = /\bfree\b(?:\s+[\w-]+){0,2}\s+(?:shipping|delivery|postage)\b/i;

export function parseMoney(rawText: string, defaultCurrency = 'CAD'): ParsedMoney | null {
  // eBay renders prices with NBSP / narrow no-break spaces.
  const text = rawText.replace(/[\u00a0\u202f]/g, ' ').trim();
  if (text.length === 0) return null;

  const matches = [...text.matchAll(MONEY_RE)];
  const freeShipping = FREE_SHIPPING_RE.test(text);

  // Explicit "free shipping" wins over any amount in the same cell: a second
  // figure there is an upgrade option (expedited), not the standard cost.
  // Flagged so a caller can see the cell was not unambiguous.
  if (freeShipping) {
    return { value: 0, currency: defaultCurrency, approximate: false, ambiguousFree: matches.length > 0 };
  }
  if (matches.length === 0) {
    // No amount and no shipping-qualified "free". A bare "Free" cell is still
    // free; anything else is unparseable.
    return /\bfree\b/i.test(text)
      ? { value: 0, currency: defaultCurrency, approximate: false, ambiguousFree: false }
      : null;
  }

  // The quoted amount is the first figure that is NOT inside an "(approx …)"
  // clause; a cell that is only a conversion still parses as that figure.
  const conversionMatch = APPROX_RE.exec(text);
  const conversionIndex = conversionMatch === null ? -1 : conversionMatch.index + conversionMatch[0].indexOf(conversionMatch[1]!);
  const first = matches.find((m) => m.index !== conversionIndex) ?? matches[0]!;
  const currency = currencyOfSymbol(first[1]!, defaultCurrency);
  const value = Number.parseFloat(first[2]!.replace(/,/g, ''));
  if (Number.isNaN(value)) return null;
  const approximate = /\bto\b/i.test(text) && matches.length > 1;
  const parsed: ParsedMoney = { value, currency, approximate, ambiguousFree: false };
  if (conversionMatch !== null && conversionIndex !== first.index) {
    const convertedValue = Number.parseFloat(conversionMatch[2]!.replace(/,/g, ''));
    const convertedCurrency = currencyOfSymbol(conversionMatch[1]!, defaultCurrency);
    if (!Number.isNaN(convertedValue) && convertedCurrency !== currency) {
      parsed.conversion = { value: convertedValue, currency: convertedCurrency };
    }
  }
  return parsed;
}

/**
 * Every currency marker eBay renders in front of an amount. Two-letter
 * country prefixes ("C $", "US $", "AU $"), a symbol (£, €), or an ISO code
 * with or without the symbol ("GBP 33.05", "CAD $5"). The ISO list is
 * closed on purpose: a generic [A-Z]{3} would read "LOT 5" as a currency.
 */
const CURRENCY_MARKER =
  '(C\\s?\\$|CA\\s?\\$|CAD\\s?\\$?|US\\s?\\$|USD\\s?\\$?|AU\\s?\\$|A\\$|AUD\\s?\\$?|NZ\\s?\\$|NZD\\s?\\$?|HK\\s?\\$|HKD\\s?\\$?|GBP\\s?£?|£|EUR\\s?€?|€|JPY\\s?¥?|¥|CHF|SGD\\s?\\$?|MXN\\s?\\$?|CNY|\\$)';
const MONEY_RE = new RegExp(`${CURRENCY_MARKER}\\s?([\\d,]+(?:\\.\\d{1,2})?)`, 'gi');
const APPROX_RE = new RegExp(`approx(?:imately|\\.)?\\s*${CURRENCY_MARKER}\\s?([\\d,]+(?:\\.\\d{1,2})?)`, 'i');

function currencyOfSymbol(rawSymbol: string, defaultCurrency: string): string {
  const symbol = rawSymbol.toUpperCase().replace(/\s/g, '');
  if (symbol === '$') return defaultCurrency;
  if (symbol.startsWith('US')) return 'USD';
  if (symbol.startsWith('AU') || symbol === 'A$') return 'AUD';
  if (symbol.startsWith('NZ')) return 'NZD';
  if (symbol.startsWith('HK')) return 'HKD';
  if (symbol.startsWith('GBP') || symbol === '£') return 'GBP';
  if (symbol.startsWith('EUR') || symbol === '€') return 'EUR';
  if (symbol.startsWith('JPY') || symbol === '¥') return 'JPY';
  if (symbol === 'CHF' || symbol === 'CNY') return symbol;
  if (symbol.startsWith('SGD')) return 'SGD';
  if (symbol.startsWith('MXN')) return 'MXN';
  return 'CAD';
}

/**
 * eBay decorates rendered titles with things that are not part of the title:
 * a screen-reader "Opens in a new window or tab" on every search-result
 * anchor, and badge spans ("New Listing", "SPONSORED") that sit inside the
 * title element on search, homepage and watchlist cards. textContent
 * concatenates all of it. The badge list is deliberately conservative --
 * whole known phrases only, never a bare leading word, so a genuine title
 * like "New Balance 990" keeps its first word.
 */
const TITLE_NOISE_RE = /\s*opens?\s+in\s+a\s+new\s+window\s+or\s+tab\s*/gi;
const TITLE_BADGE_RE =
  /^(?:new listing|newly listed|sponsored|almost gone|ending soon|watching|top rated plus|best selling|hot this week)\b\s*[:\u2013\u2014-]?\s*/i;
/**
 * The badge span can abut the title's text node with no whitespace at all:
 * textContent of `<span>New Listing</span>LEGO Bulk Lot` is
 * "New ListingLEGO Bulk Lot" -- and \b cannot see that seam, so the anchored
 * regex above leaves the badge on. The seam it CAN see is the camel boundary:
 * the badge in its exact rendered casing followed immediately by an
 * uppercase letter or digit. Case-sensitive on purpose: an all-caps title
 * that genuinely starts "NEW LISTINGS ..." is "NEW LISTING" + "S" to a
 * case-blind pattern and would lose its first two words.
 */
const TITLE_BADGE_CAMEL_RE = /^(?:New Listing|Newly Listed|Sponsored|SPONSORED)(?=[A-Z0-9])/;

export function cleanTitle(rawText: string): string {
  let text = rawText.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(TITLE_NOISE_RE, ' ').replace(/\s+/g, ' ').trim();
  // Cards can carry more than one badge.
  for (;;) {
    const stripped = text.replace(TITLE_BADGE_RE, '').replace(TITLE_BADGE_CAMEL_RE, '').trim();
    if (stripped === text || stripped.length === 0) break;
    text = stripped;
  }
  return text;
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
