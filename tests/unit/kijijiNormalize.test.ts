import { describe, expect, it } from 'vitest';
// site-kijiji is imported by relative path rather than a workspace alias:
// tests/package.json is not modified by this change, so the package is not
// linked into tests/node_modules; tsc and vitest both resolve the
// TypeScript source directly through this path.
import {
  adIdFromUrl,
  canonicalAdUrl,
  dealsFeedId,
  parseKijijiPrice,
} from '../../packages/site-kijiji/src/index.js';

describe('kijiji price parsing', () => {
  it('parses dollar amounts with and without cents and thousands separators', () => {
    expect(parseKijijiPrice('$1,234.56')).toEqual({
      kind: 'amount',
      value: 1234.56,
      currency: 'CAD',
      rawText: '$1,234.56',
    });
    expect(parseKijijiPrice('$60')).toMatchObject({ kind: 'amount', value: 60, currency: 'CAD' });
    expect(parseKijijiPrice('$60.00')).toMatchObject({ kind: 'amount', value: 60 });
  });

  it('normalizes NBSP and narrow no-break spaces like ebay parseMoney', () => {
    expect(parseKijijiPrice('$\u00a060.00')).toEqual({
      kind: 'amount',
      value: 60,
      currency: 'CAD',
      rawText: '$ 60.00',
    });
    expect(parseKijijiPrice('$\u202f1,250')).toMatchObject({ kind: 'amount', value: 1250 });
  });

  it('recognizes the non-amount classified price vocabulary', () => {
    expect(parseKijijiPrice('Free')).toEqual({ kind: 'free', value: 0, currency: 'CAD', rawText: 'Free' });
    expect(parseKijijiPrice('FREE!')).toMatchObject({ kind: 'free', value: 0 });
    expect(parseKijijiPrice('Please Contact')).toEqual({
      kind: 'contact',
      value: null,
      currency: 'CAD',
      rawText: 'Please Contact',
    });
    expect(parseKijijiPrice('please  contact')).toMatchObject({ kind: 'contact', value: null });
    expect(parseKijijiPrice('Swap / Trade')).toMatchObject({ kind: 'swap', value: null, currency: 'CAD' });
    expect(parseKijijiPrice('Swap/Trade')).toMatchObject({ kind: 'swap', value: null });
  });

  it('returns null for unrecognized or empty text instead of guessing', () => {
    expect(parseKijijiPrice('See details')).toBeNull();
    expect(parseKijijiPrice('Contact')).toBeNull();
    expect(parseKijijiPrice('')).toBeNull();
    expect(parseKijijiPrice('   ')).toBeNull();
    expect(parseKijijiPrice('1234')).toBeNull();
  });
});

describe('kijiji ad id extraction', () => {
  it('reads the trailing numeric id from VIP URL shapes', () => {
    expect(adIdFromUrl('https://www.kijiji.ca/v-buy-sell/city-of-toronto/lego-friends-bulk-lot/1712345678')).toBe(
      '1712345678',
    );
    expect(adIdFromUrl('https://www.kijiji.ca/v-buy-sell/city-of-toronto/lego-friends-bulk-lot/1712345678?utm=1#top')).toBe(
      '1712345678',
    );
    expect(adIdFromUrl('https://www.kijiji.ca/v-buy-sell/city-of-toronto/lego-friends-bulk-lot/1712345678/')).toBe(
      '1712345678',
    );
  });

  it('accepts the legacy adId query form', () => {
    expect(adIdFromUrl('https://www.kijiji.ca/v-view-details.html?adId=1712345678')).toBe('1712345678');
  });

  it('rejects non-VIP shapes, out-of-range ids, and garbage', () => {
    expect(adIdFromUrl('https://www.kijiji.ca/b-buy-sell/city-of-toronto/c10l1700273')).toBeNull();
    expect(adIdFromUrl('https://www.kijiji.ca/v-buy-sell/toronto/lot/123456')).toBeNull();
    expect(adIdFromUrl('https://www.kijiji.ca/v-buy-sell/toronto/lot/1234567890123')).toBeNull();
    expect(adIdFromUrl('https://www.kijiji.ca/')).toBeNull();
    expect(adIdFromUrl('not a url')).toBeNull();
  });
});

describe('kijiji canonical ad URL', () => {
  it('preserves the observed slug path stripped of query/fragment', () => {
    expect(
      canonicalAdUrl('1712345678', 'https://www.kijiji.ca/v-buy-sell/city-of-toronto/lego-lot/1712345678?utm=1#top'),
    ).toBe('https://www.kijiji.ca/v-buy-sell/city-of-toronto/lego-lot/1712345678');
  });

  it('forces https on the preserved URL', () => {
    expect(canonicalAdUrl('1712345678', 'http://kijiji.ca/v-buy-sell/toronto/lego-lot/1712345678')).toBe(
      'https://kijiji.ca/v-buy-sell/toronto/lego-lot/1712345678',
    );
  });

  it('returns null off the kijiji.ca host family or without a usable observed URL', () => {
    expect(canonicalAdUrl('1712345678', 'https://www.ebay.ca/itm/1712345678')).toBeNull();
    expect(canonicalAdUrl('1712345678', 'https://kijiji.ca.evil.example/v-x/1712345678')).toBeNull();
    expect(canonicalAdUrl('1712345678', 'not a url')).toBeNull();
    expect(canonicalAdUrl('1712345678', null)).toBeNull();
  });
});

describe('fluxology deals feed id', () => {
  it('uses the kijiji-<marketplaceListingId> convention', () => {
    expect(dealsFeedId('1712345678')).toBe('kijiji-1712345678');
  });
});
