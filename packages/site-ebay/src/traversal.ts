/**
 * Search-results and seller store traversal support — SDD v0.5 FR-15.
 * Candidate links are followed to canonical item pages; snippets here are
 * traversal hints only and are never accepted as canonical listing
 * evidence (§20.2).
 */
import { itemIdFromUrl, parseMoney } from './normalize.js';

export interface ListingCandidate {
  itemId: string;
  url: string;
  title: string | null;
  /** Snippet price: traversal hint only, never canonical evidence. */
  snippetPrice: { value: number; currency: string } | null;
  order: number;
}

const RESULT_LINK_SELECTORS = [
  'a.s-item__link',
  '.s-item a[href*="/itm/"]',
  '.srp-results a[href*="/itm/"]',
  '.str-item-card a[href*="/itm/"]',
  '.str-search-results a[href*="/itm/"]',
  'a[href*="/itm/"]',
];

export type EbayPageKind = 'listing' | 'search' | 'store' | 'other';

export function classifyEbayPage(pageUrl: string): EbayPageKind {
  try {
    const url = new URL(pageUrl);
    const path = url.pathname;
    if (/\/itm\//.test(path)) return 'listing';
    if (/\/sch\//.test(path)) return 'search';
    if (/\/str\//.test(path) || /\/usr\//.test(path)) return 'store';
    return 'other';
  } catch {
    return 'other';
  }
}

export function extractListingCandidates(document: Document, pageUrl: string): ListingCandidate[] {
  const seen = new Set<string>();
  const candidates: ListingCandidate[] = [];
  for (const selector of RESULT_LINK_SELECTORS) {
    let anchors: Element[];
    try {
      anchors = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href');
      if (!href) continue;
      let absolute: string;
      try {
        absolute = new URL(href, pageUrl).toString();
      } catch {
        continue;
      }
      const itemId = itemIdFromUrl(absolute);
      if (!itemId || seen.has(itemId)) continue;
      seen.add(itemId);

      const card = anchor.closest('.s-item, .str-item-card, li, article') ?? anchor;
      const titleText =
        card.querySelector('.s-item__title, .str-item-card__title, h3, .s-card__title')?.textContent?.replace(/\s+/g, ' ').trim() ??
        anchor.textContent?.replace(/\s+/g, ' ').trim() ??
        null;
      const priceText = card.querySelector('.s-item__price, .str-item-card__price, .s-card__price')?.textContent ?? '';
      const parsedPrice = parseMoney(priceText);

      candidates.push({
        itemId,
        url: absolute,
        title: titleText && titleText.length > 0 ? titleText : null,
        snippetPrice: parsedPrice === null ? null : { value: parsedPrice.value, currency: parsedPrice.currency },
        order: candidates.length,
      });
    }
    if (candidates.length > 0) break;
  }
  return candidates;
}
