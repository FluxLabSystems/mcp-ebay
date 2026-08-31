/**
 * Structured Zazzle product record — spec P1 of the site-profile
 * specifications (browser-bridge-site-profiles.md), on the Kijiji
 * provenance shape (conformance contract C1: every resolved field carries
 * {value, source, confidence}).
 *
 * Two deliberate deviations from the spec's field sketch, both in service
 * of its own stronger invariants:
 *
 *   1. Money is emitted in the LISTED currency, never converted (the spec's
 *      hard rule: "Emit the listed currency untouched. Conversion, fxRate,
 *      and fxRateAsOf are the routine's job"). The sketch's *Cad-suffixed
 *      fee names (setupFeeCad, shippingCad, …) are therefore realized as
 *      currency-carrying money objects (setupFee, shipping, …): a USD SKU
 *      cannot honestly populate a *Cad field without converting.
 *   2. C7 (never infer): a field zazzle.com does not state — fee breakdowns,
 *      shipsToCanada, personalizationIncludedInPrice — is an explicit null,
 *      never a guess. The wardrobe routine must treat such records as
 *      unverified for threshold purposes, which is exactly the spec's
 *      priceBasis fail-safe.
 */
import * as z from 'zod/v4';

export const ZazzleFieldSourceSchema = z.enum(['dom', 'jsonld', 'meta', 'computed']);
export type ZazzleFieldSource = z.infer<typeof ZazzleFieldSourceSchema>;

const provenance = {
  source: ZazzleFieldSourceSchema,
  confidence: z.number().min(0).max(1),
};

const stringField = z.strictObject({ value: z.string(), ...provenance });

/**
 * Money as listed. `currency` is set only when the page STATES it (JSON-LD
 * priceCurrency); a bare "$" price keeps currency null plus the raw text,
 * and the consumer must not fire CAD thresholds on it (spec P1 invariant:
 * no CAD threshold without fxRate — and no fxRate without a known source
 * currency).
 */
const moneyField = z.strictObject({
  value: z.number(),
  currency: z.string().nullable(),
  rawText: z.string(),
  ...provenance,
});

/**
 * The C4 basis discriminator. zazzle.com.v1 emits:
 *   'personalized' — the page offers the personalize-this-design flow, so
 *                    the listed price is a personalizable product's price;
 *   'unknown'      — no personalization affordance was found (a fixed
 *                    design, or the affordance failed to render). Never
 *                    usable for the personalized-price triggers.
 *   'blank'        — reserved for vendors that price blank garments
 *                    separately; zazzle.com.v1 never emits it.
 */
export const ZazzlePriceBasisSchema = z.enum(['blank', 'personalized', 'unknown']);
export type ZazzlePriceBasis = z.infer<typeof ZazzlePriceBasisSchema>;

export const ZazzleListingStatusSchema = z.enum(['active', 'unavailable', 'unknown']);
export type ZazzleListingStatus = z.infer<typeof ZazzleListingStatusSchema>;

export const ZAZZLE_PROFILE_REVISION = 1;

export const ZazzleProductRecordSchema = z.strictObject({
  siteProfile: z.literal('zazzle.com.v1'),
  profileRevision: z.literal(ZAZZLE_PROFILE_REVISION),
  productId: stringField.nullable(),
  /** From og:url / the JSON-LD offer URL — NEVER link[rel=canonical], which
   *  Zazzle points at style-variant siblings. */
  canonicalUrl: stringField.nullable(),
  title: stringField.nullable(),
  /** The designer/store attribution (JSON-LD brand). */
  vendor: stringField.nullable(),
  /** Price as shown (the sale price when a sale is on). */
  listedPrice: moneyField.nullable(),
  /** Strikethrough / og:price:standard_amount price when stated. */
  originalPrice: moneyField.nullable(),
  priceBasis: ZazzlePriceBasisSchema,
  /** Quantity tier the shown price applies to; 1 only when the page states a
   *  per-unit basis ("per shirt") — otherwise null, never assumed. */
  priceQuantityTier: z.int().nullable(),
  /** The stated per-unit label ("per shirt"), kept as evidence for the tier. */
  perUnitLabelText: z.string().nullable(),
  moq: z.int().nullable(),
  moq1Supported: z.boolean().nullable(),
  personalizationOffered: z.boolean(),
  /** Zazzle's personalization is design-template editing. */
  personalizationMethod: z.enum(['template']).nullable(),
  /** zazzle.com never states whether template edits change the price → null
   *  in v1 (C7). Verify in the designer flow before ever populating this. */
  personalizationIncludedInPrice: z.boolean().nullable(),
  setupFee: moneyField.nullable(),
  digitizationFee: moneyField.nullable(),
  perLocationSurcharge: moneyField.nullable(),
  perColorSurcharge: moneyField.nullable(),
  includedLocations: z.int().nullable(),
  maxColors: z.int().nullable(),
  shipping: moneyField.nullable(),
  /** Rendered delivery estimate ("Order today … get it by Sep 4 …"). */
  shippingEstimateText: z.string().nullable(),
  shipsToCanada: z.boolean().nullable(),
  freeShippingThreshold: moneyField.nullable(),
  /** Stated discount only ("You save 10%"); never computed from two prices. */
  discountPct: z.number().nullable(),
  promoName: z.string().nullable(),
  promoCode: z.string().nullable(),
  /** JSON-LD offers.priceValidUntil / og:price:end_date — when the shown
   *  (sale) price stops being promised. */
  promoExpires: z.string().nullable(),
  promoTerms: z.string().nullable(),
  ratingValue: z.number().nullable(),
  ratingCount: z.int().nullable(),
  listingStatus: ZazzleListingStatusSchema,
  observedAt: z.iso.datetime({ offset: true }),
  pageRevision: z.int(),
});

export type ZazzleProductRecord = z.infer<typeof ZazzleProductRecordSchema>;
