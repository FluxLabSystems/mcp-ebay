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

export const ListingStatusSchema = z.enum(['active', 'ended', 'unavailable', 'unknown']);
export type ListingStatus = z.infer<typeof ListingStatusSchema>;

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
  observedAt: z.iso.datetime({ offset: true }),
  pageRevision: z.int(),
});

export type ExtractionRecord = z.infer<typeof ExtractionRecordSchema>;
