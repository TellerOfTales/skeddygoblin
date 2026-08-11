import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, withRollback } from '../helpers/db.js';
import { makeGroup, makeGroupWithMembers, makeMember } from '../helpers/fixtures.js';
import { localDate } from '../../src/domain/week.js';
import * as drafts from '../../src/db/repositories/drafts.js';
import * as weeklyResponses from '../../src/db/repositories/weeklyResponses.js';
import * as availability from '../../src/db/repositories/availability.js';
import * as jobRuns from '../../src/db/repositories/jobRuns.js';
import * as groups from '../../src/db/repositories/groups.js';
import {
  claimCutoffPost,
  isCutoffDue,
  isPromptDue,
  runWeeklyPrompt,
  commitUnfinishedDrafts,
  isEveryoneAnswered,
  claimSteamSync,
} from '../../src/services/weeklyCycleService.js';
import { currentWeek, optOut, submit } from '../../src/services/responseService.js';
import {
  attendanceCounts,
  confirmSession,
  proposeSession,
  rsvp,
} from '../../src/services/sessionService.js';
import * as overlapRepo from '../../src/db/repositories/overlap.js';

afterAll(closeTestPool);

describe('scheduling predicates', () => {
  it('opens the week from Monday morning, group-local', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx, { timezone: 'Europe/London' });

      // Sunday night: not yet.
      expect(isPromptDue(group, new Date('2026-08-09T23:00:00Z'))).toBe(false);
      // Monday 09:00 London: still before the 10:00 prompt.
      expect(isPromptDue(group, new Date('2026-08-10T08:00:00Z'))).toBe(false);
      // Monday 10:00 London (09:00Z in BST).
      expect(isPromptDue(group, new Date('2026-08-10T09:00:00Z'))).toBe(true);
    });
  });

  it('reads the cutoff in the group timezone, not UTC', async () => {
    await withRollback(async (ctx) => {
      const group = await groups.updateGroupSettings(ctx.db, (await makeGroup(ctx)).id, {
        timezone: 'America/Los_Angeles',
        nudgeCutoffDay: 3, // Thursday
        nudgeCutoffTime: '20:00',
      });

      // Thursday 20:00 UTC is Thursday 13:00 in Los Angeles - not yet.
      expect(isCutoffDue(group, new Date('2026-08-13T20:00:00Z'))).toBe(false);
      // Friday 03:00 UTC is Thursday 20:00 in Los Angeles.
      expect(isCutoffDue(group, new Date('2026-08-14T03:00:00Z'))).toBe(true);
    });
  });
});

/**
 * The reason the scheduler is a tick over job_run rather than cron: a job must
 * run exactly once per group per week, even across restarts and overlapping
 * instances.
 */
describe('job claiming', () => {
  it('lets exactly one caller claim a job for a group and week', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const week = currentWeek(ctx, group.timezone);
      const params = { groupId: group.id, jobKind: 'weekly_prompt' as const, weekStartDate: week };

      expect(await jobRuns.claimJob(ctx.db, params)).toBe(true);
      expect(await jobRuns.claimJob(ctx.db, params)).toBe(false);
      expect(await jobRuns.claimJob(ctx.db, params)).toBe(false);
    });
  });

  it('claims again for the following week', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const thisWeek = currentWeek(ctx, group.timezone);
      ctx.clock.advanceDays(7);
      const nextWeek = currentWeek(ctx, group.timezone);

      expect(
        await jobRuns.claimJob(ctx.db, {
          groupId: group.id,
          jobKind: 'weekly_prompt',
          weekStartDate: thisWeek,
        }),
      ).toBe(true);
      expect(
        await jobRuns.claimJob(ctx.db, {
          groupId: group.id,
          jobKind: 'weekly_prompt',
          weekStartDate: nextWeek,
        }),
      ).toBe(true);
    });
  });
});

