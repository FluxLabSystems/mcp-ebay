import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { extractListingCandidates, type ListingCandidate } from '@browser-bridge/site-ebay';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ebay');

function loadFixture(name: string): Document {
  const html = readFileSync(join(FIXTURES, name), 'utf8');
  return parseHTML(html).document as unknown as Document;
}

function carouselCandidates(): ListingCandidate[] {
  return extractListingCandidates(
    loadFixture('search-carousel-cards.html'),
    'https://www.ebay.ca/sch/i.html?_nkw=lego+bulk+lot&_sop=10',
  );
}

function byId(candidates: ListingCandidate[], itemId: string): ListingCandidate {
  const found = candidates.find((candidate) => candidate.itemId === itemId);
  if (found === undefined) throw new Error(`no candidate for ${itemId}`);
  return found;
}

// Defect 4. The carousel card roots on a div the container list has never
// named, so anchor.closest() found no card and both lookups ran against an
// image-only anchor -- title and snippetPrice came back null on exactly the
// rows a keyword search leads with.
describe('carousel-template search cards (defect 4)', () => {
  it('reads title and price from a card whose root is not .s-item or an li', () => {
    const candidates = carouselCandidates();
    const first = byId(candidates, '198589141532');
    expect(first.title).toBe('LEGO Bulk Lot 12 lbs Mixed Bricks Minifigures');
    expect(first.snippetPrice).toEqual({ value: 86, currency: 'CAD' });
  });

  it('keeps every row of a page that mixes the carousel and legacy templates', () => {
    expect(carouselCandidates().map((candidate) => candidate.itemId)).toEqual([
      '198589141532',
      '800523282681',
      '206468265940',
      '366630546269',
      '555666777888',
    ]);
  });
});

