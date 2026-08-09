import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { AppContext } from '../../services/context.js';
import { resolveActor } from '../../services/membershipService.js';
import { beginLink, steamEnabled } from '../../services/steamService.js';

export const data = new SlashCommandBuilder()
  .setName('link-steam')
  .setDescription('Connect your Steam library so the group can find games you all own')
  .setDMPermission(false);

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!steamEnabled()) {
    await interaction.editReply(
      'Steam is not configured on this deployment yet. Ask whoever runs the bot to set `STEAM_API_KEY` and `PUBLIC_BASE_URL`.',
    );
    return;
  }

  if (!interaction.guildId) {
    await interaction.editReply('Run this in a server, not a DM.');
    return;
  }

  const actor = await resolveActor(ctx, {
    discordUserId: interaction.user.id,
    discordGuildId: interaction.guildId,
    guildName: interaction.guild?.name ?? 'this server',
  });

  const url = await beginLink(ctx, actor.user.id);

  await interaction.editReply({
    content: [
      '**Connect Steam**',
      '',
      'This is a one-time, single-use link that expires in 30 minutes.',
      'Your group only ever sees how MANY of you own a game — never whose library it came from.',
    ].join('\n'),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel('Sign in through Steam')
          .setStyle(ButtonStyle.Link)
          .setURL(url),
      ),
    ],
  });
}