describe('weekly prompt job', () => {
  it('DMs only members who have not answered yet', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 4);
      const week = currentWeek(ctx, group.timezone);
      const scope = { groupId: group.id, weekStartDate: week };

      await submit(ctx, {
        userId: members[0]!.id,
        ...scope,
        sessionsCommitted: 2,
        slots: [{ dayOfWeek: 0, window: 'evening' }],
        vibes: [],
      });
      // Opting out counts as answering - no further nudges this week.
      await optOut(ctx, { userId: members[1]!.id, ...scope });

      const outcome = await runWeeklyPrompt(ctx, group, week);

      expect(outcome.ran).toBe(true);
      expect(outcome.prompted).toBe(2);

      const promptedIds = ctx.notifier.sent.map((notification) => notification.user.id);
      expect(promptedIds).toEqual([members[2]!.id, members[3]!.id]);
    });
  });

  it('does not run twice for the same week', async () => {
    await withRollback(async (ctx) => {
      const { group } = await makeGroupWithMembers(ctx, 3);
      const week = currentWeek(ctx, group.timezone);

      const first = await runWeeklyPrompt(ctx, group, week);
      const second = await runWeeklyPrompt(ctx, group, week);

      expect(first.ran).toBe(true);
      expect(first.prompted).toBe(3);
      expect(second).toEqual({ ran: false, prompted: 0, undeliverable: 0 });
      expect(ctx.notifier.sent).toHaveLength(3);
    });
  });

  it('counts undeliverable DMs separately from successes', async () => {
    await withRollback(async (ctx) => {
      const { group } = await makeGroupWithMembers(ctx, 2);
      ctx.notifier.failWith = 'dm_closed';

      const outcome = await runWeeklyPrompt(ctx, group, currentWeek(ctx, group.timezone));

      expect(outcome.prompted).toBe(0);
      expect(outcome.undeliverable).toBe(2);
    });
  });

  it('claims the cutoff post exactly once', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const week = currentWeek(ctx, group.timezone);

      expect(await claimCutoffPost(ctx, group, week)).toBe(true);
      expect(await claimCutoffPost(ctx, group, week)).toBe(false);
    });
  });
});

/**
 * The proposal loop exists in Stage 1 specifically so the overlap score's
 * remaining-capacity term is exercised rather than permanently zero.
 */
describe('session proposal loop', () => {
  it('runs propose -> rsvp -> confirm and notifies everyone who said yes', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 3);
      const week = currentWeek(ctx, group.timezone);

      const proposal = await proposeSession(ctx, {
        groupId: group.id,
        weekStartDate: week,
        day: 2,
        window: 'evening',
        createdBy: members[0]!.id,
      });

      await rsvp(ctx, { proposalId: proposal.id, userId: members[0]!.id, response: 'yes' });
      await rsvp(ctx, { proposalId: proposal.id, userId: members[1]!.id, response: 'yes' });
      await rsvp(ctx, { proposalId: proposal.id, userId: members[2]!.id, response: 'no' });

      expect(await attendanceCounts(ctx, proposal.id)).toEqual({ yes: 2, maybe: 0, no: 1 });

      ctx.notifier.reset();
      const { notified } = await confirmSession(ctx, { proposalId: proposal.id, group });

      expect(notified).toBe(2);
      expect(ctx.notifier.countOfType('session_confirmed')).toBe(2);
      // The member who said no is not told about a session they declined.
      expect(ctx.notifier.lastTo(members[2]!.id)).toBeUndefined();
    });
  });

  it('lets a member change their RSVP without duplicating it', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 2);
      const proposal = await proposeSession(ctx, {
        groupId: group.id,
        weekStartDate: currentWeek(ctx, group.timezone),
        day: 1,
        window: 'night',
        createdBy: members[0]!.id,
      });

      await rsvp(ctx, { proposalId: proposal.id, userId: members[0]!.id, response: 'yes' });
      await rsvp(ctx, { proposalId: proposal.id, userId: members[0]!.id, response: 'maybe' });

      expect(await attendanceCounts(ctx, proposal.id)).toEqual({ yes: 0, maybe: 1, no: 0 });
    });
  });

  it('refuses an RSVP once the session is settled', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 2);
      const proposal = await proposeSession(ctx, {
        groupId: group.id,
        weekStartDate: currentWeek(ctx, group.timezone),
        day: 1,
        window: 'night',
        createdBy: members[0]!.id,
      });
      await confirmSession(ctx, { proposalId: proposal.id, group });

      await expect(
        rsvp(ctx, { proposalId: proposal.id, userId: members[1]!.id, response: 'yes' }),
      ).rejects.toMatchObject({ code: 'PROPOSAL_CLOSED' });
    });
  });

  it('produces one session when the same window is locked in twice', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const organizer = await makeMember(ctx, group, { role: 'organizer' });
      const week = currentWeek(ctx, group.timezone);

      const first = await proposeSession(ctx, {
        groupId: group.id,
        weekStartDate: week,
        day: 4,
        window: 'evening',
        createdBy: organizer.id,
      });
      const second = await proposeSession(ctx, {
        groupId: group.id,
        weekStartDate: week,
        day: 4,
        window: 'evening',
        createdBy: organizer.id,
      });

      expect(second.id).toBe(first.id);
    });
  });

  /**
   * The loop closing back onto the scorer: confirming a session spends capacity,
   * which drops that member out of future overlap rankings.
   */
  it('spends remaining capacity, changing what the overlap query returns', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 2);
      const week = currentWeek(ctx, group.timezone);
      const scope = { groupId: group.id, weekStartDate: week };
      const slots = [
        { dayOfWeek: 2 as const, window: 'evening' as const },
        { dayOfWeek: 5 as const, window: 'night' as const },
      ];

      for (const member of members) {
        await submit(ctx, { userId: member.id, ...scope, sessionsCommitted: 1, slots, vibes: [] });
      }

      const before = await overlapRepo.rankWindowAggregate(ctx.db, { ...scope, minHeadcount: 1 });
      expect(before.every((row) => row.headcount === 2)).toBe(true);

      // Both members commit their single session to Wednesday evening.
      const proposal = await proposeSession(ctx, {
        ...scope,
        day: 2,
        window: 'evening',
        createdBy: members[0]!.id,
      });
      for (const member of members) {
        await rsvp(ctx, { proposalId: proposal.id, userId: member.id, response: 'yes' });
      }
      await confirmSession(ctx, { proposalId: proposal.id, group });

      // With no capacity left, neither member pulls the group anywhere.
      const after = await overlapRepo.rankWindowAggregate(ctx.db, { ...scope, minHeadcount: 1 });
      expect(after).toEqual([]);
    });
  });
});

