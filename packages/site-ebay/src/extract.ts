/**
 * ebay.ca.v1 listing extraction — SDD v0.5 FR-08, §20.2/§20.3. Extraction
 * layers: schema.org JSON-LD (source "jsonld"), live DOM selectors
 * (source "dom"), Open Graph metadata (source "meta"), and computed
 * normalizations (source "computed"). Search-results snippets are never
 * accepted as canonical listing evidence.
 */
import { canonicalListingUrl, itemIdFromUrl, normalizePostalCode, parseMoney, postalCodesMatch } from './normalize.js';
import { EBAY_DESTINATION_POSTAL_CODE } from './profile.js';
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

const ENDED_MARKERS = [
  'this listing has ended',
  'this listing was ended',
  'bidding has ended',
  'this listing sold',
  'item sold',
];
const UNAVAILABLE_MARKERS = [
  'the item you selected is unavailable',
  'this listing is unavailable',
  "we looked everywhere",
  'listing is no longer available',
];

function detectListingStatus(document: Document): ListingStatus {
  const statusSelectors = ['.ux-message__title', '.ux-message', '.vi-status', '#vi-esc-cnt', '.statusMessage'];
  const chunks: string[] = [];
  for (const selector of statusSelectors) {
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const text = el.textContent?.toLowerCase() ?? '';
      if (text) chunks.push(text);
    }
  }
  const blob = chunks.join(' ');
  if (ENDED_MARKERS.some((marker) => blob.includes(marker))) return 'ended';
  if (UNAVAILABLE_MARKERS.some((marker) => blob.includes(marker))) return 'unavailable';
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

  // --- title ---
  let title: ExtractionRecord['title'] = null;
  for (const selector of TITLE_SELECTORS) {
    const text = textOf(document, selector);
    if (text) {
      title = { value: text, source: 'dom', confidence: 0.99 };
      break;
    }
  }
  if (title === null && jsonld?.name) {
    title = { value: jsonld.name, source: 'jsonld', confidence: 0.98 };
  }
  if (title === null) {
    const og = metaContent(document, 'og:title');
    if (og) title = { value: og.replace(/\s*\|\s*eBay.*$/i, ''), source: 'meta', confidence: 0.9 };
  }
  if (title === null) warnings.push('title could not be resolved');

  // --- seller ---
  let seller: ExtractionRecord['seller'] = null;
  for (const selector of SELLER_SELECTORS) {
    try {
      const el = document.querySelector(selector);
      if (!el) continue;
      const href = el.getAttribute('href') ?? '';
      const fromHref = /\/(?:usr|str)\/([^/?#]+)/.exec(href)?.[1];
      const text = el.textContent?.replace(/\s+/g, ' ').trim();
      const value = fromHref ?? (text && text.length > 0 && text.length <= 64 ? text : undefined);
      if (value) {
        seller = { value: decodeURIComponent(value), source: 'dom', confidence: 0.99 };
        break;
      }
    } catch {
      continue;
    }
  }
  if (seller === null && jsonld?.offers?.seller?.name) {
    seller = { value: jsonld.offers.seller.name, source: 'jsonld', confidence: 0.95 };
  }
  if (seller === null) warnings.push('seller could not be resolved');

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
      shipping = {
        value: parsed.value,
        currency: parsed.currency,
        source: 'dom',
        confidence: parsed.approximate ? 0.8 : 0.95,
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
  const bodyText = (document.body?.textContent ?? '').replace(/\s+/g, ' ').toLowerCase();
  const offerAvailable = /\b(make offer|best offer)\b/.test(bodyText);

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
    itemPrice,
    shipping,
    offer: { available: offerAvailable, sellerOfferPrice: null, expiresAt: null },
    variants,
    listingStatus: detectListingStatus(document),
    observedAt,
    pageRevision: context.pageRevision ?? 0,
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
