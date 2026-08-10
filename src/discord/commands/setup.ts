import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { AppContext } from '../../services/context.js';
import { requireOrganizer, resolveActor } from '../../services/membershipService.js';
import { updateGroupSettings } from '../../services/groupService.js';
import { DAY_LABELS, DAYS, type Day } from '../../domain/constants.js';
import { isValidTimezone } from '../../domain/week.js';

export const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Configure Skeddy Goblin for this server (organizers only)')
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('timezone')
      .setDescription(
        'IANA timezone for the group, e.g. Europe/London. All windows are read in it.',
      )
      .setRequired(false),
  )
  .addChannelOption((option) =>
    option
      .setName('channel')
      .setDescription('Where the weekly roster and leaderboard get posted')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false),
  )
  .addIntegerOption((option) =>
    option
      .setName('cutoff_day')
      .setDescription('Day the nudge cutoff falls on')
      .addChoices(...DAYS.map((day) => ({ name: DAY_LABELS[day], value: day })))
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName('country')
      .setDescription('Two-letter Steam storefront country, e.g. GB. Sets prices and currency.')
      .setMinLength(2)
      .setMaxLength(2)
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName('cutoff_time')
      .setDescription('Cutoff time in the group timezone, HH:MM (default 20:00)')
      .setRequired(false),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.guildId) {
    await interaction.editReply('Run this in a server, not a DM.');
    return;
  }

  const actor = await resolveActor(ctx, {
    discordUserId: interaction.user.id,
    discordGuildId: interaction.guildId,
    guildName: interaction.guild?.name ?? 'this server',
  });
  await requireOrganizer(actor);

  const timezone = interaction.options.getString('timezone') ?? undefined;
  if (timezone && !isValidTimezone(timezone)) {
    await interaction.editReply(
      `\`${timezone}\` is not a known IANA timezone. Try something like \`Europe/London\` or \`America/New_York\`.`,
    );
    return;
  }

  const cutoffTime = interaction.options.getString('cutoff_time') ?? undefined;
  if (cutoffTime && !/^\d{2}:\d{2}$/.test(cutoffTime)) {
    await interaction.editReply('Cutoff time must look like `20:00`.');
    return;
  }

  const country = interaction.options.getString('country')?.toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) {
    await interaction.editReply('Country must be a two-letter code, like `GB` or `US`.');
    return;
  }

  const channel = interaction.options.getChannel('channel');
  const cutoffDay = interaction.options.getInteger('cutoff_day');

  const updated = await updateGroupSettings(ctx, actor.group.id, {
    ...(timezone ? { timezone } : {}),
    ...(channel ? { announceChannelId: channel.id } : {}),
    ...(cutoffDay !== null ? { nudgeCutoffDay: cutoffDay as Day } : {}),
    ...(cutoffTime ? { nudgeCutoffTime: cutoffTime } : {}),
    ...(country ? { countryCode: country } : {}),
  });

  await interaction.editReply(
    [
      `**${updated.name} is set up.**`,
      '',
      `Timezone: \`${updated.timezone}\` — every day and window members pick is read in this zone.`,
      `Announcements: ${updated.announceChannelId ? `<#${updated.announceChannelId}>` : '_not set_'}`,
      `Nudge cutoff: ${DAY_LABELS[updated.nudgeCutoffDay]} at ${updated.nudgeCutoffTime}`,
      `Steam storefront: \`${updated.countryCode}\` — game prices show in this country's currency.`,
    ].join('\n'),
  );
}
