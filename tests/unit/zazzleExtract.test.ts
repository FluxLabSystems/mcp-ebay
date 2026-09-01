/**
 * zazzle.com.v1 extraction against fixtures whose markup mirrors live
 * zazzle.com captures (2026-08-31). The spec P1 rules under test:
 * listed-currency-untouched, the priceBasis fail-safe, stated-only discount
 * and promo-expiry, the canonical-link trap, and full-shape candidates.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import {
  classifyZazzlePage,
  extractZazzleProduct,
  extractZazzleSearchResults,
  parseZazzleMoney,
  productIdFromUrl,
  ZazzleProductRecordSchema,
} from '@browser-bridge/site-zazzle';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'zazzle');

function doc(name: string): Document {
  const { document } = parseHTML(readFileSync(join(FIXTURES, name), 'utf8'));
  return document as unknown as Document;
}

const PERSONALIZABLE_URL = 'https://www.zazzle.com/i_heart_name_t_shirt-235985008319788440?tracking=zzz';
const FIXED_URL = 'https://www.zazzle.com/wifey_modern_black_script_white_womens_t_shirt-235617449988665742';

describe('classifyZazzlePage', () => {
  it('classifies product, search, and other URLs', () => {
    expect(classifyZazzlePage(PERSONALIZABLE_URL)).toBe('product');
    expect(classifyZazzlePage('https://www.zazzle.com/s/custom+name+t+shirt')).toBe('search');
    expect(classifyZazzlePage('https://www.zazzle.com/c/tshirts')).toBe('search');
    expect(classifyZazzlePage('https://www.zazzle.com/')).toBe('other');
  });

  it('reads 18-digit product ids from URLs', () => {
    expect(productIdFromUrl(PERSONALIZABLE_URL)).toBe('235985008319788440');
    expect(productIdFromUrl('https://www.zazzle.com/c/tshirts')).toBeNull();
  });
});

describe('extractZazzleProduct — personalizable template product', () => {
  const { record, warnings } = extractZazzleProduct(doc('product-personalizable.html'), PERSONALIZABLE_URL, {
    pageRevision: 3,
  });

  it('validates against the record schema', () => {
    expect(() => ZazzleProductRecordSchema.parse(record)).not.toThrow();
  });

  it('resolves identity from JSON-LD/og and never from link[rel=canonical]', () => {
    expect(record.productId?.value).toBe('235985008319788440');
    // The fixture's canonical link points at …-235000000000000099 (a style
    // sibling); the record must carry the og:url product instead.
    expect(record.canonicalUrl?.value).toBe(
      'https://www.zazzle.com/i_heart_name_t_shirt-235985008319788440',
    );
    expect(record.title?.value).toBe('I Heart Name T-Shirt');
    expect(record.title?.source).toBe('jsonld');
    expect(record.vendor?.value).toBe('Classic Tees Studio');
  });

  it('emits the listed currency untouched and the stated original price', () => {
    expect(record.listedPrice).toMatchObject({ value: 21.92, currency: 'USD', source: 'jsonld' });
    expect(record.originalPrice).toMatchObject({ value: 24.35, currency: 'USD', source: 'meta' });
  });

  it('resolves the C4 discriminators from stated evidence', () => {
    expect(record.priceBasis).toBe('personalized');
    expect(record.personalizationOffered).toBe(true);
    expect(record.personalizationMethod).toBe('template');
    // Not stated by the page → explicit null, never a guess (C7).
    expect(record.personalizationIncludedInPrice).toBeNull();
    expect(record.priceQuantityTier).toBe(1);
    expect(record.perUnitLabelText).toBe('per shirt');
    expect(record.moq1Supported).toBe(true);
    expect(record.moq).toBe(1);
  });

  it('takes discount and promo expiry from statements, not arithmetic', () => {
    expect(record.discountPct).toBe(10);
    expect(record.promoExpires).toBe('2026-09-02T22:59:00-08:00');
  });

  it('keeps unstated money fields as explicit nulls', () => {
    expect(record.setupFee).toBeNull();
    expect(record.shipping).toBeNull();
    expect(record.shipsToCanada).toBeNull();
    expect(record.shippingEstimateText).toContain('Sep 4');
  });

  it('reports an active listing with ratings and no spurious warnings', () => {
    expect(record.listingStatus).toBe('active');
    expect(record.ratingValue).toBe(4.7);
    expect(record.ratingCount).toBe(128);
    expect(record.pageRevision).toBe(3);
    expect(warnings).toEqual([]);
  });
});

describe('extractZazzleProduct — fixed design (no personalization affordance)', () => {
  const { record, warnings } = extractZazzleProduct(doc('product-fixed-design.html'), FIXED_URL, {});

  it('fails safe to priceBasis unknown with a warning', () => {
    expect(record.priceBasis).toBe('unknown');
    expect(record.personalizationOffered).toBe(false);
    expect(record.personalizationMethod).toBeNull();
    expect(warnings.some((warning) => warning.startsWith('PRICE_BASIS_UNKNOWN'))).toBe(true);
  });

  it('still extracts the listed price faithfully', () => {
    expect(record.listedPrice).toMatchObject({ value: 19.31, currency: 'USD' });
    expect(record.originalPrice?.value).toBe(21.45);
    expect(record.listingStatus).toBe('active');
  });
});

describe('extractZazzleProduct — gone product', () => {
  it('reports listingStatus unavailable (feeds LISTING_UNAVAILABLE slots)', () => {
    const { record } = extractZazzleProduct(
      doc('product-unavailable.html'),
      'https://www.zazzle.com/some_gone_product-235000000000000001',
      {},
    );
    expect(record.listingStatus).toBe('unavailable');
    expect(record.listedPrice).toBeNull();
  });
});

describe('extractZazzleSearchResults', () => {
  const page = extractZazzleSearchResults(
    doc('search-results.html'),
    'https://www.zazzle.com/s/custom+name+t+shirt',
  );

  it('dedupes by product id and excludes off-site anchors', () => {
    expect(page.results).toHaveLength(3);
    const ids = page.results.map((row) => row.productId);
    expect(ids).toEqual(['256993602821254375', '235604562741116693', '256417746022202831']);
    expect(page.results.every((row) => row.url.includes('zazzle.com'))).toBe(true);
  });

  it('canonicalizes candidate URLs (tracking payload dropped)', () => {
    expect(page.results[0]!.url).toBe(
      'https://www.zazzle.com/pets_simple_modern_cool_typography_name_and_photo_t_shirt-256993602821254375',
    );
  });

  it('enriches from the card and states no currency for "$" snippets', () => {
    const first = page.results[0]!;
    expect(first.title).toContain('Typography Name and Photo');
    expect(first.price).toMatchObject({ value: 19.31, currency: null });
    expect(first.originalPrice).toMatchObject({ value: 21.45, currency: null });
    expect(first.discountText).toBe('Save 10%');
  });

  it('keeps degraded cards with explicit nulls (C3 from birth)', () => {
    const degraded = page.results.find((row) => row.productId === '256417746022202831')!;
    expect(degraded.title).toBeNull();
    expect(degraded.price).toBeNull();
    expect(degraded.originalPrice).toBeNull();
    expect(degraded.discountText).toBeNull();
  });
});

// 2026-09-01: zazzle.ca is the CAD research surface. Its prices render with
// an explicit "C$" prefix, which IS a currency statement; a bare "$" still
// is not one.
describe('zazzle.ca money and candidates', () => {
  it('reads the stated currency out of C$/CA$/US$ prefixes and none out of "$"', () => {
    expect(parseZazzleMoney('C$24.60')).toEqual({ value: 24.6, currency: 'CAD', rawText: 'C$24.60' });
    expect(parseZazzleMoney('CA$ 1,024.60')).toMatchObject({ value: 1024.6, currency: 'CAD' });
    expect(parseZazzleMoney('US$19.31')).toMatchObject({ value: 19.31, currency: 'USD' });
    expect(parseZazzleMoney('$19.31')).toMatchObject({ value: 19.31, currency: null });
  });

  it('keeps .ca candidates and their .ca canonical URLs, and still drops lookalike hosts', () => {
    const { document } = parseHTML(
      `<div>
         <a href="https://www.zazzle.ca/pets_typography_name_t_shirt-256993602821254375?tracking=zzz"
            aria-label="Product: Pets Typography Name T-Shirt"></a>
         <a href="https://zazzle.ca.attacker.io/fake_product-256993602821254399"></a>
       </div>`,
    );
    const page = extractZazzleSearchResults(
      document as unknown as Document,
      'https://www.zazzle.ca/s/custom+name+t+shirt',
    );
    expect(page.results).toHaveLength(1);
    expect(page.results[0]!.url).toBe(
      'https://www.zazzle.ca/pets_typography_name_t_shirt-256993602821254375',
    );
  });

  it('takes a C$ figure from the pricing module as stated CAD, without the currency warning', () => {
    const { document } = parseHTML(
      `<h1>Custom Name T-Shirt</h1>
       <div class="Pricing_mainPrice">C$31.35</div>`,
    );
    const { record, warnings } = extractZazzleProduct(
      document as unknown as Document,
      'https://www.zazzle.ca/custom_name_t_shirt-235985008319788440',
    );
    expect(record.listedPrice).toMatchObject({ value: 31.35, currency: 'CAD', source: 'dom' });
    expect(warnings.some((warning) => warning.startsWith('PRICE_CURRENCY_UNSTATED'))).toBe(false);
  });
});
