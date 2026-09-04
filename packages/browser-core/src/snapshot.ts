/**
 * Semantic page snapshot with stable element references — SDD v0.5 §14,
 * FR-03. Element refs are scoped to the page revision they were minted
 * for; secret fields are redacted per §19.3.
 */
import type { FieldContext } from '@browser-bridge/policy';
import { makeElementRef, type SemanticNode } from '@browser-bridge/protocol';
import { resolveDirtyRevision, type BrowserSessionRuntime } from './session.js';

interface RawSnapshotNode {
  ordinal: number;
  hash: string;
  role: string;
  name: string;
  text: string;
  /** Resolved absolute destination of a link-like element; null otherwise. */
  href: string | null;
  disabled: boolean;
  checked: boolean | null;
  isField: boolean;
  field: {
    inputType: string | null;
    autocomplete: string | null;
    name: string | null;
    id: string | null;
    ariaLabel: string | null;
    formSignals: string | null;
  } | null;
}

export interface SnapshotResult {
  url: string;
  title: string;
  pageRevision: number;
  snapshot: SemanticNode[];
  truncated: boolean;
}

/**
 * In-page collector. Runs inside the page; must stay self-contained
 * (no closure over Node scope). Tags nodes with data-bb-ref for later
 * action resolution.
 */
