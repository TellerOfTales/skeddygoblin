import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { AppContext } from '../../services/context.js';
import { resolveActor } from '../../services/membershipService.js';
import { currentWeek } from '../../services/responseService.js';
import { buildRoster } from '../../services/rosterService.js';
import { buildOverlapReport } from '../../services/overlapService.js';
import { suggestGamesPage } from '../../services/gameService.js';
import { formatPrice } from '../../domain/gameMatching.js';
import { rosterView } from '../views/roster.view.js';

export const data = new SlashCommandBuilder()
  .setName('status')
  .setDescription("See who's answered this week, and nudge whoever hasn't")
  .setDMPermission(false);

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
): Promise<void> {
  // Public, not ephemeral. Everything on the roster is either a name the group
  // already sees or an aggregate, so there is nothing here that needs hiding -
  // and a status only the person who typed it can read cannot do the one job it
  // has, which is telling the GROUP where the week stands. It is also what makes
  // the Buzz buttons usable by anyone rather than only the asker.
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

  const roster = await buildRoster(ctx, { group: actor.group, weekStartDate: week });
  const report = await buildOverlapReport(ctx, scope);

  // Steam is optional, and a group with nothing linked is the normal early
  // state - an empty games section, not an error.
  let games: { name: string; ownerCount: number; price: string | null }[] = [];
  try {
    const page = await suggestGamesPage(ctx, { ...scope, pageSize: 3 });
    games = page.games.map((game) => ({
      name: game.name,
      ownerCount: game.ownerCount,
      price: formatPrice(game.priceCents, game.currency, { usdMinorUnits: game.priceCentsUsd }),
    }));
  } catch (error) {
    ctx.logger.debug('no game highlights for status', { error });
  }

  await interaction.editReply(
    rosterView({
      groupId: actor.group.id,
      groupName: actor.group.name,
      weekStartDate: roster.weekStartDate,
      rows: roster.rows,
      responded: roster.responded,
      started: roster.started,
      total: roster.total,
      highlights: {
        windows: report.windows.slice(0, 3).map((window) => ({
          dayOfWeek: window.dayOfWeek,
          window: window.window,
          headcount: window.headcount,
        })),
        vibes: report.topVibes.slice(0, 4),
        games,
        suppressedForPrivacy: report.suppressedForPrivacy,
      },
    }),
  );
}
