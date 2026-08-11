import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { AppContext } from '../../services/context.js';
import { resolveActor, promoteFirstMemberToOrganizer } from '../../services/membershipService.js';
import { currentWeek } from '../../services/responseService.js';
import { sendWeeklyPrompt } from '../../services/weeklyFlowService.js';
import { broadcastWeeklyPrompt } from '../guildBroadcast.js';
import { listMyGroups } from '../../services/membershipService.js';
import { getDefaults } from '../../services/personalDefaultsService.js';
import { serverPickerView } from '../views/serverPicker.view.js';
import { startFlowInPlace } from '../components/availabilityFlow.js';

/**
 * The DM path. Every write is keyed to a group_id, so the ambiguity a DM
 * introduces has to be resolved before anything can happen: one server goes
 * straight in, several offer a picker.
 */
async function runFromDm(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void> {
  const mine = await listMyGroups(ctx, interaction.user.id);

  // Unknown account is a different situation from "in no groups", and saying
  // the wrong one would tell someone they had been removed from something.
  if (!mine) {
    await interaction.editReply(
      [
        "I don't know you yet 🧌",
        '',
        'Run `/availability` once in a server I am in, and after that you can do it from here.',
      ].join('\n'),
    );
    return;
  }

  if (mine.groups.length === 0) {
    await interaction.editReply(
      'You are not in any servers with me yet. Run `/availability` in one and I will remember you.',
    );
    return;
  }

  if (mine.groups.length === 1) {
    // No question to ask, so do not ask it.
    await startFlowInPlace(ctx, interaction, mine.groups[0]!.id);
    return;
  }

  const defaults = await getDefaults(ctx, mine.userId);
  await interaction.editReply(
    serverPickerView({ groups: mine.groups, hasDefaults: defaults.slots.length > 0 }),
  );
}

export const data = new SlashCommandBuilder()
  .setName('availability')
  .setDescription("Tell Skeddy Goblin when you're around this week (takes under two minutes)")
  // Usable in a DM, where it asks which server first. /status, /overlap,
  // /setup and /propose stay guild-only: they are inherently about one group
  // and a DM has no way to say which.
  .setDMPermission(true);

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
): Promise<void> {
  // Always defer first. A cold pool or a GC pause is enough to blow the 3s ack
  // window, and "This interaction failed" is user-visible and unrecoverable.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.guildId) {
    await runFromDm(interaction, ctx);
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
