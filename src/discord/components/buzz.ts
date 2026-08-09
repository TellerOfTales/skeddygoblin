/**
 * The [Buzz] buttons on the status roster.
 *
 * This handler is deliberately thin. Every rule about who may be buzzed lives
 * in buzzService, so the button is only a way of asking - not a permission.
 */

import { MessageFlags } from 'discord.js';
import { DomainError } from '../../domain/errors.js';
import { fromBase36, type ParsedCustomId } from '../customId.js';
import type { ComponentInteraction } from './index.js';
import { registerComponentHandler } from './index.js';
import type { AppContext } from '../../services/context.js';
import { resolveMemberByDiscordId } from '../../services/membershipService.js';
import { currentWeek } from '../../services/responseService.js';
import { buzz } from '../../services/buzzService.js';
import { buildRoster } from '../../services/rosterService.js';
import { rosterView } from '../views/roster.view.js';

async function handleBuzz(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  const [groupArg, targetArg] = parsed.args;
  if (groupArg === undefined || targetArg === undefined) throw new DomainError('INVALID_INPUT');

  const groupId = fromBase36(groupArg);
  const targetUserId = fromBase36(targetArg);

  const actor = await resolveMemberByDiscordId(ctx, {
    discordUserId: interaction.user.id,
    groupId,
  });
  const week = currentWeek(ctx, actor.group.timezone);

  // deferUpdate rather than deferReply: the roster message must stay usable for
  // everyone else while this presser gets private feedback.
  await interaction.deferUpdate();

  await buzz(ctx, {
    actorUserId: actor.user.id,
    targetUserId,
    groupId,
    weekStartDate: week,
  });

  // Re-render so the button greys out for everyone looking at the message.
  const roster = await buildRoster(ctx, { group: actor.group, weekStartDate: week });
  await interaction.editReply(
    rosterView({
      groupId: actor.group.id,
      groupName: actor.group.name,
      weekStartDate: roster.weekStartDate,
      rows: roster.rows,
      responded: roster.responded,
      total: roster.total,
    }),
  );

  await interaction.followUp({
    content: 'Buzzed. They get one nudge a day, so that is them done until tomorrow.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handle(
  interaction: ComponentInteraction,
  parsed: ParsedCustomId,
  ctx: AppContext,
): Promise<void> {
  switch (parsed.action) {
    case 'go':
      return handleBuzz(interaction, ctx, parsed);
    default:
      ctx.logger.warn('unknown buzz action', { action: parsed.action });
  }
}

registerComponentHandler('buzz', handle);
