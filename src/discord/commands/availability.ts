import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { AppContext } from '../../services/context.js';
import { resolveActor, promoteFirstMemberToOrganizer } from '../../services/membershipService.js';
import { currentWeek } from '../../services/responseService.js';
import { sendWeeklyPrompt } from '../../services/weeklyFlowService.js';
import { broadcastWeeklyPrompt } from '../guildBroadcast.js';

export const data = new SlashCommandBuilder()
  .setName('availability')
  .setDescription("Tell Skeddy Goblin when you're around this week (takes under two minutes)")
  .setDMPermission(false);

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
): Promise<void> {
  // Always defer first. A cold pool or a GC pause is enough to blow the 3s ack
  // window, and "This interaction failed" is user-visible and unrecoverable.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.guildId) {
    await interaction.editReply('Run this in a server, not a DM.');
    return;
  }

  const actor = await resolveActor(ctx, {
    discordUserId: interaction.user.id,
    discordGuildId: interaction.guildId,
    guildName: interaction.guild?.name ?? 'this server',
    announceChannelId: interaction.channelId,
  });
  await promoteFirstMemberToOrganizer(ctx, actor.group.id, actor.user.id);

  const week = currentWeek(ctx, actor.group.timezone);

  // The prompt itself goes out through notify(), not through a direct DM call.
  // That is what will let the same prompt arrive over SMS later without
  // touching this command.
  const result = await sendWeeklyPrompt(ctx, {
    user: actor.user,
    group: actor.group,
    weekStartDate: week,
  });

  // One person asking pulls the whole server in - that is the point of the
  // command. Deliberately NOT awaited: enrolling and DMing everyone takes far
  // longer than the interaction token lives, and the person who ran this should
  // not wait on other people's DMs. Exactly-once-per-week is enforced inside,
  // by a job_run claim, so a second /availability this week is a no-op.
  if (interaction.guild) {
    void broadcastWeeklyPrompt(ctx, {
      guild: interaction.guild,
      group: actor.group,
      week,
      excludeUserId: actor.user.id,
    });
  }

  if (result.ok) {
    await interaction.editReply(
      [
        "Sent you a DM. 🧌 It's two taps if this week is a write-off.",
        '',
        "I'm asking everyone else in the server too — once a week, so nobody gets pestered.",
      ].join('\n'),
    );
    return;
  }

  if (result.reason === 'dm_closed') {
    await interaction.editReply(
      [
        "I couldn't DM you — your direct messages are closed for this server.",
        '',
        'Open **Privacy Settings → Direct Messages** for this server and run `/availability` again.',
      ].join('\n'),
    );
    return;
  }

  await interaction.editReply('Something went wrong sending that. Try again in a moment.');
}
