import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
// Relative import; see kijijiExtract.test.ts for the tests/package.json rationale.
import {
  extractKijijiListing,
  extractSearchResults,
  KijijiExtractionRecordSchema,
} from '../../packages/site-kijiji/src/index.js';
import { compactKijijiAd } from '@browser-bridge/compact';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'kijiji');

function loadFixture(name: string): Document {
  const html = readFileSync(join(FIXTURES, name), 'utf8');
  return parseHTML(html).document as unknown as Document;
}

function adPage(options: { price: string; body: string; location?: string; id?: string }): Document {
  const id = options.id ?? '1720698002';
  const location = options.location ?? 'Toronto, ON M6H 2W9';
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Server rack / data rack cabinet',
    description: options.body,
    offers: {
      '@type': 'Offer',
      price: options.price,
      priceCurrency: 'CAD',
      availableAtOrFrom: { '@type': 'Place', address: { '@type': 'PostalAddress', streetAddress: location } },
      seller: { '@type': 'Person', name: 'rackmover_to' },
    },
  };
  const priceNode = /^\d/.test(options.price)
    ? `<div data-testid="vip-price">$${options.price}</div>`
    : `<div data-testid="vip-price">${options.price}</div>`;
  const { document } = parseHTML(
    `<html><head><link rel="canonical" href="https://www.kijiji.ca/v-other-computer-products/city-of-toronto/server-rack-data-rack-cabinet/${id}">
       <script type="application/ld+json">${JSON.stringify(jsonld)}</script></head>
       <body><h1>Server rack / data rack cabinet</h1>${priceNode}
       <div data-testid="vip-description-wrapper">${options.body}</div></body></html>`,
  );
  return document as unknown as Document;
}

const AD_URL = 'https://www.kijiji.ca/v-other-computer-products/city-of-toronto/server-rack-data-rack-cabinet/1720698002';

// 2026-09-09 04:42Z deals fire (site-kijiji+extractor_defect+search-card-price-
// is-not-the-ad-price-on-multi-item-and-contact-price-ads): six ads whose
// card/page price was not the price of the thing for sale — a condition
// ladder ("Brand new $800 Slightly Used-like new $600" against a C$250 card),
// a per-item list, an OBO figure, or a "Please Contact" card over a body
// that says "will sell for $350" — and nothing on the record said so. The
// record now lists every amount the body states, in document order, and
// names the disagreement; the listed price is never rewritten from prose.
describe('the amounts an ad body states beside the listed price (2026-09-09)', () => {
  it('lists the body\'s figures in document order and names a listed price the body contradicts', () => {
    const { record, warnings } = extractKijijiListing(
      adPage({ price: '250', body: 'Server rack in good shape. Brand new $800 Slightly Used-like new $600. Pickup only.' }),
      AD_URL,
      { pageRevision: 1 },
    );
    expect(KijijiExtractionRecordSchema.safeParse(record).success).toBe(true);
    expect(record.price).toMatchObject({ kind: 'amount', value: 250 });
    expect(record.bodyPriceFigures).toEqual([800, 600]);
    const differ = warnings.find((w) => w.startsWith('BODY_PRICES_DIFFER_FROM_LISTED'));
    expect(differ).toBeDefined();
    expect(differ).toContain('C$250');
    expect(differ).toContain('800');
    expect(differ).toContain('600');
    expect(differ).toMatch(/not dispositive/);
    expect(warnings.some((w) => w.startsWith('PRICE_STATED_IN_BODY_ONLY'))).toBe(false);
  });

  it('handles the per-item list, the OBO tail and thousands separators', () => {
    const { record, warnings } = extractKijijiListing(
      adPage({
        price: '199',
        body: '1. $199 Cisco AP1815i-B-K9C 2. $199 Cisco AIR-AP3802I-B-K9 2. $599 Cisco Catalyst 9130AXI-B with box, or $1,500 OBO for the lot',
        id: '1681979129',
      }),
      'https://www.kijiji.ca/v-computer-networking/city-of-toronto/cisco-access-points/1681979129',
      { pageRevision: 1 },
    );
    expect(record.bodyPriceFigures).toEqual([199, 199, 599, 1500]);
    expect(warnings.find((w) => w.startsWith('BODY_PRICES_DIFFER_FROM_LISTED'))).toContain('599');
  });

  it('is silent when the body only restates the listed price, and skips shipping figures', () => {
    const { record, warnings } = extractKijijiListing(
      adPage({ price: '140', body: 'Asking $140 firm. $20 shipping within the GTA or free pickup.' }),
      AD_URL,
      { pageRevision: 1 },
    );
    expect(record.bodyPriceFigures).toEqual([140]);
    expect(warnings.some((w) => w.startsWith('BODY_PRICES_DIFFER_FROM_LISTED'))).toBe(false);
    expect(warnings.some((w) => w.startsWith('PRICE_STATED_IN_BODY_ONLY'))).toBe(false);
  });

  it('names a "Please Contact" ad whose body prices the lot (live capture 1730433251)', () => {
    const { record, warnings } = extractKijijiListing(
      loadFixture('live-vip-contact-1730433251.html'),
      'https://www.kijiji.ca/v-toy-game/city-of-toronto/lego/1730433251',
      { pageRevision: 1 },
    );
    expect(record.price?.kind).toBe('contact');
    expect(record.bodyPriceFigures).toEqual([100, 80, 30]);
    const only = warnings.find((w) => w.startsWith('PRICE_STATED_IN_BODY_ONLY'));
    expect(only).toBeDefined();
    expect(only).toContain('100');
    expect(only).toMatch(/never drop/i);
    expect(warnings.some((w) => w.startsWith('BODY_PRICES_DIFFER_FROM_LISTED'))).toBe(false);
  });

  it('carries an empty list and no warning on a body that names no amount, and the compact projection keeps the field', () => {
    const { record, warnings } = extractKijijiListing(
      adPage({ price: '35', body: 'Lego lot from a cleanout, pickup in the west end.' }),
      AD_URL,
      { pageRevision: 1 },
    );
    expect(record.bodyPriceFigures).toEqual([]);
    expect(warnings.some((w) => /^(BODY_PRICES_DIFFER_FROM_LISTED|PRICE_STATED_IN_BODY_ONLY)/.test(w))).toBe(false);
    expect(compactKijijiAd(record).bodyPriceFigures).toEqual([]);
  });

  it('bounds the list at 24 figures', () => {
    const body = Array.from({ length: 40 }, (_, i) => `item ${i + 1} $${i + 1}`).join(', ');
    const { record } = extractKijijiListing(adPage({ price: '35', body }), AD_URL, { pageRevision: 1 });
    expect(record.bodyPriceFigures).toHaveLength(24);
    expect(KijijiExtractionRecordSchema.safeParse(record).success).toBe(true);
  });
});

