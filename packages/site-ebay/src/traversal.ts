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
   * Where snippetPrice was read: a price element one of the card selectors
   * names ('element'), or the first non-shipping amount in the card's own
   * text when no price element matched ('text'); null when there is no
   * price. The 2026-09-04 deals fire read 50 /str/ store cards with title
   * and URL on every row and snippetPrice null on every row — the store
   * grid prices its cards under class names the selectors do not know, and
   * a selector miss was a silent null. The text is still a hint, not
   * evidence, and the page-level SNIPPET_PRICE_FROM_CARD_TEXT warning
   * counts the rows that took this path. 'api' is the Countdown API mapper
   * (ebay.api.v1), whose rows carry a priced field, not a rendered card.
   */
  snippetPriceSource: 'element' | 'text' | 'api' | null;
  /**
   * Selling format as far as the CARD says, which is much less than an item
   * page says. A candidate carrying no format had to be opened just to learn
   * whether it was an auction, and opening every row is what exhausts a run's
   * tool budget. eBay leaves the Buy It Now label off most fixed-price
   * cards, so a priced card with no auction vocabulary anywhere on it is
   * inferred fixed_price — the same absence-of-auction-signals rule the item
   * page uses. 'unknown' remains a real answer for a card with no price or
   * with auction-shaped text the bid selectors could not read; it is still
   * a traversal hint, and the item page stays the canonical evidence.
   */
  sellingFormat: SellingFormatKind;
  /** Bids the card shows; null when it shows none. */
  bidCount: number | null;
  /** Shipping line as rendered ("+C $22.15 shipping", "Free shipping"). */
  shippingSnippetText: string | null;
  /**
   * The amount shippingSnippetText states (0 for "Free shipping"), parsed
   * so a consumer need not. A traversal hint like every other card field,
   * and never a landed-cost input: on 2026-09-06 the card for 167300287674
   * read "+C $83.34 shipping" and the item page, minutes later, quoted
   * C$875.27 UPS Worldwide Saver for the same id. The card names no
   * service or destination, so nothing on it says which quote it is.
   */
  shippingSnippetAmount: { value: number; currency: string } | null;
  /**
   * Whether the card's shipping text names a carrier or service level
   * (UPS, Canada Post, Expedited, …). False on the ordinary "+C $83.34
   * shipping" card; null when there is no shipping text. A false here is
   * why the figure is not costable (SHIPPING_SNIPPET_SERVICE_UNLABELLED).
   */
  shippingSnippetServiceNamed: boolean | null;
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
export const CARD_TITLE_SELECTOR = '.s-item__title, .str-item-card__title, .s-card__title, h3';
export const CARD_PRICE_SELECTOR = '.s-item__price, .str-item-card__price, .s-card__price';
const CARD_BID_SELECTOR = '.s-item__bids, .s-item__bidCount, .s-card__bids';
export const CARD_SHIPPING_SELECTOR =
  '.s-item__shipping, .s-item__logisticsCost, .s-card__shipping, .s-card__logisticsCost';
export const CARD_LOCATION_SELECTOR = '.s-item__location, .s-item__itemLocation, .s-card__location';
const CARD_FORMAT_SELECTOR =
  '.s-item__purchase-options-with-icon, .s-item__dynamic, .s-item__formatBuyItNow, .s-item__bids, .s-item__bidCount, .s-card__purchase-options, .s-card__bids';
const CARD_NEW_LISTING_SELECTOR = '.s-item__title--tag, .s-card__title--tag, .LIGHT_HIGHLIGHT';

/**
 * 'watchlist' and 'offers' are the signed-in My eBay surfaces the deals
 * routine walks: the watch list (every item the operator is watching) and
 * the bids/offers page (offers sellers sent, offers the operator made). Both
 * render item cards that link /itm/ pages, so they extract as candidate
 * lists with extra per-row fields (time left, seller offer, offer status)
 * and never as canonical listing evidence — the item page still decides.
 */
export type EbayPageKind = 'listing' | 'search' | 'store' | 'watchlist' | 'offers' | 'other';

/**
 * My eBay path shapes, both the current experience (/mye/myebay/…) and the
 * classic one (/myb/…). Case-insensitive: eBay itself links /myb/WatchList
 * and /myb/BidsOffers with capitals. The offers test runs first because a
 * bids-and-offers URL can also mention the watch list in a query string.
 */
const MYEBAY_OFFERS_RE = /^\/(?:mye\/myebay(?:\/v\d+)?|myb)\/(?:bids?(?:and|&|-)?offers?|offers?(?:received|sent)?|bidsoffers)(?:\/|$)/i;
const MYEBAY_WATCHLIST_RE = /^\/(?:mye\/myebay(?:\/v\d+)?|myb)\/watch-?list(?:\/|$)/i;

