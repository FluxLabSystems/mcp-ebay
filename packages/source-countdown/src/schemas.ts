/**
 * Loose response schemas for the Countdown API — docs/COUNTDOWN-API-PLAN.md §1.3, §6.2.
 *
 * Every field is optional AND nullable (the vendor sends explicit nulls:
 * `shipping_cost: null`, `seller_info: null`, `credits_used: null`) and
 * unknown fields pass through, so a vendor change adds data instead of
 * breaking the mapper. A shape violation becomes EXTRACTION_INCOMPLETE naming
 * the failing path; a raw ZodError never escapes.
 */
import { BridgeError } from '@browser-bridge/protocol';
import * as z from 'zod/v4';

const opt = <T extends z.ZodType>(schema: T) => schema.nullable().optional();
const optString = () => opt(z.string());
const optNumber = () => opt(z.number());
const optBoolean = () => opt(z.boolean());
/** The vendor's numbers-as-strings ("review_count": "126") and strings-as-numbers. */
const optNumberish = () => opt(z.union([z.number(), z.string()]));

export const RequestInfoSchema = z.looseObject({
  success: optBoolean(),
  demo: optBoolean(),
  message: optString(),
  credits_used: optNumber(),
  credits_remaining: optNumber(),
  credits_used_this_request: optNumber(),
  retry_after: optNumberish(),
});
export type RequestInfo = z.infer<typeof RequestInfoSchema>;

export const RequestMetadataPageSchema = z.looseObject({
  page: optNumber(),
  ebay_url: optString(),
  created_at: optString(),
  processed_at: optString(),
  total_time_taken: optNumber(),
});

export const RequestMetadataSchema = z.looseObject({
  id: optString(),
  created_at: optString(),
  processed_at: optString(),
  total_time_taken: optNumber(),
  /** Absent when max_page > 1; then `pages[]` carries one entry per page. */
  ebay_url: optString(),
  pages: opt(z.array(RequestMetadataPageSchema)),
});
export type RequestMetadata = z.infer<typeof RequestMetadataSchema>;

export const RequestParametersSchema = z.looseObject({
  type: optString(),
  ebay_domain: optString(),
  search_term: optString(),
  url: optString(),
  epid: optNumberish(),
  seller_name: optString(),
  customer_location: optString(),
  customer_zipcode: optString(),
});

/** `prices[]` entries carry `value` and `raw` only on both domains (§1.3); `currency`/`name` are documented but unseen. */
export const SearchPriceSchema = z.looseObject({
  value: optNumber(),
  raw: optString(),
  currency: optString(),
  name: optString(),
});
export type SearchPrice = z.infer<typeof SearchPriceSchema>;

export const SearchSellerInfoSchema = z.looseObject({
  name: optString(),
  review_count: optNumberish(),
  positive_feedback_percent: optNumberish(),
});

export const SearchRowSchema = z.looseObject({
  position: optNumber(),
  /** Present only when max_page > 1. */
  position_overall: optNumber(),
  page: optNumber(),
  title: optString(),
  /** Sometimes an eBay PRODUCT id, not the item number: never the item id (§1.3). */
  epid: optNumberish(),
  link: optString(),
  image: optString(),
  condition: optString(),
  item_location: optString(),
  is_auction: optBoolean(),
  buy_it_now: optBoolean(),
  best_offer: optBoolean(),
  best_offer_accepted: optBoolean(),
  free_returns: optBoolean(),
  sponsored: optBoolean(),
  is_rewritten_result: optBoolean(),
  shipping_cost: optNumberish(),
  prices: opt(z.array(SearchPriceSchema.nullable())),
  price: opt(SearchPriceSchema),
  seller_info: opt(SearchSellerInfoSchema),
  hotness: optString(),
  ended: opt(z.looseObject({ type: optString(), date: optString() })),
});
export type SearchRow = z.infer<typeof SearchRowSchema>;

export const PaginationPageSchema = z.looseObject({
  current_page: optNumber(),
  total_results: optNumber(),
  next_page: optNumber(),
  has_next_page: optBoolean(),
});

