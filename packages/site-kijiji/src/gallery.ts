/**
 * Kijiji gallery URL handling, in the site-ebay gallery.ts mould. Ad photos
 * are served as media.kijiji.ca/api/v1/<bucket>/images/<aa>/<uuid> with a
 * ?rule=kijijica-<size>-<fmt> size variant; the uuid identifies the photo
 * and the rule picks a rendition, so variants dedupe on the path. The best
 * accessible variant is the largest size class observed served by the site
 * itself (960 in the live captures) — nothing larger is invented.
 */

export const KIJIJI_GALLERY_SELECTORS: readonly string[] = [
  '[data-testid="gallery"]',
  '[data-testid="vip-gallery"]',
  '[class*="galleryContainer"]',
  '[class*="heroImage"]',
];

const KIJIJI_MEDIA_RE = /^https?:\/\/media\.kijiji\.ca\/api\/v1\/([^/?#]+)\/images\/([^?#]+)/i;
const KIJIJI_RULE_RE = /^kijijica-(\d+)-([a-z0-9]+)$/i;

/** Largest size class the live captures show Kijiji serving. */
const KIJIJI_BEST_SIZE = 960;

export interface NormalizedKijijiImageUrl {
  dedupKey: string;
  bestUrl: string;
}

export function normalizeKijijiImageUrl(url: string): NormalizedKijijiImageUrl {
  const match = KIJIJI_MEDIA_RE.exec(url);
  if (match === null) return { dedupKey: url, bestUrl: url };
  const bucket = match[1]!.toLowerCase();
  const imagePath = match[2]!;
  let bestUrl = url;
  try {
    const parsed = new URL(url);
    const rule = parsed.searchParams.get('rule');
    const ruleMatch = rule === null ? null : KIJIJI_RULE_RE.exec(rule);
    if (ruleMatch !== null && Number.parseInt(ruleMatch[1]!, 10) < KIJIJI_BEST_SIZE) {
      parsed.searchParams.set('rule', `kijijica-${KIJIJI_BEST_SIZE}-${ruleMatch[2]!.toLowerCase()}`);
      bestUrl = parsed.toString();
    }
  } catch {
    // Keep the URL exactly as the page served it.
  }
  return { dedupKey: `kijiji:${bucket}/${imagePath}`, bestUrl };
}

/**
 * Whether a URL is an ad photo rather than site chrome. The statics bucket
 * serves badges, store logos and app chrome; on the 2026-08-30 connector
 * test one of those — a 200×200 store badge — rode along in gallery scope
 * beside the six real ad photos. Only the known-chrome bucket is excluded,
 * so an unrecognised host or bucket stays included rather than silently
 * dropped: a phantom badge costs one glance, a vanished ad photo costs
 * evidence.
 */
export function isKijijiAdImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'kijiji.ca' && !host.endsWith('.kijiji.ca')) return true;
    return !parsed.pathname.toLowerCase().includes('/ca-prod-statics/');
  } catch {
    return true;
  }
}
