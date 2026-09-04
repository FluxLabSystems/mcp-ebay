/**
 * ebay.ca.v1 listing extraction — SDD v0.5 FR-08, §20.2/§20.3. Extraction
 * layers: schema.org JSON-LD (source "jsonld"), live DOM selectors
 * (source "dom"), Open Graph metadata (source "meta"), and computed
 * normalizations (source "computed"). Search-results snippets are never
 * accepted as canonical listing evidence.
 */
import { canonicalListingUrl, cleanTitle, itemIdFromUrl, normalizePostalCode, parseMoney, postalCodesMatch } from './normalize.js';
import { EBAY_DESTINATION_POSTAL_CODE, EBAY_PROFILE_REVISION } from './profile.js';
import type { ExtractionRecord, FieldSource, ListingStatus } from './record.js';

export interface ExtractContext {
  /** Postal code destination-resolved shipping must match (§20.1). */
  expectedPostalCode?: string;
  /**
   * Result of the live destination verification flow (§20.1 step 4-5):
   * the destination indicator re-read from rendered page state. When
   * absent, the extractor derives it from DOM text alone.
   */
  verifiedDestination?: { postalCode: string; verified: boolean } | undefined;
  observedAt?: Date;
  pageRevision?: number;
}

export interface ExtractOutcome {
  record: ExtractionRecord;
  warnings: string[];
}

interface JsonLdProduct {
  name?: string;
  image?: string | string[];
  sku?: string;
  offers?: {
    price?: string | number;
    priceCurrency?: string;
    priceValidUntil?: string;
    availability?: string;
    url?: string;
    seller?: { name?: string };
  };
}

function readJsonLdProduct(document: Document): JsonLdProduct | null {
  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  for (const script of scripts) {
    const rawText = script.textContent ?? '';
    if (!rawText.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      continue;
    }
    const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const candidate of candidates) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const record = candidate as Record<string, unknown>;
      const type = record['@type'];
      const typeMatches =
        type === 'Product' || (Array.isArray(type) && type.includes('Product'));
      if (typeMatches) {
        const offersRaw = record.offers;
        const offers = Array.isArray(offersRaw) ? offersRaw[0] : offersRaw;
        return {
          name: typeof record.name === 'string' ? record.name : undefined,
          image: record.image as string | string[] | undefined,
          sku: typeof record.sku === 'string' ? record.sku : undefined,
          offers: typeof offers === 'object' && offers !== null ? (offers as JsonLdProduct['offers']) : undefined,
        };
      }
    }
  }
  return null;
}