// Defect 3. A candidate that says nothing about selling format forces the run
// to open every row just to learn whether it is an auction, which is what
// exhausted the per-turn tool budget.
describe('candidate snippets carry enough to triage without opening the row (defect 3)', () => {
  it('reads an auction card from its bid count', () => {
    const candidate = byId(carouselCandidates(), '198589141532');
    expect(candidate.sellingFormat).toBe('auction');
    expect(candidate.bidCount).toBe(14);
  });

  it('reads a Buy It Now card as fixed price with no bid count', () => {
    const candidate = byId(carouselCandidates(), '800523282681');
    expect(candidate.sellingFormat).toBe('fixed_price');
    expect(candidate.bidCount).toBeNull();
  });

  it('reads a card carrying both a bid count and Buy It Now as auction_with_bin', () => {
    const candidate = byId(carouselCandidates(), '366630546269');
    expect(candidate.sellingFormat).toBe('auction_with_bin');
    expect(candidate.bidCount).toBe(23);
  });

  // eBay omits "Buy It Now" from most fixed-price cards, and a 2026-09-01
  // live run read 4 of 5 of them as unknown -- each one a page open spent
  // learning what the card already said. An auction card always shows a bid
  // count or a countdown, so a priced card with no auction vocabulary is
  // fixed price by the same absence-of-signals rule the item page uses.
  it('infers fixed price for a priced card with no auction vocabulary', () => {
    const candidate = byId(carouselCandidates(), '206468265940');
    expect(candidate.sellingFormat).toBe('fixed_price');
    expect(candidate.bidCount).toBeNull();
  });

  it('keeps unknown for a priced card whose countdown suggests an unreadable auction', () => {
    const { document } = parseHTML(
      `<div class="srp-river-results"><div class="su-card-container">
         <a class="su-link" href="https://www.ebay.ca/itm/777888999000"><img src="x.jpg"></a>
         <span class="s-card__title">LEGO Creator Expert Lot</span>
         <span class="s-card__price">C $55.00</span>
         <span class="su-styled-text">6d 4h left (Sun, 10:15 p.m.)</span>
       </div></div>`,
    );
    const [candidate] = extractListingCandidates(
      document as unknown as Document,
      'https://www.ebay.ca/sch/i.html?_nkw=lego',
    );
    expect(candidate?.sellingFormat).toBe('unknown');
  });

  it('keeps unknown for a card with no readable price', () => {
    const { document } = parseHTML(
      `<div class="srp-river-results"><div class="su-card-container">
         <a class="su-link" href="https://www.ebay.ca/itm/888999000111"><img src="x.jpg"></a>
         <span class="s-card__title">LEGO Star Wars Mixed Lot</span>
       </div></div>`,
    );
    const [candidate] = extractListingCandidates(
      document as unknown as Document,
      'https://www.ebay.ca/sch/i.html?_nkw=lego',
    );
    expect(candidate?.sellingFormat).toBe('unknown');
  });

  it('carries shipping and location snippets verbatim', () => {
    const candidate = byId(carouselCandidates(), '198589141532');
    expect(candidate.shippingSnippetText).toBe('+C $22.15 shipping');
    expect(candidate.itemLocationText).toBe('from Mississauga, ON, Canada');
  });

  it('flags the NEW LISTING badge that cleanTitle strips out of the title', () => {
    const candidates = carouselCandidates();
    expect(byId(candidates, '198589141532').isNewListing).toBe(true);
    expect(byId(candidates, '206468265940').isNewListing).toBe(true);
    expect(byId(candidates, '800523282681').isNewListing).toBe(false);
  });

  it('enriches the legacy .s-item template too', () => {
    const candidate = byId(carouselCandidates(), '555666777888');
    expect(candidate.sellingFormat).toBe('fixed_price');
    expect(candidate.shippingSnippetText).toBe('+C $9.40 shipping');
    expect(candidate.itemLocationText).toBe('from Toronto, ON, Canada');
    expect(candidate.isNewListing).toBe(false);
  });

  // A listing title containing "buy it now" must never be BIN evidence: on
  // an auction card it must not manufacture auction_with_bin. (A priced
  // non-auction card with such a title still reads fixed_price, but through
  // the absence-of-auction-signals inference, not through the title.)
  it('does not take the selling format out of the listing title', () => {
    const { document } = parseHTML(
      `<div class="srp-river-results"><div class="su-card-container">
         <a class="su-link" href="https://www.ebay.ca/itm/111222333444"><img src="x.jpg"></a>
         <span class="s-card__title">LEGO bulk lot BUY IT NOW cheap</span>
         <span class="s-card__price">C $12.00</span>
         <span class="s-card__bids">7 bids</span>
       </div></div>`,
    );
    const [candidate] = extractListingCandidates(
      document as unknown as Document,
      'https://www.ebay.ca/sch/i.html?_nkw=lego',
    );
    expect(candidate?.title).toBe('LEGO bulk lot BUY IT NOW cheap');
    expect(candidate?.sellingFormat).toBe('auction');
    expect(candidate?.bidCount).toBe(7);
  });

  // 2026-09-01 live run: the "New Listing" badge span abuts the title text
  // with no whitespace, and the concatenated badge leaked into the title
  // ("New ListingLEGO Bulk Lot 4 lbs..."), where it would break titleRegex
  // filters anchored at the start.
  it('strips a badge span that abuts the title text with no whitespace', () => {
    const { document } = parseHTML(
      `<div class="srp-river-results"><div class="su-card-container">
         <a class="su-link" href="https://www.ebay.ca/itm/222333444555"><img src="x.jpg"></a>
         <span class="s-card__title"><span class="LIGHT_HIGHLIGHT">New Listing</span>LEGO Bulk Lot 4 lbs Bricks</span>
         <span class="s-card__price">C $20.00</span>
       </div></div>`,
    );
    const [candidate] = extractListingCandidates(
      document as unknown as Document,
      'https://www.ebay.ca/sch/i.html?_nkw=lego',
    );
    expect(candidate?.title).toBe('LEGO Bulk Lot 4 lbs Bricks');
    expect(candidate?.isNewListing).toBe(true);
  });
});