/**
 * "If even one person runs /availability, everyone gets a DM — up to once a
 * week." The exactly-once half is what these cover; the enrolment half lives in
 * the Discord layer, which is the only thing that can see a guild member list.
 */
describe('one person asking pulls the whole group in', () => {
  it('does not double-DM the person who triggered it', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 3);
      const week = currentWeek(ctx, group.timezone);

      // The command already DM'd the actor directly before broadcasting.
      const outcome = await runWeeklyPrompt(ctx, group, week, {
        excludeUserId: members[0]!.id,
      });

      expect(outcome.prompted).toBe(2);
      const promptedIds = ctx.notifier.sent.map((notification) => notification.user.id);
      expect(promptedIds).not.toContain(members[0]!.id);
    });
  });

  it('sends once however many people run the command', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 4);
      const week = currentWeek(ctx, group.timezone);

      // Three different people run /availability in quick succession. The
      // job_run primary key is what makes the second and third no-ops.
      const outcomes = [
        await runWeeklyPrompt(ctx, group, week, { excludeUserId: members[0]!.id }),
        await runWeeklyPrompt(ctx, group, week, { excludeUserId: members[1]!.id }),
        await runWeeklyPrompt(ctx, group, week, { excludeUserId: members[2]!.id }),
      ];

      expect(outcomes.map((outcome) => outcome.ran)).toEqual([true, false, false]);
      expect(ctx.notifier.sent).toHaveLength(3);
    });
  });

  it('asks again the following week', async () => {
    await withRollback(async (ctx) => {
      const { group } = await makeGroupWithMembers(ctx, 2);
      const week = currentWeek(ctx, group.timezone);
      const nextWeek = new Date(`${week}T00:00:00Z`);
      nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);

      const first = await runWeeklyPrompt(ctx, group, week);
      const second = await runWeeklyPrompt(ctx, group, nextWeek.toISOString().slice(0, 10));

      // Once per week, not once ever.
      expect([first.ran, second.ran]).toEqual([true, true]);
    });
  });
});

/**
 * Forgetting to tap Submit used to erase the answers entirely: everything lived
 * in response_draft until the final button, so someone who picked their days
 * and wandered off was silent as far as the leaderboard was concerned.
 */
describe('unfinished drafts are banked at the cutoff', () => {
  it('turns a half-finished draft into a real response', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 2);
      const week = currentWeek(ctx, group.timezone);

      // Picked Wednesday evening, never reached capacity or vibes.
      const draft = await drafts.startOrResumeDraft(ctx.db, members[0]!.id, {
        groupId: group.id,
        weekStartDate: week,
      });
      await drafts.saveDraftState(ctx.db, draft.id, {
        days: [2],
        windows: { '2': ['evening'] },
      });

      const outcome = await commitUnfinishedDrafts(ctx, group, week);
      expect(outcome.committed).toBe(1);

      const responded = await weeklyResponses.listRespondedUserIds(ctx.db, {
        groupId: group.id,
        weekStartDate: week,
      });
      expect(responded).toContain(members[0]!.id);

      // ...and the slot counts towards overlap, which is the whole point.
      const slots = await availability.listSlotsForSelf(ctx.db, members[0]!.id, {
        groupId: group.id,
        weekStartDate: week,
      });
      expect(slots).toHaveLength(1);

      // The draft is consumed, so this cannot fire twice.
      expect(await drafts.findDraftById(ctx.db, draft.id)).toBeNull();
    });
  });

  it('ignores a draft with nothing in it', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 2);
      const week = currentWeek(ctx, group.timezone);

      // Opened the DM, closed it. That is not an answer and must not become one
      // - recording it would also make them silently un-buzzable.
      await drafts.startOrResumeDraft(ctx.db, members[0]!.id, {
        groupId: group.id,
        weekStartDate: week,
      });

      const outcome = await commitUnfinishedDrafts(ctx, group, week);
      expect(outcome).toEqual({ committed: 0, skipped: 1 });

      const responded = await weeklyResponses.listRespondedUserIds(ctx.db, {
        groupId: group.id,
        weekStartDate: week,
      });
      expect(responded).not.toContain(members[0]!.id);
    });
  });

  it('defaults capacity to one session when they never got that far', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 2);
      const week = currentWeek(ctx, group.timezone);

      const draft = await drafts.startOrResumeDraft(ctx.db, members[0]!.id, {
        groupId: group.id,
        weekStartDate: week,
      });
      await drafts.saveDraftState(ctx.db, draft.id, { windows: { '2': ['evening'] } });
      await commitUnfinishedDrafts(ctx, group, week);

      const response = await weeklyResponses.getResponseForSelf(ctx.db, members[0]!.id, {
        groupId: group.id,
        weekStartDate: week,
      });
      expect(response?.sessionsCommitted).toBe(1);
      expect(response?.status).toBe('submitted');
    });
  });
});

