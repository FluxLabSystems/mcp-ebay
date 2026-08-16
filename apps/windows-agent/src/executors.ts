/**
 * Command executors — SDD v0.5 §12, §15, §18. Every command re-validates
 * arguments against the normative schemas, checks expiry immediately
 * before execution, and runs serially per browser session.
 */
import { parseHTML } from 'linkedom';
import {
  click,
  enumerateImages,
  fetchImage,
  handoff,
  navigate,
  pressKey,
  screenshot,
  scroll,
  select,
  fill,
  snapshot,
  waitFor,
  type GalleryHints,
} from '@browser-bridge/browser-core';
import {
  BridgeError,
  ClickInput,
  ExtractInput,
  FillInput,
  HandoffInput,
  ImageGetInput,
  ImagesInput,
  KeyInput,
  NavigateInput,
  newArtifactId,
  ScreenshotInput,
  ScrollInput,
  SelectInput,
  SessionOpenInput,
  SnapshotInput,
  TabsInput,
  WaitInput,
  type CommandEnvelope,
} from '@browser-bridge/protocol';
import {
  classifyEbayPage,
  EBAY_GALLERY_SELECTORS,
  extractListing,
  isListingPage,
  normalizeEbayImageUrl,
  EBAY_SITE_PROFILE_ID,
} from '@browser-bridge/site-ebay';
import type { BrowserSessionRuntime } from '@browser-bridge/browser-core';
import { ensureDestination } from './destinationFlow.js';
import type { Logger } from './logger.js';
import type { SessionOpenResult } from './sessionManager.js';

export interface AgentArtifact {
  artifactId: string;
  mimeType: string;
  buffer: Buffer;
}

export interface ExecutionOutcome {
  result: Record<string, unknown>;
  pageRevision: number | null;
  artifacts: AgentArtifact[];
}

/**
 * Structural facade over SessionManager so transport-layer tests can stub
 * session ownership without a real browser.
 */
export interface SessionHost {
  open(profileName: string): Promise<SessionOpenResult>;
  resolve(browserSessionHandle: string): BrowserSessionRuntime;
  listActive(): BrowserSessionRuntime[];
  readonly isDegraded: boolean;
}

export interface ExecutorHost {
  sessions: SessionHost;
  logger: Logger;
  expectedPostalCode: string;
  /** Gallery hints; eBay hints by default, injectable for tests. */
  galleryHints?: GalleryHints;
}

function remainingBudgetMs(envelope: CommandEnvelope, floorMs = 1000): number {
  const expires = Date.parse(envelope.expiresAt);
  const remaining = expires - Date.now() - 250;
  return Math.max(floorMs, remaining);
}

function ebayGalleryHints(): GalleryHints {
  return {
    gallerySelectors: EBAY_GALLERY_SELECTORS,
    normalizeImageUrl: normalizeEbayImageUrl,
  };
}

