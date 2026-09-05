/**
 * ebay.ca.v1 against the profile conformance harness (Prompt 0 Phase 3).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkUrl, isProtectedEndpoint } from '@browser-bridge/policy';
import { ebaySiteProfile } from '@browser-bridge/site-ebay';
import { describeProfileConformance } from './harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

interface Card {
  id: string;
  title: string;
  price: string;
}

const CARDS: Card[] = [
  { id: '111111111111', title: 'LEGO Star Wars Bulk Lot 3 lbs Minifigures', price: 'C $45.00' },
  { id: '222222222222', title: 'LEGO Technic Crane 42009 Complete', price: 'C $210.00' },
  { id: '333333333333', title: 'Vintage LEGO Castle 6080 Boxed', price: 'C $320.00' },
  { id: '444444444444', title: 'LEGO City Mixed Bricks 10 lbs', price: 'C $88.00' },
  { id: '555555555555', title: 'LEGO Creator Expert Modular', price: 'C $150.00' },
];

function card(entry: Card, enriched: boolean): string {
  if (!enriched) {
    // Post-hydration decay shape: the card root survives but the title node
    // and price span are gone; the anchor wraps only an image, so the
    // extractor reads title null / snippetPrice null.
    return `
    <li class="s-item">
      <a class="s-item__link" href="https://www.ebay.ca/itm/${entry.id}?hash=x"><img src="/t/${entry.id}.jpg" alt=""></a>
    </li>`;
  }
  return `
    <li class="s-item">
      <a class="s-item__link" href="https://www.ebay.ca/itm/${entry.id}?hash=x">
        <h3 class="s-item__title">${entry.title}</h3>
      </a>
      <span class="s-item__price">${entry.price}</span>
    </li>`;
}

function searchHtml(variant: 'v1' | 'degraded' | 'cosmetic'): string {
  const rows =
    variant === 'degraded'
      ? [card(CARDS[0]!, true), ...CARDS.slice(1).map((entry) => card(entry, false))]
      : CARDS.map((entry) => card(entry, true));
  const cosmetic =
    variant === 'cosmetic'
      ? '<!-- rotated ad slot 7f3a --><div id="ad-rotation" data-nonce="9d1c">sponsored unit</div><script>var t=Date.now();</script>'
      : '';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>bulk lego | eBay Search</title></head>
<body>
  ${cosmetic}
  <ul class="srp-results">${rows.join('\n')}
  </ul>
</body>
</html>`;
}

describeProfileConformance({
  profileId: 'ebay.ca.v1',
  mismatchDeclaredId: 'kijiji.ca.v1',
  policyProfile: ebaySiteProfile,
  searchUrl: 'https://www.ebay.ca/sch/i.html?_nkw=lego+bulk+lot',
  listingUrl: 'https://www.ebay.ca/itm/999999999999',
  searchHtml,
  priceKey: 'snippetPrice',
  requiredCandidateKeys: ['itemId', 'url', 'title', 'snippetPrice', 'sellingFormat'],
  unavailableHtml: readFileSync(join(FIXTURES, 'ebay', 'unavailable-listing.html'), 'utf8'),
  unavailableUrl: 'https://www.ebay.ca/itm/198589141532',
  challengeHtml: `<!DOCTYPE html>
<html><head><title>Pardon Our Interruption</title></head>
<body><p>Pardon our interruption. As you were browsing something about your browser made us think you were a bot.</p></body></html>`,
  emptySearchHtml:
    '<!DOCTYPE html><html><head><title>no results | eBay Search</title></head><body><ul class="srp-results"></ul></body></html>',
  offProfileUrl: 'https://www.marriott.com/en-us/hotels/',
  suffixConfusionUrl: 'https://www.ebay.ca.attacker-test.example/itm/1',
  httpUrl: 'http://www.ebay.ca/sch/i.html?_nkw=lego',
  // Empty by operator decision (2026-09-05): eBay's sign-in surfaces are
  // reachable so the human can hold a session, without which shipping cannot
  // resolve to the destination postal code and the watch list and offers are
  // invisible. See EBAY_AUTH_PATH_PATTERNS for the full reasoning and for what
  // still guards credentials. The reachability is asserted positively in
  // "eBay sign-in reachability" below rather than left merely unasserted, so a
  // silent re-block fails a test instead of quietly breaking the operator.
  blockedAuthUrls: [],
  allowedLookalikeUrls: [
    // Seller-written slugs that merely contain auth-ish words.
    'https://www.ebay.ca/itm/vintage-sign-in-neon-frame/123456789012',
    'https://www.ebay.ca/sch/i.html?_nkw=signin+lock',
  ],
  protectedEndpointUrls: [
    'https://www.ebay.ca/checkout/start',
    'https://pay.ebay.ca/rxo?action=view',
    'https://www.ebay.ca/bestoffer/offers/912?modal=1',
    // SignInSubmit is deliberately absent: aborting the credential POST would
    // let the human reach the form and then kill the submission, which reads
    // as eBay rejecting their password. Credential CHANGE stays protected —
    // the change-password entry below covers every ebay subdomain.
    'https://www.ebay.ca/cnt/change-password/',
    'https://signin.ebay.ca/cnt/change-password/',
  ],
  unprotectedListingUrls: [
    // The segment-anchoring guarantee: a slug containing a deny keyword is
    // a listing, not an endpoint. Each of these was aborted by the old
    // free-substring patterns.
    'https://www.ebay.ca/itm/vintage-checkout-counter-oak/204333222111',
    'https://www.ebay.ca/itm/lego-lot-best-offer-welcome/144555666777',
    'https://www.ebay.ca/itm/nintendo-factory-reset-console/155666777888',
  ],
});

/**
 * The operator's session is a FEATURE of this profile (decision 2026-09-05).
 *
 * Signed out, eBay will not resolve shipping to the destination postal code,
 * will not show the watch list or received offers, and will not show member
 * pricing — which is most of what ebay.ca.v1 exists to extract. The previous
 * blanket auth block also applied to the human, because enforcement lives in
 * the route interception that sees every navigation in the context.
 *
 * These assertions are positive on purpose. Emptying blockedAuthUrls alone
 * would make the harness's auth test vacuous, and a future well-meaning
 * re-block would pass CI while silently locking the operator out of their own
 * account again.
 */
