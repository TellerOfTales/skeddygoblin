import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, withRollback } from '../helpers/db.js';
import { makeGroup, makeMember } from '../helpers/fixtures.js';
import * as steam from '../../src/db/repositories/steam.js';
import { currentWeek, optOut, submit } from '../../src/services/responseService.js';
import {
  listGameOptions,
  nominateGame,
  searchSharedGames,
  suggestGames,
  toggleVote,
} from '../../src/services/gameService.js';
import { proposeSession } from '../../src/services/sessionService.js';
import type { AppContext } from '../../src/services/context.js';
import type { GroupRecord, UserRecord } from '../../src/db/repositories/types.js';

afterAll(closeTestPool);

const CS2 = { appId: 730, gameName: 'Counter-Strike 2', multiplayer: true };
const STARDEW = { appId: 413150, gameName: 'Stardew Valley', multiplayer: true };
const SOLO = { appId: 1, gameName: 'A Lonely Game', multiplayer: false };

async function seedLibraries(
  ctx: AppContext,
  memberCount = 3,
): Promise<{ group: GroupRecord; members: UserRecord[]; week: string }> {
  const group = await makeGroup(ctx);
  const week = currentWeek(ctx, group.timezone);
  const members: UserRecord[] = [];

  for (let index = 0; index < memberCount; index++) {
    const member = await makeMember(ctx, group);
    members.push(member);
    await submit(ctx, {
      userId: member.id,
      groupId: group.id,
      weekStartDate: week,
      sessionsCommitted: 2,
      slots: [{ dayOfWeek: 2, window: 'evening' }],
      vibes: ['competitive'],
    });
  }

  await steam.upsertAppMeta(ctx.db, {
    appId: CS2.appId,
    name: CS2.gameName,
    categories: ['Online PvP', 'Multi-player'],
    genres: ['Action'],
    multiplayer: true,
    priceCents: 0,
    currency: 'USD',
    storeUrl: 'https://store.steampowered.com/app/730',
  });
  await steam.upsertAppMeta(ctx.db, {
    appId: STARDEW.appId,
    name: STARDEW.gameName,
    categories: ['Online Co-op', 'Multi-player'],
    genres: ['Simulation', 'Casual'],
    multiplayer: true,
    priceCents: 1499,
    currency: 'USD',
    storeUrl: 'https://store.steampowered.com/app/413150',
  });

  return { group, members, week };
}

describe('shared library aggregation', () => {
  it('counts owners without ever naming them', async () => {
    await withRollback(async (ctx) => {
      const { group, members, week } = await seedLibraries(ctx);

      await steam.replaceLibraryForSelf(ctx.db, members[0]!.id, [CS2, STARDEW]);
      await steam.replaceLibraryForSelf(ctx.db, members[1]!.id, [CS2]);
      await steam.replaceLibraryForSelf(ctx.db, members[2]!.id, [STARDEW]);

      const shared = await steam.listSharedGamesAggregate(ctx.db, {
        groupId: group.id,
        weekStartDate: week,
        minOwners: 2,
      });

      expect(shared.map((game) => [game.name, game.ownerCount])).toEqual([
        ['Counter-Strike 2', 2],
        ['Stardew Valley', 2],
      ]);

      // A library is as personal as a calendar.
      const serialized = JSON.stringify(shared);
      for (const member of members) {
        expect(serialized).not.toContain(member.discordId);
      }
      expect(serialized).not.toContain('user_id');
    });
  });

  it('applies the same k-anonymity floor as availability', async () => {
    await withRollback(async (ctx) => {
      const { group, members, week } = await seedLibraries(ctx);
      // Only one member owns it, so saying so would identify them.
      await steam.replaceLibraryForSelf(ctx.db, members[0]!.id, [CS2]);

      const shared = await steam.listSharedGamesAggregate(ctx.db, {
        groupId: group.id,
        weekStartDate: week,
        minOwners: 2,
      });

      expect(shared).toEqual([]);
    });
  });

  it('ignores members who did not submit this week', async () => {
    await withRollback(async (ctx) => {
      const { group, members, week } = await seedLibraries(ctx, 2);
      const bystander = await makeMember(ctx, group);
      await optOut(ctx, { userId: bystander.id, groupId: group.id, weekStartDate: week });

      await steam.replaceLibraryForSelf(ctx.db, members[0]!.id, [CS2]);
      await steam.replaceLibraryForSelf(ctx.db, bystander.id, [CS2]);

      const shared = await steam.listSharedGamesAggregate(ctx.db, {
        groupId: group.id,
        weekStartDate: week,
        minOwners: 2,
      });

      // The point is what THIS week's players can load up.
      expect(shared).toEqual([]);
    });
  });

  it('can exclude single-player games', async () => {
    await withRollback(async (ctx) => {
      const { group, members, week } = await seedLibraries(ctx, 2);
      for (const member of members) {
        await steam.replaceLibraryForSelf(ctx.db, member.id, [SOLO]);
      }

      const all = await steam.listSharedGamesAggregate(ctx.db, {
        groupId: group.id,
        weekStartDate: week,
        minOwners: 2,
        multiplayerOnly: false,
      });
      const together = await steam.listSharedGamesAggregate(ctx.db, {
        groupId: group.id,
        weekStartDate: week,
        minOwners: 2,
        multiplayerOnly: true,
      });

      expect(all).toHaveLength(1);
      expect(together).toEqual([]);
    });
  });
});

