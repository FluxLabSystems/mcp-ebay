/**
 * zazzle.com.v1 extraction — spec P1 record contract on the layered-source
 * conventions of site-ebay/site-kijiji (JSON-LD "jsonld", Open Graph "meta",
 * live DOM "dom", derivations "computed"). Selector inventory captured from
 * live zazzle.com on 2026-08-31; anything not yet seen live is marked
 * NEEDS-LIVE-VERIFICATION where it is read.
 *
 * C7 discipline: nothing here computes, estimates, or interpolates a value
 * the page does not state. A discount is extracted from "You save 10%",
 * never derived from two prices; an unreadable field is an explicit null.
 * A bare "$" price never becomes a currency from the TEXT alone — but the
 * storefront TLD is the page's own statement of pricing region (Zazzle
 * region-locks each TLD; see storefrontCurrency), so a bare "$" on
 * zazzle.com resolves to USD and on zazzle.ca to CAD, with an explicit
 * C$/CA$/US$ prefix always winning.
 */
import {
  canonicalProductUrl,
  collapseWhitespace,
  parseSavePercent,
  parseZazzleMoney,
  productIdFromUrl,
  storefrontCurrency,
} from './normalize.js';
import {
  ZAZZLE_PROFILE_REVISION,
  type ZazzleFieldSource,
  type ZazzleListingStatus,
  type ZazzlePriceBasis,
  type ZazzleProductRecord,
} from './record.js';

export interface ZazzleExtractContext {
  observedAt?: Date;
  pageRevision?: number;
}

export interface ZazzleExtractOutcome {
  record: ZazzleProductRecord;
  warnings: string[];
}

export type ZazzlePageKind = 'product' | 'search' | 'other';

/**
 * /s/… and /c/… are search/browse surfaces; a path ending in an 18-digit
 * product id is a product page; anything else gets the best-effort
 * product-link scan (mirroring the eBay/Kijiji 'other' behavior).
 */
export function classifyZazzlePage(pageUrl: string): ZazzlePageKind {
  try {
    const url = new URL(pageUrl);
    if (productIdFromUrl(url.pathname) !== null) return 'product';
    if (/^\/(?:s|c)\//.test(url.pathname)) return 'search';
    return 'other';
  } catch {
    return 'other';
  }
}

// ---------------------------------------------------------------------------
// JSON-LD / meta readers
// ---------------------------------------------------------------------------

interface JsonLdProduct {
  name?: string;
  brand?: { name?: string; url?: string };
  url?: string;
  aggregateRating?: { ratingValue?: number; ratingCount?: number; reviewCount?: number };
  offers?: {
    price?: string | number;
    priceCurrency?: string;
    priceValidUntil?: string;
    availability?: string;
    url?: string;
  };
}

function readJsonLdProduct(document: Document): JsonLdProduct | null {
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    const raw = script.textContent ?? '';
    if (!raw.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const nodes: unknown[] = [];
    for (const candidate of Array.isArray(parsed) ? parsed : [parsed]) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const record = candidate as Record<string, unknown>;
      // Zazzle wraps its Product node in an @graph array.
      if (Array.isArray(record['@graph'])) nodes.push(...(record['@graph'] as unknown[]));
      else nodes.push(record);
    }
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      const record = node as Record<string, unknown>;
      const type = record['@type'];
      if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) {
        return record as JsonLdProduct;
      }
    }
  }
  return null;
}

function metaContent(document: Document, property: string): string | null {
  const el =
    document.querySelector(`meta[property="${property}"]`) ??
    document.querySelector(`meta[name="${property}"]`);
  const content = el?.getAttribute('content') ?? '';
  return content.length > 0 ? content : null;
}

function textOf(document: Document, selector: string): string | null {
  let el: Element | null = null;
  try {
    el = document.querySelector(selector);
  } catch {
    return null;
  }
  const text = collapseWhitespace(el?.textContent);
  return text.length > 0 ? text : null;
}

// ---------------------------------------------------------------------------
// Product page
// ---------------------------------------------------------------------------

