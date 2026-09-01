/**
 * Screenshot capture — SDD v0.5 FR-05, §16. PNG by default; full-page
 * output may fall back to JPEG q90 when PNG exceeds 8 MiB.
 */
import type { Page } from 'playwright';
import { BridgeError, parseElementRef, FULL_PAGE_PNG_JPEG_FALLBACK_BYTES, ARTIFACT_MAX_BYTES } from '@browser-bridge/protocol';
import { sniffImageMeta } from './imageMeta.js';
import type { BrowserSessionRuntime } from './session.js';

export interface ScreenshotCapture {
  buffer: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  pageRevision: number;
}

interface CdpClip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

/**
 * CDP clip for a downscaled capture. Playwright's screenshot API has no
 * numeric scale, but Chrome's Page.captureScreenshot scales through
 * clip.scale, so scaled captures go over a raw CDP session. Width/height
 * are floored at 1 CSS pixel: a zero-dimension clip is a protocol error,
 * and a degenerate rect here means the page told us nothing anyway.
 */
export function scaledClip(
  rect: { x: number; y: number; width: number; height: number },
  scale: number,
): CdpClip {
  return {
    x: rect.x,
    y: rect.y,
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
    scale,
  };
}

/** Whether a requested scale actually changes the capture. */
export function isDownscale(scale: number | undefined): scale is number {
  return scale !== undefined && scale < 1;
}

async function cdpCapture(
  page: Page,
  format: 'png' | 'jpeg',
  clip: CdpClip,
  captureBeyondViewport: boolean,
): Promise<Buffer> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const result = await cdp.send('Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality: 90 } : {}),
      clip,
      ...(captureBeyondViewport ? { captureBeyondViewport: true } : {}),
    });
    return Buffer.from(result.data, 'base64');
  } finally {
    await cdp.detach().catch(() => {
      // A tab that navigated mid-capture can drop the session first.
    });
  }
}

export async function screenshot(
  session: BrowserSessionRuntime,
  tabId: string,
  mode: 'viewport' | 'full_page' | 'element',
  format: 'png' | 'jpeg',
  elementRef: string | undefined,
  timeoutMs: number,
  scale?: number,
): Promise<ScreenshotCapture> {
  const tab = session.getTab(tabId);
  let buffer: Buffer;
  let mimeType: 'image/png' | 'image/jpeg' = format === 'jpeg' ? 'image/jpeg' : 'image/png';

  const options = (fullPage: boolean): Parameters<typeof tab.page.screenshot>[0] => ({
    fullPage,
    timeout: timeoutMs,
    type: format,
    ...(format === 'jpeg' ? { quality: 90 } : {}),
  });

  if (mode === 'element') {
    if (elementRef === undefined) {
      throw new BridgeError('STALE_ELEMENT', 'elementRef is required for element screenshots.', {});
    }
    const parsed = parseElementRef(elementRef);
    if (!parsed || parsed.pageRevision !== tab.revision) {
      throw new BridgeError(
        'STALE_ELEMENT',
        `Element reference belongs to page revision ${parsed?.pageRevision ?? '?'}; current revision is ${tab.revision}.`,
        { elementRef },
      );
    }
    const locator = tab.page.locator(`[data-bb-ref="${elementRef}"]`);
    if ((await locator.count()) === 0) {
      throw new BridgeError('STALE_ELEMENT', 'Element is no longer present in the document.', { elementRef });
    }
    if (isDownscale(scale)) {
      const box = await locator.first().boundingBox();
      if (box === null) {
        throw new BridgeError('STALE_ELEMENT', 'Element has no renderable bounding box.', { elementRef });
      }
      buffer = await cdpCapture(tab.page, format, scaledClip(box, scale), false);
    } else {
      buffer = await locator.first().screenshot({
        timeout: timeoutMs,
        type: format,
        ...(format === 'jpeg' ? { quality: 90 } : {}),
      });
    }
  } else if (isDownscale(scale)) {
    // Layout metrics rather than viewportSize(): the CSS visual viewport is
    // what the user sees regardless of how the context was configured, and
    // cssContentSize is the full-page rect the same call reports.
    const cdp = await tab.page.context().newCDPSession(tab.page);
    let viewportRect: { x: number; y: number; width: number; height: number };
    let contentRect: { x: number; y: number; width: number; height: number };
    try {
      const metrics = await cdp.send('Page.getLayoutMetrics');
      const visual = metrics.cssVisualViewport;
      const content = metrics.cssContentSize;
      viewportRect = { x: visual.pageX, y: visual.pageY, width: visual.clientWidth, height: visual.clientHeight };
      contentRect = { x: 0, y: 0, width: content.width, height: content.height };
    } finally {
      await cdp.detach().catch(() => {});
    }
    const fullPage = mode === 'full_page';
    const clip = scaledClip(fullPage ? contentRect : viewportRect, scale);
    buffer = await cdpCapture(tab.page, format, clip, fullPage);
    if (fullPage && format === 'png' && buffer.length > FULL_PAGE_PNG_JPEG_FALLBACK_BYTES) {
      buffer = await cdpCapture(tab.page, 'jpeg', clip, true);
      mimeType = 'image/jpeg';
    }
  } else {
    buffer = await tab.page.screenshot(options(mode === 'full_page'));
    if (mode === 'full_page' && format === 'png' && buffer.length > FULL_PAGE_PNG_JPEG_FALLBACK_BYTES) {
      buffer = await tab.page.screenshot({ fullPage: true, timeout: timeoutMs, type: 'jpeg', quality: 90 });
      mimeType = 'image/jpeg';
    }
  }

  if (buffer.length > ARTIFACT_MAX_BYTES) {
    throw new BridgeError('ARTIFACT_TOO_LARGE', undefined, { byteLength: buffer.length });
  }

  const meta = sniffImageMeta(buffer);
  return {
    buffer,
    mimeType,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    pageRevision: tab.revision,
  };
}
