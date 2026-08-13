/**
 * Element interactions — SDD v0.5 FR-04, §19.2/§19.3 local enforcement.
 * Every interaction re-inspects the live element and consults the policy
 * hooks before acting; stale refs fail deterministically (§14).
 */
import type { Locator } from 'playwright';
import type { ActionContext, FieldContext } from '@browser-bridge/policy';
import { BridgeError, parseElementRef, ALLOWED_KEYS } from '@browser-bridge/protocol';
import type { BrowserSessionRuntime, TabState } from './session.js';

interface LiveElementInfo {
  accessibleName: string;
  role: string;
  href: string | null;
  formAction: string | null;
  text: string;
  field: {
    inputType: string | null;
    autocomplete: string | null;
    name: string | null;
    id: string | null;
    ariaLabel: string | null;
    formSignals: string | null;
  } | null;
  tag: string;
}

function resolveRef(session: BrowserSessionRuntime, tabId: string, elementRef: string): { tab: TabState; locator: Locator } {
  const tab = session.getTab(tabId);
  const parsed = parseElementRef(elementRef);
  if (!parsed) {
    throw new BridgeError('STALE_ELEMENT', `Element reference "${elementRef}" is malformed.`, { elementRef });
  }
  if (parsed.pageRevision !== tab.revision) {
    throw new BridgeError(
      'STALE_ELEMENT',
      `Element reference belongs to page revision ${parsed.pageRevision}; current revision is ${tab.revision}.`,
      { elementRef, currentRevision: tab.revision },
    );
  }
  return { tab, locator: tab.page.locator(`[data-bb-ref="${elementRef}"]`) };
}

