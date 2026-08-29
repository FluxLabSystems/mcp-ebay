/**
 * Compact projections and search compaction — the Phase 2 call-budget work.
 *
 * The byte-budget test at the bottom is the point of the whole module: a
 * measured deals run on 2026-08-29 spent 8 tool calls on a single eBay
 * search page because browser.extract returned 160 KB of tracking-laden
 * candidate rows that spilled to a file the model then had to parse with
 * shell calls. The assertion pins the size, not the shape, so a future
 * candidate field that quietly reinflates the payload fails here.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalizeCandidateUrl,
  compactEbayItem,
  compactItemRecord,
  compactKijijiAd,
  compactSearchPage,
} from '@browser-bridge/windows-agent';
import { SearchCompactionInput } from '@browser-bridge/protocol';

const DEFAULTS = SearchCompactionInput.parse({});

function field(value: string) {
  return { value, source: 'dom' as const, confidence: 0.95 };
}

/** A realistic eBay search-result href, tracking payload and all. */
function trackingUrl(itemId: string, title: string): string {
  const skw = encodeURIComponent(title);
  return (
    `https://www.ebay.ca/itm/${itemId}?_skw=${skw}` +
    `&itmmeta=01K3QJ8${itemId}TZ4WQ9F0GJ7C` +
    `&hash=item34f${itemId}b2%3Ag%3A${itemId}AAOSw${itemId}` +
    `&itmprp=enc%3AAQAKAAAA4FkggFvd1GGDu0w3yXCmi1c5rH3Yv3Xq6Y9pOaU9Fh2Kd` +
    `Wq7bH9zRnUu4pQm3LxTaVc0yYw1E2sJ8oGgKfPd%7Ctkp%3ABk9SR8${itemId}`
  );
}

function syntheticEbayCandidates(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const itemId = String(226100000000 + index);
    const title = `LEGO Bulk Lot ${index} - Mixed Bricks Minifigures City Friends Star Wars 5 lbs Cleaned Sorted`;
    return {
      itemId,
      url: trackingUrl(itemId, title),
      title,
      snippetPrice: { value: 40 + (index % 90), currency: 'CAD' },
      sellingFormat: index % 3 === 0 ? 'auction' : 'fixed_price',
      bidCount: index % 3 === 0 ? index % 12 : null,
      shippingSnippetText: `+C $${(12 + (index % 30)).toFixed(2)} shipping estimate from United States to Canada`,
      itemLocationText: index % 2 === 0 ? 'Toronto, ON, Canada' : 'Buffalo, NY, United States',
      isNewListing: index % 7 === 0,
      order: index,
    };
  });
}

function searchRecord(count: number) {
  return {
    siteProfile: 'ebay.ca.v1',
    pageKind: 'search',
    pageUrl: 'https://www.ebay.ca/sch/i.html?_nkw=lego+bulk+lot&_sop=10',
    candidateCount: count,
    candidates: syntheticEbayCandidates(count),
    note: 'Candidate snippets are traversal hints; open each /itm/ URL and extract it for canonical evidence.',
  };
}

describe('candidate URL canonicalization', () => {
  it('reduces an eBay result href to https://www.ebay.ca/itm/<id>', () => {
    expect(canonicalizeCandidateUrl(trackingUrl('226123456789', 'lego lot'), 'ebay')).toBe(
      'https://www.ebay.ca/itm/226123456789',
    );
  });

  it('preserves an ebay.com canonical host rather than rewriting the marketplace', () => {
    expect(canonicalizeCandidateUrl('https://www.ebay.com/itm/226123456789?_skw=x', 'ebay')).toBe(
      'https://www.ebay.com/itm/226123456789',
    );
  });

  it('keeps the Kijiji VIP path, which carries the identity, and drops the query', () => {
    expect(
      canonicalizeCandidateUrl(
        'https://www.kijiji.ca/v-toys-games/city-of-toronto/lego-bulk-lot/1712345678?siteLocale=en_CA&enableSearchNavigationFlag=true',
        'kijiji',
      ),
    ).toBe('https://www.kijiji.ca/v-toys-games/city-of-toronto/lego-bulk-lot/1712345678');
  });

  it('never returns nothing: an unparseable URL comes back as it arrived', () => {
    expect(canonicalizeCandidateUrl('not a url', 'ebay')).toBe('not a url');
  });
});

