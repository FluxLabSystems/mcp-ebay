/**
 * Policy hooks the hosting process (Windows agent) supplies to browser
 * primitives. The local policy engine is authoritative (§19); browser-core
 * never executes an action without consulting these hooks.
 */
import type {
  ActionContext,
  FieldContext,
  SitePolicyProfile,
  UrlPolicyContext,
  UrlPolicyDecision,
} from '@browser-bridge/policy';

export interface PagePolicy {
  readonly profile: SitePolicyProfile;
  /** Throws BridgeError (SCHEME_DENIED/ORIGIN_DENIED/PRIVATE_NETWORK_DENIED) on denial. */
  assertUrlAllowed(url: string, context: UrlPolicyContext): Promise<UrlPolicyDecision>;
  /** Non-throwing variant used inside network interception. */
  checkUrl(url: string, context: UrlPolicyContext): Promise<UrlPolicyDecision>;
  /** Throws BridgeError ACTION_BLOCKED on protected actions. */
  assertActionAllowed(action: ActionContext): void;
  /** Throws BridgeError SECRET_FIELD_BLOCKED for secret fields. */
  assertFieldAllowed(field: FieldContext): void;
  /** True when a request URL matches transaction/account endpoint deny rules. */
  isProtectedEndpoint(url: string): boolean;
  /** Non-throwing secret check used by snapshot redaction. */
  isSecretField(field: FieldContext): boolean;
}

/** Optional site-specific hints for gallery enumeration (§20.4). */
export interface GalleryHints {
  /** CSS selectors that identify gallery image containers, in priority order. */
  gallerySelectors?: readonly string[];
  /** Normalize an image URL to a dedup key + best-resolution source URL. */
  normalizeImageUrl?: (url: string) => { dedupKey: string; bestUrl: string };
  /**
   * Gallery scope only: false excludes an image that is site chrome (a
   * badge, a store logo) rather than a listing photo. Never applied to
   * page scope, whose contract is everything the page renders.
   */
  isGalleryImage?: (url: string) => boolean;
}
