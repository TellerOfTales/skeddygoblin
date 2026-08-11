/**
 * Personal availability: filled in once, projected onto every server.
 *
 * The rule this file exists to protect: applying a template must NEVER replace
 * an answer someone actually gave. That failure would be silent and invisible
 * to the person it happened to.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, withRollback } from '../helpers/db.js';
import { makeGroup, makeMember } from '../helpers/fixtures.js';
import * as userDefaults from '../../src/db/repositories/userDefaults.js';
import * as weeklyResponses from '../../src/db/repositories/weeklyResponses.js';
import * as availability from '../../src/db/repositories/availability.js';
import * as memberships from '../../src/db/repositories/memberships.js';
import {
  applyToAllGroups,
  autoApplyForGroup,
  getDefaults,
  saveDefaults,
  setAutoApply,
} from '../../src/services/personalDefaultsService.js';
import { currentWeek, submit } from '../../src/services/responseService.js';
import { listMyGroups } from '../../src/services/membershipService.js';
import { runWeeklyPrompt } from '../../src/services/weeklyCycleService.js';

afterAll(closeTestPool);

const TEMPLATE = [
  { dayOfWeek: 2, window: 'evening' },
  { dayOfWeek: 4, window: 'evening' },
] as const;

describe('saving a template', () => {
  it('round-trips slots, capacity and vibes', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const user = await makeMember(ctx, group);

      await saveDefaults(ctx, user.id, {
        slots: [...TEMPLATE],
        capacity: 2,
        vibes: ['Co-op'],
      });

      const defaults = await getDefaults(ctx, user.id);
      expect(defaults.slots).toEqual([...TEMPLATE]);
      expect(defaults.capacity).toBe(2);
      expect(defaults.vibes).toEqual(['Co-op']);
      expect(defaults.autoApply).toBe(false);
    });
  });

  it('replaces wholesale, so the stored set matches what was on screen', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const user = await makeMember(ctx, group);

      await saveDefaults(ctx, user.id, { slots: [...TEMPLATE] });
      await saveDefaults(ctx, user.id, { slots: [{ dayOfWeek: 0, window: 'night' }] });

      const defaults = await getDefaults(ctx, user.id);
      expect(defaults.slots).toEqual([{ dayOfWeek: 0, window: 'night' }]);
    });
  });
});

describe('applying across servers', () => {
  it('writes a normal response in every group the member belongs to', async () => {
    await withRollback(async (ctx) => {
      const one = await makeGroup(ctx, { name: 'One' });
      const two = await makeGroup(ctx, { name: 'Two' });
      const user = await makeMember(ctx, one);
      await memberships.ensureMembership(ctx.db, user.id, two.id);

      await saveDefaults(ctx, user.id, { slots: [...TEMPLATE], capacity: 3 });
      const outcome = await applyToAllGroups(ctx, user.id);

      expect(outcome.applied.map((entry) => entry.groupName).sort()).toEqual(['One', 'Two']);

      // Ordinary rows: nothing downstream can tell a template was involved.
      for (const group of [one, two]) {
        const week = currentWeek(ctx, group.timezone);
        const response = await weeklyResponses.getResponseForSelf(ctx.db, user.id, {
          groupId: group.id,
          weekStartDate: week,
        });
        expect(response?.status).toBe('submitted');
        expect(response?.sessionsCommitted).toBe(3);

        const slots = await availability.listSlotsForSelf(ctx.db, user.id, {
          groupId: group.id,
          weekStartDate: week,
        });
        expect(slots).toHaveLength(2);
      }
    });
  });

  /** The rule the whole feature lives or dies on. */
  it('never overwrites an answer the member actually gave', async () => {
    await withRollback(async (ctx) => {
      const one = await makeGroup(ctx, { name: 'One' });
      const two = await makeGroup(ctx, { name: 'Two' });
      const user = await makeMember(ctx, one);
      await memberships.ensureMembership(ctx.db, user.id, two.id);

      // An explicit, deliberate answer in One.
      await submit(ctx, {
        userId: user.id,
        groupId: one.id,
        weekStartDate: currentWeek(ctx, one.timezone),
        sessionsCommitted: 1,
        slots: [{ dayOfWeek: 5, window: 'lunch' }],
        vibes: [],
      });

      await saveDefaults(ctx, user.id, { slots: [...TEMPLATE], capacity: 4 });
      const outcome = await applyToAllGroups(ctx, user.id);

      expect(outcome.alreadyAnswered).toEqual(['One']);
      expect(outcome.applied.map((entry) => entry.groupName)).toEqual(['Two']);

      // Untouched: still Friday lunch, still one session.
      const slots = await availability.listSlotsForSelf(ctx.db, user.id, {
        groupId: one.id,
        weekStartDate: currentWeek(ctx, one.timezone),
      });
      expect(slots).toEqual([{ dayOfWeek: 5, window: 'lunch' }]);
    });
  });

  it('refuses when there is no template to apply', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const user = await makeMember(ctx, group);
      await expect(applyToAllGroups(ctx, user.id)).rejects.toThrow();
    });
  });
});

