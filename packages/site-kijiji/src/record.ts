/**
 * Structured Kijiji extraction record — mirrors the site-ebay §20.3
 * conventions. Every resolved field carries provenance and confidence;
 * values are never silently substituted from search snippets. Names are
 * Kijiji-prefixed so both site packages can be consumed side by side.
 */
import * as z from 'zod/v4';

export const KijijiFieldSourceSchema = z.enum(['dom', 'jsonld', 'meta', 'computed']);
export type KijijiFieldSource = z.infer<typeof KijijiFieldSourceSchema>;

const stringField = z.strictObject({
  value: z.string(),
  source: KijijiFieldSourceSchema,
  confidence: z.number().min(0).max(1),
});

export const KijijiPriceKindSchema = z.enum(['amount', 'free', 'contact', 'swap']);

export const KijijiListingStatusSchema = z.enum(['active', 'deleted', 'expired', 'unknown']);
export type KijijiListingStatus = z.infer<typeof KijijiListingStatusSchema>;

export const KijijiSellerTypeSchema = z.enum(['dealer', 'owner', 'unknown']);
export type KijijiSellerType = z.infer<typeof KijijiSellerTypeSchema>;

export const KijijiExtractionRecordSchema = z.strictObject({
  siteProfile: z.literal('kijiji.ca.v1'),
  adId: stringField.nullable(),
  canonicalUrl: stringField.nullable(),
  title: stringField.nullable(),
  price: z
    .strictObject({
      kind: KijijiPriceKindSchema,
      /** Numeric amount for "amount"; 0 for "free"; null for "contact"/"swap". */
      value: z.number().nullable(),
      currency: z.literal('CAD'),
      rawText: z.string(),
      source: KijijiFieldSourceSchema,
      confidence: z.number().min(0).max(1),
    })
    .nullable(),
  /** Rendered location text (e.g. "Toronto, ON M6H 2W9"); never geocoded here. */
  location: z
    .strictObject({
      text: z.string(),
      source: KijijiFieldSourceSchema,
      confidence: z.number().min(0).max(1),
    })
    .nullable(),
  /** ISO timestamp when the posted time was machine-parseable; else null. */
  postedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Raw rendered posted text ("Posted 2 hours ago"), kept even when postedAt parses. */
  postedText: z.string().nullable(),
  sellerName: stringField.nullable(),
  sellerType: KijijiSellerTypeSchema,
  /** Description excerpt, whitespace-collapsed and capped at 500 chars. */
  description: z
    .strictObject({
      value: z.string().max(500),
      source: KijijiFieldSourceSchema,
      confidence: z.number().min(0).max(1),
    })
    .nullable(),
  attributes: z.array(
    z.strictObject({
      label: z.string(),
      value: z.string(),
    }),
  ),
  imageCount: z.int().nullable(),
  listingStatus: KijijiListingStatusSchema,
  observedAt: z.iso.datetime({ offset: true }),
  pageRevision: z.int(),
});

export type KijijiExtractionRecord = z.infer<typeof KijijiExtractionRecordSchema>;
