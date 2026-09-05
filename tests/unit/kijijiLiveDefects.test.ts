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
  buildSellerListingsUrl,
  classifyKijijiPage,
  extractKijijiListing,
  extractSearchResults,
  KijijiExtractionRecordSchema,
  nextKijijiSellerPageUrl,
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

  // B1 (2026-09-02 deals fire): search records carried no pageTitle, yet the
  // deals and office SKILLs make the rendered page title the sole accepted
  // proof of which region an l<regionId> path segment scopes.
  it('carries the rendered document title as pageTitle (B1)', () => {
    const page = extractSearchResults(loadFixture('live-search-lego-toronto.html'), SEARCH_URL);
    expect(page.pageTitle).toBe('3,386 ads for lego in Toys & Games in City of Toronto | Kijiji Marketplaces');
  });

  it('reports pageTitle null when the page carries no title', () => {
    const document = parseHTML('<html><body><div data-testid="listing-card"></div></body></html>').document as unknown as Document;
    const page = extractSearchResults(document, SEARCH_URL);
    expect(page.pageTitle).toBeNull();
  });

  // 2026-09-03 office fire (site-kijiji+extractor_defect+vip-sellername-
  // unresolved-on-mls-syndicated-ads): 7 of 12 commercial ads answered
  // sellerName null with the generic "could not be resolved" warning, and
  // every one of them carried MLS-syndicated body copy (an "(id:24493)
  // MLS# …" tail) or operator copy, while the 5 private advertisers in the
  // same batch resolved. No syndicated VIP is captured, so whether such an
  // ad renders a poster under another element cannot be pinned here; what
  // CAN be said from the page is that the ad is a brokerage syndication, so
  // a run can tell "no poster shown on a syndicated ad" from "selector
  // missed" without a per-listing judgement call.
  describe('a syndicated (MLS) ad with no resolvable seller says so (2026-09-03)', () => {
    const OFFICE_URL = 'https://www.kijiji.ca/v-commercial-office-space/mississauga-peel-region/2c07-7215-goreway-drive/1740058167';
    it('names the syndication instead of the generic resolution failure', () => {
      const { document } = parseHTML(
        `<html><body>
           <h1>7215 Goreway Drive, Mississauga — office unit 2C07</h1>
           <div data-testid="vip-description-wrapper">Bright second-floor office in Malton. Ample parking. Available immediately.
             (id:24493) MLS# W9312345</div>
         </body></html>`,
      );
      const { record, warnings } = extractKijijiListing(document as unknown as Document, OFFICE_URL, { pageRevision: 1 });
      expect(record.sellerName).toBeNull();
      expect(warnings.some((w) => w.startsWith('SELLER_UNRESOLVED_SYNDICATED') && w.includes('MLS# W9312345'))).toBe(true);
      expect(warnings).not.toContain('sellerName could not be resolved');
    });

    it('keeps the generic warning on an unsyndicated ad with no seller', () => {
      const { document } = parseHTML(
        `<html><body><h1>Desk for rent</h1>
           <div data-testid="vip-description-wrapper">One desk in a shared office, month to month.</div>
         </body></html>`,
      );
      const { record, warnings } = extractKijijiListing(document as unknown as Document, OFFICE_URL, { pageRevision: 1 });
      expect(record.sellerName).toBeNull();
      expect(warnings).toContain('sellerName could not be resolved');
      expect(warnings.some((w) => w.startsWith('SELLER_UNRESOLVED_SYNDICATED'))).toBe(false);
    });

    it('does not mention syndication when the seller resolved', () => {
      const { document } = parseHTML(
        `<html><body><h1>Office</h1>
           <a href="/o-profile/55/1" aria-label="View Royal LePage Signature's profile">R</a>
           <div data-testid="vip-description-wrapper">Great unit. (id:24493) MLS# W9312345</div>
         </body></html>`,
      );
      const { record, warnings } = extractKijijiListing(document as unknown as Document, OFFICE_URL, { pageRevision: 1 });
      expect(record.sellerName?.value).toBe('Royal LePage Signature');
      expect(warnings.some((w) => w.startsWith('SELLER_UNRESOLVED_SYNDICATED'))).toBe(false);
    });
  });

});

