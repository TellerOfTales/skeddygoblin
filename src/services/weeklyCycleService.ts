/**
 * What the scheduler actually does, expressed without any Discord or timer
 * concepts so it can be driven directly from a test.
 *
 * Each job claims its run through job_run before doing anything, so calling
 * these twice is a no-op rather than a second round of DMs.
 */

import {
  MIN_AGGREGATE_HEADCOUNT,
  WEEKLY_PROMPT_HOUR,
  WEEKLY_PROMPT_MINUTE,
  DEFAULT_NUDGE_CUTOFF_DAY,
} from '../domain/constants.js';
import { hasWeeklyMomentPassed, parseTimeToMinutes, weekStartDate } from '../domain/week.js';
import type { IsoDate } from '../domain/week.js';
import * as jobRuns from '../db/repositories/jobRuns.js';
import * as memberships from '../db/repositories/memberships.js';
import * as users from '../db/repositories/users.js';
import * as weeklyResponses from '../db/repositories/weeklyResponses.js';
import * as drafts from '../db/repositories/drafts.js';
import type { GroupRecord } from '../db/repositories/types.js';
import type { Capacity } from '../domain/constants.js';
import * as draftService from './draftService.js';
import { autoApplyForGroup } from './personalDefaultsService.js';
import type { AppContext } from './context.js';
import { sendWeeklyPrompt } from './weeklyFlowService.js';
import { drainQueue } from './sendQueue.js';
import { submit } from './responseService.js';

/** Is it time to open the week for this group? */
export function isPromptDue(group: GroupRecord, now: Date): boolean {
  return hasWeeklyMomentPassed(
    now,
    group.timezone,
    0, // Monday
    WEEKLY_PROMPT_HOUR * 60 + WEEKLY_PROMPT_MINUTE,
  );
}

/** Has the nudge cutoff passed for this group? */
export function isCutoffDue(group: GroupRecord, now: Date): boolean {
  return hasWeeklyMomentPassed(
    now,
    group.timezone,
    group.nudgeCutoffDay ?? DEFAULT_NUDGE_CUTOFF_DAY,
    parseTimeToMinutes(group.nudgeCutoffTime),
  );
}

export interface PromptOutcome {
  ran: boolean;
  prompted: number;
  undeliverable: number;
}

/**
 * DMs the weekly questionnaire to everyone who has not answered yet.
 *
 * Delivery is sequential rather than fanned out: creating a DM channel is a
 * heavier Discord rate-limit bucket than sending a message, and a burst across
 * a whole group is exactly the shape that trips it.
 */
export async function runWeeklyPrompt(
  ctx: AppContext,
  group: GroupRecord,
  week: IsoDate,
  options: { excludeUserId?: number } = {},
): Promise<PromptOutcome> {
  const claimed = await jobRuns.claimJob(ctx.db, {
    groupId: group.id,
    jobKind: 'weekly_prompt',
    weekStartDate: week,
  });
  if (!claimed) return { ran: false, prompted: 0, undeliverable: 0 };

  const memberIds = await memberships.listMemberIds(ctx.db, group.id);
  const responded = new Set(
    await weeklyResponses.listRespondedUserIds(ctx.db, {
      groupId: group.id,
      weekStartDate: week,
    }),
  );
  // The person who triggered this has already been DM'd by the command itself;
  // sending again would land two identical prompts seconds apart.
  let pending = memberIds.filter((id) => !responded.has(id) && id !== options.excludeUserId);

  // Answer for anyone who asked to be answered for, then simply do not ask
  // them. This is the only path that actually saves someone the two minutes -
  // a template they still have to open and apply saves them nothing.
  const autoAnswered = await autoApplyForGroup(ctx, {
    groupId: group.id,
    weekStartDate: week,
    candidateUserIds: pending,
  });
  if (autoAnswered.length > 0) {
    const answered = new Set(autoAnswered);
    pending = pending.filter((id) => !answered.has(id));
    ctx.logger.info('answered from personal defaults', {
      groupId: group.id,
      week,
      count: autoAnswered.length,
    });
  }
  const recipients = await users.listUsersByIds(ctx.db, pending);

  // Through the shared queue rather than a sequential loop. Bounded
  // concurrency because DM channel creation is a global rate-limit bucket that
  // every group is spending from at once - a per-group loop cannot see that.
  const { sent, failed } = await drainQueue(
    recipients,
    async (user) => (await sendWeeklyPrompt(ctx, { user, group, weekStartDate: week })).ok,
    { logger: ctx.logger },
  );

  ctx.logger.info('weekly prompt sent', {
    groupId: group.id,
    week,
    prompted: sent,
    undeliverable: failed,
  });
  return { ran: true, prompted: sent, undeliverable: failed };
}

/**
 * Claims the cutoff post. The caller does the posting, because that is the one
 * part that genuinely needs a Discord channel.
 */
