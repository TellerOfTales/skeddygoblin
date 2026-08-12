import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, withRollback } from '../helpers/db.js';
import { makeGroup, makeMember, upsertGame } from '../helpers/fixtures.js';
import * as steam from '../../src/db/repositories/steam.js';
import * as groups from '../../src/db/repositories/groups.js';
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
      vibes: ['Online PvP'],
    });
  }

  await upsertGame(ctx, {
    appId: CS2.appId,
    name: CS2.gameName,
    categories: ['Online PvP', 'Multi-player'],
    genres: ['Action'],
    multiplayer: true,
    priceCents: 0,
    currency: 'USD',
    priceCentsUsd: 0,
    priceCountry: 'US',
    storeUrl: 'https://store.steampowered.com/app/730',
  });
  await upsertGame(ctx, {
    appId: STARDEW.appId,
    name: STARDEW.gameName,
    categories: ['Online Co-op', 'Multi-player'],
    genres: ['Simulation', 'Casual'],
    multiplayer: true,
    priceCents: 1499,
    currency: 'USD',
    priceCentsUsd: 1499,
    priceCountry: 'US',
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

      // Everyone picked 'Online PvP' in seedLibraries.
      const suggestions = await suggestGames(ctx, { groupId: group.id, weekStartDate: week });

      expect(suggestions[0]?.name).toBe('Counter-Strike 2');
      expect(suggestions[0]?.vibeFit).toBe(1);
      // Stardew suits nobody's stated mood, so it ranks last - but it is still
      // a game they all own and can all play, so hiding it would be throwing
      // away a real option over a vocabulary mismatch.
      expect(suggestions.at(-1)?.name).toBe('Stardew Valley');
      expect(suggestions.at(-1)?.vibeFit).toBe(0);
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
      // votedByMe is self-scoped: no other member's choice is represented, and
      // the extra fields are app metadata (price, link) rather than user data.
      expect(Object.keys(options[0]!).sort()).toEqual([
        'appId',
        'currency',
        'gameName',
        'priceCents',
        'priceCentsUsd',
        'storeUrl',
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

      await upsertGame(ctx, {
        appId: CS2.appId,
        name: 'Counter-Strike 2',
        categories: ['Online PvP'],
        genres: ['Action'],
        multiplayer: true,
        priceCents: 0,
        currency: 'USD',
        priceCentsUsd: 0,
        priceCountry: 'US',
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

/**
 * Suggestions are shared games filtered by the week's mood, and they say which
 * vibes they matched. A ranked list nobody can check is one you have to take on
 * trust; "matches Co-op, Survival" is one you can argue with.
 */
describe('suggestions explain themselves', () => {
  it("puts games matching the week's vibes first, and says which they matched", async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const week = currentWeek(ctx, group.timezone);
      const members = [await makeMember(ctx, group), await makeMember(ctx, group)];

      await upsertGame(ctx, {
        appId: 5001,
        name: 'Co-op Survival Thing',
        categories: ['Online Co-op', 'Multi-player'],
        genres: ['Survival'],
        multiplayer: true,
        priceCents: 1999,
        currency: 'GBP',
        priceCentsUsd: 2499,
        priceCountry: 'GB',
        storeUrl: 'https://store.steampowered.com/app/5001',
      });
      await upsertGame(ctx, {
        appId: 5002,
        name: 'Pure Racing Sim',
        categories: ['Multi-player'],
        genres: ['Racing'],
        multiplayer: true,
        priceCents: 2999,
        currency: 'GBP',
        priceCentsUsd: 3499,
        priceCountry: 'GB',
        storeUrl: 'https://store.steampowered.com/app/5002',
      });

      const owned = [
        { appId: 5001, gameName: 'Co-op Survival Thing', multiplayer: true },
        { appId: 5002, gameName: 'Pure Racing Sim', multiplayer: true },
      ];
      for (const member of members) {
        await steam.replaceLibraryForSelf(ctx.db, member.id, owned);
      }

      // The group asked for co-op and survival. Nobody asked for racing.
      for (const member of members) {
        await submit(ctx, {
          userId: member.id,
          groupId: group.id,
          weekStartDate: week,
          sessionsCommitted: 1,
          slots: [{ dayOfWeek: 2, window: 'evening' }],
          vibes: ['Co-op', 'Survival'],
        });
      }

      const games = await suggestGames(ctx, { groupId: group.id, weekStartDate: week });
      const names = games.map((game) => game.name);

      // Ranked, not filtered: the racing sim is still shared and playable, it
      // just is not what anyone asked for this week.
      expect(names[0]).toBe('Co-op Survival Thing');
      expect(names.at(-1)).toBe('Pure Racing Sim');

      const match = games.find((game) => game.name === 'Co-op Survival Thing')!;
      expect(match.matchedVibes.sort()).toEqual(['Co-op', 'Survival']);
      expect(match.vibeFit).toBe(1);
    });
  });
});

/**
 * Two bugs that made real, obvious co-op games invisible.
 */
describe('shared games that should never have been hidden', () => {
  it('ranks a game with no matching genre below the fits, rather than dropping it', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const week = currentWeek(ctx, group.timezone);
      const members = [await makeMember(ctx, group), await makeMember(ctx, group)];

      await upsertGame(ctx, {
        appId: 6001,
        name: 'Fits The Mood',
        categories: ['Online Co-op', 'Multi-player'],
        genres: ['Adventure'],
        multiplayer: true,
        priceCents: 999,
        currency: 'GBP',
        priceCentsUsd: 1299,
        priceCountry: 'GB',
        storeUrl: 'https://store.steampowered.com/app/6001',
      });
      // Everyone owns it, everyone can play it, but Steam's official genres
      // simply do not carry the word the group used. That is a vocabulary gap,
      // not a wrong game.
      await upsertGame(ctx, {
        appId: 6002,
        name: 'Shared But Unlabelled',
        categories: ['Online Co-op', 'Multi-player'],
        genres: ['Indie'],
        multiplayer: true,
        priceCents: 799,
        currency: 'GBP',
        priceCentsUsd: 999,
        priceCountry: 'GB',
        storeUrl: 'https://store.steampowered.com/app/6002',
      });

      const owned = [
        { appId: 6001, gameName: 'Fits The Mood', multiplayer: true },
        { appId: 6002, gameName: 'Shared But Unlabelled', multiplayer: true },
      ];
      for (const member of members) {
        await steam.replaceLibraryForSelf(ctx.db, member.id, owned);
        await submit(ctx, {
          userId: member.id,
          groupId: group.id,
          weekStartDate: week,
          sessionsCommitted: 1,
          slots: [{ dayOfWeek: 2, window: 'evening' }],
          vibes: ['Adventure'],
        });
      }

      const games = await suggestGames(ctx, { groupId: group.id, weekStartDate: week });

      expect(games.map((game) => game.name)).toEqual(['Fits The Mood', 'Shared But Unlabelled']);
      expect(games[1]!.vibeFit).toBe(0);
    });
  });

  it('fetches metadata for the most-shared apps first, not the oldest', async () => {
    await withRollback(async (ctx) => {
      const group = await makeGroup(ctx);
      const [a, b] = [await makeMember(ctx, group), await makeMember(ctx, group)];

      // A 2004-era app id nobody shares, and a recent one everybody owns.
      await steam.replaceLibraryForSelf(ctx.db, a.id, [
        { appId: 240, gameName: 'Ancient Thing', multiplayer: true },
        { appId: 3_241_660, gameName: 'This Year Co-op Hit', multiplayer: true },
      ]);
      await steam.replaceLibraryForSelf(ctx.db, b.id, [
        { appId: 3_241_660, gameName: 'This Year Co-op Hit', multiplayer: true },
      ]);

      const queue = await steam.listAppIdsNeedingMeta(ctx.db, { limit: 10, staleAfterDays: 30 });

      // Ordering by app_id put every game from twenty years ago ahead of the
      // one the group actually shares - and a game with no metadata cannot be
      // suggested at all.
      expect(queue[0]).toBe(3_241_660);
    });
  });
});