const TITLE_SELECTOR = '.ProductSpaceDetailsPod_title, h1';
const MAIN_PRICE_SELECTOR = '.Pricing_mainPrice';
const STRIKETHROUGH_SELECTOR = '.Pricing_strikethrough';
const PER_UNIT_SELECTOR = '.Pricing_perUnitLabel';
const SAVE_LABEL_SELECTOR = '.DigitalAndPhysicalPricing_listingLabel, .SearchProductPriceBadge_root';
const SHIPPING_ESTIMATE_SELECTOR =
  '.ProductSpaceDetailsPod_shippingEstimates, [class*="ShippingEstimatesVariant_root"]';
const QUANTITY_SELECTOR = '.QuantitySelector2_droplistButton, .ProductSpaceDetailsPod_quantityPicker';

/** "Expand to select Quantity. Current selection is1 shirt" → 1. */
const QUANTITY_SELECTION_RE = /current selection is\s*(\d{1,4})/i;

const PERSONALIZE_RE = /personali[sz]e (?:this )?(?:design|template|it)/i;

/**
 * Gone-product shells. NEEDS-LIVE-VERIFICATION: phrasing is a conservative
 * guess until a dead product id is captured live; an unmatched gone-page
 * degrades to listingStatus 'unknown' (fail-safe), never to 'active'.
 */
const UNAVAILABLE_MARKERS = [
  'this product is no longer available',
  'this product is unavailable',
  'product not found',
  'page not found',
  'no longer for sale',
];

function detectPersonalization(document: Document): boolean {
  for (const el of Array.from(document.querySelectorAll('button, a'))) {
    const label = `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`;
    if (PERSONALIZE_RE.test(label)) return true;
  }
  return false;
}

function detectListingStatus(
  document: Document,
  jsonld: JsonLdProduct | null,
): { status: ZazzleListingStatus; source: ZazzleFieldSource } {
  const availability = (metaContent(document, 'og:availability') ?? '').toLowerCase();
  if (availability === 'instock' || availability === 'in stock') return { status: 'active', source: 'meta' };
  if (availability === 'oos' || availability === 'out of stock' || availability === 'discontinued') {
    return { status: 'unavailable', source: 'meta' };
  }
  const blob = collapseWhitespace(document.body?.textContent ?? '')
    .toLowerCase()
    .slice(0, 4000);
  if (UNAVAILABLE_MARKERS.some((marker) => blob.includes(marker))) {
    return { status: 'unavailable', source: 'dom' };
  }
  if (jsonld?.offers?.price !== undefined) return { status: 'active', source: 'jsonld' };
  return { status: 'unknown', source: 'computed' };
}

