import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
// Relative import; see kijijiExtract.test.ts for the tests/package.json rationale.
import { extractKijijiListing, KijijiExtractionRecordSchema } from '../../packages/site-kijiji/src/index.js';

/**
 * 2026-09-14 00:0xZ office fire (mcp-ebay+extractor_defect+seller-name-
 * unresolved-warning-prescribes-reading-the-name-at-sellerlistingsurl-which-
 * is-null-on-the-same-record): four of five ads in one browser_extract_many
 * batch resolved sellerId from the hydration cache (1045747118, 1045747122,
 * 1045747232, 6386559) but rendered no /o-profile/ anchor, so
 * sellerListingsUrl and sellerListingCount came back null — while the
 * SELLER_NAME_UNRESOLVED_ID_KNOWN warning on the same record told the caller
 * to read the name "from the profile page at sellerListingsUrl". The fifth ad
 * in the batch carried the anchor and all three fields.
 *
 * The profile URL is a deterministic function of the poster id (the same
 * /o-profile/<posterId>/1 the populated slot returned), so a record that
 * resolves the id now carries the URL it can be built from, marked as
 * computed rather than read off the page. The listing count genuinely is
 * unknown without the anchor and stays null.
 */
const AD_ID = '1726355545';
const AD_URL = `https://www.kijiji.ca/v-commercial-office-space/city-of-toronto/dedicated-office-for-rent-regus-keele-street-in-vaughan/${AD_ID}`;
const POSTER_ID = '1045747118';

function adWithPosterIdAndNoProfileAnchor(): Document {
  const nextData = {
    props: {
      pageProps: {
        __APOLLO_STATE__: {
          [`StandardListing:${AD_ID}`]: {
            __typename: 'StandardListing',
            id: AD_ID,
            posterInfo: { posterId: POSTER_ID, sellerType: 'PROFESSIONAL', websiteUrl: null, phoneNumber: null, verified: false },
          },
        },
      },
    },
  };
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Dedicated Office for Rent - Regus Keele Street',
    description: 'A fully serviced private office, ready to use from day one. Office sizes and pricing are subject to availability.',
    offers: { '@type': 'Offer', price: '399', priceCurrency: 'CAD' },
  };
  const { document } = parseHTML(
    `<html><head><link rel="canonical" href="${AD_URL}">
       <script type="application/ld+json">${JSON.stringify(jsonld)}</script>
       <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></head>
       <body><h1>Dedicated Office for Rent - Regus Keele Street</h1><div data-testid="vip-price">$399</div>
       <div data-testid="vip-description-wrapper">${jsonld.description}</div></body></html>`,
  );
  return document as unknown as Document;
}

describe('kijiji seller listings URL when the poster id resolves but no profile anchor renders (2026-09-14)', () => {
  it('builds sellerListingsUrl from the poster id, marks it computed, and leaves the count null', () => {
    const { record, warnings } = extractKijijiListing(adWithPosterIdAndNoProfileAnchor(), AD_URL, { pageRevision: 1 });
    expect(KijijiExtractionRecordSchema.safeParse(record).success).toBe(true);
    expect(record.sellerName).toBeNull();
    expect(record.sellerId).toMatchObject({ value: POSTER_ID, source: 'dom' });
    expect(record.sellerListingsUrl).toMatchObject({
      value: `https://www.kijiji.ca/o-profile/${POSTER_ID}/1`,
      source: 'computed',
    });
    // A URL the page rendered scores higher than one built from the id.
    expect(record.sellerListingsUrl?.confidence).toBeLessThan(0.9);
    expect(record.sellerListingCount).toBeNull();

    const warning = warnings.find((w) => w.startsWith('SELLER_NAME_UNRESOLVED_ID_KNOWN'));
    expect(warning).toBeDefined();
    // The remedy the warning prescribes is reachable on the same record, and
    // the warning says the URL was built rather than read.
    expect(warning).toContain(`sellerListingsUrl https://www.kijiji.ca/o-profile/${POSTER_ID}/1`);
    expect(warning).toMatch(/built from the poster id/);
  });

  it('still prefers the rendered anchor and its count when the page carries one', () => {
    const doc = adWithPosterIdAndNoProfileAnchor();
    const anchor = doc.createElement('a');
    anchor.setAttribute('href', `/o-profile/${POSTER_ID}/1`);
    anchor.textContent = 'View all listings (7)';
    doc.body.appendChild(anchor);
    const { record, warnings } = extractKijijiListing(doc, AD_URL, { pageRevision: 1 });
    expect(record.sellerListingsUrl).toMatchObject({
      value: `https://www.kijiji.ca/o-profile/${POSTER_ID}/1`,
      source: 'dom',
      confidence: 0.97,
    });
    expect(record.sellerListingCount).toBe(7);
    const warning = warnings.find((w) => w.startsWith('SELLER_NAME_UNRESOLVED_ID_KNOWN'));
    expect(warning).toBeDefined();
    expect(warning).not.toMatch(/built from the poster id/);
  });

  it('answers null for the URL when neither the cache nor the page names a poster', () => {
    const { document } = parseHTML('<html><body><h1>LEGO lot</h1><p data-testid="vip-price">$5</p></body></html>');
    const { record } = extractKijijiListing(document as unknown as Document, AD_URL, { pageRevision: 1 });
    expect(record.sellerId).toBeNull();
    expect(record.sellerListingsUrl).toBeNull();
    expect(record.sellerListingCount).toBeNull();
  });
});
