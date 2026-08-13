/**
 * User handoff — SDD v0.5 FR-11 (Should). Automation pauses, a reversible
 * banner offers a resume control, and the same tab/session continues
 * afterwards. If banner injection is not possible the handoff resolves at
 * the timeout with resumed=false.
 */
import type { BrowserSessionRuntime } from './session.js';

export interface HandoffResult {
  resumed: boolean;
  pageRevision: number;
  url: string;
}

function injectBanner(message: string): void {
  const id = '__browser_bridge_handoff__';
  if (document.getElementById(id)) return;
  const banner = document.createElement('div');
  banner.id = id;
  banner.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0b57d0;color:#fff;' +
    'font:14px system-ui,sans-serif;padding:10px 16px;display:flex;gap:16px;align-items:center;';
  const label = document.createElement('span');
  label.textContent = `Browser Bridge paused: ${message}`;
  const button = document.createElement('button');
  button.textContent = 'Resume automation';
  button.style.cssText = 'padding:4px 12px;border-radius:4px;border:none;cursor:pointer;';
  button.addEventListener('click', () => {
    (window as unknown as Record<string, unknown>).__browserBridgeResume = true;
    banner.remove();
  });
  banner.append(label, button);
  document.documentElement.append(banner);
}

export async function handoff(
  session: BrowserSessionRuntime,
  tabId: string,
  message: string,
  timeoutSeconds: number,
): Promise<HandoffResult> {
  const tab = session.getTab(tabId);
  let bannerInjected = true;
  try {
    await tab.page.evaluate(injectBanner, message);
  } catch {
    bannerInjected = false;
  }
  let resumed = false;
  if (bannerInjected) {
    try {
      await tab.page.waitForFunction(
        () => (window as unknown as Record<string, unknown>).__browserBridgeResume === true,
        undefined,
        { timeout: timeoutSeconds * 1000 },
      );
      resumed = true;
      await tab.page
        .evaluate(() => {
          delete (window as unknown as Record<string, unknown>).__browserBridgeResume;
        })
        .catch(() => undefined);
    } catch {
      resumed = false;
    }
  } else {
    await tab.page.waitForTimeout(timeoutSeconds * 1000);
  }
  // Manual interaction may have changed anything: force a revision bump so
  // pre-handoff element refs are deterministically stale (§14).
  tab.revision += 1;
  tab.dirty = false;
  return { resumed, pageRevision: tab.revision, url: tab.page.url() };
}
