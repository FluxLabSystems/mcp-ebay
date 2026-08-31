/**
 * kijiji.ca.v1 against the profile conformance harness (Prompt 0 Phase 3).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Relative import; see kijijiExtract.test.ts for the tests/package.json rationale.
import { kijijiSiteProfile } from '../../packages/site-kijiji/src/index.js';
import { describeProfileConformance } from './harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

interface Card {
  id: string;
  slug: string;
  title: string;
  price: string;
  location: string;
  posted: string;
}

const CARDS: Card[] = [
  { id: '1712300001', slug: 'lego-friends-bulk-lot', title: 'LEGO Friends Bulk Lot 5 lbs', price: '$35.00', location: 'City of Toronto', posted: 'Yesterday' },
  { id: '1712300002', slug: 'lego-technic-crane', title: 'LEGO Technic Crane 42009', price: '$210.00', location: 'North York', posted: '2 days ago' },
  { id: '1712300003', slug: 'vintage-lego-castle', title: 'Vintage LEGO Castle 6080', price: '$320.00', location: 'Etobicoke', posted: '3 days ago' },
  { id: '1712300004', slug: 'lego-city-mixed-bricks', title: 'LEGO City Mixed Bricks 10 lbs', price: '$88.00', location: 'Scarborough', posted: '4 days ago' },
  { id: '1712300005', slug: 'lego-creator-modular', title: 'LEGO Creator Expert Modular', price: '$150.00', location: 'City of Toronto', posted: '5 days ago' },
];

function card(entry: Card, enriched: boolean): string {
  if (!enriched) {
    // Hydration-decay shape: the anchor and ad id survive, every
    // enrichment node is gone.
    return `
    <li data-testid="listing-card-${entry.id}">
      <a href="/v-buy-sell/city-of-toronto/${entry.slug}/${entry.id}"><img src="/t/${entry.id}.jpg" alt=""></a>
    </li>`;
  }
  return `
    <li data-testid="listing-card-${entry.id}">
      <a href="/v-buy-sell/city-of-toronto/${entry.slug}/${entry.id}">
        <h3>${entry.title}</h3>
      </a>
      <div data-testid="listing-price">${entry.price}</div>
      <span data-testid="listing-location">${entry.location}</span>
      <span data-testid="listing-date">${entry.posted}</span>
    </li>`;
}

function searchHtml(variant: 'v1' | 'degraded' | 'cosmetic'): string {
  const rows =
    variant === 'degraded'
      ? [card(CARDS[0]!, true), ...CARDS.slice(1).map((entry) => card(entry, false))]
      : CARDS.map((entry) => card(entry, true));
  const cosmetic =
    variant === 'cosmetic'
      ? '<!-- impression beacon 41ab --><div data-ad-rotation="cc90">sponsored unit</div><script>var t=Date.now();</script>'
      : '';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>lego in City of Toronto | Kijiji</title></head>
<body>
  ${cosmetic}
  <ul data-testid="srp-search-list">${rows.join('\n')}
  </ul>
</body>
</html>`;
}

describeProfileConformance({
  profileId: 'kijiji.ca.v1',
  mismatchDeclaredId: 'ebay.ca.v1',
  policyProfile: kijijiSiteProfile,
  searchUrl: 'https://www.kijiji.ca/b-buy-sell/city-of-toronto/lego/c10l1700273?radius=45',
  listingUrl: 'https://www.kijiji.ca/v-buy-sell/city-of-toronto/lego-bulk-lot/1799999999',
  searchHtml,
  priceKey: 'price',
  requiredCandidateKeys: ['adId', 'url', 'title', 'price', 'locationText', 'postedText'],
  unavailableHtml: readFileSync(join(FIXTURES, 'kijiji', 'vip-deleted.html'), 'utf8'),
  unavailableUrl: 'https://www.kijiji.ca/v-buy-sell/city-of-toronto/removed-ad/1788888888',
  challengeHtml: `<!DOCTYPE html>
<html><head><title>Just a moment...</title></head>
<body><form id="challenge-form" action="/cdn-cgi/challenge"></form><p>Verify you are human by completing the action below.</p></body></html>`,
  emptySearchHtml:
    '<!DOCTYPE html><html><head><title>lego | Kijiji</title></head><body><ul data-testid="srp-search-list"></ul></body></html>',
  offProfileUrl: 'https://www.marriott.com/en-us/hotels/',
  suffixConfusionUrl: 'https://www.kijiji.ca.attacker-test.example/v-buy-sell/x/1',
  httpUrl: 'http://www.kijiji.ca/b-buy-sell/lego/c10',
  blockedAuthUrls: [
    'https://www.kijiji.ca/t-login.html',
    'https://www.kijiji.ca/t-login.html?targetUrl=L2Ivc29tZXdoZXJl',
    'https://www.kijiji.ca/t-register.html',
    'https://www.kijiji.ca/consumer/login?state=abc',
    'https://id.kijiji.ca/login?client_id=web',
  ],
  allowedLookalikeUrls: [
    // Ad slugs are seller-written title text; auth-ish words inside them
    // must never make an ad unreachable.
    'https://www.kijiji.ca/v-buy-sell/city-of-toronto/antique-cash-register/1740940278',
    'https://www.kijiji.ca/v-buy-sell/city-of-toronto/login-book-collection/1712345678',
    'https://www.kijiji.ca/b-buy-sell/city-of-toronto/cash-register/k0c10l1700273',
  ],
  protectedEndpointUrls: [
    'https://www.kijiji.ca/t-login.html',
    'https://www.kijiji.ca/p-post-ad.html',
    'https://www.kijiji.ca/m-msg/inbox',
    'https://www.kijiji.ca/m-my-favourites/',
    'https://www.kijiji.ca/payment/checkout?adId=1',
  ],
  unprotectedListingUrls: [
    // Each of these was aborted by the old free-substring deny patterns.
    'https://www.kijiji.ca/v-buy-sell/city-of-toronto/antique-cash-register/1740940278',
    'https://www.kijiji.ca/v-buy-sell/city-of-toronto/vintage-lamp-post/1730433251',
    'https://www.kijiji.ca/v-buy-sell/city-of-toronto/gaming-chat-headset/1712345670',
    'https://www.kijiji.ca/b-buy-sell/city-of-toronto/fire-alerts/k0c10l1700273',
  ],
});
