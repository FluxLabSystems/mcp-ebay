/**
 * jobs-sources.v1 — a POLICY-ONLY profile built by createResearchProfile
 * from the roster in sources.ts. It exists so the jobs routine can read job
 * boards, aggregators, union / apprenticeship channels and employer ATS
 * career pages with browser_navigate / browser_snapshot / browser_click /
 * browser_screenshot — the pages WebFetch cannot read (ca.indeed.com 401,
 * iw721.org 403, the JS-rendered ATS hosts) and the ones it can, so the lane
 * is one profile. It ships no extractor: browser_extract on one of these
 * hosts answers NO_EXTRACTOR_FOR_HOST rather than returning a
 * marketplace-shaped null record.
 *
 * Read-only research posture, identical in kind to the marketplace profiles
 * and to wardrobe-vendors.v1 / office-sources.v1: no application, no resume
 * or CV upload, no job alert, no saved job, no message to a recruiter or an
 * employer, no credential surface. The generic walls come from
 * createResearchProfile (which already refuses `apply`, `application`,
 * `easy apply`, `quick apply`, `submit application`, `message`, `follow`,
 * `subscribe`, `create alert` and the sign-in family); the extra
 * accessible-name patterns and path tokens below are the job-board
 * specifics — every board and every ATS puts an apply, save, alert or
 * resume control one click from every posting. The scope limit the
 * operator's ratification carries is the same as the office lane's: read
 * and navigate only, no form submission, no contact with any employer,
 * recruiter or union — an application is the operator's own act, on their
 * own machine, never a routine's.
 */
import { createResearchProfile, type SitePolicyProfile } from '@browser-bridge/policy';
import { JOBS_SOURCES } from './sources.js';

export const JOBS_SOURCES_SITE_PROFILE_ID = 'jobs-sources.v1';

/** Job-board specific accessible names that apply, save, alert, upload or contact. */
export const JOBS_SOURCES_EXTRA_BLOCKED_ACTION_PATTERNS: readonly string[] = [
  'apply',
  'apply on company site',
  'apply on employer site',
  'apply on company website',
  'apply with indeed',
  'apply with linkedin',
  'apply with profile',
  'start application',
  'continue application',
  'start applying',
  'i am interested',
  "i'm interested",
  'express interest',
  'save job',
  'save this job',
  'saved jobs',
  'job alert',
  'create job alert',
  'get job alerts',
  'email me jobs',
  'email me similar jobs',
  'upload resume',
  'upload your resume',
  'upload cv',
  'upload your cv',
  'build your resume',
  'message recruiter',
  'message the recruiter',
  'contact recruiter',
  'contact employer',
  'connect',
  'follow company',
  'refer a friend',
  'report job',
];

/**
 * Extra path tokens beyond createResearchProfile's transaction / auth /
 * state sets: resume and CV storage, saved-job and alert state, the
 * candidate self-service areas on ATS hosts, and Indeed's and LinkedIn's
 * apply routes. Segment-anchored like the generic ones, so a posting slug
 * that CONTAINS one of these words ("resume-writer-jobs") never matches —
 * only a path segment that IS the token.
 */
const JOBS_STATE_TOKENS = [
  'resume', 'resumes', 'cv', 'cvs', 'profile', 'profiles',
  'saved-jobs', 'savedjobs', 'myjobs', 'my-jobs', 'job-alerts', 'jobalerts',
  'easyapply', 'easy-apply', 'applystart', 'apply-start', 'applynow', 'apply-now',
  'candidate', 'candidates', 'my-account', 'myaccount', 'onboarding',
  'referral', 'referrals', 'talent-community', 'talentcommunity',
  // LinkedIn's messaging and InMail routes: the generic set has `message`
  // and `messages`, not the segment LinkedIn actually uses.
  'messaging', 'inmail',
] as const;

function escapeHost(host: string): string {
  return host.replace(/\./g, '\\.');
}

const JOBS_ORIGIN = `https?://(?:[a-z0-9-]+\\.)*(?:${[...new Set(JOBS_SOURCES.flatMap((source) => source.hosts))].map(escapeHost).join('|')})`;

export const JOBS_SOURCES_EXTRA_TRANSACTION_ENDPOINT_PATTERNS: readonly string[] = [
  `${JOBS_ORIGIN}/(?:.*/)?(?:${JOBS_STATE_TOKENS.join('|')})(?:/|\\?|#|$)`,
];

export const jobsSourcesSiteProfile: SitePolicyProfile = createResearchProfile({
  id: JOBS_SOURCES_SITE_PROFILE_ID,
  hosts: JOBS_SOURCES.flatMap((source) => source.hosts),
  extraBlockedActionPatterns: JOBS_SOURCES_EXTRA_BLOCKED_ACTION_PATTERNS,
  extraTransactionEndpointPatterns: JOBS_SOURCES_EXTRA_TRANSACTION_ENDPOINT_PATTERNS,
});

/**
 * Whether a hostname (or a URL) belongs to a roster source. The agent's
 * extract dispatch uses it to answer NO_EXTRACTOR_FOR_HOST instead of
 * running a marketplace extractor on a job board or an ATS page.
 */
export function isJobsSourceHost(hostOrUrl: string): boolean {
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
  return JOBS_SOURCES.some((source) => source.hosts.some((apex) => host === apex || host.endsWith(`.${apex}`)));
}

/** The roster's `sourceLabel` for a host — the jobs record's closed `source` value — or null off-roster. */
export function jobsSourceLabelForHost(hostOrUrl: string): string | null {
  let host = hostOrUrl.trim().toLowerCase();
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  host = host.replace(/\.$/, '');
  const match = JOBS_SOURCES.find((source) => source.hosts.some((apex) => host === apex || host.endsWith(`.${apex}`)));
  return match ? match.sourceLabel : null;
}
