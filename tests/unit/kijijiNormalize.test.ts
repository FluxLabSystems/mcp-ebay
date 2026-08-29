import { describe, expect, it } from 'vitest';
// site-kijiji is imported by relative path rather than a workspace alias:
// tests/package.json is not modified by this change, so the package is not
// linked into tests/node_modules; tsc and vitest both resolve the
// TypeScript source directly through this path.
import {
  adIdFromUrl,
  canonicalAdUrl,
  dealsFeedId,
  parseKijijiPostedText,
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

describe('kijiji relative posted-time parsing', () => {
  // Wording taken from the site's own listing:activation_time.* strings,
  // shipped inline on every search page.
  const now = new Date('2026-08-29T12:00:00.000Z');

  it('parses the short units a result card renders', () => {
    expect(parseKijijiPostedText('45 seconds ago', now)).toBe('2026-08-29T11:59:15.000Z');
    expect(parseKijijiPostedText('1 min ago', now)).toBe('2026-08-29T11:59:00.000Z');
    expect(parseKijijiPostedText('30 min ago', now)).toBe('2026-08-29T11:30:00.000Z');
    expect(parseKijijiPostedText('1 hr ago', now)).toBe('2026-08-29T11:00:00.000Z');
    expect(parseKijijiPostedText('2 hrs ago', now)).toBe('2026-08-29T10:00:00.000Z');
    expect(parseKijijiPostedText('1 day ago', now)).toBe('2026-08-28T12:00:00.000Z');
    expect(parseKijijiPostedText('3 days ago', now)).toBe('2026-08-26T12:00:00.000Z');
    expect(parseKijijiPostedText('1 wk ago', now)).toBe('2026-08-22T12:00:00.000Z');
    expect(parseKijijiPostedText('3 wks ago', now)).toBe('2026-08-08T12:00:00.000Z');
    expect(parseKijijiPostedText('1 mo ago', now)).toBe('2026-07-30T12:00:00.000Z');
  });

  it('tolerates the longer wording and the aria-label prefix', () => {
    expect(parseKijijiPostedText('Published 2 hours ago', now)).toBe('2026-08-29T10:00:00.000Z');
    expect(parseKijijiPostedText('Posted 2 minutes ago', now)).toBe('2026-08-29T11:58:00.000Z');
    expect(parseKijijiPostedText('Yesterday', now)).toBe('2026-08-28T12:00:00.000Z');
    // NEEDS-LIVE-VERIFICATION: fr_CA activation_time wording is carried
    // defensively; only the en_CA strings have been seen on a live page.
    expect(parseKijijiPostedText('il y a 2 heures', now)).toBe('2026-08-29T10:00:00.000Z');
    expect(parseKijijiPostedText('hier', now)).toBe('2026-08-28T12:00:00.000Z');
  });

  it('refuses open-ended and unrecognized text rather than guessing an instant', () => {
    // "30+ d" and "over a month ago" state a bound, not a time.
    expect(parseKijijiPostedText('30+ d', now)).toBeNull();
    expect(parseKijijiPostedText('over a month ago', now)).toBeNull();
    expect(parseKijijiPostedText('', now)).toBeNull();
    expect(parseKijijiPostedText('Old Toronto', now)).toBeNull();
    expect(parseKijijiPostedText('$45.00', now)).toBeNull();
  });
});