/**
 * The bug: steam_app_meta was keyed by app_id alone and carried a price, and
 * the refresh picked ONE country per tick - the lowest group id. Two groups in
 * two countries therefore shared one price, and whichever signed up first won.
 * Silently, and rendered in the other group's currency symbol.
 */
describe('prices are per storefront', () => {
  it('gives two groups in two countries their own real prices', async () => {
    await withRollback(async (ctx) => {
      const uk = await groups.updateGroupSettings(
        ctx.db,
        (await makeGroup(ctx, { name: 'UK' })).id,
        { countryCode: 'GB' },
      );
      const us = await groups.updateGroupSettings(
        ctx.db,
        (await makeGroup(ctx, { name: 'US' })).id,
        { countryCode: 'US' },
      );

      await steam.upsertAppMeta(ctx.db, {
        appId: 7001,
        name: 'Regional Pricing Ltd',
        categories: ['Online Co-op', 'Multi-player'],
        genres: ['Action'],
        multiplayer: true,
        priceCents: null,
        currency: null,
        priceCountry: null,
        priceCentsUsd: null,
        storeUrl: 'https://store.steampowered.com/app/7001',
      });
      // Steam prices regionally: these are two different real numbers, not a
      // conversion of one another.
      await steam.upsertAppPrice(ctx.db, {
        appId: 7001,
        countryCode: 'GB',
        priceCents: 1699,
        currency: 'GBP',
      });
      await steam.upsertAppPrice(ctx.db, {
        appId: 7001,
        countryCode: 'US',
        priceCents: 2499,
        currency: 'USD',
      });

      for (const group of [uk, us]) {
        const week = currentWeek(ctx, group.timezone);
        const members = [await makeMember(ctx, group), await makeMember(ctx, group)];
        for (const member of members) {
          await steam.replaceLibraryForSelf(ctx.db, member.id, [
            { appId: 7001, gameName: 'Regional Pricing Ltd', multiplayer: true },
          ]);
          await submit(ctx, {
            userId: member.id,
            groupId: group.id,
            weekStartDate: week,
            sessionsCommitted: 1,
            slots: [{ dayOfWeek: 2, window: 'evening' }],
            vibes: [],
          });
        }
      }

      const [ukGame] = await suggestGames(ctx, {
        groupId: uk.id,
        weekStartDate: currentWeek(ctx, uk.timezone),
      });
      const [usGame] = await suggestGames(ctx, {
        groupId: us.id,
        weekStartDate: currentWeek(ctx, us.timezone),
      });

      expect(ukGame?.priceCents).toBe(1699);
      expect(ukGame?.currency).toBe('GBP');
      expect(usGame?.priceCents).toBe(2499);
      expect(usGame?.currency).toBe('USD');

      // Both carry the same USD reference, whatever their own storefront.
      expect(ukGame?.priceCentsUsd).toBe(2499);
      expect(usGame?.priceCentsUsd).toBe(2499);
    });
  });

  it('works every storefront in use, not just one per pass', async () => {
    await withRollback(async (ctx) => {
      for (const [name, country] of [
        ['One', 'GB'],
        ['Two', 'DE'],
        ['Three', 'GB'],
      ] as const) {
        await groups.updateGroupSettings(ctx.db, (await makeGroup(ctx, { name })).id, {
          countryCode: country,
        });
      }

      const countries = await steam.listActiveCountryCodesAggregate(ctx.db);

      // Deduplicated, and US always present because it is the reference price
      // shown in brackets even to groups not on it.
      expect(countries).toContain('GB');
      expect(countries).toContain('DE');
      expect(countries).toContain('US');
      expect(new Set(countries).size).toBe(countries.length);
    });
  });
});
