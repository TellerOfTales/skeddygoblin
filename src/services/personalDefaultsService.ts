/**
 * Personal availability: filled in once, projected onto every server.
 *
 * The projection writes ordinary weekly_response / availability_slot / vibe_tag
 * rows through the same submit() everything else uses, so overlap, roster and
 * buzz stay entirely unaware a template was involved. Nothing downstream needs
 * a special case, which is the point.
 *
 * TIMEZONE: day+window labels carry no zone, and windows are group-local
 * everywhere (domain/week.ts explains why - the no-timestamps rule forces it).
 * So a default of "Wednesday evening" means each server's OWN Wednesday
 * evening. For one friend group that is invisible; across countries it is real,
 * and the copy says so rather than pretending otherwise.
 */

import { DomainError } from '../domain/errors.js';
import { isCapacity, type Capacity, type VibeTag } from '../domain/constants.js';
import * as userDefaults from '../db/repositories/userDefaults.js';
import * as memberships from '../db/repositories/memberships.js';
import * as groups from '../db/repositories/groups.js';
import * as weeklyResponses from '../db/repositories/weeklyResponses.js';
import * as availability from '../db/repositories/availability.js';
import * as vibesRepo from '../db/repositories/vibes.js';
import type { SlotRow, UserId } from '../db/repositories/types.js';
import type { AppContext } from './context.js';
import { currentWeek, submit } from './responseService.js';

export type { PersonalDefaults } from '../db/repositories/userDefaults.js';

export async function getDefaults(
  ctx: AppContext,
  userId: UserId,
): Promise<userDefaults.PersonalDefaults> {
  return userDefaults.getDefaultsForSelf(ctx.db, userId);
}

/** Saves the whole template in one transaction: partial saves confuse people. */
export async function saveDefaults(
  ctx: AppContext,
  userId: UserId,
  params: {
    slots: readonly SlotRow[];
    capacity?: Capacity | undefined;
    vibes?: readonly VibeTag[] | undefined;
  },
): Promise<void> {
  await ctx.db.withTransaction(async (tx) => {
    await userDefaults.replaceDefaultSlotsForSelf(tx, userId, params.slots);
    await userDefaults.setDefaultPreferencesForSelf(tx, userId, {
      capacity: params.capacity,
      vibes: params.vibes,
    });
  });
}

export async function setAutoApply(
  ctx: AppContext,
  userId: UserId,
  autoApply: boolean,
): Promise<void> {
  await userDefaults.setAutoApplyForSelf(ctx.db, userId, autoApply);
}

export interface ApplyOutcome {
  applied: { groupId: number; groupName: string }[];
  /** Groups skipped because an explicit answer already exists this week. */
  alreadyAnswered: string[];
}

/**
 * Projects the template onto every group the member belongs to.
 *
 * Skips any group where they already answered this week, always. An explicit
 * answer beats a template every time - silently replacing one with a default
 * would be the worst bug this feature could have, and it would be invisible to
 * the person it happened to.
 */
export async function applyToAllGroups(ctx: AppContext, userId: UserId): Promise<ApplyOutcome> {
  const defaults = await userDefaults.getDefaultsForSelf(ctx.db, userId);
  if (defaults.slots.length === 0) throw new DomainError('NO_DAYS_SELECTED');

  const groupIds = await memberships.listGroupIdsForSelf(ctx.db, userId);
  const outcome: ApplyOutcome = { applied: [], alreadyAnswered: [] };

  for (const groupId of groupIds) {
    const group = await groups.findGroupById(ctx.db, groupId);
    if (!group) continue;

    const week = currentWeek(ctx, group.timezone);

    if (await weeklyResponses.hasResponded(ctx.db, { userId, groupId, weekStartDate: week })) {
      outcome.alreadyAnswered.push(group.name);
      continue;
    }

    await submit(ctx, {
      userId,
      groupId,
      weekStartDate: week,
      // A template with no capacity means "I am around"; one session is the
      // conservative read, matching the cutoff auto-commit.
      sessionsCommitted: isCapacity(defaults.capacity) ? defaults.capacity : 1,
      slots: defaults.slots,
      vibes: defaults.vibes,
    });
    outcome.applied.push({ groupId, groupName: group.name });
  }

  return outcome;
}

/**
 * Answers on behalf of members who asked to be answered for.
 *
 * Called from the weekly prompt, before the DMs go out, so someone with
 * auto-apply on is submitted and then simply not asked. They can still change
 * it - running /availability again edits a submitted response.
 */
export async function autoApplyForGroup(
  ctx: AppContext,
  params: { groupId: number; weekStartDate: string; candidateUserIds: readonly UserId[] },
): Promise<UserId[]> {
  const eligible = await userDefaults.listAutoApplyUserIds(ctx.db, params.candidateUserIds);
  const answered: UserId[] = [];

  for (const userId of eligible) {
    try {
      const defaults = await userDefaults.getDefaultsForSelf(ctx.db, userId);
      if (defaults.slots.length === 0) continue;

      await submit(ctx, {
        userId,
        groupId: params.groupId,
        weekStartDate: params.weekStartDate,
        sessionsCommitted: isCapacity(defaults.capacity) ? defaults.capacity : 1,
        slots: defaults.slots,
        vibes: defaults.vibes,
      });
      answered.push(userId);
    } catch (error) {
      // One bad template must not stop the rest of the group being prompted.
      ctx.logger.warn('auto-apply failed', { userId, groupId: params.groupId, error });
    }
  }

  return answered;
}

export interface SubmittedSummary {
  userId: UserId;
  groupName: string;
  weekStartDate: string;
  capacity: Capacity;
  slotCount: number;
  dayCount: number;
  vibes: VibeTag[];
  autoApply: boolean;
}

/**
 * Rebuilds the confirmation summary from what was actually submitted, and
 * optionally stores it as the member's template.
 *
 * Reads the database rather than trusting a draft, because submit() has already
 * consumed the draft by the time the confirmation's buttons are pressed - and
 * because "save exactly what I am looking at" is the promise the button makes.
 */
export async function saveDefaultsFromLatestAnswer(
  ctx: AppContext,
  userId: UserId,
  options: { saveSlots?: boolean } = {},
): Promise<SubmittedSummary | null> {
  const groupIds = await memberships.listGroupIdsForSelf(ctx.db, userId);

  for (const groupId of groupIds) {
    const group = await groups.findGroupById(ctx.db, groupId);
    if (!group) continue;

    const week = currentWeek(ctx, group.timezone);
    const scope = { groupId, weekStartDate: week };

    const response = await weeklyResponses.getResponseForSelf(ctx.db, userId, scope);
    if (!response || response.status !== 'submitted') continue;

    const slots = await availability.listSlotsForSelf(ctx.db, userId, scope);
    const vibes = await vibesRepo.listVibesForSelf(ctx.db, userId, scope);

    if (options.saveSlots !== false) {
      await saveDefaults(ctx, userId, {
        slots,
        capacity: isCapacity(response.sessionsCommitted) ? response.sessionsCommitted : undefined,
        vibes,
      });
    }

    const defaults = await userDefaults.getDefaultsForSelf(ctx.db, userId);

    return {
      userId,
      groupName: group.name,
      weekStartDate: week,
      capacity: (isCapacity(response.sessionsCommitted)
        ? response.sessionsCommitted
        : 1) as Capacity,
      slotCount: slots.length,
      dayCount: new Set(slots.map((slot) => slot.dayOfWeek)).size,
      vibes,
      autoApply: defaults.autoApply,
    };
  }

  return null;
}
