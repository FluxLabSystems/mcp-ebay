/**
 * zazzle.com.v1 against the profile conformance harness — the first profile
 * built on top of the Prompt 0 fixes, and required to pass the same suite
 * as the incumbents before any live alert fires on its numbers.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zazzleSiteProfile } from '@browser-bridge/site-zazzle';
import { describeProfileConformance } from './harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

interface Card {
  id: string;
  slug: string;
  title: string;
  price: string;
  original: string;
}

const CARDS: Card[] = [
  { id: '256900000000000001', slug: 'custom_name_classic_tee', title: 'Custom Name Classic Tee', price: '$19.31', original: '$21.45' },
  { id: '256900000000000002', slug: 'retro_team_logo_tee', title: 'Retro Team Logo Tee', price: '$23.10', original: '$25.67' },
  { id: '256900000000000003', slug: 'monogram_pocket_tee', title: 'Monogram Pocket Tee', price: '$17.05', original: '$18.95' },
  { id: '256900000000000004', slug: 'photo_collage_tee', title: 'Photo Collage Tee', price: '$24.20', original: '$26.90' },
  { id: '256900000000000005', slug: 'script_wifey_tee', title: 'Script Wifey Tee', price: '$19.31', original: '$21.45' },
];

function card(entry: Card, enriched: boolean): string {
  if (!enriched) {
    return `
    <div class="SearchResults_cell SearchResultsGridCell2_root" data-itemid="${entry.id}">
      <a class="SearchResultsGridCell2_link" href="https://www.zazzle.com/${entry.slug}-${entry.id}"><img src="https://rlv.zcache.com/${entry.id}.jpg" alt=""></a>
    </div>`;
  }
  return `
    <div class="SearchResults_cell SearchResultsGridCell2_root" data-itemid="${entry.id}">
      <div class="SearchResultsGridCell2_info">
        <a class="SearchResultsGridCell2_link" href="https://www.zazzle.com/${entry.slug}-${entry.id}">
          <span class="SearchResultsGridCell2_title">${entry.title}</span>
        </a>
        <div class="SearchProductPrice_root">
          <span class="SearchProductPrice_priceAdjustedText">${entry.price}</span>
          <span class="SearchProductPrice_cv_text SearchProductPrice_lineThrough">${entry.original}</span>
        </div>
      </div>
    </div>`;
}

function searchHtml(variant: 'v1' | 'degraded' | 'cosmetic'): string {
  const rows =
    variant === 'degraded'
      ? [card(CARDS[0]!, true), ...CARDS.slice(1).map((entry) => card(entry, false))]
      : CARDS.map((entry) => card(entry, true));
  const cosmetic =
    variant === 'cosmetic'
      ? '<!-- rotated promo 5b2e --><div data-promo-rotation="e77a">seasonal banner</div><script>var t=Date.now();</script>'
      : '';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Custom T-Shirts | Zazzle</title></head>
<body>
  ${cosmetic}
  <div class="SearchResults_grid">${rows.join('\n')}
  </div>
</body>
</html>`;
}

describeProfileConformance({
  profileId: 'zazzle.com.v1',
  mismatchDeclaredId: 'ebay.ca.v1',
  policyProfile: zazzleSiteProfile,
  searchUrl: 'https://www.zazzle.com/s/custom+t+shirts',
  listingUrl: 'https://www.zazzle.com/custom_name_classic_tee-256900000000000001',
  searchHtml,
  priceKey: 'price',
  requiredCandidateKeys: ['productId', 'url', 'title', 'price'],
  unavailableHtml: readFileSync(join(FIXTURES, 'zazzle', 'product-unavailable.html'), 'utf8'),
  unavailableUrl: 'https://www.zazzle.com/some_gone_product-235000000000000001',
  challengeHtml: `<!DOCTYPE html>
<html><head><title>Access Denied</title></head>
<body><p>Access to this page has been denied because we believe you are using automation tools to browse the website.</p><div id="px-captcha"></div></body></html>`,
  emptySearchHtml:
    '<!DOCTYPE html><html><head><title>no results | Zazzle</title></head><body><div class="SearchResults_grid"></div></body></html>',
  offProfileUrl: 'https://www.marriott.com/en-us/hotels/',
  suffixConfusionUrl: 'https://www.zazzle.com.attacker-test.example/custom_tee-256900000000000009',
  httpUrl: 'http://www.zazzle.com/s/custom+t+shirts',
  blockedAuthUrls: [
    'https://www.zazzle.com/lgn',
    'https://www.zazzle.com/lgn?ru=%2Fco%2Fcart',
    'https://www.zazzle.com/login',
    'https://www.zazzle.com/signin/',
  ],
  allowedLookalikeUrls: [
    // Designer-written slugs with auth-ish or endpoint-ish words inside.
    'https://www.zazzle.com/login_book_collection_tee-256900000000000010',
    'https://www.zazzle.com/s/cash+register',
  ],
  protectedEndpointUrls: [
    'https://www.zazzle.com/co/cart',
    'https://www.zazzle.com/co/checkout?step=1',
    'https://www.zazzle.com/checkout',
  ],
  unprotectedListingUrls: [
    'https://www.zazzle.com/custom_checkout_counter_sign-256900000000000011',
    'https://www.zazzle.com/vintage_cash_register_art_tee-256900000000000012',
  ],
  permanentlyDeniedUrls: [
    // Spec P1: entripy is permanently excluded; deny beats every allowlist.
    'https://entripy.com/products/custom-tshirt',
    'https://www.entripy.com/',
  ],
});