function collectInPage(args: { revision: number; maxNodes: number }): { nodes: RawSnapshotNode[]; truncated: boolean } {
  const { revision, maxNodes } = args;
  const SELECTOR = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    'img[alt]',
    'h1',
    'h2',
    'h3',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="combobox"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[onclick]',
    '[aria-label]',
  ].join(',');

  const djb2 = (value: string): string => {
    let hash = 5381;
    for (let i = 0; i < value.length; i++) {
      hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
  };

  const visible = (el: Element): boolean => {
    const html = el as HTMLElement;
    if (html.hidden) return false;
    const style = window.getComputedStyle(html);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = html.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'img';
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') return 'heading';
    if (tag === 'option') return 'option';
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      return 'textbox';
    }
    return 'generic';
  };

  const nameOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim().slice(0, 120);
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length > 0 && labels[0]) {
        const labelText = (labels[0].textContent ?? '').trim();
        if (labelText) return labelText.slice(0, 120);
      }
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder.trim().slice(0, 120);
    }
    const alt = el.getAttribute('alt');
    if (alt) return alt.trim().slice(0, 120);
    const title = el.getAttribute('title');
    if (title) return title.trim().slice(0, 120);
    const text = (el as HTMLElement).innerText ?? el.textContent ?? '';
    return text.trim().replace(/\s+/g, ' ').slice(0, 120);
  };

  // The destination a link resolves to, absolute, so a listing grid on a
  // host with no extractor can be traversed by URL (2026-09-03 wardrobe
  // Lane B fire: roster-host product cards carried names and prices but no
  // way to reach a product page). javascript: and other non-navigable
  // schemes are not destinations and stay null.
  const hrefOf = (el: Element): string | null => {
    if (el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement) {
      const resolved = el.href;
      return /^https?:/i.test(resolved) ? resolved : null;
    }
    const raw = el.getAttribute('href');
    if (!raw) return null;
    try {
      const resolved = new URL(raw, document.baseURI).href;
      return /^https?:/i.test(resolved) ? resolved : null;
    } catch {
      return null;
    }
  };

  // Money-like text outside any interactive element. The selector above
  // collects what a page lets you DO; a product page's own price is
  // something it merely SAYS, as styled text in a generic container with no
  // role, label or link around it (2026-09-04 wardrobe fire: Printful and
  // Spreadshirt PDPs snapshotted their whole buy box — technique radios,
  // colours, sizes, "Start designing" — and no price node, while sibling
  // recommendation cards' prices came through inside their links). Such
  // text is collected as role "text": the deepest visible element whose
  // text carries a currency amount, skipped when an ancestor is already an
  // interactive node (its text carries the amount) or a child carries the
  // amount itself (that child is the node). textContent is checked before
  // anything that forces layout, so a page of ten thousand spans costs one
  // regex each, not one style resolution each.
  const TEXT_SELECTOR = 'p,span,div,dd,dt,td,th,li,strong,b,em,i,s,del,ins,bdi,data,output,label,small,mark';
  const MONEY_RE =
    /(?:[$€£¥]|\b(?:C|CA|US|AU|NZ|A)\s?\$|\b(?:CAD|USD|EUR|GBP|AUD|CHF)\b)\s?\d[\d,]*(?:[.,]\d{1,2})?|\d[\d,]*(?:[.,]\d{1,2})?\s?(?:[€£]|\b(?:CAD|USD|EUR|GBP|AUD|CHF)\b)/i;
  const moneyLike = (value: string | null | undefined): boolean =>
    typeof value === 'string' && value.length <= 400 && MONEY_RE.test(value);
  const isPriceText = (el: Element): boolean => {
    if (el.matches(SELECTOR)) return false;
    if (!moneyLike(el.textContent)) return false;
    const parent = el.parentElement;
    if (parent !== null && parent.closest(SELECTOR) !== null) return false;
    for (const child of Array.from(el.children)) {
      if (moneyLike(child.textContent)) return false;
    }
    return true;
  };

  const elements = Array.from(document.querySelectorAll(`${SELECTOR},${TEXT_SELECTOR}`));
  const nodes: RawSnapshotNode[] = [];
  let truncated = false;
  let ordinal = 0;
  for (const el of elements) {
    if (nodes.length >= maxNodes) {
      truncated = true;
      break;
    }
    const priceText = !el.matches(SELECTOR);
    if (priceText && !isPriceText(el)) continue;
    if (!visible(el)) continue;
    const html = el as HTMLElement;
    const text = (html.innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
    if (priceText && !moneyLike(text)) continue;
    const role = priceText ? 'text' : roleOf(el);
    const name = priceText ? text.slice(0, 120) : nameOf(el);
    const isFormField =
      el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
    let field: RawSnapshotNode['field'] = null;
    if (isFormField) {
      const form = (el as HTMLInputElement).form;
      const formSignals = form
        ? `${form.getAttribute('action') ?? ''} ${form.id} ${form.className} ${form.getAttribute('aria-label') ?? ''} ${form.getAttribute('name') ?? ''}`
        : null;
      field = {
        inputType: el instanceof HTMLInputElement ? (el.getAttribute('type') ?? 'text') : el.tagName.toLowerCase(),
        autocomplete: el.getAttribute('autocomplete'),
        name: el.getAttribute('name'),
        id: el.id || null,
        ariaLabel: el.getAttribute('aria-label'),
        formSignals,
      };
    }
    let checked: boolean | null = null;
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      checked = el.checked;
    }
    const disabled =
      (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
    const hash = djb2(`${el.tagName}|${role}|${name}|${el.getAttribute('href') ?? ''}`);
    el.setAttribute('data-bb-ref', `el_${revision}_${ordinal}_${hash}`);
    nodes.push({
      ordinal,
      hash,
      role,
      name,
      text,
      href: hrefOf(el),
      disabled,
      checked,
      isField: isFormField,
      field,
    });
    ordinal += 1;
  }
  return { nodes, truncated };
}

export async function snapshot(
  session: BrowserSessionRuntime,
  tabId: string,
  maxNodes: number,
): Promise<SnapshotResult> {
  const tab = session.getTab(tabId);
  // §14: explicit snapshot refresh after mutation increments the revision
  // (shared with extraction-source capture so the two read models agree).
  const revision = resolveDirtyRevision(tab);
  const raw = await tab.page.evaluate(collectInPage, { revision, maxNodes });
  const nodes: SemanticNode[] = raw.nodes.map((node) => {
    const secret =
      node.field !== null && session.policy.isSecretField(node.field as FieldContext);
    return {
      elementRef: makeElementRef(revision, node.ordinal, node.hash),
      role: node.role,
      name: node.name,
      text: secret ? '' : node.text,
      href: node.href,
      disabled: node.disabled,
      checked: node.checked,
      valueRedacted: secret,
    };
  });
  return {
    url: tab.page.url(),
    title: await tab.page.title().catch(() => ''),
    pageRevision: revision,
    snapshot: nodes,
    truncated: raw.truncated,
  };
}