export function classifyEbayPage(pageUrl: string): EbayPageKind {
  try {
    const url = new URL(pageUrl);
    const path = url.pathname;
    if (/\/itm\//.test(path)) return 'listing';
    if (/\/sch\//.test(path)) return 'search';
    if (/\/str\//.test(path) || /\/usr\//.test(path)) return 'store';
    if (MYEBAY_OFFERS_RE.test(path)) return 'offers';
    if (MYEBAY_WATCHLIST_RE.test(path)) return 'watchlist';
    return 'other';
  } catch {
    return 'other';
  }
}

export function normalizeText(raw: string | null | undefined): string {
  return (raw ?? '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function cardText(card: Element, selector: string): string | null {
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
export function cardRootFor(anchor: Element): Element {
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

/**
 * An amount that is a shipping/delivery figure rather than the price, as a
 * card renders it ("+C $12.00 shipping", "C $8.50 delivery", "Free
 * shipping"); stripped before the card text is read for a price so a card
 * whose only amount is its shipping never gets that amount as its price.
 */
const CARD_SHIPPING_PHRASE_RE =
  /(?:\+\s*)?(?:(?:C|CA|US)\s?\$|\$|CAD|USD)\s?[\d,]+(?:\.\d{1,2})?\s*(?:shipping|delivery|postage|est(?:imated)?\.?\s*(?:shipping|delivery))\b|\bfree\s+(?:shipping|delivery|postage)\b/gi;
/** The shipping line as a card renders it, for cards with no named shipping element. */
const CARD_SHIPPING_TEXT_RE =
  /\bfree\s+(?:shipping|delivery|postage)\b|(?:\+\s*)?(?:(?:C|CA|US)\s?\$|\$|CAD|USD)\s?[\d,]+(?:\.\d{1,2})?\s*(?:shipping|delivery|postage)\b(?:\s+estimate)?/i;

/**
 * The card's price when no price element matched: the first amount in the
 * card's text that is not a shipping figure, with the title removed first
 * (a title is free to say "$5 Lego Lot"). Strike-through and "was" prices
 * render after the current price on every eBay template seen, so "first"
 * is the current price; that is the extent of the claim, and the value is
 * a traversal hint the item page still decides.
 */
function priceFromCardText(card: Element, rawTitle: string | null): ReturnType<typeof parseMoney> {
  let text = spacedText(card);
  if (rawTitle !== null && rawTitle.length > 0) text = text.split(rawTitle).join(' ');
  text = text.replace(CARD_SHIPPING_PHRASE_RE, ' ');
  return parseMoney(text);
}

function shippingFromCardText(card: Element): string | null {
  const match = CARD_SHIPPING_TEXT_RE.exec(spacedText(card));
  return match === null ? null : match[0].trim();
}

/**
 * Words that name the service a shipping figure is for. A card that carries
 * only "+C $83.34 shipping" names none, and that absence is what makes its
 * figure uncostable. NEEDS-LIVE-VERIFICATION: no live ebay.ca card has been
 * captured naming a carrier; the vocabulary is the item page's ("UPS
 * Worldwide Saver", "USPS Priority Mail International", "UPS Standard").
 */
const SHIPPING_SERVICE_NAMED_RE =
  /\b(?:ups|usps|fedex|dhl|purolator|canpar|canada\s+post|expedited|economy|standard|priority|express|ground|first[\s-]class|worldwide|international\s+(?:priority|express|economy|standard))\b/i;

/** The amount a shipping snippet states and whether it names a service; both null without a snippet. */
export function readShippingSnippet(shippingSnippetText: string | null): {
  amount: { value: number; currency: string } | null;
  serviceNamed: boolean | null;
} {
  if (shippingSnippetText === null) return { amount: null, serviceNamed: null };
  const parsed = parseMoney(shippingSnippetText);
  return {
    amount: parsed === null ? null : { value: parsed.value, currency: parsed.currency },
    serviceNamed: SHIPPING_SERVICE_NAMED_RE.test(shippingSnippetText),
  };
}

/**
 * The card's text with a space at every element boundary. textContent runs
 * adjacent elements together ("+C $12.00 shippingC $45.00"), and a word
 * boundary the regexes above rely on disappears with the whitespace.
 */
function spacedText(root: Element): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) parts.push(child.textContent ?? '');
      else if (child.nodeType === 1) walk(child);
    }
  };
  walk(root);
  return normalizeText(parts.join(' '));
}

const CARD_BIDS_RE = /\b(\d{1,5})\s*bids?\b/i;
const CARD_BIN_RE = /\bbuy\s+it\s+now\b|\bor\s+best\s+offer\b/i;
const CARD_AUCTION_RE = /\bplace\s+bid\b|\bcurrent\s+bid\b|\bstarting\s+bid\b/i;
/**
 * A live countdown is an auction tell ("6d 4h left", "Ends today"). It only
 * ever BLOCKS the fixed-price inference below — it never classifies a card
 * as an auction on its own, because promo strips borrow the vocabulary.
 */
const CARD_TIMELEFT_RE = /\b(?:\d+\s*[dhms]\s+)*\d+\s*[dhms]\s+left\b|\btime\s+left\b|\bends?\s+(?:today|tonight|in)\b/i;
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

export interface CardFormatOptions {
  /**
   * Whether a priced card with no auction vocabulary is read as
   * fixed_price. True for search and store cards, where the 2026-09-01 run
   * proved the inference against item pages. False for the My eBay watch
   * list: its ?page=99 overflow render (2026-09-04) carried no format
   * element on any of 346 cards, and the inference labelled 44 live
   * auctions with bids as fixed_price — there a card that states nothing
   * is 'unknown'.
   */
  inferFixedPriceFromPrice?: boolean;
}

export function detectCardFormat(
  card: Element,
  rawTitle: string | null,
  hasSnippetPrice: boolean,
  options: CardFormatOptions = {},
): { sellingFormat: SellingFormatKind; bidCount: number | null } {
  const inferFixedPrice = options.inferFixedPriceFromPrice ?? true;
  const blob = cardFormatText(card, rawTitle);
  const bidText = cardText(card, CARD_BID_SELECTOR);
  const bidMatch = (bidText === null ? null : CARD_BIDS_RE.exec(bidText)) ?? CARD_BIDS_RE.exec(blob);
  const bidCount = bidMatch === null ? null : Number.parseInt(bidMatch[1]!, 10);
  const hasAuction = bidCount !== null || CARD_AUCTION_RE.test(blob);
  const hasBin = CARD_BIN_RE.test(blob);
  if (hasAuction && hasBin) return { sellingFormat: 'auction_with_bin', bidCount };
  if (hasAuction) return { sellingFormat: 'auction', bidCount };
  if (hasBin) return { sellingFormat: 'fixed_price', bidCount: null };
  // Same inference the item-page extractor makes: eBay leaves the Buy It Now
  // label off most fixed-price cards, while an auction card essentially
  // always shows a bid count ("0 bids" included) or a countdown. A priced
  // card with no auction vocabulary anywhere on it — the whole card is
  // scanned here, title included, because the title can only ever make this
  // check MORE conservative — is a fixed-price listing, not an unknown. A
  // 2026-09-01 live run read 4 of 5 fixed-price cards as unknown, and every
  // unknown costs a page open just to learn what the card already said.
  const whole = normalizeText(card.textContent);
  if (
    inferFixedPrice &&
    hasSnippetPrice &&
    !CARD_BIDS_RE.test(whole) &&
    !CARD_AUCTION_RE.test(whole) &&
    !CARD_TIMELEFT_RE.test(whole)
  ) {
    return { sellingFormat: 'fixed_price', bidCount: null };
  }
  return { sellingFormat: 'unknown', bidCount: null };
}

export function isNewListingCard(card: Element, rawTitle: string | null): boolean {
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
      const elementPrice = parseMoney(cardText(card, CARD_PRICE_SELECTOR) ?? '');
      const textPrice = elementPrice === null ? priceFromCardText(card, rawTitle) : null;
      const parsedPrice = elementPrice ?? textPrice;
      const { sellingFormat, bidCount } = detectCardFormat(card, rawTitle, parsedPrice !== null);
      const shippingSnippetText = cardText(card, CARD_SHIPPING_SELECTOR) ?? shippingFromCardText(card);
      const shippingSnippet = readShippingSnippet(shippingSnippetText);

      candidates.push({
        itemId,
        url: absolute,
        title: titleText !== null && titleText.length > 0 ? titleText : null,
        snippetPrice: parsedPrice === null ? null : { value: parsedPrice.value, currency: parsedPrice.currency },
        snippetPriceSource: elementPrice !== null ? 'element' : textPrice !== null ? 'text' : null,
        sellingFormat,
        bidCount,
        shippingSnippetText,
        shippingSnippetAmount: shippingSnippet.amount,
        shippingSnippetServiceNamed: shippingSnippet.serviceNamed,
        itemLocationText: cardText(card, CARD_LOCATION_SELECTOR),
        isNewListing: isNewListingCard(card, rawTitle),
        order: candidates.length,
      });
    }
    if (candidates.length > 0) break;
  }
  return candidates;
}
