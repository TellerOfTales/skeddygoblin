/**
 * Opt-in membership: the Join button.
 *
 * This is what lets the roster be "people who actually play" rather than
 * "everyone who ever joined the server", and it is the thing that makes the
 * privileged members intent optional rather than load-bearing - which matters,
 * because that intent is what forces Discord verification at 75 servers.
 */

import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { registerComponentHandler, type ComponentInteraction } from './index.js';
import { fromBase36, type ParsedCustomId } from '../customId.js';
import { DomainError } from '../../domain/errors.js';
import { joinGroup, leaveGroup, resolveActorInGroup } from '../../services/membershipService.js';
import { joinBoardView } from '../views/onboarding.view.js';
import type { AppContext } from '../../services/context.js';

async function refreshBoard(
  interaction: ButtonInteraction,
  ctx: AppContext,
  groupId: number,
): Promise<void> {
  // The public board shows a live count, so it is edited in place rather than
  // left stale - a join button that never visibly does anything gets tapped
  // twice and then ignored.
  const memberCount = await ctx.db
    .query<{ count: string }>(
      'SELECT COUNT(*)::bigint AS count FROM group_membership WHERE group_id = $1',
      [groupId],
    )
    .then((result) => Number(result.rows[0]?.count ?? 0));

  await interaction.editReply(joinBoardView({ groupId, memberCount }));
}

async function handle(
  interaction: ComponentInteraction,
  parsed: ParsedCustomId,
  ctx: AppContext,
): Promise<void> {
  if (!interaction.isButton()) throw new DomainError('INVALID_INPUT');
  const groupId = fromBase36(parsed.args[0] ?? '');

  await interaction.deferUpdate();

  const actor = await resolveActorInGroup(ctx, {
    discordUserId: interaction.user.id,
    groupId,
  });

  if (parsed.action === 'out') {
    await leaveGroup(ctx, actor.user.id, groupId);
    await refreshBoard(interaction, ctx, groupId);
    await interaction.followUp({
      content: 'Taken you off. Tap **Count me in** whenever you want back on.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await joinGroup(ctx, actor.user.id, groupId);
  await refreshBoard(interaction, ctx, groupId);
  await interaction.followUp({
    content: "You're in 🧌 Run `/availability` to answer for this week — it takes two minutes.",
    flags: MessageFlags.Ephemeral,
  });
}

registerComponentHandler('join', handle);
