/**
 * Session proposal buttons: lock in a window, RSVP, confirm, cancel.
 *
 * The public RSVP message shows counts only. Who said yes is never rendered -
 * an attendance answer is as much a preference as an availability slot.
 */

import { MessageFlags } from 'discord.js';
import { DomainError } from '../../domain/errors.js';
import { isDay, isWindow } from '../../domain/constants.js';
import { fromBase36, type ParsedCustomId } from '../customId.js';
import type { ComponentInteraction } from './index.js';
import { registerComponentHandler } from './index.js';
import type { AppContext } from '../../services/context.js';
import { resolveMemberByDiscordId } from '../../services/membershipService.js';
import { currentWeek } from '../../services/responseService.js';
import {
  attachMessageId,
  attendanceCounts,
  cancelSession,
  confirmSession,
  proposeSession,
  requireProposal,
  rsvp,
} from '../../services/sessionService.js';
import { sessionRsvpView } from '../views/leaderboard.view.js';

async function handleLockIn(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  const [groupArg, dayArg, windowArg] = parsed.args;
  if (groupArg === undefined) throw new DomainError('INVALID_INPUT');

  const day = Number(dayArg);
  if (!isDay(day) || !isWindow(windowArg)) throw new DomainError('INVALID_INPUT');

  const actor = await resolveMemberByDiscordId(ctx, {
    discordUserId: interaction.user.id,
    groupId: fromBase36(groupArg),
  });
  // Enforced in the handler AND re-derivable from the record: the button is
  // visible to everyone in the channel, so the check cannot live in the view.
  if (actor.role !== 'organizer') throw new DomainError('NOT_ORGANIZER');

  await interaction.deferUpdate();

  const proposal = await proposeSession(ctx, {
    groupId: actor.group.id,
    weekStartDate: currentWeek(ctx, actor.group.timezone),
    day,
    window: windowArg,
    createdBy: actor.user.id,
  });

  const message = await interaction.followUp({
    ...sessionRsvpView({
      proposalId: proposal.id,
      groupName: actor.group.name,
      day: proposal.candidateDay,
      window: proposal.candidateWindow,
      counts: await attendanceCounts(ctx, proposal.id),
      confirmed: proposal.status === 'confirmed',
      showConfirm: true,
    }),
    withResponse: true,
  });

  if (message && 'id' in message) {
    await attachMessageId(ctx, proposal.id, message.id);
  }
}

async function handleRsvp(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  const [proposalArg, responseArg] = parsed.args;
  if (proposalArg === undefined) throw new DomainError('INVALID_INPUT');
  if (responseArg !== 'yes' && responseArg !== 'maybe' && responseArg !== 'no') {
    throw new DomainError('INVALID_INPUT');
  }

  const proposalId = fromBase36(proposalArg);
  const proposal = await requireProposal(ctx, proposalId);

  const actor = await resolveMemberByDiscordId(ctx, {
    discordUserId: interaction.user.id,
    groupId: proposal.groupId,
  });

  await interaction.deferUpdate();

  const { counts } = await rsvp(ctx, {
    proposalId,
    userId: actor.user.id,
    response: responseArg,
  });

  await interaction.editReply(
    sessionRsvpView({
      proposalId,
      groupName: actor.group.name,
      day: proposal.candidateDay,
      window: proposal.candidateWindow,
      counts,
      confirmed: false,
      showConfirm: true,
    }),
  );
}

async function handleConfirm(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  const proposalArg = parsed.args[0];
  if (proposalArg === undefined) throw new DomainError('INVALID_INPUT');

  const proposalId = fromBase36(proposalArg);
  const proposal = await requireProposal(ctx, proposalId);

  const actor = await resolveMemberByDiscordId(ctx, {
    discordUserId: interaction.user.id,
    groupId: proposal.groupId,
  });
  if (actor.role !== 'organizer') throw new DomainError('NOT_ORGANIZER');

  await interaction.deferUpdate();

  const { proposal: confirmed, notified } = await confirmSession(ctx, {
    proposalId,
    group: actor.group,
  });

  await interaction.editReply(
    sessionRsvpView({
      proposalId,
      groupName: actor.group.name,
      day: confirmed.candidateDay,
      window: confirmed.candidateWindow,
      counts: await attendanceCounts(ctx, proposalId),
      confirmed: true,
      showConfirm: false,
    }),
  );

  await interaction.followUp({
    content: `Confirmed. ${notified} ${notified === 1 ? 'person has' : 'people have'} been told.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCancel(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  const proposalArg = parsed.args[0];
  if (proposalArg === undefined) throw new DomainError('INVALID_INPUT');

  const proposalId = fromBase36(proposalArg);
  const proposal = await requireProposal(ctx, proposalId);

  const actor = await resolveMemberByDiscordId(ctx, {
    discordUserId: interaction.user.id,
    groupId: proposal.groupId,
  });
  if (actor.role !== 'organizer') throw new DomainError('NOT_ORGANIZER');

  await interaction.deferUpdate();
  await cancelSession(ctx, proposalId);

  await interaction.editReply({
    content: 'Session cancelled.',
    embeds: [],
    components: [],
  });
}

async function handle(
  interaction: ComponentInteraction,
  parsed: ParsedCustomId,
  ctx: AppContext,
): Promise<void> {
  switch (parsed.action) {
    case 'lock':
      return handleLockIn(interaction, ctx, parsed);
    case 'rsvp':
      return handleRsvp(interaction, ctx, parsed);
    case 'confirm':
      return handleConfirm(interaction, ctx, parsed);
    case 'cancel':
      return handleCancel(interaction, ctx, parsed);
    default:
      ctx.logger.warn('unknown session action', { action: parsed.action });
  }
}

registerComponentHandler('sess', handle);