/**
 * Is every member accounted for this week?
 *
 * The floor matters: a "group" of one person who has answered is trivially
 * complete, and posting a board for them would both be useless and expose the
 * only respondent's picks as the aggregate.
 */
export async function isEveryoneAnswered(
  ctx: AppContext,
  group: GroupRecord,
  week: IsoDate,
): Promise<boolean> {
  const counts = await weeklyResponses.countRespondersAggregate(ctx.db, {
    groupId: group.id,
    weekStartDate: week,
  });
  return counts.total >= MIN_AGGREGATE_HEADCOUNT && counts.responded >= counts.total;
}

export async function claimCutoffPost(
  ctx: AppContext,
  group: GroupRecord,
  week: IsoDate,
): Promise<boolean> {
  return jobRuns.claimJob(ctx.db, {
    groupId: group.id,
    jobKind: 'nudge_cutoff',
    weekStartDate: week,
  });
}

/**
 * Claims the weekly library re-sync. Once per group per week is plenty:
 * libraries change slowly, and GetOwnedGames is one call per linked member.
 */
/**
 * Claims the library re-sync for one DAY, not one week.
 *
 * Libraries go stale the moment somebody buys something, and a week-old view of
 * what the group owns quietly produces a worse suggestion list every day until
 * Monday. Daily is cheap: GetOwnedGames is a single call per linked member, and
 * a friend group is a handful of calls - nothing like the Store metadata
 * endpoint, which is the rate-limited one and stays on its own slow drip.
 *
 * job_run's third column is named week_start_date because every other job is
 * weekly, but the primary key only cares that it is a DATE - so passing the
 * group-local day makes the same lock mean "once today" with no schema change.
 * The date is group-local so "daily" rolls over at the group's midnight rather
 * than UTC's.
 */
export async function claimSteamSync(
  ctx: AppContext,
  group: GroupRecord,
  localDay: IsoDate,
): Promise<boolean> {
  return jobRuns.claimJob(ctx.db, {
    groupId: group.id,
    jobKind: 'steam_sync',
    weekStartDate: localDay,
  });
}

export function currentWeekFor(ctx: AppContext, group: GroupRecord): IsoDate {
  return weekStartDate(ctx.clock.now(), group.timezone);
}

export interface AutoCommitOutcome {
  committed: number;
  skipped: number;
}

/**
 * Commits unfinished drafts at the cutoff, so forgetting to tap Submit does not
 * erase someone's answers.
 *
 * The problem this solves: everything a member picks lives in response_draft
 * until the final button writes weekly_response, availability_slot and vibe_tag
 * in one transaction. Someone who picked their days on the bus and never came
 * back was, as far as the leaderboard was concerned, silent - even though we
 * knew exactly when they were free.
 *
 * Why at the cutoff rather than on every tap: a weekly_response row is what
 * makes a member un-buzzable, so writing one the moment they pick a day would
 * make a half-finished person immune to being nudged - inverting the rule the
 * buzz feature exists to serve. Holding until the cutoff keeps them buzzable
 * for exactly as long as nudging them is still useful, and banks their answers
 * at the one moment it stops being useful.
 *
 * Capacity defaults to 1 when they never reached that step. It is the
 * conservative read - they are around, assume they are up for one session -
 * and it only ever affects the tie-break between equal-headcount windows, never
 * the headcount itself.
 */
export async function commitUnfinishedDrafts(
  ctx: AppContext,
  group: GroupRecord,
  week: IsoDate,
): Promise<AutoCommitOutcome> {
  const pending = await drafts.listDraftsForWeek(ctx.db, {
    groupId: group.id,
    weekStartDate: week,
  });

  let committed = 0;
  let skipped = 0;

  for (const draft of pending) {
    // toSlotRows applies the same precedence the flow does - per-day windows
    // when present, otherwise days x simpleWindows. Reading state.windows
    // directly here would silently skip everyone who used the single prompt.
    const slots = draftService.toSlotRows(draft.state);

    // Nothing to bank. An empty draft is someone who opened the DM and closed
    // it, which is not an answer and must not be recorded as one.
    if (slots.length === 0) {
      skipped++;
      continue;
    }

    try {
      await submit(ctx, {
        userId: draft.userId,
        groupId: group.id,
        weekStartDate: week,
        sessionsCommitted: (draft.state.capacity ?? 1) as Capacity,
        slots,
        vibes: draft.state.vibes ?? [],
        draftId: draft.id,
      });
      committed++;
    } catch (error) {
      // Already submitted between the read and here, or otherwise invalid. One
      // bad draft must not cost the rest of the group theirs.
      ctx.logger.warn('could not auto-commit draft', { draftId: draft.id, error });
      skipped++;
    }
  }

  if (committed > 0) {
    ctx.logger.info('auto-committed unfinished drafts', { groupId: group.id, week, committed });
  }
  return { committed, skipped };
}
