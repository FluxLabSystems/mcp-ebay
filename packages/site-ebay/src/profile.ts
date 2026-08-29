/**
 * ebay.ca.v1 policy configuration — SDD v0.5 §19, §20, Appendix C.
 * Version changes are explicit; the id participates in extraction records.
 */
import type { SitePolicyProfile } from '@browser-bridge/policy';

export const EBAY_SITE_PROFILE_ID = 'ebay.ca.v1';

/**
 * Additive revision of the extraction record inside ebay.ca.v1. The id above
 * is a wire enum value -- the protocol schema, the agent executor, the
 * security tests and the dashboards all pin the literal 'ebay.ca.v1' -- so it
 * cannot move when the record only gains fields. Bump this instead; a
 * consumer reading record.profileRevision can tell which shape it got without
 * anything downstream having to be redeployed in lockstep.
 *
 * 1 = the shape shipped with the first live run.
 * 2 = adds endsAt, timeLeftText, itemLocationText, watcherCount,
 *     quantityAvailable, quantitySold.
 */
export const EBAY_PROFILE_REVISION = 2;

export const EBAY_DESTINATION_POSTAL_CODE = 'M6H 2W9';

/**
 * Transaction/account endpoint deny rules matched by the browser network
 * layer (§19.2). Sources are case-insensitive regexes over full URLs.
 * These are defense-in-depth behind the accessible-name deny patterns.
 */
export const EBAY_TRANSACTION_ENDPOINT_PATTERNS: readonly string[] = [
  // Checkout / purchase flows
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*)?(?:checkout|rxo|rgc)(?:/|\\?|$)',
  'https?://pay(?:ments)?\\.ebay\\.(?:ca|com)/',
  // Bidding
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*)?(?:PlaceBid|placebid|bidflow|MakeBid)',
  // Best Offer submission
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*)?(?:bestoffer|best-offer|makeOffer|offer/submit)',
  // Cart mutation (blocked in MVP, §4)
  'https?://cart\\.ebay\\.(?:ca|com)/(?:.*)?(?:add|update|checkout)',
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*)?cart/(?:api|add)',
  // Seller messaging
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*)?(?:contact_seller|ShowSellerFAQ|sendmsg|M2MContact)',
  'https?://mesg(?:[a-z0-9-]*)\\.ebay\\.(?:ca|com)/',
  // Account security / credentials
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*)?(?:acctsec|account/security|changepassword|change-password|reset)',
  'https?://signin\\.ebay\\.(?:ca|com)/(?:.*)?(?:SignInSubmit|password)',
  // Watch/follow state mutation (low-consequence state, blocked in MVP)
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*)?(?:watchlist/api|AddToWatchList|watch/add|follow/api)',
];

/** Appendix C blockedActionPatterns plus MVP low-consequence blocks (§19.2 table). */
export const EBAY_BLOCKED_ACTION_PATTERNS: readonly string[] = [
  'buy it now',
  'confirm and pay',
  'place bid',
  'submit bid',
  'review and confirm bid',
  'make offer',
  'send offer',
  'review offer',
  'message seller',
  'send message',
  'contact seller',
  'change password',
  'security settings',
  'add to cart',
  'add to watchlist',
  'watch this item',
  'follow this seller',
  'go to checkout',
  'proceed to checkout',
  'pay now',
  'commit to buy',
];

export const EBAY_BLOCKED_FIELD_AUTOCOMPLETE: readonly string[] = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-exp',
  'cc-csc',
];

export const ebaySiteProfile: SitePolicyProfile = {
  id: EBAY_SITE_PROFILE_ID,
  allowedHosts: [
    'ebay.ca',
    '*.ebay.ca',
    'ebay.com',
    '*.ebay.com',
    'ebaystatic.com',
    '*.ebaystatic.com',
    'ebayimg.com',
    '*.ebayimg.com',
  ],
  blockedActionPatterns: EBAY_BLOCKED_ACTION_PATTERNS,
  blockedFieldAutocomplete: EBAY_BLOCKED_FIELD_AUTOCOMPLETE,
  transactionEndpointPatterns: EBAY_TRANSACTION_ENDPOINT_PATTERNS,
  destinationPostalCode: EBAY_DESTINATION_POSTAL_CODE,
};
