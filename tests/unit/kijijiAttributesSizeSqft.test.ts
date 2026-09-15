import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { compactKijijiAd } from '@browser-bridge/compact';
// Relative import; see kijijiExtract.test.ts for the tests/package.json rationale.
import {
  extractKijijiListing,
  KIJIJI_ATTRIBUTES_MAX,
  KIJIJI_ATTRIBUTE_TEXT_MAX_CHARS,
  KijijiExtractionRecordSchema,
} from '../../packages/site-kijiji/src/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'kijiji');

function loadFixture(name: string): Document {
  const html = readFileSync(join(FIXTURES, name), 'utf8');
  return parseHTML(html).document as unknown as Document;
}

function parse(html: string): Document {
  return parseHTML(html).document as unknown as Document;
}

const CONTACT_URL = 'https://www.kijiji.ca/v-toy-game/city-of-toronto/lego/1730433251';
const OFFICE_URL = 'https://www.kijiji.ca/v-commercial-office-space/city-of-toronto/private-office-downtown/1750000001';

/**
 * One attribute row in the shape the live VIP renders it (copied from
 * live-vip-contact-1730433251.html): a row <div> holding an icon <div> and a
 * text <div> whose two <p> children are the label and the value. The class
 * names are Kijiji's generated ones and carry no meaning.
 */
function row(label: string, value: string): string {
  return `<div class="sc-eb45309b-0 befWKT sc-944f28fe-0 jwYrCy"><div class="sc-944f28fe-1 duYMkh"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" height="32" width="32"><path d="M12 22c5.523 0 10-4.477 10-10" stroke="currentColor"></path></svg></div><div class="sc-eb45309b-0 iNzWBi"><p class="sc-82669b63-0 cqjWkX">${label}</p><p class="sc-991ea11d-0 fgtvkm">${value}</p></div></div>`;
}

/** A synthetic office-space VIP whose attribute section carries the live markup around the given rows. */
function officeVip(rows: string, body = 'Bright private office on the 3rd floor, furnished, available now.'): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Private office downtown | Kijiji</title>
  <link rel="canonical" href="${OFFICE_URL}">
</head>
<body>
  <h1 data-testid="listing-title">Private office downtown</h1>
  <div data-testid="vip-price">$1,200.00</div>
  <div data-testid="vip-location">Toronto, ON M5V 2T6</div>
  <div data-testid="vip-attributes-section" class="sc-1f51e79f-0 sc-31977afe-0 hIJWvU PYLMO"><div class="sc-eb45309b-0 dTSpLs"><div class="sc-803433f5-0 jHdANZ"><div data-testid="fade-out-section" class="sc-69f589a8-0 imDWzI"><div data-testid="vip-attributes-body" class="sc-803433f5-2 hqyKJY"><div data-testid="vip-attributes-generic" class="sc-eb45309b-0 dTSpLs">${rows}</div></div></div></div></div></div>
  <div data-testid="vip-description-wrapper"><p>${body}</p></div>
  <div data-testid="r2s-form"><button data-testid="vip-reply-button">Send message</button></div>
