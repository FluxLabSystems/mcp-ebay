import { describe, expect, it } from 'vitest';
import {
  canonicalListingUrl,
  cleanTitle,
  itemIdFromUrl,
  normalizeEbayImageUrl,
  normalizePostalCode,
  parseMoney,
  postalCodesMatch,
} from '@browser-bridge/site-ebay';

describe('postal normalization (§20.1)', () => {
  it('normalizes to A9A 9A9', () => {
    expect(normalizePostalCode('m6h2w9')).toBe('M6H 2W9');
    expect(normalizePostalCode('M6H 2W9')).toBe('M6H 2W9');
    expect(normalizePostalCode(' m6h-2w9 ')).toBe('M6H 2W9');
    expect(normalizePostalCode('90210')).toBeNull();
    expect(normalizePostalCode('')).toBeNull();
  });
  it('matches equivalent forms', () => {
    expect(postalCodesMatch('m6h2w9', 'M6H 2W9')).toBe(true);
    expect(postalCodesMatch('K1A 0B1', 'M6H 2W9')).toBe(false);
  });
});

describe('money parsing (§20.3)', () => {
  it('parses eBay-rendered amounts', () => {
    expect(parseMoney('C $35.00')).toEqual({ value: 35, currency: 'CAD', approximate: false, ambiguousFree: false });
    expect(parseMoney('US $12.50')).toEqual({ value: 12.5, currency: 'USD', approximate: false, ambiguousFree: false });
    expect(parseMoney('C $1,234.56')).toEqual({
      value: 1234.56,
      currency: 'CAD',
      approximate: false,
      ambiguousFree: false,
    });
    expect(parseMoney('$10.99')).toEqual({ value: 10.99, currency: 'CAD', approximate: false, ambiguousFree: false });
    expect(parseMoney('Free shipping')).toEqual({ value: 0, currency: 'CAD', approximate: false, ambiguousFree: false });
    expect(parseMoney('Free')).toEqual({ value: 0, currency: 'CAD', approximate: false, ambiguousFree: false });
  });
  it('flags ranges as approximate at the low bound', () => {
    expect(parseMoney('C $8.91 to C $12.00')).toEqual({
      value: 8.91,
      currency: 'CAD',
      approximate: true,
      ambiguousFree: false,
    });
  });
  it('rejects non-monetary text', () => {
    expect(parseMoney('See details')).toBeNull();
  });

  // An eBay International Shipping block renders "free returns" beside the
  // real figure. A bare /free/ test zeroed the cost while observedText still
  // showed it -- a silent zero that corrupts landed-cost arithmetic.
  it('does not zero a real amount because the text mentions free returns', () => {
    expect(parseMoney('C $28.36 eBay International Shipping | Free returns')).toEqual({
      value: 28.36,
      currency: 'CAD',
      approximate: false,
      ambiguousFree: false,
    });
    expect(parseMoney('US $14.99 expedited shipping. Free 30-day returns.')).toEqual({
      value: 14.99,
      currency: 'USD',
      approximate: false,
      ambiguousFree: false,
    });
  });

  // 2026-09-04 deals fire (site-ebay+extractor_defect+shipping-currency-
  // mislabelled-on-foreign-quotes): an Australian seller's "AU $5.00 (approx
  // C $4.97)" shipping cell came back {value 5, currency 'CAD'} — the bare
  // "$" alternative matched inside "AU $" and took the .ca default, so the
  // foreign figure wore the domestic label and landed-cost maths was off by
  // the FX rate. GBP quotes ("GBP 33.05 (approx C $61.66)") carry no "$" at
  // all, so the only match was the conversion, silently.
  describe('foreign quotes keep their currency and surface the page conversion', () => {
    it('reads AU $ as AUD and carries the approx CAD conversion beside it', () => {
      expect(parseMoney('AU $5.00 (approx C $4.97)')).toEqual({
        value: 5,
        currency: 'AUD',
        approximate: false,
        ambiguousFree: false,
        conversion: { value: 4.97, currency: 'CAD' },
      });
    });
    it('reads an ISO-coded quote (GBP, EUR) as that currency', () => {
      expect(parseMoney('GBP 33.05 (approx C $61.66)')).toEqual({
        value: 33.05,
        currency: 'GBP',
        approximate: false,
        ambiguousFree: false,
        conversion: { value: 61.66, currency: 'CAD' },
      });
      expect(parseMoney('£22.77')).toMatchObject({ value: 22.77, currency: 'GBP' });
      expect(parseMoney('EUR 10.00')).toMatchObject({ value: 10, currency: 'EUR' });
      expect(parseMoney('AU $11.00')).toMatchObject({ value: 11, currency: 'AUD' });
      expect(parseMoney('AU $11.00')).not.toHaveProperty('conversion');
    });
    it('does not read a three-letter word before a number as a currency code', () => {
      // "LOT 5" is a quantity; only ISO codes eBay renders count.
      expect(parseMoney('LOT 5 C $3.00')).toMatchObject({ value: 3, currency: 'CAD' });
    });
    it('leaves domestic amounts exactly as before', () => {
      expect(parseMoney('C $35.00')).toEqual({ value: 35, currency: 'CAD', approximate: false, ambiguousFree: false });
      expect(parseMoney('$10.99')).toEqual({ value: 10.99, currency: 'CAD', approximate: false, ambiguousFree: false });
    });
  });

  it('still takes free when the word actually modifies shipping, and flags a mixed cell', () => {
    expect(parseMoney('Free standard shipping')).toEqual({
      value: 0,
      currency: 'CAD',
      approximate: false,
      ambiguousFree: false,
    });
    // Free standard, paid expedited: free is the standard cost, but the cell
    // was not unambiguous and says so.
    expect(parseMoney('Free shipping | C $12.00 expedited')).toEqual({
      value: 0,
      currency: 'CAD',
      approximate: false,
      ambiguousFree: true,
    });
  });
});

