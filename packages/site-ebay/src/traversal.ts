/**
 * Search-results and seller store traversal support — SDD v0.5 FR-15.
 * Candidate links are followed to canonical item pages; snippets here are
 * traversal hints only and are never accepted as canonical listing
 * evidence (§20.2).
 */
import { cleanTitle, itemIdFromUrl, marketplaceCurrencyFor, parseMoney } from './normalize.js';
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
  /** How `itemLocationText` was read: a location element, the "from <place>" / "Located in <place>" phrase in the card text, or not at all. */
  itemLocationSource: 'element' | 'text' | 'api' | null;
  /** The badge cleanTitle strips out of the title, kept as a flag. */
  isNewListing: boolean;
  /**
   * The sold caption the card renders, verbatim ("Sold Sep 3, 2026", or a
   * bare "Sold Item" tag); null when the card carries none. A row is a sold
   * comp only when this is set: the 2026-09-08 deals fire's
   * LH_Sold=1&LH_Complete=1 search rendered 247 rows with no field
   * separating a sold row from a live ask, and the routine's rule that "a
   * row without a sold date is not a sold row" had nothing to read. A
   * quantity badge ("12 sold") is never this caption. NEEDS-LIVE-VERIFICATION:
   * the classic template's `.s-item__caption--signal` is the selector this
   * was written against; no live sold page has been captured.
   */
  soldText: string | null;
  /**
   * The caption's date as YYYY-MM-DD — a calendar date, because the card
   * states no time or zone; null when there is no caption or it carries no
   * readable date ("Sold Item"). On a row that carries it, snippetPrice is
   * the figure the card shows beside the caption: the sold price as the card
   * states it, a hint the item page confirms like every other card field.
   */
  soldAt: string | null;
  /**
   * The seller login id the CARD states, from its seller-info element
   * ("fantasma713 (1,234) 99.5%"); null when the card states none, which on
   * the search templates captured so far is most cards. Never inferred from
   * the query: on 2026-09-07 item 227509015721 came back for
   * _ssn=dkbooksandtreasures and its item page names fantasma713, so a row
   * of a seller search is "a result of that query", not "that seller's
   * listing", until a card or the item page says whose it is. A traversal
   * hint like every other card field; the item page's seller decides.
   */
  seller: string | null;
  /**
   * How `seller` was read: 'element' from a seller-info element the
   * extractor knows, 'text' from the "login_id (count) percent" run in the
   * card's text when no such element matched (2026-09-08: seller null on
   * 240 of 240 rows of three broad /sch/ pages whose template is
   * NEEDS-LIVE-VERIFICATION), null when the card states no seller either
   * way. A page whose rows read 'text' is a selector to pin
   * (CARD_SELLER_SELECTOR_MISSED); a page of nulls renders no seller line
   * (CARD_SELLER_UNRENDERED).
   */
  sellerSource: 'element' | 'text' | 'api' | null;
  /**
   * Where the row sits on the results page: 'primary' above eBay's
   * "Results matching fewer words" divider, 'rewrite' below it, where the
   * rows match fewer of the query's words (and, on a seller search, are not
   * necessarily the seller's). NEEDS-LIVE-VERIFICATION: the divider is
   * `.srp-river-answer--REWRITE_START` on the templates this was written
   * against; a page without one is all 'primary'.
   */
  matchScope: 'primary' | 'rewrite';
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
 * The card's seller-info element, when the template renders one. The
 * classic row template's `.s-item__seller-info-text` reads "login_id (1,234)
 * 99.5%"; the newer card templates are NEEDS-LIVE-VERIFICATION (no live
 * search card naming a seller has been captured; the 2026-09-07 fire read
 * 240-card _ssn= pages with no seller on any row).
 */
const CARD_SELLER_SELECTOR =
  '.s-item__seller-info-text, .s-item__seller-info, .s-card__seller-info, .su-card-container__attributes__seller, [class*="seller-info"]';