/**
 * The board posts publicly at the cutoff OR when the last person answers,
 * whichever comes first - and exactly once either way, because both triggers
 * share one job_run claim.
 */
describe('posting the weekly board early', () => {
  it('is complete once every member has answered', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 3);
      const week = currentWeek(ctx, group.timezone);
      const scope = { groupId: group.id, weekStartDate: week };

      expect(await isEveryoneAnswered(ctx, group, week)).toBe(false);

      await submit(ctx, {
        userId: members[0]!.id,
        ...scope,
        sessionsCommitted: 1,
        slots: [{ dayOfWeek: 2, window: 'evening' }],
        vibes: [],
      });
      await submit(ctx, {
        userId: members[1]!.id,
        ...scope,
        sessionsCommitted: 1,
        slots: [{ dayOfWeek: 2, window: 'evening' }],
        vibes: [],
      });
      expect(await isEveryoneAnswered(ctx, group, week)).toBe(false);

      // Opting out counts: it is an answer, and the group is no longer waiting.
      await optOut(ctx, { userId: members[2]!.id, ...scope });
      expect(await isEveryoneAnswered(ctx, group, week)).toBe(true);
    });
  });

  it('never treats a lone member as a complete group', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await makeGroupWithMembers(ctx, 1);
      const week = currentWeek(ctx, group.timezone);

      await submit(ctx, {
        userId: members[0]!.id,
        groupId: group.id,
        weekStartDate: week,
        sessionsCommitted: 1,
        slots: [{ dayOfWeek: 2, window: 'evening' }],
        vibes: [],
      });

      // Posting here would be useless and would publish the only respondent's
      // picks as the aggregate.
      expect(await isEveryoneAnswered(ctx, group, week)).toBe(false);
    });
  });

  it('lets only one trigger post: the cutoff and the last answer share a claim', async () => {
    await withRollback(async (ctx) => {
      const { group } = await makeGroupWithMembers(ctx, 2);
      const week = currentWeek(ctx, group.timezone);

      // Whoever claims first posts; the other becomes a silent no-op.
      expect(await claimCutoffPost(ctx, group, week)).toBe(true);
      expect(await claimCutoffPost(ctx, group, week)).toBe(false);
    });
  });
});

/**
 * Libraries go stale the moment someone buys something, so the re-sync is
 * daily. job_run's third column is a DATE, so the same primary-key lock means
 * "once today" simply by being handed a day instead of a week.
 */
describe('daily steam library re-sync', () => {
  it('runs once per day, not once per week', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx, { timezone: 'Europe/London' });
      const today = localDate(ctx.clock.now(), group.timezone);

      expect(await claimSteamSync(ctx, group, today)).toBe(true);
      // Same day: already done.
      expect(await claimSteamSync(ctx, group, today)).toBe(false);

      const tomorrow = new Date(`${today}T00:00:00Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      expect(await claimSteamSync(ctx, group, tomorrow.toISOString().slice(0, 10))).toBe(true);
    });
  });

  it("rolls over at the group's own midnight", async () => {
    await withRollback(async (ctx) => {
      // Kiritimati is UTC+14: its date is ahead of UTC's for most of the day,
      // which is exactly where a naive UTC-keyed "daily" would double-run.
      const group = await makeGroup(ctx, { timezone: 'Pacific/Kiritimati' });
      const theirToday = localDate(ctx.clock.now(), group.timezone);

      expect(await claimSteamSync(ctx, group, theirToday)).toBe(true);
      expect(await claimSteamSync(ctx, group, theirToday)).toBe(false);
    });
  });
});
