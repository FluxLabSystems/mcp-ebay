/**
 * Semantic page snapshot with stable element references — SDD v0.5 §14,
 * FR-03. Element refs are scoped to the page revision they were minted
 * for; secret fields are redacted per §19.3.
 */
import type { FieldContext } from '@browser-bridge/policy';
import { makeElementRef, type SemanticNode } from '@browser-bridge/protocol';
import type { BrowserSessionRuntime } from './session.js';

interface RawSnapshotNode {
  ordinal: number;
  hash: string;
  role: string;
  name: string;
  text: string;
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

  const elements = Array.from(document.querySelectorAll(SELECTOR));
  const nodes: RawSnapshotNode[] = [];
  let truncated = false;
  let ordinal = 0;
  for (const el of elements) {
    if (nodes.length >= maxNodes) {
      truncated = true;
      break;
    }
    if (!visible(el)) continue;
    const role = roleOf(el);
    const name = nameOf(el);
    const html = el as HTMLElement;
    const text = (html.innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
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
  // §14: explicit snapshot refresh after mutation increments the revision.
  if (tab.dirty) {
    tab.revision += 1;
    tab.dirty = false;
  }
  const revision = tab.revision;
  const raw = await tab.page.evaluate(collectInPage, { revision, maxNodes });
  const nodes: SemanticNode[] = raw.nodes.map((node) => {
    const secret =
      node.field !== null && session.policy.isSecretField(node.field as FieldContext);
    return {
      elementRef: makeElementRef(revision, node.ordinal, node.hash),
      role: node.role,
      name: node.name,
      text: secret ? '' : node.text,
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