describe('vibe-filtered suggestions', () => {
  it('ranks by how well a game fits the week’s mood', async () => {
    await withRollback(async (ctx) => {
      const { group, members, week } = await seedLibraries(ctx);
      for (const member of members) {
        await steam.replaceLibraryForSelf(ctx.db, member.id, [CS2, STARDEW]);
      }

      // Everyone picked 'competitive' in seedLibraries.
      const suggestions = await suggestGames(ctx, { groupId: group.id, weekStartDate: week });

      expect(suggestions[0]?.name).toBe('Counter-Strike 2');
      expect(suggestions[0]?.vibeFit).toBe(1);
      // Stardew suits nobody's stated mood, so it drops out entirely.
      expect(suggestions.map((game) => game.name)).not.toContain('Stardew Valley');
    });
  });

  it('carries price and store link through from the shared metadata cache', async () => {
    await withRollback(async (ctx) => {
      const { group, members, week } = await seedLibraries(ctx, 2);
      for (const member of members) {
        await steam.replaceLibraryForSelf(ctx.db, member.id, [CS2]);
      }

      const [game] = await suggestGames(ctx, { groupId: group.id, weekStartDate: week });

      expect(game?.priceCents).toBe(0);
      expect(game?.storeUrl).toBe('https://store.steampowered.com/app/730');
    });
  });

  it('feeds /propose autocomplete from the shared library', async () => {
    await withRollback(async (ctx) => {
      const { group, members, week } = await seedLibraries(ctx);
      for (const member of members) {
        await steam.replaceLibraryForSelf(ctx.db, member.id, [CS2, STARDEW]);
      }

      const matches = await searchSharedGames(ctx, {
        groupId: group.id,
        weekStartDate: week,
        query: 'stardew',
      });

      expect(matches.map((game) => game.name)).toEqual(['Stardew Valley']);
    });
  });
});

describe('nominations and voting', () => {
  it('nominating also casts your vote', async () => {
    await withRollback(async (ctx) => {
      const { group, members, week } = await seedLibraries(ctx, 2);
      const proposal = await proposeSession(ctx, {
        groupId: group.id,
        weekStartDate: week,
        day: 2,
        window: 'evening',
        createdBy: members[0]!.id,
      });

      await nominateGame(ctx, {
        proposalId: proposal.id,
        gameName: 'Counter-Strike 2',
        appId: 730,
        nominatedBy: members[0]!.id,
      });

      const options = await listGameOptions(ctx, {
        proposalId: proposal.id,
        viewerUserId: members[0]!.id,
      });

      expect(options).toHaveLength(1);
      expect(options[0]).toMatchObject({ gameName: 'Counter-Strike 2', votes: 1, votedByMe: true });
    });
  });

  it('two people nominating the same game make one option with two votes', async () => {
    await withRollback(async (ctx) => {
      const { group, members, week } = await seedLibraries(ctx, 2);
      const proposal = await proposeSession(ctx, {
        groupId: group.id,
        weekStartDate: week,
        day: 2,
        window: 'evening',
        createdBy: members[0]!.id,
      });

      for (const member of members) {
        await nominateGame(ctx, {
          proposalId: proposal.id,
          gameName: 'Counter-Strike 2',
          appId: 730,
          nominatedBy: member.id,
        });
      }

      const options = await listGameOptions(ctx, {
        proposalId: proposal.id,
        viewerUserId: members[0]!.id,
      });

      expect(options).toHaveLength(1);
      expect(options[0]?.votes).toBe(2);
    });
  });

  it('a second tap removes your vote', async () => {
    await withRollback(async (ctx) => {
      const { group, members, week } = await seedLibraries(ctx, 2);
      const proposal = await proposeSession(ctx, {
        groupId: group.id,
        weekStartDate: week,
        day: 2,
        window: 'evening',
        createdBy: members[0]!.id,
      });
      const voteId = await nominateGame(ctx, {
        proposalId: proposal.id,
        gameName: 'Stardew Valley',
        nominatedBy: members[0]!.id,
      });

      expect(await toggleVote(ctx, { voteId, userId: members[0]!.id })).toBe(false);
      expect(await toggleVote(ctx, { voteId, userId: members[0]!.id })).toBe(true);
    });
  });

  it('shows vote counts without revealing who voted', async () => {
    await withRollback(async (ctx) => {
      const { group, members, week } = await seedLibraries(ctx, 3);
      const proposal = await proposeSession(ctx, {
        groupId: group.id,
        weekStartDate: week,
        day: 2,
        window: 'evening',
        createdBy: members[0]!.id,
      });
      const voteId = await nominateGame(ctx, {
        proposalId: proposal.id,
        gameName: 'Counter-Strike 2',
        nominatedBy: members[0]!.id,
      });
      await toggleVote(ctx, { voteId, userId: members[1]!.id });

      // Viewed by someone who has NOT voted.
      const options = await listGameOptions(ctx, {
        proposalId: proposal.id,
        viewerUserId: members[2]!.id,
      });

      expect(options[0]?.votes).toBe(2);
      expect(options[0]?.votedByMe).toBe(false);
      // votedByMe is self-scoped: no other member's choice is represented.
      expect(Object.keys(options[0]!).sort()).toEqual([
        'appId',
        'gameName',
        'voteId',
        'votedByMe',
        'votes',
      ]);
    });
  });
});

