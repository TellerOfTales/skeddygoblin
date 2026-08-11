/**
 * Buzz: nudging someone who has not answered yet.
 *
 * ---------------------------------------------------------------------------
 * THE HARD RULE
 * ---------------------------------------------------------------------------
 * A buzz can never reach someone who has already responded. That is enforced
 * here, in the service, not by the disabled button in the roster - so it holds
 * for any client that ever calls this, including a future web or console app.
 * The roster's rendering is a courtesy; this function is the control.
 *
 * Rate limiting (one buzz per person per day) lives here too, above the
 * notifier, so it applies identically regardless of which transport eventually
 * delivers the message.
 */

import { advisoryXactLock } from '../db/pool.js';
import { BUZZ_PENDING_TIMEOUT_MINUTES } from '../domain/constants.js';
import { DomainError } from '../domain/errors.js';
import { localDate, type IsoDate } from '../domain/week.js';
import * as buzzLog from '../db/repositories/buzzLog.js';
import * as groups from '../db/repositories/groups.js';
import * as memberships from '../db/repositories/memberships.js';
import * as users from '../db/repositories/users.js';
import * as weeklyResponses from '../db/repositories/weeklyResponses.js';
import * as drafts from '../db/repositories/drafts.js';
import type { GroupId, UserId } from '../db/repositories/types.js';
import * as templates from '../notify/templates.js';
import type { AppContext } from './context.js';
import { responseLockKey } from './responseService.js';

export interface BuzzResult {
  buzzId: number;
  targetUserId: UserId;
}

/**
 * @throws DomainError GROUP_NOT_FOUND | SELF_BUZZ | ACTOR_NOT_MEMBER |
 *                     TARGET_NOT_MEMBER | ALREADY_RESPONDED | RATE_LIMITED |
 *                     DELIVERY_FAILED
 */
export async function buzz(
  ctx: AppContext,
  params: {
    actorUserId: UserId;
    targetUserId: UserId;
    groupId: GroupId;
    weekStartDate: IsoDate;
  },
): Promise<BuzzResult> {
  const group = await groups.findGroupById(ctx.db, params.groupId);
  if (!group) throw new DomainError('GROUP_NOT_FOUND');

  const buzzDate = localDate(ctx.clock.now(), group.timezone);

  // Everything that decides *whether* to buzz happens in one transaction, and
  // the DM is sent only after it commits.
  const claim = await ctx.db.withTransaction(async (tx) => {
    // Shared with responseService.optOut/submit. This is what closes the
    // check-then-act race between "they have not answered, so buzzing is
    // allowed" and them answering a millisecond later: the two operations touch
    // different tables, so no constraint could catch that collision.
    await advisoryXactLock(tx, responseLockKey(params.targetUserId));

    if (params.actorUserId === params.targetUserId) throw new DomainError('SELF_BUZZ');

    // A stale roster message in a guild the actor has left must not still work.
    if (!(await memberships.isMember(tx, params.actorUserId, params.groupId))) {
      throw new DomainError('ACTOR_NOT_MEMBER');
    }
    if (!(await memberships.isMember(tx, params.targetUserId, params.groupId))) {
      throw new DomainError('TARGET_NOT_MEMBER');
    }

    // Row existence, not status: opting out counts as responding, which is the
    // entire point of the escape hatch.
    if (
      await weeklyResponses.hasResponded(tx, {
        userId: params.targetUserId,
        groupId: params.groupId,
        weekStartDate: params.weekStartDate,
      })
    ) {
      throw new DomainError('ALREADY_RESPONDED');
    }

    const buzzId = await buzzLog.claimBuzz(tx, {
      groupId: params.groupId,
      actorUserId: params.actorUserId,
      targetUserId: params.targetUserId,
      weekStartDate: params.weekStartDate,
      buzzDate,
    });
    if (buzzId === null) throw new DomainError('RATE_LIMITED');

    return buzzId;
  });

  const target = await users.findUserById(ctx.db, params.targetUserId);
  if (!target) {
    await buzzLog.markBuzzStatus(ctx.db, claim, 'failed');
    throw new DomainError('TARGET_NOT_MEMBER');
  }

  const started = await drafts.listUserIdsWithProgress(ctx.db, {
    groupId: group.id,
    weekStartDate: params.weekStartDate,
  });

  const result = await ctx.notifier.notify(
    {
      id: target.id,
      discordId: target.discordId,
      preferredChannel: target.preferredChannel,
      phoneE164: target.phoneE164,
    },
    'buzz',
    templates.buzz({
      // Changes the ask from "please answer" to "please finish", which is the
      // only actionable thing to say to someone two taps from done.
      halfDone: started.includes(params.targetUserId),
      groupId: group.id,
      groupName: group.name,
      weekStartDate: params.weekStartDate,
    }),
  );

  if (!result.ok) {
    // Marking it failed releases the daily quota, because the partial unique
    // index ignores failed rows. An undeliverable nudge should not cost the
    // target their one buzz for the day.
    await buzzLog.markBuzzStatus(ctx.db, claim, 'failed');
    throw new DomainError('DELIVERY_FAILED', undefined, { reason: result.reason });
  }

  await buzzLog.markBuzzStatus(ctx.db, claim, 'sent');
  return { buzzId: claim, targetUserId: params.targetUserId };
}

/** Housekeeping for buzzes orphaned by a crash between COMMIT and notify(). */
export async function expireStalePendingBuzzes(ctx: AppContext): Promise<number> {
  return buzzLog.expireStalePendingBuzzes(ctx.db, BUZZ_PENDING_TIMEOUT_MINUTES);
}
