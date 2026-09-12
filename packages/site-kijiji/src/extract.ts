/**
 * kijiji.ca.v1 VIP (view-item page) extraction — layered like the
 * site-ebay extractor: schema.org JSON-LD (source "jsonld") first, live
 * DOM selectors (source "dom") second, Open Graph metadata (source
 * "meta") third, computed normalizations (source "computed") last.
 * Search-results snippets are never accepted as canonical ad evidence.
 *
 * One field, postedAt, has a fourth layer under all of those: it carries no
 * provenance of its own, and on an ad with a non-amount price it is stated
 * nowhere but the page's hydration cache. See readKijijiApolloCache.
 */
import { isKijijiAdImageUrl, KIJIJI_GALLERY_SELECTORS, normalizeKijijiImageUrl } from './gallery.js';
import { adIdFromUrl, canonicalAdUrl, parseKijijiPrice } from './normalize.js';
import {
  KIJIJI_BODY_PRICE_FIGURES_MAX,
  KIJIJI_DESCRIPTION_EXCERPT_CHARS,
  KIJIJI_DESCRIPTION_MAX_CHARS,
  type KijijiExtractionRecord,
  type KijijiFieldSource,
  type KijijiListingStatus,
} from './record.js';

export interface KijijiExtractContext {
  observedAt?: Date;
  pageRevision?: number;
  /**
   * The caller asked for the ad body under `descriptionFull`, cut at this
   * many characters (500..KIJIJI_DESCRIPTION_MAX_CHARS). Absent, the record
   * carries only the 500-character excerpt.
   */
  descriptionMaxChars?: number;
  /**
   * Where the `descriptionFull` window starts in the whitespace-collapsed
   * body (0 by default). Meaningful only with `descriptionMaxChars`: a body
   * longer than the cap is paged, never widened past it.
   */
  descriptionOffset?: number;
}

export interface KijijiExtractOutcome {
  record: KijijiExtractionRecord;
  warnings: string[];
}

/**
 * Confirmed against live VIP pages on 2026-08-29 (see the live-vip-*
 * fixtures): the Product is a bare top-level object, not "@graph"-wrapped;
 * there is no datePosted and no seller, the posted date arrives as
 * offers.validFrom, and offers.availableAtOrFrom carries the address in the
 * words the page renders. image is an array of ImageObject, not of strings,
 * so only its length is read.
 *
 * The block is served EMPTY -- no Product at all -- for any ad whose price
 * is not an amount, which is why nothing here may be the sole source of a
 * field. NEEDS-LIVE-VERIFICATION: seller.name has not been seen populated.
 */
interface JsonLdProduct {
  name?: string;
  description?: string;
  image?: string | string[];
  sku?: string;
  datePosted?: string;
  offers?: {
    price?: string | number;
    priceCurrency?: string;
    availability?: string;
    url?: string;
    validFrom?: string;
    seller?: { name?: string };
    availableAtOrFrom?: {
      name?: string;
      address?: {
        streetAddress?: string;
        addressLocality?: string;
      };
    };
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
    const topLevel: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const candidates: unknown[] = [];
    for (const candidate of topLevel) {
      candidates.push(candidate);
      // Kijiji has historically wrapped entities in "@graph".
      if (typeof candidate === 'object' && candidate !== null) {
        const graph = (candidate as Record<string, unknown>)['@graph'];
        if (Array.isArray(graph)) candidates.push(...graph);
      }
    }
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
          description: typeof record.description === 'string' ? record.description : undefined,
          image: record.image as string | string[] | undefined,
          sku: typeof record.sku === 'string' ? record.sku : undefined,
          datePosted: typeof record.datePosted === 'string' ? record.datePosted : undefined,
          offers: typeof offers === 'object' && offers !== null ? (offers as JsonLdProduct['offers']) : undefined,
        };
      }
    }
  }
  return null;
}

/**
 * The Apollo cache Kijiji ships inside <script id="__NEXT_DATA__">, or null.
 * It is a pages-router Next.js app: the cache that rendered the page is
 * serialized there and left in the DOM afterwards.
 *
 * Reading an addressed path out of parsed JSON is not the mistake
 * visibleText guards against -- that was matching banner STRINGS anywhere in
 * script text. This looks up one named key and reads one named field. It is
 * also the only place some fields exist at all: Kijiji renders the posted
 * time and the pagination controls client-side, and serves an EMPTY
 * schema.org Product block for any ad whose price is not an amount.
 *
 * Lives here rather than in traversal.ts because both the VIP and the search
 * extractor need it and extract.ts is the module that already owns DOM
 * reading; traversal.ts imports it.
 */
