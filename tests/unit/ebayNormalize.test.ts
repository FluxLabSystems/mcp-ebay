import { describe, expect, it } from 'vitest';
import {
  canonicalListingUrl,
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
    expect(parseMoney('C $35.00')).toEqual({ value: 35, currency: 'CAD', approximate: false });
    expect(parseMoney('US $12.50')).toEqual({ value: 12.5, currency: 'USD', approximate: false });
    expect(parseMoney('C $1,234.56')).toEqual({ value: 1234.56, currency: 'CAD', approximate: false });
    expect(parseMoney('$10.99')).toEqual({ value: 10.99, currency: 'CAD', approximate: false });
    expect(parseMoney('Free shipping')).toEqual({ value: 0, currency: 'CAD', approximate: false });
  });
  it('flags ranges as approximate at the low bound', () => {
    expect(parseMoney('C $8.91 to C $12.00')).toEqual({ value: 8.91, currency: 'CAD', approximate: true });
  });
  it('rejects non-monetary text', () => {
    expect(parseMoney('See details')).toBeNull();
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
