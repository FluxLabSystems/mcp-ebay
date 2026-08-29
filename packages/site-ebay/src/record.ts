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

const countField = z.strictObject({
  value: z.int().min(0),
  source: FieldSourceSchema,
  confidence: z.number().min(0).max(1),
});

const instantField = z.strictObject({
  value: z.iso.datetime({ offset: true }),
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
  /**
   * When the listing closes. A deals run that cannot see this has to open
   * every auction just to learn which ones are about to end, and pays for
   * that in tool calls. Null when the page exposes no end time at all --
   * a fixed-price listing with no duration shown, or a template that renders
   * neither a timestamp nor a countdown. Never inferred from a bare date:
   * "ends Sep 3" does not say which minute.
   */
  endsAt: instantField.nullable(),
  /**
   * The countdown exactly as rendered ("5d 04h left"). Kept beside endsAt
   * because it is the value that is certainly true: an endsAt computed from
   * this text is no finer than the text was.
   */
  timeLeftText: stringField.nullable(),
  itemLocationText: stringField.nullable(),
  watcherCount: countField.nullable(),
  /**
   * "More than 10 available" is a floor, not a count -- the number is stored
   * with reduced confidence rather than dropped, since a floor still ranks.
   */
  quantityAvailable: countField.nullable(),
  quantitySold: countField.nullable(),
  observedAt: z.iso.datetime({ offset: true }),
  pageRevision: z.int(),
  /**
   * Which additive revision of this shape produced the record. The profile
   * id cannot carry it: 'ebay.ca.v1' is a wire enum value pinned by the
   * protocol schema, the agent executor and the dashboards, so it may not
   * move when the record only gains fields.
   */
  profileRevision: z.int(),
});

export type ExtractionRecord = z.infer<typeof ExtractionRecordSchema>;
