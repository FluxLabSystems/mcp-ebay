/**
 * My eBay extraction — the signed-in watch list and the bids/offers page.
 *
 * The deals routine walks the operator's own watch list several times a
 * week and reads every offer sellers have sent, so these two surfaces get
 * their own page kinds. Both render item cards that link /itm/ pages; the
 * structure this module reads is the same one the search-results scanner
 * reads (an /itm/ anchor, the card around it, the card's text), because
 * eBay has restyled My eBay more than once and no raw capture of the
 * current watch-list markup exists in this repository: the closest thing is
 * tests/fixtures/ebay/watchlist-page-2026-09-05.html, authored from the
 * 2026-09-05 browser_snapshot's node order (roles, names, text, hrefs — no
 * class names). So every field below is read shape-tolerantly: a known
 * class name first, then the card's own text through a bounded regex, and
 * a null — never a guess — when neither says. A page that renders no cards
 * says exactly which of three things it is (a sign-in wall, an empty list,
 * or a template the selectors do not know) so a live pass can pin the
 * markup as a fixture instead of reading silence as "nothing watched".
 *
 * Nothing here is canonical listing evidence: a watch-list card is a
 * traversal hint exactly like a search card, and the item page decides
 * price, format and availability (§20.2).
 */
import { countdownMs } from './extract.js';
import { cleanTitle, itemIdFromUrl, parseMoney } from './normalize.js';
import type { SellingFormatKind } from './record.js';
import {
  CARD_PRICE_SELECTOR,
  CARD_SHIPPING_SELECTOR,
  CARD_TITLE_SELECTOR,
  cardRootFor,
  cardText,
  detectCardFormat,
  isNewListingCard,
  normalizeText,
  type ListingCandidate,
} from './traversal.js';

export interface MyEbayExtractContext {
  observedAt?: Date;
}

/**
 * What the card says about the listing's state. 'active' is read only from
 * a live countdown on a card with no ended/sold marker; 'unknown' is a card
 * that states nothing, which the item page must settle. A price alone is
 * NOT a tell: on the 2026-09-04 ?page=99 overflow render every card was
 * priced and 81 of the 118 validated had ended, so reading price as
 * 'active' manufactured 83 phantom reactivations in one walk.
 */
export type WatchlistItemStatus = 'active' | 'ended' | 'sold' | 'unknown';

export interface SellerOfferSnippet {
  /** The offer sentence as rendered, bounded; the evidence the row carries. */
  text: string;
  /** The offered amount when the sentence carries one; null when it does not. */
  price: { value: number; currency: string } | null;
}

export interface WatchlistCandidate extends ListingCandidate {
  /** The countdown exactly as rendered ("2d 4h left"); null when the card shows none. */
  timeLeftText: string | null;
  /** observedAt plus the countdown, ISO; a derivation, no finer than the text was. */
  endsAt: string | null;
  watchlistStatus: WatchlistItemStatus;
  /** The /usr/<loginId> the card links, when it links one. Never a display name. */
  seller: string | null;
  /** Seller text as rendered ("brickseller (1,234) 99.8%"), when the card shows it. */
  sellerText: string | null;
  /** A seller-sent offer the card advertises; the deals routine's Track O reads this first. */
  sellerOffer: SellerOfferSnippet | null;
  /** A price-drop badge as rendered ("Price drop: was C $45.00"); null when absent. */
  priceDropText: string | null;
  conditionText: string | null;
}

export interface WatchlistPage {
  candidates: WatchlistCandidate[];
  /** The rendered document title; the cheapest proof of which page actually loaded. */
  pageTitle: string;
  /**
   * true when the page rendered watch-list cards; false when it rendered a
   * sign-in wall instead; null when neither could be told (an empty list,
   * or a template the selectors do not know).
   */
  signedIn: boolean | null;
  /** The count the page states for the list ("All (312)"); null when it states none. */
  totalCount: number | null;
  /** Where totalCount was read from, for the audit; null with totalCount. */
  totalCountSource: string | null;
  currentPage: number | null;
  hasNextPage: boolean;
  nextPageUrl: string | null;
  warnings: string[];
}

export type OfferDirection = 'from_seller' | 'from_you' | 'unknown';
/**
 * 'none' is a row that carries only the listing's Best Offer control ("Make
 * Best offer") and no offer wording at all: the listing accepts offers and
 * nobody has made one. Observed 2026-09-04 on the live bids/offers page,
 * where 25 such rows had their ask read as an offer amount.
 */
export type OfferStatus = 'open' | 'accepted' | 'declined' | 'expired' | 'countered' | 'retracted' | 'none' | 'unknown';

export interface OfferCandidate {
  itemId: string;
  url: string;
  title: string | null;
  /**
   * The offered amount; null when the row shows no readable offer figure.
   * On a row that is an offer (a status prefix or sender wording) and
   * carries two amounts, this is the LOWER one: an offer is never above the
   * ask. Proven 2026-09-04 against three item pages, where the higher
   * figure on every row was the listing's own ask (267676402924 C $84.99 /
   * C $72.24, 168360507031, 128028063251; 25 of 25 rows the same way) —
   * the page-level OFFERS_AMOUNTS_ORDERED_BY_VALUE names the rows read so.
   */
  offerPrice: { value: number; currency: string } | null;
  /** The listing's asking price when the row shows a second figure; null otherwise. */
  listPrice: { value: number; currency: string } | null;
  direction: OfferDirection;
  offerStatus: OfferStatus;
  /** The expiry as rendered ("Expires in 1d 3h"); null when absent. */
  expiresText: string | null;
  /** observedAt plus the expiry countdown when it is one; null otherwise. */
  expiresAt: string | null;
  /** The /usr/<loginId> the row links, when it links one. */
  seller: string | null;
  sellerText: string | null;
  /** The row's own text, bounded, so a reader can audit the classification. */
  snippet: string;
  order: number;
}

export interface OffersPage {
  candidates: OfferCandidate[];
  pageTitle: string;
  signedIn: boolean | null;
  /** The count the page states for its rows ("All (39)"); null when it states none. */
  totalCount: number | null;
  totalCountSource: string | null;
  hasNextPage: boolean;
  nextPageUrl: string | null;
  warnings: string[];
}

/** Known and plausible card containers, tried before the generic climb. */
const MYEBAY_CARD_SELECTOR = [
  '.m-item',
  '.m-item-card',
  '.item-card',
  '.watchlist-item',
  '.watch-list-item',
  '.mye-item',
  '.my-ebay-item',
  '.bidsoffers-item',
  '.offer-card',
  '[data-testid="item-card"]',
  '[data-testid="watchlist-item"]',
  '[data-item-id]',
  '[data-itemid]',
  '[data-listing-id]',
].join(', ');

const MYEBAY_TITLE_SELECTOR = [
  CARD_TITLE_SELECTOR,
  '.m-item__title',
  '.item-card__title',
  '.item-title',
  '[class*="__title"]',
  '[class*="-title"]',
  '[data-testid="item-title"]',
].join(', ');

