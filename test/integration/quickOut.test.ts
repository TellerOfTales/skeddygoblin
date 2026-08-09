/**
 * Step 2's round trip: Discord -> bot -> DB -> confirmation.
 *
 * These exercise the service layer directly, which is the point: the buttons
 * are one client, and the rules must hold for any caller.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, withRollback } from '../helpers/db.js';
import { makeGroup, makeGroupWithMembers, makeMember } from '../helpers/fixtures.js';
import * as drafts from '../../src/db/repositories/drafts.js';
import * as weeklyResponses from '../../src/db/repositories/weeklyResponses.js';
import {
  currentWeek,
  getOwnResponse,
  optOut,
  startOrResumeFlow,
} from '../../src/services/responseService.js';
import { sendWeeklyPrompt } from '../../src/services/weeklyFlowService.js';
import { resolveActor } from '../../src/services/membershipService.js';

afterAll(closeTestPool);

describe('opt out', () => {
  it('writes exactly one opted_out row with zero capacity', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const user = await makeMember(ctx, group);
      const week = currentWeek(ctx, group.timezone);

      const response = await optOut(ctx, {
        userId: user.id,
        groupId: group.id,
        weekStartDate: week,
      });

      expect(response.status).toBe('opted_out');
      expect(response.sessionsCommitted).toBe(0);
      expect(response.weekStartDate).toBe(week);

      const stored = await getOwnResponse(ctx, {
        userId: user.id,
        groupId: group.id,
        weekStartDate: week,
      });
      expect(stored?.id).toBe(response.id);
    });
  });

  it('is idempotent - tapping twice does not error or duplicate', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const user = await makeMember(ctx, group);
      const week = currentWeek(ctx, group.timezone);

      const first = await optOut(ctx, { userId: user.id, groupId: group.id, weekStartDate: week });
      const second = await optOut(ctx, { userId: user.id, groupId: group.id, weekStartDate: week });

      expect(second.id).toBe(first.id);

      const count = await ctx.db.query<{ count: number }>(
        'SELECT COUNT(*)::bigint AS count FROM weekly_response WHERE user_id = $1',
        [user.id],
      );
      expect(count.rows[0]?.count).toBe(1);
    });
  });

  it('discards an in-progress draft, so no half-answer survives', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const user = await makeMember(ctx, group);
      const week = currentWeek(ctx, group.timezone);

      await startOrResumeFlow(ctx, { userId: user.id, groupId: group.id, weekStartDate: week });
      expect(
        await drafts.findDraftForSelf(ctx.db, user.id, { groupId: group.id, weekStartDate: week }),
      ).not.toBeNull();

      await optOut(ctx, { userId: user.id, groupId: group.id, weekStartDate: week });

      expect(
        await drafts.findDraftForSelf(ctx.db, user.id, { groupId: group.id, weekStartDate: week }),
      ).toBeNull();
    });
  });

  it('counts as having responded, so the member becomes un-buzzable', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const user = await makeMember(ctx, group);
      const week = currentWeek(ctx, group.timezone);

      expect(
        await weeklyResponses.hasResponded(ctx.db, {
          userId: user.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ).toBe(false);

      await optOut(ctx, { userId: user.id, groupId: group.id, weekStartDate: week });

      expect(
        await weeklyResponses.hasResponded(ctx.db, {
          userId: user.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ).toBe(true);
    });
  });

  it('is scoped to one week - last week does not answer for this week', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const user = await makeMember(ctx, group);

      const thisWeek = currentWeek(ctx, group.timezone);
      await optOut(ctx, { userId: user.id, groupId: group.id, weekStartDate: thisWeek });

      ctx.clock.advanceDays(7);
      const nextWeek = currentWeek(ctx, group.timezone);
      expect(nextWeek).not.toBe(thisWeek);

      expect(
        await weeklyResponses.hasResponded(ctx.db, {
          userId: user.id,
          groupId: group.id,
          weekStartDate: nextWeek,
        }),
      ).toBe(false);
    });
  });
});

describe('starting the flow', () => {
  it('creates a draft but deliberately NO weekly_response row', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const user = await makeMember(ctx, group);
      const week = currentWeek(ctx, group.timezone);

      const { draft, existingResponse } = await startOrResumeFlow(ctx, {
        userId: user.id,
        groupId: group.id,
        weekStartDate: week,
      });

      expect(draft.id).toBeGreaterThan(0);
      expect(existingResponse).toBeNull();

      // The crucial part: an unfinished questionnaire must NOT make someone
      // un-buzzable, or the escape hatch inverts the buzz rule.
      expect(
        await weeklyResponses.hasResponded(ctx.db, {
          userId: user.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ).toBe(false);
    });
  });

  it('resumes rather than restarts when run again', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const user = await makeMember(ctx, group);
      const week = currentWeek(ctx, group.timezone);

      const first = await startOrResumeFlow(ctx, {
        userId: user.id,
        groupId: group.id,
        weekStartDate: week,
      });
      await drafts.saveDraftState(ctx.db, first.draft.id, { days: [0, 2], capacity: 2 });

      const second = await startOrResumeFlow(ctx, {
        userId: user.id,
        groupId: group.id,
        weekStartDate: week,
      });

      expect(second.draft.id).toBe(first.draft.id);
      expect(second.draft.state).toEqual({ days: [0, 2], capacity: 2 });
    });
  });
});

describe('weekly prompt delivery', () => {
  it('goes through notify() with both escape-hatch actions attached', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 1);
      const user = members[0]!;
      const week = currentWeek(ctx, group.timezone);

      const result = await sendWeeklyPrompt(ctx, { user, group, weekStartDate: week });

      expect(result.ok).toBe(true);
      expect(ctx.notifier.sent).toHaveLength(1);

      const sent = ctx.notifier.sent[0]!;
      expect(sent.type).toBe('weekly_prompt');
      expect(sent.user.id).toBe(user.id);

      const kinds = sent.payload.actions?.map((action) => action.action.kind);
      expect(kinds).toEqual(['start_weekly_flow', 'opt_out_week']);

      // No action may render red: the style union has no 'danger' member, and
      // this pins the escape hatch specifically.
      const optOutAction = sent.payload.actions?.find(
        (action) => action.action.kind === 'opt_out_week',
      );
      expect(optOutAction?.style).toBe('secondary');
    });
  });

  it('reports a closed DM as a structured failure rather than throwing', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 1);
      ctx.notifier.failWith = 'dm_closed';

      const result = await sendWeeklyPrompt(ctx, {
        user: members[0]!,
        group,
        weekStartDate: currentWeek(ctx, group.timezone),
      });

      expect(result).toEqual({ ok: false, reason: 'dm_closed' });
      expect(ctx.notifier.sent).toHaveLength(0);
    });
  });
});

describe('resolveActor', () => {
  it('creates user, group and membership on first contact and is idempotent', async () => {
    await withRollback(async (ctx) => {
      const params = {
        discordUserId: '111111111111111111',
        discordGuildId: '222222222222222222',
        guildName: 'The Basement',
      };

      const first = await resolveActor(ctx, params);
      const second = await resolveActor(ctx, params);

      expect(second.user.id).toBe(first.user.id);
      expect(second.group.id).toBe(first.group.id);
      expect(first.group.name).toBe('The Basement');
      expect(first.role).toBe('member');
    });
  });
});
