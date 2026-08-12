/**
 * One global queue for outbound DMs.
 *
 * The weekly prompt used to fan out group by group, sequentially, inside the
 * scheduler tick. At one server that is fine. At 200 it is wrong twice over:
 * the work serialises into hours, and the per-group view cannot see that every
 * group is spending the SAME global Discord rate limit.
 *
 * Two properties matter and they pull against each other:
 *
 *   - Creating a DM channel is a heavier rate-limit bucket than sending to one
 *     that already exists, and it is global to the bot rather than per guild.
 *     So concurrency has to be bounded, and low.
 *   - A member of the 200th server should not wait behind 199 other groups.
 *     So the queue is global and FIFO across groups rather than nested loops.
 *
 * Deliberately in-process and unpersisted. A restart mid-fan-out loses the
 * remainder, and that is the right trade: the weekly prompt is idempotent by
 * job_run, and someone who missed one DM still has /availability, the public
 * post, and next week. Persisting a send queue would be a lot of machinery to
 * avoid a consequence nobody would notice.
 */

import { config } from '../config.js';
import type { Logger } from '../logger.js';

/** Concurrent sends. Low on purpose - DM channel creation is the tight bucket. */
export const SEND_CONCURRENCY = 4;

/**
 * Spread within a batch, so four sends do not land on the same millisecond.
 *
 * Zero outside production: the delay exists to be kind to Discord's rate
 * limiter, and there is no rate limiter in a test or a local run - only a
 * recording notifier that answers instantly. Paying it there would slow the
 * suite for no protection at all.
 */
export const SEND_JITTER_MS = config.nodeEnv === 'production' ? 250 : 0;

export interface SendQueueStats {
  sent: number;
  failed: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `task` over every item, at most SEND_CONCURRENCY at a time.
 *
 * Workers pull from a shared cursor rather than being handed a fixed slice:
 * one slow recipient (a closed DM that has to time out) would otherwise idle
 * its whole slice while the others finish.
 */
export async function drainQueue<T>(
  items: readonly T[],
  task: (item: T) => Promise<boolean>,
  options: { concurrency?: number; jitterMs?: number; logger?: Logger } = {},
): Promise<SendQueueStats> {
  const concurrency = Math.max(1, options.concurrency ?? SEND_CONCURRENCY);
  const jitterMs = options.jitterMs ?? SEND_JITTER_MS;

  let cursor = 0;
  const stats: SendQueueStats = { sent: 0, failed: 0 };

  async function worker(index: number): Promise<void> {
    // Stagger the starts so the first batch does not all fire at once.
    if (jitterMs > 0) await sleep(index * jitterMs);

    for (;;) {
      const next = cursor++;
      if (next >= items.length) return;

      try {
        if (await task(items[next]!)) stats.sent++;
        else stats.failed++;
      } catch (error) {
        // A single undeliverable recipient must never stop the queue.
        stats.failed++;
        options.logger?.warn('queued send threw', { error });
      }

      if (jitterMs > 0) await sleep(jitterMs);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, (_, index) => worker(index)),
  );

  return stats;
}
