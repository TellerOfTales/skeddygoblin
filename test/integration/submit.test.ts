import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, withRollback } from '../helpers/db.js';
import { makeGroup, makeMember } from '../helpers/fixtures.js';
import * as availability from '../../src/db/repositories/availability.js';
import * as vibesRepo from '../../src/db/repositories/vibes.js';
import * as drafts from '../../src/db/repositories/drafts.js';
import * as draftService from '../../src/services/draftService.js';
import { MAX_VIBE_SELECTIONS } from '../../src/domain/constants.js';
import {
  currentWeek,
  getOwnSubmission,
  startOrResumeFlow,
  submit,
} from '../../src/services/responseService.js';
import * as weeklyResponses from '../../src/db/repositories/weeklyResponses.js';
import type { AppContext } from '../../src/services/context.js';
import type { GroupRecord, UserRecord } from '../../src/db/repositories/types.js';

afterAll(closeTestPool);

async function seed(ctx: AppContext): Promise<{
  group: GroupRecord;
  user: UserRecord;
  week: string;
  draftId: number;
}> {
  const group = await makeGroup(ctx);
  const user = await makeMember(ctx, group);
  const week = currentWeek(ctx, group.timezone);
  const { draft } = await startOrResumeFlow(ctx, {
    userId: user.id,
    groupId: group.id,
    weekStartDate: week,
  });
  return { group, user, week, draftId: draft.id };
}

