/**
 * 2026-09-11 18:2xZ deals fire (site-kijiji+extractor_defect+seller-profile-
 * cards-render-no-price-so-a-large-roster-seller-costs-one-page-open-per-
 * price): both /o-profile/63691662/listings/<n> pages hydrated and returned
 * 20 ad links each, titles and URLs on all 40, and price null on all 40 —
 * the card selectors ([data-testid="listing-price"], [class*="price"]) match
 * nothing on that template. No live capture of the page kind exists, so the
 * shape below is SYNTHETIC: cards whose price sits in an unnamed element.
 * The fix is the same one the eBay /str/ store cards got: read the amount
 * from the card's own text when no price element matches, say so per page,
 * and when no card carries an amount at all say THAT, so a drill-down can
 * report "prices are not on this surface" instead of forty nulls.
 */
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { extractSearchResults } from '../../packages/site-kijiji/src/index.js';

const SELLER_URL = 'https://www.kijiji.ca/o-profile/63691662/listings/1';
const OBSERVED_AT = new Date('2026-09-11T18:20:00.000Z');

function sellerDoc(cards: string): Document {
  const { document } = parseHTML(
    `<html><head><title>Listings | Kijiji</title></head><body><h1>Tech Liquidations</h1>
     <ul>${cards}</ul></body></html>`,
  );
  return document as unknown as Document;
}

const unnamedPrice = (id: string, title: string, price: string, location = 'Scarborough') =>
  `<li><article><h3><a href="https://www.kijiji.ca/v-computer-components/city-of-toronto/${id}">${title}</a></h3>
    <p>${price}</p><p>${location}</p><p>2 days ago</p></article></li>`;
const namedPrice = (id: string, title: string, price: string) =>
  `<li><article><h3 data-testid="listing-title"><a href="https://www.kijiji.ca/v-computer-components/city-of-toronto/${id}">${title}</a></h3>
    <p data-testid="listing-price">${price}</p></article></li>`;
const noPrice = (id: string, title: string) =>
  `<li><article><h3><a href="https://www.kijiji.ca/v-computer-components/city-of-toronto/${id}">${title}</a></h3>
    <p>Scarborough</p><p>2 days ago</p></article></li>`;

describe('kijiji seller-page cards: a price with no price element is read from the card text (2026-09-11 fire)', () => {
  it('takes the one amount in the card text as the price, marks its source, and says so per page', () => {
    const page = extractSearchResults(
      sellerDoc(
        unnamedPrice('1743114161', 'Dell PowerEdge R740 server', '$1,250.00') +
          unnamedPrice('1737551142', 'Cisco Catalyst 3850 48-port', '$225') +
          unnamedPrice('1737657370', 'APC Smart-UPS 1500', 'Please Contact') +
          unnamedPrice('1743069551', 'Rack shelf, free to a good home', 'Free'),
      ),
      SELLER_URL,
      { observedAt: OBSERVED_AT },
    );
    const byId = Object.fromEntries(page.results.map((row) => [row.adId, row]));
    expect(byId['1743114161']!.price).toMatchObject({ kind: 'amount', value: 1250 });
    expect(byId['1743114161']!.priceSource).toBe('card_text');
    expect(byId['1737551142']!.price).toMatchObject({ kind: 'amount', value: 225 });
    expect(byId['1737657370']!.price).toMatchObject({ kind: 'contact', value: null });
    expect(byId['1743069551']!.price).toMatchObject({ kind: 'free', value: 0 });
    const fromText = page.warnings.find((warning) => warning.startsWith('CARD_PRICE_FROM_CARD_TEXT'));
    expect(fromText).toBeDefined();
    expect(fromText).toMatch(/4 of 4/);
    expect(page.warnings.some((warning) => warning.startsWith('CARD_PRICE_UNRENDERED'))).toBe(false);
  });

  it('a card whose text carries two amounts stays null — the fallback never guesses between figures', () => {
    const page = extractSearchResults(
      sellerDoc(unnamedPrice('1743114161', 'Two servers', '$800 each or $1,500 for both')),
      SELLER_URL,
      { observedAt: OBSERVED_AT },
    );
    expect(page.results[0]!.price).toBeNull();
    expect(page.results[0]!.priceSource).toBeNull();
  });

  it('an amount inside the title is never the price', () => {
    const page = extractSearchResults(sellerDoc(noPrice('1743114161', 'LEGO lot paid $400 new')), SELLER_URL, {
      observedAt: OBSERVED_AT,
    });
    expect(page.results[0]!.price).toBeNull();
  });

  it('a named price element still wins and is marked card_element, with no per-page card-text warning', () => {
    const page = extractSearchResults(sellerDoc(namedPrice('1743114161', 'Dell R740', '$1,250.00')), SELLER_URL, {
      observedAt: OBSERVED_AT,
    });
    expect(page.results[0]!.price).toMatchObject({ kind: 'amount', value: 1250 });
    expect(page.results[0]!.priceSource).toBe('card_element');
    expect(page.warnings.some((warning) => warning.startsWith('CARD_PRICE_FROM_CARD_TEXT'))).toBe(false);
  });

  it('when no card carries a price element or an amount, CARD_PRICE_UNRENDERED names the count so the surface can be reported as priceless', () => {
    const page = extractSearchResults(
      sellerDoc(noPrice('1743114161', 'Dell R740') + noPrice('1737551142', 'Cisco 3850') + noPrice('1737657370', 'APC UPS')),
      SELLER_URL,
      { observedAt: OBSERVED_AT },
    );
    expect(page.results.map((row) => row.price)).toEqual([null, null, null]);
    const unrendered = page.warnings.find((warning) => warning.startsWith('CARD_PRICE_UNRENDERED'));
    expect(unrendered).toBeDefined();
    expect(unrendered).toMatch(/all 3/);
    expect(unrendered).toMatch(/o-profile/);
  });

  it('a search page whose cards mostly price stays quiet about the odd unpriced card', () => {
    const page = extractSearchResults(
      sellerDoc(namedPrice('1743114161', 'Dell R740', '$1,250.00') + noPrice('1737551142', 'Cisco 3850')),
      'https://www.kijiji.ca/b-computer-components/city-of-toronto/cisco/k0c780l1700273',
      { observedAt: OBSERVED_AT },
    );
    expect(page.warnings.some((warning) => warning.startsWith('CARD_PRICE_UNRENDERED'))).toBe(false);
  });
});
