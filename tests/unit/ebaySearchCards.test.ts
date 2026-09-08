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

// 2026-09-02 / 2026-09-06 / 2026-09-08 deals fires (site-ebay+extractor_defect+
// search-card-bidcount-hundreds-where-item-page-reports-one, filed three times
// under three keys): search cards read bidCount 781 and 910, then 971 and 951
// on two ONE-bid auctions (377462787285, 287567907370), then 350 and 280, then
// 820 and 740 on two ZERO-bid auctions (147558210462, 278348633712). Every
// figure ends in the item page's true bid count, and the digits in front of
// it are a two-digit number — the shape of a price's cents run into the bids
// text: textContent concatenates adjacent elements, so "C $24.95" followed by
// "1 bid" reads "C $24.951 bid" and the bid regex captures 951. The named bid
// element (.s-item__bids / .s-card__bids) never had this problem; the fallback
// over the card's own text did, on every template whose bids live under a
// class the selectors do not know. NEEDS-LIVE-VERIFICATION: no such card has
// been captured (three fires asked for one), so the element in front of the
// bids text is the price by inference from the figures; the fix — a space at
// every element boundary before the regex runs — holds whatever it is.
describe('search-card bidCount is never another element\'s digits (2026-09-08)', () => {
  function cardCandidates(html: string): ListingCandidate[] {
    const { document } = parseHTML(`<div class="srp-river-results">${html}</div>`);
    return extractListingCandidates(
      document as unknown as Document,
      'https://www.ebay.ca/sch/i.html?_nkw=lego+raised+baseplate&_sop=10&_ipg=240',
    );
  }

  it('reads 1 bid, not 951, when the price element abuts an unnamed bids element', () => {
    const [candidate] = cardCandidates(
      `<div class="su-card-container">
         <a class="su-link" href="https://www.ebay.ca/itm/377462787285"><img src="x.jpg"></a>
         <span class="s-card__title">LEGO Baseplate Lot 32x32 Green Grey</span>
         <span class="s-card__price">C $24.95</span><span class="s-card__attribute-row"><span>1 bid</span><span>·</span><span>4d 2h left</span></span>
       </div>`,
    );
    expect(candidate?.sellingFormat).toBe('auction');
    expect(candidate?.bidCount).toBe(1);
  });

  it('reads 0 bids, not 820, on a zero-bid auction priced C $12.82', () => {
    const [candidate] = cardCandidates(
      `<div class="su-card-container">
         <a class="su-link" href="https://www.ebay.ca/itm/147558210462"><img src="x.jpg"></a>
         <span class="s-card__title">LEGO Raised Baseplate 6092 Ramp</span>
         <span class="s-card__price">C $12.82</span><span class="s-card__attribute-row"><span>0 bids</span><span>·</span><span>6d 23h left</span></span>
       </div>`,
    );
    expect(candidate?.sellingFormat).toBe('auction');
    expect(candidate?.bidCount).toBe(0);
  });

  it('still reads the named bids element first, and the title never feeds the count', () => {
    const [candidate] = cardCandidates(
      `<div class="su-card-container">
         <a class="su-link" href="https://www.ebay.ca/itm/278348633712"><img src="x.jpg"></a>
         <span class="s-card__title">LEGO 6092 baseplate lot of 3 bids welcome</span>
         <span class="s-card__price">C $9.97</span><span class="s-card__bids">2 bids</span>
       </div>`,
    );
    expect(candidate?.bidCount).toBe(2);
  });

  it('a title that ends in digits does not run into the bids text either', () => {
    // The anchor-text title path (no title element): the badge span inside
    // the anchor makes the concatenated title differ from the spaced one.
    const [candidate] = cardCandidates(
      `<div class="su-card-container">
         <a class="su-link" href="https://www.ebay.ca/itm/298641348686"><span class="LIGHT_HIGHLIGHT">New Listing</span>LEGO Classic 10698 x 2</a>
         <span class="su-styled-text">1 bid</span><span class="s-card__price">C $28.00</span>
       </div>`,
    );
    expect(candidate?.bidCount).toBe(1);
    expect(candidate?.sellingFormat).toBe('auction');
  });
});

