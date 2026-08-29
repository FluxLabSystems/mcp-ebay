/**
 * Call-budget telemetry (@browser-bridge/telemetry). The load-bearing test
 * here is the redaction one: the recorder is handed whole argument objects
 * on purpose, so "sizes out, values never" has to be proven rather than
 * asserted in a comment.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandBroker, type BrokerDeps, type ToolCallRecorderHook } from '@browser-bridge/gateway';
import { WIRE_PROTOCOL_VERSION } from '@browser-bridge/protocol';
// telemetry is imported by relative path rather than a workspace alias:
// tests/package.json is not modified by this change, so the package is not
// linked into tests/node_modules; tsc and vitest both resolve the
// TypeScript source directly through this path.
import {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_TELEMETRY_DIR,
  buildRecord,
  createCallRecorder,
  createCallRecorderFromEnv,
  jsonByteLength,
  recorderOptionsFromEnv,
  type CallRecorder,
  type ToolCallObservation,
} from '../../packages/telemetry/src/index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bb-telemetry-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function observation(overrides: Partial<ToolCallObservation> = {}): ToolCallObservation {
  return {
    toolName: 'browser.extract',
    args: { browserSessionHandle: 'bs_abc', tabId: 't1', siteProfile: 'ebay.ca.v1' },
    response: { siteProfile: 'ebay.ca.v1', record: { candidateCount: 2 } },
    durationMs: 12.4,
    outcome: 'ok',
    errorCode: null,
    sessionId: 'bs_abc',
    requestId: 'req_1',
    ...overrides,
  };
}

async function readLog(recorder: CallRecorder): Promise<string> {
  await recorder.close();
  return readFile(recorder.logPath!, 'utf8');
}

describe('recorder enablement', () => {
  it('is off unless explicitly enabled, and writes nothing when off', async () => {
    const recorder = createCallRecorder({ dir });
    expect(recorder.enabled).toBe(false);
    expect(recorder.logPath).toBeNull();
    recorder.record(observation());
    await recorder.close();
    expect(await readdir(dir)).toEqual([]);
  });

  it('reads enablement from the environment, affirmative values only', () => {
    expect(recorderOptionsFromEnv({}).enabled).toBe(false);
    expect(recorderOptionsFromEnv({ BRIDGE_TELEMETRY: '0' }).enabled).toBe(false);
    expect(recorderOptionsFromEnv({ BRIDGE_TELEMETRY: 'false' }).enabled).toBe(false);
    for (const value of ['1', 'true', 'YES', ' on ']) {
      expect(recorderOptionsFromEnv({ BRIDGE_TELEMETRY: value }).enabled, value).toBe(true);
    }
    expect(createCallRecorderFromEnv({}).enabled).toBe(false);
  });

  it('defaults keep telemetry out of the repo and bounded on disk', () => {
    const options = recorderOptionsFromEnv({});
    expect(options.dir).toBe(DEFAULT_TELEMETRY_DIR);
    expect(options.dir?.startsWith(tmpdir())).toBe(true);
    expect(options.maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(options.maxFiles).toBe(DEFAULT_MAX_FILES);
  });

  it('takes rotation limits from the environment', () => {
    const options = recorderOptionsFromEnv({
      BRIDGE_TELEMETRY: '1',
      BRIDGE_TELEMETRY_DIR: '/var/log/bridge',
      BRIDGE_TELEMETRY_MAX_BYTES: '4096',
      BRIDGE_TELEMETRY_MAX_FILES: '3',
      BRIDGE_TELEMETRY_RUN_ID: 'run_x1',
    });
    expect(options).toMatchObject({ dir: '/var/log/bridge', maxFileBytes: 4096, maxFiles: 3, runId: 'run_x1' });
    // Garbage falls back rather than disabling the size ceiling.
    expect(recorderOptionsFromEnv({ BRIDGE_TELEMETRY_MAX_BYTES: 'lots' }).maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(recorderOptionsFromEnv({ BRIDGE_TELEMETRY_MAX_FILES: '-2' }).maxFiles).toBe(DEFAULT_MAX_FILES);
  });
});

describe('what reaches the log line', () => {
  it('records sizes, timings and correlation ids', async () => {
    const recorder = createCallRecorder({ enabled: true, dir, runId: 'run_t1' });
    recorder.record(observation());
    const lines = (await readLog(recorder)).trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      runId: 'run_t1',
      tool: 'browser.extract',
      outcome: 'ok',
      sessionId: 'bs_abc',
      requestId: 'req_1',
      errorCode: null,
      durationMs: 12,
    });
    expect(record.argBytes).toBe(jsonByteLength(observation().args));
    expect(record.responseBytes).toBe(jsonByteLength(observation().response));
    expect(typeof record.ts).toBe('string');
  });

  it('never writes an argument value, secret or otherwise (§26)', async () => {
    const secret = 'sk-live-2f4a9c1e7b0d8a6f3e5c1b9d7a4f2e6c';
    const recorder = createCallRecorder({ enabled: true, dir, runId: 'run_t2' });
    recorder.record(
      observation({
        args: {
          browserSessionHandle: 'bs_abc',
          authorization: `Bearer ${secret}`,
          password: 'hunter2',
          nested: { token: secret, destinationPostalCode: 'M6H 2W9' },
          value: 'a search phrase the user typed',
        },
        response: { setCookie: `session=${secret}`, listings: [{ id: 'ebay-1' }] },
      }),
    );
    const text = await readLog(recorder);
    for (const leak of [secret, 'hunter2', 'Bearer', 'authorization', 'password', 'M6H', 'a search phrase']) {
      expect(text, leak).not.toContain(leak);
    }
    // The sizes of those very objects are still there — that is the point.
    const record = JSON.parse(text.trim()) as Record<string, unknown>;
    expect(record.argBytes).toBeGreaterThan(100);
    expect(record.responseBytes).toBeGreaterThan(20);
  });

  it('refuses free-form text smuggled through an identifier field', () => {
    const record = buildRecord(
      observation({
        sessionId: `Bearer sk-live-2f4a9c1e7b0d8a6f3e5c1b9d7a4f2e6c`,
        requestId: 'req_ok-1',
        errorCode: 'NAVIGATION_TIMEOUT',
        toolName: 'browser.navigate',
      }),
      'run_t3',
    );
    expect(record.sessionId).toBe('[unsafe]');
    expect(record.requestId).toBe('req_ok-1');
    expect(record.errorCode).toBe('NAVIGATION_TIMEOUT');
    expect(record.tool).toBe('browser.navigate');
  });

  it('reports an unmeasurable payload as null rather than zero', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(jsonByteLength(circular)).toBeNull();
    expect(jsonByteLength(undefined)).toBe(0);
    expect(jsonByteLength({ a: 1 })).toBe(7);
    const record = buildRecord(observation({ args: circular }), 'run_t4');
    expect(record.argBytes).toBeNull();
  });
});

describe('degrading instead of failing', () => {
  it('survives a log directory that cannot exist', async () => {
    const blocker = join(dir, 'not-a-dir');
    await writeFile(blocker, 'a file sitting where the log directory would go');
    const recorder = createCallRecorder({ enabled: true, dir: join(blocker, 'logs') });
    expect(() => {
      recorder.record(observation());
      recorder.record(observation());
    }).not.toThrow();
    await expect(recorder.close()).resolves.toBeUndefined();
    // Later calls stay silent rather than retrying a doomed open.
    expect(() => recorder.record(observation())).not.toThrow();
    await recorder.close();
  });
});

describe('rotation', () => {
  it('caps retained files and keeps whole lines', async () => {
    const recorder = createCallRecorder({
      enabled: true,
      dir,
      runId: 'run_t5',
      maxFileBytes: 400,
      maxFiles: 3,
    });
    for (let index = 0; index < 40; index += 1) {
      recorder.record(observation({ requestId: `req_${index}` }));
      // Flush per call so each append is measured against the cap on its own.
      await recorder.close();
    }
    const files = (await readdir(dir)).sort();
    expect(files.length).toBeLessThanOrEqual(3);
    expect(files).toContain('tool-calls.ndjson');
    for (const file of files) {
      const text = await readFile(join(dir, file), 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      for (const line of text.trim().split('\n')) {
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      }
    }
  });

  it('truncates in place when only one file is retained', async () => {
    const recorder = createCallRecorder({ enabled: true, dir, maxFileBytes: 300, maxFiles: 1 });
    for (let index = 0; index < 20; index += 1) {
      recorder.record(observation({ requestId: `req_${index}` }));
      await recorder.close();
    }
    expect(await readdir(dir)).toEqual(['tool-calls.ndjson']);
  });
});

/**
 * The broker takes the recorder structurally, so the two halves are only
 * connected if something actually runs a call through it. A canned agent
 * result is enough: the hook sits on the path every outcome funnels into.
 */
