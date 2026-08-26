/**
 * Structured extraction record — SDD v0.5 §20.3. Every field carries
 * provenance and confidence; values are never silently substituted from
 * search snippets or non-destination proxies.
 */
import * as z from 'zod/v4';

export const FieldSourceSchema = z.enum(['dom', 'jsonld', 'meta', 'computed']);
export type FieldSource = z.infer<typeof FieldSourceSchema>;

const stringField = z.strictObject({
  value: z.string(),
  source: FieldSourceSchema,
  confidence: z.number().min(0).max(1),
});

/**
 * 'sold' is distinct from 'ended': an auction that closed with no winner and
 * a listing that sold are both "over", but only one of them is a comparable
 * price observation. Collapsing them loses the signal the deals watch exists
 * to collect.
 */
export const ListingStatusSchema = z.enum(['active', 'ended', 'sold', 'unavailable', 'unknown']);
export type ListingStatus = z.infer<typeof ListingStatusSchema>;

/**
 * Auction and Buy-It-Now prices are not the same quantity -- a current bid
 * moves and a fixed price does not -- and an item page renders both the same
 * way. Without this, scoring treats a live bid as a purchasable price.
 */
export const SellingFormatKindSchema = z.enum(['auction', 'fixed_price', 'auction_with_bin', 'unknown']);
export type SellingFormatKind = z.infer<typeof SellingFormatKindSchema>;

export const ExtractionRecordSchema = z.strictObject({
  siteProfile: z.literal('ebay.ca.v1'),
  itemId: stringField.nullable(),
  canonicalUrl: stringField.nullable(),
  title: stringField.nullable(),
  seller: stringField.nullable(),
  itemPrice: z
    .strictObject({
      value: z.number(),
      currency: z.string(),
      source: FieldSourceSchema,
      confidence: z.number().min(0).max(1),
    })
    .nullable(),
  shipping: z
    .strictObject({
      value: z.number().nullable(),
      currency: z.string().nullable(),
      source: FieldSourceSchema,
      confidence: z.number().min(0).max(1),
      destinationPostalCode: z.string().nullable(),
      destinationVerified: z.boolean(),
      observedText: z.string().nullable(),
    })
    .nullable(),
  offer: z.strictObject({
    available: z.boolean(),
    sellerOfferPrice: z.number().nullable(),
    expiresAt: z.string().nullable(),
  }),
  variants: z
    .strictObject({
      hasVariants: z.boolean(),
      selections: z.array(
        z.strictObject({
          label: z.string(),
          selected: z.string().nullable(),
          options: z.array(z.string()),
        }),
      ),
    })
    .nullable(),
  listingStatus: ListingStatusSchema,
  sellingFormat: z.strictObject({
    kind: SellingFormatKindSchema,
    /** Bids placed so far; null on a fixed-price listing or when unreadable. */
    bidCount: z.int().min(0).nullable(),
    source: FieldSourceSchema,
    confidence: z.number().min(0).max(1),
  }),
  observedAt: z.iso.datetime({ offset: true }),
  pageRevision: z.int(),
});

export type ExtractionRecord = z.infer<typeof ExtractionRecordSchema>;