function textOf(document: Document, selector: string): string | null {
  try {
    const el = document.querySelector(selector);
    const text = el?.textContent?.replace(/\s+/g, ' ').trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function metaContent(document: Document, property: string): string | null {
  const el =
    document.querySelector(`meta[property="${property}"]`) ?? document.querySelector(`meta[name="${property}"]`);
  const value = el?.getAttribute('content')?.trim();
  return value && value.length > 0 ? value : null;
}

const TITLE_SELECTORS = ['h1.x-item-title__mainTitle', '.x-item-title__mainTitle', 'h1[data-testid="x-item-title"]', 'h1'];
const PRICE_SELECTORS = ['.x-price-primary', '[data-testid="x-price-primary"]', '#prcIsum', '#mm-saleDscPrc'];
const SELLER_SELECTORS = [
  '.x-sellercard-atf__info__about-seller a',
  '[data-testid="x-sellercard-atf"] a',
  '.x-sellercard-atf a[href*="/usr/"]',
  'a[href*="/usr/"]',
  'a[href*="/str/"]',
  '#mbgLink',
];
const SHIPPING_SELECTORS = [
  '.ux-labels-values--shipping .ux-labels-values__values',
  '[data-testid="ux-labels-values--shipping"] .ux-labels-values__values',
  '.d-shipping-minview .ux-labels-values__values',
  '#fshippingCost',
  '#shSummary',
];
const DELIVERY_SELECTORS = [
  '.ux-labels-values--deliverto .ux-labels-values__values',
  '.ux-labels-values--delivery .ux-labels-values__values',
  '[data-testid="ux-labels-values--delivery"] .ux-labels-values__values',
  '.vim-delivery-module',
];
const ITEM_LOCATION_SELECTORS = [
  '.ux-labels-values--itemLocation .ux-labels-values__values',
  '[data-testid="ux-labels-values--itemLocation"] .ux-labels-values__values',
  '.ux-labels-values--location .ux-labels-values__values',
  // Newer templates nest the value one level deeper, or render the row with
  // no __values wrapper at all; the whole-row reads work because
  // readItemLocation strips the "Item location:"/"Located in:" label off.
  '.ux-labels-values--itemLocation .ux-labels-values__values-content',
  '.ux-labels-values--itemLocation',
  '[data-testid="ux-labels-values--itemLocation"]',
  '#itemLocation',
  '.vi-acc-del-range',
];
const WATCHER_SELECTORS = [
  '.x-quantity__watchcount',
  '[data-testid="x-watch-count"]',
  '.ux-watchcount',
  '.vi-notify-new-bg-vi',
  '#vi-notify-new-bg-vi',
];
const QUANTITY_SELECTORS = [
  '.x-quantity__availability',
  '[data-testid="x-quantity"]',
  '.d-quantity__availability',
  '#qtySubTxt',
  '.vi-quantity-wrapper',
];
const TIMER_SELECTORS = [
  '.ux-timer__text',
  '[data-testid="x-timer"]',
  '.ux-timer',
  '.x-timer',
  '#vi-cdown_timeLeft',
  '.vi-tm-left',
  '.timeMs',
];
/** Epoch-ms (or epoch-s) attributes eBay hangs a live countdown off. */
const END_TIME_ATTRIBUTES = [
  'timems',
  'data-enddate',
  'data-end-date',
  'data-endtime',
  'data-end-time',
  'data-time-end',
];

const SOLD_MARKERS = ['this listing sold', 'item sold', 'sold for', 'winning bid', 'sold on '];
const ENDED_MARKERS = [
  'this listing has ended',
  'this listing was ended',
  'bidding has ended',
  'this listing ended',
  'the listing has ended',
  'bidding ended',
  'auction has ended',
  'ended on ',
  'no longer available for purchase',
];
const UNAVAILABLE_MARKERS = [
  'the item you selected is unavailable',
  'this listing is unavailable',
  "we looked everywhere",
  'listing is no longer available',
];

/**
 * Status banners have moved around eBay's markup more than once, and a
 * selector list that misses the current one returns 'unknown' for a plainly
 * ended listing -- which reads as "could not tell" rather than "over".
 * Widened, and backed by a bounded scan of the page's leading text when no
 * banner element matches: markers are whole sentences specific enough that a
 * related-items strip does not trip them.
 */
const STATUS_SELECTORS = [
  '.ux-message__title',
  '.ux-message',
  '.ux-statusmessage',
  '[data-testid="ux-message"]',
  '[data-testid="x-status-message"]',
  '.x-status-message',
  '.vi-status',
  '#vi-esc-cnt',
  '.statusMessage',
  '.vim-status',
  '#msgPanel',
];

const BID_COUNT_SELECTORS = [
  '.x-bid-count',
  '[data-testid="x-bid-count"]',
  '#qty-test-bid-count',
  '.vi-bidCount',
  '#qty-test',
  '.x-quantity__availability--bidcount',
];
const BIN_SELECTORS = ['#binBtn_btn', '[data-testid="x-bin-action"]', '.x-bin-action', '.vi-bin-btn'];
/** Where price/format live; scanned instead of the whole page so a
 *  "Buy It Now" in a related-items strip cannot flip an auction. */
const FORMAT_SCOPE_SELECTORS = [
  '.x-buybox',
  '[data-testid="x-buybox"]',
  '.vim-buybox',
  '#CenterPanelInternal',
  '.x-price-primary',
  '#mainContent',
];

/**
 * Narrower than FORMAT_SCOPE_SELECTORS on purpose. #mainContent holds the
 * similar-items strip, and every card in it says "Buy It Now" about some
 * other listing -- deciding whether THIS listing can still be bought has to
 * look only where its own controls render.
 */
const BUYBOX_SCOPE_SELECTORS = [
  '.x-buybox',
  '[data-testid="x-buybox"]',
  '.vim-buybox',
  '.x-buybox-cta',
  '.x-bin-action',
];

function scopedText(document: Document, selectors: readonly string[]): string {
  const chunks: string[] = [];
  for (const selector of selectors) {
    try {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        const text = el.textContent;
        if (text) chunks.push(text);
      }
    } catch {
      continue;
    }
  }
  return chunks.join(' ').replace(/\s+/g, ' ');
}

function detectSellingFormat(document: Document): ExtractionRecord['sellingFormat'] {
  const scoped: string[] = [];
  for (const selector of FORMAT_SCOPE_SELECTORS) {
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const text = el.textContent ?? '';
      if (text) scoped.push(text);
    }
  }
  const scopedHit = scoped.length > 0;
  const blob = (scopedHit ? scoped.join(' ') : (document.body?.textContent ?? '')).replace(/\s+/g, ' ');

  let bidCount: number | null = null;
  for (const selector of BID_COUNT_SELECTORS) {
    const text = textOf(document, selector);
    const match = text ? /(\d{1,5})\s*bids?\b/i.exec(text) : null;
    if (match) {
      bidCount = Number.parseInt(match[1]!, 10);
      break;
    }
  }
  if (bidCount === null) {
    const match = /\b(\d{1,5})\s*bids?\b/i.exec(blob);
    if (match) bidCount = Number.parseInt(match[1]!, 10);
  }

  const hasAuction = bidCount !== null || /\bplace\s+bid\b|\bcurrent\s+bid\b|\bstarting\s+bid\b/i.test(blob);
  const hasBin =
    BIN_SELECTORS.some((selector) => document.querySelector(selector) !== null) || /\bbuy\s+it\s+now\b/i.test(blob);

  let kind: ExtractionRecord['sellingFormat']['kind'];
  if (hasAuction && hasBin) kind = 'auction_with_bin';
  else if (hasAuction) kind = 'auction';
  else if (hasBin) kind = 'fixed_price';
  else kind = 'unknown';

  // A fixed-price page often renders no "Buy It Now" string at all -- the
  // absence of any auction signal on a page that has a price is the tell.
  if (kind === 'unknown' && PRICE_SELECTORS.some((selector) => textOf(document, selector) !== null)) {
    kind = 'fixed_price';
  }

  return {
    kind,
    bidCount,
    source: 'dom',
    // Unscoped fallback saw the whole page, so trust it less.
    confidence: kind === 'unknown' ? 0.3 : scopedHit ? 0.9 : 0.6,
  };
}

