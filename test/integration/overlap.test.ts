/**
 * O1-O3 and P4.
 *
 * The scoring formula exists in two places by necessity: as SQL (because the
 * aggregation has to happen in the database) and as a pure function (because
 * ranking and day-diversity belong in the domain). O1 is what stops those two
 * drifting - it generates randomised groups and asserts they agree exactly,
 * including ordering.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, withRollback } from '../helpers/db.js';
import { makeGroup, makeMember } from '../helpers/fixtures.js';
import * as overlapRepo from '../../src/db/repositories/overlap.js';
import * as sessions from '../../src/db/repositories/sessions.js';
import { compareSlots, scoreSlot, type SlotAggregate } from '../../src/domain/overlap.js';
import {
  DAYS,
  MIN_AGGREGATE_HEADCOUNT,
  WINDOWS,
  type Capacity,
  type Day,
  type Window,
} from '../../src/domain/constants.js';
import { currentWeek, submit } from '../../src/services/responseService.js';
import { buildOverlapReport } from '../../src/services/overlapService.js';
import * as weeklyResponses from '../../src/db/repositories/weeklyResponses.js';
import type { AppContext } from '../../src/services/context.js';
import type { SlotRow } from '../../src/db/repositories/types.js';

afterAll(closeTestPool);

// ---------------------------------------------------------------------------
// Reference implementation - the same formula, computed in plain TypeScript
// ---------------------------------------------------------------------------

interface Member {
  capacity: Capacity;
  slots: SlotRow[];
  optedOut: boolean;
  confirmedYes: number;
}

function referenceRanking(members: Member[], minHeadcount: number): SlotAggregate[] {
  const responders = members.filter((member) => !member.optedOut);
  const totalResponders = responders.length;

  const remaining = new Map<Member, number>();
  for (const member of responders) {
    remaining.set(member, Math.max(member.capacity - member.confirmedYes, 0));
  }

  const buckets = new Map<string, { day: Day; window: Window; caps: number[] }>();
  for (const member of responders) {
    const left = remaining.get(member)!;
    if (left <= 0) continue;
    for (const slot of member.slots) {
      const key = `${slot.dayOfWeek}:${slot.window}`;
      const bucket = buckets.get(key) ?? { day: slot.dayOfWeek, window: slot.window, caps: [] };
      bucket.caps.push(left);
      buckets.set(key, bucket);
    }
  }

  return [...buckets.values()]
    .filter((bucket) => bucket.caps.length >= minHeadcount)
    .map((bucket) => ({
      dayOfWeek: bucket.day,
      window: bucket.window,
      headcount: bucket.caps.length,
      score: scoreSlot(bucket.caps, totalResponders),
    }))
    .sort(compareSlots);
}

// ---------------------------------------------------------------------------
// Deterministic PRNG so a failure is reproducible from its seed
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

async function seedGroup(
  ctx: AppContext,
  members: Member[],
): Promise<{ groupId: number; week: string }> {
  const group = await makeGroup(ctx);
  const week = currentWeek(ctx, group.timezone);

  for (const member of members) {
    const user = await makeMember(ctx, group);
    const scope = { groupId: group.id, weekStartDate: week };

    if (member.optedOut) {
      await weeklyResponses.optOut(ctx.db, user.id, scope);
      continue;
    }

    await submit(ctx, {
      userId: user.id,
      ...scope,
      sessionsCommitted: member.capacity,
      slots: member.slots,
      vibes: [],
    });

    // Burn capacity by confirming sessions this member said yes to.
    for (let index = 0; index < member.confirmedYes; index++) {
      const day = (index % 7) as Day;
      const proposal = await sessions.createProposal(ctx.db, {
        groupId: group.id,
        weekStartDate: week,
        candidateDay: day,
        candidateWindow: 'morning',
        createdBy: user.id,
      });
      await sessions.setAttendance(ctx.db, proposal.id, user.id, 'yes');
      await sessions.setProposalStatus(ctx.db, proposal.id, 'confirmed');
    }
  }

  return { groupId: group.id, week };
}

describe('O1: SQL agrees with the pure reference', () => {
  it('matches on 60 randomised groups, including ordering', async () => {
    const rng = makeRng(20_260_809);

    for (let iteration = 0; iteration < 60; iteration++) {
      await withRollback(async (ctx) => {
        const memberCount = 2 + Math.floor(rng() * 11); // 2..12
        const members: Member[] = [];

        for (let index = 0; index < memberCount; index++) {
          const capacity = (1 + Math.floor(rng() * 4)) as Capacity;
          const optedOut = rng() < 0.15;
          // Occasionally confirm more sessions than capacity, to exercise the
          // GREATEST(.., 0) clamp on remaining capacity.
          const confirmedYes = rng() < 0.25 ? Math.floor(rng() * (capacity + 1)) : 0;

          const slots: SlotRow[] = [];
          for (const day of DAYS) {
            for (const window of WINDOWS) {
              if (rng() < 0.18) slots.push({ dayOfWeek: day, window });
            }
          }
          // A submitted member must have at least one slot.
          if (!optedOut && slots.length === 0) slots.push({ dayOfWeek: 0, window: 'evening' });

          members.push({ capacity, slots, optedOut, confirmedYes });
        }

        const { groupId, week } = await seedGroup(ctx, members);

        const actual = await overlapRepo.rankWindowAggregate(ctx.db, {
          groupId,
          weekStartDate: week,
          minHeadcount: MIN_AGGREGATE_HEADCOUNT,
          limit: 100,
        });
        const expected = referenceRanking(members, MIN_AGGREGATE_HEADCOUNT).slice(0, 100);

        const shape = (rows: SlotAggregate[]) =>
          rows.map((row) => `${row.dayOfWeek}:${row.window}:${row.headcount}`);

        expect(shape(actual), `iteration ${iteration}`).toEqual(shape(expected));

        actual.forEach((row, index) => {
          expect(row.score).toBeCloseTo(expected[index]!.score, 6);
        });
      });
    }
  });
});

describe('O3: exclusions', () => {
  it('ignores opted-out members entirely', async () => {
    await withRollback(async (ctx) => {
      const { groupId, week } = await seedGroup(ctx, [
        {
          capacity: 2,
          slots: [{ dayOfWeek: 1, window: 'evening' }],
          optedOut: false,
          confirmedYes: 0,
        },
        {
          capacity: 2,
          slots: [{ dayOfWeek: 1, window: 'evening' }],
          optedOut: false,
          confirmedYes: 0,
        },
        { capacity: 4, slots: [], optedOut: true, confirmedYes: 0 },
      ]);

      const rows = await overlapRepo.rankWindowAggregate(ctx.db, {
        groupId,
        weekStartDate: week,
        minHeadcount: 1,
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]!.headcount).toBe(2);
    });
  });

  it('excludes members whose remaining capacity has been used up', async () => {
    await withRollback(async (ctx) => {
      const { groupId, week } = await seedGroup(ctx, [
        // capacity 1, already confirmed for 1 session -> remaining 0
        {
          capacity: 1,
          slots: [{ dayOfWeek: 3, window: 'night' }],
          optedOut: false,
          confirmedYes: 1,
        },
        {
          capacity: 3,
          slots: [{ dayOfWeek: 3, window: 'night' }],
          optedOut: false,
          confirmedYes: 0,
        },
      ]);

      const rows = await overlapRepo.rankWindowAggregate(ctx.db, {
        groupId,
        weekStartDate: week,
        minHeadcount: 1,
      });

      const thursdayNight = rows.find((row) => row.dayOfWeek === 3 && row.window === 'night');
      expect(thursdayNight?.headcount).toBe(1);
    });
  });

  it('scores headcount above capacity: three keen beats two keener', async () => {
    await withRollback(async (ctx) => {
      const three = { dayOfWeek: 2 as Day, window: 'lunch' as Window };
      const two = { dayOfWeek: 4 as Day, window: 'evening' as Window };

      const { groupId, week } = await seedGroup(ctx, [
        { capacity: 1, slots: [three], optedOut: false, confirmedYes: 0 },
        { capacity: 1, slots: [three], optedOut: false, confirmedYes: 0 },
        { capacity: 1, slots: [three], optedOut: false, confirmedYes: 0 },
        { capacity: 4, slots: [two], optedOut: false, confirmedYes: 0 },
        { capacity: 4, slots: [two], optedOut: false, confirmedYes: 0 },
      ]);

      const rows = await overlapRepo.rankWindowAggregate(ctx.db, {
        groupId,
        weekStartDate: week,
        minHeadcount: 2,
      });

      expect(rows[0]).toMatchObject({ dayOfWeek: 2, window: 'lunch', headcount: 3 });
    });
  });
});

/**
 * P4. A headcount of one says "exactly one person is free at this exact slot",
 * which in a small group is a raw availability disclosure with extra steps.
 */