describe('title cleaning', () => {
  it('strips the screen-reader anchor text eBay puts inside every card title', () => {
    expect(cleanTitle('LEGO Friends Bulk Lot 5 lbs Opens in a new window or tab')).toBe('LEGO Friends Bulk Lot 5 lbs');
  });
  it('strips badge prefixes, including stacked ones', () => {
    expect(cleanTitle('New Listing LEGO Castle Lot')).toBe('LEGO Castle Lot');
    expect(cleanTitle('SPONSORED Almost gone Vintage LEGO Space Set')).toBe('Vintage LEGO Space Set');
    expect(cleanTitle('Watching: LEGO Technic 42115')).toBe('LEGO Technic 42115');
  });
  it('matches whole badge phrases, so a shared first word is not enough to strip', () => {
    // "New" alone is never a badge -- only "New Listing" is -- so this survives.
    expect(cleanTitle('New Balance 990v5 Made in USA')).toBe('New Balance 990v5 Made in USA');
  });
  it('strips a badge span that abuts the title with no whitespace (2026-09-01 live run)', () => {
    // textContent of `<span>New Listing</span>LEGO ...` has no separating
    // space, so the word-boundary form cannot see where the badge ends.
    expect(cleanTitle('New ListingLEGO Bulk Lot 4 lbs Star Wars Castle')).toBe(
      'LEGO Bulk Lot 4 lbs Star Wars Castle',
    );
    expect(cleanTitle('SPONSOREDVintage LEGO Space Set')).toBe('Vintage LEGO Space Set');
  });
  it('keeps an all-caps title that genuinely starts with NEW LISTINGS', () => {
    // The camel strip is case-sensitive on the badge's rendered casing, so
    // "NEW LISTING" + "S" in a shouting title is not mistaken for the badge.
    expect(cleanTitle('NEW LISTINGS DAILY LEGO Mixed Bricks')).toBe('NEW LISTINGS DAILY LEGO Mixed Bricks');
  });
  it('KNOWN LIMIT: a title whose real first word IS a badge phrase loses it', () => {
    // "Sponsored" is a single-word badge, so a genuine title starting with it
    // is trimmed. Accepted: eBay stamps that badge on cards far more often
    // than a listing title begins with the word, and the alternative is
    // leaving the badge on every sponsored card. Documented rather than
    // silently tolerated -- if this bites, the fix is to read the badge from
    // its own span and subtract it, not to widen the regex.
    expect(cleanTitle('Sponsored Content Book First Edition')).toBe('Content Book First Edition');
  });
  it('collapses the whitespace eBay renders with non-breaking spaces', () => {
    expect(cleanTitle('LEGO\u00a0Star\u00a0Wars   75192')).toBe('LEGO Star Wars 75192');
  });
});

describe('canonical listing identity (§20.2)', () => {
  it('extracts item ids from listing URL shapes', () => {
    expect(itemIdFromUrl('https://www.ebay.ca/itm/123456789012')).toBe('123456789012');
    expect(itemIdFromUrl('https://www.ebay.ca/itm/123456789012?var=0&hash=x')).toBe('123456789012');
    expect(itemIdFromUrl('https://www.ebay.com/itm/Cool-Lego-Lot/234567890123')).toBe('234567890123');
    expect(itemIdFromUrl('https://www.ebay.ca/sch/i.html?_nkw=lego')).toBeNull();
  });
  it('normalizes to ebay.ca and preserves ebay.com canonical hosts', () => {
    expect(canonicalListingUrl('123456789012', 'https://www.ebay.ca/itm/123456789012?x=1')).toBe(
      'https://www.ebay.ca/itm/123456789012',
    );
    expect(canonicalListingUrl('987654321098', 'https://www.ebay.com/itm/987654321098')).toBe(
      'https://www.ebay.com/itm/987654321098',
    );
    expect(canonicalListingUrl('111', null)).toBe('https://www.ebay.ca/itm/111');
  });
});

describe('gallery URL normalization (§20.4)', () => {
  it('dedupes size variants to one image key and upgrades to s-l1600', () => {
    const a = normalizeEbayImageUrl('https://i.ebayimg.com/images/g/AAAAAAAAAA1/s-l64.jpg');
    const b = normalizeEbayImageUrl('https://i.ebayimg.com/images/g/AAAAAAAAAA1/s-l500.jpg');
    expect(a.dedupKey).toBe(b.dedupKey);
    expect(b.bestUrl).toBe('https://i.ebayimg.com/images/g/AAAAAAAAAA1/s-l1600.jpg');
  });
  it('normalizes thumbs hosts and keeps larger-than-1600 sources', () => {
    const thumbs = normalizeEbayImageUrl('https://thumbs2.ebayimg.com/images/g/KEY9/s-l300.webp');
    expect(thumbs.dedupKey).toBe('ebayimg:g/KEY9');
    expect(thumbs.bestUrl).toBe('https://i.ebayimg.com/images/g/KEY9/s-l1600.webp');
    const big = normalizeEbayImageUrl('https://i.ebayimg.com/images/g/KEY9/s-l2400.jpg');
    expect(big.bestUrl).toBe('https://i.ebayimg.com/images/g/KEY9/s-l2400.jpg');
  });
  it('passes through non-ebayimg URLs untouched', () => {
    const other = normalizeEbayImageUrl('https://example.com/pic.png');
    expect(other).toEqual({ dedupKey: 'https://example.com/pic.png', bestUrl: 'https://example.com/pic.png' });
  });
});
