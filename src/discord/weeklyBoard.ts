/**
 * The public post: the whole point of the product, in one message.
 *
 * Skeddy does as much as it can in the open. Everything here is an aggregate -
 * ranked windows by headcount, the week's mood as counts, shared games by owner
 * count - so the group sees the RESULT of everyone's answers without any
 * individual's picks being visible. That is what makes a public post safe, and
 * it is why the board can say more than a DM ever needs to.
 *
 * Two things trigger it and they share one job_run claim, so whichever comes
 * first wins and the second is a silent no-op:
 *   - the nudge cutoff passing
 *   - the last member answering
 */

import type { Client, Guild } from 'discord.js';
import { buildOverlapReport } from '../services/overlapService.js';
import { suggestGamesPage } from '../services/gameService.js';
import { claimCutoffPost, isEveryoneAnswered } from '../services/weeklyCycleService.js';
import { formatPrice } from '../domain/gameMatching.js';
import { leaderboardView } from './views/leaderboard.view.js';
import type { AppContext } from '../services/context.js';
import type { GroupRecord } from '../services/types.js';

/** Games are best-effort: no Steam linked is the normal early state. */
async function sharedGames(
  ctx: AppContext,
  scope: { groupId: number; weekStartDate: string },
): Promise<{ name: string; ownerCount: number; price: string | null }[]> {
  try {
    const page = await suggestGamesPage(ctx, { ...scope, pageSize: 3 });
    return page.games.map((game) => ({
      name: game.name,
      ownerCount: game.ownerCount,
      price: formatPrice(game.priceCents, game.currency, { usdMinorUnits: game.priceCentsUsd }),
    }));
  } catch (error) {
    ctx.logger.debug('no games for the weekly board', { error });
    return [];
  }
}

async function resolveChannel(
  client: Client,
  group: GroupRecord,
): Promise<{ send: (payload: unknown) => Promise<unknown> } | null> {
  if (!group.announceChannelId) return null;
  const channel = await client.channels.fetch(group.announceChannelId).catch(() => null);
  if (!channel?.isTextBased() || !('send' in channel)) return null;
  return channel as unknown as { send: (payload: unknown) => Promise<unknown> };
}

/**
 * Posts the board if this week's has not been posted yet.
 *
 * The claim comes FIRST. Posting twice is worse than posting late, and with two
 * triggers racing - a cutoff tick and someone's final Submit - the job_run
 * primary key is the only thing that makes "exactly once" true rather than
 * likely.
 */
export async function publishWeeklyBoard(
  ctx: AppContext,
  client: Client,
  group: GroupRecord,
  week: string,
  reason: 'cutoff' | 'everyone-answered',
): Promise<boolean> {
  if (!(await claimCutoffPost(ctx, group, week))) return false;

  const channel = await resolveChannel(client, group);
  if (!channel) {
    ctx.logger.warn('weekly board due but no postable announce channel', { groupId: group.id });
    return false;
  }

  const scope = { groupId: group.id, weekStartDate: week };
  const report = await buildOverlapReport(ctx, scope);
  const games = await sharedGames(ctx, scope);

  await channel.send(
    leaderboardView({
      groupId: group.id,
      groupName: group.name,
      weekStartDate: report.weekStartDate,
      windows: report.windows,
      responded: report.responded,
      total: report.total,
      topVibes: report.topVibes,
      suppressedForPrivacy: report.suppressedForPrivacy,
      showLockIn: true,
      games,
      reason,
    }),
  );

  ctx.logger.info('weekly board posted', { groupId: group.id, week, reason });
  return true;
}

/**
 * Called after someone answers. Posts early when that answer was the last one
 * outstanding - waiting for a cutoff nobody is waiting for is just a delay.
 *
 * Never throws: this runs after the member has already been told their answer
 * was saved, and a channel problem must not surface as their failure.
 */
export async function publishIfEveryoneAnswered(
  ctx: AppContext,
  guildOrClient: Client | Guild,
  group: GroupRecord,
  week: string,
): Promise<void> {
  try {
    if (!(await isEveryoneAnswered(ctx, group, week))) return;
    const client = 'client' in guildOrClient ? guildOrClient.client : guildOrClient;
    await publishWeeklyBoard(ctx, client, group, week, 'everyone-answered');
  } catch (error) {
    ctx.logger.error('early weekly board failed', { groupId: group.id, error });
  }
}