describe('P4: k-anonymity floor', () => {
  it('never returns a window only one person can make', async () => {
    await withRollback(async (ctx) => {
      const { groupId, week } = await seedGroup(ctx, [
        {
          capacity: 2,
          slots: [
            { dayOfWeek: 0, window: 'evening' },
            { dayOfWeek: 6, window: 'late_night' }, // only this member
          ],
          optedOut: false,
          confirmedYes: 0,
        },
        {
          capacity: 2,
          slots: [{ dayOfWeek: 0, window: 'evening' }],
          optedOut: false,
          confirmedYes: 0,
        },
      ]);

      const report = await buildOverlapReport(ctx, { groupId, weekStartDate: week });

      expect(report.windows).toHaveLength(1);
      expect(report.windows[0]).toMatchObject({ dayOfWeek: 0, window: 'evening' });
      expect(
        report.windows.some((row) => row.dayOfWeek === 6),
        'a solo window must never reach the group',
      ).toBe(false);
    });
  });

  it('distinguishes "nobody overlaps" from "we will not say"', async () => {
    await withRollback(async (ctx) => {
      const { groupId, week } = await seedGroup(ctx, [
        {
          capacity: 2,
          slots: [{ dayOfWeek: 0, window: 'morning' }],
          optedOut: false,
          confirmedYes: 0,
        },
        {
          capacity: 2,
          slots: [{ dayOfWeek: 5, window: 'night' }],
          optedOut: false,
          confirmedYes: 0,
        },
      ]);

      const report = await buildOverlapReport(ctx, { groupId, weekStartDate: week });

      expect(report.windows).toEqual([]);
      expect(report.suppressedForPrivacy).toBe(true);
    });
  });

  it('exposes no user identity anywhere in the report', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const week = currentWeek(ctx, group.timezone);
      const members = [await makeMember(ctx, group), await makeMember(ctx, group)];

      for (const member of members) {
        await submit(ctx, {
          userId: member.id,
          groupId: group.id,
          weekStartDate: week,
          sessionsCommitted: 2,
          slots: [{ dayOfWeek: 1, window: 'evening' }],
          vibes: ['Casual'],
        });
      }

      const report = await buildOverlapReport(ctx, { groupId: group.id, weekStartDate: week });
      const serialized = JSON.stringify(report);

      for (const member of members) {
        expect(serialized).not.toContain(member.discordId);
        expect(serialized).not.toMatch(new RegExp(`\\b${member.id}\\b`));
      }
      for (const row of report.windows) {
        expect(Object.keys(row).sort()).toEqual(['dayOfWeek', 'headcount', 'score', 'window']);
      }
    });
  });
});