</body>
</html>`;
}

describe('kijiji.ca.v1 reads the VIP attribute table (vip-attributes-section)', () => {
  it('reads the Condition row off the live 1730433251 capture', () => {
    // The captured server HTML renders exactly one attribute row:
    // "Condition" / "Used - Like new", as two <p> siblings under
    // vip-attributes-generic. Before this fix ATTRIBUTE_GROUP_SELECTORS
    // matched none of that markup and attributes came back [].
    const { record } = extractKijijiListing(loadFixture('live-vip-contact-1730433251.html'), CONTACT_URL, {
      pageRevision: 1,
    });
    expect(record.attributes).toContainEqual({ label: 'Condition', value: 'Used - Like new' });
    expect(record.attributes).toHaveLength(1);
    expect(KijijiExtractionRecordSchema.parse(record)).toBeTruthy();
  });

  it('reads a Size (sqft) row and a Condition row off the live row markup', () => {
    const { record, warnings } = extractKijijiListing(
      parse(officeVip(row('Size (sqft)', '150 sqft') + row('Condition', 'Used - Like new'))),
      OFFICE_URL,
    );
    expect(record.attributes).toEqual([
      { label: 'Size (sqft)', value: '150 sqft' },
      { label: 'Condition', value: 'Used - Like new' },
    ]);
    expect(record.sizeSqft).toEqual({ value: 150, rawText: '150 sqft', source: 'dom', confidence: 0.95 });
    expect(warnings.some((warning) => warning.startsWith('SIZE_SQFT'))).toBe(false);
    expect(KijijiExtractionRecordSchema.parse(record)).toBeTruthy();
  });

  it('surfaces a "1 sqft" data-entry value but names it implausible', () => {
    const { record, warnings } = extractKijijiListing(
      parse(officeVip(row('Size (sqft)', '1 sqft') + row('Condition', 'Used - Like new'))),
      OFFICE_URL,
    );
    expect(record.attributes).toContainEqual({ label: 'Size (sqft)', value: '1 sqft' });
    expect(record.sizeSqft).toMatchObject({ value: 1, rawText: '1 sqft', source: 'dom' });
    expect(record.sizeSqft?.confidence).toBeLessThan(0.95);
    const warning = warnings.find((entry) => entry.startsWith('SIZE_SQFT_IMPLAUSIBLE'));
    expect(warning).toBeDefined();
    expect(warning).toContain('Size (sqft) reads "1 sqft"');
    expect(warning).toContain('under 20 sqft are surfaced, not trusted');
  });

  it('collapses whitespace in both halves of a row', () => {
    const { record } = extractKijijiListing(
      parse(officeVip(row('  Size\n   (sqft) ', '\n 1,250   sqft\n'))),
      OFFICE_URL,
    );
    expect(record.attributes).toEqual([{ label: 'Size (sqft)', value: '1,250 sqft' }]);
    expect(record.sizeSqft).toMatchObject({ value: 1250, rawText: '1,250 sqft' });
  });

  it('accepts the spacing variants of the size label and a square-feet label', () => {
    for (const label of ['Size (sq ft)', 'Size (sq. ft.)', 'Square Feet', 'Square footage']) {
      const { record } = extractKijijiListing(parse(officeVip(row(label, '400 sqft'))), OFFICE_URL);
      expect(record.sizeSqft?.value, label).toBe(400);
    }
  });

  it('leaves sizeSqft null and warns when the size row does not parse', () => {
    const { record, warnings } = extractKijijiListing(
      parse(officeVip(row('Size (sqft)', 'Please contact'))),
      OFFICE_URL,
    );
    expect(record.attributes).toContainEqual({ label: 'Size (sqft)', value: 'Please contact' });
    expect(record.sizeSqft).toBeNull();
    const warning = warnings.find((entry) => entry.startsWith('SIZE_SQFT_UNPARSEABLE'));
    expect(warning).toBeDefined();
    expect(warning).toContain('"Please contact"');
  });

  it('never infers a size from the description body', () => {
    // The body states 1,200 sqft; the attribute table has no size row. The
    // field comes from the table only, so it stays null and nothing warns.
    const { record, warnings } = extractKijijiListing(
      parse(officeVip(row('Condition', 'Used - Like new'), 'Approximately 1,200 sqft of open-plan space, 12 workstations.')),
      OFFICE_URL,
    );
    expect(record.sizeSqft).toBeNull();
    expect(warnings.some((warning) => warning.startsWith('SIZE_SQFT'))).toBe(false);
  });

  it('is bounded: at most KIJIJI_ATTRIBUTES_MAX rows, each string cut at KIJIJI_ATTRIBUTE_TEXT_MAX_CHARS', () => {
    const long = 'x'.repeat(KIJIJI_ATTRIBUTE_TEXT_MAX_CHARS + 50);
    const rows = Array.from({ length: KIJIJI_ATTRIBUTES_MAX + 10 }, (_, index) => row(`Label ${index}`, `Value ${index}`)).join('');
    const { record } = extractKijijiListing(parse(officeVip(row(long, long) + rows)), OFFICE_URL);
    expect(record.attributes).toHaveLength(KIJIJI_ATTRIBUTES_MAX);
    expect(record.attributes[0]?.label).toHaveLength(KIJIJI_ATTRIBUTE_TEXT_MAX_CHARS);
    expect(record.attributes[0]?.value).toHaveLength(KIJIJI_ATTRIBUTE_TEXT_MAX_CHARS);
    expect(KijijiExtractionRecordSchema.parse(record)).toBeTruthy();
  });

  it('ignores a row that is not exactly two <p> children', () => {
    const notARow =
      '<div class="sc-eb45309b-0 iNzWBi"><p>Only a label</p></div><div><p>a</p><p>b</p><p>c</p></div>';
    const { record } = extractKijijiListing(parse(officeVip(notARow + row('Condition', 'New'))), OFFICE_URL);
    expect(record.attributes).toEqual([{ label: 'Condition', value: 'New' }]);
  });

  it('keeps the dt/dd and li readers working on the synthetic fixtures', () => {
    const dom = extractKijijiListing(loadFixture('vip-dom-only.html'), 'https://www.kijiji.ca/v-buy-sell/x/2109876543');
    expect(dom.record.attributes).toContainEqual({ label: 'Condition', value: 'Used - Fair' });
    const jsonld = extractKijijiListing(loadFixture('vip-jsonld.html'), 'https://www.kijiji.ca/v-buy-sell/x/1712345678');
    expect(jsonld.record.attributes).toContainEqual({ label: 'For Sale By', value: 'Owner' });
    expect(dom.record.sizeSqft).toBeNull();
    expect(jsonld.record.sizeSqft).toBeNull();
  });

  it('the compact ad summary carries sizeSqft as a bare number', () => {
    const { record } = extractKijijiListing(parse(officeVip(row('Size (sqft)', '150 sqft'))), OFFICE_URL);
    const compact = compactKijijiAd(record);
    expect(compact.sizeSqft).toBe(150);
    expect(compactKijijiAd({ ...record, sizeSqft: null }).sizeSqft).toBeNull();
  });
});
