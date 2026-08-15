/**
 * Agent-side harness: a real AgentConnection over a real WSS link, with
 * either a stubbed SessionHost (transport tests) or a real SessionManager
 * over the local test browser (e2e).
 */
import { pino } from 'pino';
import {
  generateDeviceKeyPair,
  newDeviceId,
  publicKeyFingerprint,
  type Tab,
} from '@browser-bridge/protocol';
import type { BrowserSessionRuntime } from '@browser-bridge/browser-core';
import {
  AgentConnection,
  type ConnectionOptions,
  type DeviceIdentity,
  type ExecutorHost,
  type SessionHost,
} from '@browser-bridge/windows-agent';
import type { GatewayHarness } from './gatewayHarness.js';

export interface TestDevice {
  identity: DeviceIdentity;
}

/** Register a paired, active device directly in the harness store. */
export async function registerTestDevice(harness: GatewayHarness, name = 'test-device'): Promise<TestDevice> {
  const pair = generateDeviceKeyPair();
  const deviceId = newDeviceId();
  await harness.store.devices.insert({
    deviceId,
    name,
    publicKeyEd25519: Buffer.from(pair.publicKeyPem, 'utf8'),
    keyFingerprint: publicKeyFingerprint(pair.publicKeyPem),
    status: 'active',
    agentVersion: null,
    pairedAt: new Date(),
    lastSeenAt: null,
  });
  return {
    identity: {
      deviceId,
      publicKeyPem: pair.publicKeyPem,
      privateKeyPem: pair.privateKeyPem,
      fingerprint: publicKeyFingerprint(pair.publicKeyPem),
      keyStoreKind: 'plainfile-dev',
    },
  };
}

/** SessionHost stub for transport tests (no browser involved). */
export function stubSessionHost(
  handle = 'bs_stub_session_000000000001',
  options: { openDelayMs?: number } = {},
): SessionHost & { openCount: number } {
  const tabs: Tab[] = [
    { tabId: 'tab_STUB0000000000000000000001', url: 'about:blank', title: 'stub', active: true, pageRevision: 0 },
  ];
  const host = {
    openCount: 0,
    isDegraded: false,
    async open(profileName: string) {
      host.openCount += 1;
      if (options.openDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.openDelayMs));
      }
      return { browserSessionHandle: handle, profileName, status: 'ready' as const, tabs };
    },
    resolve(): BrowserSessionRuntime {
      throw Object.assign(new Error('stub host has no live browser'), { code: 'SESSION_NOT_FOUND' });
    },
    listActive(): BrowserSessionRuntime[] {
      return [];
    },
  };
  return host;
}

export interface ConnectedAgent {
  connection: AgentConnection;
  waitReady: () => Promise<string>;
  stop: () => Promise<void>;
}

export function connectAgent(
  urls: { wsUrl: string; httpUrl: string },
  identity: DeviceIdentity,
  sessions: SessionHost,
  options: {
    heartbeatSeconds?: number;
    expectedPostalCode?: string;
    executeCommandImpl?: ConnectionOptions['executeCommandImpl'];
  } = {},
): ConnectedAgent {
  const logger = pino({ level: 'silent' });
  const host: ExecutorHost = {
    sessions,
    logger,
    expectedPostalCode: options.expectedPostalCode ?? 'M6H 2W9',
  };
  let readyResolve: ((connectionId: string) => void) | null = null;
  let readyPromise = new Promise<string>((resolve) => {
    readyResolve = resolve;
  });
  const connection = new AgentConnection({
    gatewayWsUrl: urls.wsUrl,
    gatewayHttpUrl: urls.httpUrl,
    identity,
    host,
    logger,
    heartbeatSeconds: options.heartbeatSeconds ?? 20,
    ...(options.executeCommandImpl === undefined ? {} : { executeCommandImpl: options.executeCommandImpl }),
    onReady: (connectionId) => {
      readyResolve?.(connectionId);
      readyPromise = new Promise<string>((resolve) => {
        readyResolve = resolve;
      });
    },
  });
  return {
    connection,
    waitReady: () => readyPromise,
    stop: () => connection.stop(),
  };
}
