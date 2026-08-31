/**
 * Bot-challenge interstitial detection (conformance contract C5). A
 * challenge wall must surface as a code DISTINCT from a removed listing:
 * CHALLENGE_PAGE is retryable (the wall clears; the page behind it still
 * exists), LISTING_UNAVAILABLE is not (the listing is gone). Conflating the
 * two makes a routine retire live inventory whenever the marketplace throws
 * a captcha.
 *
 * Detection is deliberately precise rather than broad: vendor-specific
 * challenge markup (hCaptcha/reCAPTCHA/Arkose/PerimeterX/Cloudflare
 * containers) or the known interstitial phrasings — never the mere presence
 * of a word like "captcha" in listing text, which is seller-written and
 * untrusted.
 */

export interface ChallengeSignal {
  vendor: string;
  marker: string;
}

/** Challenge-vendor DOM anchors. Selector presence alone is a match. */
const CHALLENGE_SELECTORS: readonly { selector: string; vendor: string }[] = [
  { selector: 'iframe[src*="hcaptcha.com"]', vendor: 'hCaptcha' },
  { selector: 'iframe[src*="recaptcha"]', vendor: 'reCAPTCHA' },
  { selector: 'div.g-recaptcha', vendor: 'reCAPTCHA' },
  { selector: 'iframe[src*="arkoselabs.com"]', vendor: 'Arkose' },
  { selector: '#px-captcha', vendor: 'PerimeterX' },
  { selector: 'form#challenge-form', vendor: 'Cloudflare' },
  { selector: '#cf-challenge-running, .cf-challenge, #challenge-stage', vendor: 'Cloudflare' },
  { selector: 'iframe[src*="geo.captcha-delivery.com"]', vendor: 'DataDome' },
];

/** Interstitial phrasings, matched against the title plus leading body text. */
const CHALLENGE_PHRASES: readonly { phrase: string; vendor: string }[] = [
  { phrase: 'pardon our interruption', vendor: 'eBay/Imperva' },
  { phrase: 'please verify yourself to continue', vendor: 'eBay' },
  { phrase: 'checking your browser before accessing', vendor: 'Cloudflare' },
  { phrase: 'verify you are human', vendor: 'Cloudflare' },
  { phrase: 'just a moment...', vendor: 'Cloudflare' },
  { phrase: 'enable javascript and cookies to continue', vendor: 'Cloudflare' },
  { phrase: 'access to this page has been denied', vendor: 'PerimeterX' },
];

/** URL shapes that ARE the challenge flow. */
const CHALLENGE_URL_MARKERS: readonly { marker: string; vendor: string }[] = [
  { marker: '/splashui/challenge', vendor: 'eBay' },
  { marker: '/cdn-cgi/challenge-platform/', vendor: 'Cloudflare' },
];

/**
 * How much rendered text an interstitial is allowed to have. A real listing
 * or search page carries far more; the cap keeps a listing whose seller
 * text quotes a phrase from ever matching. Phrase matches in <title> are
 * exempt from the cap — a title is site chrome, not seller text.
 */
const PHRASE_BODY_CHAR_LIMIT = 3500;

function normalize(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function detectChallengePage(document: Document, pageUrl: string): ChallengeSignal | null {
  const lowerUrl = pageUrl.toLowerCase();
  for (const { marker, vendor } of CHALLENGE_URL_MARKERS) {
    if (lowerUrl.includes(marker.toLowerCase())) {
      return { vendor, marker: `url contains ${marker}` };
    }
  }

  for (const { selector, vendor } of CHALLENGE_SELECTORS) {
    try {
      if (document.querySelector(selector) !== null) {
        return { vendor, marker: `selector ${selector}` };
      }
    } catch {
      // An engine that cannot parse one selector must not veto the rest.
    }
  }

  const title = normalize(document.querySelector('title')?.textContent);
  const bodyText = normalize(document.body?.textContent ?? '');
  const shortBody = bodyText.length <= PHRASE_BODY_CHAR_LIMIT;
  for (const { phrase, vendor } of CHALLENGE_PHRASES) {
    if (title.includes(phrase)) return { vendor, marker: `title says "${phrase}"` };
    if (shortBody && bodyText.includes(phrase)) {
      return { vendor, marker: `page says "${phrase}"` };
    }
  }
  return null;
}

/** Warning-code prefix shared by executors and batch slot mapping. */
export const CHALLENGE_WARNING_PREFIX = 'CHALLENGE_PAGE';

export function challengeWarning(signal: ChallengeSignal): string {
  return `${CHALLENGE_WARNING_PREFIX}: ${signal.vendor} bot-challenge interstitial detected (${signal.marker}); the requested page was not reached. Retryable — solve or wait out the challenge; do NOT treat this as a removed listing.`;
}
