/**
 * B1-B6: the buzz rules.
 *
 * Every one of these calls the SERVICE directly, bypassing the button
 * entirely. That is the point of the brief's rule: the disabled button in the
 * roster is a courtesy, and the guarantee has to hold for any client that ever
 * calls this - a web app, a console client, a script.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, withCommitted, withRollback } from '../helpers/db.js';
import { makeGroup, makeGroupWithMembers, makeMember, makeUser } from '../helpers/fixtures.js';
import { buzz, expireStalePendingBuzzes } from '../../src/services/buzzService.js';
import { currentWeek, optOut, submit } from '../../src/services/responseService.js';
import { buildRoster } from '../../src/services/rosterService.js';
import * as groups from '../../src/db/repositories/groups.js';
import * as memberships from '../../src/db/repositories/memberships.js';
import * as users from '../../src/db/repositories/users.js';
import { createDb } from '../../src/db/pool.js';
import { RecordingNotifier } from '../../src/notify/RecordingNotifier.js';

afterAll(closeTestPool);

/** B1. The brief's hard rule. */
describe('B1: a responder can never be buzzed', () => {
  it('refuses when the target has submitted, and sends nothing', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 2);
      const [actor, target] = members;
      const week = currentWeek(ctx, group.timezone);

      await submit(ctx, {
        userId: target!.id,
        groupId: group.id,
        weekStartDate: week,
        sessionsCommitted: 2,
        slots: [{ dayOfWeek: 0, window: 'evening' }],
        vibes: [],
      });
      ctx.notifier.reset();

      await expect(
        buzz(ctx, {
          actorUserId: actor!.id,
          targetUserId: target!.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ).rejects.toMatchObject({ code: 'ALREADY_RESPONDED' });

      expect(ctx.notifier.sent).toHaveLength(0);
    });
  });
});

/** B2. Opting out is answering. The escape hatch must actually close the door. */
describe('B2: opting out counts as responding', () => {
  it('refuses to buzz someone who opted out', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 2);
      const [actor, target] = members;
      const week = currentWeek(ctx, group.timezone);

      await optOut(ctx, { userId: target!.id, groupId: group.id, weekStartDate: week });

      await expect(
        buzz(ctx, {
          actorUserId: actor!.id,
          targetUserId: target!.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ).rejects.toMatchObject({ code: 'ALREADY_RESPONDED' });
      expect(ctx.notifier.sent).toHaveLength(0);
    });
  });

  it('DOES allow buzzing someone with an unfinished draft', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 2);
      const [actor, target] = members;
      const week = currentWeek(ctx, group.timezone);

      // Starting the questionnaire must not confer immunity - otherwise opening
      // the DM and wandering off would be a way to never be nudged again.
      const { startOrResumeFlow } = await import('../../src/services/responseService.js');
      await startOrResumeFlow(ctx, {
        userId: target!.id,
        groupId: group.id,
        weekStartDate: week,
      });

      await expect(
        buzz(ctx, {
          actorUserId: actor!.id,
          targetUserId: target!.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ).resolves.toMatchObject({ targetUserId: target!.id });
      expect(ctx.notifier.countOfType('buzz')).toBe(1);
    });
  });
});

