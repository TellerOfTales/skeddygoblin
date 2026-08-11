import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, withRollback } from '../helpers/db.js';
import { makeGroup, makeMember } from '../helpers/fixtures.js';
import * as drafts from '../../src/db/repositories/drafts.js';
import * as draftService from '../../src/services/draftService.js';
import { currentWeek, startOrResumeFlow } from '../../src/services/responseService.js';
import type { AppContext } from '../../src/services/context.js';
import type { DraftRecord, GroupRecord } from '../../src/db/repositories/types.js';

afterAll(closeTestPool);

async function seedDraft(
  ctx: AppContext,
): Promise<{ draft: DraftRecord; group: GroupRecord; userId: number }> {
  const group = await makeGroup(ctx);
  const user = await makeMember(ctx, group);
  const week = currentWeek(ctx, group.timezone);
  const { draft } = await startOrResumeFlow(ctx, {
    userId: user.id,
    groupId: group.id,
    weekStartDate: week,
  });
  return { draft, group, userId: user.id };
}

describe('day selection', () => {
  it('stores days sorted and deduplicated', async () => {
    await withRollback(async (ctx) => {
      const { draft } = await seedDraft(ctx);
      const updated = await draftService.setDays(ctx, draft, [4, 0, 4, 2]);
      expect(draftService.selectedDays(updated.state)).toEqual([0, 2, 4]);
    });
  });

  it('drops windows for days that were deselected', async () => {
    await withRollback(async (ctx) => {
      const { draft } = await seedDraft(ctx);

      let updated = await draftService.setDays(ctx, draft, [0, 1]);
      updated = await draftService.setWindowsForDay(ctx, updated, 0, ['evening']);
      updated = await draftService.setWindowsForDay(ctx, updated, 1, ['night']);

      // Deselect Tuesday.
      updated = await draftService.setDays(ctx, updated, [0]);

      expect(draftService.windowsForDay(updated.state, 0)).toEqual(['evening']);
      expect(draftService.windowsForDay(updated.state, 1)).toEqual([]);

      // ...and reselecting it must not resurrect the old answer.
      updated = await draftService.setDays(ctx, updated, [0, 1]);
      expect(draftService.windowsForDay(updated.state, 1)).toEqual([]);
    });
  });
});

describe('window selection', () => {
  it('replaces a day’s windows wholesale', async () => {
    await withRollback(async (ctx) => {
      const { draft } = await seedDraft(ctx);
      let updated = await draftService.setDays(ctx, draft, [2]);

      updated = await draftService.setWindowsForDay(ctx, updated, 2, ['evening', 'night']);
      expect(draftService.windowsForDay(updated.state, 2)).toEqual(['evening', 'night']);

      updated = await draftService.setWindowsForDay(ctx, updated, 2, ['lunch']);
      expect(draftService.windowsForDay(updated.state, 2)).toEqual(['lunch']);
    });
  });

  it('clearing a day removes it from the count but keeps the day selected', async () => {
    await withRollback(async (ctx) => {
      const { draft } = await seedDraft(ctx);
      let updated = await draftService.setDays(ctx, draft, [2, 3]);
      updated = await draftService.setWindowsForDay(ctx, updated, 2, ['evening']);
      updated = await draftService.setWindowsForDay(ctx, updated, 2, []);

      expect(draftService.selectedDays(updated.state)).toEqual([2, 3]);
      expect(draftService.totalSlotCount(updated.state)).toBe(0);
    });
  });

  it('ignores values that are not real windows', async () => {
    await withRollback(async (ctx) => {
      const { draft } = await seedDraft(ctx);
      let updated = await draftService.setDays(ctx, draft, [1]);
      updated = await draftService.setWindowsForDay(ctx, updated, 1, [
        'evening',
        'brunch' as never,
      ]);
      expect(draftService.windowsForDay(updated.state, 1)).toEqual(['evening']);
    });
  });
});

/**
 * The two-minute rule in practice. "I'm free evenings, always" is the most
 * common shape of answer, and this is what turns it from seven interactions
 * into one.
 */