/** "login_id (1,234) 99.5%" or a bare login id: the id is the first token. */
const CARD_SELLER_RE = /^([A-Za-z0-9][A-Za-z0-9._*-]{1,63})(?:\s*\(|\s+\d|\s*$)/;
/**
 * eBay's "Results matching fewer words" divider between the rows that match
 * the whole query and the looser tail. NEEDS-LIVE-VERIFICATION (see
 * ListingCandidate.matchScope).
 */
const REWRITE_DIVIDER_SELECTOR =
  '.srp-river-answer--REWRITE_START, [class*="REWRITE_START"], .srp-river-answer, .section-notice__main, h2, h3';
const REWRITE_DIVIDER_TEXT_RE = /^results\s+matching\s+fewer\s+words\b/i;

/**
 * The seller login id the card itself states, or null. A slug-shaped first
 * token of the seller-info text; nothing else on the card is read for it,
 * because the title's last word is not a seller (the offers-page lesson of
 * 2026-09-07).
 */
export function readCardSeller(card: Element): string | null {
  return readCardSellerWithSource(card, null).seller;
}

/**
 * The seller run as a card's text carries it when no seller-info element
 * matched: "login_id (1,234) 99.5%" — the login id, the feedback count in
 * parentheses and the positive-feedback percentage. The three together are
 * the signature; a title's last word is never followed by "(count) percent",
 * and the title is stripped first regardless.
 */
const CARD_SELLER_TEXT_RE = /(?:^|\s)([A-Za-z0-9][A-Za-z0-9._*-]{1,63})\s*\(\s*[\d,]+\s*\)\s*\d{1,3}(?:\.\d+)?%/;

/**
 * `seller` and where it came from. The named element wins; when none
 * matched, the card's own text is read for the seller run (2026-09-08:
 * three broad /sch/ pages returned seller null on every one of 240 rows —
 * whether the live template renders the line under an element the
 * selectors do not know, or renders none, is what the source tells the
 * page-level reader). NEEDS-LIVE-VERIFICATION: no broad-page card has been
 * captured; the fallback pins the text shape, not an element.
 */
export function readCardSellerWithSource(
  card: Element,
  rawTitle: string | null,
): { seller: string | null; source: 'element' | 'text' | null } {
  const elementText = cardText(card, CARD_SELLER_SELECTOR);
  if (elementText !== null) {
    const match = CARD_SELLER_RE.exec(elementText);
    if (match !== null) return { seller: match[1]!, source: 'element' };
  }
  const fromText = CARD_SELLER_TEXT_RE.exec(textWithoutTitle(card, rawTitle));
  if (fromText !== null) return { seller: fromText[1]!, source: 'text' };
  return { seller: null, source: null };
}

/**
 * The location phrase as a card's text renders it when no location element
 * matched: "from United States", "Located in Canada", "Ships from
 * Mississauga, ON, Canada". The place must start with a capital letter so
 * that a title's "lot from my collection" (already stripped) or a shipping
 * line's "from" never reads as a location. NEEDS-LIVE-VERIFICATION, as the
 * seller run above.
 */
const CARD_LOCATION_TEXT_RE =
  /\b((?:[Ll]ocated in|[Ss]hips from|[Ff]rom)\s+[A-Z][A-Za-z.'-]*(?:,?\s+(?:[A-Z][A-Za-z.'-]*|ON|QC|BC|AB|MB|SK|NS|NB|PE|NL|YT|NT|NU))*)/;

/** `itemLocationText` and where it came from: a known element, the card's text, or nowhere. */
export function readCardLocationWithSource(
  card: Element,
  rawTitle: string | null,
): { text: string | null; source: 'element' | 'text' | null } {
  const elementText = cardText(card, CARD_LOCATION_SELECTOR);
  if (elementText !== null) return { text: elementText, source: 'element' };
  // The seller run is stripped first: "from United States Lego_Lover99 (87)
  // 100%" must not read the login id's capitalised head as part of the place.
  const blob = textWithoutTitle(card, rawTitle).replace(CARD_SHIPPING_PHRASE_RE, ' ').replace(CARD_SELLER_TEXT_RE, ' ');
  const match = CARD_LOCATION_TEXT_RE.exec(blob);
  if (match !== null) return { text: normalizeText(match[1]!), source: 'text' };
  return { text: null, source: null };
}

/** The card's spaced text with the title removed, so a title never supplies a seller or a place. */
function textWithoutTitle(card: Element, rawTitle: string | null): string {
  let text = spacedText(card);
  if (rawTitle !== null && rawTitle.length > 0) text = text.split(rawTitle).join(' ');
  return text;
}

/**
 * Every /itm/ anchor that renders BELOW the first "Results matching fewer
 * words" divider, in one document-order query (the DOM here has no
 * compareDocumentPosition). Empty when the page has no divider.
 */