export const PaginationSchema = z.looseObject({
  current_page: optNumber(),
  total_results: optNumber(),
  next_page: optNumber(),
  has_next_page: optBoolean(),
  /** The max_page > 1 shape: one entry per fetched page. */
  pages: opt(z.array(PaginationPageSchema)),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export const SearchResponseSchema = z.looseObject({
  request_info: opt(RequestInfoSchema),
  request_parameters: opt(RequestParametersSchema),
  request_metadata: opt(RequestMetadataSchema),
  search_results: opt(z.array(SearchRowSchema.nullable())),
  pagination: opt(PaginationSchema),
  facets: opt(z.array(z.unknown())),
  message: optString(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const ProductAttributeSchema = z.looseObject({ name: optString(), value: optNumberish() });
export const ProductCategorySchema = z.looseObject({ name: optString(), link: optString() });

export const ProductBlockSchema = z.looseObject({
  is_master: optBoolean(),
  title: optString(),
  /** Documented as the item id; absent on every url-form capture. Cross-checked against the link. */
  epid: optNumberish(),
  link: optString(),
  description: optString(),
  description_external_url: optString(),
  images: opt(z.array(z.unknown())),
  image_count: optNumber(),
  primary_image: optString(),
  attributes: opt(z.array(ProductAttributeSchema.nullable())),
  categories: opt(z.array(ProductCategorySchema.nullable())),
  variants: opt(z.array(z.unknown())),
  last_updated: optString(),
  brand: optString(),
});

export const AuctionBlockSchema = z.looseObject({
  bids: optNumberish(),
  winning_bid_price: optNumber(),
  winning_bid_price_raw: optString(),
  winning_bid_price_converted: opt(z.unknown()),
  time_left: opt(z.union([z.string(), z.looseObject({ raw: optString() })])),
  end_date: opt(z.union([z.string(), z.looseObject({ utc: optString(), raw: optString() })])),
  buy_it_now: opt(z.unknown()),
});

export const ProductResponseSchema = z.looseObject({
  request_info: opt(RequestInfoSchema),
  request_parameters: opt(RequestParametersSchema),
  request_metadata: opt(RequestMetadataSchema),
  /** "Product not found." on HTTP 200 with success:true and no product block (§1.3). */
  message: optString(),
  redirected: optBoolean(),
  redirected_link: optString(),
  redirected_epid: optNumberish(),
  /** False on live auctions (§1.3); never read for format. */
  is_auction: optBoolean(),
  make_offer: optBoolean(),
  product: opt(ProductBlockSchema),
  auction: opt(AuctionBlockSchema),
  offer: opt(
    z.looseObject({
      price: optNumber(),
      currency: optString(),
      best_offer_accepted: optBoolean(),
      sale_date: optString(),
    }),
  ),
  stock_status: opt(
    z.looseObject({
      raw: optString(),
      status: optString(),
      message: optString(),
      quantity_available: optNumber(),
      quantity_sold: optNumber(),
    }),
  ),
  condition: opt(z.looseObject({ raw: optString(), name: optString(), is_new: optBoolean(), is_used: optBoolean() })),
  returns_policy: opt(z.looseObject({ raw: optString(), returns_accepted: optBoolean() })),
  seller: opt(
    z.looseObject({
      name: optString(),
      link: optString(),
      feedback_score: optNumberish(),
      positive_feedback_percent: optNumberish(),
    }),
  ),
  shipping: opt(
    z.looseObject({
      /** A STRING in mixed forms: "C $68.71", "GBP 21.56 ", "7.95 ", "Free" (§1.3). */
      price: optNumberish(),
      service: optString(),
      ships_to: optString(),
      location: optString(),
      delivery_estimate: optString(),
      /** The measured key is camel-cased. */
      deliveryEstimate: optString(),
      link: optString(),
    }),
  ),
  payment_methods: opt(z.unknown()),
  /** Documented as present when the listing is flagged ended; shape unverified, presence is the signal. */
  end_date: opt(z.unknown()),
  promotion: opt(z.looseObject({ why_buy: opt(z.array(z.string().nullable())) })),
  html: optString(),
});
export type ProductResponse = z.infer<typeof ProductResponseSchema>;

export const SellerProfileResponseSchema = z.looseObject({
  request_info: opt(RequestInfoSchema),
  request_parameters: opt(RequestParametersSchema),
  request_metadata: opt(RequestMetadataSchema),
  message: optString(),
  seller: opt(
    z.looseObject({
      name: optString(),
      link: optString(),
      member_since: optString(),
      positive_ratings_percent: optNumberish(),
      /** "79 followers" as measured; a bare number is tolerated. */
      followers: optNumberish(),
      location: optString(),
      image: optString(),
      description: optString(),
      top_rated_seller: optBoolean(),
    }),
  ),
});
export type SellerProfileResponse = z.infer<typeof SellerProfileResponseSchema>;

/** The free account endpoint; the shape is not pinned beyond request_info. */
export const AccountResponseSchema = z.looseObject({
  request_info: opt(RequestInfoSchema),
  account_info: opt(
    z.looseObject({
      credits_used: optNumber(),
      credits_remaining: optNumber(),
      credits_limit: optNumber(),
      plan: optString(),
    }),
  ),
});
export type AccountResponse = z.infer<typeof AccountResponseSchema>;

export interface ParsedIssue {
  path: string;
  message: string;
}

/**
 * Validate a decoded body. A failure is EXTRACTION_INCOMPLETE with the first
 * failing path in the message and up to five issues in `details.issues`.
 */
export function parseCountdownBody<S extends z.ZodType>(schema: S, body: unknown, kind: string): z.output<S> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issues: ParsedIssue[] = result.error.issues.slice(0, 5).map((issue) => ({
    path: issue.path.length === 0 ? '(root)' : issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }));
  const first = issues[0];
  throw new BridgeError(
    'EXTRACTION_INCOMPLETE',
    `Countdown API ${kind} response did not match the expected shape at ${first?.path ?? '(root)'}: ${first?.message ?? 'invalid'}`,
    { kind, path: first?.path ?? '(root)', issues },
  );
}
