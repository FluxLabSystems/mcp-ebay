import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
// site-kijiji is imported by relative path rather than a workspace alias:
// tests/package.json is not modified by this change, so the package is not
// linked into tests/node_modules; tsc and vitest both resolve the
// TypeScript source directly through this path.
import {
  extractKijijiListing,
  extractSearchResults,
  KijijiExtractionRecordSchema,
} from '../../packages/site-kijiji/src/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'kijiji');

function loadFixture(name: string): Document {
  const html = readFileSync(join(FIXTURES, name), 'utf8');
  return parseHTML(html).document as unknown as Document;
}

/**
 * Defects a second live Kijiji run surfaced on 2026-08-29, every one of them
 * pinned against server HTML captured from the ads the run actually visited
 * (see the .json sidecar beside each fixture). The first fix pass shipped
 * against hand-built fixtures and the live DOM did not match them: the VIP
 * hooks are vip-price / vip-description-wrapper / r2s / vip-about-seller,
 * not the listing-* names that were guessed.
 */
const PRICED_URL = 'https://www.kijiji.ca/v-toy-game/city-of-toronto/lego/1740940278';
const CONTACT_URL = 'https://www.kijiji.ca/v-toy-game/city-of-toronto/lego/1730433251';
const SEARCH_URL = 'https://www.kijiji.ca/b-toys-games/city-of-toronto/lego/k0c108l1700273';

function pricedAd() {
  return extractKijijiListing(loadFixture('live-vip-priced-1740940278.html'), PRICED_URL, { pageRevision: 1 });
}

function contactAd() {
  return extractKijijiListing(loadFixture('live-vip-contact-1730433251.html'), CONTACT_URL, { pageRevision: 1 });
}

describe('defect 1 — a live ad is not a removed one', () => {
  it('calls a live priced ad active, not deleted or unknown', () => {
    // Price, description, gallery and a reply form are all rendered. The
    // only "no longer available" text on this page is in the inline i18n
    // bundle, which no reader ever sees.
    expect(pricedAd().record.listingStatus).toBe('active');
  });

  it('calls a live "Please Contact" ad active too', () => {
    expect(contactAd().record.listingStatus).toBe('active');
  });

  it('reports the ad id Kijiji redirected a removed ad away from', () => {
    // A removed ad does not render a banner: Kijiji 302s the VIP to its
    // category search page with ?adRemoved=<id>. That parameter is the
    // marker, and the page it lands on is a search page.
    const page = extractSearchResults(
      loadFixture('search-results.html'),
      'https://www.kijiji.ca/b-buy-sell/city-of-toronto/c10l1700273?radius=50.0&adRemoved=1740940277',
    );
    expect(page.removedAdId).toBe('1740940277');
  });

  it('leaves removedAdId null on an ordinary search page', () => {
    expect(extractSearchResults(loadFixture('live-search-lego-toronto.html'), SEARCH_URL).removedAdId).toBeNull();
  });
});

describe('defect 2 — location on the ad page', () => {
  it('reads the address the priced ad states in its JSON-LD offer', () => {
    const { record } = pricedAd();
    expect(record.location).toMatchObject({ text: 'Oakville, ON L6K 3R9', source: 'jsonld' });
  });

  it('still resolves a location when the ad ships no Product JSON-LD', () => {
    // 1730433251 renders "Thornhill, ON L4J 5M9" in its about-seller block.
    const { record } = contactAd();
    expect(record.location?.text).toContain('Thornhill');
    expect(record.location?.text).toContain('L4J 5M9');
  });
});

describe('defect 3 — posted time on search candidates', () => {
  it('reads the relative posted time the card renders', () => {
    const page = extractSearchResults(loadFixture('search-cards-hydrated.html'), SEARCH_URL, {
      observedAt: new Date('2026-08-29T12:00:00.000Z'),
    });
    expect(page.results.map((result) => result.postedText)).toEqual(['2 hrs ago', '1 day ago', '3 wks ago']);
  });

  it('resolves postedAt from the posted text when it is machine-parseable', () => {
    const page = extractSearchResults(loadFixture('search-cards-hydrated.html'), SEARCH_URL, {
      observedAt: new Date('2026-08-29T12:00:00.000Z'),
    });
    expect(page.results[0]?.postedAt).toBe('2026-08-29T10:00:00.000Z');
    expect(page.results[1]?.postedAt).toBe('2026-08-28T12:00:00.000Z');
    expect(page.results[2]?.postedAt).toBe('2026-08-08T12:00:00.000Z');
  });

  it('reads the time out of the details block when the node carries no name', () => {
    // Only the location half of the block is named; the posted time sits
    // beside it with nothing but its position to identify it.
    const document = loadFixture('search-cards-hydrated.html');
    for (const el of Array.from(document.querySelectorAll('[aria-label^="Published"]'))) {
      el.removeAttribute('aria-label');
    }
    const page = extractSearchResults(document, SEARCH_URL, {
      observedAt: new Date('2026-08-29T12:00:00.000Z'),
    });
    expect(page.results.map((result) => result.postedText)).toEqual(['2 hrs ago', '1 day ago', '3 wks ago']);
  });

  it('does not mistake a distance or a rating for a posted time', () => {
    // Some card layouts trail "< 21km" and a seller rating in that same
    // block; unnamed text has to read as a time to be taken as one.
    const document = loadFixture('search-cards-hydrated.html');
    for (const el of Array.from(document.querySelectorAll('[aria-label^="Published"]'))) {
      el.removeAttribute('aria-label');
      el.textContent = '< 21km • 5.0';
    }
    const page = extractSearchResults(document, SEARCH_URL, {
      observedAt: new Date('2026-08-29T12:00:00.000Z'),
    });
    expect(page.results.map((result) => result.postedText)).toEqual([null, null, null]);
  });

  it('falls back to the activation date the search page ships for each card', () => {
    // The posted time is hydrated client-side, so it is absent from server
    // HTML entirely; the same page still states every card's activation
    // date in its __NEXT_DATA__ cache.
    const page = extractSearchResults(loadFixture('live-search-lego-toronto.html'), SEARCH_URL);
    expect(page.results.filter((result) => result.postedAt !== null)).toHaveLength(page.results.length);
    expect(page.results[0]).toMatchObject({ adId: '1742668328', postedAt: '2026-08-28T12:35:55.000Z' });
  });
});