export function extractZazzleProduct(
  document: Document,
  pageUrl: string,
  context: ZazzleExtractContext = {},
): ZazzleExtractOutcome {
  const warnings: string[] = [];
  const observedAt = (context.observedAt ?? new Date()).toISOString();
  const pageRevision = context.pageRevision ?? 0;
  const jsonld = readJsonLdProduct(document);

  const field = <T>(value: T, source: ZazzleFieldSource, confidence: number) => ({
    value,
    source,
    confidence,
  });

  // productId: the URL is authoritative (it IS the id scheme).
  const productId = productIdFromUrl(pageUrl);

  // canonicalUrl: og:url, else the JSON-LD offer/product URL, else the page
  // URL stripped. link[rel=canonical] is deliberately never read — live
  // pages point it at style-variant SIBLING products.
  const ogUrl = metaContent(document, 'og:url');
  const ldUrl = jsonld?.offers?.url ?? jsonld?.url ?? null;
  const canonical =
    (ogUrl !== null ? canonicalProductUrl(ogUrl) : null) ??
    (ldUrl !== null ? canonicalProductUrl(ldUrl) : null) ??
    canonicalProductUrl(pageUrl);
  const canonicalSource: ZazzleFieldSource = ogUrl !== null ? 'meta' : ldUrl !== null ? 'jsonld' : 'computed';

  // title
  const ldName = typeof jsonld?.name === 'string' ? collapseWhitespace(jsonld.name) : '';
  const domTitle = textOf(document, TITLE_SELECTOR);
  const title =
    ldName.length > 0
      ? field(ldName, 'jsonld' as const, 0.98)
      : domTitle !== null
        ? field(domTitle, 'dom' as const, 0.9)
        : null;

  // vendor (store/designer attribution)
  const brandName =
    typeof jsonld?.brand?.name === 'string' ? collapseWhitespace(jsonld.brand.name) : '';
  const vendor = brandName.length > 0 ? field(brandName, 'jsonld' as const, 0.95) : null;

  // listedPrice: JSON-LD offer is the only place currency is STATED.
  let listedPrice: ZazzleProductRecord['listedPrice'] = null;
  const ldPriceRaw = jsonld?.offers?.price;
  const ldPrice =
    typeof ldPriceRaw === 'number'
      ? ldPriceRaw
      : typeof ldPriceRaw === 'string'
        ? Number.parseFloat(ldPriceRaw)
        : Number.NaN;
  if (Number.isFinite(ldPrice)) {
    const currency =
      typeof jsonld?.offers?.priceCurrency === 'string' ? jsonld.offers.priceCurrency : null;
    listedPrice = {
      value: ldPrice,
      currency,
      rawText: String(ldPriceRaw),
      source: 'jsonld',
      confidence: 0.98,
    };
    if (currency === null) {
      warnings.push('PRICE_CURRENCY_UNSTATED: the JSON-LD offer carries no priceCurrency; CAD thresholds must not fire on this record.');
    }
  } else {
    const domPrice = parseZazzleMoney(textOf(document, MAIN_PRICE_SELECTOR));
    if (domPrice !== null) {
      // Currency, in trust order: an explicit C$/CA$/US$ prefix in the
      // rendered figure, else the storefront TLD's own pricing region
      // (zazzle.com USD, zazzle.ca CAD). Only off both storefronts is a
      // bare "$" genuinely unstated.
      const currency = domPrice.currency ?? storefrontCurrency(pageUrl);
      listedPrice = { ...domPrice, currency, source: 'dom', confidence: 0.85 };
      if (currency === null) {
        warnings.push(
          'PRICE_CURRENCY_UNSTATED: price was read from the rendered "$" figure and the page stated no currency; CAD thresholds must not fire on this record.',
        );
      }
    } else {
      warnings.push('listedPrice could not be resolved from JSON-LD or the pricing module.');
    }
  }

  // originalPrice: og:price:standard_amount (meta) or the strikethrough.
  let originalPrice: ZazzleProductRecord['originalPrice'] = null;
  const standardAmount = metaContent(document, 'og:price:standard_amount');
  if (standardAmount !== null) {
    const value = Number.parseFloat(standardAmount);
    if (Number.isFinite(value)) {
      originalPrice = {
        value,
        currency:
          (listedPrice?.source === 'jsonld' ? listedPrice.currency : null) ??
          storefrontCurrency(pageUrl),
        rawText: standardAmount,
        source: 'meta',
        confidence: 0.9,
      };
    }
  }
  if (originalPrice === null) {
    const struck = parseZazzleMoney(textOf(document, STRIKETHROUGH_SELECTOR));
    if (struck !== null) {
      originalPrice = {
        ...struck,
        currency: struck.currency ?? storefrontCurrency(pageUrl),
        source: 'dom',
        confidence: 0.85,
      };
    }
  }

  // Personalization → the C4 basis discriminator. Never the favourable
  // default: no affordance found means 'unknown', and the record is not
  // usable for the personalized-price triggers.
  const personalizationOffered = detectPersonalization(document);
  const priceBasis: ZazzlePriceBasis = personalizationOffered ? 'personalized' : 'unknown';
  if (!personalizationOffered) {
    warnings.push(
      'PRICE_BASIS_UNKNOWN: no personalize-this-design affordance was found; the listed price cannot be treated as a personalized unit price (fixed design, or the affordance did not render).',
    );
  }

  // Quantity/tier: only what the page states. "per shirt" states a per-unit
  // basis; the quantity control's "Current selection is 1 shirt" states a
  // supported quantity of 1.
  const perUnitLabelText = textOf(document, PER_UNIT_SELECTOR);
  const quantityText = textOf(document, QUANTITY_SELECTOR);
  const quantityMatch = quantityText === null ? null : QUANTITY_SELECTION_RE.exec(quantityText);
  const selectedQuantity = quantityMatch === null ? null : Number.parseInt(quantityMatch[1]!, 10);
  const priceQuantityTier = perUnitLabelText !== null ? 1 : selectedQuantity;
  const moq1Supported = selectedQuantity === 1 ? true : selectedQuantity !== null ? false : null;
  const moq = selectedQuantity === 1 ? 1 : null;

  // Discount / promo window: stated only.
  const discountPct = parseSavePercent(textOf(document, SAVE_LABEL_SELECTOR));
  const promoExpires =
    (typeof jsonld?.offers?.priceValidUntil === 'string' ? jsonld.offers.priceValidUntil : null) ??
    metaContent(document, 'og:price:end_date');

  // Shipping: zazzle.com states delivery DATES on the product page, not
  // costs. Cost stays null; the rendered estimate is kept as evidence.
  const shippingEstimateText = textOf(document, SHIPPING_ESTIMATE_SELECTOR);

  const ratingValue =
    typeof jsonld?.aggregateRating?.ratingValue === 'number' ? jsonld.aggregateRating.ratingValue : null;
  const ratingCountRaw = jsonld?.aggregateRating?.ratingCount ?? jsonld?.aggregateRating?.reviewCount;
  const ratingCount = typeof ratingCountRaw === 'number' ? Math.trunc(ratingCountRaw) : null;

  const { status: listingStatus } = detectListingStatus(document, jsonld);

  const record: ZazzleProductRecord = {
    siteProfile: 'zazzle.com.v1',
    profileRevision: ZAZZLE_PROFILE_REVISION,
    productId: productId === null ? null : field(productId, 'computed', 1),
    canonicalUrl: canonical === null ? null : field(canonical, canonicalSource, 1),
    title,
    vendor,
    listedPrice,
    originalPrice,
    priceBasis,
    priceQuantityTier,
    perUnitLabelText,
    moq,
    moq1Supported,
    personalizationOffered,
    personalizationMethod: personalizationOffered ? 'template' : null,
    personalizationIncludedInPrice: null,
    setupFee: null,
    digitizationFee: null,
    perLocationSurcharge: null,
    perColorSurcharge: null,
    includedLocations: null,
    maxColors: null,
    shipping: null,
    shippingEstimateText,
    shipsToCanada: null,
    freeShippingThreshold: null,
    discountPct,
    promoName: null,
    promoCode: null,
    promoExpires,
    promoTerms: null,
    ratingValue,
    ratingCount,
    listingStatus,
    observedAt,
    pageRevision,
  };

  return { record, warnings };
}

