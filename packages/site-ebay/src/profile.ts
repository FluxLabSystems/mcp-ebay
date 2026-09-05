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

/**
 * The Countdown API mapper (@browser-bridge/source-countdown) produces the
 * same ExtractionRecord shape under its own profile id, so a consumer can
 * tell an API record from a Bridge record without a separate field. The
 * Bridge never produces this id and the browser tools' siteProfile enums do
 * not list it. Revision 1 = the shape shipped with docs/COUNTDOWN-API-PLAN.md
 * §4.2 (the additive fields shipsToText … categories).
 */
export const EBAY_API_SITE_PROFILE_ID = 'ebay.api.v1';
export const EBAY_API_PROFILE_REVISION = 1;

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
  // The sign-in SUBMIT endpoint is deliberately NOT here any more (operator
  // decision 2026-09-05, same reasoning as EBAY_AUTH_PATH_PATTERNS above).
  // Aborting it would let the human reach the sign-in form and then silently
  // kill the POST, which looks like eBay rejecting their password. Credential
  // CHANGE on signin.* is still covered by the change-password/reset/acctsec
  // patterns immediately above, which match every ebay subdomain.
  // Watch/follow state mutation through the legacy any-method endpoints
  // (an ISAPI GET can mutate). The JSON watch-list/follow APIs live in
  // EBAY_MUTATION_ENDPOINT_PATTERNS below, where a GET read is exempt.
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*)?(?:AddToWatchList|watch/add|RemoveFromWatchList|watch/remove)',
];

/**
 * Endpoints whose non-GET requests mutate account state (§19.2, extended
 * 2026-09-03 for the My eBay watch-list walk). The signed-in
 * /mye/myebay/watchlist page reads the operator's list through the same
 * API family its add/remove controls post to; aborting every method there
 * would abort the read the deals routine exists to make. So GET and HEAD
 * pass and every other method is aborted (see isProtectedEndpoint), and a
 * click or submit targeting one of these is blocked whatever its method.
 * NEEDS-LIVE-VERIFICATION: the exact watch-list data endpoint has not
 * been captured; the pattern is the family name, deliberately wide.
 */
export const EBAY_MUTATION_ENDPOINT_PATTERNS: readonly string[] = [
  'https?://(?:[a-z0-9-]+\\.)*ebay\\.(?:ca|com)/(?:.*)?(?:watchlist/api|watchlist/v\\d+|watch/api|follow/api|myebay/api/watch|mye/api/watch)',
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
 * Auth-surface deny rules. EMPTY FOR EBAY BY OPERATOR DECISION (2026-09-05).
 *
 * This list used to block every sign-in surface, on the reasoning that
 * "read-only research never signs in; over-blocking is acceptable". That
 * reasoning does not survive contact with eBay: a signed-out session cannot
 * resolve shipping to the destination postal code, cannot see the operator's
 * watch list or received offers, and cannot read member pricing — which is
 * most of what this profile exists to extract. The block also applied to the
 * HUMAN, because enforcement lives in the Playwright route interception that
 * sees every main-frame navigation in the context, so the operator could not
 * sign into their own account in their own browser. The control was not
 * protecting them from anything; it was denying them their own session.
 *
 * What still stops the agent from touching credentials, unchanged:
 *   - blockedFieldAutocomplete refuses current-password, new-password,
 *     one-time-code and every cc-* field, so the AGENT can never type a
 *     credential. The human types it; automation cannot.
 *   - blockedActionPatterns still refuse "sign in", "change password" and
 *     "security settings" style controls (see EBAY_BLOCKED_ACTION_PATTERNS).
 *   - Account-security endpoints (acctsec, account/security, changepassword,
 *     change-password, reset) remain in EBAY_TRANSACTION_ENDPOINT_PATTERNS on
 *     EVERY ebay host including signin.*, so credential CHANGE is still
 *     aborted at the network layer. Signing in is not changing a credential.
 *   - Every purchase, bid, offer, cart, checkout, messaging and watch-list
 *     mutation block is untouched. The read-only guarantee that matters —
 *     the routine cannot spend money or mutate the account — is intact.
 *
 * Kijiji, Zazzle and the vendor profiles keep their own auth blocks; this is
 * an eBay-specific decision, not a change to the policy engine.
 */
export const EBAY_AUTH_PATH_PATTERNS: readonly string[] = [];

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
  mutationEndpointPatterns: EBAY_MUTATION_ENDPOINT_PATTERNS,
  authPathPatterns: EBAY_AUTH_PATH_PATTERNS,
  destinationPostalCode: EBAY_DESTINATION_POSTAL_CODE,
};
