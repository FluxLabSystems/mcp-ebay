/**
 * Gallery/page image enumeration and retrieval — SDD v0.5 FR-06, §16,
 * §20.4. Order is preserved; duplicates collapse by normalized URL; the
 * highest-resolution accessible source is preferred without bypassing
 * access controls.
 */
import {
  ARTIFACT_MAX_BYTES,
  BridgeError,
  isAllowedArtifactMime,
  newImageId,
  type ImageCandidate,
} from '@browser-bridge/protocol';
import { sniffImageMeta } from './imageMeta.js';
import type { GalleryHints } from './policyHooks.js';
import type { BrowserSessionRuntime, ImageRegistryEntry } from './session.js';

interface RawImage {
  src: string | null;
  srcsetBest: string | null;
  naturalWidth: number;
  naturalHeight: number;
}

function collectImagesInPage(args: { selectors: string[] }): RawImage[] {
  const parseSrcset = (srcset: string | null): string | null => {
    if (!srcset) return null;
    let bestUrl: string | null = null;
    let bestWeight = -1;
    for (const part of srcset.split(',')) {
      const chunk = part.trim();
      if (!chunk) continue;
      const pieces = chunk.split(/\s+/);
      const url = pieces[0] ?? '';
      let weight = 0;
      const descriptor = pieces[1] ?? '';
      if (descriptor.endsWith('w')) weight = parseFloat(descriptor);
      else if (descriptor.endsWith('x')) weight = parseFloat(descriptor) * 1000;
      if (url && weight >= bestWeight) {
        bestWeight = weight;
        bestUrl = url;
      }
    }
    return bestUrl;
  };

  const toRaw = (img: HTMLImageElement): RawImage => ({
    src: img.currentSrc || img.src || null,
    srcsetBest: parseSrcset(img.getAttribute('srcset')),
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
  });

  for (const selector of args.selectors) {
    let container: Element | null = null;
    try {
      container = document.querySelector(selector);
    } catch {
      container = null;
    }
    if (container) {
      const imgs = Array.from(container.querySelectorAll('img'));
      if (imgs.length > 0) return imgs.map(toRaw);
    }
  }
  return Array.from(document.querySelectorAll('img')).map(toRaw);
}

export async function enumerateImages(
  session: BrowserSessionRuntime,
  tabId: string,
  scope: 'page' | 'gallery',
  hints: GalleryHints = {},
): Promise<{ pageRevision: number; images: ImageCandidate[] }> {
  const tab = session.getTab(tabId);
  const selectors = scope === 'gallery' ? [...(hints.gallerySelectors ?? [])] : [];
  const raw = await tab.page.evaluate(collectImagesInPage, { selectors });

  const seen = new Set<string>();
  const candidates: ImageCandidate[] = [];
  tab.imageRegistry.clear();
  let order = 0;
  for (const image of raw) {
    const source = image.srcsetBest ?? image.src;
    if (!source) continue;
    let absolute: string;
    try {
      absolute = new URL(source, tab.page.url()).toString();
    } catch {
      continue;
    }
    if (absolute.startsWith('data:')) continue;
    // Gallery scope promises listing photos; a badge or store logo that
    // happens to render inside the gallery container is not one.
    if (scope === 'gallery' && hints.isGalleryImage !== undefined && !hints.isGalleryImage(absolute)) continue;
    const normalized = hints.normalizeImageUrl?.(absolute) ?? { dedupKey: absolute, bestUrl: absolute };
    if (seen.has(normalized.dedupKey)) continue;
    seen.add(normalized.dedupKey);
    const entry: ImageRegistryEntry = {
      imageId: newImageId(),
      order,
      sourceUrl: normalized.bestUrl,
      thumbnailUrl: image.src === null ? null : new URL(image.src, tab.page.url()).toString(),
      width: image.naturalWidth > 0 ? image.naturalWidth : null,
      height: image.naturalHeight > 0 ? image.naturalHeight : null,
      mimeType: null,
      pageRevision: tab.revision,
    };
    tab.imageRegistry.set(entry.imageId, entry);
    candidates.push({
      imageId: entry.imageId,
      order: entry.order,
      thumbnailUrl: entry.thumbnailUrl,
      sourceUrl: entry.sourceUrl,
      width: entry.width,
      height: entry.height,
      mimeType: entry.mimeType,
    });
    order += 1;
  }
  return { pageRevision: tab.revision, images: candidates };
}

export interface FetchedImage {
  buffer: Buffer;
  mimeType: string;
  sourceUrl: string;
  pageRevision: number;
}

/**
 * Fetch a previously enumerated image through the browser context's
 * request facility (shares cookies; obeys URL policy, §19.1
 * "direct image download").
 */
export async function fetchImage(
  session: BrowserSessionRuntime,
  tabId: string,
  imageId: string,
  timeoutMs: number,
): Promise<FetchedImage> {
  const tab = session.getTab(tabId);
  const entry = tab.imageRegistry.get(imageId);
  if (!entry || entry.pageRevision !== tab.revision) {
    throw new BridgeError(
      'STALE_ELEMENT',
      `imageId ${imageId} belongs to an older page revision; re-run browser_images.`,
      { imageId },
    );
  }
  if (!entry.sourceUrl) {
    throw new BridgeError('EXTRACTION_INCOMPLETE', `imageId ${imageId} has no fetchable source URL.`, { imageId });
  }
  await session.policy.assertUrlAllowed(entry.sourceUrl, 'image_download');
  const response = await session.browserContext.request.get(entry.sourceUrl, { timeout: timeoutMs });
  if (!response.ok()) {
    throw new BridgeError('EXTRACTION_INCOMPLETE', `Image fetch failed with HTTP ${response.status()}.`, {
      imageId,
      status: response.status(),
    });
  }
  const buffer = Buffer.from(await response.body());
  if (buffer.length > ARTIFACT_MAX_BYTES) {
    throw new BridgeError('ARTIFACT_TOO_LARGE', undefined, { byteLength: buffer.length });
  }
  const sniffed = sniffImageMeta(buffer);
  const headerMime = response.headers()['content-type']?.split(';')[0]?.trim();
  const mimeType = sniffed.mimeType ?? headerMime ?? 'application/octet-stream';
  // Audit F-06: only passive raster images may become artifacts; an
  // SVG/HTML payload is a policy-violating download (§19).
  if (!isAllowedArtifactMime(mimeType)) {
    throw new BridgeError('DOWNLOAD_BLOCKED', `Image MIME type "${mimeType}" is not permitted.`, {
      imageId,
      mimeType,
    });
  }
  return {
    buffer,
    mimeType,
    sourceUrl: entry.sourceUrl,
    pageRevision: tab.revision,
  };
}