function anchorsBelowRewriteDivider(document: Document): Set<Element> {
  const below = new Set<Element>();
  let nodes: Element[];
  try {
    nodes = Array.from(document.querySelectorAll(`${REWRITE_DIVIDER_SELECTOR}, a[href*="/itm/"]`));
  } catch {
    return below;
  }
  let seenDivider = false;
  for (const node of nodes) {
    const isAnchor = node.tagName.toLowerCase() === 'a';
    if (!isAnchor) {
      if (!seenDivider) {
        const cls = node.getAttribute('class') ?? '';
        if (/REWRITE_START/.test(cls) || REWRITE_DIVIDER_TEXT_RE.test(normalizeText(node.textContent))) seenDivider = true;
      }
      continue;
    }
    if (seenDivider) below.add(node);
  }
  return below;
}

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
function priceFromCardText(card: Element, rawTitle: string | null, defaultCurrency: string): ReturnType<typeof parseMoney> {
  const text = textWithoutTitle(card, rawTitle).replace(CARD_SHIPPING_PHRASE_RE, ' ');
  return parseMoney(text, defaultCurrency);
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
export function readShippingSnippet(
  shippingSnippetText: string | null,
  defaultCurrency = 'CAD',
): {
  amount: { value: number; currency: string } | null;
  serviceNamed: boolean | null;
} {
  if (shippingSnippetText === null) return { amount: null, serviceNamed: null };
  const parsed = parseMoney(shippingSnippetText, defaultCurrency);
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
      const text = spacedText(el);
      if (text.length > 0) parts.push(text);
    }
  } catch {
    // fall through to the card's own text
  }
  if (parts.length > 0) return normalizeText(parts.join(' '));
  // No named format element on this template, so the card's own text has to
  // do -- minus the title, because a listing title is free to say
  // "BUY IT NOW" and that is the seller talking, not the format -- and with
  // a space at every element boundary. textContent ran the price element
  // into the bids element ("C $24.95" + "1 bid" = "C $24.951 bid"), and the
  // bid regex below read 951 bids on a one-bid auction, 820 on a zero-bid
  // one: every implausible card bidCount the deals fires filed (2026-09-02,
  // 09-06, 09-08) ended in the item page's true count with a two-digit run
  // in front of it.
  return withoutTitle(spacedText(card), card, rawTitle);
}

/**
 * The card's text with the title taken out, in every form the title takes:
 * the concatenated rawTitle the caller read, the title element's own spaced
 * text, and the spaced text of each /itm/ anchor (the anchor wraps the title
 * on every template, and a badge span inside it makes the concatenated form
 * differ from the spaced one).
 */
function withoutTitle(text: string, card: Element, rawTitle: string | null): string {
  const forms = new Set<string>();
  if (rawTitle !== null && rawTitle.length > 0) forms.add(rawTitle);
  try {
    const titleEl = card.querySelector(CARD_TITLE_SELECTOR);
    if (titleEl !== null) {
      const spaced = spacedText(titleEl);
      if (spaced.length > 0) forms.add(spaced);
    }
    for (const anchor of Array.from(card.querySelectorAll('a[href*="/itm/"]'))) {
      const spaced = spacedText(anchor);
      if (spaced.length > 0) forms.add(spaced);
    }
  } catch {
    // the title forms already collected still apply
  }
  let out = text;
  for (const form of forms) out = out.split(form).join(' ');
  return normalizeText(out);
}

/**
 * The sold caption of a sold/completed-search row. Two templates are known:
 * the classic `.s-item__caption--signal.POSITIVE` "Sold  Sep 3, 2026" (month
 * first, with the `.s-item__title--tagblock` "Sold Item" tag), and the live
 * 2026-09-09 template the first captured sold page showed (deals fire 04:20Z,
 * the re-file under sold-search-renders-rows-but-candidate-schema-carries-
 * no-solddate-or-soldprice): a bare generic node with no signal class whose
 * whole text is "Sold 1 Sep 2026" — DAY first, no comma — between the row's
 * img and its title link. The month-first pattern alone read every such row
 * as unmarked, so the comps step ended for nothing. When no caption element
 * matches, the dated phrase is read from the card's own text with the title
 * removed, in either order, so a template change degrades to "no caption
 * read" (and the page-level SOLD_FILTER_ROWS_UNMARKED warning) rather than
 * to a guess. A quantity badge ("12 sold") matches neither pattern.
 */