// Same fire, the search half: a card carrying "Please Contact" reads
// price.kind 'contact' with value null, and a routine filtering on the card
// figure silently dropped the strongest LEGO buy of the fire (1740461192,
// "will sell for $350" in prose). The search record now counts those rows.
describe('search cards that state no amount are counted at page level', () => {
  it('SEARCH_CONTACT_PRICE_ROWS names the contact-priced rows of the live capture', () => {
    const page = extractSearchResults(
      loadFixture('live-search-lego-toronto.html'),
      'https://www.kijiji.ca/b-toys-games/city-of-toronto/lego/k0c108l1700273',
    );
    const contact = page.results.filter((r) => r.price?.kind === 'contact');
    expect(contact.length).toBeGreaterThan(0);
    const warning = page.warnings.find((w) => w.startsWith('SEARCH_CONTACT_PRICE_ROWS'));
    expect(warning).toBeDefined();
    expect(warning).toContain(`${contact.length} of ${page.results.length}`);
    expect(warning).toContain(contact[0]!.adId);
    expect(warning).toMatch(/null, not zero/);
  });

  it('is silent on a page whose cards all state an amount', () => {
    const page = extractSearchResults(
      loadFixture('search-results-count-only.html'),
      'https://www.kijiji.ca/b-toys-games/city-of-toronto/lego/k0c108l1700273',
    );
    expect(page.results.every((r) => r.price?.kind !== 'contact')).toBe(true);
    expect(page.warnings.some((w) => w.startsWith('SEARCH_CONTACT_PRICE_ROWS'))).toBe(false);
  });
});