describe('compact item records tolerate the record shape they are given', () => {
  it('flattens a full eBay record to the Appendix A field set', () => {
    const compact = compactEbayItem(
      {
        siteProfile: 'ebay.ca.v1',
        itemId: field('226123456789'),
        canonicalUrl: field('https://www.ebay.ca/itm/226123456789'),
        title: field('LEGO bulk lot 5 lbs'),
        seller: field('tweedsidesales'),
        itemLocationText: field('Toronto, ON, Canada'),
        itemPrice: { value: 84.5, currency: 'CAD', source: 'dom', confidence: 0.9 },
        shipping: {
          value: 22.15,
          currency: 'CAD',
          source: 'dom',
          confidence: 0.9,
          destinationPostalCode: 'M6H 2W9',
          destinationVerified: true,
          observedText: 'C $22.15 expedited shipping',
        },
        offer: { available: true, sellerOfferPrice: null, expiresAt: null },
        listingStatus: 'active',
        sellingFormat: { kind: 'auction', bidCount: 7, source: 'dom', confidence: 0.9 },
        endsAt: { value: '2026-09-03T18:00:00Z', source: 'dom', confidence: 0.8 },
        watcherCount: { value: 14, source: 'dom', confidence: 0.7 },
        quantityAvailable: { value: 1, source: 'dom', confidence: 0.9 },
        quantitySold: { value: 0, source: 'dom', confidence: 0.9 },
        observedAt: '2026-08-29T12:00:00Z',
        pageRevision: 3,
      },
      ['DESTINATION_UNVERIFIED'],
    );
    expect(compact).toEqual({
      itemId: '226123456789',
      canonicalUrl: 'https://www.ebay.ca/itm/226123456789',
      title: 'LEGO bulk lot 5 lbs',
      seller: 'tweedsidesales',
      itemLocationText: 'Toronto, ON, Canada',
      sellingFormat: { kind: 'auction', bidCount: 7 },
      listingStatus: 'active',
      endsAt: '2026-09-03T18:00:00Z',
      itemPrice: { value: 84.5, currency: 'CAD' },
      shipping: {
        value: 22.15,
        currency: 'CAD',
        destinationVerified: true,
        serviceText: 'C $22.15 expedited shipping',
      },
      offerAvailable: true,
      quantityAvailable: 1,
      quantitySold: 0,
      watcherCount: 14,
      warnings: ['DESTINATION_UNVERIFIED'],
    });
  });

  it('emits null for fields a record does not carry yet, and never throws', () => {
    // Exactly the pre-2026-08-29 eBay record: no endsAt, no location, no
    // watcher or quantity fields. The site packages add fields on their own
    // cadence and a projection that threw would turn that into an outage.
    const compact = compactEbayItem({
      siteProfile: 'ebay.ca.v1',
      itemId: field('1'),
      title: field('lot'),
      itemPrice: null,
      shipping: null,
      offer: { available: false, sellerOfferPrice: null, expiresAt: null },
      listingStatus: 'unknown',
      sellingFormat: { kind: 'unknown', bidCount: null, source: 'dom', confidence: 0.3 },
    });
    expect(compact.endsAt).toBeNull();
    expect(compact.itemLocationText).toBeNull();
    expect(compact.watcherCount).toBeNull();
    expect(compact.quantityAvailable).toBeNull();
    expect(compact.quantitySold).toBeNull();
    expect(compact.itemPrice).toBeNull();
    expect(compact.shipping).toBeNull();
    expect(compact.offerAvailable).toBe(false);
    expect(() => compactEbayItem(null)).not.toThrow();
    expect(() => compactEbayItem('nonsense')).not.toThrow();
    expect(compactEbayItem(undefined).itemId).toBeNull();
  });

  it('reads a shipping line under either observedText or a later serviceText', () => {
    const withService = compactEbayItem({
      shipping: { value: 0, currency: 'CAD', destinationVerified: true, serviceText: 'Free 3-day' },
    });
    expect(withService.shipping?.serviceText).toBe('Free 3-day');
  });

  it('flattens a Kijiji ad, unwrapping the location text envelope', () => {
    const compact = compactKijijiAd({
      siteProfile: 'kijiji.ca.v1',
      adId: field('1712345678'),
      canonicalUrl: field('https://www.kijiji.ca/v-toys-games/city-of-toronto/lego/1712345678'),
      title: field('LEGO bulk 10 lbs'),
      price: { kind: 'amount', value: 120, currency: 'CAD', rawText: '$120.00', source: 'dom', confidence: 0.9 },
      location: { text: 'Toronto, ON M6H 2W9', source: 'dom', confidence: 0.8 },
      postedAt: '2026-08-28T14:30:00Z',
      postedText: 'Posted 22 hours ago',
      sellerName: field('Dave'),
      sellerType: 'owner',
      description: { value: 'Mixed bricks, no minifigs.', source: 'dom', confidence: 0.9 },
      attributes: [],
      imageCount: 6,
      listingStatus: 'active',
      observedAt: '2026-08-29T12:00:00Z',
      pageRevision: 2,
    });
    expect(compact).toEqual({
      adId: '1712345678',
      canonicalUrl: 'https://www.kijiji.ca/v-toys-games/city-of-toronto/lego/1712345678',
      title: 'LEGO bulk 10 lbs',
      price: { kind: 'amount', value: 120 },
      location: 'Toronto, ON M6H 2W9',
      postedAt: '2026-08-28T14:30:00Z',
      sellerName: 'Dave',
      description: 'Mixed bricks, no minifigs.',
      imageCount: 6,
      listingStatus: 'active',
    });
  });

  it('dispatches by site profile and leaves an unknown profile alone', () => {
    expect(compactItemRecord('kijiji.ca.v1', { adId: field('7') }).adId).toBe('7');
    expect(compactItemRecord('ebay.ca.v1', { itemId: field('9') }).itemId).toBe('9');
    const foreign = { anything: 1 };
    expect(compactItemRecord('amazon.v1', foreign)).toEqual(foreign);
  });
});

