/**
 * Search-results and seller store traversal support — SDD v0.5 FR-15.
 * Candidate links are followed to canonical item pages; snippets here are
 * traversal hints only and are never accepted as canonical listing
 * evidence (§20.2).
 */
import { cleanTitle, itemIdFromUrl, parseMoney } from './normalize.js';
import type { SellingFormatKind } from './record.js';

export interface ListingCandidate {
  itemId: string;
  url: string;
  title: string | null;
  /** Snippet price: traversal hint only, never canonical evidence. */
  snippetPrice: { value: number; currency: string } | null;
  /**
   * Selling format as far as the CARD says, which is much less than an item
   * page says. A candidate carrying no format had to be opened just to learn
   * whether it was an auction, and opening every row is what exhausts a run's
   * tool budget. 'unknown' is a real answer here: eBay leaves the Buy It Now
   * label off plenty of fixed-price cards, so silence is ambiguous, and
   * reading it as fixed price would price a live bid as purchasable.
   */
  sellingFormat: SellingFormatKind;
  /** Bids the card shows; null when it shows none. */
  bidCount: number | null;
  /** Shipping line as rendered ("+C $22.15 shipping", "Free shipping"). */
  shippingSnippetText: string | null;
  itemLocationText: string | null;
  /** The badge cleanTitle strips out of the title, kept as a flag. */
  isNewListing: boolean;
  order: number;
}

/**
 * Every known result-card template in one pass. Taking the first selector
 * that matched anything and stopping there loses whichever template it did
 * not name: on a page that leads with carousel cards and falls back to older
 * rows, `a.s-item__link` matched only the old rows and the carousel rows
 * vanished from the candidate list entirely.
 */
const RESULT_LINK_SELECTOR_GROUPS = [
  [
    'a.s-item__link',
    '.s-item a[href*="/itm/"]',
    '.s-card a[href*="/itm/"]',
    '.su-card-container a[href*="/itm/"]',
    '.brwrvr__item-card a[href*="/itm/"]',
    '.str-item-card a[href*="/itm/"]',
  ].join(', '),
  '.srp-results a[href*="/itm/"]',
  '.str-search-results a[href*="/itm/"]',
  'a[href*="/itm/"]',
];

const CARD_CONTAINER_SELECTOR = '.s-item, .str-item-card, li, article';
const CARD_TITLE_SELECTOR = '.s-item__title, .str-item-card__title, .s-card__title, h3';
const CARD_PRICE_SELECTOR = '.s-item__price, .str-item-card__price, .s-card__price';
const CARD_BID_SELECTOR = '.s-item__bids, .s-item__bidCount, .s-card__bids';
const CARD_SHIPPING_SELECTOR =
  '.s-item__shipping, .s-item__logisticsCost, .s-card__shipping, .s-card__logisticsCost';
const CARD_LOCATION_SELECTOR = '.s-item__location, .s-item__itemLocation, .s-card__location';
const CARD_FORMAT_SELECTOR =
  '.s-item__purchase-options-with-icon, .s-item__dynamic, .s-item__formatBuyItNow, .s-item__bids, .s-item__bidCount, .s-card__purchase-options, .s-card__bids';
const CARD_NEW_LISTING_SELECTOR = '.s-item__title--tag, .s-card__title--tag, .LIGHT_HIGHLIGHT';

export type EbayPageKind = 'listing' | 'search' | 'store' | 'other';