describe('copy to all days', () => {
  it('applies one day’s windows across every selected day, including other pages', async () => {
    await withRollback(async (ctx) => {
      const { draft } = await seedDraft(ctx);
      let updated = await draftService.setDays(ctx, draft, [0, 1, 2, 3, 4, 5, 6]);
      updated = await draftService.setWindowsForDay(ctx, updated, 0, ['evening', 'night']);

      updated = await draftService.copyWindowsToAllDays(ctx, updated, 0);

      for (const day of [0, 1, 2, 3, 4, 5, 6] as const) {
        expect(draftService.windowsForDay(updated.state, day)).toEqual(['evening', 'night']);
      }
      // Seven days x two windows.
      expect(draftService.totalSlotCount(updated.state)).toBe(14);
      // And day 6 lives on page 2, proving the copy crosses pages.
      expect(draftService.pageForDay(updated.state, 6)).toBe(1);
    });
  });

  it('copying an empty day clears everything rather than half-applying', async () => {
    await withRollback(async (ctx) => {
      const { draft } = await seedDraft(ctx);
      let updated = await draftService.setDays(ctx, draft, [0, 1]);
      updated = await draftService.setWindowsForDay(ctx, updated, 1, ['lunch']);

      updated = await draftService.copyWindowsToAllDays(ctx, updated, 0);

      expect(draftService.totalSlotCount(updated.state)).toBe(0);
    });
  });
});

describe('pagination', () => {
  it('splits seven days into two pages of 4 and 3', async () => {
    await withRollback(async (ctx) => {
      const { draft } = await seedDraft(ctx);
      const updated = await draftService.setDays(ctx, draft, [0, 1, 2, 3, 4, 5, 6]);

      expect(draftService.pageCount(updated.state)).toBe(2);
      expect(draftService.daysOnPage(updated.state, 0)).toEqual([0, 1, 2, 3]);
      expect(draftService.daysOnPage(updated.state, 1)).toEqual([4, 5, 6]);
    });
  });

  it('clamps pages that are out of range', async () => {
    await withRollback(async (ctx) => {
      const { draft } = await seedDraft(ctx);
      const updated = await draftService.setDays(ctx, draft, [0, 1]);
      expect(draftService.clampPage(updated.state, 99)).toBe(0);
      expect(draftService.clampPage(updated.state, -5)).toBe(0);
    });
  });
});

describe('draft ownership', () => {
  it('refuses to load someone else’s draft, even with a valid id', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const owner = await makeMember(ctx, group);
      const intruder = await makeMember(ctx, group);
      const week = currentWeek(ctx, group.timezone);

      const { draft } = await startOrResumeFlow(ctx, {
        userId: owner.id,
        groupId: group.id,
        weekStartDate: week,
      });

      await expect(draftService.loadOwnedDraft(ctx, draft.id, intruder.id)).rejects.toMatchObject({
        code: 'DRAFT_NOT_OWNED',
      });

      await expect(
        draftService.loadDraftContext(ctx, draft.id, intruder.discordId),
      ).rejects.toMatchObject({ code: 'DRAFT_NOT_OWNED' });
    });
  });

  it('reports a missing draft distinctly, so the copy can offer a restart', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const user = await makeMember(ctx, group);
      await expect(draftService.loadOwnedDraft(ctx, 999_999_999, user.id)).rejects.toMatchObject({
        code: 'DRAFT_NOT_FOUND',
      });
    });
  });
});

/**
 * S2. A deploy mid-flow must not cost anyone their answers. Nothing is held in
 * this process, so "restart" is simply a fresh context reading the same rows.
 */