export async function executeCommand(host: ExecutorHost, envelope: CommandEnvelope): Promise<ExecutionOutcome> {
  // §18: expiry is checked immediately before execution.
  if (Date.parse(envelope.expiresAt) <= Date.now()) {
    throw new BridgeError('REQUEST_EXPIRED', undefined, { requestId: envelope.requestId });
  }
  const budget = remainingBudgetMs(envelope);
  const args: unknown = envelope.arguments;

  switch (envelope.command) {
    case 'session_open': {
      const input = SessionOpenInput.parse({ deviceId: envelope.deviceId, ...(args as object) });
      const opened = await host.sessions.open(input.profileName);
      return {
        result: {
          browserSessionHandle: opened.browserSessionHandle,
          deviceId: envelope.deviceId,
          profileName: opened.profileName,
          status: opened.status,
          tabs: opened.tabs,
        },
        pageRevision: null,
        artifacts: [],
      };
    }
    case 'tabs': {
      TabsInput.parse({ browserSessionHandle: envelope.browserSessionHandle });
      const session = host.sessions.resolve(envelope.browserSessionHandle);
      return { result: { tabs: await session.listTabs() }, pageRevision: null, artifacts: [] };
    }
    default:
      break;
  }

  const session = host.sessions.resolve(envelope.browserSessionHandle);
  const tabId = envelope.tabId;
  if (tabId === null) {
    throw new BridgeError('TAB_NOT_FOUND', 'Command requires a tabId.', { command: envelope.command });
  }

  return session.enqueue(async (): Promise<ExecutionOutcome> => {
    // Re-check expiry once the command reaches the front of the queue (§18).
    if (Date.parse(envelope.expiresAt) <= Date.now()) {
      throw new BridgeError('REQUEST_EXPIRED', undefined, { requestId: envelope.requestId });
    }
    switch (envelope.command) {
      case 'navigate': {
        const input = NavigateInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await navigate(session, tabId, input.url, input.waitUntil, budget);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'snapshot': {
        const input = SnapshotInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await snapshot(session, tabId, input.maxNodes);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'screenshot': {
        const input = ScreenshotInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const capture = await screenshot(session, tabId, input.mode, input.format, input.elementRef, budget);
        const artifactId = newArtifactId();
        return {
          result: {
            artifactId,
            width: capture.width,
            height: capture.height,
            pageRevision: capture.pageRevision,
          },
          pageRevision: capture.pageRevision,
          artifacts: [{ artifactId, mimeType: capture.mimeType, buffer: capture.buffer }],
        };
      }
      case 'images': {
        const input = ImagesInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const hints =
          host.galleryHints ?? (session.policy.profile.id === EBAY_SITE_PROFILE_ID ? ebayGalleryHints() : {});
        const outcome = await enumerateImages(session, tabId, input.scope, hints);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'image_get': {
        const input = ImageGetInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const fetched = await fetchImage(session, tabId, input.imageId, budget);
        const artifactId = newArtifactId();
        return {
          result: { artifactId, sourceUrl: fetched.sourceUrl, pageRevision: fetched.pageRevision },
          pageRevision: fetched.pageRevision,
          artifacts: [{ artifactId, mimeType: fetched.mimeType, buffer: fetched.buffer }],
        };
      }
      case 'click': {
        const input = ClickInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await click(session, tabId, input.elementRef, budget);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'fill': {
        const input = FillInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await fill(session, tabId, input.elementRef, input.value, budget);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'select': {
        const input = SelectInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await select(session, tabId, input.elementRef, input.value, budget);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'scroll': {
        const input = ScrollInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await scroll(session, tabId, input.deltaX, input.deltaY, input.elementRef);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'key': {
        const input = KeyInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await pressKey(session, tabId, input.key);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'wait': {
        const input = WaitInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await waitFor(session, tabId, input.condition, Math.min(input.timeoutMs, budget));
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'extract': {
        // The gateway threads the deployment-authoritative destination on
        // the wire envelope (audit F-09); it is not part of the public
        // tool schema, so strip it before normative validation.
        const { destinationPostalCode, ...toolArgs } = args as Record<string, unknown>;
        ExtractInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...toolArgs,
        });
        const expectedPostal =
          typeof destinationPostalCode === 'string' && destinationPostalCode.length > 0
            ? destinationPostalCode
            : host.expectedPostalCode;
        return executeExtract(host, session, tabId, expectedPostal);
      }
      case 'handoff': {
        const input = HandoffInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await handoff(session, tabId, input.message, input.timeoutSeconds);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      default:
        throw new BridgeError('INTERNAL_ERROR', `Unknown command "${envelope.command}".`, {
          command: envelope.command,
        });
    }
  });
}

async function executeExtract(
  host: ExecutorHost,
  session: BrowserSessionRuntime,
  tabId: string,
  expectedPostalCode: string = host.expectedPostalCode,
): Promise<ExecutionOutcome> {
  const tab = session.getTab(tabId);
  const pageUrl = tab.page.url();
  const isEbayProfile = session.policy.profile.id === EBAY_SITE_PROFILE_ID;
  if (isEbayProfile) {
    const kind = classifyEbayPage(pageUrl);
    if (kind !== 'listing') {
      throw new BridgeError(
        'SITE_PROFILE_MISMATCH',
        `ebay.ca.v1 listing extraction supports canonical /itm/ pages; current page is "${kind}" (${pageUrl}).`,
        { pageUrl, kind },
      );
    }
  }

  // §20.1: verify/set destination through reversible controls before
  // marking shipping destination-resolved.
  let verifiedDestination: { postalCode: string; verified: boolean } | undefined;
  if (isEbayProfile && isListingPage(pageUrl)) {
    const outcome = await ensureDestination(session, tabId, expectedPostalCode, host.logger);
    verifiedDestination =
      outcome.postalCode === null
        ? { postalCode: '', verified: false }
        : { postalCode: outcome.postalCode, verified: outcome.verified };
  }

  const html = await tab.page.content();
  const { document } = parseHTML(html);
  const { record, warnings } = extractListing(document as unknown as Document, pageUrl, {
    expectedPostalCode,
    verifiedDestination,
    pageRevision: tab.revision,
  });

  const allWarnings = [...warnings];
  if (verifiedDestination !== undefined && !verifiedDestination.verified) {
    allWarnings.push('DESTINATION_UNVERIFIED');
  }
  return {
    result: {
      siteProfile: record.siteProfile,
      pageRevision: tab.revision,
      record: record as unknown as Record<string, unknown>,
      warnings: allWarnings,
    },
    pageRevision: tab.revision,
    artifacts: [],
  };
}
