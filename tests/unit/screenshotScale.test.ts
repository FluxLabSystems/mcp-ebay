/**
 * Scaled-capture plumbing for browser_screenshot (2026-09-01 operator
 * request: cheaper screenshots, parity with the Claude-in-Chrome scale
 * knob). The CDP capture itself needs a live Chrome, so what is pinned
 * here is the decision logic: when the CDP path engages at all, and the
 * clip geometry it is handed.
 */
import { describe, expect, it } from 'vitest';
import { isDownscale, scaledClip } from '@browser-bridge/browser-core';

describe('screenshot scale plumbing', () => {
  it('only an actual downscale engages the CDP path', () => {
    // undefined and 1 must stay on the untouched Playwright path so the
    // no-scale behavior remains byte-identical to the pre-scale bridge.
    expect(isDownscale(undefined)).toBe(false);
    expect(isDownscale(1)).toBe(false);
    expect(isDownscale(0.99)).toBe(true);
    expect(isDownscale(0.1)).toBe(true);
  });

  it('carries the rect through with the scale attached', () => {
    expect(scaledClip({ x: 10, y: 20, width: 1280, height: 720 }, 0.5)).toEqual({
      x: 10,
      y: 20,
      width: 1280,
      height: 720,
      scale: 0.5,
    });
  });

  it('floors degenerate rects at one CSS pixel', () => {
    // A zero-dimension clip is a CDP protocol error; a collapsed element
    // box should fail as an empty capture, not as a protocol exception.
    const clip = scaledClip({ x: 0, y: 0, width: 0, height: 0 }, 0.25);
    expect(clip.width).toBe(1);
    expect(clip.height).toBe(1);
    expect(clip.scale).toBe(0.25);
  });
});
