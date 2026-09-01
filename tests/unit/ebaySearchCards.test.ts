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
