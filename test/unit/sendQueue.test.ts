/**
 * The weekly prompt used to fan out group by group, sequentially. At 200
 * servers that serialises into hours, and no per-group loop can see that every
 * group is spending the same global Discord rate limit.
 */

import { describe, expect, it } from 'vitest';
import { drainQueue } from '../../src/services/sendQueue.js';

describe('drainQueue', () => {
  it('delivers every item exactly once', async () => {
    const items = Array.from({ length: 50 }, (_, index) => index);
    const seen: number[] = [];

    const stats = await drainQueue(items, async (item) => {
      seen.push(item);
      return true;
    });

    expect(stats).toEqual({ sent: 50, failed: 0 });
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;

    await drainQueue(
      Array.from({ length: 40 }, (_, index) => index),
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return true;
      },
      { concurrency: 4, jitterMs: 0 },
    );

    expect(peak).toBeLessThanOrEqual(4);
  });

  it('keeps going when a recipient fails or throws', async () => {
    // One closed DM must not strand the other 199 servers' members.
    const stats = await drainQueue(
      [1, 2, 3, 4, 5],
      async (item) => {
        if (item === 2) throw new Error('dm closed');
        if (item === 4) return false;
        return true;
      },
      { jitterMs: 0 },
    );

    expect(stats).toEqual({ sent: 3, failed: 2 });
  });

  it('does not let one slow recipient idle a whole worker', async () => {
    // Workers pull from a shared cursor rather than a fixed slice, so the fast
    // items finish regardless of where the slow one landed.
    const order: number[] = [];
    await drainQueue(
      [0, 1, 2, 3, 4, 5, 6, 7],
      async (item) => {
        await new Promise((resolve) => setTimeout(resolve, item === 0 ? 30 : 1));
        order.push(item);
        return true;
      },
      { concurrency: 2, jitterMs: 0 },
    );

    expect(order).toHaveLength(8);
    // The slow first item finishes last despite starting first.
    expect(order.at(-1)).toBe(0);
  });

  it('handles an empty queue without spawning workers', async () => {
    expect(await drainQueue([], async () => true)).toEqual({ sent: 0, failed: 0 });
  });
});