export function readKijijiApolloCache(document: Document): Record<string, unknown> | null {
  let script: Element | null;
  try {
    script = document.querySelector('script#__NEXT_DATA__');
  } catch {
    return null;
  }
  const rawText = script?.textContent ?? '';
  if (!rawText.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
  const props = (parsed as Record<string, unknown> | null)?.props;
  const pageProps = (props as Record<string, unknown> | null)?.pageProps;
  const cache = (pageProps as Record<string, unknown> | null)?.__APOLLO_STATE__;
  return typeof cache === 'object' && cache !== null ? (cache as Record<string, unknown>) : null;
}

/**
 * The amount the cache states for one ad, in CENTS with its currency —
 * "price":{"__typename":"StandardAmountPrice","type":"FIXED","amount":3500,
 * "currency":"CAD"} on the live 1740940278 capture, whose page renders $35
 * and whose JSON-LD says "35"; the live search capture renders $2.50 for
 * amount 250. Null for a non-amount price (Please Contact, Swap) or when
 * the entry states none.
 */
export function apolloPriceAmount(
  cache: Record<string, unknown> | null,
  adId: string | null,
): { amountCents: number; currency: string | null } | null {
  if (cache === null || adId === null) return null;
  const entry = cache[`StandardListing:${adId}`];
  if (typeof entry !== 'object' || entry === null) return null;
  const price = (entry as Record<string, unknown>).price;
  if (typeof price !== 'object' || price === null) return null;
  const { __typename, amount, currency } = price as Record<string, unknown>;
  if (__typename !== undefined && __typename !== 'StandardAmountPrice') return null;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
  return { amountCents: amount, currency: typeof currency === 'string' ? currency : null };
}

/** posterInfo.posterId for one ad out of the hydration cache (live captures: "81273541", "1008009261"). */
export function apolloPosterId(cache: Record<string, unknown> | null, adId: string | null): string | null {
  if (cache === null || adId === null) return null;
  const entry = cache[`StandardListing:${adId}`];
  if (typeof entry !== 'object' || entry === null) return null;
  const poster = (entry as Record<string, unknown>).posterInfo;
  if (typeof poster !== 'object' || poster === null) return null;
  const posterId = (poster as Record<string, unknown>).posterId;
  return typeof posterId === 'string' && /^\d{1,16}$/.test(posterId) ? posterId : null;
}

/** The activation date the cache states for one ad, in the "StandardListing:<id>" entry. */
export function apolloActivationDate(cache: Record<string, unknown> | null, adId: string | null): string | null {
  if (cache === null || adId === null) return null;
  const entry = cache[`StandardListing:${adId}`];
  if (typeof entry !== 'object' || entry === null) return null;
  const activationDate = (entry as Record<string, unknown>).activationDate;
  return typeof activationDate === 'string' && activationDate.length > 0 ? activationDate : null;
}

/**
 * The full image list the cache states for one ad. This is the only complete
 * statement of it in server HTML: the schema.org Product block caps its image
 * array at 4 (live 1740940278 stated 4 there against 7 here), and the
 * rendered gallery repeats each photo as hero plus thumbnail.
 */
export function apolloImageUrls(cache: Record<string, unknown> | null, adId: string | null): string[] | null {
  if (cache === null || adId === null) return null;
  const entry = cache[`StandardListing:${adId}`];
  if (typeof entry !== 'object' || entry === null) return null;
  const imageUrls = (entry as Record<string, unknown>).imageUrls;
  if (!Array.isArray(imageUrls)) return null;
  const urls = imageUrls.filter((url): url is string => typeof url === 'string' && url.length > 0);
  return urls.length > 0 ? urls : null;
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

/**
 * Text a reader can actually see. document.body.textContent includes the
 * contents of <script>, and Kijiji is a Next.js app that ships its i18n
 * bundle and __NEXT_DATA__ inline -- which carries EVERY banner string the
 * app can render, including "this ad is no longer available", on pages that
 * render none of them. Scanning that blob reported live ads as deleted.
 */
const NON_VISIBLE_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD']);

function visibleText(root: Node | null): string {
  if (root === null) return '';
  const parts: string[] = [];
  const walk = (node: Node): void => {
    const element = node as Element;
    if (element.tagName !== undefined && NON_VISIBLE_TAGS.has(element.tagName.toUpperCase())) return;
    if (element.getAttribute?.('aria-hidden') === 'true') return;
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? '';
      if (text.trim().length > 0) parts.push(text);
      return;
    }
    for (const child of Array.from(node.childNodes ?? [])) walk(child);
  };
  walk(root);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function metaContent(document: Document, property: string): string | null {
  const el =
    document.querySelector(`meta[property="${property}"]`) ?? document.querySelector(`meta[name="${property}"]`);
  const value = el?.getAttribute('content')?.trim();
  return value && value.length > 0 ? value : null;
}

// Every selector group below targets the current Kijiji React VIP layout.
// The vip-* names were read off live pages on 2026-08-29 and lead their
// groups; the listing-* names below them were guesses that matched no live
// ad page and are kept only as fallbacks. NEEDS-LIVE-VERIFICATION (F-24
// posture, like the ebay extractor): Kijiji churns generated class names, so
// the class*= entries and anything not marked live-read still need checking.
const TITLE_SELECTORS = ['h1[itemprop="name"]', 'h1[data-testid="listing-title"]', 'h1'];
const PRICE_SELECTORS = [
  // The name the live VIP actually uses; "listing-price" is the SEARCH card.
  '[data-testid="vip-price"]',
  '[data-testid="listing-price"]',
  '[itemprop="price"]',
  'span[class*="currentPrice"]',
  '[class*="priceContainer"]',
];
const LOCATION_SELECTORS = [
  '[data-testid="listing-location"]',
  '[data-testid="vip-location"]',
  '[data-testid="map-location"]',
  '[itemprop="address"]',
  '[itemprop="addressLocality"]',
  'span[class*="address"]',
  '[class*="locationContainer"]',
  '[class*="mapLocation"]',
  '[class*="locationText"]',
];
/**
 * Kijiji renders an editorial neighbourhood blurb near the map on many VIP
 * pages ("About The Annex Explore the area … This information is provided by a
 * third party data source. Kijiji is not responsible for the accuracy of this
 * information."). A broad location selector picks it up in place of the
 * address/locality the Office and Deals records need for municipality and
 * geocoding. The blurb is third-party editorial, not the ad's location, so a
 * candidate carrying one of these markers is rejected and the og:locality
 * fallback (with its existing region-not-address warning) runs instead.
 */
const AREA_BLURB_RE =
  /this\s+information\s+is\s+provided\s+by\s+a\s+third\s+party\s+data\s+source|explore\s+the\s+area|^about\s+.+\bexplore\b/i;
/** Where the ad renders its map/address block; scanned for the address line
 *  or a bare postal code when no selector above matched, rather than the
 *  whole page. */
const LOCATION_SCOPE_SELECTORS = [
  '[data-testid="vip-about-seller"]',
  '[data-testid="vip-map"]',
  '[class*="mapContainer"]',
  '[class*="sidebar"]',
  '[data-testid="vip-attributes"]',
  'aside',
];
/** A9A 9A9 / A9A9A9, the shape a Kijiji ad sidebar shows. */
const POSTAL_CODE_RE = /\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/;
/** The whole line the sidebar renders around it: "Thornhill, ON L4J 5M9".
 *  Preferred over the bare code -- it is the same evidence, said in full. */
const ADDRESS_LINE_RE =
  /\b[A-Z][A-Za-z\u00c0-\u00ff'\u2019.\- ]{1,40},\s*[A-Z]{2}\s+[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/;
const POSTED_TEXT_SELECTORS = [
  '[data-testid="listing-date"]',
  'time',
  'span[class*="datePosted"]',
];
const SELLER_SELECTORS = [
  '[data-testid="seller-name"]',
  '[data-testid="profile-link"]',
  'a[href*="/o-profile/"]',
  'a[href*="/u/"]',
  '[class*="sellerName"]',
];
/**
 * The profile anchor often wraps only the avatar, whose text is the seller's
 * initial -- "J" for "junior". A single letter is never a username, so
 * candidates are filtered rather than taken first-match, and the anchor's
 * own title/aria-label is consulted before its text.
 */
const PROFILE_LABEL_RE = /^view\s+(.+?)(?:['\u2019])s\s+profile$/i;
/**
 * The poster's listings link. Both live VIP captures (2026-08-29) render
 * `<a href="/o-profile/<posterId>/1" target="_blank">View all listings (N)</a>`
 * in the about-seller block; the avatar and name anchors point at the same
 * path without the count. The count is read only from the labelled anchor.
 */
const SELLER_PROFILE_PATH_RE = /\/o-profile\/(\d{1,16})(?:\/|$|\?)/;
const VIEW_ALL_LISTINGS_RE = /view\s+all\s+listings\s*\(\s*([\d,]+)\s*\)/i;

/** Warning-code prefix for a JSON-LD price the page's own stated amount contradicts. */
export const PRICE_JSONLD_TRUNCATED_WARNING_PREFIX = 'PRICE_JSONLD_TRUNCATED';

function plausibleSellerName(raw: string | null | undefined): string | null {
  const collapsed = raw?.replace(/\s+/g, ' ').trim() ?? '';
  // Kijiji labels the profile anchor "View <name>'s profile" rather than
  // naming the seller, and that label is consulted before the anchor's text
  // (which is only the avatar monogram), so the record stored a whole
  // sentence where the dashboard expects a name. The wording is the site's
  // own; anything not matching it is left exactly as it was.
  const labelled = PROFILE_LABEL_RE.exec(collapsed);
  const text = labelled === null ? collapsed : labelled[1]!.trim();
  if (text.length < 2) return null;
  // "J", "J.", "JD" as an avatar monogram -- all caps and very short.
  if (text.length <= 2 && text === text.toUpperCase()) return null;
  if (/^[A-Za-z]\.?$/.test(text)) return null;
  return text;
}
const DESCRIPTION_SELECTORS = [
  '[data-testid="vip-description-wrapper"]',
  '[data-testid="listing-description"]',
  '[itemprop="description"]',
  '#vip-body',
  '[class*="descriptionContainer"]',
];
const ATTRIBUTE_GROUP_SELECTORS = [
  '[data-testid="attribute-list"]',
  'dl[data-testid="attributes"]',
  '[class*="attributeList"]',
];
// Gallery container hooks live in gallery.ts so browser_images and this
// extractor scope "the gallery" identically.
const GALLERY_SELECTORS = KIJIJI_GALLERY_SELECTORS;

// Removed/expired ad marker text, in the ENDED_MARKERS style of the ebay
// extractor. NEEDS-LIVE-VERIFICATION: exact live wording of both banners.
const DELETED_MARKERS = [
  'this ad is no longer available',
  'ad is no longer available',
  'this listing is no longer available',
  'this ad was deleted',
];
const EXPIRED_MARKERS = ['ad expired', 'this ad has expired', 'listing has expired'];

// '.message' used to be in this list and matched the "Message the seller"
// contact panel on every live ad, so the fallback below fired constantly.
// Every selector here must name a status banner and nothing else.
const STATUS_SELECTORS = [
  '[data-testid="vip-removed-banner"]',
  '[data-testid="expired-ad"]',
  '[data-testid="vip-banner"]',
  '[class*="removedBanner"]',
  '[class*="expiredBanner"]',
  '[class*="statusBanner"]',
  '[role="alert"]',
];

/**
 * A live ad answers all three. If a marker only turned up in the unscoped
 * fallback while these hold, the marker came from markup the reader cannot
 * see -- trust the page, not the string.
 */
const LIVE_AD_SELECTORS = [
  // NOT guesses: every name below was read off a live VIP. The first pass
  // listed listing-*/message-seller names that appear on no Kijiji ad page,
  // so this test answered false on every live ad and the status fell through
  // to "unknown" -- confidently wrong replaced by uselessly vague.
  '[data-testid="r2s-form"]',
  '[data-testid="r2s"]',
  '[data-testid="vip-description-wrapper"]',
  '[data-testid="vip-gallery"]',
  '[data-testid="vip-reply-button"]',
  '[data-testid="message-seller"]',
  'button[class*="replyButton"]',
  '[data-testid="listing-description"]',
];

function detectKijijiListingStatus(document: Document): KijijiListingStatus {
  const chunks: string[] = [];
  for (const selector of STATUS_SELECTORS) {
    let elements: Element[];
    try {
      elements = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    for (const el of elements) {
      const text = visibleText(el).toLowerCase();
      if (text) chunks.push(text);
    }
  }

  const scoped = chunks.length > 0;
  // Kijiji moves these banners around, so a whole-page scan stays as the
  // fallback -- but over VISIBLE text only, and bounded, and it is not
  // allowed to overrule a page that is plainly a live ad.
  const blob = scoped
    ? chunks.join(' ')
    : visibleText(document.body).slice(0, 4000).toLowerCase();

  const looksLive =
    LIVE_AD_SELECTORS.some((selector) => {
      try {
        return document.querySelector(selector) !== null;
      } catch {
        return false;
      }
    }) && PRICE_SELECTORS.some((selector) => textOf(document, selector) !== null);

  const matched = DELETED_MARKERS.some((marker) => blob.includes(marker))
    ? ('deleted' as const)
    : EXPIRED_MARKERS.some((marker) => blob.includes(marker))
      ? ('expired' as const)
      : null;

  // An unscoped match on a page that answers like a live ad is the false
  // positive this guard exists for; a banner element saying so is believed.
  if (matched !== null && (scoped || !looksLive)) return matched;

  const hasTitle = TITLE_SELECTORS.some((selector) => textOf(document, selector) !== null);
  const hasPrice = PRICE_SELECTORS.some((selector) => textOf(document, selector) !== null);
  if (hasTitle && hasPrice) return 'active';
  return 'unknown';
}

function extractAttributes(document: Document): { label: string; value: string }[] {
  for (const selector of ATTRIBUTE_GROUP_SELECTORS) {
    let group: Element | null;
    try {
      group = document.querySelector(selector);
    } catch {
      continue;
    }
    if (!group) continue;
    const attributes: { label: string; value: string }[] = [];
    const terms = Array.from(group.querySelectorAll('dt'));
    if (terms.length > 0) {
      for (const term of terms) {
        const label = term.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        const sibling = term.nextElementSibling;
        const value =
          sibling && /^dd$/i.test(sibling.tagName) ? (sibling.textContent?.replace(/\s+/g, ' ').trim() ?? '') : '';
        if (label.length > 0 && value.length > 0) attributes.push({ label, value });
      }
    } else {
      // List-style attributes render as "Label: Value" items.
      for (const item of Array.from(group.querySelectorAll('li'))) {
        const text = item.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        const separator = text.indexOf(':');
        if (separator <= 0) continue;
        const label = text.slice(0, separator).trim();
        const value = text.slice(separator + 1).trim();
        if (label.length > 0 && value.length > 0) attributes.push({ label, value });
      }
    }
    if (attributes.length > 0) return attributes;
  }
  return [];
}

const ABOUT_SELLER_SELECTORS = [
  '[data-testid="vip-about-seller"]',
  '[data-testid="about-seller"]',
  '[class*="aboutSeller"]',
];

/**
 * The VIP renders the seller-type badge in the about-seller block and never
 * populates the attribute list, so deriving it from attributes alone always
 * answered 'unknown'. Scoped to that block on purpose: "owner" and "dealer"
 * are ordinary enough words that a whole-page scan would match a description
 * ("selling for my father, the original owner").
 */
function sellerTypeFromAboutBlock(document: Document): KijijiExtractionRecord['sellerType'] {
  for (const selector of ABOUT_SELLER_SELECTORS) {
    let el: Element | null;
    try {
      el = document.querySelector(selector);
    } catch {
      continue;
    }
    if (!el) continue;
    // The badge is matched on a leaf node's own text rather than the
    // block's textContent: that concatenates its children without
    // separators ("JessicaOwnerView all listings"), which destroys the word
    // boundaries a text scan needs and would equally let "homeowner" in a
    // neighbouring line answer for the badge.
    let nodes: Element[];
    try {
      nodes = Array.from(el.querySelectorAll('*'));
    } catch {
      continue;
    }
    for (const node of [...nodes, el]) {
      const own = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (own.length === 0 || own.length > 24) continue;
      if (/^(dealer|business|professional)$/i.test(own)) return 'dealer';
      if (/^owner$/i.test(own)) return 'owner';
    }
  }
  return 'unknown';
}

function sellerTypeFromAttributes(attributes: readonly { label: string; value: string }[]): KijijiExtractionRecord['sellerType'] {
  for (const attribute of attributes) {
    if (!/for sale by/i.test(attribute.label)) continue;
    if (/dealer|business/i.test(attribute.value)) return 'dealer';
    if (/owner/i.test(attribute.value)) return 'owner';
  }
  return 'unknown';
}

function toIsoOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Collapse whitespace and cap at the record's 500-char excerpt limit. */
/**
 * The tail a brokerage feed appends to an MLS-syndicated Kijiji ad:
 * "(id:24493) MLS# W9312345" (2026-09-03 office fire, 7 of 12 commercial
 * ads). Either half alone counts; the match is quoted in the warning.
 */
const MLS_SYNDICATION_RE = /\(id:\s*\d+\)\s*(?:MLS\s*#?\s*[A-Z]?\d{5,})?|\bMLS\s*#\s*[A-Z]?\d{5,}\b/i;
/**
 * The Kijiji category whose ads are known to syndicate an MLS record
 * (realtor.ca): commercial & office space (c40), the one the office routine
 * walks. Other real-estate categories are not listed here because no capture
 * of one exists; an ad in any category whose body carries a syndication
 * reference is treated as syndicated by MLS_SYNDICATION_RE instead.
 */
const MLS_CATEGORY_PATH_RE = /\/v-commercial-office-space\//i;

function excerpt(raw: string): string {
  return collapse(raw).slice(0, KIJIJI_DESCRIPTION_EXCERPT_CHARS);
}

/**
 * Every currency amount an ad body states, in document order (2026-09-09
 * deals fire, search-card-price-is-not-the-ad-price-on-multi-item-and-
 * contact-price-ads): six ads whose listed price was not the price of the
 * thing for sale — a condition ladder ("Brand new $800 Slightly Used-like
 * new $600" under a C$250 card), a per-item list, an "$279 OBO" tail, and
 * two "Please Contact" cards over bodies that named a figure — with nothing
 * on the record saying so. The figures are reported as the body states
 * them; the listed price is never rewritten from prose. A figure followed by
 * a shipping/delivery word is a shipping figure, not a price the ad asks.
 * Bounded (KIJIJI_BODY_PRICE_FIGURES_MAX) because the body is untrusted text.
 */
const BODY_AMOUNT_RE = /(?:C\s?\$|CA\s?\$|\$|\bCAD\s?)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d)(\s*(?:\/|per\b)?\s*(?:shipping|delivery|postage|ship\b))?/gi;

export function bodyPriceFigures(body: string | null): number[] {
  if (body === null) return [];
  const figures: number[] = [];
  const text = collapse(body).replace(/[\u00a0\u202f]/g, ' ');
  for (const match of text.matchAll(BODY_AMOUNT_RE)) {
    if (match[3] !== undefined) continue;
    const whole = Number.parseInt(match[1]!.replace(/,/g, ''), 10);
    if (!Number.isFinite(whole) || whole <= 0) continue;
    const cents = match[2] === undefined ? 0 : Number.parseInt(match[2].padEnd(2, '0'), 10) / 100;
    figures.push(whole + cents);
    if (figures.length >= KIJIJI_BODY_PRICE_FIGURES_MAX) break;
  }
  return figures;
}

/**
 * A place the body says the item is at, as the body says it: "Located in
 * Laval", "pickup in Ajax", "pick up from Vaughan". Quoted verbatim and
 * bounded; the structured location is never rewritten from it (2026-09-09
 * deals fire, ad-location-field-contradicts-location-stated-in-body:
 * record.location "Toronto, ON, L1T" beside a body reading "Located in
 * Laval", roughly 540 km apart).
 */
// The keyword is matched in either case; the place must be capitalised, so
// the two halves are spelled out rather than flagged case-insensitive.
const BODY_PLACE_RE =
  /\b(?:[Ll]ocated|[Ll]ocation(?:\s+is)?|[Pp]ick[\s-]?[Uu]p(?:\s+is|\s+only)?|[Aa]vailable)\s*(?::\s*|\s+)(?:in|at|from|IN|In|AT|At|FROM|From)\s+([A-Z][A-Za-zÀ-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÿ'’.-]+){0,2})/;

function bodyPlaceStatement(body: string | null): { phrase: string; place: string } | null {
  if (body === null) return null;
  const match = BODY_PLACE_RE.exec(collapse(body));
  if (match === null) return null;
  return { phrase: match[0].slice(0, 60), place: match[1]! };
}

/**
 * Canada Post reserves the M prefix for Toronto: a Toronto label carrying
 * any other forward sortation area contradicts itself ("Toronto, ON, L1T"
 * is Ajax). Only that one rule is known here; no FSA-to-city table exists
 * in this package, so no other city is checked.
 */
const TORONTO_LABEL_RE = /\btoronto\b/i;
const FSA_RE = /\b([A-Z])\d[A-Z]\b/;

function fsaOutsideToronto(locationText: string | null): string | null {
  if (locationText === null || !TORONTO_LABEL_RE.test(locationText)) return null;
  const fsa = FSA_RE.exec(locationText.toUpperCase());
  if (fsa === null || fsa[1] === 'M') return null;
  return fsa[0];
}

function collapse(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** The caller's descriptionMaxChars, clamped into the bound the record schema enforces; null when not asked. */
function requestedDescriptionChars(context: KijijiExtractContext): number | null {
  const asked = context.descriptionMaxChars;
  if (typeof asked !== 'number' || !Number.isFinite(asked)) return null;
  return Math.min(KIJIJI_DESCRIPTION_MAX_CHARS, Math.max(KIJIJI_DESCRIPTION_EXCERPT_CHARS, Math.floor(asked)));
}

/** The caller's descriptionOffset as a non-negative integer; 0 when not asked. */
function requestedDescriptionOffset(context: KijijiExtractContext): number {
  const asked = context.descriptionOffset;
  if (typeof asked !== 'number' || !Number.isFinite(asked)) return 0;
  return Math.max(0, Math.floor(asked));
}

export function extractKijijiListing(
  document: Document,
  pageUrl: string,
  context: KijijiExtractContext = {},
): KijijiExtractOutcome {
  const warnings: string[] = [];
  const jsonld = readJsonLdProduct(document);
  const apollo = readKijijiApolloCache(document);
  const observedAt = (context.observedAt ?? new Date()).toISOString();

  // --- ad id + canonical URL (identity, then computed canonical) ---
  const canonicalHref = document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null;
  const ogUrl = metaContent(document, 'og:url');
  let adId: string | null = null;
  let adIdSource: KijijiFieldSource = 'dom';
  for (const candidate of [canonicalHref, pageUrl, ogUrl, jsonld?.offers?.url ?? null]) {
    if (!candidate) continue;
    const id = adIdFromUrl(candidate);
    if (id) {
      adId = id;
      adIdSource = candidate === jsonld?.offers?.url ? 'jsonld' : 'dom';
      break;
    }
  }
  if (adId === null && jsonld?.sku && /^\d{7,12}$/.test(jsonld.sku)) {
    adId = jsonld.sku;
    adIdSource = 'jsonld';
  }
  if (adId === null) warnings.push('adId could not be resolved from canonical URL, page URL, or metadata');

  // The canonical is the preserved slug path, never a reconstruction
  // (see canonicalAdUrl); first candidate that canonicalizes wins.
  let canonicalUrl: KijijiExtractionRecord['canonicalUrl'] = null;
  if (adId !== null) {
    for (const candidate of [canonicalHref, ogUrl, pageUrl]) {
      const canonical = canonicalAdUrl(adId, candidate);
      if (canonical !== null) {
        canonicalUrl = { value: canonical, source: 'computed', confidence: 1.0 };
        break;
      }
    }
    if (canonicalUrl === null) warnings.push('canonicalUrl could not be derived from any observed kijiji.ca URL');
  }

  // --- title (jsonld → dom → meta) ---
  let title: KijijiExtractionRecord['title'] = null;
  if (jsonld?.name) {
    title = { value: jsonld.name, source: 'jsonld', confidence: 0.98 };
  }
  if (title === null) {
    for (const selector of TITLE_SELECTORS) {
      const text = textOf(document, selector);
      if (text) {
        title = { value: text, source: 'dom', confidence: 0.99 };
        break;
      }
    }
  }
  if (title === null) {
    const og = metaContent(document, 'og:title');
    if (og) title = { value: og.replace(/\s*\|\s*kijiji.*$/i, ''), source: 'meta', confidence: 0.9 };
  }
  if (title === null) warnings.push('title could not be resolved');

  // --- price (jsonld → dom) ---
  // JSON-LD wins when it carries a positive amount; a JSON-LD price of 0 is
  // ambiguous on Kijiji (Free vs Please Contact vs Swap/Trade), so the DOM
  // text is preferred for kind fidelity in that case.
  let price: KijijiExtractionRecord['price'] = null;
  const jsonldPrice = jsonld?.offers?.price;
  const jsonldAmount =
    jsonldPrice === undefined
      ? null
      : typeof jsonldPrice === 'number'
        ? jsonldPrice
        : Number.parseFloat(jsonldPrice);
  if (jsonldAmount !== null && !Number.isNaN(jsonldAmount) && jsonldAmount > 0) {
    price = {
      kind: 'amount',
      value: jsonldAmount,
      currency: 'CAD',
      rawText: String(jsonldPrice),
      source: 'jsonld',
      confidence: 0.98,
    };
    const jsonldCurrency = jsonld?.offers?.priceCurrency;
    if (jsonldCurrency && jsonldCurrency.toUpperCase() !== 'CAD') {
      warnings.push(`JSON-LD priceCurrency is "${jsonldCurrency}"; kijiji.ca.v1 records assume CAD`);
    }
    // 2026-09-03 deals fire (search-card-price-differs-from-ad-page-price):
    // four ads whose cards read C$1.50/C$7.50 came back C$1.00/C$7.00 from
    // their ad pages — each lost exactly its cents. JSON-LD offers.price is
    // a whole-number string on the live capture ("35" for amount 3500), so
    // a fractional price arrives truncated while the hydration cache states
    // the exact amount in cents. When the two disagree the page's own
    // amount is recorded and the disagreement is named; when they agree
    // JSON-LD keeps its provenance.
    const stated = apolloPriceAmount(apollo, adId);
    if (stated !== null && (stated.currency === null || stated.currency.toUpperCase() === 'CAD')) {
      const exact = stated.amountCents / 100;
      if (Math.abs(exact - jsonldAmount) >= 0.005) {
        const rendered = exact.toFixed(2);
        price = {
          kind: 'amount',
          value: exact,
          currency: 'CAD',
          rawText: `$${rendered}`,
          source: 'dom',
          confidence: 0.97,
        };
        warnings.push(
          `${PRICE_JSONLD_TRUNCATED_WARNING_PREFIX}: JSON-LD offers.price "${String(jsonldPrice)}" disagrees with the amount the page states for this ad (${stated.amountCents} cents = C$${rendered}); the stated amount is recorded (observed 2026-09-03: ads whose search cards read C$1.50 and C$7.50 extracted as C$1.00 and C$7.00 from JSON-LD alone).`,
        );
      }
    }
  }
  if (price === null) {
    for (const selector of PRICE_SELECTORS) {
      let el: Element | null;
      try {
        el = document.querySelector(selector);
      } catch {
        continue;
      }
      if (!el) continue;
      const text = el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      const parsed = parseKijijiPrice(text);
      if (parsed) {
        price = { ...parsed, source: 'dom', confidence: 0.99 };
        break;
      }
      // itemprop="price" carries a bare numeric content attribute.
      const content = el.getAttribute('content');
      if (content && /^\d+(?:\.\d{1,2})?$/.test(content)) {
        price = {
          kind: 'amount',
          value: Number.parseFloat(content),
          currency: 'CAD',
          rawText: content,
          source: 'dom',
          confidence: 0.95,
        };
        break;
      }
    }
  }
  if (price === null) warnings.push('price could not be resolved');

  // --- location (jsonld → dom → meta; never inferred) ---
  // The offer states where the item can be collected, and states it in the
  // same words the page renders ("Oakville, ON L6K 3R9"), so it leads.
  let location: KijijiExtractionRecord['location'] = null;
  const place = jsonld?.offers?.availableAtOrFrom;
  for (const candidate of [place?.address?.streetAddress, place?.address?.addressLocality, place?.name]) {
    if (typeof candidate !== 'string') continue;
    const text = candidate.replace(/\s+/g, ' ').trim();
    if (text.length === 0) continue;
    location = { text, source: 'jsonld', confidence: 0.97 };
    break;
  }
  if (location === null) {
    for (const selector of LOCATION_SELECTORS) {
      const text = textOf(document, selector);
      // Reject a third-party neighbourhood blurb picked up by a broad
      // location selector; it is editorial, not the ad's location.
      if (text && !AREA_BLURB_RE.test(text)) {
        location = { text, source: 'dom', confidence: 0.95 };
        break;
      }
    }
  }
  if (location === null) {
    // The ad sidebar renders a postal code even when no location element
    // carries a name. A postal code IS the location, and null was throwing
    // away the most precise form of it. Scoped to the map/sidebar blocks so
    // a postal code inside the description is not mistaken for the ad's.
    for (const selector of LOCATION_SCOPE_SELECTORS) {
      let scope: Element | null;
      try {
        scope = document.querySelector(selector);
      } catch {
        continue;
      }
      if (!scope) continue;
      const scopeText = visibleText(scope);
      const line = ADDRESS_LINE_RE.exec(scopeText);
      if (line) {
        location = { text: line[0].trim(), source: 'dom', confidence: 0.9 };
        warnings.push(`location resolved from a postal code line in the ad sidebar: "${line[0].trim()}"`);
        break;
      }
      const match = POSTAL_CODE_RE.exec(scopeText);
      if (match) {
        location = { text: match[0].toUpperCase(), source: 'dom', confidence: 0.75 };
        warnings.push(`location resolved from a postal code in the ad sidebar: "${match[0]}"`);
        break;
      }
    }
  }
  if (location === null) {
    // og:locality names the ad's region rather than its address, so it is
    // the last resort -- but it is present on every VIP, which "null" was
    // not an improvement on.
    const locality = metaContent(document, 'og:locality');
    if (locality) {
      location = { text: locality, source: 'meta', confidence: 0.7 };
      warnings.push(`location resolved from og:locality, which names a region rather than an address: "${locality}"`);
    }
  }
  if (location === null) warnings.push('location could not be resolved');

  // --- posted time (jsonld → dom time[datetime] → raw relative text) ---
  let postedAt: string | null = toIsoOrNull(jsonld?.datePosted) ?? toIsoOrNull(jsonld?.offers?.validFrom);
  let postedText: string | null = null;
  const timeEl = document.querySelector('time[datetime]');
  if (timeEl) {
    postedText = timeEl.textContent?.replace(/\s+/g, ' ').trim() || null;
    if (postedAt === null) postedAt = toIsoOrNull(timeEl.getAttribute('datetime'));
  }
  if (postedText === null) {
    for (const selector of POSTED_TEXT_SELECTORS) {
      const text = textOf(document, selector);
      if (text) {
        postedText = text;
        break;
      }
    }
  }
  if (postedAt === null) {
    // An ad with a non-amount price is served with no Product JSON-LD at
    // all, and the VIP renders no posted date, so the hydration cache is the
    // only statement of when it went up.
    postedAt = toIsoOrNull(apolloActivationDate(apollo, adId));
  }
  if (postedAt === null && postedText !== null) {
    warnings.push(`postedAt not machine-parseable; raw text preserved in postedText: "${postedText}"`);
  }

  // --- seller (jsonld → dom) ---
  let sellerName: KijijiExtractionRecord['sellerName'] = null;
  if (jsonld?.offers?.seller?.name) {
    sellerName = { value: jsonld.offers.seller.name, source: 'jsonld', confidence: 0.95 };
  }
  if (sellerName === null) {
    for (const selector of SELLER_SELECTORS) {
      let el: Element | null;
      try {
        el = document.querySelector(selector);
      } catch {
        continue;
      }
      if (!el) continue;
      // title/aria-label carry the full username on an avatar-only anchor,
      // whose text is just the initial.
      const candidate =
        plausibleSellerName(el.getAttribute('title')) ??
        plausibleSellerName(el.getAttribute('aria-label')) ??
        plausibleSellerName(el.textContent);
      // The "View all listings (N)" anchor shares the /o-profile/ path with
      // the name anchor; its label is a control, never a seller's name.
      if (candidate && candidate.length <= 64 && !VIEW_ALL_LISTINGS_RE.test(candidate)) {
        sellerName = { value: candidate, source: 'dom', confidence: 0.9 };
        break;
      }
    }
  }
  // The unresolved warning is pushed after the description is read: a
  // brokerage-syndicated ad is named as such (see MLS_SYNDICATION_RE).

  // --- seller listings surface (hydration posterId → /o-profile/ anchors) ---
  // 2026-09-02 deals fire (kijiji-no-seller-inventory-surface): a good new
  // trader's other ads were unreachable except by keyword collision. The
  // VIP links them: "View all listings (N)" → /o-profile/<posterId>/1.
  let sellerId: KijijiExtractionRecord['sellerId'] = null;
  let sellerListingsUrl: KijijiExtractionRecord['sellerListingsUrl'] = null;
  let sellerListingCount: number | null = null;
  const cachedPosterId = apolloPosterId(apollo, adId);
  if (cachedPosterId !== null) sellerId = { value: cachedPosterId, source: 'dom', confidence: 0.98 };
  let profileAnchors: Element[] = [];
  try {
    profileAnchors = Array.from(document.querySelectorAll('a[href*="/o-profile/"]'));
  } catch {
    profileAnchors = [];
  }
  let labelledHref: string | null = null;
  let firstHref: string | null = null;
  for (const anchor of profileAnchors) {
    const href = anchor.getAttribute('href');
    if (!href || !SELLER_PROFILE_PATH_RE.test(href)) continue;
    if (firstHref === null) firstHref = href;
    const label = VIEW_ALL_LISTINGS_RE.exec((anchor.textContent ?? '').replace(/\s+/g, ' ').trim());
    if (label !== null && labelledHref === null) {
      labelledHref = href;
      const count = Number.parseInt(label[1]!.replace(/,/g, ''), 10);
      if (Number.isFinite(count)) sellerListingCount = count;
    }
  }
  const profileHref = labelledHref ?? firstHref;
  if (profileHref !== null) {
    try {
      const absolute = new URL(profileHref, pageUrl);
      absolute.search = '';
      absolute.hash = '';
      sellerListingsUrl = { value: absolute.toString(), source: 'dom', confidence: labelledHref === null ? 0.9 : 0.97 };
      if (sellerId === null) {
        const fromPath = SELLER_PROFILE_PATH_RE.exec(absolute.pathname);
        if (fromPath !== null) sellerId = { value: fromPath[1]!, source: 'dom', confidence: 0.95 };
      }
    } catch {
      // an unparseable href is no evidence; leave the fields null
    }
  }

  // --- description excerpt (jsonld → dom) ---
  let description: KijijiExtractionRecord['description'] = null;
  // The whole body, not the 500-char excerpt: the syndication tail sits at
  // the end of a long brokerage description.
  let descriptionBody: string | null = null;
  if (jsonld?.description) {
    descriptionBody = jsonld.description;
    description = { value: excerpt(jsonld.description), source: 'jsonld', confidence: 0.95 };
  }
  if (description === null) {
    for (const selector of DESCRIPTION_SELECTORS) {
      const text = textOf(document, selector);
      if (text) {
        descriptionBody = text;
        description = { value: excerpt(text), source: 'dom', confidence: 0.9 };
        break;
      }
    }
  }
  // The 500-character excerpt is the record's own untrusted-data bound and
  // stays; what must not stay silent is the cut. 2026-09-05 office fire: an
  // MLS-syndicated commercial ad came back as 490 characters ending
  // mid-word with nothing saying so, and the cut section was where square
  // footage and lease terms sat — a run could not tell a terse ad from a
  // cut one. Name the cut and the body's full length — and name a remedy
  // that exists. The first version of this warning sent the caller to a
  // browser_snapshot of the description region; the 2026-09-06 office fire
  // followed it on ad 1743072691 (a 1,239-character body) and got zero body
  // nodes before and after Show More, because the snapshot collects
  // interactive elements and short money-bearing text only, never prose
  // (browser-core snapshot.ts, TEXT_SELECTOR + the 400-character bound).
  // The excerpt IS the whole ad text the Bridge returns; the cut terms are
  // read from the MLS record the ad syndicates or from a screenshot.
  // The MLS half of that remedy is real estate's: on 2026-09-07 three LEGO
  // toy ads carried it verbatim, sending a reader to realtor.ca for "square
  // footage, TMI, lease structure" a minifigure lot does not have. It is
  // named only for an ad in the commercial-office category the office
  // routine walks, or whose body carries a brokerage syndication reference;
  // every other category gets the category-neutral cap and screenshot remedy.
  // 2026-09-08 deals fire (ad-description-truncated-at-500-chars-withholds-
  // the-valuation-basis): 13 of 35 opened ads were cut, and on identified-
  // set and minifigure lots the cut text IS what the routine values on
  // (1743100906: 500 of 5,174 characters — the set list). The excerpt keeps
  // its bound; a caller who says the body matters asks for it, bounded, and
  // gets it under its own field. The warning names that opt-in first.
  // 2026-09-11 18:2xZ deals fire (ad-body-longer-than-the-6000-char-
  // descriptionmaxchars-cap-hides-a-dealer-price-list): a cabinet dealer's
  // whole catalogue in one 15,154-character body, the floor cabinets priced
  // past where even the cap could reach. The per-call bound stays (the body
  // is untrusted text); the body is PAGED: descriptionOffset starts the
  // window, the field states offset and total, the warning names the next
  // offset — so a catalogue ad is three calls of machine-readable text, not
  // a screenshot.
  let descriptionFull: KijijiExtractionRecord['descriptionFull'] = null;
  const requestedChars = requestedDescriptionChars(context);
  const requestedOffset = requestedDescriptionOffset(context);
  if (descriptionBody !== null) {
    const collapsed = collapse(descriptionBody);
    const collapsedLength = collapsed.length;
    let offsetBeyondEnd = false;
    if (collapsedLength > KIJIJI_DESCRIPTION_EXCERPT_CHARS && requestedChars !== null && description !== null) {
      if (requestedOffset >= collapsedLength) {
        offsetBeyondEnd = true;
        warnings.push(
          `DESCRIPTION_OFFSET_BEYOND_END: descriptionOffset ${requestedOffset} is at or past the end of the ad body, which is ${collapsedLength} characters (whitespace-collapsed), so descriptionFull is null — the body was read in full by the windows before this one; the last window starts at an offset below ${collapsedLength}.`,
        );
      } else {
        descriptionFull = {
          value: collapsed.slice(requestedOffset, requestedOffset + requestedChars),
          source: description.source,
          confidence: description.confidence,
          maxChars: requestedChars,
          offset: requestedOffset,
          totalChars: collapsedLength,
        };
      }
    }
    const returnedEnd =
      descriptionFull === null ? KIJIJI_DESCRIPTION_EXCERPT_CHARS : descriptionFull.offset + descriptionFull.value.length;
    if (collapsedLength > returnedEnd && !offsetBeyondEnd) {
      const realEstate =
        MLS_CATEGORY_PATH_RE.test(canonicalUrl?.value ?? pageUrl) || MLS_SYNDICATION_RE.test(descriptionBody);
      const remedy = realEstate
        ? 'the terms the cut may hide (square footage, TMI, lease structure) are read from the MLS record the ad syndicates (realtor.ca, on the office-sources.v1 roster) or from a browser_screenshot of the description after clicking Show More'
        : 'whatever the cut hides is read from a browser_screenshot of the description after clicking Show More';
      if (descriptionFull === null) {
        warnings.push(
          `DESCRIPTION_TRUNCATED: the description excerpt is capped at ${KIJIJI_DESCRIPTION_EXCERPT_CHARS} characters and the ad body is ${collapsedLength} characters (whitespace-collapsed) — the text ends mid-ad, so do not read it as the whole ad. The excerpt is the whole ad text the Bridge returns unless asked for more: when the body decides the ad's value (a set list, a figure count, a dealer's price list), re-extract with descriptionMaxChars (up to ${KIJIJI_DESCRIPTION_MAX_CHARS}) to get it under descriptionFull, and page a body longer than that with descriptionOffset (the field states offset and totalChars); otherwise: browser_snapshot carries interactive elements and short money-bearing text, never description prose, so ${remedy}; when that is not available the field stays unresolved`,
        );
      } else {
        warnings.push(
          `DESCRIPTION_TRUNCATED: descriptionFull carries characters ${descriptionFull.offset}–${returnedEnd} of the ad body, which is ${collapsedLength} characters (whitespace-collapsed) — this window ends mid-ad, so do not read it as the whole ad. The next window starts at descriptionOffset ${returnedEnd}: re-extract with descriptionOffset ${returnedEnd} and the same descriptionMaxChars (at most ${KIJIJI_DESCRIPTION_MAX_CHARS} per call) until totalChars is reached; the windows concatenate into the whole collapsed body. Page it rather than screenshotting it — a price list is only usable as text; when paging is not available, ${remedy}`,
        );
      }
    }
  }

  // --- the amounts the body states, beside the listed price ---
  const figures = bodyPriceFigures(descriptionBody);
  if (figures.length > 0) {
    const listed = price !== null && price.kind === 'amount' && price.value !== null ? price.value : null;
    const stated = figures.map((figure) => `C$${figure.toFixed(2).replace(/\.00$/, '')}`).join(', ');
    if (listed === null) {
      warnings.push(
        `PRICE_STATED_IN_BODY_ONLY: the listing states no amount (price.kind ${price?.kind ?? 'null'}, value null — not zero) but the body names ${figures.length} amount(s) in order: ${stated} (bodyPriceFigures). The ad is priced in prose; never drop it on the card's null price — read the body (descriptionFull) and price it from what the body says.`,
      );
    } else if (figures.some((figure) => Math.abs(figure - listed) >= 0.005)) {
      warnings.push(
        `BODY_PRICES_DIFFER_FROM_LISTED: the listed price is C$${listed.toFixed(2).replace(/\.00$/, '')} but the body names ${figures.length} amount(s) in order: ${stated} (bodyPriceFigures) — a condition ladder, a per-item list, an OBO figure or a rate. The listed price is not dispositive for this ad: read the body (descriptionFull) before pricing it, and never rank it on the card figure alone.`,
      );
    }
  }

  // --- a location the page contradicts ---
  const locationText = location?.text ?? null;
  const foreignFsa = fsaOutsideToronto(locationText);
  if (foreignFsa !== null) {
    warnings.push(
      `LOCATION_FSA_OUTSIDE_NAMED_CITY: location reads "${locationText}" — a Toronto label carrying the forward sortation area ${foreignFsa}, which is not a Toronto FSA (Canada Post reserves the letter M for Toronto). The FSA is the more specific statement; cost pickup travel from ${foreignFsa}, not from Toronto, and open the ad's map if the trip decides the verdict.`,
    );
  }
  const bodyPlace = bodyPlaceStatement(descriptionBody);
  if (bodyPlace !== null && (locationText === null || !locationText.toLowerCase().includes(bodyPlace.place.toLowerCase()))) {
    warnings.push(
      `LOCATION_BODY_NAMES_PLACE: the body says "${bodyPlace.phrase}" while location reads "${locationText ?? 'null'}". The structured field is recorded as the page states it; the body's place is quoted here, not applied — compare the two before costing a pickup, and treat the ad as unlocated when they disagree.`,
    );
  }

  // --- unresolved seller: syndicated ad or selector miss? ---
  // 2026-09-03 office fire (vip-sellername-unresolved-on-mls-syndicated-ads):
  // every unresolved ad in the batch carried an "(id:NNNNN) MLS# …" tail;
  // every resolved one was a private advertiser. Naming the syndication lets
  // a run tell the two apart. Whether a syndicated VIP renders the poster
  // under some other element is NOT known — no such page is captured — so
  // the warning asks for that capture rather than guessing a selector.
  if (sellerName === null) {
    const syndication = descriptionBody === null ? null : MLS_SYNDICATION_RE.exec(descriptionBody);
    if (syndication !== null) {
      warnings.push(
        `SELLER_UNRESOLVED_SYNDICATED: no seller element matched and the body carries a brokerage syndication reference "${syndication[0].trim()}" — an MLS-syndicated ad may render no poster; capture the about-seller block of one such ad so the selector can be pinned or the absence confirmed`,
      );
    } else if (sellerId !== null) {
      // 2026-09-09 deals fire (sellername-null-while-sellerid-resolves):
      // three ads carried sellerId, sellerListingsUrl and sellerListingCount
      // beside this warning. The hydration payload the id comes from carries
      // no name (live posterInfo: posterId, sellerType, websiteUrl,
      // phoneNumber, verified), so the name is not withheld by a selector
      // miss alone — it lives on the profile page the record already links.
      warnings.push(
        `SELLER_NAME_UNRESOLVED_ID_KNOWN: no seller-name element matched, but the poster id ${sellerId.value} resolved (sellerId${sellerListingsUrl === null ? '' : `; sellerListingsUrl ${sellerListingsUrl.value}`}). The hydration payload the id comes from carries no name, so the name is read from the profile page at sellerListingsUrl (the same drill-down that lists the seller's other ads); until then key the roster match and any discovery note on the poster id, never on a guessed name.`,
      );
    } else {
      warnings.push('sellerName could not be resolved');
    }
  }

  // --- attributes + seller type ---
  const attributes = extractAttributes(document);
  const attributeSellerType = sellerTypeFromAttributes(attributes);
  const sellerType =
    attributeSellerType === 'unknown' ? sellerTypeFromAboutBlock(document) : attributeSellerType;

  // --- image count (apollo imageUrls → jsonld image array → dom gallery) ---
  // The cache leads because it is the only complete statement: the
  // schema.org image array caps at 4 (a 6-photo live ad reported
  // imageCount 4 on the 2026-08-30 connector test), and the rendered
  // gallery repeats each photo as hero plus thumbnail (live 1730433251:
  // 10 img nodes, 6 photos), so the DOM fallback counts distinct photos,
  // not img elements, and skips site-chrome assets.
  let imageCount: number | null = null;
  const cachedImageUrls = apolloImageUrls(apollo, adId);
  if (cachedImageUrls !== null) imageCount = cachedImageUrls.length;
  if (imageCount === null && jsonld?.image !== undefined) {
    imageCount = Array.isArray(jsonld.image) ? jsonld.image.length : 1;
  }
  if (imageCount === null) {
    for (const selector of GALLERY_SELECTORS) {
      let gallery: Element | null;
      try {
        gallery = document.querySelector(selector);
      } catch {
        continue;
      }
      if (!gallery) continue;
      const distinct = new Set<string>();
      for (const img of Array.from(gallery.querySelectorAll('img'))) {
        const src = img.getAttribute('src') ?? '';
        if (src.length === 0 || src.startsWith('data:') || !isKijijiAdImageUrl(src)) continue;
        distinct.add(normalizeKijijiImageUrl(src).dedupKey);
      }
      if (distinct.size > 0) {
        imageCount = distinct.size;
        break;
      }
    }
  }

  const record: KijijiExtractionRecord = {
    siteProfile: 'kijiji.ca.v1',
    adId: adId === null ? null : { value: adId, source: adIdSource, confidence: 1.0 },
    canonicalUrl,
    title,
    price,
    location,
    postedAt,
    postedText,
    sellerName,
    sellerType,
    sellerId,
    sellerListingsUrl,
    sellerListingCount,
    description,
    descriptionFull,
    bodyPriceFigures: figures,
    attributes,
    imageCount,
    listingStatus: detectKijijiListingStatus(document),
    observedAt,
    pageRevision: context.pageRevision ?? 0,
  };

  return { record, warnings };
}

/**
 * True when the URL is on the kijiji.ca host family AND the path has the
 * VIP shape: /v-<slugs>/<digits>, or more generally a URL the ad id can
 * be read from (trailing numeric id, or the legacy adId query form).
 */
export function isKijijiListingPage(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl);
    const host = url.hostname.toLowerCase();
    const onKijiji = host === 'kijiji.ca' || host.endsWith('.kijiji.ca');
    return onKijiji && adIdFromUrl(pageUrl) !== null;
  } catch {
    return false;
  }
}

/**
 * 'seller' is the poster's listings page, /o-profile/<posterId>/<page> —
 * the URL every VIP links as "View all listings (N)". NEEDS-LIVE-
 * VERIFICATION: no live /o-profile/ page is captured; it is read with the
 * same anchor-href ad scan the search pages use, which depends on no card
 * markup, and its pagination is the trailing page number (observed as /1).
 */
export type KijijiPageKind = 'listing' | 'search' | 'seller' | 'other';

/** Path-shape classification, mirroring classifyEbayPage. */
export function classifyKijijiPage(pageUrl: string): KijijiPageKind {
  try {
    const url = new URL(pageUrl);
    if (/^\/b-/.test(url.pathname)) return 'search';
    if (/^\/o-profile\/\d{1,16}(?:\/|$)/.test(url.pathname)) return 'seller';
    if (adIdFromUrl(pageUrl) !== null) return 'listing';
    return 'other';
  } catch {
    return 'other';
  }
}