/**
 * 2026-09-02 deals fire (site-kijiji+coverage_gap+kijiji-no-seller-
 * inventory-surface): a new Kijiji trader was found through one good ad and
 * the mandatory same-run seller drill-down could not be performed — the ad
 * record carried a sellerName but no seller id, profile URL or other-ads
 * link. Both live captures render exactly that link: an anchor to
 * /o-profile/<posterId>/1 labelled "View all listings (N)", and the
 * hydration cache states posterInfo.posterId for the ad.
 */
describe('kijiji seller listings surface (live captures)', () => {
  it('carries the poster id, the "View all listings" URL and its stated count on a priced ad', () => {
    const { record } = pricedAd();
    expect(record.sellerId).toMatchObject({ value: '81273541', source: 'dom' });
    expect(record.sellerListingsUrl).toMatchObject({
      value: 'https://www.kijiji.ca/o-profile/81273541/1',
      source: 'dom',
    });
    expect(record.sellerListingCount).toBe(1);
  });

  it('reads a three-digit listing count on the contact-price ad', () => {
    const { record } = contactAd();
    expect(record.sellerId?.value).toBe('1008009261');
    expect(record.sellerListingsUrl?.value).toBe('https://www.kijiji.ca/o-profile/1008009261/1');
    expect(record.sellerListingCount).toBe(219);
  });

  it('answers null for all three on a page that renders no profile link', () => {
    const { document } = parseHTML('<html><body><h1>LEGO lot</h1><p data-testid="vip-price">$5</p></body></html>');
    const { record } = extractKijijiListing(document as unknown as Document, PRICED_URL, { pageRevision: 1 });
    expect(record.sellerId).toBeNull();
    expect(record.sellerListingsUrl).toBeNull();
    expect(record.sellerListingCount).toBeNull();
    expect(KijijiExtractionRecordSchema.safeParse(record).success).toBe(true);
  });

  it('classifies /o-profile/<id>/<page> as a seller page and pages it by the trailing number', () => {
    expect(classifyKijijiPage('https://www.kijiji.ca/o-profile/81273541/1')).toBe('seller');
    expect(classifyKijijiPage('https://www.kijiji.ca/o-profile/81273541')).toBe('seller');
    expect(buildSellerListingsUrl('1008009261')).toBe('https://www.kijiji.ca/o-profile/1008009261/1');
    expect(buildSellerListingsUrl('1008009261', 3)).toBe('https://www.kijiji.ca/o-profile/1008009261/3');
    expect(nextKijijiSellerPageUrl('https://www.kijiji.ca/o-profile/1008009261/1')).toBe(
      'https://www.kijiji.ca/o-profile/1008009261/2',
    );
    expect(nextKijijiSellerPageUrl('https://www.kijiji.ca/o-profile/1008009261')).toBe(
      'https://www.kijiji.ca/o-profile/1008009261/2',
    );
    expect(nextKijijiSellerPageUrl('https://www.kijiji.ca/b-buy-sell/city-of-toronto/lego/c10l1700273')).toBeNull();
  });

  // 2026-09-04 20:00Z deals fire: the site redirected /o-profile/1046282996/1
  // to /o-profile/1046282996/listings/1 — the page the tab ends on is the one
  // the next-page URL is derived from, so the redirect form pages too.
  it('pages the post-redirect /o-profile/<id>/listings/<n> form and classifies it as a seller page', () => {
    expect(classifyKijijiPage('https://www.kijiji.ca/o-profile/1046282996/listings/1')).toBe('seller');
    expect(nextKijijiSellerPageUrl('https://www.kijiji.ca/o-profile/1046282996/listings/1')).toBe(
      'https://www.kijiji.ca/o-profile/1046282996/listings/2',
    );
    expect(nextKijijiSellerPageUrl('https://www.kijiji.ca/o-profile/1046282996/listings/')).toBe(
      'https://www.kijiji.ca/o-profile/1046282996/listings/2',
    );
  });

  it('a seller page runs the ad-link scan and names itself a seller page', () => {
    // No live /o-profile/ capture exists; the scan is anchor-href based, so
    // the search capture stands in for the markup shape it does not depend on.
    const page = extractSearchResults(
      loadFixture('live-search-lego-toronto.html'),
      'https://www.kijiji.ca/o-profile/1008009261/1',
    );
    expect(page.results.length).toBeGreaterThan(0);
    expect(page.nextPageUrl === null || page.nextPageUrl.startsWith('https://www.kijiji.ca/o-profile/1008009261/')).toBe(true);
  });
});