// ---------------------------------------------------------------------------
// Search / browse pages
// ---------------------------------------------------------------------------

export interface ZazzleSearchCandidate {
  productId: string;
  url: string;
  title: string | null;
  /**
   * Sale/shown price snippet. Currency comes from an explicit C$/CA$/US$
   * prefix when the card renders one, else from the storefront TLD
   * (zazzle.com USD, zazzle.ca CAD); null only off both storefronts.
   */
  price: { value: number; currency: string | null; rawText: string } | null;
  originalPrice: { value: number; currency: string | null; rawText: string } | null;
  /** Stated badge ("Save 10%"), kept raw. */
  discountText: string | null;
  order: number;
}

export interface ZazzleSearchPage {
  results: ZazzleSearchCandidate[];
  /**
   * True when the page renders Zazzle's "did not match any products" shell.
   * Observed live 2026-09-01: a /s/ DEEP LINK can render this shell while
   * the tab title still names the resolved category — driving the search
   * box with the same query on the same URL returned 60 candidates — so an
   * empty shell is ambiguous between a true zero and deep-link gating, and
   * the caller must retry via the search box before recording zero coverage.
   */
  noResultsShell: boolean;
}

const CARD_ROOT_SELECTOR = '[class*="SearchResultsGridCell2_root"], li, article';
const CARD_TITLE_SELECTOR = '[class*="SearchResultsGridCell2_title"]';
const CARD_SALE_PRICE_SELECTOR = '[class*="SearchProductPrice_priceAdjustedText"]';
const CARD_ORIGINAL_PRICE_SELECTOR = '[class*="SearchProductPrice_lineThrough"]';
const CARD_BADGE_SELECTOR = '[class*="SearchProductPriceBadge"]';

function cardRootFor(anchor: Element): Element {
  let known: Element | null = null;
  try {
    known = anchor.closest(CARD_ROOT_SELECTOR);
  } catch {
    known = null;
  }
  if (known !== null) return known;
  // Climb, stopping before a node that spans more than one product — the
  // same guard site-ebay's traversal uses.
  let root: Element = anchor;
  let node: Element | null = anchor.parentElement;
  for (let depth = 0; node !== null && depth < 5; depth += 1) {
    const ids = new Set<string>();
    for (const link of Array.from(node.querySelectorAll('a[href]'))) {
      const id = productIdFromUrl(link.getAttribute('href') ?? '');
      if (id !== null) ids.add(id);
    }
    if (ids.size > 1) break;
    root = node;
    node = node.parentElement;
  }
  return root;
}