const MYEBAY_PRICE_SELECTOR = [
  CARD_PRICE_SELECTOR,
  '.m-item__price',
  '.item-card__price',
  '.item-price',
  '[class*="__price"]',
  '[class*="-price"]',
  '[data-testid="item-price"]',
].join(', ');

const MYEBAY_SHIPPING_SELECTOR = [
  CARD_SHIPPING_SELECTOR,
  '.m-item__shipping',
  '.item-card__shipping',
  '[class*="shipping"]',
  '[class*="delivery"]',
].join(', ');

const MYEBAY_TIMER_SELECTOR = [
  '.m-item__time-left',
  '.item-card__time-left',
  '.time-left',
  '[class*="time-left"]',
  '[class*="timeleft"]',
  '[class*="timer"]',
  '[class*="countdown"]',
  '[data-testid="time-left"]',
  'time',
].join(', ');

const MYEBAY_CONDITION_SELECTOR = ['.m-item__condition', '.item-card__condition', '[class*="condition"]'].join(', ');

const SIGN_IN_SELECTOR = [
  'form[action*="signin" i]',
  'form[action*="SignIn" i]',
  'input#userid',
  'input[name="userid"]',
  'input[name="userId"]',
  'input[type="password"]',
].join(', ');

/** "5d 04h left", "Ends in 2d 3h", "Ending today", "Time left: 1h 12m". */
const TIME_LEFT_RE =
  /(?:time\s+left:?\s*)?(?:(?:\d+\s*d(?:ays?)?\s*)?(?:\d+\s*h(?:ours?|rs?)?\s*)?(?:\d+\s*m(?:in(?:ute)?s?)?\s*)?(?:\d+\s*s(?:ec(?:ond)?s?)?\s*)?\bleft\b|\bends?\s+(?:in|today|tonight|soon)\b[^|•·\n]{0,40}|\bending\s+(?:today|soon)\b[^|•·\n]{0,40})/i;
const ENDED_RE = /\b(?:listing\s+(?:has\s+)?ended|this\s+listing\s+ended|item\s+(?:has\s+)?ended|\bended\b|no\s+longer\s+available|bidding\s+(?:has\s+)?ended|out\s+of\s+stock)\b/i;
/**
 * A sold STATE, never a sold COUNT: "12 sold" / "1,204+ sold" is the
 * quantity badge on a live multi-quantity listing (137295398934 read 'sold'
 * from it on 2026-09-04 while its item page was live at C $35.00).
 */
const SOLD_RE = /\b(?:this\s+item\s+sold|item\s+sold|sold\s+out|(?<![\d,+]\s?)\bsold\b(?!\s+by))/i;
const MONEY_SOURCE = String.raw`(?:C\s?\$|US\s?\$|CA\s?\$|\$)\s?\d[\d,]*(?:\.\d{2})?`;
/**
 * A seller named by a label. The colon form ("Seller: name (883) 99%") and
 * the "from seller name" / "sold by name" forms are the only ones read;
 * a bare "seller" followed by the next word is not, because "Declined by
 * seller Seller: x" would otherwise name the seller "Seller".
 */
const SELLER_TEXT_RE =
  /(?:\bseller|\bsold\s+by|\bfrom\s+seller|\bfrom)\s*:\s*([A-Za-z0-9._*-]{2,64})(?:\s*\((\d[\d,]*)\))?(?:\s*(\d{1,3}(?:\.\d)?%))?|(?:\bfrom\s+seller|\bsold\s+by)\s+([A-Za-z0-9._*-]{3,64})(?:\s*\((\d[\d,]*)\))?(?:\s*(\d{1,3}(?:\.\d)?%))?/i;