/**
 * 2026-09-03 deals fire (site-kijiji+extractor_defect+search-card-price-
 * differs-from-ad-page-price): four ads whose search cards read C$1.50,
 * C$1.50, C$1.50 and C$7.50 came back C$1.00, C$1.00, C$1.00 and C$7.00 from
 * their ad pages, fetched within two minutes of the cards. Every one lost
 * exactly its cents. The ad page's JSON-LD carries offers.price as a
 * whole-number string ("35" on the live 1740940278 capture, whose hydration
 * cache states amount 3500 in cents), and the extractor took JSON-LD first
 * — so a fractional price arrives truncated while the page itself states
 * the exact amount a few kilobytes away. The cache's amount is the value
 * the search card rendered ($2.50 for amount 250 on the live search
 * capture).
 */
describe('kijiji ad price against the page\'s own stated amount', () => {
  function vipWithPrices(jsonldPrice: string, cacheAmountCents: number | null, rendered: string): Document {
    const cache =
      cacheAmountCents === null
        ? '{}'
        : JSON.stringify({
            props: {
              pageProps: {
                __APOLLO_STATE__: {
                  'StandardListing:1740940278': {
                    __typename: 'StandardListing',
                    price: { __typename: 'StandardAmountPrice', type: 'FIXED', amount: cacheAmountCents, currency: 'CAD', originalAmount: null },
                  },
                },
              },
            },
          });
    const html = `<html><head>
      <link rel="canonical" href="${PRICED_URL}">
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'Lego minifigure',
        offers: { '@type': 'Offer', price: jsonldPrice, priceCurrency: 'CAD' },
      })}</script>
      <script id="__NEXT_DATA__" type="application/json">${cache}</script>
      </head><body><h1>Lego minifigure</h1><p data-testid="vip-price">${rendered}</p></body></html>`;
    return parseHTML(html).document as unknown as Document;
  }

  it('records the exact cents the page states when JSON-LD carries a truncated whole number', () => {
    const { record, warnings } = extractKijijiListing(vipWithPrices('1', 150, '$1.50'), PRICED_URL, { pageRevision: 1 });
    expect(record.price).toMatchObject({ kind: 'amount', value: 1.5, currency: 'CAD' });
    expect(record.price?.source).not.toBe('jsonld');
    expect(warnings.some((warning) => warning.startsWith('PRICE_JSONLD_TRUNCATED') && warning.includes('1.50'))).toBe(true);
  });

  it('keeps JSON-LD provenance when it agrees with the stated amount', () => {
    const { record, warnings } = extractKijijiListing(vipWithPrices('35', 3500, '$35'), PRICED_URL, { pageRevision: 1 });
    expect(record.price).toMatchObject({ kind: 'amount', value: 35, source: 'jsonld' });
    expect(warnings.some((warning) => warning.startsWith('PRICE_JSONLD_TRUNCATED'))).toBe(false);
  });

  it('keeps JSON-LD when the page states no amount for the ad', () => {
    const { record } = extractKijijiListing(vipWithPrices('7', null, '$7.50'), PRICED_URL, { pageRevision: 1 });
    expect(record.price).toMatchObject({ kind: 'amount', value: 7, source: 'jsonld' });
  });

  it('the live priced capture is unchanged: JSON-LD "35" and amount 3500 agree', () => {
    const { record, warnings } = pricedAd();
    expect(record.price).toMatchObject({ kind: 'amount', value: 35, source: 'jsonld' });
    expect(warnings.some((warning) => warning.startsWith('PRICE_JSONLD_TRUNCATED'))).toBe(false);
  });
});
