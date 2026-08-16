/**
 * eBay gallery URL handling — SDD v0.5 §20.4. eBay serves size variants of
 * one image as .../images/g/<imageKey>/s-l<size>.<ext>; variants dedupe to
 * the image key and the highest-resolution accessible source is preferred
 * without bypassing access controls.
 */

export const EBAY_GALLERY_SELECTORS: readonly string[] = [
  '.ux-image-carousel-container',
  '.ux-image-carousel',
  '.ux-image-grid-container',
  '.ux-image-grid',
  '#PicturePanel',
  '#vi_main_img_fs',
];

const EBAY_IMAGE_PATTERN = /^(https?:)\/\/((?:i|thumbs\d*)\.ebayimg\.com)\/(?:images\/)?g\/([^/]+)\/s-l(\d+)(\.[a-z0-9]+)(?:\?.*)?$/i;

/** Highest widely-served eBay size class. */
const EBAY_BEST_SIZE = 1600;

export interface NormalizedImageUrl {
  dedupKey: string;
  bestUrl: string;
}

export function normalizeEbayImageUrl(url: string): NormalizedImageUrl {
  const match = EBAY_IMAGE_PATTERN.exec(url);
  if (!match) {
    return { dedupKey: url, bestUrl: url };
  }
  const imageKey = match[3]!;
  const size = Number.parseInt(match[4]!, 10);
  const ext = match[5]!;
  const targetSize = Math.max(size, EBAY_BEST_SIZE);
  return {
    dedupKey: `ebayimg:g/${imageKey}`,
    bestUrl: `https://i.ebayimg.com/images/g/${imageKey}/s-l${targetSize}${ext}`,
  };
}