const PURCHASE_CONTROL_SELECTORS = [
  ...BIN_SELECTORS,
  '#bidBtn_btn',
  '[data-testid="x-bid-action"]',
  '.x-bid-action',
  '[data-testid="x-atc-action"]',
  '.x-atc-action',
];
const PURCHASE_TEXT_RE = /\bplace\s+bid\b|\bbuy\s+it\s+now\b|\badd\s+to\s+cart\b|\bconfirm\s+and\s+pay\b/i;

/** Whether the page still offers a way to bid on or buy this listing. */
function hasPurchaseAffordance(document: Document): boolean {
  for (const selector of PURCHASE_CONTROL_SELECTORS) {
    try {
      if (document.querySelector(selector) !== null) return true;
    } catch {
      continue;
    }
  }
  return PURCHASE_TEXT_RE.test(scopedText(document, BUYBOX_SCOPE_SELECTORS));
}

/**
 * The ended-item template carries no banner sentence ENDED_MARKERS matches:
 * it swaps the buybox for a link back to the original listing and an offer to
 * relist, and nothing else says the listing is over. Neither phrase is
 * trusted on its own -- eBay shows "Sell one like this" to a seller on their
 * own running listing -- so the rule is the affordance TOGETHER WITH a buybox
 * that offers no way to bid or buy. Both halves are needed: the phrase alone
 * ends live listings, and missing controls alone would end every page whose
 * buybox markup we failed to recognize.
 */
const ENDED_TEMPLATE_PHRASES = ['see original listing', 'sell one like this'];

