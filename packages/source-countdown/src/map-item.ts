/**
 * Product → ExtractionRecord (siteProfile 'ebay.api.v1') — docs/COUNTDOWN-API-PLAN.md §3.2, §4.2.
 *
 * Pure. The measured facts this rests on (§1.3): the item page reports a
 * live auction as `is_auction: false` with an `offer.price`, so format comes
 * only from the caller's `expectedFormat` and an auction's price is nulled;
 * `shipping.price` is a string in mixed forms resolved to the vendor's own
 * zip, so shipping is observed text with no destination; ended and sold are
 * signalled by `stock_status`, not `end_date`; `quantity_available: 0` on an
 * in-stock listing means "not shown"; `/str/<slug>` is not a login id.
 */
import {
  EBAY_API_PROFILE_REVISION,
  EBAY_API_SITE_PROFILE_ID,
  canonicalListingUrl,
  cleanTitle,
  itemIdFromUrl,
  parseMoney,
  type ExtractionRecord,
  type ListingStatus,
  type SellingFormatKind,
} from '@browser-bridge/site-ebay';
import {
  COUNTDOWN_WARNING,
  DESTINATION_UNVERIFIED_WARNING,
  domainCurrency,
  nonEmpty,
  parseSellerLink,
  readInt,
  readNumber,
  type CountdownDomain,
} from './common.js';
import { ProductResponseSchema, parseCountdownBody, type ProductResponse } from './schemas.js';

export interface MapItemInput {
  /** A decoded product response (the client's `body`, or a fixture). */
  body: unknown;
  domain: CountdownDomain;
  /** The item URL the caller asked for; the item-id fallback when the body carries no link. */
  requestedUrl?: string | null;
  /** The format the search that found the row established (§3.1). The item page's `is_auction` is never read. */
  expectedFormat?: SellingFormatKind;
  /** ISO instant stamped on the record. */
  observedAt: string;
}

export interface MapItemResult {
  /** 'unavailable' when the vendor returned no product ("Product not found.") or a redirect. */
  status: 'ok' | 'unavailable';
  record: ExtractionRecord;
  warnings: string[];
}

type StringField = NonNullable<ExtractionRecord['title']>;
type CountField = NonNullable<ExtractionRecord['imageCount']>;

const ITEM_ID_RE = /^\d{9,15}$/;

function apiString(value: unknown, confidence = 0.95): StringField | null {
  const text = nonEmpty(value);
  return text === null ? null : { value: text, source: 'api', confidence };
}

function apiCount(value: unknown, confidence = 0.95): CountField | null {
  const count = readInt(value);
  return count === null || count < 0 ? null : { value: count, source: 'api', confidence };
}

function apiNumber(value: unknown, confidence = 0.95): NonNullable<ExtractionRecord['sellerFeedbackScore']> | null {
  const number = readNumber(value);
  return number === null ? null : { value: number, source: 'api', confidence };
}

function apiBoolean(value: unknown, confidence = 1): NonNullable<ExtractionRecord['makeOffer']> | null {
  return typeof value === 'boolean' ? { value, source: 'api', confidence } : null;
}

function digits(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return ITEM_ID_RE.test(text) ? text : null;
}

