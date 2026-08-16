/**
 * Test browser harness: launches the LOCAL TEST BROWSER (bundled
 * Chromium) through the same launcher path production uses for branded
 * Chrome. Channel enforcement / no-fallback behavior is covered by
 * dedicated tests that assert plan shapes and BROWSER_UNAVAILABLE.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  BrowserSessionRuntime,
  buildTestLaunchPlan,
  launchPersistent,
} from '@browser-bridge/browser-core';
import type { SitePolicyProfile } from '@browser-bridge/policy';
import { createPagePolicy } from '@browser-bridge/windows-agent';

export function resolveTestExecutablePath(): string | undefined {
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // fall through
  }
  const fallback = process.env.BRIDGE_TEST_BROWSER;
  if (fallback !== undefined && existsSync(fallback)) return fallback;
  return undefined;
}

export interface BrowserHarness {
  session: BrowserSessionRuntime;
  profileDir: string;
  close: () => Promise<void>;
}

export async function launchTestSession(profile: SitePolicyProfile): Promise<BrowserHarness> {
  const profileDir = mkdtempSync(join(tmpdir(), 'bridge-profile-'));
  const plan = buildTestLaunchPlan(profileDir, resolveTestExecutablePath());
  const context = await launchPersistent(plan);
  const session = await BrowserSessionRuntime.create(context, 'test-profile', createPagePolicy(profile));
  return {
    session,
    profileDir,
    close: async () => {
      await session.close();
    },
  };
}
