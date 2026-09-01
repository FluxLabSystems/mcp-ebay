/**
 * Kijiji gallery hints — URL normalization, the chrome filter, and their
 * effect on browser_images gallery scope. Pinned against the 2026-08-30
 * connector test, where scope "gallery" on a Kijiji ad returned seven
 * images: six ad photos plus a 200×200 store badge served from the
 * ca-prod-statics bucket.
 */
import { describe, expect, it } from 'vitest';
import { enumerateImages, type BrowserSessionRuntime } from '@browser-bridge/browser-core';
import { isKijijiAdImageUrl, normalizeKijijiImageUrl } from '@browser-bridge/site-kijiji';

const PHOTO = (uuid: string, rule = 'kijijica-640-webp'): string =>
  `https://media.kijiji.ca/api/v1/ca-prod-fsbo-ads/images/aa/${uuid}?rule=${rule}`;
const BADGE = 'https://media.kijiji.ca/api/v1/ca-prod-statics/images/badge/store-badge-200.png';

describe('normalizeKijijiImageUrl', () => {
  it('dedupes size-rule variants of one photo to the same key', () => {
    const small = normalizeKijijiImageUrl(PHOTO('u1', 'kijijica-200-jpg'));
    const large = normalizeKijijiImageUrl(PHOTO('u1', 'kijijica-640-webp'));
    expect(small.dedupKey).toBe(large.dedupKey);
  });

  it('upgrades to the largest size class the site itself serves, keeping the format', () => {
    expect(normalizeKijijiImageUrl(PHOTO('u1', 'kijijica-640-webp')).bestUrl).toContain('rule=kijijica-960-webp');
    // Already at or above 960: leave the served URL alone.
    expect(normalizeKijijiImageUrl(PHOTO('u1', 'kijijica-960-jpg')).bestUrl).toBe(PHOTO('u1', 'kijijica-960-jpg'));
  });

  it('leaves a non-media URL untouched', () => {
    const url = 'https://www.kijiji.ca/some/page.png';
    expect(normalizeKijijiImageUrl(url)).toEqual({ dedupKey: url, bestUrl: url });
  });
});

describe('isKijijiAdImageUrl', () => {
  it('keeps ad photos and drops the statics bucket', () => {
    expect(isKijijiAdImageUrl(PHOTO('u1'))).toBe(true);
    expect(isKijijiAdImageUrl(BADGE)).toBe(false);
  });

  it('keeps anything it does not recognise — a phantom badge beats a vanished photo', () => {
    expect(isKijijiAdImageUrl('https://cdn.example/whatever.png')).toBe(true);
    expect(isKijijiAdImageUrl('not a url')).toBe(true);
  });
});

/** Just enough session for enumerateImages: one tab whose page reports the
 *  given imgs. The registry and revision are what the real runtime carries. */
function sessionWith(imgs: { src: string; w?: number; h?: number }[]): BrowserSessionRuntime {
  const page = {
    url: () => 'https://www.kijiji.ca/v-toys-games/city-of-toronto/lego/1712345678',
    evaluate: async () =>
      imgs.map((img) => ({
        src: img.src,
        srcsetBest: null,
        naturalWidth: img.w ?? 800,
        naturalHeight: img.h ?? 600,
      })),
  };
  return {
    getTab: () => ({ tabId: 'tab_1', page, revision: 1, imageRegistry: new Map() }),
  } as unknown as BrowserSessionRuntime;
}

describe('gallery scope with the Kijiji hints', () => {
  const hints = {
    gallerySelectors: ['[data-testid="gallery"]'],
    normalizeImageUrl: normalizeKijijiImageUrl,
    isGalleryImage: isKijijiAdImageUrl,
  };

  it('returns the ad photos once each and no store badge', async () => {
    const session = sessionWith([
      { src: PHOTO('u1') },
      { src: PHOTO('u2') },
      // The same photo again as a thumbnail-rule variant: one candidate.
      { src: PHOTO('u1', 'kijijica-200-jpg') },
      { src: BADGE, w: 200, h: 200 },
    ]);
    const { images } = await enumerateImages(session, 'tab_1', 'gallery', hints);
    expect(images).toHaveLength(2);
    expect(images.every((image) => !image.sourceUrl?.includes('ca-prod-statics'))).toBe(true);
  });

  it('page scope keeps the badge: its contract is everything the page renders', async () => {
    const session = sessionWith([{ src: PHOTO('u1') }, { src: BADGE, w: 200, h: 200 }]);
    const { images } = await enumerateImages(session, 'tab_1', 'page', hints);
    expect(images).toHaveLength(2);
  });
});
