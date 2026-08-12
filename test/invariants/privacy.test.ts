/**
 * P1-P3: the aggregate-only privacy rule.
 *
 * The brief asks for this to be enforced at the query/service layer, with no
 * code path that lets one member's raw record reach another member's view.
 * These tests encode that.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, withRollback } from '../helpers/db.js';
import { makeGroup, makeMember } from '../helpers/fixtures.js';
import { currentWeek, optOut, submit } from '../../src/services/responseService.js';
import { buildOverlapReport } from '../../src/services/overlapService.js';
import { buildRoster } from '../../src/services/rosterService.js';
import * as weeklyResponses from '../../src/db/repositories/weeklyResponses.js';
import * as vibesRepo from '../../src/db/repositories/vibes.js';

afterAll(closeTestPool);

const SRC = new URL('../../src/', import.meta.url).pathname;

/**
 * P1. Seed members with globally unique markers, then assert that everything a
 * DIFFERENT member can see contains none of them.
 *
 * The markers are chosen so that leaking would be unmistakable: B is the only
 * member available late_night on Sunday, and the only one who picked 'Action'.
 */
describe('P1: no raw record reaches another member', () => {
  it('keeps one member’s availability, capacity and vibes out of group views', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const viewer = await makeMember(ctx, group);
      const b = await makeMember(ctx, group);
      const c = await makeMember(ctx, group);
      const week = currentWeek(ctx, group.timezone);
      const scope = { groupId: group.id, weekStartDate: week };

      await submit(ctx, {
        userId: viewer.id,
        ...scope,
        sessionsCommitted: 1,
        slots: [{ dayOfWeek: 0, window: 'evening' }],
        vibes: ['Casual'],
      });
      await submit(ctx, {
        userId: b.id,
        ...scope,
        sessionsCommitted: 3,
        slots: [
          { dayOfWeek: 0, window: 'evening' },
          // B alone is free here.
          { dayOfWeek: 6, window: 'late_night' },
        ],
        vibes: ['Action'],
      });
      // C opted out, which must not be distinguishable from having submitted.
      await optOut(ctx, { userId: c.id, ...scope });

      const overlap = await buildOverlapReport(ctx, scope);
      const roster = await buildRoster(ctx, { group, weekStartDate: week });
      const vibeCounts = await vibesRepo.countVibesAggregate(ctx.db, scope);

      const groupVisible = JSON.stringify({ overlap, vibeCounts });

      // B's solo slot must not surface at all: it is below the k-anonymity
      // floor, and it would identify B by construction.
      expect(overlap.windows.some((row) => row.dayOfWeek === 6)).toBe(false);

      // No user identity anywhere in the aggregate surfaces.
      for (const member of [b, c]) {
        expect(groupVisible).not.toContain(member.discordId);
        expect(groupVisible).not.toMatch(new RegExp(`"userId":\\s*${member.id}\\b`));
      }

      // Nothing exposes a capacity alongside an identity.
      expect(groupVisible).not.toMatch(/sessionsCommitted/);

      // The roster carries identities, which is allowed - but only with a
      // boolean beside them.
      for (const row of roster.rows) {
        expect(Object.keys(row).sort()).toEqual([
          'buzzedToday',
          'discordId',
          'hasResponded',
          // Progress, not content: 'started' says someone picked something,
          // never what. Windows, capacity and vibes stay unreachable here.
          'progress',
          'userId',
        ]);
      }
    });
  });

  it('self-scoped reads never return another member’s rows', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const a = await makeMember(ctx, group);
      const b = await makeMember(ctx, group);
      const week = currentWeek(ctx, group.timezone);
      const scope = { groupId: group.id, weekStartDate: week };

      await submit(ctx, {
        userId: b.id,
        ...scope,
        sessionsCommitted: 4,
        slots: [{ dayOfWeek: 3, window: 'night' }],
        vibes: ['Action'],
      });

      const { getOwnSubmission } = await import('../../src/services/responseService.js');
      const asA = await getOwnSubmission(ctx, { userId: a.id, ...scope });

      expect(asA.response).toBeNull();
      expect(asA.slots).toEqual([]);
      expect(asA.vibes).toEqual([]);
    });
  });
});