/** B3. One buzz per person per day. */
describe('B3: daily rate limit', () => {
  it('refuses a second buzz the same day, from anyone', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 3);
      const [first, second, target] = members;
      const week = currentWeek(ctx, group.timezone);

      await buzz(ctx, {
        actorUserId: first!.id,
        targetUserId: target!.id,
        groupId: group.id,
        weekStartDate: week,
      });

      // A DIFFERENT person, same day. The rule protects the recipient, so it is
      // per target across all senders rather than per sender.
      await expect(
        buzz(ctx, {
          actorUserId: second!.id,
          targetUserId: target!.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' });

      expect(ctx.notifier.countOfType('buzz')).toBe(1);
    });
  });

  it('allows another buzz the next day', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 2);
      const [actor, target] = members;
      const week = currentWeek(ctx, group.timezone);

      await buzz(ctx, {
        actorUserId: actor!.id,
        targetUserId: target!.id,
        groupId: group.id,
        weekStartDate: week,
      });

      ctx.clock.advanceDays(1);

      await expect(
        buzz(ctx, {
          actorUserId: actor!.id,
          targetUserId: target!.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ).resolves.toBeDefined();
      expect(ctx.notifier.countOfType('buzz')).toBe(2);
    });
  });

  it('uses the group timezone to decide what "today" is', async () => {
    await withRollback(async (ctx) => {
      const group = await groups.updateGroupSettings(ctx.db, (await makeGroup(ctx)).id, {
        timezone: 'Pacific/Kiritimati', // UTC+14
      });
      const actor = await makeMember(ctx, group);
      const target = await makeMember(ctx, group);
      const week = currentWeek(ctx, group.timezone);

      // 2026-08-12T11:00Z is already the 13th in Kiritimati.
      ctx.clock.set('2026-08-12T11:00:00Z');
      await buzz(ctx, {
        actorUserId: actor.id,
        targetUserId: target.id,
        groupId: group.id,
        weekStartDate: week,
      });

      // Still the 13th there, six hours later - so still rate limited.
      ctx.clock.set('2026-08-12T17:00:00Z');
      await expect(
        buzz(ctx, {
          actorUserId: actor.id,
          targetUserId: target.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    });
  });
});

/**
 * B4. The race the unique index exists for.
 *
 * This needs genuinely concurrent transactions on separate connections, so it
 * cannot use the shared-client rollback harness.
 */
describe('B4: two simultaneous buzzes send exactly one DM', () => {
  it('resolves concurrent presses to one winner', async () => {
    await withCommitted(async (ctx, guildId) => {
      const group = await groups.ensureGroup(ctx.db, guildId, {
        name: 'Race Test',
        timezone: 'UTC',
      });
      const actorA = await users.ensureUser(ctx.db, `${guildId}-a`, { timezone: 'UTC' });
      const actorB = await users.ensureUser(ctx.db, `${guildId}-b`, { timezone: 'UTC' });
      const target = await users.ensureUser(ctx.db, `${guildId}-t`, { timezone: 'UTC' });
      for (const user of [actorA, actorB, target]) {
        await memberships.ensureMembership(ctx.db, user.id, group.id);
      }
      const week = currentWeek(ctx, group.timezone);

      // Separate notifiers and contexts, so both attempts are truly parallel.
      const notifierA = new RecordingNotifier();
      const notifierB = new RecordingNotifier();
      const { testPool } = await import('../helpers/db.js');
      const ctxA = { ...ctx, db: createDb(testPool()), notifier: notifierA };
      const ctxB = { ...ctx, db: createDb(testPool()), notifier: notifierB };

      const results = await Promise.allSettled([
        buzz(ctxA, {
          actorUserId: actorA.id,
          targetUserId: target.id,
          groupId: group.id,
          weekStartDate: week,
        }),
        buzz(ctxB, {
          actorUserId: actorB.id,
          targetUserId: target.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'RATE_LIMITED',
      });

      // Exactly one DM in total, across both attempts.
      expect(notifierA.countOfType('buzz') + notifierB.countOfType('buzz')).toBe(1);
    });
  });
});

/** B5. Basic eligibility. */
describe('B5: self and non-member buzzes', () => {
  it('refuses a self-buzz', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 1);
      const week = currentWeek(ctx, group.timezone);

      await expect(
        buzz(ctx, {
          actorUserId: members[0]!.id,
          targetUserId: members[0]!.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ).rejects.toMatchObject({ code: 'SELF_BUZZ' });
    });
  });

  it('refuses when the presser is not a member', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 1);
      // A stale roster message in a guild the actor has left must stop working.
      const outsider = await makeUser(ctx);
      const week = currentWeek(ctx, group.timezone);

      await expect(
        buzz(ctx, {
          actorUserId: outsider.id,
          targetUserId: members[0]!.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ).rejects.toMatchObject({ code: 'ACTOR_NOT_MEMBER' });
    });
  });

  it('refuses when the target is not a member', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 1);
      const outsider = await makeUser(ctx);
      const week = currentWeek(ctx, group.timezone);

      await expect(
        buzz(ctx, {
          actorUserId: members[0]!.id,
          targetUserId: outsider.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ).rejects.toMatchObject({ code: 'TARGET_NOT_MEMBER' });
    });
  });
});