// 2026-09-08 04:1xZ deals fire (site-ebay+coverage_gap+sold-search-renders-rows-
// but-candidate-schema-carries-no-solddate-or-soldprice): the sold/completed
// search finally rendered (247 rows for _nkw=lego+baseplate+6092+32x32+ramp&
// LH_Sold=1&LH_Complete=1&_sop=13) and every row came back shaped exactly like
// a live ask — no sold date, nothing separating a comp from an ask — so the
// fire fell back to live-ask medians. A row is a sold comp only when the card
// SAYS it sold; the schema now has a place for that statement.
// NEEDS-LIVE-VERIFICATION: the caption markup is the classic template's
// `.s-item__caption--signal.POSITIVE` "Sold  Sep 3, 2026" as this was written
// against; a live sold page has never been captured (www.ebay.ca 403s dev
// boxes, and the 2026-09-08 snapshot could not be taken).
describe('sold/completed-search rows state their sold date (2026-09-08)', () => {
  function rows(html: string, url = 'https://www.ebay.ca/sch/i.html?_nkw=lego+baseplate+6092+32x32+ramp&LH_Sold=1&LH_Complete=1&_sop=13'): ListingCandidate[] {
    const { document } = parseHTML(`<ul class="srp-results">${html}</ul>`);
    return extractListingCandidates(document as unknown as Document, url);
  }

  it('reads the classic caption element into soldText and a date-only soldAt', () => {
    const [candidate] = rows(
      `<li class="s-item"><a class="s-item__link" href="https://www.ebay.ca/itm/307149482142"><h3 class="s-item__title">Lego Baseplate 6092 32x32 Ramp</h3></a>
         <span class="s-item__price">C $27.60</span>
         <div class="s-item__caption"><div class="s-item__caption--row"><span class="s-item__caption--signal POSITIVE"><span>Sold  Sep 3, 2026</span></span></div></div>
       </li>`,
    );
    expect(candidate?.soldText).toBe('Sold Sep 3, 2026');
    expect(candidate?.soldAt).toBe('2026-09-03');
    expect(candidate?.snippetPrice).toEqual({ value: 27.6, currency: 'CAD' });
  });

  it('reads a dated "Sold" phrase from the card text when no caption element is named', () => {
    const [candidate] = rows(
      `<li class="s-item"><a class="s-item__link" href="https://www.ebay.ca/itm/398222039071"><h3 class="s-item__title">LEGO 6092 Raised Baseplate</h3></a>
         <span class="s-item__price">C $38.74</span><span class="su-styled-text positive">Sold Aug 28, 2026</span>
       </li>`,
    );
    expect(candidate?.soldText).toBe('Sold Aug 28, 2026');
    expect(candidate?.soldAt).toBe('2026-08-28');
  });

  it('a live row carries null for both, and a "12 sold" quantity badge is not a sold caption', () => {
    const candidates = rows(
      `<li class="s-item"><a class="s-item__link" href="https://www.ebay.ca/itm/358504681378"><h3 class="s-item__title">Lego baseplate ramp 6092</h3></a>
         <span class="s-item__price">C $24.89</span><span class="s-item__hotness">12 sold</span>
       </li>
       <li class="s-item"><a class="s-item__link" href="https://www.ebay.ca/itm/358504681379"><h3 class="s-item__title">Sold as seen LEGO lot Sep 3, 2026 build</h3></a>
         <span class="s-item__price">C $10.00</span>
       </li>`,
      'https://www.ebay.ca/sch/i.html?_nkw=lego+baseplate+6092+32x32+ramp&_sop=10',
    );
    expect(candidates.map((row) => row.soldText)).toEqual([null, null]);
    expect(candidates.map((row) => row.soldAt)).toEqual([null, null]);
  });

  it('a "Sold Item" tag without a date is a sold marker with soldAt null, never a guessed date', () => {
    const [candidate] = rows(
      `<li class="s-item"><a class="s-item__link" href="https://www.ebay.ca/itm/307149482143"><h3 class="s-item__title">Lego Baseplate 6092</h3></a>
         <span class="s-item__title--tagblock"><span class="POSITIVE">Sold Item</span></span><span class="s-item__price">C $22.00</span>
       </li>`,
    );
    expect(candidate?.soldText).toBe('Sold Item');
    expect(candidate?.soldAt).toBeNull();
  });
});
