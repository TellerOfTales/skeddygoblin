/**
 * A 60-second tick that evaluates idempotent conditions - not cron.
 *
 * Cron fires at a wall-clock instant and, if the process happens to be down at
 * that moment, silently skips forever. For a WEEKLY prompt that means a dead
 * week for the whole group. A tick plus a persisted marker in job_run gets
 * catch-up semantics for free: whenever the process comes back, the condition
 * is still true and the job runs late rather than never.
 *
 * Single instance is the intended deployment, but correctness does not depend
 * on it: job_run's primary key is the real lock (see claimJob), and the session
 * advisory lock below is belt and braces.
 */

import { config } from '../config.js';
import { tryAdvisorySessionLock } from '../db/pool.js';
import * as groups from '../db/repositories/groups.js';
import * as drafts from '../db/repositories/drafts.js';
import { DRAFT_TTL_DAYS } from '../domain/constants.js';
import type { AppContext } from '../services/context.js';
import {
  claimCutoffPost,
  currentWeekFor,
  isCutoffDue,
  isPromptDue,
  runWeeklyPrompt,
} from '../services/weeklyCycleService.js';
import type { GroupRecord } from '../db/repositories/types.js';

const SCHEDULER_LOCK_KEY = 'skeddygoblin:scheduler';

export interface SchedulerHooks {
  /** Posts the roster + leaderboard to the group's channel. */
  postCutoff(group: GroupRecord, week: string): Promise<void>;
}

export async function runTick(ctx: AppContext, hooks: SchedulerHooks): Promise<void> {
  const all = await groups.listAllGroups(ctx.db);

  for (const group of all) {
    const week = currentWeekFor(ctx, group);

    try {
      if (isPromptDue(group, ctx.clock.now())) {
        await runWeeklyPrompt(ctx, group, week);
      }

      if (isCutoffDue(group, ctx.clock.now())) {
        // Claim first: posting twice is worse than posting late.
        if (await claimCutoffPost(ctx, group, week)) {
          await hooks.postCutoff(group, week);
        }
      }
    } catch (error) {
      // One bad group must not stop the others.
      ctx.logger.error('scheduler tick failed for group', { groupId: group.id, error });
    }
  }

  try {
    const pruned = await drafts.deleteStaleDrafts(ctx.db, DRAFT_TTL_DAYS);
    if (pruned > 0) ctx.logger.debug('pruned stale drafts', { pruned });
  } catch (error) {
    ctx.logger.error('draft prune failed', { error });
  }
}

export interface Scheduler {
  stop(): void;
}

export async function startScheduler(
  ctx: AppContext,
  hooks: SchedulerHooks,
): Promise<Scheduler | undefined> {
  if (!config.scheduler.enabled) {
    ctx.logger.info('scheduler disabled by configuration');
    return undefined;
  }

  const acquired = await tryAdvisorySessionLock(ctx.db, SCHEDULER_LOCK_KEY);
  if (!acquired) {
    ctx.logger.warn(
      'scheduler disabled: another instance holds the lock, serving interactions only',
    );
    return undefined;
  }

  let running = false;
  const timer = setInterval(() => {
    // Skip rather than overlap if a tick outlives its interval.
    if (running) return;
    running = true;
    void runTick(ctx, hooks)
      .catch((error: unknown) => ctx.logger.error('scheduler tick failed', { error }))
      .finally(() => {
        running = false;
      });
  }, config.scheduler.tickIntervalMs);

  // Never hold the process open on the timer alone.
  timer.unref();

  ctx.logger.info('scheduler started', { intervalMs: config.scheduler.tickIntervalMs });
  return { stop: () => clearInterval(timer) };
}
