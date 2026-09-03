/**
 * Site policy profile shape consumed by the local policy engine
 * (SDD v0.5 §19, Appendix C). Site profiles are versioned data, not code;
 * `@browser-bridge/site-ebay` provides `ebay.ca.v1`.
 */

export interface SitePolicyProfile {
  /** Versioned identifier, e.g. "ebay.ca.v1". */
  id: string;
  /**
   * Host allowlist. Entries are either bare registrable hosts ("ebay.ca",
   * matches exactly) or wildcard entries ("*.ebay.ca", matches any label
   * depth under the base). Matching is label-boundary safe.
   */
  allowedHosts: readonly string[];
  /**
   * Deny-wins host list, same syntax as allowedHosts, checked BEFORE it.
   * A host named here is ORIGIN_DENIED even if some allowlist entry —
   * present or future — would admit it. For hosts a routine has ruled out
   * permanently (the wardrobe routine's entripy.com), so a mistyped URL or
   * a careless later allowlist widening can never reach them.
   */
  deniedHosts?: readonly string[];
  /** Lower-cased substrings of accessible names/labels that must never be interacted with. */
  blockedActionPatterns: readonly string[];
  /** Autocomplete tokens marking secret fields beyond the global set. */
  blockedFieldAutocomplete: readonly string[];
  /**
   * Regex sources matched against full request URLs in the browser network
   * layer; matches are aborted (§19.2 defense-in-depth).
   */
  transactionEndpointPatterns: readonly string[];
  /**
   * Regex sources over full request URLs of endpoints whose MUTATING
   * requests change account state without being a transaction: the
   * watch-list and follow APIs. The network layer aborts every request to
   * them except a GET or HEAD, so the signed-in watch-list page can load
   * the list it renders while an add/remove call from the same page is
   * still aborted; protected-action evaluation blocks a click or submit
   * whose target matches, whatever the method. A request whose method is
   * unknown is treated as mutating.
   */
  mutationEndpointPatterns?: readonly string[];
  /**
   * Auth-surface deny rules: case-insensitive regex sources over full URLs
   * naming the profile's sign-in/registration/credential pages. Blocked by
   * default for navigation, redirect, popup, and frame targets — and because
   * the browser network layer re-evaluates EVERY main-frame hop, a redirect
   * that lands on an auth host (ebay.ca/signin/ → signin.ebay.ca) is blocked
   * at the hop even though the requested URL passed. The bridge is read-only
   * research tooling; there is no legitimate traversal into a login flow.
   */
  authPathPatterns?: readonly string[];
  /** Required destination for destination-resolved data, when applicable. */
  destinationPostalCode?: string;
  /**
   * TEST-ONLY escape hatches. Production site profiles never set these;
   * the ebay.ca.v1 profile is asserted by security tests to keep them unset.
   */
  testOnly?: {
    allowInsecureHttp?: boolean;
    allowPrivateNetworks?: boolean;
  };
}

export type UrlPolicyContext =
  | 'navigation'
  | 'redirect'
  | 'popup'
  | 'frame'
  | 'image_download'
  | 'subresource';

export interface UrlPolicyDecision {
  allowed: boolean;
  errorCode?: 'SCHEME_DENIED' | 'ORIGIN_DENIED' | 'PRIVATE_NETWORK_DENIED' | 'ACTION_BLOCKED';
  reason?: string;
  /** Addresses the hostname resolved to at check time (rebinding pinning). */
  resolvedAddresses?: string[];
}

export interface ActionContext {
  /** Accessible name / visible label of the element. */
  accessibleName: string;
  role: string;
  /** href for links, resolved form action for submit controls. */
  href?: string | null;
  formAction?: string | null;
  pageUrl: string;
  /** Nearby/inner text for context matching. */
  text?: string;
}

export interface FieldContext {
  inputType?: string | null;
  autocomplete?: string | null;
  name?: string | null;
  id?: string | null;
  ariaLabel?: string | null;
  /** Signals gathered from the enclosing form (action URL, id/class hints). */
  formSignals?: string | null;
}