/**
 * P2. A structural audit rather than a behavioural one: adding a repository
 * function that returns raw rows for an arbitrary user should require a
 * conscious edit to the allowlist below, which is the review trigger the brief
 * asks for.
 */
describe('P2: repository export naming discipline', () => {
  /**
   * Functions that read or write group-scoped data without a `selfUserId`
   * guard. Each is here because its RETURN TYPE cannot carry a preference
   * alongside an identity. Adding to this list is a deliberate act.
   */
  const ALLOWLIST = new Set([
    // Carries user_id, but only ever to turn each draft into that same user's
    // own submission at the cutoff. No view can reach it.
    'listDraftsForWeek',
    // Ids only - who has started, never what they picked.
    'listUserIdsWithProgress',
    // Ids only - who asked to be answered for automatically. The template
    // itself is read through getDefaultsForSelf, one user at a time.
    'listAutoApplyUserIds',
    // aggregates - counts and scores only
    'rankWindowAggregate',
    'countSubmittedResponders',
    'countRespondersAggregate',
    'countVibesAggregate',
    // Counts only: how many have not linked Steam, never which of them.
    'countUnlinkedMembersAggregate',
    // Storefronts in use. A list of country codes, attached to nobody.
    'listActiveCountryCodesAggregate',
    'countAttendanceAggregate',
    'countSlotsForGroup',
    'countMembers',
    // identity WITHOUT preference - the roster seam
    'listRespondedUserIds',
    'listRosterEntries',
    'listMemberIds',
    'listYesUserIds',
    'listUsersByIds',
    // membership / identity records, which carry no weekly answers
    'ensureUser',
    'findUserById',
    'findUserByDiscordId',
    'ensureGroup',
    'findGroupById',
    'findGroupByGuildId',
    'listAllGroups',
    'updateGroupSettings',
    'ensureMembership',
    'findMembership',
    'isMember',
    // Writes taking an explicit user id, returning nothing.
    'removeMembership',
    // Catalogue writes and work queues: app ids and prices, no user anywhere.
    'upsertAppPrice',
    'listAppIdsNeedingPrice',
    'isOrganizer',
    'setRole',
    // existence checks - a boolean, not a preference
    'hasResponded',
    'wasBuzzedOn',
    // writes, which take the acting user explicitly
    'optOut',
    'submit',
    'startOrResumeDraft',
    'findDraftById',
    'saveDraftState',
    'deleteDraft',
    'deleteStaleDrafts',
    'replaceSlotsForSelf',
    'replaceVibesForSelf',
    'claimBuzz',
    'markBuzzStatus',
    'expireStalePendingBuzzes',
    // sessions - proposals are group-level by nature, attendance is aggregated
    'createProposal',
    'findProposalById',
    'setProposalStatus',
    'setProposalMessageId',
    'listProposalsForWeek',
    'setAttendance',
    // scheduler bookkeeping
    'claimJob',
    'hasRun',
    'releaseJob',

    // --- Stage 2 -----------------------------------------------------------
    // App metadata is about GAMES, not people. No user column exists on it.
    'upsertAppMeta',
    'listAppIdsNeedingMeta',
    // Owner COUNTS only. The query never selects a user id - see the games
    // integration test, which asserts no member identifier survives into it.
    'listSharedGamesAggregate',
    // Vote counts, plus a votedByMe flag that the SQL can only ever compute
    // against the caller's own id.
    'listOptionsAggregate',
    // Nomination records: proposal, app id, game name. A game name is not a
    // preference about a person - it is the group's shortlist.
    'createGameVote',
    'findGameVoteById',
    // Writes that take the acting user explicitly.
    'castVote',
    'toggleVote',
    'createLinkState',
    'consumeLinkState',
    'setSteamId',
    'setSteamPublic',
    // Identity without preference, exactly like listMemberIds: who has linked
    // Steam, not what is in their library.
    'listLinkedUserIds',
  ]);

  it('every repository export is self-scoped or explicitly allowlisted', async () => {
    const dir = join(SRC, 'db/repositories');
    const files = (await readdir(dir)).filter(
      (name) => name.endsWith('.ts') && name !== 'types.ts',
    );
    expect(files.length).toBeGreaterThan(5);

    const offenders: string[] = [];

    for (const file of files) {
      const module: Record<string, unknown> = await import(join(dir, file));

      for (const [name, value] of Object.entries(module)) {
        if (typeof value !== 'function') continue;

        if (name.endsWith('ForSelf')) {
          // Self-scoped: the second parameter must be the caller's own id, by
          // name, so a reviewer can see the guard at the call site.
          const source = value.toString();
          const params = /\(([^)]*)\)/.exec(source)?.[1] ?? '';
          if (!/\bselfUserId\b/.test(params)) {
            offenders.push(`${file}:${name} - ForSelf without a selfUserId parameter`);
          }
          continue;
        }

        if (!ALLOWLIST.has(name)) {
          offenders.push(
            `${file}:${name} - not self-scoped and not allowlisted. ` +
              'If it returns aggregate data, add it to the allowlist in this test ' +
              'after checking its return type carries no identity+preference pair.',
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no repository query uses SELECT *', async () => {
    const dir = join(SRC, 'db/repositories');
    const files = await readdir(dir);
    const offenders: string[] = [];

    for (const file of files.filter((name) => name.endsWith('.ts'))) {
      const source = await readFile(join(dir, file), 'utf8');
      if (/SELECT\s+\*/i.test(source)) offenders.push(relative(SRC, join(dir, file)));
    }

    // Enumerating columns is what keeps a new column from silently joining
    // every existing result set.
    expect(offenders).toEqual([]);
  });
});

/**
 * P3. "Responded vs not-responded by name only" - which way someone answered is
 * itself a preference.
 */
describe('P3: the roster never reveals HOW someone answered', () => {
  it('reports opted-out and submitted members identically', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const submitter = await makeMember(ctx, group);
      const optedOut = await makeMember(ctx, group);
      const silent = await makeMember(ctx, group);
      const week = currentWeek(ctx, group.timezone);
      const scope = { groupId: group.id, weekStartDate: week };

      await submit(ctx, {
        userId: submitter.id,
        ...scope,
        sessionsCommitted: 2,
        slots: [{ dayOfWeek: 1, window: 'evening' }],
        vibes: [],
      });
      await optOut(ctx, { userId: optedOut.id, ...scope });

      const roster = await buildRoster(ctx, { group, weekStartDate: week });
      const byId = new Map(roster.rows.map((row) => [row.userId, row]));

      // Indistinguishable, which is the whole point.
      expect(byId.get(submitter.id)?.hasResponded).toBe(true);
      expect(byId.get(optedOut.id)?.hasResponded).toBe(true);
      expect(byId.get(silent.id)?.hasResponded).toBe(false);

      expect(JSON.stringify(roster)).not.toMatch(/opted_out|submitted/);
    });
  });

  it('the roster primitive never selects the status column', async () => {
    const source = await readFile(join(SRC, 'db/repositories/weeklyResponses.ts'), 'utf8');
    const rosterQuery =
      /listRosterEntries[\s\S]*?\)\s*:\s*Promise[\s\S]*?^}/m.exec(source)?.[0] ?? '';

    expect(rosterQuery).not.toMatch(/\bstatus\b/);
    expect(rosterQuery).toMatch(/has_responded/);
  });

  it('listRespondedUserIds returns both statuses without distinguishing them', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const submitter = await makeMember(ctx, group);
      const optedOut = await makeMember(ctx, group);
      const week = currentWeek(ctx, group.timezone);
      const scope = { groupId: group.id, weekStartDate: week };

      await submit(ctx, {
        userId: submitter.id,
        ...scope,
        sessionsCommitted: 1,
        slots: [{ dayOfWeek: 2, window: 'lunch' }],
        vibes: [],
      });
      await optOut(ctx, { userId: optedOut.id, ...scope });

      const ids = await weeklyResponses.listRespondedUserIds(ctx.db, scope);
      expect(ids.sort()).toEqual([submitter.id, optedOut.id].sort());
    });
  });
});
