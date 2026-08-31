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
  // Checkout / purchase flows. `(?:.*/)?` — token must START a path segment:
  // /itm/vintage-checkout-counter/123 is a listing whose slug merely contains
  // the word and stays reachable; /checkout/… and /rxo/… stay aborted. The
  // old free-substring form silently aborted real listings whose seller-
  // written slug contained a keyword.
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*/)?(?:checkout|rxo|rgc)(?:/|\\?|#|$)',
  'https?://pay(?:ments)?\\.ebay\\.(?:ca|com)/',
  // Bidding (camelCase/API tokens; no real-word collision, substring kept)
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*)?(?:PlaceBid|placebid|bidflow|MakeBid)',
  // Best Offer submission — "best offer" appears in listing titles all day,
  // so the plain-word forms are segment-anchored; API tokens stay substring.
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*/)?(?:bestoffer|best-offer)(?:/|\\?|#|$)',
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*)?(?:makeOffer|offer/submit)',
  // Cart mutation (blocked in MVP, §4)
  'https?://cart\\.ebay\\.(?:ca|com)/(?:.*)?(?:add|update|checkout)',
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*)?cart/(?:api|add)',
  // Seller messaging
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*)?(?:contact_seller|ShowSellerFAQ|sendmsg|M2MContact)',
  'https?://mesg(?:[a-z0-9-]*)\\.ebay\\.(?:ca|com)/',
  // Account security / credentials — plain words segment-anchored
  // ("factory-reset" slugs are merchandise, /reset/ is not); API tokens kept.
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*)?(?:acctsec|account/security|changepassword)',
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*/)?(?:change-password|reset)(?:/|\\?|#|$)',
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

/**
 * Auth-surface deny rules (blocked by default; see SitePolicyProfile).
 * `ebay.ca/signin/` 302s to `signin.ebay.ca`, which the host allowlist
 * (*.ebay.ca) admits — so the landing HOST is named here explicitly and the
 * network layer's per-hop re-evaluation blocks the redirect where the
 * requested-URL check alone could not. Read-only research never signs in;
 * over-blocking is acceptable, under-blocking is not.
 */
export const EBAY_AUTH_PATH_PATTERNS: readonly string[] = [
  // The dedicated sign-in hosts, post-redirect (signin.ebay.ca, signin.ebay.com).
  'https?://signin\\.ebay\\.(?:ca|com)/',
  // Sign-in / registration PATH SEGMENTS on any eBay host. The auth token
  // must be a complete path segment — "/signin/", never a listing slug that
  // merely contains the word — so /itm/vintage-sign-in-frame/123 stays
  // reachable while /signin/ and /help/signin are blocked.
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:[a-zA-Z0-9_.~%-]+/)*(?:signin|sign-in|signup|sign-up|registration)(?:/|\\?|#|$)',
  // Legacy ISAPI sign-in endpoints.
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/ws/eBayISAPI\\.dll\\?Sign(?:In|Up)',
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
  authPathPatterns: EBAY_AUTH_PATH_PATTERNS,
  destinationPostalCode: EBAY_DESTINATION_POSTAL_CODE,
};
