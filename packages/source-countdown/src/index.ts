/**
 * @browser-bridge/source-countdown — the Countdown API (Traject Data) eBay
 * data source: an HTTP client with injectable fetch, loose response schemas
 * and pure mappers onto the ebay.ca.v1 candidate and extraction-record
 * shapes. No I/O beyond `fetch`. See README.md and docs/COUNTDOWN-API-PLAN.md.
 */
export {
  COUNTDOWN_WARNING,
  DESTINATION_UNVERIFIED_WARNING,
  domainCurrency,
  domainFromUrl,
  mergeWarnings,
  normalizeCondition,
  parseSellerLink,
  type CountdownDomain,
  type CountdownWarningCode,
  type Mapped,
  type NormalizedCondition,
  type ParsedSellerLink,
  type SellerLinkKind,
} from './common.js';
export {
  COUNTDOWN_DEFAULT_BASE_URL,
  COUNTDOWN_DEFAULT_RETRY_DELAYS_MS,
  COUNTDOWN_DEFAULT_TIMEOUT_MS,
  COUNTDOWN_RETRY_MIN_BUDGET_MS,
  CountdownClient,
  type CountdownAccountResult,
  type CountdownCallOptions,
  type CountdownClientOptions,
  type CountdownCredits,
  type CountdownListingType,
  type CountdownProductParams,
  type CountdownRequestBudget,
  type CountdownRequestType,
  type CountdownResult,
  type CountdownSearchParams,
  type CountdownSellerProfileParams,
  type CountdownSortBy,
} from './client.js';
export {
  AccountResponseSchema,
  AuctionBlockSchema,
  PaginationSchema,
  ProductBlockSchema,
  ProductResponseSchema,
  RequestInfoSchema,
  RequestMetadataSchema,
  SearchPriceSchema,
  SearchResponseSchema,
  SearchRowSchema,
  SellerProfileResponseSchema,
  parseCountdownBody,
  stripAccountSecrets,
  summarizeAccount,
  type AccountResponse,
  type CountdownAccountInfo,
  type Pagination,
  type ParsedIssue,
  type ProductResponse,
  type RequestInfo,
  type RequestMetadata,
  type SearchPrice,
  type SearchResponse,
  type SearchRow,
  type SellerProfileResponse,
} from './schemas.js';
export {
  mapSearchRows,
  mergeSplitSearch,
  readPagination,
  type ApiListingCandidate,
  type CountdownPagination,
  type MapSearchRowsInput,
  type RetrievedUnder,
} from './map-search.js';
export { mapItem, type MapItemInput, type MapItemResult } from './map-item.js';
export {
  mapSellerProfile,
  type MapSellerProfileInput,
  type MapSellerProfileResult,
  type SellerProfile,
} from './map-seller.js';