async function inspectElement(locator: Locator): Promise<LiveElementInfo> {
  const count = await locator.count();
  if (count === 0) {
    throw new BridgeError('STALE_ELEMENT', 'Element is no longer present in the document.', {});
  }
  return locator.first().evaluate((el: Element): LiveElementInfo => {
    const tag = el.tagName.toLowerCase();
    const isFormField =
      el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
    const form = isFormField ? (el as HTMLInputElement).form : (el as HTMLButtonElement).form ?? null;
    const aria = el.getAttribute('aria-label') ?? '';
    const text = ((el as HTMLElement).innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
    const name = (aria || text || el.getAttribute('title') || el.getAttribute('alt') || '').slice(0, 200);
    return {
      accessibleName: name,
      role: el.getAttribute('role') ?? tag,
      href: el.getAttribute('href'),
      formAction: form ? form.getAttribute('action') : null,
      text,
      tag,
      field: isFormField
        ? {
            inputType: el instanceof HTMLInputElement ? (el.getAttribute('type') ?? 'text') : tag,
            autocomplete: el.getAttribute('autocomplete'),
            name: el.getAttribute('name'),
            id: el.id || null,
            ariaLabel: el.getAttribute('aria-label'),
            formSignals: form
              ? `${form.getAttribute('action') ?? ''} ${form.id} ${form.className} ${form.getAttribute('aria-label') ?? ''} ${form.getAttribute('name') ?? ''}`
              : null,
          }
        : null,
    };
  });
}

function toActionContext(info: LiveElementInfo, pageUrl: string): ActionContext {
  return {
    accessibleName: info.accessibleName,
    role: info.role,
    href: info.href,
    formAction: info.formAction,
    pageUrl,
    text: info.text,
  };
}

export interface ClickResult {
  pageRevision: number;
  url: string;
  changed: boolean;
}

export async function click(
  session: BrowserSessionRuntime,
  tabId: string,
  elementRef: string,
  timeoutMs: number,
): Promise<ClickResult> {
  const { tab, locator } = resolveRef(session, tabId, elementRef);
  const info = await inspectElement(locator);
  session.policy.assertActionAllowed(toActionContext(info, tab.page.url()));
  if (info.field !== null) {
    // Clicking into a secret field is also blocked (focus/interaction).
    session.policy.assertFieldAllowed(info.field as FieldContext);
  }
  const beforeRevision = tab.revision;
  const beforeUrl = tab.page.url();
  await locator.first().click({ timeout: timeoutMs });
  await tab.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
  const changed = tab.revision !== beforeRevision || tab.page.url() !== beforeUrl;
  if (!changed) tab.dirty = true;
  return { pageRevision: tab.revision, url: tab.page.url(), changed };
}

export interface FillResult {
  pageRevision: number;
  filled: boolean;
}

export async function fill(
  session: BrowserSessionRuntime,
  tabId: string,
  elementRef: string,
  value: string,
  timeoutMs: number,
): Promise<FillResult> {
  const { tab, locator } = resolveRef(session, tabId, elementRef);
  const info = await inspectElement(locator);
  if (info.field === null) {
    throw new BridgeError('ACTION_BLOCKED', 'Target element is not a fillable field.', { elementRef });
  }
  session.policy.assertFieldAllowed(info.field as FieldContext);
  session.policy.assertActionAllowed(toActionContext(info, tab.page.url()));
  await locator.first().fill(value, { timeout: timeoutMs });
  tab.dirty = true;
  return { pageRevision: tab.revision, filled: true };
}

export interface SelectResult {
  pageRevision: number;
  selectedValue: string;
}

export async function select(
  session: BrowserSessionRuntime,
  tabId: string,
  elementRef: string,
  value: string,
  timeoutMs: number,
): Promise<SelectResult> {
  const { tab, locator } = resolveRef(session, tabId, elementRef);
  const info = await inspectElement(locator);
  session.policy.assertActionAllowed(toActionContext(info, tab.page.url()));
  if (info.field !== null) {
    session.policy.assertFieldAllowed(info.field as FieldContext);
  }
  if (info.tag === 'select') {
    const results = await locator.first().selectOption(value, { timeout: timeoutMs });
    tab.dirty = true;
    return { pageRevision: tab.revision, selectedValue: results[0] ?? value };
  }
  // Radio buttons / role=option variants: click to select.
  await locator.first().click({ timeout: timeoutMs });
  tab.dirty = true;
  return { pageRevision: tab.revision, selectedValue: value };
}

export interface ScrollResult {
  pageRevision: number;
  scrollX: number;
  scrollY: number;
}

export async function scroll(
  session: BrowserSessionRuntime,
  tabId: string,
  deltaX: number,
  deltaY: number,
  elementRef?: string,
): Promise<ScrollResult> {
  const tab = session.getTab(tabId);
  if (elementRef !== undefined) {
    const { locator } = resolveRef(session, tabId, elementRef);
    const count = await locator.count();
    if (count === 0) throw new BridgeError('STALE_ELEMENT', 'Element is no longer present.', { elementRef });
    await locator.first().evaluate(
      (el, deltas: { dx: number; dy: number }) => {
        el.scrollBy(deltas.dx, deltas.dy);
      },
      { dx: deltaX, dy: deltaY },
    );
  } else {
    await tab.page.mouse.wheel(deltaX, deltaY);
  }
  await tab.page.waitForTimeout(100);
  const position = await tab.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  return { pageRevision: tab.revision, scrollX: position.x, scrollY: position.y };
}

export interface KeyResult {
  pageRevision: number;
  sent: boolean;
}

export async function pressKey(
  session: BrowserSessionRuntime,
  tabId: string,
  key: string,
): Promise<KeyResult> {
  const tab = session.getTab(tabId);
  if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
    throw new BridgeError('ACTION_BLOCKED', `Key "${key}" is not an allowed navigation key.`, { key });
  }
  // If focus is in a secret field, keystrokes are blocked (§19.3).
  const focusedField = await tab.page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const isFormField =
      el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
    if (!isFormField) return null;
    const form = (el as HTMLInputElement).form;
    return {
      inputType: el instanceof HTMLInputElement ? (el.getAttribute('type') ?? 'text') : el.tagName.toLowerCase(),
      autocomplete: el.getAttribute('autocomplete'),
      name: el.getAttribute('name'),
      id: el.id || null,
      ariaLabel: el.getAttribute('aria-label'),
      formSignals: form
        ? `${form.getAttribute('action') ?? ''} ${form.id} ${form.className} ${form.getAttribute('aria-label') ?? ''}`
        : null,
    };
  });
  if (focusedField !== null) {
    session.policy.assertFieldAllowed(focusedField as FieldContext);
  }
  await tab.page.keyboard.press(key);
  await tab.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
  tab.dirty = true;
  return { pageRevision: tab.revision, sent: true };
}