const CARD_SOLD_SELECTOR =
  '.s-item__caption--signal, .s-item__caption, .s-card__caption, .s-item__title--tagblock, .s-card__title--tagblock';
const SOLD_MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
/** Month-first "Sold Sep 3, 2026" — groups 2 (month), 3 (day), 4 (year). */
const SOLD_CAPTION_MONTH_FIRST_RE = new RegExp(`\\bsold\\s+(?:on\\s+)?(${SOLD_MONTH}\\s+(\\d{1,2}),?\\s+(\\d{4}))\\b`, 'i');
/** Day-first "Sold 1 Sep 2026" — groups 2 (day), 3 (month), 4 (year). */
const SOLD_CAPTION_DAY_FIRST_RE = new RegExp(`\\bsold\\s+(?:on\\s+)?((\\d{1,2})\\s+${SOLD_MONTH},?\\s+(\\d{4}))\\b`, 'i');
const SOLD_TAG_RE = /\bsold\s+item\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoDateFrom(month: string, day: string, year: string): string | null {
  const monthIndex = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
  const dayNumber = Number.parseInt(day, 10);
  if (monthIndex < 0 || !Number.isFinite(dayNumber) || dayNumber < 1 || dayNumber > 31) return null;
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(dayNumber).padStart(2, '0')}`;
}

export function readSoldCaption(card: Element, rawTitle: string | null): { soldText: string | null; soldAt: string | null } {
  const sources: string[] = [];
  try {
    for (const el of Array.from(card.querySelectorAll(CARD_SOLD_SELECTOR))) {
      const text = spacedText(el);
      if (text.length > 0) sources.push(text);
    }
  } catch {
    // fall through to the card's own text
  }
  sources.push(withoutTitle(spacedText(card), card, rawTitle));
  for (const source of sources) {
    const monthFirst = SOLD_CAPTION_MONTH_FIRST_RE.exec(source);
    if (monthFirst !== null) {
      return { soldText: normalizeText(monthFirst[0]), soldAt: isoDateFrom(monthFirst[2]!, monthFirst[3]!, monthFirst[4]!) };
    }
    const dayFirst = SOLD_CAPTION_DAY_FIRST_RE.exec(source);
    if (dayFirst !== null) {
      return { soldText: normalizeText(dayFirst[0]), soldAt: isoDateFrom(dayFirst[3]!, dayFirst[2]!, dayFirst[4]!) };
    }
  }
  for (const source of sources) {
    const tag = SOLD_TAG_RE.exec(source);
    if (tag !== null) return { soldText: normalizeText(tag[0]), soldAt: null };
  }
  return { soldText: null, soldAt: null };
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
  const rewriteAnchors = anchorsBelowRewriteDivider(document);
  // A bare "$" on the card is the page host's currency: USD on www.ebay.com,
  // CAD on www.ebay.ca (2026-09-08: .com cards wore the CAD label at the USD
  // figure, 38% under the landed cost, on every enterprise sweep).
  const marketplaceCurrency = marketplaceCurrencyFor(pageUrl);
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
      const elementPrice = parseMoney(cardText(card, CARD_PRICE_SELECTOR) ?? '', marketplaceCurrency);
      const textPrice = elementPrice === null ? priceFromCardText(card, rawTitle, marketplaceCurrency) : null;
      const parsedPrice = elementPrice ?? textPrice;
      const { sellingFormat, bidCount } = detectCardFormat(card, rawTitle, parsedPrice !== null);
      const shippingSnippetText = cardText(card, CARD_SHIPPING_SELECTOR) ?? shippingFromCardText(card);
      const shippingSnippet = readShippingSnippet(shippingSnippetText, marketplaceCurrency);
      const sellerRead = readCardSellerWithSource(card, rawTitle);
      const locationRead = readCardLocationWithSource(card, rawTitle);

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
        itemLocationText: locationRead.text,
        itemLocationSource: locationRead.source,
        isNewListing: isNewListingCard(card, rawTitle),
        ...readSoldCaption(card, rawTitle),
        seller: sellerRead.seller,
        sellerSource: sellerRead.source,
        matchScope: rewriteAnchors.has(anchor) ? 'rewrite' : 'primary',
        order: candidates.length,
      });
    }
    if (candidates.length > 0) break;
  }
  return candidates;
}