describe('defect 4 — pagination on a live search page', () => {
  it('reports the stated total and a next page for a 3,386-result search', () => {
    const page = extractSearchResults(loadFixture('live-search-lego-toronto.html'), SEARCH_URL);
    expect(page.results).toHaveLength(40);
    expect(page.totalResults).toBe(3386);
    expect(page.hasNextPage).toBe(true);
    expect(page.nextPageUrl).toContain('/page-2/');
  });

  it('reads the total off the page title when the hydration payload is gone', () => {
    // The count is stated twice on this page and neither place is a
    // rendered results-count element: <title> says "3,386 ads for lego",
    // __NEXT_DATA__ says pagination.totalCount. Either alone must do.
    const document = loadFixture('live-search-lego-toronto.html');
    document.querySelector('#__NEXT_DATA__')?.remove();
    const page = extractSearchResults(document, SEARCH_URL);
    expect(page.totalResults).toBe(3386);
    expect(page.hasNextPage).toBe(true);
  });

  it('does not claim a next page once the stated total has been seen', () => {
    const document = loadFixture('live-search-lego-toronto.html');
    document.querySelector('#__NEXT_DATA__')?.remove();
    const title = document.querySelector('title');
    if (title) title.textContent = '40 ads for lego in Toys & Games in City of Toronto | Kijiji Marketplaces';
    const page = extractSearchResults(document, SEARCH_URL);
    expect(page.totalResults).toBe(40);
    expect(page.hasNextPage).toBe(false);
    expect(page.nextPageUrl).toBeNull();
  });
});

describe('defect 5 — an ad whose price is not an amount', () => {
  it('resolves the contact price kind from the rendered price node', () => {
    const { record } = contactAd();
    expect(record.price).toMatchObject({ kind: 'contact', value: null, currency: 'CAD', source: 'dom' });
  });

  it('resolves the description even though no Product JSON-LD is served', () => {
    const { record } = contactAd();
    expect(record.description?.source).toBe('dom');
    expect(record.description?.value).toContain('Serious buyers');
  });

  it('resolves postedAt from the activation date the page states', () => {
    expect(contactAd().record.postedAt).toBe('2025-12-15T18:15:13.000Z');
  });

  it('counts the six distinct photos, not the ten gallery img nodes', () => {
    // The rendered gallery repeats photos as hero + thumbnail: this capture
    // holds 10 img elements over 6 distinct image UUIDs, and the page's own
    // hydration cache states exactly those 6 in StandardListing.imageUrls.
    // The old expectation of 10 pinned the double-count as if it were fact.
    expect(contactAd().record.imageCount).toBe(6);
  });

  it('counts past the four-image cap of the schema.org block on the priced ad', () => {
    // 1740940278 states 4 images in JSON-LD and 7 in its hydration cache;
    // the 2026-08-30 connector test caught the same cap on a 6-photo ad
    // that reported imageCount 4.
    expect(pricedAd().record.imageCount).toBe(7);
  });
});

describe('live records still satisfy the canonical schema', () => {
  it('validates both live ad records unchanged', () => {
    expect(KijijiExtractionRecordSchema.safeParse(pricedAd().record).success).toBe(true);
    expect(KijijiExtractionRecordSchema.safeParse(contactAd().record).success).toBe(true);
  });
});

/**
 * Two defects the live captures surfaced that were outside the reported
 * list. Both affect every Kijiji ad, and both were stored rather than
 * warned about, so nothing downstream could tell the value was wrong.
 */
describe('kijiji seller identity (live captures)', () => {
  it('stores the seller name, not the profile link label', () => {
    // The profile anchor is labelled "View Jessica's profile" and that label
    // is read before the anchor's text, which is only the avatar monogram.
    // Reading it verbatim put a sentence in a field the Deals dashboard
    // renders as a seller.
    expect(pricedAd().record.sellerName?.value).toBe('Jessica');
    expect(contactAd().record.sellerName?.value).toBe('Inna');
  });

  it('resolves sellerType from the about-seller block', () => {
    // The VIP never populates the attribute list sellerType was derived
    // from, so every ad answered 'unknown' while the page plainly rendered
    // "Owner" a few nodes away.
    expect(pricedAd().record.sellerType).toBe('owner');
    expect(contactAd().record.sellerType).toBe('owner');
  });

  it('leaves a name that is not a profile-link label untouched', () => {
    // The unwrap keys on Kijiji's own wording; anything else passes through,
    // so a seller genuinely called "View Ridge Salvage" keeps its name.
    const { document } = parseHTML(
      '<html><body><a href="/o-profile/1/1" aria-label="View Ridge Salvage">x</a></body></html>',
    );
    const { record } = extractKijijiListing(document as unknown as Document, PRICED_URL, { pageRevision: 1 });
    expect(record.sellerName?.value).toBe('View Ridge Salvage');
  });
});
