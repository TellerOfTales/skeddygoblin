import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { AppContext } from '../../services/context.js';
import { resolveActor } from '../../services/membershipService.js';
import { currentWeek } from '../../services/responseService.js';
import { buildOverlapReport } from '../../services/overlapService.js';
import { countUnlinkedMembers, suggestGamesPage } from '../../services/gameService.js';
import { formatPrice } from '../../domain/gameMatching.js';
import { leaderboardView } from '../views/leaderboard.view.js';

export const data = new SlashCommandBuilder()
  .setName('overlap')
  .setDescription('Show the best windows for the group this week')
  .setDMPermission(false);

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
): Promise<void> {
  // Public, not ephemeral. The leaderboard is entirely aggregate - ranked
  // windows by headcount, with the k-anonymity floor already applied - and it is
  // the thing the group gathers around to pick a night. Hiding it from everyone
  // but the asker defeats the point.
  await interaction.deferReply();

  if (!interaction.guildId) {
    await interaction.editReply('Run this in a server, not a DM.');
    return;
  }

  const actor = await resolveActor(ctx, {
    discordUserId: interaction.user.id,
    discordGuildId: interaction.guildId,
    guildName: interaction.guild?.name ?? 'this server',
  });

  const week = currentWeek(ctx, actor.group.timezone);
  const scope = { groupId: actor.group.id, weekStartDate: week };
  const report = await buildOverlapReport(ctx, scope);

  // Windows and games are the same decision - "when can we play" is only half
  // of it - so the board carries both rather than making anyone run /games.
  let games: { name: string; ownerCount: number; price: string | null }[] = [];
  try {
    const page = await suggestGamesPage(ctx, { ...scope, pageSize: 3 });
    games = page.games.map((game) => ({
      name: game.name,
      ownerCount: game.ownerCount,
      price: formatPrice(game.priceCents, game.currency, { usdMinorUnits: game.priceCentsUsd }),
    }));
  } catch (error) {
    ctx.logger.debug('no games for the overlap board', { error });
  }

  const steam = await countUnlinkedMembers(ctx, actor.group.id);

  const view = leaderboardView({
    games,
    steam,
    groupId: actor.group.id,
    groupName: actor.group.name,
    weekStartDate: report.weekStartDate,
    windows: report.windows,
    responded: report.responded,
    total: report.total,
    topVibes: report.topVibes,
    suppressedForPrivacy: report.suppressedForPrivacy,
    // Only an organizer can turn a window into a session, so only they see the
    // buttons - and the handler re-checks, because a button is not a permission.
    showLockIn: actor.role === 'organizer',
  });

  await interaction.editReply(view);
}
