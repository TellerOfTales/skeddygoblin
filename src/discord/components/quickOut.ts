/**
 * The quick-out flow: the two buttons on the weekly prompt DM.
 *
 * This is the first full round trip - Discord -> bot -> DB -> confirmation back
 * to the user - and both branches are terminal from the member's point of view:
 * "Can't this week" ends the week outright, "I'm in" hands off to the
 * questionnaire.
 */

import { fromBase36, type ParsedCustomId } from '../customId.js';
import type { ComponentInteraction } from './index.js';
import { registerComponentHandler } from './index.js';
import type { AppContext } from '../../services/context.js';
import { resolveMemberByDiscordId } from '../../services/membershipService.js';
import { currentWeek, optOut, startOrResumeFlow } from '../../services/responseService.js';
import { DomainError } from '../../domain/errors.js';
import { formatWeekLabel } from '../../domain/week.js';

async function handle(
  interaction: ComponentInteraction,
  parsed: ParsedCustomId,
  ctx: AppContext,
): Promise<void> {
  const groupIdArg = parsed.args[0];
  if (groupIdArg === undefined) throw new DomainError('INVALID_INPUT');
  const groupId = fromBase36(groupIdArg);

  // The prompt arrives as a DM, so there is no guild context on the
  // interaction - the group id has to travel in the custom_id.
  const actor = await resolveMemberByDiscordId(ctx, {
    discordUserId: interaction.user.id,
    groupId,
  });
  const week = currentWeek(ctx, actor.group.timezone);

  switch (parsed.action) {
    case 'optout':
      await handleOptOut(interaction, ctx, actor.user.id, groupId, week, actor.group.name);
      return;
    case 'in':
      await handleOptIn(interaction, ctx, actor.user.id, groupId, week);
      return;
    default:
      ctx.logger.warn('unknown quick-out action', { action: parsed.action });
  }
}

async function handleOptOut(
  interaction: ComponentInteraction,
  ctx: AppContext,
  userId: number,
  groupId: number,
  week: string,
  groupName: string,
): Promise<void> {
  await interaction.deferUpdate();

  await optOut(ctx, { userId, groupId, weekStartDate: week });

  // No follow-up questions. No "are you sure". No guilt. The components are
  // stripped so the flow is visibly over.
  await interaction.editReply({
    content: [
      `**Noted — you're out for the week of ${formatWeekLabel(week)}.**`,
      '',
      `Nobody will nudge you about ${groupName} again until next week.`,
      'Changed your mind? `/availability` reopens it any time.',
    ].join('\n'),
    components: [],
  });
}

async function handleOptIn(
  interaction: ComponentInteraction,
  ctx: AppContext,
  userId: number,
  groupId: number,
  week: string,
): Promise<void> {
  await interaction.deferUpdate();

  const { draft } = await startOrResumeFlow(ctx, { userId, groupId, weekStartDate: week });

  // Step 3 replaces this with the day picker. Until then, confirm the draft
  // exists so the round trip is verifiable end to end.
  await interaction.editReply({
    content: [
      `**Great — let's find you a session.** (week of ${formatWeekLabel(week)})`,
      '',
      'The day and window pickers land in the next build step.',
    ].join('\n'),
    components: [],
  });

  ctx.logger.debug('weekly flow started', { draftId: draft.id, userId, groupId });
}

registerComponentHandler('av', handle);
