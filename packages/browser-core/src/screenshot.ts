/**
 * Screenshot capture — SDD v0.5 FR-05, §16. PNG by default; full-page
 * output may fall back to JPEG q90 when PNG exceeds 8 MiB.
 */
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

export async function screenshot(
  session: BrowserSessionRuntime,
  tabId: string,
  mode: 'viewport' | 'full_page' | 'element',
  format: 'png' | 'jpeg',
  elementRef: string | undefined,
  timeoutMs: number,
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
    buffer = await locator.first().screenshot({
      timeout: timeoutMs,
      type: format,
      ...(format === 'jpeg' ? { quality: 90 } : {}),
    });
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