// 2026-09-04 deals fire (site-ebay+extractor_defect+store-page-snippetprice-
// null-on-every-row): on https://www.ebay.ca/str/lapennaco every one of 50
// cards came back with itemId, url and title but snippetPrice null,
// shippingSnippetText null and sellingFormat 'unknown', while the same
// items on a /sch/ page and their /itm/ pages priced normally. The store
// grid renders its price under class names none of the price selectors
// know, and a selector miss was silently a null. The price is still on
// the card as text; when no element names it, the card's own text does.
describe('store cards whose price element has no known class (2026-09-04)', () => {
  function storeCandidates(html: string): ListingCandidate[] {
    const { document } = parseHTML(`<div class="str-search-results">${html}</div>`);
    return extractListingCandidates(document as unknown as Document, 'https://www.ebay.ca/str/lapennaco?_sop=10&_ipg=240');
  }

  it('reads snippetPrice and the shipping line from the card text and says where they came from', () => {
    const candidates = storeCandidates(
      `<div class="str-grid-item">
         <a href="https://www.ebay.ca/itm/800106302072"><h3>Cisco C9130AXE-A Catalyst 9130 Access Point</h3></a>
         <div class="str-grid-item__attributes"><span>Pre-Owned</span></div>
         <div class="str-grid-item__price-line"><span>C $59.99</span></div>
         <div class="str-grid-item__shipping-line"><span>+C $12.00 shipping</span></div>
       </div>
       <div class="str-grid-item">
         <a href="https://www.ebay.ca/itm/800348101076"><h3>Cisco Galvanized Outdoor Wall Mounting Bracket</h3></a>
         <div class="str-grid-item__price-line"><span>C $24.50</span><span class="strike">C $30.00</span></div>
         <div class="str-grid-item__shipping-line"><span>Free shipping</span></div>
       </div>`,
    );
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      itemId: '800106302072',
      snippetPrice: { value: 59.99, currency: 'CAD' },
      snippetPriceSource: 'text',
      shippingSnippetText: '+C $12.00 shipping',
      sellingFormat: 'fixed_price',
    });
    expect(candidates[1]).toMatchObject({
      itemId: '800348101076',
      snippetPrice: { value: 24.5, currency: 'CAD' },
      snippetPriceSource: 'text',
      shippingSnippetText: 'Free shipping',
    });
  });

  it('does not read the shipping amount as the price when it is the only amount on the card', () => {
    const [candidate] = storeCandidates(
      `<div class="str-grid-item">
         <a href="https://www.ebay.ca/itm/800106302073"><h3>Cisco AIR-ANT2513P4M-N Antenna</h3></a>
         <div class="str-grid-item__shipping-line"><span>+C $12.00 shipping</span></div>
       </div>`,
    );
    expect(candidate?.snippetPrice).toBeNull();
    expect(candidate?.snippetPriceSource).toBeNull();
    expect(candidate?.shippingSnippetText).toBe('+C $12.00 shipping');
    expect(candidate?.sellingFormat).toBe('unknown');
  });

  it('reads the price after a shipping line that is not followed by a period', () => {
    const [candidate] = storeCandidates(
      `<div class="str-grid-item">
         <a href="https://www.ebay.ca/itm/800106302075"><h3>Cisco AIR-AP1852I</h3></a>
         <div><span>+C $12.00 shipping</span></div><div><span>C $45.00</span></div>
       </div>`,
    );
    expect(candidate?.snippetPrice).toEqual({ value: 45, currency: 'CAD' });
    expect(candidate?.shippingSnippetText).toBe('+C $12.00 shipping');
  });

  it('a price element the selectors know still wins, and is labelled as such', () => {
    const [candidate] = storeCandidates(
      `<div class="str-item-card">
         <a href="https://www.ebay.ca/itm/555666777888"><span class="str-item-card__title">LEGO Minifigure Accessory Bulk Bag</span></a>
         <span class="str-item-card__price">C $19.99</span>
         <span>Was C $25.00</span>
       </div>`,
    );
    expect(candidate?.snippetPrice).toEqual({ value: 19.99, currency: 'CAD' });
    expect(candidate?.snippetPriceSource).toBe('element');
  });

  it('a card with no amount at all stays null', () => {
    const [candidate] = storeCandidates(
      `<div class="str-grid-item">
         <a href="https://www.ebay.ca/itm/800106302074"><h3>Cisco bracket</h3></a>
         <div><span>See price in cart</span></div>
       </div>`,
    );
    expect(candidate?.snippetPrice).toBeNull();
    expect(candidate?.snippetPriceSource).toBeNull();
  });
});

