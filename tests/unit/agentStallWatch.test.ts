/**
 * Agent-side observability for the stall (2026-09-15 wardrobe fire 10:0xZ,
 * windows-agent+coverage_gap+agent-stops-acknowledging-commands-mid-fire-
 * then-disconnects, re-filed after mcp-ebay#78 made the gateway side
 * legible): a fresh session's FIRST navigation was followed by 80 s of total
 * silence with the socket OPEN, then the drop. Nothing on the agent said
 * what it had been executing. Two things it can now say: every accepted
 * command is logged at acceptance (with its URL, bounded), and a blocked
 * event loop is logged after the fact with the last accepted command.
 */
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { startEventLoopStallWatch } from '@browser-bridge/windows-agent';

interface Line {
  msg: string;
  obj: Record<string, unknown>;
}

function capture(): { logger: pino.Logger; lines: Line[] } {
  const lines: Line[] = [];
  const logger = pino(
    { level: 'debug' },
    {
      write(line: string) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        lines.push({ msg: String(parsed.msg), obj: parsed });
      },
    },
  );
  return { logger, lines };
}

function blockFor(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // busy-wait: the only way to block a Node event loop from inside it
  }
}

describe('event-loop stall watch', () => {
  it('logs a blocked loop with how long it was blocked and the last accepted command', async () => {
    const { logger, lines } = capture();
    const watch = startEventLoopStallWatch({
      logger,
      intervalMs: 20,
      thresholdMs: 150,
      context: () => ({
        requestId: '01M2J8D8HPMMPQG2A92RWDCHXP',
        command: 'navigate',
        url: 'https://www.zazzle.ca/c/hats',
        acceptedAt: '2026-09-15T10:04:30.000Z',
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    blockFor(300);
    await new Promise((resolve) => setTimeout(resolve, 80));
    watch.stop();
    const stall = lines.find((line) => line.msg.startsWith('Event loop was blocked'));
    expect(stall).toBeDefined();
    expect(stall!.obj.blockedForMs as number).toBeGreaterThanOrEqual(150);
    expect(stall!.obj.thresholdMs).toBe(150);
    expect(stall!.obj.lastAcceptedCommand).toMatchObject({ command: 'navigate', url: 'https://www.zazzle.ca/c/hats' });
    expect(watch.stalls).toBeGreaterThanOrEqual(1);
  });

  it('stays silent while the loop turns freely', async () => {
    const { logger, lines } = capture();
    const watch = startEventLoopStallWatch({ logger, intervalMs: 10, thresholdMs: 500, context: () => null });
    await new Promise((resolve) => setTimeout(resolve, 100));
    watch.stop();
    expect(lines.filter((line) => line.msg.startsWith('Event loop was blocked'))).toHaveLength(0);
    expect(watch.stalls).toBe(0);
  });
});