describe('auto-apply', () => {
  it('answers only for members who asked to be answered for', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const optedIn = await makeMember(ctx, group);
      const optedOut = await makeMember(ctx, group);

      await saveDefaults(ctx, optedIn.id, { slots: [...TEMPLATE] });
      await setAutoApply(ctx, optedIn.id, true);
      // Has a template but never asked for it to be applied automatically.
      await saveDefaults(ctx, optedOut.id, { slots: [...TEMPLATE] });

      const answered = await autoApplyForGroup(ctx, {
        groupId: group.id,
        weekStartDate: currentWeek(ctx, group.timezone),
        candidateUserIds: [optedIn.id, optedOut.id],
      });

      expect(answered).toEqual([optedIn.id]);
    });
  });

  it('is skipped for anyone with auto-apply on but no template', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const user = await makeMember(ctx, group);
      await setAutoApply(ctx, user.id, true);

      expect(await userDefaults.listAutoApplyUserIds(ctx.db, [user.id])).toEqual([]);
    });
  });

  it('answers during the weekly prompt and then does not DM them', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const auto = await makeMember(ctx, group);
      const manual = await makeMember(ctx, group);

      await saveDefaults(ctx, auto.id, { slots: [...TEMPLATE], capacity: 2 });
      await setAutoApply(ctx, auto.id, true);

      const week = currentWeek(ctx, group.timezone);
      const outcome = await runWeeklyPrompt(ctx, group, week);

      // Only the member who still has to answer is asked.
      expect(outcome.prompted).toBe(1);
      expect(ctx.notifier.sent.map((notification) => notification.user.id)).toEqual([manual.id]);

      const response = await weeklyResponses.getResponseForSelf(ctx.db, auto.id, {
        groupId: group.id,
        weekStartDate: week,
      });
      expect(response?.status).toBe('submitted');
      expect(response?.sessionsCommitted).toBe(2);
    });
  });
});

describe('the DM entry point', () => {
  it('distinguishes an unknown account from a member of no servers', async () => {
    await withRollback(async (ctx) => {
      // Never seen: DM'd the bot without ever using it in a server. Telling
      // this person "you are in no servers" would imply they had been removed
      // from something.
      expect(await listMyGroups(ctx, '999999999999999999')).toBeNull();

      const group = await makeGroup(ctx);
      const user = await makeMember(ctx, group);
      const mine = await listMyGroups(ctx, user.discordId);
      expect(mine?.groups.map((entry) => entry.name)).toEqual([group.name]);
    });
  });

  it('lists every server the member belongs to, and only those', async () => {
    await withRollback(async (ctx) => {
      const mine1 = await makeGroup(ctx, { name: 'Mine One' });
      const mine2 = await makeGroup(ctx, { name: 'Mine Two' });
      const theirs = await makeGroup(ctx, { name: 'Not Mine' });

      const user = await makeMember(ctx, mine1);
      await memberships.ensureMembership(ctx.db, user.id, mine2.id);
      await makeMember(ctx, theirs);

      const mine = await listMyGroups(ctx, user.discordId);
      expect(mine?.groups.map((entry) => entry.name).sort()).toEqual(['Mine One', 'Mine Two']);
    });
  });
});
