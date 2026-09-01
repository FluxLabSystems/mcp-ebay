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
import type { KijijiExtractionRecord, KijijiFieldSource, KijijiListingStatus } from './record.js';

export interface KijijiExtractContext {
  observedAt?: Date;
  pageRevision?: number;
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
function excerpt(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
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
      if (text) {
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
      if (candidate && candidate.length <= 64) {
        sellerName = { value: candidate, source: 'dom', confidence: 0.9 };
        break;
      }
    }
  }
  if (sellerName === null) warnings.push('sellerName could not be resolved');

  // --- description excerpt (jsonld → dom) ---
  let description: KijijiExtractionRecord['description'] = null;
  if (jsonld?.description) {
    description = { value: excerpt(jsonld.description), source: 'jsonld', confidence: 0.95 };
  }
  if (description === null) {
    for (const selector of DESCRIPTION_SELECTORS) {
      const text = textOf(document, selector);
      if (text) {
        description = { value: excerpt(text), source: 'dom', confidence: 0.9 };
        break;
      }
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
    description,
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

export type KijijiPageKind = 'listing' | 'search' | 'other';

/** Path-shape classification, mirroring classifyEbayPage. */
export function classifyKijijiPage(pageUrl: string): KijijiPageKind {
  try {
    const url = new URL(pageUrl);
    if (/^\/b-/.test(url.pathname)) return 'search';
    if (adIdFromUrl(pageUrl) !== null) return 'listing';
    return 'other';
  } catch {
    return 'other';
  }
}