function cardText(card: Element, selector: string): string | null {
  let el: Element | null = null;
  try {
    el = card.querySelector(selector);
  } catch {
    return null;
  }
  const text = collapseWhitespace(el?.textContent);
  return text.length > 0 ? text : null;
}

/** "Product: X" aria-labels wrap the plain title. */
function titleFromAria(anchor: Element): string | null {
  const aria = collapseWhitespace(anchor.getAttribute('aria-label'));
  if (aria.length === 0) return null;
  return aria.replace(/^product:\s*/i, '') || null;
}

/**
 * Regions whose product links describe the SESSION, not the search: the
 * "Recently Viewed Items" rail (rendered in the page's complementary
 * region) carries real product anchors, and on the no-results shell it was
 * the only anchor left — so an empty search produced one phantom candidate
 * with a null title and price (observed live 2026-09-01).
 */
const NON_RESULT_REGION_SELECTOR =
  '[role="complementary"], aside, [class*="RecentlyViewed"], [class*="recentlyViewed"]';

/** Zazzle's empty-results shell sentence (see ZazzleSearchPage.noResultsShell). */
const NO_RESULTS_RE = /did\s+not\s+match\s+any\s+products/i;

function inNonResultRegion(anchor: Element): boolean {
  try {
    return anchor.closest(NON_RESULT_REGION_SELECTOR) !== null;
  } catch {
    return false;
  }
}

function detectNoResultsShell(document: Document): boolean {
  // documentElement fallback: statically parsed fragments (the unit-test
  // path) can carry their content outside an empty body.
  const raw = document.body?.textContent || document.documentElement?.textContent || '';
  const text = raw.replace(/\s+/g, ' ');
  // Bounded scan: the shell sentence renders in the leading content, and
  // scanning the whole page text would also read script text (the failure
  // mode site-ebay documented for status banners).
  return NO_RESULTS_RE.test(text.slice(0, 4000));
}

export function extractZazzleSearchResults(document: Document, pageUrl: string): ZazzleSearchPage {
  const seen = new Set<string>();
  const results: ZazzleSearchCandidate[] = [];
  const pageCurrency = storefrontCurrency(pageUrl);
  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
    if (inNonResultRegion(anchor)) continue;
    const href = anchor.getAttribute('href');
    if (!href) continue;
    let absolute: string;
    try {
      absolute = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    let host: string;
    try {
      host = new URL(absolute).hostname.toLowerCase();
    } catch {
      continue;
    }
    // Off-site anchors with plausible numeric tails must not become
    // candidates (the Kijiji fixture's lesson). Both storefront TLDs count:
    // the CAD research surface is zazzle.ca.
    if (!/(?:^|\.)zazzle\.(?:com|ca)$/.test(host)) continue;
    const productId = productIdFromUrl(absolute);
    if (productId === null || seen.has(productId)) continue;
    seen.add(productId);

    const card = cardRootFor(anchor);
    const title =
      cardText(card, CARD_TITLE_SELECTOR) ??
      titleFromAria(anchor) ??
      (collapseWhitespace(card.getAttribute('title')) || null);
    const withPageCurrency = (
      money: ReturnType<typeof parseZazzleMoney>,
    ): ReturnType<typeof parseZazzleMoney> =>
      money === null || money.currency !== null ? money : { ...money, currency: pageCurrency };
    const price = withPageCurrency(parseZazzleMoney(cardText(card, CARD_SALE_PRICE_SELECTOR)));
    const originalPrice = withPageCurrency(parseZazzleMoney(cardText(card, CARD_ORIGINAL_PRICE_SELECTOR)));

    results.push({
      productId,
      url: canonicalProductUrl(absolute) ?? absolute,
      title,
      price,
      originalPrice,
      discountText: cardText(card, CARD_BADGE_SELECTOR),
      order: results.length,
    });
  }
  return { results, noResultsShell: detectNoResultsShell(document) };
}
