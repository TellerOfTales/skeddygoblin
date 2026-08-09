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
import * as availability from '../db/repositories/availability.js';
import * as drafts from '../db/repositories/drafts.js';
import * as vibes from '../db/repositories/vibes.js';
import * as weeklyResponses from '../db/repositories/weeklyResponses.js';
import type {
  DraftRecord,
  GroupId,
  SlotRow,
  UserId,
  WeeklyResponseRecord,
} from '../db/repositories/types.js';
import type { Capacity, VibeTag } from '../domain/constants.js';
import { isCapacity } from '../domain/constants.js';
import { DomainError } from '../domain/errors.js';
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

export interface SubmitResult {
  response: WeeklyResponseRecord;
  slotsWritten: number;
  vibesWritten: number;
}

/**
 * Finalises the questionnaire.
 *
 * All of it lands together or none of it does. The ordering is forced by the
 * schema: availability_slot and vibe_tag both carry a composite foreign key to
 * weekly_response, so the parent row must be upserted first - which also means
 * a failure part-way through cannot leave slots pointing at nothing.
 *
 * Takes the same advisory lock as the buzz service, so a member submitting at
 * the exact moment someone presses Buzz resolves one way or the other rather
 * than interleaving.
 */
export async function submit(
  ctx: AppContext,
  params: {
    userId: UserId;
    groupId: GroupId;
    weekStartDate: IsoDate;
    sessionsCommitted: Capacity;
    slots: readonly SlotRow[];
    vibes: readonly VibeTag[];
    /** Draft to consume. Deleted in the same transaction. */
    draftId?: number | undefined;
  },
): Promise<SubmitResult> {
  if (params.slots.length === 0) throw new DomainError('NO_DAYS_SELECTED');
  if (!isCapacity(params.sessionsCommitted)) throw new DomainError('NO_CAPACITY_SELECTED');

  return ctx.db.withTransaction(async (tx) => {
    await advisoryXactLock(tx, responseLockKey(params.userId));

    const scope = { groupId: params.groupId, weekStartDate: params.weekStartDate };

    const response = await weeklyResponses.submit(tx, params.userId, {
      ...scope,
      sessionsCommitted: params.sessionsCommitted,
    });

    const slotsWritten = await availability.replaceSlotsForSelf(
      tx,
      params.userId,
      scope,
      params.slots,
    );
    const vibesWritten = await vibes.replaceVibesForSelf(tx, params.userId, scope, params.vibes);

    if (params.draftId !== undefined) await drafts.deleteDraft(tx, params.draftId);

    return { response, slotsWritten, vibesWritten };
  });
}

/** A member's own complete answer, for the confirmation screen. */
export async function getOwnSubmission(
  ctx: AppContext,
  params: { userId: UserId; groupId: GroupId; weekStartDate: IsoDate },
): Promise<{
  response: WeeklyResponseRecord | null;
  slots: SlotRow[];
  vibes: VibeTag[];
}> {
  const scope = { groupId: params.groupId, weekStartDate: params.weekStartDate };
  return {
    response: await weeklyResponses.getResponseForSelf(ctx.db, params.userId, scope),
    slots: await availability.listSlotsForSelf(ctx.db, params.userId, scope),
    vibes: await vibes.listVibesForSelf(ctx.db, params.userId, scope),
  };
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