describe('eBay sign-in reachability', () => {
  const SIGNIN_URLS = [
    'https://www.ebay.ca/signin/',
    'https://www.ebay.ca/signin/?ru=https%3A%2F%2Fwww.ebay.ca%2F',
    'https://signin.ebay.ca/ws/eBayISAPI.dll?SignIn',
    'https://signin.ebay.ca/signin/s',
    'https://www.ebay.com/signin/',
  ];

  it('sign-in pages are reachable by navigation and by redirect hop', async () => {
    for (const url of SIGNIN_URLS) {
      for (const context of ['navigation', 'redirect'] as const) {
        const decision = await checkUrl(url, ebaySiteProfile, context, { resolveDns: false });
        expect(decision.allowed, `${url} (${context})`).toBe(true);
      }
    }
  });

  it('the credential POST is not aborted as a protected endpoint', () => {
    expect(isProtectedEndpoint('https://signin.ebay.ca/ws/eBayISAPI.dll?SignInSubmit', ebaySiteProfile)).toBe(false);
  });

  it('but changing a credential is still blocked, on every eBay host', () => {
    for (const url of [
      'https://www.ebay.ca/cnt/change-password/',
      'https://signin.ebay.ca/cnt/change-password/',
      'https://www.ebay.ca/acctsec/security',
      'https://accounts.ebay.com/account/security',
    ]) {
      expect(isProtectedEndpoint(url, ebaySiteProfile), url).toBe(true);
    }
  });

  it('the agent still cannot type a credential', () => {
    for (const field of ['current-password', 'new-password', 'one-time-code']) {
      expect(ebaySiteProfile.blockedFieldAutocomplete).toContain(field);
    }
  });
});