describe('search compaction', () => {
  it('windows, canonicalizes and projects, and says what it left behind', () => {
    const result = compactSearchPage(searchRecord(240), DEFAULTS);
    const record = result.record as {
      candidateCount: number;
      matchedCount: number;
      returnedCount: number;
      hasMore: boolean;
      nextOffset: number | null;
      candidates: Record<string, unknown>[];
    };
    expect(record.candidateCount).toBe(240);
    expect(record.matchedCount).toBe(240);
    expect(record.returnedCount).toBe(40);
    expect(record.hasMore).toBe(true);
    expect(record.nextOffset).toBe(40);
    expect(record.candidates[0]!.url).toBe('https://www.ebay.ca/itm/226100000000');
    // The default projection drops the long shipping snippet and the order
    // index; everything a triage decision reads survives.
    expect(Object.keys(record.candidates[0]!).sort()).toEqual(
      ['bidCount', 'isNewListing', 'itemId', 'itemLocationText', 'sellingFormat', 'snippetPrice', 'title', 'url'].sort(),
    );
  });

  it('offset walks the matched set', () => {
    const page2 = compactSearchPage(
      searchRecord(240),
      SearchCompactionInput.parse({ limit: 10, offset: 235 }),
    ).record as { returnedCount: number; hasMore: boolean; candidates: { itemId: string }[] };
    expect(page2.returnedCount).toBe(5);
    expect(page2.hasMore).toBe(false);
    expect(page2.candidates[0]!.itemId).toBe('226100000235');
  });

  it('a fields allow-list replaces the default projection but keeps the URL', () => {
    const record = compactSearchPage(
      searchRecord(3),
      SearchCompactionInput.parse({ fields: ['itemId', 'title'] }),
    ).record as { candidates: Record<string, unknown>[] };
    expect(Object.keys(record.candidates[0]!).sort()).toEqual(['itemId', 'title', 'url']);
  });

  it('filters by title, price band and selling format', () => {
    const base = searchRecord(60);
    const byTitle = compactSearchPage(
      base,
      SearchCompactionInput.parse({ limit: 240, include: { titleRegex: 'Lot (1|2)\\b' } }),
    ).record as { matchedCount: number };
    expect(byTitle.matchedCount).toBe(2);

    const byPrice = compactSearchPage(
      base,
      SearchCompactionInput.parse({ limit: 240, include: { minPrice: 60, maxPrice: 70 } }),
    ).record as { matchedCount: number; candidates: { snippetPrice: { value: number } }[] };
    expect(byPrice.matchedCount).toBe(11);
    for (const candidate of byPrice.candidates) {
      expect(candidate.snippetPrice.value).toBeGreaterThanOrEqual(60);
      expect(candidate.snippetPrice.value).toBeLessThanOrEqual(70);
    }

    const auctions = compactSearchPage(
      base,
      SearchCompactionInput.parse({ limit: 240, include: { formats: ['auction'] } }),
    ).record as { matchedCount: number };
    expect(auctions.matchedCount).toBe(20);
  });

  it('reports rows a price bound dropped for having no readable price', () => {
    const record = {
      ...searchRecord(4),
      candidates: [
        ...syntheticEbayCandidates(2),
        { itemId: '9', url: 'https://www.ebay.ca/itm/9', title: 'no price', snippetPrice: null },
      ],
    };
    const result = compactSearchPage(record, SearchCompactionInput.parse({ include: { maxPrice: 1000 } }));
    expect((result.record as { matchedCount: number }).matchedCount).toBe(2);
    expect(result.warnings.some((warning) => warning.startsWith('EXCLUDED_NO_PRICE'))).toBe(true);
  });

  it('keeps unreadable formats when the caller asks for "unknown"', () => {
    const record = {
      ...searchRecord(0),
      candidates: [{ itemId: '9', url: 'https://www.ebay.ca/itm/9', title: 'mystery' }],
      candidateCount: 1,
    };
    expect(
      (
        compactSearchPage(record, SearchCompactionInput.parse({ include: { formats: ['auction'] } }))
          .record as { matchedCount: number }
      ).matchedCount,
    ).toBe(0);
    expect(
      (
        compactSearchPage(record, SearchCompactionInput.parse({ include: { formats: ['auction', 'unknown'] } }))
          .record as { matchedCount: number }
      ).matchedCount,
    ).toBe(1);
  });

  it('leaves a record that is not a candidate list untouched', () => {
    const itemRecord = { siteProfile: 'ebay.ca.v1', itemId: field('1') };
    expect(compactSearchPage(itemRecord, DEFAULTS).record).toEqual(itemRecord);
  });

  it('preserves Kijiji pagination fields and uses the Kijiji default projection', () => {
    const kijiji = {
      siteProfile: 'kijiji.ca.v1',
      pageKind: 'search',
      pageUrl: 'https://www.kijiji.ca/b-toys-games/city-of-toronto/lego/k0c108l1700273r45',
      candidateCount: 1,
      candidates: [
        {
          adId: '1712345678',
          url: 'https://www.kijiji.ca/v-toys-games/city-of-toronto/lego/1712345678?siteLocale=en_CA',
          title: 'LEGO bulk',
          priceText: '$120.00',
          price: { kind: 'amount', value: 120, currency: 'CAD', rawText: '$120.00' },
          locationText: 'Toronto',
          postedText: 'Posted 2 hours ago',
        },
      ],
      hasNextPage: true,
      nextPageUrl: 'https://www.kijiji.ca/b-toys-games/city-of-toronto/lego/page-2/k0c108l1700273r45',
      totalResults: 73,
    };
    const record = compactSearchPage(kijiji, DEFAULTS).record as {
      hasNextPage: boolean;
      nextPageUrl: string;
      totalResults: number;
      candidates: Record<string, unknown>[];
    };
    expect(record.hasNextPage).toBe(true);
    expect(record.totalResults).toBe(73);
    expect(record.candidates[0]!.url).toBe(
      'https://www.kijiji.ca/v-toys-games/city-of-toronto/lego/1712345678',
    );
    expect(record.candidates[0]!.priceText).toBeUndefined();
  });
});