function toIsoInstant(value: unknown): string | null {
  const text = nonEmpty(value);
  if (text === null) return null;
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

interface ResolvedItemId {
  itemId: ExtractionRecord['itemId'];
  observedUrl: string | null;
}

/**
 * `product.link` first, cross-checked against `product.epid` (the link wins
 * on disagreement); then the vendor's own resolved `request_metadata.ebay_url`;
 * then the caller's URL; then the echoed request parameters.
 */
function resolveItemId(body: ProductResponse, requestedUrl: string | null, warnings: string[]): ResolvedItemId {
  const product = body.product ?? null;
  const link = nonEmpty(product?.link);
  const epid = digits(product?.epid);
  const ebayUrl = nonEmpty(body.request_metadata?.ebay_url);
  const paramsUrl = nonEmpty(body.request_parameters?.url);
  const paramsEpid = digits(body.request_parameters?.epid);

  const fromLink = link === null ? null : itemIdFromUrl(link);
  if (fromLink !== null) {
    if (epid !== null && epid !== fromLink) {
      warnings.push(
        `${COUNTDOWN_WARNING.ITEM_ID_MISMATCH}: product.epid ${epid} disagrees with the link's item id ${fromLink}; the link wins.`,
      );
    }
    return { itemId: { value: fromLink, source: 'api', confidence: 1 }, observedUrl: link };
  }
  const fromEbayUrl = ebayUrl === null ? null : itemIdFromUrl(ebayUrl);
  if (fromEbayUrl !== null) {
    if (epid !== null && epid !== fromEbayUrl) {
      warnings.push(
        `${COUNTDOWN_WARNING.ITEM_ID_MISMATCH}: product.epid ${epid} disagrees with the resolved page URL's item id ${fromEbayUrl}; the URL wins.`,
      );
    }
    return { itemId: { value: fromEbayUrl, source: 'api', confidence: 0.98 }, observedUrl: ebayUrl };
  }
  if (epid !== null) return { itemId: { value: epid, source: 'api', confidence: 0.9 }, observedUrl: link };
  const fromRequested = requestedUrl === null ? null : itemIdFromUrl(requestedUrl);
  if (fromRequested !== null) {
    return { itemId: { value: fromRequested, source: 'computed', confidence: 0.9 }, observedUrl: requestedUrl };
  }
  const fromParams = paramsUrl === null ? null : itemIdFromUrl(paramsUrl);
  if (fromParams !== null) return { itemId: { value: fromParams, source: 'computed', confidence: 0.85 }, observedUrl: paramsUrl };
  if (paramsEpid !== null) return { itemId: { value: paramsEpid, source: 'computed', confidence: 0.85 }, observedUrl: null };
  warnings.push('itemId could not be resolved from the product link, the resolved page URL, or the requested URL');
  return { itemId: null, observedUrl: null };
}

function isAuctionKind(kind: SellingFormatKind): boolean {
  return kind === 'auction' || kind === 'auction_with_bin';
}

/** `warnings` is null on an unavailable record: there is no listing to classify, so no format warning. */
function resolveSellingFormat(
  body: ProductResponse,
  expectedFormat: SellingFormatKind | undefined,
  warnings: string[] | null,
): ExtractionRecord['sellingFormat'] {
  const bids = readInt(body.auction?.bids);
  const bidCount = bids === null || bids < 0 ? null : bids;
  if (expectedFormat !== undefined && expectedFormat !== 'unknown') {
    return { kind: expectedFormat, bidCount, source: 'computed', confidence: 0.9 };
  }
  warnings?.push(
    `${COUNTDOWN_WARNING.FORMAT_UNKNOWN_FROM_SOURCE}: the item page's is_auction reads false on live auctions, so no format was inferred; pass expectedFormat from the search that found the row.`,
  );
  return { kind: 'unknown', bidCount, source: 'api', confidence: 0.5 };
}

function outOfStock(body: ProductResponse): boolean {
  const stock = body.stock_status ?? null;
  if (stock === null) return false;
  const status = nonEmpty(stock.status)?.toLowerCase() ?? '';
  const raw = nonEmpty(stock.raw) ?? '';
  return status === 'not_in_stock' || status === 'out_of_stock' || /outofstock/i.test(raw);
}

function detectListingStatus(body: ProductResponse, hasPrice: boolean): ListingStatus {
  const stock = body.stock_status ?? null;
  if (outOfStock(body)) {
    return /this listing sold on/i.test(nonEmpty(stock?.message) ?? '') ? 'sold' : 'ended';
  }
  if (body.end_date !== undefined && body.end_date !== null) return 'ended';
  const status = nonEmpty(stock?.status)?.toLowerCase() ?? '';
  const raw = nonEmpty(stock?.raw) ?? '';
  const inStock = status === 'in_stock' || /\binstock\b/i.test(raw);
  return inStock && hasPrice ? 'active' : 'unknown';
}

const ISO_PRICE_RE = /^([A-Za-z]{3})\s*([\d,]+(?:\.\d{1,2})?)$/;
const BARE_PRICE_RE = /^([\d,]+(?:\.\d{1,2})?)$/;

function mapShipping(body: ProductResponse, domain: CountdownDomain, warnings: string[]): ExtractionRecord['shipping'] {
  const block = body.shipping ?? null;
  const rawPrice = block?.price;
  const priceText = typeof rawPrice === 'number' ? String(rawPrice) : nonEmpty(rawPrice);
  if (block === null || priceText === null) {
    warnings.push('shipping could not be resolved');
    return null;
  }
  const service = nonEmpty(block.service);
  const observedText = service === null ? priceText : `${priceText} (${service})`;
  const currency = domainCurrency(domain);
  const base = { source: 'api' as const, destinationPostalCode: null, destinationVerified: false, observedText };

  if (typeof rawPrice === 'number') {
    return { ...base, value: Number.isFinite(rawPrice) ? rawPrice : null, currency, confidence: 0.4 };
  }
  const parsed = parseMoney(priceText, currency);
  if (parsed !== null) {
    if (parsed.approximate) warnings.push(`shipping parsed from a range: "${priceText}"`);
    return { ...base, value: parsed.value, currency: parsed.currency, confidence: parsed.approximate ? 0.8 : 0.9 };
  }
  const iso = ISO_PRICE_RE.exec(priceText);
  if (iso !== null) {
    return {
      ...base,
      value: Number.parseFloat(iso[2]!.replace(/,/g, '')),
      currency: iso[1]!.toUpperCase(),
      confidence: 0.9,
    };
  }
  const bare = BARE_PRICE_RE.exec(priceText);
  if (bare !== null) {
    // The vendor stripped the symbol; the domain currency is a guess.
    return { ...base, value: Number.parseFloat(bare[1]!.replace(/,/g, '')), currency, confidence: 0.4 };
  }
  warnings.push(`shipping text observed but not parseable as an amount: "${priceText}"`);
  return { ...base, value: null, currency: null, confidence: 0.5 };
}

function mapVariants(body: ProductResponse): ExtractionRecord['variants'] {
  const variants = (body.product?.variants ?? []).filter((entry) => entry !== null && entry !== undefined);
  if (variants.length === 0) return null;
  const dimensions = new Map<string, Set<string>>();
  const titles: string[] = [];
  for (const entry of variants) {
    const variant = asRecord(entry);
    if (variant === null) continue;
    const title = nonEmpty(variant.title) ?? nonEmpty(variant.name);
    if (title !== null) titles.push(title);
    const attributes = variant.attributes;
    const pairs: Array<[string, string]> = [];
    if (Array.isArray(attributes)) {
      for (const attribute of attributes) {
        const pair = asRecord(attribute);
        const name = nonEmpty(pair?.name);
        const value = nonEmpty(pair?.value);
        if (name !== null && value !== null) pairs.push([name, value]);
      }
    } else {
      const record = asRecord(attributes);
      if (record !== null) {
        for (const [name, value] of Object.entries(record)) {
          const text = nonEmpty(value);
          if (text !== null) pairs.push([name, text]);
        }
      }
    }
    for (const [name, value] of pairs) {
      const options = dimensions.get(name) ?? new Set<string>();
      options.add(value);
      dimensions.set(name, options);
    }
  }
  const selections =
    dimensions.size > 0
      ? [...dimensions.entries()].map(([label, options]) => ({ label, selected: null, options: [...options] }))
      : [{ label: 'variant', selected: null, options: titles }];
  return { hasVariants: true, selections };
}

function mapAttributes(body: ProductResponse): ExtractionRecord['attributes'] {
  const attributes = body.product?.attributes ?? null;
  if (attributes === null || attributes === undefined) return null;
  const out: Array<{ name: string; value: string }> = [];
  for (const attribute of attributes) {
    if (attribute === null || attribute === undefined) continue;
    const name = nonEmpty(attribute.name);
    const value = nonEmpty(attribute.value);
    if (name === null || value === null) continue;
    out.push({ name, value });
    if (out.length === 40) break;
  }
  return out;
}

function mapCategories(body: ProductResponse): ExtractionRecord['categories'] {
  const categories = body.product?.categories ?? null;
  if (categories === null || categories === undefined) return null;
  const names: string[] = [];
  for (const category of categories) {
    const name = nonEmpty(category?.name);
    if (name !== null) names.push(name);
  }
  return names;
}

function emptyRecord(
  itemId: ExtractionRecord['itemId'],
  canonicalUrl: ExtractionRecord['canonicalUrl'],
  sellingFormat: ExtractionRecord['sellingFormat'],
  listingStatus: ListingStatus,
  observedAt: string,
): ExtractionRecord {
  return {
    siteProfile: EBAY_API_SITE_PROFILE_ID,
    itemId,
    canonicalUrl,
    title: null,
    seller: null,
    itemPrice: null,
    shipping: null,
    offer: { available: false, sellerOfferPrice: null, expiresAt: null },
    variants: null,
    listingStatus,
    sellingFormat,
    endsAt: null,
    timeLeftText: null,
    itemLocationText: null,
    watcherCount: null,
    quantityAvailable: null,
    quantitySold: null,
    observedAt,
    pageRevision: 0,
    profileRevision: EBAY_API_PROFILE_REVISION,
    shipsToText: null,
    deliveryEstimateText: null,
    conditionText: null,
    returnsText: null,
    returnsAccepted: null,
    sellerDisplayName: null,
    sellerStoreSlug: null,
    sellerFeedbackScore: null,
    sellerPositivePercent: null,
    sellerProfileUrl: null,
    makeOffer: null,
    imageCount: null,
    attributes: null,
    categories: null,
  };
}

/** Map one product response onto an ExtractionRecord. Never throws on content; only a body that is not a product response at all is EXTRACTION_INCOMPLETE. */
export function mapItem(input: MapItemInput): MapItemResult {
  const body = parseCountdownBody(ProductResponseSchema, input.body, 'product');
  const warnings: string[] = [];
  const requestedUrl = nonEmpty(input.requestedUrl);
  const { itemId, observedUrl } = resolveItemId(body, requestedUrl, warnings);
  const canonicalUrl: ExtractionRecord['canonicalUrl'] =
    itemId === null
      ? null
      : {
          value: canonicalListingUrl(itemId.value, observedUrl ?? requestedUrl ?? `https://www.${input.domain}/`),
          source: 'computed',
          confidence: 1,
        };
  // --- unavailable: no product block, or eBay redirected an unavailable item ---
  const product = body.product ?? null;
  const redirected = body.redirected === true;
  const sellingFormat = resolveSellingFormat(body, input.expectedFormat, product === null || redirected ? null : warnings);
  if (product === null || redirected) {
    if (redirected) {
      const target = nonEmpty(body.redirected_link);
      const targetId = digits(body.redirected_epid);
      warnings.push(
        `${COUNTDOWN_WARNING.LISTING_REDIRECTED}: eBay redirected this item${target === null ? '' : ` to ${target}`}${targetId === null ? '' : ` (item ${targetId})`}; the listing is unavailable and nothing from the redirect target was mapped.`,
      );
    } else {
      const message = nonEmpty(body.message);
      warnings.push(
        `${COUNTDOWN_WARNING.LISTING_UNAVAILABLE}: ${message ?? 'the source returned no product block'}`,
      );
    }
    warnings.push(DESTINATION_UNVERIFIED_WARNING);
    return {
      status: 'unavailable',
      record: emptyRecord(itemId, canonicalUrl, sellingFormat, 'unavailable', input.observedAt),
      warnings,
    };
  }

  // --- price: fixed price from offer; auctions are nulled (the vendor reports a live auction as a fixed price) ---
  const offerPrice = body.offer?.price;
  const offerCurrency = nonEmpty(body.offer?.currency);
  const hasOfferPrice = typeof offerPrice === 'number' && Number.isFinite(offerPrice);
  const hasAuctionBid = typeof body.auction?.winning_bid_price === 'number';
  let itemPrice: ExtractionRecord['itemPrice'] = null;
  if (isAuctionKind(sellingFormat.kind)) {
    warnings.push(
      `${COUNTDOWN_WARNING.AUCTION_DETAIL_UNAVAILABLE_FROM_SOURCE}: this source cannot supply a bid, an end time or a price for an auction (it reported a live auction as a fixed price); itemPrice, endsAt and timeLeftText are null unless the vendor's auction block is present. Use the Bridge for auction detail.`,
    );
    warnings.push(
      `${COUNTDOWN_WARNING.AUCTION_PRICE}: itemPrice is null on this ${sellingFormat.kind} listing${
        hasOfferPrice ? `; the source's offer.price (${offerPrice} ${offerCurrency ?? domainCurrency(input.domain)}) is not a purchasable fixed price and was discarded` : ''
      }`,
    );
  } else if (hasOfferPrice) {
    itemPrice = {
      value: offerPrice,
      currency: offerCurrency === null ? domainCurrency(input.domain) : offerCurrency.toUpperCase(),
      source: 'api',
      confidence: offerCurrency === null ? 0.7 : 0.95,
    };
  } else {
    warnings.push('itemPrice could not be resolved');
  }

  // --- seller: login id only from /usr/ and /sch/<id>/m.html; /str/ is a store slug ---
  const sellerBlock = body.seller ?? null;
  const sellerLink = nonEmpty(sellerBlock?.link);
  const parsedLink = parseSellerLink(sellerLink);
  const seller: ExtractionRecord['seller'] =
    parsedLink.loginId === null ? null : { value: parsedLink.loginId, source: 'api', confidence: 0.98 };
  const sellerStoreSlug = apiString(parsedLink.storeSlug, 0.98);
  if (seller === null) {
    if (sellerStoreSlug !== null) {
      warnings.push(
        `${COUNTDOWN_WARNING.SELLER_LOGIN_ID_UNAVAILABLE}: the seller link is a store page (/str/${sellerStoreSlug.value}); a store slug is not a login id. Resolve it with the seller tool before matching the roster.`,
      );
    } else {
      warnings.push('seller could not be resolved');
    }
  }

  // --- shipping: observed text resolved to the vendor's own location, never a destination ---
  const shipping = mapShipping(body, input.domain, warnings);
  warnings.push(DESTINATION_UNVERIFIED_WARNING);

  // --- status, quantities ---
  const listingStatus = detectListingStatus(body, hasOfferPrice || hasAuctionBid);
  const stock = body.stock_status ?? null;
  const isOut = outOfStock(body);
  const quantityRaw = stock?.quantity_available;
  const quantityAvailable: ExtractionRecord['quantityAvailable'] =
    typeof quantityRaw === 'number' && Number.isInteger(quantityRaw) && quantityRaw >= 0 && (quantityRaw > 0 || isOut)
      ? { value: quantityRaw, source: 'api', confidence: 0.95 }
      : null;
  const quantitySold = apiCount(stock?.quantity_sold, 0.95);

  // --- auction block, when the vendor ever returns one ---
  const auction = body.auction ?? null;
  const endDate = auction?.end_date;
  const endsAtRaw = typeof endDate === 'string' ? endDate : (endDate?.utc ?? endDate?.raw ?? null);
  const endsAtIso = toIsoInstant(endsAtRaw);
  const endsAt: ExtractionRecord['endsAt'] = endsAtIso === null ? null : { value: endsAtIso, source: 'api', confidence: 0.95 };
  const timeLeft = auction?.time_left;
  const timeLeftText = apiString(typeof timeLeft === 'string' ? timeLeft : timeLeft?.raw, 0.95);

  const shippingBlock = body.shipping ?? null;
  const conditionBlock = body.condition ?? null;
  const returns = body.returns_policy ?? null;
  const images = product.images ?? null;
  const imageCount = apiCount(product.image_count, 0.95) ?? (Array.isArray(images) ? apiCount(images.length, 0.9) : null);

  const record: ExtractionRecord = {
    siteProfile: EBAY_API_SITE_PROFILE_ID,
    itemId,
    canonicalUrl,
    title: apiString(product.title === null || product.title === undefined ? null : cleanTitle(product.title), 0.98),
    seller,
    itemPrice,
    shipping,
    offer: { available: body.make_offer === true, sellerOfferPrice: null, expiresAt: null },
    variants: mapVariants(body),
    listingStatus,
    sellingFormat,
    endsAt,
    timeLeftText,
    itemLocationText: apiString(shippingBlock?.location, 0.95),
    watcherCount: null,
    quantityAvailable,
    quantitySold,
    observedAt: input.observedAt,
    pageRevision: 0,
    profileRevision: EBAY_API_PROFILE_REVISION,
    shipsToText: apiString(shippingBlock?.ships_to, 0.9),
    deliveryEstimateText: apiString(shippingBlock?.deliveryEstimate ?? shippingBlock?.delivery_estimate, 0.9),
    conditionText: apiString(conditionBlock?.raw ?? conditionBlock?.name, 0.95),
    returnsText: apiString(returns?.raw, 0.95),
    returnsAccepted: apiBoolean(returns?.returns_accepted),
    sellerDisplayName: apiString(sellerBlock?.name, 0.95),
    sellerStoreSlug,
    sellerFeedbackScore: apiNumber(sellerBlock?.feedback_score),
    sellerPositivePercent: apiNumber(sellerBlock?.positive_feedback_percent),
    sellerProfileUrl: apiString(sellerLink, 0.98),
    makeOffer: apiBoolean(body.make_offer),
    imageCount,
    attributes: mapAttributes(body),
    categories: mapCategories(body),
  };
  if (record.title === null) warnings.push('title could not be resolved');

  return { status: 'ok', record, warnings };
}