describe('library sync bookkeeping', () => {
  it('replaces a library wholesale rather than accumulating', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const member = await makeMember(ctx, group);

      await steam.replaceLibraryForSelf(ctx.db, member.id, [CS2, STARDEW]);
      await steam.replaceLibraryForSelf(ctx.db, member.id, [CS2]);

      const library = await steam.listLibraryForSelf(ctx.db, member.id);
      expect(library.map((game) => game.appId)).toEqual([CS2.appId]);
    });
  });

  it('only asks for metadata once per app across the whole group', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const a = await makeMember(ctx, group);
      const b = await makeMember(ctx, group);

      await steam.replaceLibraryForSelf(ctx.db, a.id, [CS2, STARDEW]);
      await steam.replaceLibraryForSelf(ctx.db, b.id, [CS2, STARDEW]);

      // Two members, two games: two lookups, not four. This is what keeps the
      // Store API's ~200-per-5-minutes budget viable.
      const needed = await steam.listAppIdsNeedingMeta(ctx.db, { limit: 50, staleAfterDays: 30 });
      expect(needed.sort()).toEqual([CS2.appId, STARDEW.appId].sort());

      await steam.upsertAppMeta(ctx.db, {
        appId: CS2.appId,
        name: 'Counter-Strike 2',
        categories: ['Online PvP'],
        genres: ['Action'],
        multiplayer: true,
        priceCents: 0,
        currency: 'USD',
        storeUrl: 'https://store.steampowered.com/app/730',
      });

      expect(await steam.listAppIdsNeedingMeta(ctx.db, { limit: 50, staleAfterDays: 30 })).toEqual([
        STARDEW.appId,
      ]);
    });
  });

  it('consumes a link token exactly once', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const member = await makeMember(ctx, group);

      const state = await steam.createLinkState(ctx.db, member.id);

      expect(await steam.consumeLinkState(ctx.db, state)).toBe(member.id);
      expect(await steam.consumeLinkState(ctx.db, state)).toBeNull();
      expect(await steam.consumeLinkState(ctx.db, 'never-issued')).toBeNull();
    });
  });
});

describe('weekly library re-sync', () => {
  it('is claimed once per group per week, like every other scheduled job', async () => {
    await withRollback(async (ctx) => {
      const { group, week } = await seedLibraries(ctx, 1);
      const { claimSteamSync } = await import('../../src/services/weeklyCycleService.js');

      expect(await claimSteamSync(ctx, group, week)).toBe(true);
      expect(await claimSteamSync(ctx, group, week)).toBe(false);

      // ...and comes round again next week, because people buy games.
      ctx.clock.advanceDays(7);
      const nextWeek = currentWeek(ctx, group.timezone);
      expect(await claimSteamSync(ctx, group, nextWeek)).toBe(true);
    });
  });

  it('only re-syncs members who actually linked Steam', async () => {
    await withRollback(async (ctx) => {
      const { group, members } = await seedLibraries(ctx, 2);
      await steam.setSteamId(ctx.db, members[0]!.id, '76561198000000001', true);

      const linked = await steam.listLinkedUserIds(ctx.db, group.id);

      expect(linked).toEqual([members[0]!.id]);
    });
  });
});