describe('submit', () => {
  it('writes response, slots and vibes together and consumes the draft', async () => {
    await withRollback(async (ctx) => {
      const { group, user, week, draftId } = await seed(ctx);

      const result = await submit(ctx, {
        userId: user.id,
        groupId: group.id,
        weekStartDate: week,
        sessionsCommitted: 2,
        slots: [
          { dayOfWeek: 0, window: 'evening' },
          { dayOfWeek: 2, window: 'night' },
        ],
        vibes: ['Casual', 'Co-op'],
        draftId,
      });

      expect(result.response.status).toBe('submitted');
      expect(result.response.sessionsCommitted).toBe(2);
      expect(result.slotsWritten).toBe(2);
      expect(result.vibesWritten).toBe(2);

      const stored = await getOwnSubmission(ctx, {
        userId: user.id,
        groupId: group.id,
        weekStartDate: week,
      });
      expect(stored.slots).toEqual([
        { dayOfWeek: 0, window: 'evening' },
        { dayOfWeek: 2, window: 'night' },
      ]);
      expect(stored.vibes).toEqual(['Casual', 'Co-op']);

      expect(await drafts.findDraftById(ctx.db, draftId)).toBeNull();
    });
  });

  it('replaces a previous answer wholesale rather than merging', async () => {
    await withRollback(async (ctx) => {
      const { group, user, week } = await seed(ctx);
      const scope = { groupId: group.id, weekStartDate: week };

      await submit(ctx, {
        userId: user.id,
        ...scope,
        sessionsCommitted: 4,
        slots: [
          { dayOfWeek: 0, window: 'morning' },
          { dayOfWeek: 1, window: 'lunch' },
        ],
        vibes: ['Action'],
      });

      await submit(ctx, {
        userId: user.id,
        ...scope,
        sessionsCommitted: 1,
        slots: [{ dayOfWeek: 5, window: 'late_night' }],
        vibes: ['Action'],
      });

      const stored = await getOwnSubmission(ctx, { userId: user.id, ...scope });
      expect(stored.response?.sessionsCommitted).toBe(1);
      expect(stored.slots).toEqual([{ dayOfWeek: 5, window: 'late_night' }]);
      expect(stored.vibes).toEqual(['Action']);
    });
  });

  it('converts a previous opt-out into a submission', async () => {
    await withRollback(async (ctx) => {
      const { group, user, week } = await seed(ctx);
      const scope = { groupId: group.id, weekStartDate: week };

      await weeklyResponses.optOut(ctx.db, user.id, scope);

      await submit(ctx, {
        userId: user.id,
        ...scope,
        sessionsCommitted: 3,
        slots: [{ dayOfWeek: 4, window: 'evening' }],
        vibes: [],
      });

      const stored = await getOwnSubmission(ctx, { userId: user.id, ...scope });
      expect(stored.response?.status).toBe('submitted');
      expect(stored.response?.sessionsCommitted).toBe(3);
    });
  });

  it('rejects an empty slot set rather than writing a hollow response', async () => {
    await withRollback(async (ctx) => {
      const { group, user, week } = await seed(ctx);

      await expect(
        submit(ctx, {
          userId: user.id,
          groupId: group.id,
          weekStartDate: week,
          sessionsCommitted: 2,
          slots: [],
          vibes: [],
        }),
      ).rejects.toMatchObject({ code: 'NO_DAYS_SELECTED' });

      expect(
        await weeklyResponses.hasResponded(ctx.db, {
          userId: user.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ).toBe(false);
    });
  });

  it('rejects a missing capacity', async () => {
    await withRollback(async (ctx) => {
      const { group, user, week } = await seed(ctx);
      await expect(
        submit(ctx, {
          userId: user.id,
          groupId: group.id,
          weekStartDate: week,
          sessionsCommitted: 0 as never,
          slots: [{ dayOfWeek: 1, window: 'evening' }],
          vibes: [],
        }),
      ).rejects.toMatchObject({ code: 'NO_CAPACITY_SELECTED' });
    });
  });
});

/**
 * S1. If any part of the submit fails, none of it may land. Slots and vibes
 * hang off weekly_response by a composite foreign key, so a partial write would
 * mean either orphaned rows or a response claiming availability it does not
 * have.
 */
describe('submit atomicity', () => {
  it('leaves zero rows in all three tables when the transaction fails', async () => {
    await withRollback(async (ctx) => {
      const { group, user, week } = await seed(ctx);
      const scope = { groupId: group.id, weekStartDate: week };

      // Inject a failure after the response and slots have been written, by
      // making the vibe insert violate its CHECK constraint.
      await expect(
        submit(ctx, {
          userId: user.id,
          ...scope,
          sessionsCommitted: 2,
          slots: [
            { dayOfWeek: 0, window: 'evening' },
            { dayOfWeek: 1, window: 'evening' },
          ],
          vibes: ['definitely_not_a_real_vibe' as never],
        }),
      ).rejects.toThrow();

      const stored = await getOwnSubmission(ctx, { userId: user.id, ...scope });
      expect(stored.response).toBeNull();
      expect(stored.slots).toEqual([]);
      expect(stored.vibes).toEqual([]);
      expect(await availability.countSlotsForGroup(ctx.db, scope)).toBe(0);
    });
  });

  it('does not consume the draft when the submit fails', async () => {
    await withRollback(async (ctx) => {
      const { group, user, week, draftId } = await seed(ctx);

      await expect(
        submit(ctx, {
          userId: user.id,
          groupId: group.id,
          weekStartDate: week,
          sessionsCommitted: 2,
          slots: [{ dayOfWeek: 0, window: 'evening' }],
          vibes: ['nope' as never],
          draftId,
        }),
      ).rejects.toThrow();

      // The member can retry from where they were.
      expect(await drafts.findDraftById(ctx.db, draftId)).not.toBeNull();
    });
  });
});

describe('draft to submission', () => {
  it('flattens draft state into exactly the slots that get written', async () => {
    await withRollback(async (ctx) => {
      const { group, user, week, draftId } = await seed(ctx);

      let draft = (await drafts.findDraftById(ctx.db, draftId))!;
      draft = await draftService.setDays(ctx, draft, [0, 1, 2]);
      draft = await draftService.setWindowsForDay(ctx, draft, 0, ['evening', 'night']);
      draft = await draftService.setWindowsForDay(ctx, draft, 2, ['lunch']);
      // Day 1 deliberately left empty - "leave a day empty to skip it".
      draft = await draftService.setCapacity(ctx, draft, 3);
      draft = await draftService.setVibes(ctx, draft, ['Casual']);

      const slots = draftService.toSlotRows(draft.state);
      expect(slots).toEqual([
        { dayOfWeek: 0, window: 'evening' },
        { dayOfWeek: 0, window: 'night' },
        { dayOfWeek: 2, window: 'lunch' },
      ]);

      await submit(ctx, {
        userId: user.id,
        groupId: group.id,
        weekStartDate: week,
        sessionsCommitted: draftService.chosenCapacity(draft.state)!,
        slots,
        vibes: draftService.chosenVibes(draft.state),
        draftId,
      });

      const stored = await getOwnSubmission(ctx, {
        userId: user.id,
        groupId: group.id,
        weekStartDate: week,
      });
      expect(stored.slots).toHaveLength(3);
      expect(stored.response?.sessionsCommitted).toBe(3);
    });
  });

  it('caps vibe picks at the curated maximum', async () => {
    await withRollback(async (ctx) => {
      const { draftId } = await seed(ctx);
      const draft = (await drafts.findDraftById(ctx.db, draftId))!;

      // Deduplicated first, then capped: "everything" carries the same
      // information as "nothing", which is why there is a cap at all.
      const updated = await draftService.setVibes(ctx, draft, [
        'Casual',
        'Action',
        'Action',
        'Online PvP',
        'Simulation',
        'Horror',
        'Puzzle',
        'Racing',
      ]);

      expect(draftService.chosenVibes(updated.state)).toHaveLength(MAX_VIBE_SELECTIONS);
    });
  });

  it('ignores vibe values that are not in the curated set', async () => {
    await withRollback(async (ctx) => {
      const { draftId } = await seed(ctx);
      const draft = (await drafts.findDraftById(ctx.db, draftId))!;

      const updated = await draftService.setVibes(ctx, draft, ['Casual', 'vibes' as never]);
      expect(draftService.chosenVibes(updated.state)).toEqual(['Casual']);
    });
  });
});

describe('vibe aggregation', () => {
  it('counts submitted members only, and returns no user ids', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const a = await makeMember(ctx, group);
      const b = await makeMember(ctx, group);
      const c = await makeMember(ctx, group);
      const week = currentWeek(ctx, group.timezone);
      const scope = { groupId: group.id, weekStartDate: week };

      for (const user of [a, b]) {
        await submit(ctx, {
          userId: user.id,
          ...scope,
          sessionsCommitted: 2,
          slots: [{ dayOfWeek: 0, window: 'evening' }],
          vibes: ['Casual'],
        });
      }
      // c opts out, so contributes nothing.
      await weeklyResponses.optOut(ctx.db, c.id, scope);

      const counts = await vibesRepo.countVibesAggregate(ctx.db, scope);

      expect(counts).toEqual([{ tag: 'Casual', count: 2 }]);
      expect(JSON.stringify(counts)).not.toContain(String(a.id));
    });
  });
});