function hasEndedTemplateAffordance(document: Document): boolean {
  try {
    for (const control of Array.from(document.querySelectorAll('a[href], button'))) {
      // eBay only builds an orig_cvip link for a listing that is over, so the
      // href carries the signal structurally even where the label is localized.
      if (/[?&]orig_cvip=true\b/i.test(control.getAttribute('href') ?? '')) return true;
      const label = (control.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      // A wrapper anchor's textContent is the whole card it wraps; only a
      // short label is the affordance itself.
      if (label.length === 0 || label.length > 64) continue;
      if (ENDED_TEMPLATE_PHRASES.some((phrase) => label.includes(phrase))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function detectListingStatus(document: Document): ListingStatus {
  const chunks: string[] = [];
  for (const selector of STATUS_SELECTORS) {
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const text = el.textContent?.toLowerCase() ?? '';
      if (text) chunks.push(text);
    }
  }
  if (chunks.length === 0) {
    // No banner element matched. Fall back to the first stretch of body text,
    // where any such banner renders, rather than the whole document.
    const body = (document.body?.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (body) chunks.push(body.slice(0, 2000));
  }
  const blob = chunks.join(' ');
  // Sold is checked first: a sold listing also says it ended.
  if (SOLD_MARKERS.some((marker) => blob.includes(marker))) return 'sold';
  if (ENDED_MARKERS.some((marker) => blob.includes(marker))) return 'ended';
  if (UNAVAILABLE_MARKERS.some((marker) => blob.includes(marker))) return 'unavailable';
  // No banner sentence anywhere. Read the template's shape instead, before
  // falling through to "it has a title and a price, so it must be live".
  if (hasEndedTemplateAffordance(document) && !hasPurchaseAffordance(document)) return 'ended';
  const hasTitle = TITLE_SELECTORS.some((selector) => textOf(document, selector) !== null);
  const hasPrice = PRICE_SELECTORS.some((selector) => textOf(document, selector) !== null);
  if (hasTitle && hasPrice) return 'active';
  return hasTitle ? 'unknown' : 'unavailable';
}

const POSTAL_IN_TEXT = /\b([A-Za-z]\d[A-Za-z])\s?(\d[A-Za-z]\d)\b/;

/** Read the delivery-destination indicator postal code from rendered DOM (§20.1). */
export function readDestinationPostal(document: Document): string | null {
  for (const selector of DELIVERY_SELECTORS) {
    const text = textOf(document, selector);
    if (!text) continue;
    const match = POSTAL_IN_TEXT.exec(text);
    if (match) return normalizePostalCode(`${match[1]}${match[2]}`);
  }
  // Fallback: scan shipping module text for "to <postal>".
  for (const selector of SHIPPING_SELECTORS) {
    const text = textOf(document, selector);
    if (!text) continue;
    const toMatch = /\bto\s+([A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d)\b/.exec(text);
    if (toMatch) return normalizePostalCode(toMatch[1]!);
  }
  return null;
}

const OFFER_CONTROL_SELECTORS = ['.x-offer-action', '[data-testid="x-offer-action"]', '#boBtn_btn', '.vi-bo-btn'];
const OFFER_TEXT_RE = /\b(?:make\s+offer|best\s+offer)\b/i;

/**
 * Best Offer availability, read from the offer control or the buybox around
 * it. It used to be a regex over document.body.textContent, which answered
 * true for every listing including plain auctions: body text on an item page
 * also carries the similar-items strip -- whose cards each say "or Best
 * Offer" about some other listing -- and, because textContent includes
 * <script>, the page's own inline i18n bundle, which ships the phrase whether
 * or not anything renders it. Same failure mode body-text scanning produced
 * for listing status. A template whose offer control we do not recognize now
 * reads false rather than true, which is the cheaper error: a missed offer
 * costs a negotiation, a phantom one costs a listing opened for nothing.
 */
function detectOfferAvailable(document: Document): boolean {
  for (const selector of OFFER_CONTROL_SELECTORS) {
    try {
      if (document.querySelector(selector) !== null) return true;
    } catch {
      continue;
    }
  }
  return OFFER_TEXT_RE.test(scopedText(document, BUYBOX_SCOPE_SELECTORS));
}

function isoFromEpoch(raw: string): string | null {
  const digits = raw.trim();
  if (!/^\d{10,14}$/.test(digits)) return null;
  // 10-digit values are seconds, 13-digit milliseconds. Anything landing
  // outside a plausible window is a different number wearing the same
  // attribute name.
  const parsed = Number.parseInt(digits, 10);
  const date = new Date(digits.length <= 11 ? parsed * 1000 : parsed);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  return year >= 2000 && year <= 2100 ? date.toISOString() : null;
}

/**
 * Only a timestamp that names its own zone is usable. A bare "2026-09-03"
 * has no minute in it, and a zoneless "2026-09-03 18:30" would be read in
 * whatever timezone the agent happens to run in -- an end time that moves
 * with the reader is worse than no end time at all.
 */
function isoFromTimestamp(raw: string): string | null {
  const text = raw.trim();
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** "5d 04h left", "Ends in 2d 03h 15m", "Time left: 1h 12m 30s". */
const COUNTDOWN_CONTEXT_RE = /\bleft\b|\bends?\s+in\b|\btime\s+left\b|\bending\s+in\b/i;

/**
 * Milliseconds a rendered countdown ("5d 04h left", "Ends in 2d 03h 15m")
 * has to run; null when the text carries no countdown phrase, because
 * without one the digits are a clock time or a date, not a duration, and
 * adding them to now would invent an end. Exported for the My eBay
 * watchlist cards, which render the same countdown vocabulary.
 */
export function countdownMs(text: string): number | null {
  if (!COUNTDOWN_CONTEXT_RE.test(text)) return null;
  const days = /(\d+)\s*d(?:ays?)?\b/i.exec(text);
  const hours = /(\d+)\s*h(?:ours?|rs?)?\b/i.exec(text);
  const minutes = /(\d+)\s*m(?:in(?:ute)?s?)?\b/i.exec(text);
  const seconds = /(\d+)\s*s(?:ec(?:ond)?s?)?\b/i.exec(text);
  if (days === null && hours === null && minutes === null && seconds === null) return null;
  const unit = (match: RegExpExecArray | null): number => (match === null ? 0 : Number.parseInt(match[1]!, 10));
  return ((unit(days) * 24 + unit(hours)) * 60 + unit(minutes)) * 60_000 + unit(seconds) * 1000;
}

/**
 * A rendered countdown phrase, bounded to the units and the word that makes
 * them a countdown: "Ends in 1d 3h 22m", "2d 05h left", "Time left: 1h 12m".
 * The context word is required — bare "1d 3h" is a duration in a shipping
 * estimate as easily as in an auction. Kept to one phrase so a text scan
 * never returns a module.
 */
const COUNTDOWN_UNITS = String.raw`(?:\d{1,3}\s*(?:d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\b\s*)+`;
const COUNTDOWN_PHRASE_RE = new RegExp(
  String.raw`\b(?:(?:ends?|ending|closes?)\s+in\s*:?\s*${COUNTDOWN_UNITS}|time\s+left\s*:?\s*${COUNTDOWN_UNITS}|${COUNTDOWN_UNITS}left\b)`,
  'i',
);

/**
 * The countdown as text inside the modules that describe THIS listing's
 * sale, for pages where no timer element matches. The 2026-09-04 deals fire
 * extracted 328 item pages and got endsAt null on 326 of them — live
 * auctions with 17–22 bids included, their bid counts read from the very
 * buy box the countdown renders in — because the timer selectors name
 * templates the common one no longer uses. The buy box is scanned first;
 * failing that, the price/format modules, but never #mainContent, whose
 * similar-items and promo strips say "ends in" about other things.
 * NEEDS-LIVE-VERIFICATION: the common template's timer markup has not been
 * captured; when it is, a selector goes into TIMER_SELECTORS and this scan
 * stops being the path that finds it.
 */
const COUNTDOWN_TEXT_SCOPE_SELECTORS = FORMAT_SCOPE_SELECTORS.filter((selector) => selector !== '#mainContent');

function scanCountdownText(document: Document): string | null {
  for (const scope of [BUYBOX_SCOPE_SELECTORS, COUNTDOWN_TEXT_SCOPE_SELECTORS]) {
    const text = scopedText(document, scope).replace(/[\u00a0\u202f]/g, ' ');
    if (text.trim().length === 0) continue;
    const match = COUNTDOWN_PHRASE_RE.exec(text);
    if (match !== null) return match[0].replace(/\s+/g, ' ').trim();
  }
  return null;
}

function timerElements(document: Document): Element[] {
  const found: Element[] = [];
  for (const selector of TIMER_SELECTORS) {
    try {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (!found.includes(el)) found.push(el);
      }
    } catch {
      continue;
    }
  }
  return found;
}

/**
 * When the listing closes, in the order the value can be trusted: a timestamp
 * the page states outright, then schema.org, then the rendered countdown.
 * The countdown is a derivation and says so -- "5d 04h left" is an hour wide,
 * so a value computed from it is 'computed' and carries less confidence than
 * anything read directly.
 */
function readEndTime(
  document: Document,
  jsonld: JsonLdProduct | null,
  observedAt: string,
): {
  endsAt: ExtractionRecord['endsAt'];
  timeLeftText: ExtractionRecord['timeLeftText'];
  /** True when the countdown came from a text scan, not a timer element. */
  fromText: boolean;
} {
  const timers = timerElements(document);

  let timeLeftText: ExtractionRecord['timeLeftText'] = null;
  for (const el of timers) {
    const text = el.textContent?.replace(/\s+/g, ' ').trim();
    // A timer wrapper's textContent is the countdown plus whatever sits
    // beside it; a string that long is a module, not a countdown.
    if (text !== undefined && text.length > 0 && text.length <= 120) {
      timeLeftText = { value: text, source: 'dom', confidence: 0.95 };
      break;
    }
  }
  // No timer element on this template: the countdown, if the buy box
  // renders one, is unlabelled text. Read from text it trusts itself less
  // than a timer element and the end time derived from it less again.
  let fromText = false;
  if (timers.length === 0) {
    const phrase = scanCountdownText(document);
    if (phrase !== null) {
      timeLeftText = { value: phrase, source: 'dom', confidence: 0.8 };
      fromText = true;
    }
  }

  for (const el of timers) {
    for (const attribute of END_TIME_ATTRIBUTES) {
      const raw = el.getAttribute(attribute);
      const iso = raw === null ? null : (isoFromEpoch(raw) ?? isoFromTimestamp(raw));
      if (iso !== null) return { endsAt: { value: iso, source: 'dom', confidence: 0.97 }, timeLeftText, fromText };
    }
    let time: Element | null = null;
    try {
      time = el.matches('time[datetime]') ? el : el.querySelector('time[datetime]');
    } catch {
      time = null;
    }
    const iso = time === null ? null : isoFromTimestamp(time.getAttribute('datetime') ?? '');
    if (iso !== null) return { endsAt: { value: iso, source: 'dom', confidence: 0.97 }, timeLeftText, fromText };
  }

  // priceValidUntil is the closest thing schema.org gives an auction close,
  // and only counts when it carries a time of day.
  const validUntil = jsonld?.offers?.priceValidUntil;
  const fromJsonLd = validUntil === undefined ? null : isoFromTimestamp(validUntil);
  if (fromJsonLd !== null) {
    return { endsAt: { value: fromJsonLd, source: 'jsonld', confidence: 0.85 }, timeLeftText, fromText };
  }

  const delta = timeLeftText === null ? null : countdownMs(timeLeftText.value);
  if (delta !== null) {
    return {
      endsAt: {
        value: new Date(Date.parse(observedAt) + delta).toISOString(),
        source: 'computed',
        confidence: fromText ? 0.5 : 0.6,
      },
      timeLeftText,
      fromText,
    };
  }
  return { endsAt: null, timeLeftText, fromText };
}

/**
 * eBay's delivery-estimate disclaimer ("Delivery time is estimated using our
 * proprietary method which is based on the buyer's proximity to the item
 * location, the shipping service selected, the seller's shipping history, and
 * other factors") renders inside a delivery/location row on some templates,
 * and a broad location selector picks up a truncated fragment of it. Disclaimer
 * prose is worse than null in the location field: it feeds the Canada-vs-import
 * route decision in the multi-path shipping policy and a consumer cannot tell
 * it is junk without pattern-matching the sentence. Any candidate carrying one
 * of these phrases is rejected so the "Located in:" fallback can run instead.
 */
const LOCATION_DISCLAIMER_RE =
  /delivery\s+time\s+is\s+estimated|proprietary\s+method|shipping\s+service\s+selected|shipping\s+history|buyer'?s\s+proximity|other\s+factors?\b/i;

function readItemLocation(document: Document): ExtractionRecord['itemLocationText'] {
  for (const selector of ITEM_LOCATION_SELECTORS) {
    const text = textOf(document, selector);
    if (text !== null) {
      const value = text.replace(/^(?:located\s+in|item\s+location)\s*:?\s*/i, '').trim();
      // Skip a disclaimer fragment and keep looking; the fallback below reads
      // the "Located in:" span the shipping module still carries.
      if (value.length > 0 && !LOCATION_DISCLAIMER_RE.test(value)) {
        return { value, source: 'dom', confidence: 0.95 };
      }
    }
  }
  // Some templates fold the location into the shipping or delivery row
  // instead of giving it a row of its own — under either label wording.
  for (const selector of [...SHIPPING_SELECTORS, ...DELIVERY_SELECTORS]) {
    const text = textOf(document, selector);
    const match = text === null ? null : /\b(?:located\s+in|item\s+location)\s*:?\s*([^.|]{2,80})/i.exec(text);
    if (match !== null) {
      const value = match[1]!.trim();
      if (!LOCATION_DISCLAIMER_RE.test(value)) return { value, source: 'dom', confidence: 0.8 };
    }
  }
  return null;
}

const WATCHER_RE = /(\d[\d,]*)\s*(?:watchers?|watching|people\s+are\s+watching)/i;

function readWatcherCount(document: Document): ExtractionRecord['watcherCount'] {
  const sources = [...WATCHER_SELECTORS.map((selector) => textOf(document, selector))];
  // The watch count moves between containers often enough to be worth a
  // buybox-scoped fallback: "N watchers" is specific enough that nothing else
  // in a buybox can produce it.
  sources.push(scopedText(document, BUYBOX_SCOPE_SELECTORS));
  for (const text of sources) {
    const match = text === null ? null : WATCHER_RE.exec(text);
    if (match !== null) {
      return { value: Number.parseInt(match[1]!.replace(/,/g, ''), 10), source: 'dom', confidence: 0.9 };
    }
  }
  return null;
}

const QUANTITY_MORE_THAN_RE = /more\s+than\s+(\d[\d,]*)\s+available/i;
const QUANTITY_AVAILABLE_RE = /(\d[\d,]*)\s+available/i;
const QUANTITY_LAST_ONE_RE = /\blast\s+one\b/i;
const QUANTITY_SOLD_RE = /(\d[\d,]*)\s+sold\b/i;

/**
 * Quantity is read only from the availability module, never from a wider
 * scope: a listing title is free to contain "2 sold separately", and a wrong
 * count reads as fact where a null reads as "go look".
 */
function readQuantities(document: Document): {
  quantityAvailable: ExtractionRecord['quantityAvailable'];
  quantitySold: ExtractionRecord['quantitySold'];
} {
  let quantityAvailable: ExtractionRecord['quantityAvailable'] = null;
  let quantitySold: ExtractionRecord['quantitySold'] = null;
  for (const selector of QUANTITY_SELECTORS) {
    const text = textOf(document, selector);
    if (text === null) continue;
    if (quantityAvailable === null) {
      // "More than 10 available" is a floor, not a count -- kept, because a
      // floor still ranks, but at a confidence that says so.
      const moreThan = QUANTITY_MORE_THAN_RE.exec(text);
      const exact = QUANTITY_AVAILABLE_RE.exec(text);
      if (moreThan !== null) {
        quantityAvailable = { value: Number.parseInt(moreThan[1]!.replace(/,/g, ''), 10), source: 'dom', confidence: 0.6 };
      } else if (exact !== null) {
        quantityAvailable = { value: Number.parseInt(exact[1]!.replace(/,/g, ''), 10), source: 'dom', confidence: 0.95 };
      } else if (QUANTITY_LAST_ONE_RE.test(text)) {
        quantityAvailable = { value: 1, source: 'dom', confidence: 0.9 };
      }
    }
    if (quantitySold === null) {
      const sold = QUANTITY_SOLD_RE.exec(text);
      if (sold !== null) {
        quantitySold = { value: Number.parseInt(sold[1]!.replace(/,/g, ''), 10), source: 'dom', confidence: 0.95 };
      }
    }
  }
  return { quantityAvailable, quantitySold };
}

export function extractListing(document: Document, pageUrl: string, context: ExtractContext = {}): ExtractOutcome {
  const warnings: string[] = [];
  const expectedPostal = normalizePostalCode(context.expectedPostalCode ?? EBAY_DESTINATION_POSTAL_CODE);
  const jsonld = readJsonLdProduct(document);
  const observedAt = (context.observedAt ?? new Date()).toISOString();

  // --- item id + canonical URL (§20.2) ---
  const canonicalHref = document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null;
  const ogUrl = metaContent(document, 'og:url');
  let itemId: string | null = null;
  let itemIdSource: FieldSource = 'dom';
  for (const candidate of [canonicalHref, pageUrl, ogUrl, jsonld?.offers?.url ?? null]) {
    if (!candidate) continue;
    const id = itemIdFromUrl(candidate);
    if (id) {
      itemId = id;
      itemIdSource = candidate === jsonld?.offers?.url ? 'jsonld' : 'dom';
      break;
    }
  }
  if (itemId === null && jsonld?.sku && /^\d{9,15}$/.test(jsonld.sku)) {
    itemId = jsonld.sku;
    itemIdSource = 'jsonld';
  }
  if (itemId === null) warnings.push('itemId could not be resolved from canonical URL, page URL, or metadata');

  const canonicalUrl =
    itemId === null
      ? null
      : {
          value: canonicalListingUrl(itemId, canonicalHref ?? pageUrl),
          source: 'computed' as const,
          confidence: 1.0,
        };

  // --- selling format (auction vs fixed price) ---
  const sellingFormat = detectSellingFormat(document);
  if (sellingFormat.kind === 'unknown') {
    warnings.push('sellingFormat could not be resolved: a bid and a fixed price are not comparable quantities');
  } else if (sellingFormat.kind !== 'fixed_price') {
    warnings.push(
      `AUCTION_PRICE: itemPrice is a live bid (${sellingFormat.kind}${sellingFormat.bidCount === null ? '' : `, ${sellingFormat.bidCount} bids`}), not a purchasable fixed price`,
    );
  }

  // --- title ---
  let title: ExtractionRecord['title'] = null;
  for (const selector of TITLE_SELECTORS) {
    const text = textOf(document, selector);
    // textContent pulls in badge spans and the screen-reader "Opens in a new
    // window or tab" that live inside the title element.
    const cleaned = text ? cleanTitle(text) : null;
    if (cleaned) {
      title = { value: cleaned, source: 'dom', confidence: 0.99 };
      break;
    }
  }
  if (title === null && jsonld?.name) {
    title = { value: cleanTitle(jsonld.name), source: 'jsonld', confidence: 0.98 };
  }
  if (title === null) {
    const og = metaContent(document, 'og:title');
    if (og) title = { value: cleanTitle(og.replace(/\s*\|\s*eBay.*$/i, '')), source: 'meta', confidence: 0.9 };
  }
  if (title === null) warnings.push('title could not be resolved');

  // --- seller ---
  // A seller card links either /usr/<loginId> — the addressable login id the
  // _ssn= seller sweep needs — or /str/<slug>, a store slug in a different
  // namespace that fails as an _ssn= value. The two were conflated: the first
  // selector that matched won, so a store-linked card recorded its slug as if
  // it were a login id, and a later _ssn=<slug> sweep read its zero-candidate
  // result as "seller has no inventory". Prefer a /usr/ login id wherever the
  // page carries one (the /usr/-specific selectors sit later in the list);
  // when only a store slug is readable, surface it as sellerStoreSlug and warn
  // SELLER_LOGIN_ID_UNAVAILABLE rather than passing a slug off as a login id.
  let seller: ExtractionRecord['seller'] = null;
  let sellerStoreSlug: string | null = null;
  let sellerProfileUrl: string | null = null;
  let sellerTextName: string | null = null;
  for (const selector of SELLER_SELECTORS) {
    let elements: Element[];
    try {
      elements = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    for (const el of elements) {
      const href = el.getAttribute('href') ?? '';
      const usrSlug = /\/usr\/([^/?#]+)/.exec(href)?.[1];
      const strSlug = /\/str\/([^/?#]+)/.exec(href)?.[1];
      if (usrSlug !== undefined && seller === null) {
        seller = { value: decodeURIComponent(usrSlug), source: 'dom', confidence: 0.99 };
        if (href.length > 0) sellerProfileUrl = href;
      } else if (strSlug !== undefined && sellerStoreSlug === null) {
        sellerStoreSlug = decodeURIComponent(strSlug);
        if (sellerProfileUrl === null && href.length > 0) sellerProfileUrl = href;
      } else if (sellerTextName === null) {
        const text = el.textContent?.replace(/\s+/g, ' ').trim();
        if (text && text.length > 0 && text.length <= 64) sellerTextName = text;
      }
    }
    if (seller !== null) break;
  }
  if (seller === null && jsonld?.offers?.seller?.name) {
    seller = { value: jsonld.offers.seller.name, source: 'jsonld', confidence: 0.95 };
  }
  if (seller === null) {
    if (sellerStoreSlug !== null) {
      warnings.push(
        `SELLER_LOGIN_ID_UNAVAILABLE: the seller card links a store (/str/${sellerStoreSlug}), not a /usr/ login id; the store slug is not addressable as an _ssn= seller and was not recorded as one`,
      );
    } else {
      warnings.push('seller could not be resolved');
    }
  }

  // --- item price ---
  let itemPrice: ExtractionRecord['itemPrice'] = null;
  const jsonldPrice = jsonld?.offers?.price;
  const jsonldCurrency = jsonld?.offers?.priceCurrency;
  if (jsonldPrice !== undefined && jsonldCurrency) {
    const value = typeof jsonldPrice === 'number' ? jsonldPrice : Number.parseFloat(jsonldPrice);
    if (!Number.isNaN(value)) {
      itemPrice = { value, currency: jsonldCurrency.toUpperCase(), source: 'jsonld', confidence: 0.98 };
    }
  }
  if (itemPrice === null) {
    for (const selector of PRICE_SELECTORS) {
      const text = textOf(document, selector);
      if (!text) continue;
      const parsed = parseMoney(text);
      if (parsed) {
        if (parsed.approximate) warnings.push(`itemPrice parsed from a range: "${text}"`);
        itemPrice = { value: parsed.value, currency: parsed.currency, source: 'dom', confidence: 0.99 };
        break;
      }
    }
  }
  if (itemPrice === null) warnings.push('itemPrice could not be resolved');

  // --- destination + shipping (§20.1: never mark proxy shipping verified) ---
  const domPostal = readDestinationPostal(document);
  const liveVerification = context.verifiedDestination;
  const destinationPostal = liveVerification?.postalCode ?? domPostal;
  const destinationVerified =
    liveVerification !== undefined
      ? liveVerification.verified &&
        expectedPostal !== null &&
        postalCodesMatch(liveVerification.postalCode, expectedPostal)
      : domPostal !== null && expectedPostal !== null && postalCodesMatch(domPostal, expectedPostal);

  let shipping: ExtractionRecord['shipping'] = null;
  for (const selector of SHIPPING_SELECTORS) {
    const text = textOf(document, selector);
    if (!text) continue;
    const parsed = parseMoney(text);
    if (parsed) {
      if (parsed.approximate) warnings.push(`shipping parsed from a range: "${text}"`);
      if (parsed.ambiguousFree) {
        warnings.push(
          `shipping cell claims free shipping but also carries an amount; took free: "${text}"`,
        );
      }
      // A foreign quote (2026-09-04 shipping-currency-mislabelled-on-foreign-
      // quotes): the page's own "(approx C $x)" conversion is the figure the
      // .ca buyer is shown, so it is the recorded value; the quoted amount
      // stays in observedText and the warning. Without a conversion the
      // quote keeps its own currency — never the domestic label.
      let value = parsed.value;
      let currency = parsed.currency;
      let confidence = parsed.approximate ? 0.8 : 0.95;
      if (currency !== 'CAD' && parsed.conversion?.currency === 'CAD') {
        value = parsed.conversion.value;
        currency = 'CAD';
        confidence = 0.9;
        warnings.push(
          `SHIPPING_CONVERTED_BY_PAGE: quoted ${parsed.currency} ${parsed.value}; recorded the page's own approx C $${parsed.conversion.value} conversion (observedText keeps the quote)`,
        );
      } else if (currency !== 'CAD') {
        warnings.push(
          `SHIPPING_FOREIGN_CURRENCY: quoted in ${currency} with no CAD conversion rendered; shipping.value is ${currency}, not CAD`,
        );
      }
      shipping = {
        value,
        currency,
        source: 'dom',
        confidence,
        destinationPostalCode: destinationPostal,
        destinationVerified,
        observedText: text,
      };
      break;
    }
    // Text present but unparseable (e.g. "See details"): keep as observed text.
    shipping = {
      value: null,
      currency: null,
      source: 'dom',
      confidence: 0.5,
      destinationPostalCode: destinationPostal,
      destinationVerified: false,
      observedText: text,
    };
    warnings.push(`shipping text observed but not parseable as an amount: "${text}"`);
    break;
  }
  if (shipping === null) {
    warnings.push('shipping could not be resolved');
  } else if (!destinationVerified) {
    warnings.push('DESTINATION_UNVERIFIED: shipping must not be treated as destination-resolved Toronto data');
  }

  // --- best offer availability (read-only observation) ---
  const offerAvailable = detectOfferAvailable(document);

  // --- close time, location, watchers, quantity ---
  const { endsAt, timeLeftText, fromText: endTimeFromText } = readEndTime(document, jsonld, observedAt);
  if (endTimeFromText && timeLeftText !== null) {
    warnings.push(
      `END_TIME_FROM_TEXT: no timer element matched this template; the countdown "${timeLeftText.value}" was read from the buy-box text and endsAt is computed from it (minute-wide at best). Capture the countdown element (browser_snapshot of the buy box) so the selector can be pinned.`,
    );
  }
  const { quantityAvailable, quantitySold } = readQuantities(document);

  // --- variants (msku) ---
  let variants: ExtractionRecord['variants'] = null;
  const variantSelects = Array.from(
    document.querySelectorAll('select[name*="msku" i], .x-msku select, [data-testid="x-msku"] select'),
  );
  if (variantSelects.length > 0) {
    variants = {
      hasVariants: true,
      selections: variantSelects.map((selectEl) => {
        const select = selectEl as HTMLSelectElement;
        const options = Array.from(select.querySelectorAll('option'))
          .map((option) => option.textContent?.trim() ?? '')
          .filter((option) => option.length > 0 && !/^-?\s*select\s*-?$/i.test(option));
        const label =
          select.getAttribute('aria-label') ??
          select.closest('.x-msku__box, .vim')?.querySelector('label')?.textContent?.trim() ??
          select.getAttribute('name') ??
          'variant';
        // Live DOM reflects user choice via selectedIndex; statically
        // parsed HTML (fixture/unit path) only carries the attribute.
        const selectedIndex = select.selectedIndex;
        const selectedOption =
          (selectedIndex >= 0 ? select.options[selectedIndex] : undefined) ??
          (select.querySelector('option[selected]') as HTMLOptionElement | null) ??
          undefined;
        const selectedText = selectedOption?.textContent?.trim() ?? null;
        return {
          label,
          selected: selectedText !== null && !/select/i.test(selectedText) ? selectedText : null,
          options,
        };
      }),
    };
  }

  const record: ExtractionRecord = {
    siteProfile: 'ebay.ca.v1',
    itemId: itemId === null ? null : { value: itemId, source: itemIdSource, confidence: 1.0 },
    canonicalUrl,
    title,
    seller,
    sellerStoreSlug: sellerStoreSlug === null ? null : { value: sellerStoreSlug, source: 'dom', confidence: 0.95 },
    sellerProfileUrl: sellerProfileUrl === null ? null : { value: sellerProfileUrl, source: 'dom', confidence: 0.99 },
    sellerDisplayName: sellerTextName === null ? null : { value: sellerTextName, source: 'dom', confidence: 0.9 },
    itemPrice,
    shipping,
    offer: { available: offerAvailable, sellerOfferPrice: null, expiresAt: null },
    variants,
    listingStatus: detectListingStatus(document),
    sellingFormat,
    endsAt,
    timeLeftText,
    itemLocationText: readItemLocation(document),
    watcherCount: readWatcherCount(document),
    quantityAvailable,
    quantitySold,
    observedAt,
    pageRevision: context.pageRevision ?? 0,
    profileRevision: EBAY_PROFILE_REVISION,
  };

  return { record, warnings };
}

/** True when the document looks like an eBay listing page the extractor supports (§20.2). */
export function isListingPage(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl);
    const host = url.hostname.toLowerCase();
    const onEbay = host === 'ebay.ca' || host.endsWith('.ebay.ca') || host === 'ebay.com' || host.endsWith('.ebay.com');
    return onEbay && /\/itm\//.test(url.pathname);
  } catch {
    return false;
  }
}
