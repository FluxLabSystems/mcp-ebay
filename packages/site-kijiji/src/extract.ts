/**
 * kijiji.ca.v1 VIP (view-item page) extraction — layered like the
 * site-ebay extractor: schema.org JSON-LD (source "jsonld") first, live
 * DOM selectors (source "dom") second, Open Graph metadata (source
 * "meta") third, computed normalizations (source "computed") last.
 * Search-results snippets are never accepted as canonical ad evidence.
 */
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
 * NEEDS-LIVE-VERIFICATION: Kijiji embeds schema.org Product/Offer JSON-LD
 * on VIP pages; the exact shape (top-level vs "@graph"-wrapped, seller
 * placement, datePosted presence) must be confirmed against live pages.
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
// NEEDS-LIVE-VERIFICATION (F-24 posture, like the ebay extractor): Kijiji
// churns generated class names; data-testid/itemprop hooks are the most
// stable candidates but must be re-checked against live VIP pages.
const TITLE_SELECTORS = ['h1[itemprop="name"]', 'h1[data-testid="listing-title"]', 'h1'];
const PRICE_SELECTORS = [
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
/** Where the ad renders its map/address block; scanned for a postal code
 *  when no selector above matched, rather than the whole page. */
const LOCATION_SCOPE_SELECTORS = [
  '[data-testid="vip-map"]',
  '[class*="mapContainer"]',
  '[class*="sidebar"]',
  '[data-testid="vip-attributes"]',
  'aside',
];
/** A9A 9A9 / A9A9A9, the shape a Kijiji ad sidebar shows. */
const POSTAL_CODE_RE = /\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/;
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
function plausibleSellerName(raw: string | null | undefined): string | null {
  const text = raw?.replace(/\s+/g, ' ').trim() ?? '';
  if (text.length < 2) return null;
  // "J", "J.", "JD" as an avatar monogram -- all caps and very short.
  if (text.length <= 2 && text === text.toUpperCase()) return null;
  if (/^[A-Za-z]\.?$/.test(text)) return null;
  return text;
}
const DESCRIPTION_SELECTORS = [
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
const GALLERY_SELECTORS = [
  '[data-testid="gallery"]',
  '[data-testid="vip-gallery"]',
  '[class*="galleryContainer"]',
  '[class*="heroImage"]',
];

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

  // --- location (dom only; never inferred) ---
  let location: KijijiExtractionRecord['location'] = null;
  for (const selector of LOCATION_SELECTORS) {
    const text = textOf(document, selector);
    if (text) {
      location = { text, source: 'dom', confidence: 0.95 };
      break;
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
      const match = POSTAL_CODE_RE.exec(visibleText(scope));
      if (match) {
        location = { text: match[0].toUpperCase(), source: 'dom', confidence: 0.75 };
        warnings.push(`location resolved from a postal code in the ad sidebar: "${match[0]}"`);
        break;
      }
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
  const sellerType = sellerTypeFromAttributes(attributes);

  // --- image count (jsonld image array → dom gallery) ---
  let imageCount: number | null = null;
  if (jsonld?.image !== undefined) {
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
      const count = gallery.querySelectorAll('img').length;
      if (count > 0) {
        imageCount = count;
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
