/**
 * The weekly response lifecycle: opt out, start/resume, submit.
 *
 * Note the advisory lock in optOut/submit. It is keyed the same way as the buzz
 * service's lock, which is what closes the check-then-act race between "this
 * member has not responded, so buzzing is allowed" and the member responding a
 * millisecond later. The two operations touch different tables, so no unique
 * constraint could catch that collision on its own.
 */

import { advisoryXactLock } from '../db/pool.js';
import * as drafts from '../db/repositories/drafts.js';
import * as weeklyResponses from '../db/repositories/weeklyResponses.js';
import type {
  DraftRecord,
  GroupId,
  UserId,
  WeeklyResponseRecord,
} from '../db/repositories/types.js';
import type { IsoDate } from '../domain/week.js';
import { weekStartDate } from '../domain/week.js';
import type { AppContext } from './context.js';

/** The lock key shared with buzzService. Both must use exactly this. */
export function responseLockKey(userId: UserId): string {
  return `response:${userId}`;
}

/** The active planning week for a group, in that group's timezone. */
export function currentWeek(ctx: AppContext, groupTimezone: string): IsoDate {
  return weekStartDate(ctx.clock.now(), groupTimezone);
}

/**
 * The escape hatch: one tap, ends the flow, asks nothing further.
 *
 * Any in-progress draft is discarded in the same transaction, so a member who
 * got halfway and then bailed does not leave a half-answer behind.
 */
export async function optOut(
  ctx: AppContext,
  params: { userId: UserId; groupId: GroupId; weekStartDate: IsoDate },
): Promise<WeeklyResponseRecord> {
  return ctx.db.withTransaction(async (tx) => {
    await advisoryXactLock(tx, responseLockKey(params.userId));

    const response = await weeklyResponses.optOut(tx, params.userId, {
      groupId: params.groupId,
      weekStartDate: params.weekStartDate,
    });

    const draft = await drafts.findDraftForSelf(tx, params.userId, {
      groupId: params.groupId,
      weekStartDate: params.weekStartDate,
    });
    if (draft) await drafts.deleteDraft(tx, draft.id);

    return response;
  });
}

export interface StartFlowResult {
  draft: DraftRecord;
  /** The member's existing answer for this week, if they already gave one. */
  existingResponse: WeeklyResponseRecord | null;
}

/**
 * Begins or resumes the questionnaire.
 *
 * Deliberately does NOT write a weekly_response row. That row's existence is
 * exactly what makes someone un-buzzable, so creating one at the start of the
 * flow would make a member who opened the DM and wandered off immune to
 * nudging - inverting the brief's own rule.
 */
export async function startOrResumeFlow(
  ctx: AppContext,
  params: { userId: UserId; groupId: GroupId; weekStartDate: IsoDate },
): Promise<StartFlowResult> {
  return ctx.db.withTransaction(async (tx) => {
    const existingResponse = await weeklyResponses.getResponseForSelf(tx, params.userId, {
      groupId: params.groupId,
      weekStartDate: params.weekStartDate,
    });
    const draft = await drafts.startOrResumeDraft(tx, params.userId, {
      groupId: params.groupId,
      weekStartDate: params.weekStartDate,
    });
    return { draft, existingResponse };
  });
}

/** A member's own answer. Self-scoped: the id is both filter and authorization. */
export async function getOwnResponse(
  ctx: AppContext,
  params: { userId: UserId; groupId: GroupId; weekStartDate: IsoDate },
): Promise<WeeklyResponseRecord | null> {
  return weeklyResponses.getResponseForSelf(ctx.db, params.userId, {
    groupId: params.groupId,
    weekStartDate: params.weekStartDate,
  });
}