describe('search response byte budget', () => {
  /**
   * The guarantee, pinned. 20 KiB is the ceiling the Phase 2 brief set for a
   * 240-row page returned with default options; the measured numbers are
   * printed so a regression shows how far it moved, not just that it moved.
   */
  const BUDGET_BYTES = 20 * 1024;

  it('a 240-row eBay search page fits in 20 KiB with default compaction', () => {
    const raw = searchRecord(240);
    const compacted = compactSearchPage(raw, DEFAULTS).record;
    const rawBytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
    const compactBytes = Buffer.byteLength(JSON.stringify(compacted), 'utf8');
    console.log(
      `search compaction: ${rawBytes} B raw -> ${compactBytes} B compact ` +
        `(${(rawBytes / compactBytes).toFixed(1)}x, ${((1 - compactBytes / rawBytes) * 100).toFixed(1)}% smaller)`,
    );
    expect(rawBytes).toBeGreaterThan(150 * 1024);
    expect(compactBytes).toBeLessThan(BUDGET_BYTES);
  });

  it('still halves the payload when the caller explicitly asks for all 240 rows', () => {
    // Opting out of the default window is a choice, not the guarantee: what
    // survives is canonical URLs and the field projection, which on their
    // own take the page from ~190 KB to ~75 KB. The 20 KiB number belongs to
    // the default, and this bound exists so the projection cannot quietly
    // stop pulling its weight.
    const compacted = compactSearchPage(searchRecord(240), SearchCompactionInput.parse({ limit: 240 })).record;
    const bytes = Buffer.byteLength(JSON.stringify(compacted), 'utf8');
    console.log(`search compaction (limit 240): ${bytes} B`);
    expect(bytes).toBeLessThan(80 * 1024);
  });
});