const SELLER_FEEDBACK_RE = /\b([A-Za-z0-9._*-]{3,64})\s*\((\d[\d,]*)\)(?:\s*(\d{1,3}(?:\.\d)?%))?/;
const SELLER_OFFER_RE =
  /((?:seller\s+sent\s+(?:you\s+)?an?\s+offer|offer\s+from\s+(?:the\s+)?seller|you(?:'ve|\s+have)\s+(?:received|got)\s+an?\s+offer|seller'?s?\s+offer|new\s+offer|counter\s*offer)[^|•·\n]{0,80})/i;
/**
 * "Price drop: was US $1,299.00", "Price reduced from C $45.00", "20% off".
 * Bounded to the badge itself: a card's text runs straight on into its
 * shipping and seller lines.
 */
const PRICE_DROP_RE = new RegExp(
  String.raw`((?:price\s+drop(?:ped)?|price\s+reduced)(?:\s*:?\s*(?:was|from)\s*${MONEY_SOURCE})?|(?:now\s+)?\d+%\s+off)`,
  'i',
);
const MONEY_RE = new RegExp(MONEY_SOURCE);
const COUNT_IN_LABEL_RE = /\((\d[\d,]*)\)/;
const COUNT_ITEMS_RE = /\b(\d[\d,]*)\s+(?:items?|listings?|results?)\b/i;
const SNIPPET_MAX = 240;

function bounded(text: string, max = SNIPPET_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Milliseconds in a bare duration ("1d 22h", "3h 15m"). Unlike countdownMs
 * this needs no "left"/"ends in" phrase, because the caller has already
 * matched the expiry context the digits sit in.
 */
function durationMs(text: string): number | null {
  const days = /(\d+)\s*d(?:ays?)?\b/i.exec(text);
  const hours = /(\d+)\s*h(?:ours?|rs?)?\b/i.exec(text);
  const minutes = /(\d+)\s*m(?:in(?:ute)?s?)?\b/i.exec(text);
  if (days === null && hours === null && minutes === null) return null;
  const unit = (match: RegExpExecArray | null): number => (match === null ? 0 : Number.parseInt(match[1]!, 10));
  return ((unit(days) * 24 + unit(hours)) * 60 + unit(minutes)) * 60_000;
}

function toIso(observedAt: string, deltaMs: number | null): string | null {
  if (deltaMs === null) return null;
  const ms = Date.parse(observedAt) + deltaMs;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function money(text: string | null): { value: number; currency: string } | null {
  if (text === null) return null;
  const parsed = parseMoney(text);
  return parsed === null ? null : { value: parsed.value, currency: parsed.currency };
}

function firstMoneyIn(text: string): { value: number; currency: string } | null {
  const match = MONEY_RE.exec(text);
  return match === null ? null : money(match[0]);
}

function documentTitle(document: Document): string {
  return normalizeText(document.querySelector('title')?.textContent);
}

function bodyText(document: Document, max: number): string {
  return normalizeText(document.body?.textContent).slice(0, max);
}

/** Every /itm/ anchor on the page, de-duplicated by item id, in document order. */
function itemAnchors(document: Document, pageUrl: string): Array<{ anchor: Element; itemId: string; url: string }> {
  const seen = new Set<string>();
  const found: Array<{ anchor: Element; itemId: string; url: string }> = [];
  let anchors: Element[];
  try {
    anchors = Array.from(document.querySelectorAll('a[href*="/itm/"]'));
  } catch {
    return found;
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
    if (itemId === null || seen.has(itemId)) continue;
    seen.add(itemId);
    found.push({ anchor, itemId, url: absolute });
  }
  return found;
}

/** The card around an anchor: a known My eBay container first, then the generic climb. */
function myEbayCardRoot(anchor: Element): Element {
  try {
    const known = anchor.closest(MYEBAY_CARD_SELECTOR);
    if (known !== null) return known;
  } catch {
    // fall through to the generic climb
  }
  return cardRootFor(anchor);
}

function sellerFrom(card: Element): { seller: string | null; sellerText: string | null } {
  let seller: string | null = null;
  try {
    for (const link of Array.from(card.querySelectorAll('a[href*="/usr/"]'))) {
      const slug = /\/usr\/([^/?#]+)/.exec(link.getAttribute('href') ?? '')?.[1];
      if (slug !== undefined) {
        seller = decodeURIComponent(slug);
        break;
      }
    }
  } catch {
    seller = null;
  }
  const text = normalizeText(card.textContent);
  const labelled = SELLER_TEXT_RE.exec(text);
  const feedback = SELLER_FEEDBACK_RE.exec(text);
  const sellerText =
    labelled !== null
      ? bounded(normalizeText(labelled[0]), 96)
      : feedback !== null
        ? bounded(feedback[0], 96)
        : sellerTextFromLinks(card);
  return { seller, sellerText };
}

/**
 * The seller as the 2026-09-05 watch-list template renders it: no "Seller:"
 * label and no "name (283) 100%" run, but two links per row — the /usr/
 * link reading "<loginId> username" and the feedback-profile link reading
 * "100% (283) Feedback score is 283 for <loginId>". Composed as
 * "<loginId> 100% (283)" from the login id and the feedback link's leading
 * figures; null when the row links neither.
 */
const USR_LINK_NAME_RE = /^(.{2,64}?)(?:\s+username)?$/i;
const FEEDBACK_LEAD_RE = /^(\d{1,3}(?:\.\d)?%\s*\(\d[\d,]*\))/;

function sellerTextFromLinks(card: Element): string | null {
  let name: string | null = null;
  let feedback: string | null = null;
  try {
    const usr = card.querySelector('a[href*="/usr/"]');
    const usrText = normalizeText(usr?.textContent);
    const nameMatch = usrText.length > 0 ? USR_LINK_NAME_RE.exec(usrText) : null;
    if (nameMatch !== null && nameMatch[1]!.length > 0) name = nameMatch[1]!;
    const fdbk = card.querySelector('a[href*="/fdbk/feedback_profile/"]');
    const fdbkText = normalizeText(fdbk?.textContent);
    const lead = fdbkText.length > 0 ? FEEDBACK_LEAD_RE.exec(fdbkText) : null;
    if (lead !== null) feedback = normalizeText(lead[1]!);
  } catch {
    return null;
  }
  const parts = [name, feedback].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : bounded(parts.join(' '), 96);
}

/**
 * The format as the row's ACTION LINK states it — "Bid Now" / "Place bid"
 * on an auction, "Buy It Now" on a fixed-price listing, both on an auction
 * with a Buy It Now. Read only from an anchor's or button's own text, never
 * from the title (a seller is free to write BUY IT NOW in one) and never
 * from the card's running text, where the 2026-09-05 template concatenates
 * the control onto the seller's name ("…for loginidBuy It NowView…") and a
 * word-bounded regex sees nothing. 'unknown' when the row renders no such
 * control.
 */
const ACTION_AUCTION_RE = /^(?:bid\s+now|place\s+bid)$/i;
const ACTION_BIN_RE = /^buy\s+it\s+now$/i;

function actionLinkFormat(card: Element): SellingFormatKind {
  let auction = false;
  let bin = false;
  try {
    for (const control of Array.from(card.querySelectorAll('a, button'))) {
      const text = normalizeText(control.textContent);
      if (ACTION_AUCTION_RE.test(text)) auction = true;
      else if (ACTION_BIN_RE.test(text)) bin = true;
    }
  } catch {
    return 'unknown';
  }
  if (auction && bin) return 'auction_with_bin';
  if (auction) return 'auction';
  if (bin) return 'fixed_price';
  return 'unknown';
}

/**
 * "* Converted from GBP 16.00": eBay's own conversion note beside a price it
 * rendered in the viewer's currency. The C$ figure on such a row is eBay's
 * conversion at its rate, not the seller's ask.
 */
const CONVERTED_FROM_RE = /converted\s+from\s+([A-Z]{3})\s*([\d,]+(?:\.\d{2})?)/i;

function readConvertedFrom(cardBlob: string): string | null {
  const match = CONVERTED_FROM_RE.exec(cardBlob);
  return match === null ? null : `${match[1]!.toUpperCase()} ${match[2]!}`;
}

function detectSignedIn(document: Document, cardCount: number): boolean | null {
  if (cardCount > 0) return true;
  try {
    if (document.querySelector(SIGN_IN_SELECTOR) !== null) return false;
  } catch {
    // selector failure means no evidence either way
  }
  const title = documentTitle(document).toLowerCase();
  if (/\bsign\s*in\b|\blog\s*in\b/.test(title)) return false;
  const lead = bodyText(document, 600).toLowerCase();
  if (/\bsign\s+in\s+to\s+(?:your\s+account|ebay|see|view)\b|\bplease\s+sign\s+in\b/.test(lead)) return false;
  return null;
}

/**
 * The count the page states for the list. Tab and heading labels carry it
 * as "All (312)"; older templates say "312 items". Read from the labels
 * first, because a card's own text can also say "3 items" about a lot.
 *
 * The "(N)" form outranks the "N items" form wherever both render: on the
 * live 2026-09-04 watch list a heading reading "1 item" was taken as the
 * list total over 34 reads of a 328-row list (it labels one row, not the
 * list). The caller still checks the chosen count against the rows the
 * page rendered — a stated total below them is no total at all.
 */
function readTotalCount(document: Document): { count: number | null; source: string | null; categoryChips: number } {
  const { chips, allChip } = categoryFilterChips(document);
  if (allChip !== null) {
    // "(352)" in the chip's text; the accessible name's "352 items" is the
    // same figure and the fallback when the text carries no parenthesis.
    const text = normalizeText(allChip.textContent);
    const aria = normalizeText(allChip.getAttribute('aria-label'));
    const match = COUNT_IN_LABEL_RE.exec(text) ?? COUNT_ITEMS_RE.exec(aria);
    if (match !== null) {
      // The visible label only: the accessible name's "352 items" rides in
      // a visually-hidden span that textContent runs onto the label's end.
      const label = text.replace(/\s*\d[\d,]*\s*items?\s*$/i, '');
      return {
        count: Number.parseInt(match[1]!.replace(/,/g, ''), 10),
        source: bounded(label.length > 0 ? label : aria, 80),
        categoryChips: chips.length,
      };
    }
  }
  const labelled: Array<{ count: number; source: string; form: 'label' | 'items' }> = [];
  try {
    const labels = Array.from(
      document.querySelectorAll('h1, h2, [role="tab"], [role="tablist"] a, [role="tablist"] button, .tabs a, .tabs button, .m-tabs a, .filter-menu a, .filter-menu button'),
    );
    for (const el of labels) {
      if (chips.some((chip) => chip === el || chip.contains(el))) continue;
      const text = normalizeText(el.textContent);
      if (text.length === 0 || text.length > 80) continue;
      const inLabel = COUNT_IN_LABEL_RE.exec(text);
      const match = inLabel ?? COUNT_ITEMS_RE.exec(text);
      if (match === null) continue;
      labelled.push({ count: Number.parseInt(match[1]!.replace(/,/g, ''), 10), source: text, form: inLabel !== null ? 'label' : 'items' });
    }
  } catch {
    // fall through
  }
  for (const form of ['label', 'items'] as const) {
    const entries = labelled.filter((entry) => entry.form === form);
    if (entries.length === 0) continue;
    // "All" is the whole list; failing a tab that says so, the largest label
    // is the widest filter the page offers.
    const all = entries.find((entry) => /^all\b/i.test(entry.source));
    const chosen = all ?? entries.reduce((best, entry) => (entry.count > best.count ? entry : best));
    return { count: chosen.count, source: chosen.source, categoryChips: chips.length };
  }
  // The body-text fallback with every chip's own text struck out first: a
  // chip's visually-hidden ", 1 item" is the first "N items" on the page.
  let lead = normalizeText(document.body?.textContent);
  for (const chip of chips) {
    const text = normalizeText(chip.textContent);
    if (text.length > 0) lead = lead.split(text).join(' ');
  }
  const match = COUNT_ITEMS_RE.exec(lead.slice(0, 4000));
  if (match !== null) {
    return { count: Number.parseInt(match[1]!.replace(/,/g, ''), 10), source: bounded(match[0], 40), categoryChips: chips.length };
  }
  return { count: null, source: null, categoryChips: chips.length };
}

/**
 * The category-filter chips the 2026-09-05 watch-list template opens with:
 * a carousel of links ("Drives, Storage & Blank Media (1)", accessible name
 * "Filter Watchlist by category: …, 1 item", href …&filter=category:…).
 * Each count is that CATEGORY's, never the list's — the first chip's
 * "1 item" was read as the list total over 10+ rendered rows on the
 * 2026-09-05 15:30Z fire — so a chip is never a count source.
 */
function categoryFilterChips(document: Document): { chips: Element[]; allChip: Element | null } {
  const chips: Element[] = [];
  let allChip: Element | null = null;
  try {
    for (const el of Array.from(document.querySelectorAll('a[href], [aria-label]'))) {
      const href = el.getAttribute('href') ?? '';
      const aria = normalizeText(el.getAttribute('aria-label'));
      const text = normalizeText(el.textContent);
      const named = CHIP_NAME_RE.test(aria) || CHIP_NAME_RE.test(text);
      if (!named && !/[?&]filter=category(?::|%3A)/i.test(href)) continue;
      // The carousel's HEAD (18:21Z snapshot, node el_54_54): "All Categories
      // (352) - Selected", accessible name "…: All Categories, 352 items,
      // selected", href with NO filter=. That one chip is the whole list's
      // count and is the total; every filtered sibling is a category's.
      const isAll =
        !/[?&]filter=category(?::|%3A)/i.test(href) &&
        (ALL_CATEGORIES_CHIP_RE.test(aria) || /^all\s+categories\b/i.test(text));
      if (isAll) {
        if (allChip === null) allChip = el;
      } else {
        chips.push(el);
      }
    }
  } catch {
    // no chips is no evidence either way
  }
  return { chips, allChip };
}
const CHIP_NAME_RE = /^filter\s+watch\s*list\s+by\s+category\b/i;
const ALL_CATEGORIES_CHIP_RE = /^filter\s+watch\s*list\s+by\s+category:\s*all\s+categories\b/i;

/**
 * A stated total below the rows the page itself rendered cannot be the
 * list's total; it is some other label ("1 item" on one row). Drop it and
 * say so, rather than hand the audit a count it will compare rows against.
 */
function checkedTotalCount(
  read: { count: number | null; source: string | null },
  renderedRows: number,
  prefix: string,
  warnings: string[],
): { count: number | null; source: string | null } {
  if (read.count === null || read.count >= renderedRows) return read;
  warnings.push(
    `${prefix}: the page's count label "${read.source ?? ''}" reads ${read.count}, below the ${renderedRows} rows this page rendered, so it is not the list total and totalResults is null; audit rows read against a count the page has not stated, and file the label through the improvement queue with a browser_snapshot so the real list-count element can be pinned.`,
  );
  return { count: null, source: null };
}

function pageNumberOf(pageUrl: string): number | null {
  try {
    const url = new URL(pageUrl);
    for (const key of ['page', 'pgn', 'pageNumber', 'ipg_page']) {
      const raw = url.searchParams.get(key);
      if (raw !== null && /^\d{1,4}$/.test(raw)) return Number.parseInt(raw, 10);
    }
  } catch {
    return null;
  }
  return null;
}

function withPage(pageUrl: string, page: number): string | null {
  try {
    const url = new URL(pageUrl);
    const key = ['page', 'pgn', 'pageNumber'].find((name) => url.searchParams.has(name)) ?? 'page';
    url.searchParams.set(key, String(page));
    return url.toString();
  } catch {
    return null;
  }
}

function isDisabled(el: Element): boolean {
  return (
    el.hasAttribute('disabled') ||
    el.getAttribute('aria-disabled') === 'true' ||
    /\b(?:disabled|is-disabled)\b/.test(el.getAttribute('class') ?? '')
  );
}

/**
 * The next-page control, from the site's own markup: a rel=next anchor, an
 * aria-labelled control, or the pagination widget's next button. An anchor
 * gives the URL outright; a button (client-side pagination) gives only the
 * fact that there is a next page, so the URL is derived from the current
 * page number and said to be derived.
 */
function readPagination(
  document: Document,
  pageUrl: string,
  warnings: string[],
): { hasNextPage: boolean; nextPageUrl: string | null; currentPage: number | null } {
  const currentPage = pageNumberOf(pageUrl);
  let controls: Element[] = [];
  try {
    controls = Array.from(
      document.querySelectorAll(
        'a[rel="next"], link[rel="next"], [aria-label="Next page" i], [aria-label="Next" i], [aria-label*="next page" i], a.pagination__next, button.pagination__next, .pagination__next a, .pagination__next button, a[class*="next"], button[class*="next"]',
      ),
    );
  } catch {
    controls = [];
  }
  for (const control of controls) {
    const label = normalizeText(control.textContent).toLowerCase();
    const aria = (control.getAttribute('aria-label') ?? '').toLowerCase();
    // "next" has to be about pagination: a card's "next day delivery" span
    // matches the class selector and must not become a page.
    const looksLikeNext =
      control.getAttribute('rel') === 'next' ||
      /\bnext\b/.test(aria) ||
      /^(?:next|next page|›|»|>)$/.test(label) ||
      /\bpagination\b/.test(control.getAttribute('class') ?? '') ||
      /\bpagination\b/.test(control.parentElement?.getAttribute('class') ?? '');
    if (!looksLikeNext) continue;
    if (isDisabled(control)) return { hasNextPage: false, nextPageUrl: null, currentPage };
    const href = control.getAttribute('href');
    if (href !== null && href.length > 0 && !/^(?:#|javascript:)/i.test(href)) {
      try {
        return { hasNextPage: true, nextPageUrl: new URL(href, pageUrl).toString(), currentPage };
      } catch {
        // fall through to derivation
      }
    }
    const derived = withPage(pageUrl, (currentPage ?? 1) + 1);
    warnings.push(
      `WATCHLIST_NEXT_URL_DERIVED: the page's next control carries no href (client-side pagination), so nextPageUrl was derived from the current page number as ${derived ?? 'nothing'}; confirm the derived page renders different rows before counting it.`,
    );
    return { hasNextPage: true, nextPageUrl: derived, currentPage };
  }
  return { hasNextPage: false, nextPageUrl: null, currentPage };
}

function readTimeLeft(card: Element): string | null {
  let el: Element | null = null;
  try {
    el = card.querySelector(MYEBAY_TIMER_SELECTOR);
  } catch {
    el = null;
  }
  const own = normalizeText(el?.textContent);
  if (own.length > 0 && own.length <= 80 && TIME_LEFT_RE.test(own)) return own;
  const match = TIME_LEFT_RE.exec(normalizeText(card.textContent));
  if (match === null) return null;
  const text = normalizeText(match[0]);
  return text.length > 0 && text.length <= 80 ? text : null;
}

function readStatus(cardBlob: string, timeLeft: string | null): WatchlistItemStatus {
  if (SOLD_RE.test(cardBlob)) return 'sold';
  if (ENDED_RE.test(cardBlob)) return 'ended';
  if (timeLeft !== null) return 'active';
  return 'unknown';
}

function readSellerOffer(cardBlob: string): SellerOfferSnippet | null {
  const match = SELLER_OFFER_RE.exec(cardBlob);
  if (match === null) return null;
  const text = bounded(normalizeText(match[1]!), 160);
  return { text, price: firstMoneyIn(text) };
}

function nullCountsWarning(rows: readonly Record<string, unknown>[], keys: readonly string[], prefix: string): string | null {
  if (rows.length === 0) return null;
  const parts: string[] = [];
  for (const key of keys) {
    const nulls = rows.filter((row) => row[key] === null).length;
    if (nulls === rows.length) parts.push(`${key} on all ${rows.length}`);
  }
  return parts.length === 0 ? null : `${prefix}: ${parts.join(', ')} — the field is either absent from this template or its selector needs pinning against a live capture.`;
}

/**
 * Read a watch-list page. Cards are found from their /itm/ links, so a
 * template the selectors have never seen still yields item ids, URLs and
 * whatever its text says; only the row fields degrade.
 */
export function extractWatchlistPage(document: Document, pageUrl: string, context: MyEbayExtractContext = {}): WatchlistPage {
  const warnings: string[] = [];
  const observedAt = (context.observedAt ?? new Date()).toISOString();
  const candidates: WatchlistCandidate[] = [];
  const converted: Array<{ itemId: string; price: string; from: string }> = [];

  for (const { anchor, itemId, url } of itemAnchors(document, pageUrl)) {
    const card = myEbayCardRoot(anchor);
    const anchorText = normalizeText(anchor.textContent);
    const rawTitle = cardText(card, MYEBAY_TITLE_SELECTOR) ?? (anchorText.length > 0 ? anchorText : null);
    const title = rawTitle === null ? null : cleanTitle(rawTitle);
    const blob = normalizeText(card.textContent);
    const priceText = cardText(card, MYEBAY_PRICE_SELECTOR);
    const elementPrice = money(priceText);
    const snippetPrice = elementPrice ?? firstMoneyIn(blob);
    const convertedFrom = readConvertedFrom(blob);
    if (convertedFrom !== null) {
      converted.push({
        itemId,
        price: snippetPrice === null ? 'no price' : `${snippetPrice.currency} ${snippetPrice.value.toFixed(2)}`,
        from: convertedFrom,
      });
    }
    // A watch-list card that states no format is 'unknown': the overflow
    // render carries no format element, and inferring fixed_price from the
    // price labelled 44 live auctions that way on 2026-09-04. The row's
    // action link ("Bid Now" / "Buy It Now") is the one card-level statement
    // of format the 2026-09-05 template makes, and it is read only when the
    // format vocabulary said nothing.
    const detected = detectCardFormat(card, rawTitle, snippetPrice !== null, {
      inferFixedPriceFromPrice: false,
    });
    const sellingFormat = detected.sellingFormat === 'unknown' ? actionLinkFormat(card) : detected.sellingFormat;
    const bidCount = detected.bidCount;
    const timeLeftText = readTimeLeft(card);
    const status = readStatus(blob, timeLeftText);
    const { seller, sellerText } = sellerFrom(card);
    const shipping = cardText(card, MYEBAY_SHIPPING_SELECTOR);
    const shippingMatch = /((?:free\s+(?:shipping|delivery)|(?:\+\s*)?(?:C\s?\$|US\s?\$|\$)\s?\d[\d,]*(?:\.\d{2})?\s*(?:shipping|delivery|postage)))/i.exec(blob);
    const priceDrop = PRICE_DROP_RE.exec(blob);

    candidates.push({
      itemId,
      url,
      title: title !== null && title.length > 0 ? title : null,
      snippetPrice,
      snippetPriceSource: elementPrice !== null ? 'element' : snippetPrice !== null ? 'text' : null,
      sellingFormat: sellingFormat as SellingFormatKind,
      bidCount,
      shippingSnippetText: shipping ?? (shippingMatch === null ? null : normalizeText(shippingMatch[1]!)),
      itemLocationText: null,
      isNewListing: isNewListingCard(card, rawTitle),
      order: candidates.length,
      timeLeftText,
      endsAt: timeLeftText === null ? null : toIso(observedAt, countdownMs(timeLeftText)),
      watchlistStatus: status,
      seller,
      sellerText,
      sellerOffer: readSellerOffer(blob),
      priceDropText: priceDrop === null ? null : bounded(normalizeText(priceDrop[1]!), 120),
      conditionText: cardText(card, MYEBAY_CONDITION_SELECTOR),
    });
  }

  const pageTitle = documentTitle(document);
  const signedIn = detectSignedIn(document, candidates.length);
  const { categoryChips, ...readTotal } = readTotalCount(document);
  const { count: totalCount, source: totalCountSource } = checkedTotalCount(
    readTotal,
    candidates.length,
    'WATCHLIST_TOTAL_REJECTED',
    warnings,
  );
  // Unstated is "nothing was found", distinct from a found label being
  // rejected above; a chip is not a label, so it never counts as found.
  if (readTotal.count === null && categoryChips > 0) {
    warnings.push(
      `WATCHLIST_TOTAL_UNSTATED: the page renders ${categoryChips} category-filter chips ("<category> (N)", accessible name "Filter Watchlist by category: …, N items") whose counts are per-category, and no list total was found anywhere else on it, so totalResults is null; audit the rows read against a count the page has not stated, never against a chip's count.`,
    );
  }
  const pagination = readPagination(document, pageUrl, warnings);

  if (candidates.length === 0) {
    if (signedIn === false) {
      warnings.push(
        `SIGN_IN_REQUIRED: ${pageUrl} rendered a sign-in wall (title "${pageTitle}"), so the watch list was not read. The research profile's eBay session has expired: sign in once by hand in the automation Chrome (never through the bridge, which blocks sign-in flows) and re-run.`,
      );
    } else if (totalCount === 0) {
      warnings.push(`WATCHLIST_EMPTY: ${pageUrl} states the list holds 0 items (from "${totalCountSource ?? ''}").`);
    } else {
      warnings.push(
        `WATCHLIST_NO_CANDIDATES: no /itm/ links on ${pageUrl} (title "${pageTitle}"${totalCount === null ? '' : `, page states ${totalCount} items`}). Either the list is empty, the cards render only after client-side hydration (retry after browser_wait), or the template links items some other way — take a browser_snapshot and file the structure through the improvement queue with this URL.`,
      );
    }
  } else {
    // Say how much of the page's state and format is unstated, so a walk
    // diffs status and format from item pages, never from these cards.
    const unstatedStatus = candidates.filter((row) => row.watchlistStatus === 'unknown').length;
    if (unstatedStatus > 0) {
      warnings.push(
        `WATCHLIST_STATUS_UNSTATED: ${unstatedStatus} of ${candidates.length} row(s) carry neither an ended/sold badge nor a live countdown, so watchlistStatus is unknown on them — a price is not a status; the item page decides whether each is live, and a diff must never read these rows as active or as a status change.`,
      );
    }
    const unstatedFormat = candidates.filter((row) => row.sellingFormat === 'unknown').length;
    if (unstatedFormat > 0) {
      warnings.push(
        `WATCHLIST_FORMAT_UNSTATED: ${unstatedFormat} of ${candidates.length} row(s) state neither bids nor Buy It Now, so sellingFormat is unknown and bidCount null on them (this template shows no format element; live auctions with bids render exactly like fixed-price rows here) — read format and bids from the item page.`,
      );
    }
    if (converted.length > 0) {
      const rows = converted
        .slice(0, 10)
        .map((row) => `${row.itemId}: ${row.price} converted from ${row.from}`)
        .join('; ');
      warnings.push(
        `WATCHLIST_PRICE_CONVERTED: ${converted.length} of ${candidates.length} row(s) carry eBay's currency-conversion note (${rows}${converted.length > 10 ? '; …' : ''}), so snippetPrice on them is eBay's conversion of the seller's ask at its own rate, not the seller's ask; the item page decides the price and its currency, and a price diff on these rows must allow for the rate moving.`,
      );
    }
    const nullNote = nullCountsWarning(
      candidates as unknown as Record<string, unknown>[],
      ['title', 'snippetPrice', 'timeLeftText', 'seller', 'sellerText', 'shippingSnippetText'],
      'WATCHLIST_FIELDS_NULL',
    );
    if (nullNote !== null) warnings.push(nullNote);
    if (totalCount !== null && totalCount > candidates.length && !pagination.hasNextPage) {
      const derived = withPage(pageUrl, (pagination.currentPage ?? 1) + 1);
      warnings.push(
        `WATCHLIST_PAGINATION_UNKNOWN: the page states ${totalCount} items but rendered ${candidates.length} and no next-page control was recognised. The remaining rows may load on scroll or on a page-size parameter; try ${derived ?? 'a page parameter'} and a larger page size, and never report ${candidates.length} as the whole list.`,
      );
    }
  }

  return {
    candidates,
    pageTitle,
    signedIn,
    totalCount,
    totalCountSource,
    currentPage: pagination.currentPage,
    hasNextPage: pagination.hasNextPage,
    nextPageUrl: pagination.nextPageUrl,
    warnings,
  };
}

const OFFER_FROM_SELLER_RE =
  /\b(?:seller\s+sent|offer\s+from\s+(?:the\s+)?seller|seller'?s?\s+(?:counter)?offer|counter\s*offer\s+from\s+(?:the\s+)?seller|you\s+(?:received|got)\s+an?\s+offer|new\s+offer\s+from)\b/i;
const OFFER_FROM_YOU_RE = /\b(?:you\s+(?:offered|sent|made)|your\s+offer|offer\s+sent|you\s+countered)\b/i;
/**
 * The status token the current bids/offers template puts at the head of
 * every offer row ("OFFER RECEIVED", "OFFER EXPIRED" — 25 of 31 live rows on
 * 2026-09-04, none of which carried any other direction or state wording).
 * Read only at the start of the row's text, where the template renders it;
 * a title is free to contain the words.
 *
 * No word boundary after the token: the live template's elements
 * concatenate with no whitespace in textContent, so the title runs
 * straight on from it ("OFFER RECEIVEDLEGO Star Wars …" — 2026-09-05
 * 12:52Z fire, 31 of 31 rows unread by a \b-anchored pattern on the agent
 * build that carried the fix). The uppercase form is matched as rendered,
 * case-sensitively, so nothing a title starts with can complete it; the
 * mixed-case form still needs a boundary, exactly as before.
 */
const OFFER_PREFIX_RE =
  /^\s*(?:OFFER\s+(RECEIVED|EXPIRED|ACCEPTED|DECLINED|SENT|COUNTERED|RETRACTED|WITHDRAWN)|[Oo]ffer\s+(received|expired|accepted|declined|sent|countered|retracted|withdrawn)\b)/;
const PREFIX_STATUS: Readonly<Record<string, OfferStatus>> = {
  received: 'open',
  expired: 'expired',
  accepted: 'accepted',
  declined: 'declined',
  sent: 'open',
  countered: 'countered',
  retracted: 'retracted',
  withdrawn: 'retracted',
};
/**
 * The operator's own auction bid, which the bids/offers page lists beside
 * the offers ("Your max bid: US $41.00"; 6 of 31 rows on 2026-09-04, exactly
 * the rows with no offer prefix and no offer figure). A bid is not an offer.
 * No leading boundary: the label follows the bid count with no whitespace
 * on the live template ("12 bidsYour max bid: US $41.00").
 */
const BID_ROW_RE = /your\s+max(?:imum)?\s+bid\b/i;
/** A shipping figure on the row, never an offer or an ask. */
const ROW_SHIPPING_FIGURE_RE = new RegExp(String.raw`(?:\+\s*)?${MONEY_SOURCE}\s*(?:shipping|delivery|postage)\b`, 'gi');
const MONEY_GLOBAL_RE = new RegExp(MONEY_SOURCE, 'g');

/** Every distinct non-shipping amount on the row, in order. */
function rowFigures(blob: string): Array<{ value: number; currency: string }> {
  const figures: Array<{ value: number; currency: string }> = [];
  const seen = new Set<string>();
  const text = blob.replace(ROW_SHIPPING_FIGURE_RE, ' ');
  for (const match of text.matchAll(MONEY_GLOBAL_RE)) {
    const parsed = money(match[0]);
    if (parsed === null) continue;
    const key = `${parsed.currency} ${parsed.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    figures.push(parsed);
    if (figures.length === 4) break;
  }
  return figures;
}
const OFFER_STATUS_RES: ReadonlyArray<[OfferStatus, RegExp]> = [
  ['accepted', /\baccepted\b/i],
  ['declined', /\b(?:declined|rejected)\b/i],
  ['expired', /\bexpired\b/i],
  ['retracted', /\b(?:retracted|withdrawn|cancelled|canceled)\b/i],
  ['countered', /\bcounter(?:ed|\s*offer)\b/i],
  ['open', /\b(?:pending|awaiting|respond|review\s+offer|accept\s+offer|expires?\s+(?:in|on)|time\s+left|\d+\s*[dhm]\s+left)\b/i],
];
/**
 * "offer: US $165.00", "You offered US $950.00", "Counteroffer from seller:
 * C $2.75", "offer of $12". The who-sent-it phrase between the offer word
 * and the amount is skipped, never read here (direction has its own rules).
 *
 * "Best Offer" is the listing FEATURE, not an offer: "Make Best offer
 * C $65.00" and "or Best Offer C $65.00" put the listing's ask right after
 * the word, and on 2026-09-04 every one of 25 live rows had its ask read
 * as offerPrice that way (proven against the item pages: offerPrice ==
 * itemPrice to the cent). The lookbehind keeps the feature label out.
 */
const OFFER_AMOUNT_RE = new RegExp(
  String.raw`(?<!\bbest\s)(?:counter\s*offer|offer(?:ed)?(?:\s+price)?)\s*(?:from\s+(?:the\s+)?seller|from\s+you|to\s+you|sent)?\s*[:\-–]?\s*(?:of\s+|for\s+|at\s+)?(${MONEY_SOURCE})`,
  'i',
);
/**
 * The listing's Best Offer control as My eBay renders it: an invitation,
 * not an offer. No leading word boundary: adjacent elements concatenate
 * with no whitespace in textContent ("…shippingMake Best offer").
 */
const BEST_OFFER_CONTROL_RE = /make\s+(?:an?\s+)?(?:best\s+)?offer\b|\bor\s+best\s+offer\b|\bbest\s+offer\s+(?:available|accepted\s+here)\b/i;
/** A row that holds an offer thread the template shows only as a link into it. */
const OFFER_THREAD_RE = /view\s+offers?\s+details?\b|\boffer\s+details\b|view\s+offers?\b|respond\s+to\s+offer\b/i;
const DURATION_SOURCE = String.raw`(?:\d+\s*(?:d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?)\s*)+`;
/**
 * "Expires in 1d 22h", "expires on Sep 5, 2026 at 3:00 pm", "1d 4h left".
 * Each form captures only its own tokens; the free-text tail a bounded
 * character class used to allow ran into the next line of the row.
 */
const EXPIRES_RE = new RegExp(
  String.raw`((?:expires?|expiring|valid)\s+(?:in|for)\s+${DURATION_SOURCE}|(?:expires?|expiring|valid)\s+(?:on|until)\s+[A-Za-z]{3,9}\.?\s+\d{1,2}(?:,?\s*\d{4})?(?:\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:[ap]\.?m\.?)?)?|${DURATION_SOURCE}left)`,
  'i',
);

/**
 * Read the bids/offers page. Every row is keyed on its /itm/ link; the
 * amount, direction, status and expiry are read from the row's own text.
 * A row whose direction cannot be told is kept as 'unknown' rather than
 * dropped — Track O counts and reports every row it saw.
 */
export function extractOffersPage(document: Document, pageUrl: string, context: MyEbayExtractContext = {}): OffersPage {
  const warnings: string[] = [];
  const observedAt = (context.observedAt ?? new Date()).toISOString();
  const candidates: OfferCandidate[] = [];
  const bidRowIds: string[] = [];
  let orderedByValue = 0;

  for (const { anchor, itemId, url } of itemAnchors(document, pageUrl)) {
    const card = myEbayCardRoot(anchor);
    const anchorText = normalizeText(anchor.textContent);
    const rawTitle = cardText(card, MYEBAY_TITLE_SELECTOR) ?? (anchorText.length > 0 ? anchorText : null);
    const title = rawTitle === null ? null : cleanTitle(rawTitle);
    const blob = normalizeText(card.textContent);
    const amount = OFFER_AMOUNT_RE.exec(blob);
    let offerPrice = amount === null ? null : money(amount[1]!);
    // The listing's own price is whatever other figure the row renders.
    let listPrice: { value: number; currency: string } | null = null;
    const rest = amount === null ? blob : blob.replace(amount[0], ' ');
    const priceCell = cardText(card, MYEBAY_PRICE_SELECTOR);
    listPrice = money(priceCell) ?? firstMoneyIn(rest);
    const prefixMatch = OFFER_PREFIX_RE.exec(blob);
    const prefix = (prefixMatch?.[1] ?? prefixMatch?.[2])?.toLowerCase() ?? null;
    let direction: OfferDirection = OFFER_FROM_SELLER_RE.test(blob) ? 'from_seller' : OFFER_FROM_YOU_RE.test(blob) ? 'from_you' : 'unknown';
    let offerStatus: OfferStatus = 'unknown';
    for (const [status, re] of OFFER_STATUS_RES) {
      if (re.test(blob)) {
        offerStatus = status;
        break;
      }
    }
    if (prefix !== null) {
      // The template's own status token outranks the free-text guesses.
      offerStatus = PREFIX_STATUS[prefix] ?? offerStatus;
      if (direction === 'unknown') {
        // "OFFER RECEIVED" is a seller's offer to the operator by
        // definition. "OFFER EXPIRED" was the seller's too on every one of
        // the 19 live rows (the operator's own lapsed offers say "You
        // offered", which the wording check above reads first). "OFFER
        // SENT" is the operator's. Anything else keeps its direction unknown.
        direction = prefix === 'sent' ? 'from_you' : prefix === 'received' || prefix === 'expired' ? 'from_seller' : 'unknown';
      }
    }
    const isBidRow = prefix === null && offerPrice === null && direction === 'unknown' && BID_ROW_RE.test(blob);
    if (isBidRow) {
      // The operator's own auction bid: no offer exists on the row, and
      // none of its figures (the max bid, the current price) is an offer.
      direction = 'from_you';
      offerStatus = 'none';
      bidRowIds.push(itemId);
    }
    // A row that renders the Best Offer control and nothing about an offer
    // — no amount, no sender, no thread link, no state — has no offer on
    // it. The 2026-09-04 fires reported 25 such rows as received offers
    // priced at the seller's own ask; 'none' is the honest state.
    if (
      offerStatus === 'unknown' &&
      offerPrice === null &&
      direction === 'unknown' &&
      BEST_OFFER_CONTROL_RE.test(blob) &&
      !OFFER_THREAD_RE.test(blob)
    ) {
      offerStatus = 'none';
    }
    // On an offer row the offer is never the higher of two figures. The
    // 2026-09-04 template labels neither amount ("OFFER RECEIVED … C $72.24
    // … C $84.99 Make offer"), and an older reading took the ask for the
    // offer on 25 of 25 rows; whichever way the figures are labelled or
    // unlabelled, the lower is the offer and the higher the ask.
    const isOfferRow = !isBidRow && (prefix !== null || direction !== 'unknown');
    if (isOfferRow) {
      const figures = rowFigures(blob);
      if (offerPrice === null && figures.length === 2 && figures[0]!.currency === figures[1]!.currency) {
        const [low, high] = figures[0]!.value <= figures[1]!.value ? [figures[0]!, figures[1]!] : [figures[1]!, figures[0]!];
        offerPrice = low;
        listPrice = high;
        orderedByValue += 1;
      } else if (
        offerPrice !== null &&
        listPrice !== null &&
        offerPrice.currency === listPrice.currency &&
        offerPrice.value > listPrice.value
      ) {
        [offerPrice, listPrice] = [listPrice, offerPrice];
        orderedByValue += 1;
      }
    }
    const expires = EXPIRES_RE.exec(blob);
    const expiresText = expires === null ? null : bounded(normalizeText(expires[1]!), 60);
    const { seller, sellerText } = sellerFrom(card);
    candidates.push({
      itemId,
      url,
      title: title !== null && title.length > 0 ? title : null,
      offerPrice,
      listPrice: listPrice !== null && offerPrice !== null && listPrice.value === offerPrice.value ? null : listPrice,
      direction,
      offerStatus,
      expiresText,
      // Only a relative expiry ("in 1d 22h", "3h left") becomes an instant; a
      // dated one stays text, because the row states no timezone for it.
      expiresAt:
        expiresText === null || /\b(?:on|until)\b/i.test(expiresText) ? null : toIso(observedAt, durationMs(expiresText)),
      seller,
      sellerText,
      snippet: bounded(blob),
      order: candidates.length,
    });
  }

  const pageTitle = documentTitle(document);
  const signedIn = detectSignedIn(document, candidates.length);
  const { count: totalCount, source: totalCountSource } = checkedTotalCount(
    readTotalCount(document),
    candidates.length,
    'OFFERS_TOTAL_REJECTED',
    warnings,
  );
  const pagination = readPagination(document, pageUrl, warnings);

  if (candidates.length === 0) {
    if (signedIn === false) {
      warnings.push(
        `SIGN_IN_REQUIRED: ${pageUrl} rendered a sign-in wall (title "${pageTitle}"), so no offers were read. Sign in once by hand in the automation Chrome and re-run.`,
      );
    } else {
      warnings.push(
        `OFFERS_NO_ROWS: no /itm/ links on ${pageUrl} (title "${pageTitle}"). Either there are no offers, the rows render after client-side hydration (retry after browser_wait), or the template links items some other way — take a browser_snapshot and file the structure through the improvement queue with this URL.`,
      );
    }
  } else {
    if (bidRowIds.length > 0) {
      const ids = bidRowIds.slice(0, 10).join(', ');
      warnings.push(
        `OFFERS_BID_ROWS: ${bidRowIds.length} of ${candidates.length} row(s) are the operator's own auction bids ("Your max bid"; ids: ${ids}${bidRowIds.length > 10 ? ', …' : ''}) — not offers: direction from_you, offerStatus none, and no figure on them is an offer amount.`,
      );
    }
    if (orderedByValue > 0) {
      warnings.push(
        `OFFERS_AMOUNTS_ORDERED_BY_VALUE: ${orderedByValue} of ${candidates.length} row(s) carry two amounts with no wording that labels the offer, or label the higher one as the offer; an offer is never above the ask, so on them offerPrice is the lower figure and listPrice the higher (proven 2026-09-04 against three item pages, where the higher figure was the listing's own ask).`,
      );
    }
    const bidRows = new Set(bidRowIds);
    const noOffer = candidates.filter((row) => row.offerStatus === 'none' && !bidRows.has(row.itemId));
    if (noOffer.length > 0) {
      warnings.push(
        `OFFERS_NO_OFFER_THREAD: ${noOffer.length} of ${candidates.length} row(s) carry only the listing's Best Offer control ("Make Best offer") and no offer wording, so no offer exists on them (offerStatus none); the figure beside the control is the listing's ask (listPrice), never an offer amount.`,
      );
    }
    const threadUnread = candidates.filter((row) => row.offerStatus !== 'none' && row.offerPrice === null && OFFER_THREAD_RE.test(row.snippet));
    if (threadUnread.length > 0) {
      const ids = threadUnread.slice(0, 10).map((row) => row.itemId).join(', ');
      warnings.push(
        `OFFERS_THREAD_UNREAD: ${threadUnread.length} row(s) link an offer thread ("View offer details") but this template renders neither its amount, direction nor expiry in the row (ids: ${ids}${threadUnread.length > 10 ? ', …' : ''}); open the thread by hand or take a browser_snapshot of one such row and file it under site-ebay extractor_defect offers-template-unpinned so the selectors can be pinned.`,
      );
    }
    const unknownDirection = candidates.filter((row) => row.direction === 'unknown' && row.offerStatus !== 'none').length;
    if (unknownDirection > 0) {
      warnings.push(
        `OFFERS_DIRECTION_UNKNOWN: ${unknownDirection} of ${candidates.length} row(s) carry no seller-sent/you-sent wording; read each row's snippet before treating it as a received offer.`,
      );
    }
    const nullNote = nullCountsWarning(
      candidates as unknown as Record<string, unknown>[],
      ['title', 'offerPrice', 'expiresText', 'seller'],
      'OFFERS_FIELDS_NULL',
    );
    if (nullNote !== null) warnings.push(nullNote);
    if (totalCount !== null && totalCount > candidates.length && !pagination.hasNextPage) {
      warnings.push(
        `OFFERS_PAGINATION_UNKNOWN: the page states ${totalCount} rows ("${totalCountSource ?? ''}") but rendered ${candidates.length} and no next-page control was recognised. The remaining rows may sit behind a page-size control at the foot of the list or a filter tab; report the read as ${candidates.length} of ${totalCount}, never as complete.`,
      );
    }
  }

  return {
    candidates,
    pageTitle,
    signedIn,
    totalCount,
    totalCountSource,
    hasNextPage: pagination.hasNextPage,
    nextPageUrl: pagination.nextPageUrl,
    warnings,
  };
}

/** Canonical URL of the current-experience watch list, sorted by ending soonest. */
export function buildWatchlistUrl(domain: 'ebay.ca' | 'ebay.com' = 'ebay.ca', page = 1): string {
  const url = new URL(`https://www.${domain}/mye/myebay/watchlist`);
  if (page > 1) url.searchParams.set('page', String(page));
  return url.toString();
}

/** Canonical URL of the current-experience bids/offers page. */
export function buildOffersUrl(domain: 'ebay.ca' | 'ebay.com' = 'ebay.ca'): string {
  return `https://www.${domain}/mye/myebay/bidsoffers`;
}