function brokerWith(recorder: ToolCallRecorderHook | undefined, result: Record<string, unknown>): CommandBroker {
  const deps = {
    registry: {
      sessionOwner: () => 'dev_1',
      rememberSessionOwner: () => {},
      sendCommand: () =>
        Promise.resolve({
          protocolVersion: WIRE_PROTOCOL_VERSION,
          type: 'result',
          requestId: 'req_broker_1',
          status: 'ok',
          pageRevision: 3,
          result,
          artifacts: [],
          error: null,
          durationMs: 41,
        }),
    },
    store: { browserSessions: { get: () => Promise.resolve(null) }, audit: { insert: () => Promise.resolve() } },
    artifacts: {},
    logger: { info: () => {}, error: () => {} },
    ebayDestinationPostalCode: 'M6H 2W9',
    ...(recorder === undefined ? {} : { callRecorder: recorder }),
  } as unknown as BrokerDeps;
  return new CommandBroker(deps);
}

describe('gateway hook', () => {
  it('a recorder satisfies the broker hook without the gateway importing telemetry', () => {
    const recorder = createCallRecorder({ dir });
    const hook: ToolCallRecorderHook = recorder;
    expect(() => hook.record(observation())).not.toThrow();
  });

  it('the broker hands one observation per tool call to the recorder it was given', async () => {
    const seen: Parameters<ToolCallRecorderHook['record']>[0][] = [];
    const broker = brokerWith(
      { record: (o) => void seen.push(o) },
      { siteProfile: 'ebay.ca.v1', record: { candidateCount: 2 }, warnings: [] },
    );
    await broker.call(
      'browser.extract',
      { browserSessionHandle: 'bs_00000000000000000000000000000001', tabId: 't1', siteProfile: 'ebay.ca.v1' },
      { subject: 'user-1', traceparent: null },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      toolName: 'browser.extract',
      outcome: 'ok',
      errorCode: null,
      sessionId: 'bs_00000000000000000000000000000001',
      requestId: 'req_broker_1',
    });
    // The recorder gets the values so it can size them; only sizes come out.
    const record = buildRecord({ ...seen[0]!, durationMs: 0 }, 'run_t6');
    expect(record.argBytes).toBeGreaterThan(0);
    expect(record.responseBytes).toBeGreaterThan(0);
  });

  it('runs the same code with no recorder configured', async () => {
    const broker = brokerWith(undefined, { siteProfile: 'ebay.ca.v1', record: {}, warnings: [] });
    await expect(
      broker.call(
        'browser.extract',
        { browserSessionHandle: 'bs_00000000000000000000000000000001', tabId: 't1', siteProfile: 'ebay.ca.v1' },
        { subject: null, traceparent: null },
      ),
    ).resolves.toMatchObject({ structured: { siteProfile: 'ebay.ca.v1' } });
  });
});