/** B6. A failed delivery must not cost the target their one buzz. */
describe('B6: delivery failure releases the quota', () => {
  it('lets the target be buzzed again after a closed DM', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 2);
      const [actor, target] = members;
      const week = currentWeek(ctx, group.timezone);

      ctx.notifier.failWith = 'dm_closed';
      await expect(
        buzz(ctx, {
          actorUserId: actor!.id,
          targetUserId: target!.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ).rejects.toMatchObject({ code: 'DELIVERY_FAILED' });

      // Their DMs reopen. The quota was never really spent.
      ctx.notifier.failWith = undefined;
      await expect(
        buzz(ctx, {
          actorUserId: actor!.id,
          targetUserId: target!.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ).resolves.toBeDefined();
      expect(ctx.notifier.countOfType('buzz')).toBe(1);
    });
  });

  it('sweeps buzzes orphaned between commit and delivery', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 2);
      const [actor, target] = members;
      const week = currentWeek(ctx, group.timezone);

      await buzz(ctx, {
        actorUserId: actor!.id,
        targetUserId: target!.id,
        groupId: group.id,
        weekStartDate: week,
      });

      // Simulate a process that died before marking the row sent.
      await ctx.db.query(
        `UPDATE buzz_log SET status = 'pending', created_at = now() - interval '1 hour'`,
      );

      expect(await expireStalePendingBuzzes(ctx)).toBe(1);

      // Choosing duplicate-risk over silent-loss: the target is buzzable again.
      await expect(
        buzz(ctx, {
          actorUserId: actor!.id,
          targetUserId: target!.id,
          groupId: group.id,
          weekStartDate: week,
        }),
      ).resolves.toBeDefined();
    });
  });
});

describe('buzz content', () => {
  it('does not name who pressed the button', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 2);
      const [actor, target] = members;

      await buzz(ctx, {
        actorUserId: actor!.id,
        targetUserId: target!.id,
        groupId: group.id,
        weekStartDate: currentWeek(ctx, group.timezone),
      });

      const sent = ctx.notifier.sent[0]!;
      const serialized = JSON.stringify(sent.payload);
      // A nudge, not "Alex is waiting on you" - the roster is public, but
      // turning it into personal pressure is not the point.
      expect(serialized).not.toContain(actor!.discordId);
      expect(serialized).not.toMatch(new RegExp(`\\b${actor!.id}\\b`));
    });
  });

  it('offers both escape hatches so a buzz can be answered in one tap', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 2);

      await buzz(ctx, {
        actorUserId: members[0]!.id,
        targetUserId: members[1]!.id,
        groupId: group.id,
        weekStartDate: currentWeek(ctx, group.timezone),
      });

      const kinds = ctx.notifier.sent[0]!.payload.actions?.map((action) => action.action.kind);
      expect(kinds).toEqual(['start_weekly_flow', 'opt_out_week']);
    });
  });
});

describe('roster reflects buzz state', () => {
  it('marks a buzzed member so the button greys out', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 2);
      const [actor, target] = members;
      const week = currentWeek(ctx, group.timezone);

      await buzz(ctx, {
        actorUserId: actor!.id,
        targetUserId: target!.id,
        groupId: group.id,
        weekStartDate: week,
      });

      const roster = await buildRoster(ctx, { group, weekStartDate: week });
      const targetRow = roster.rows.find((row) => row.userId === target!.id);

      expect(targetRow?.buzzedToday).toBe(true);
      expect(targetRow?.hasResponded).toBe(false);
    });
  });
});
