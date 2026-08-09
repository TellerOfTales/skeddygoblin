/**
 * What the scheduler actually does, expressed without any Discord or timer
 * concepts so it can be driven directly from a test.
 *
 * Each job claims its run through job_run before doing anything, so calling
 * these twice is a no-op rather than a second round of DMs.
 */

import {
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
import type { GroupRecord } from '../db/repositories/types.js';
import type { AppContext } from './context.js';
import { sendWeeklyPrompt } from './weeklyFlowService.js';

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
  const pending = memberIds.filter((id) => !responded.has(id));
  const recipients = await users.listUsersByIds(ctx.db, pending);

  let prompted = 0;
  let undeliverable = 0;
  for (const user of recipients) {
    const result = await sendWeeklyPrompt(ctx, { user, group, weekStartDate: week });
    if (result.ok) prompted++;
    else undeliverable++;
  }

  ctx.logger.info('weekly prompt sent', { groupId: group.id, week, prompted, undeliverable });
  return { ran: true, prompted, undeliverable };
}

/**
 * Claims the cutoff post. The caller does the posting, because that is the one
 * part that genuinely needs a Discord channel.
 */
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

export function currentWeekFor(ctx: AppContext, group: GroupRecord): IsoDate {
  return weekStartDate(ctx.clock.now(), group.timezone);
}