export function classifyEbayPage(pageUrl: string): EbayPageKind {
  try {
    const url = new URL(pageUrl);
    const path = url.pathname;
    if (/\/itm\//.test(path)) return 'listing';
    if (/\/sch\//.test(path)) return 'search';
    if (/\/str\//.test(path) || /\/usr\//.test(path)) return 'store';
    return 'other';
  } catch {
    return 'other';
  }
}

function normalizeText(raw: string | null | undefined): string {
  return (raw ?? '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function cardText(card: Element, selector: string): string | null {
  let el: Element | null = null;
  try {
    el = card.querySelector(selector);
  } catch {
    return null;
  }
  const text = normalizeText(el?.textContent);
  return text.length > 0 ? text : null;
}

function distinctItemIds(root: Element): number {
  const ids = new Set<string>();
  for (const link of Array.from(root.querySelectorAll('a[href]'))) {
    const id = itemIdFromUrl(link.getAttribute('href') ?? '');
    if (id !== null) ids.add(id);
  }
  return ids.size;
}

/**
 * The card a result anchor belongs to. Known container classes are tried
 * first; when none matches -- the carousel-card template roots on a plain
 * div, and its item link wraps nothing but <img> elements -- climb from the
 * anchor and take the highest ancestor that still describes a single
 * listing. That stop condition is the whole safety of the climb: without it
 * it would reach the results list and read the next card's title as this
 * one's, which is worse than the null it replaces.
 */
function cardRootFor(anchor: Element): Element {
  let known: Element | null = null;
  try {
    known = anchor.closest(CARD_CONTAINER_SELECTOR);
  } catch {
    known = null;
  }
  if (known !== null) return known;
  let root: Element = anchor;
  let node: Element | null = anchor.parentElement;
  for (let depth = 0; node !== null && depth < 5; depth += 1) {
    if (distinctItemIds(node) > 1) break;
    root = node;
    node = node.parentElement;
  }
  return root;
}

const CARD_BIDS_RE = /\b(\d{1,5})\s*bids?\b/i;
const CARD_BIN_RE = /\bbuy\s+it\s+now\b/i;
const CARD_AUCTION_RE = /\bplace\s+bid\b|\bcurrent\s+bid\b/i;
const NEW_LISTING_BADGE_RE = /^\s*new\s+listing/i;

function cardFormatText(card: Element, rawTitle: string | null): string {
  const parts: string[] = [];
  try {
    for (const el of Array.from(card.querySelectorAll(CARD_FORMAT_SELECTOR))) {
      const text = el.textContent;
      if (text) parts.push(text);
    }
  } catch {
    // fall through to the card's own text
  }
  if (parts.length > 0) return normalizeText(parts.join(' '));
  // No named format element on this template, so the card's own text has to
  // do -- minus the title, because a listing title is free to say
  // "BUY IT NOW" and that is the seller talking, not the format.
  const whole = normalizeText(card.textContent);
  return rawTitle === null ? whole : whole.split(rawTitle).join(' ');
}

function detectCardFormat(
  card: Element,
  rawTitle: string | null,
): { sellingFormat: SellingFormatKind; bidCount: number | null } {
  const blob = cardFormatText(card, rawTitle);
  const bidText = cardText(card, CARD_BID_SELECTOR);
  const bidMatch = (bidText === null ? null : CARD_BIDS_RE.exec(bidText)) ?? CARD_BIDS_RE.exec(blob);
  const bidCount = bidMatch === null ? null : Number.parseInt(bidMatch[1]!, 10);
  const hasAuction = bidCount !== null || CARD_AUCTION_RE.test(blob);
  const hasBin = CARD_BIN_RE.test(blob);
  if (hasAuction && hasBin) return { sellingFormat: 'auction_with_bin', bidCount };
  if (hasAuction) return { sellingFormat: 'auction', bidCount };
  if (hasBin) return { sellingFormat: 'fixed_price', bidCount: null };
  return { sellingFormat: 'unknown', bidCount: null };
}

function isNewListingCard(card: Element, rawTitle: string | null): boolean {
  const badge = cardText(card, CARD_NEW_LISTING_SELECTOR);
  if (badge !== null && /new\s+listing/i.test(badge)) return true;
  // The badge usually lives inside the title element, where textContent
  // concatenates it onto the front and cleanTitle then strips it back off.
  return rawTitle !== null && NEW_LISTING_BADGE_RE.test(rawTitle);
}

export function extractListingCandidates(document: Document, pageUrl: string): ListingCandidate[] {
  const seen = new Set<string>();
  const candidates: ListingCandidate[] = [];
  for (const selector of RESULT_LINK_SELECTOR_GROUPS) {
    let anchors: Element[];
    try {
      anchors = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href');
      if (!href) continue;
      let absolute: string;
      try {
        absolute = new URL(href, pageUrl).toString();
      } catch {
        continue;
      }
      const itemId = itemIdFromUrl(absolute);
      if (!itemId || seen.has(itemId)) continue;
      seen.add(itemId);

      const card = cardRootFor(anchor);
      // Card titles carry badge spans ("New Listing", "SPONSORED") and a
      // screen-reader "Opens in a new window or tab" inside the same element,
      // and textContent concatenates all of it into the title.
      const anchorText = normalizeText(anchor.textContent);
      // Empty, not null: a carousel card's item link wraps only <img>, and an
      // empty string here would split the format blob character by character.
      const rawTitle = cardText(card, CARD_TITLE_SELECTOR) ?? (anchorText.length > 0 ? anchorText : null);
      const titleText = rawTitle === null ? null : cleanTitle(rawTitle);
      const parsedPrice = parseMoney(cardText(card, CARD_PRICE_SELECTOR) ?? '');
      const { sellingFormat, bidCount } = detectCardFormat(card, rawTitle);

      candidates.push({
        itemId,
        url: absolute,
        title: titleText !== null && titleText.length > 0 ? titleText : null,
        snippetPrice: parsedPrice === null ? null : { value: parsedPrice.value, currency: parsedPrice.currency },
        sellingFormat,
        bidCount,
        shippingSnippetText: cardText(card, CARD_SHIPPING_SELECTOR),
        itemLocationText: cardText(card, CARD_LOCATION_SELECTOR),
        isNewListing: isNewListingCard(card, rawTitle),
        order: candidates.length,
      });
    }
    if (candidates.length > 0) break;
  }
  return candidates;
}