describe('surviving a restart', () => {
  it('resumes from stored state with a brand-new context', async () => {
    await withRollback(async (ctx) => {
      const { draft, group, userId } = await seedDraft(ctx);

      let updated = await draftService.setDays(ctx, draft, [0, 3]);
      updated = await draftService.setWindowsForDay(ctx, updated, 3, ['evening']);

      // Simulate a restart: a new context object over the same connection,
      // holding none of the previous state.
      const restarted: AppContext = {
        db: ctx.db,
        logger: ctx.logger,
        clock: ctx.clock,
        notifier: ctx.notifier,
      };

      const resumed = await draftService.loadDraftContext(
        restarted,
        updated.id,
        (
          await ctx.db.query<{ discord_id: string }>(
            'SELECT discord_id FROM app_user WHERE id = $1',
            [userId],
          )
        ).rows[0]!.discord_id,
      );

      expect(resumed.draft.state.days).toEqual([0, 3]);
      expect(draftService.windowsForDay(resumed.draft.state, 3)).toEqual(['evening']);
      expect(resumed.group.id).toBe(group.id);

      // And re-running /availability lands on the same draft rather than a new one.
      const again = await startOrResumeFlow(ctx, {
        userId,
        groupId: group.id,
        weekStartDate: draft.weekStartDate,
      });
      expect(again.draft.id).toBe(draft.id);
      expect(again.draft.state.days).toEqual([0, 3]);
    });
  });

  it('keeps the week captured at flow start, so a rollover mid-flow is consistent', async () => {
    await withRollback(async (ctx) => {
      const { draft, group, userId } = await seedDraft(ctx);
      const startedWeek = draft.weekStartDate;

      // The member wanders off; the clock rolls into the next week.
      ctx.clock.advanceDays(7);

      const stored = await drafts.findDraftById(ctx.db, draft.id);
      expect(stored?.weekStartDate).toBe(startedWeek);
      expect(currentWeek(ctx, group.timezone)).not.toBe(startedWeek);

      // Re-entering the flow now opens a draft for the NEW week, leaving the
      // old one untouched rather than retroactively rewriting it.
      const fresh = await startOrResumeFlow(ctx, {
        userId,
        groupId: group.id,
        weekStartDate: currentWeek(ctx, group.timezone),
      });
      expect(fresh.draft.id).not.toBe(draft.id);
    });
  });
});

/**
 * The single prompt puts days and times on separate selects, so availability is
 * their cross product - "Mon/Wed/Fri" plus "evenings" is evenings on all three.
 * Per-day precision stays reachable, and once used it must win outright.
 */
describe('cross-product windows and the per-day override', () => {
  it('applies the shared windows to every chosen day', async () => {
    await withRollback(async (ctx) => {
      const { draft } = await seedDraft(ctx);

      let state = await draftService.setDays(ctx, draft, [0, 2, 4]);
      state = await draftService.setSimpleWindows(ctx, state, ['evening', 'night']);

      expect(draftService.toSlotRows(state.state)).toHaveLength(6);
      expect(draftService.windowsForDay(state.state, 2)).toEqual(['evening', 'night']);
      // A day nobody picked stays empty rather than inheriting the windows.
      expect(draftService.windowsForDay(state.state, 5)).toEqual([]);
    });
  });

  it('seeds the per-day picker from the cross product, losing nothing', async () => {
    await withRollback(async (ctx) => {
      const { draft } = await seedDraft(ctx);

      let state = await draftService.setDays(ctx, draft, [0, 2]);
      state = await draftService.setSimpleWindows(ctx, state, ['evening']);
      state = await draftService.seedPerDayWindows(ctx, state);

      // They are editing what they already said, not starting over.
      expect(draftService.explicitWindowsForDay(state.state, 0)).toEqual(['evening']);
      expect(draftService.explicitWindowsForDay(state.state, 2)).toEqual(['evening']);
      expect(draftService.hasPerDayWindows(state.state)).toBe(true);
    });
  });

  it('lets per-day windows win, and keeps them when the shared select changes', async () => {
    await withRollback(async (ctx) => {
      const { draft } = await seedDraft(ctx);

      let state = await draftService.setDays(ctx, draft, [0, 2]);
      state = await draftService.setSimpleWindows(ctx, state, ['evening']);
      state = await draftService.seedPerDayWindows(ctx, state);
      state = await draftService.setWindowsForDay(ctx, state, 2, ['afternoon']);

      // Deliberate per-day work.
      expect(draftService.windowsForDay(state.state, 0)).toEqual(['evening']);
      expect(draftService.windowsForDay(state.state, 2)).toEqual(['afternoon']);

      // The shared select is disabled in the UI, but the service is the
      // authority: even if a stale message sends one, per-day still wins.
      state = await draftService.setSimpleWindows(ctx, state, ['morning']);
      expect(draftService.windowsForDay(state.state, 2)).toEqual(['afternoon']);
      expect(draftService.toSlotRows(state.state)).toEqual([
        { dayOfWeek: 0, window: 'evening' },
        { dayOfWeek: 2, window: 'afternoon' },
      ]);
    });
  });
});
