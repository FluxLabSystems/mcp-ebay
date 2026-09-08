/**
 * One element's outerHTML, bounded and redacted — browser_markup.
 *
 * 2026-09-08 (site-ebay+extractor_defect+offers-row-seller-misattributed-to-
 * adjacent-row, third filing): the offers page read three rows' sellers
 * from a neighbouring row and nothing on the Bridge could show WHY, because
 * the boundary is markup and no tool returned any. The snapshot is
 * semantic, the screenshot is pixels; this returns the element itself.
 *
 * The redaction is not optional and not configurable: script, style,
 * template, noscript, iframe, object and embed descendants are removed, svg
 * contents emptied, every on* handler, style, srcset and value attribute is
 * dropped (a form value — a password, a search box, a postal code — is never
 * returned), data: URLs are replaced by a marker, runs of whitespace collapse
 * to one space, and the result is cut at maxChars with the full length
 * reported so a cut is never silent. data-bb-ref attributes are kept so the
 * markup lines up with the snapshot it came from.
 */
import { BridgeError, MARKUP_MAX_CHARS, parseElementRef } from '@browser-bridge/protocol';
import type { BrowserSessionRuntime } from './session.js';

export interface MarkupRead {
  elementRef: string;
  pageRevision: number;
  climbed: number;
  tagName: string;
  markup: string;
  length: number;
  truncated: boolean;
  redactedAttributes: number;
  redactedElements: number;
}

const REMOVED_ELEMENTS = 'script, style, template, noscript, iframe, object, embed';
const DROPPED_ATTRIBUTE_RE = /^(?:on[a-z]+|style|srcset|value)$/i;

export async function markup(
  session: BrowserSessionRuntime,
  tabId: string,
  elementRef: string,
  ancestors: number,
  maxChars: number,
  timeoutMs: number,
): Promise<MarkupRead> {
  const tab = session.getTab(tabId);
  const parsed = parseElementRef(elementRef);
  if (!parsed || parsed.pageRevision !== tab.revision) {
    throw new BridgeError(
      'STALE_ELEMENT',
      `Element reference belongs to page revision ${parsed?.pageRevision ?? '?'}; current revision is ${tab.revision}.`,
      { elementRef },
    );
  }
  const bound = Math.min(MARKUP_MAX_CHARS, Math.max(200, Math.floor(maxChars)));
  const climb = Math.min(8, Math.max(0, Math.floor(ancestors)));
  const locator = tab.page.locator(`[data-bb-ref="${elementRef}"]`);
  if ((await locator.count()) === 0) {
    throw new BridgeError('STALE_ELEMENT', 'Element is no longer present in the document.', { elementRef });
  }
  const read = await locator.first().evaluate(
    (referenced, args: { removed: string; dropped: string; bound: number; climb: number }) => {
      const dropped = new RegExp(args.dropped, 'i');
      let element: Element = referenced;
      let climbed = 0;
      while (climbed < args.climb && element.parentElement !== null && element.parentElement.tagName.toLowerCase() !== 'html') {
        element = element.parentElement;
        climbed += 1;
      }
      const clone = element.cloneNode(true) as Element;
      let redactedElements = 0;
      let redactedAttributes = 0;
      for (const node of Array.from(clone.querySelectorAll(args.removed))) {
        node.remove();
        redactedElements += 1;
      }
      for (const svg of Array.from(clone.querySelectorAll('svg'))) {
        if (svg.childNodes.length > 0) {
          svg.textContent = '';
          redactedElements += 1;
        }
      }
      const all = [clone, ...Array.from(clone.querySelectorAll('*'))];
      for (const node of all) {
        for (const name of Array.from(node.getAttributeNames())) {
          if (dropped.test(name)) {
            node.removeAttribute(name);
            redactedAttributes += 1;
          } else if (/^data:/i.test(node.getAttribute(name) ?? '')) {
            node.setAttribute(name, 'data:[redacted]');
            redactedAttributes += 1;
          }
        }
        const tag = node.tagName.toLowerCase();
        if (tag === 'textarea' && node.textContent !== '') {
          node.textContent = '';
          redactedAttributes += 1;
        }
      }
      const html = clone.outerHTML.replace(/\s+/g, ' ');
      return {
        climbed,
        tagName: element.tagName.toLowerCase(),
        markup: html.length > args.bound ? html.slice(0, args.bound) : html,
        length: html.length,
        truncated: html.length > args.bound,
        redactedAttributes,
        redactedElements,
      };
    },
    { removed: REMOVED_ELEMENTS, dropped: DROPPED_ATTRIBUTE_RE.source, bound, climb },
    { timeout: timeoutMs },
  );
  return { elementRef, pageRevision: tab.revision, ...read };
}