// 2026-09-09 04:42Z deals fire (site-kijiji+extractor_defect+sellername-null-
// while-sellerid-resolves): three ads warned "sellerName could not be
// resolved" beside a populated sellerId, sellerListingsUrl and
// sellerListingCount. The hydration payload the id comes from carries no
// name (live posterInfo: posterId, sellerType, websiteUrl, phoneNumber,
// verified), so the warning now says where the name IS — the profile page —
// and what to key on until then.
describe('a seller with an id but no name says where the name is (2026-09-09)', () => {
  it('names the id and the profile page instead of the bare resolution failure', () => {
    const { document } = parseHTML(
      `<html><body><h1>Lego bulk lot</h1><div data-testid="vip-price">$45.00</div>
         <div data-testid="vip-description-wrapper">Mixed bricks from a cleanout.</div>
         <a href="/o-profile/1046282996/1">View all listings (12)</a></body></html>`,
    );
    const { record, warnings } = extractKijijiListing(
      document as unknown as Document,
      'https://www.kijiji.ca/v-toy-game/city-of-toronto/lego-bulk-lot/1743164051',
      { pageRevision: 1 },
    );
    expect(record.sellerName).toBeNull();
    expect(record.sellerId?.value).toBe('1046282996');
    const warning = warnings.find((w) => w.startsWith('SELLER_NAME_UNRESOLVED_ID_KNOWN'));
    expect(warning).toBeDefined();
    expect(warning).toContain('1046282996');
    expect(warning).toContain('https://www.kijiji.ca/o-profile/1046282996/1');
    expect(warnings).not.toContain('sellerName could not be resolved');
  });

  it('keeps the generic warning when neither the name nor the id resolved', () => {
    const { document } = parseHTML(
      `<html><body><h1>Lego bulk lot</h1><div data-testid="vip-description-wrapper">Mixed bricks.</div></body></html>`,
    );
    const { warnings } = extractKijijiListing(
      document as unknown as Document,
      'https://www.kijiji.ca/v-toy-game/city-of-toronto/lego-bulk-lot/1743164052',
      { pageRevision: 1 },
    );
    expect(warnings).toContain('sellerName could not be resolved');
    expect(warnings.some((w) => w.startsWith('SELLER_NAME_UNRESOLVED_ID_KNOWN'))).toBe(false);
  });
});

// 2026-09-09 04:42Z deals fire (site-kijiji+extractor_defect+ad-location-
// field-contradicts-location-stated-in-body): record.location read
// "Toronto, ON, L1T" — an Ajax forward sortation area under a Toronto
// label — while the body read "Located in Laval". Canada Post reserves the
// M prefix for Toronto, so a non-M FSA beside the word Toronto is a
// contradiction the page itself carries; a body sentence naming a place is
// quoted beside the field. The location field is never rewritten.
describe('a location the page contradicts is named, never rewritten (2026-09-09)', () => {
  it('flags a Toronto label carrying a non-M forward sortation area', () => {
    const { record, warnings } = extractKijijiListing(
      adPage({ price: '1500', body: 'Located in Laval - our office is closing down. Two cabinets available.', location: 'Toronto, ON, L1T', id: '1742998610' }),
      'https://www.kijiji.ca/v-other-computer-products/city-of-toronto/server-cabinets/1742998610',
      { pageRevision: 1 },
    );
    expect(record.location?.text).toBe('Toronto, ON, L1T');
    const fsa = warnings.find((w) => w.startsWith('LOCATION_FSA_OUTSIDE_NAMED_CITY'));
    expect(fsa).toBeDefined();
    expect(fsa).toContain('L1T');
    expect(fsa).toMatch(/\bM\b/);
    const body = warnings.find((w) => w.startsWith('LOCATION_BODY_NAMES_PLACE'));
    expect(body).toBeDefined();
    expect(body).toContain('Located in Laval');
    expect(body).toContain('Toronto, ON, L1T');
  });

  it('is silent on a Toronto address with an M postal code and a body naming no other place', () => {
    const { warnings } = extractKijijiListing(
      adPage({ price: '35', body: 'Pickup in Toronto near Dufferin and Bloor.', location: 'Toronto, ON M6H 2W9' }),
      AD_URL,
      { pageRevision: 1 },
    );
    expect(warnings.some((w) => /^LOCATION_(FSA_OUTSIDE_NAMED_CITY|BODY_NAMES_PLACE)/.test(w))).toBe(false);
  });

  it('does not apply the M rule to a city other than Toronto', () => {
    const { warnings } = extractKijijiListing(
      adPage({ price: '35', body: 'Cash and pick up only.', location: 'Oakville, ON L6K 3R9' }),
      AD_URL,
      { pageRevision: 1 },
    );
    expect(warnings.some((w) => w.startsWith('LOCATION_FSA_OUTSIDE_NAMED_CITY'))).toBe(false);
  });
});