// 2026-09-06 deals fire (site-ebay+extractor_defect+search-card-
// shippingsnippettext-quotes-a-different-service-than-the-item-page): the
// card for 167300287674 quoted "+C $83.34 shipping" and the item page,
// minutes later, C$875.27 UPS Worldwide Saver — 10.5x apart, and nothing on
// either read said the card's figure names no service or destination. Two
// other cards on the same page matched their pages, so the divergence is
// per listing and a card's shipping figure is never a landed-cost input.
describe('search-card shipping snippets name no service (2026-09-06)', () => {
  function searchCandidates(html: string): ListingCandidate[] {
    const { document } = parseHTML(`<ul class="srp-results">${html}</ul>`);
    return extractListingCandidates(
      document as unknown as Document,
      'https://www.ebay.ca/sch/i.html?_nkw=40GbE+QSFP%2B+switch&_sop=10&_ipg=240',
    );
  }

  it('parses the card\'s shipping amount beside the verbatim text', () => {
    const candidates = searchCandidates(
      `<li class="s-item"><a class="s-item__link" href="https://www.ebay.ca/itm/167300287674"><h3 class="s-item__title">ARISTA DCS-7050QX-32-R 32x40GbE QSFP+ SWITCH</h3></a><span class="s-item__price">C $145.29</span><span class="s-item__shipping">+C $83.34 shipping</span></li>
       <li class="s-item"><a class="s-item__link" href="https://www.ebay.ca/itm/198591780847"><h3 class="s-item__title">Mellanox SX1036</h3></a><span class="s-item__price">C $210.00</span><span class="s-item__shipping">Free shipping</span></li>
       <li class="s-item"><a class="s-item__link" href="https://www.ebay.ca/itm/236571703560"><h3 class="s-item__title">Dell S6000</h3></a><span class="s-item__price">C $300.00</span><span class="s-item__shipping">+US $73.50 shipping estimate from United States</span></li>
       <li class="s-item"><a class="s-item__link" href="https://www.ebay.ca/itm/236571703561"><h3 class="s-item__title">No shipping line</h3></a><span class="s-item__price">C $12.00</span></li>`,
    );
    expect(candidates.map((row) => row.shippingSnippetAmount)).toEqual([
      { value: 83.34, currency: 'CAD' },
      { value: 0, currency: 'CAD' },
      { value: 73.5, currency: 'USD' },
      null,
    ]);
    expect(candidates.map((row) => row.shippingSnippetServiceNamed)).toEqual([false, false, false, null]);
  });

  it('recognises a card that does name a carrier or service level', () => {
    const [named] = searchCandidates(
      `<li class="s-item"><a class="s-item__link" href="https://www.ebay.ca/itm/198591780848"><h3 class="s-item__title">Switch</h3></a><span class="s-item__price">C $99.00</span><span class="s-item__shipping">+C $29.00 UPS Standard shipping</span></li>`,
    );
    expect(named).toMatchObject({ shippingSnippetAmount: { value: 29, currency: 'CAD' }, shippingSnippetServiceNamed: true });
  });
});
