/**
 * office-sources.v1 — a POLICY-ONLY profile built by createResearchProfile
 * from the roster in sources.ts. It exists so the office routine can drive
 * the providers' JS-rendered location and pricing pages and the MLS /
 * aggregator listing pages with browser_navigate / browser_snapshot /
 * browser_click / browser_screenshot. It ships no extractor: browser_extract
 * on one of these hosts answers NO_EXTRACTOR_FOR_HOST rather than returning
 * a marketplace-shaped null record.
 *
 * Read-only research posture, identical in kind to the marketplace
 * profiles and to wardrobe-vendors.v1: no cart, checkout, booking,
 * reservation, application, enquiry or credential surface, no wishlist or
 * alert state. The generic walls come from createResearchProfile; the extra
 * accessible-name patterns below are the office-market specifics — the
 * quote, tour and viewing requests that are one click from every managed
 * office and every MLS listing. The scope limit the operator's ratification
 * carries is the same: read and navigate only, no form submission, no
 * message to any agent or provider — outreach stays on its human-approval
 * path.
 */
import { createResearchProfile, type SitePolicyProfile } from '@browser-bridge/policy';
import { OFFICE_SOURCES } from './sources.js';

export const OFFICE_SOURCES_SITE_PROFILE_ID = 'office-sources.v1';

/** Office-market specific accessible names that request contact, a quote, a tour or a viewing. */
export const OFFICE_SOURCES_EXTRA_BLOCKED_ACTION_PATTERNS: readonly string[] = [
  'get a quote',
  'get quote',
  'request a quote',
  'request quote',
  'schedule a tour',
  'schedule tour',
  'schedule a visit',
  'book a viewing',
  'request a viewing',
  'enquire now',
  'inquire now',
  'contact broker',
  'contact us',
  'call now',
  'get in touch',
  'start booking',
  // craigslist (roster 2026-09-14): the reply-to-poster control, the flag
  // controls and the posting flow are the write surfaces on a classifieds
  // site; every one is an outreach or state action the lane never takes.
  'reply',
  'post to classifieds',
  'flag',
  'my account',
];

/**
 * craigslist's write surfaces live on their own hosts and path segments:
 * `accounts.craigslist.org` (sign-in, saved searches, posting management),
 * `post.craigslist.org` (the posting flow) and the per-city `/reply/…`,
 * `/flag/…` and `/edit/…` paths. The generic walls cover `account` and
 * `login` as path segments only, so the hosts and the classifieds-specific
 * segments are added here. Full-URL regex sources, segment-anchored like the
 * generic ones so a listing slug containing "reply" never matches.
 */
export const OFFICE_SOURCES_EXTRA_TRANSACTION_ENDPOINT_PATTERNS: readonly string[] = [
  'https?://(?:accounts|post)\\.craigslist\\.org(?:/|$)',
  'https?://(?:[a-z0-9-]+\\.)*craigslist\\.org/(?:.*/)?(?:reply|flag|edit|manage|post)(?:/|\\?|#|$)',
];

export const officeSourcesSiteProfile: SitePolicyProfile = createResearchProfile({
  id: OFFICE_SOURCES_SITE_PROFILE_ID,
  hosts: OFFICE_SOURCES.flatMap((source) => source.hosts),
  extraBlockedActionPatterns: OFFICE_SOURCES_EXTRA_BLOCKED_ACTION_PATTERNS,
  extraTransactionEndpointPatterns: OFFICE_SOURCES_EXTRA_TRANSACTION_ENDPOINT_PATTERNS,
});

/**
 * Whether a hostname (or a URL) belongs to a roster source. The agent's
 * extract dispatch uses it to answer NO_EXTRACTOR_FOR_HOST instead of
 * running a marketplace extractor on an office page.
 */
export function isOfficeSourceHost(hostOrUrl: string): boolean {
  let host = hostOrUrl.trim().toLowerCase();
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      return false;
    }
  }
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  host = host.replace(/\.$/, '');
  return OFFICE_SOURCES.some((source) => source.hosts.some((apex) => host === apex || host.endsWith(`.${apex}`)));
}
