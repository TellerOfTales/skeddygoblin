import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { requireDiscordConfig } from '../../config.js';
import type { AppContext } from '../../services/context.js';

export const data = new SlashCommandBuilder()
  .setName('invite')
  .setDescription('Get the link to add Skeddy Goblin to another server')
  .setDMPermission(true);

export async function execute(
  interaction: ChatInputCommandInteraction,
  _ctx: AppContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { inviteUrl, websiteUrl } = requireDiscordConfig();

  await interaction.editReply(
    [
      '**Add Skeddy Goblin to a server** 🧌',
      '',
      inviteUrl,
      '',
      'You need **Manage Server** on the server you are adding it to. Everyone else just uses it.',
      '',
      `[How it works, terms and privacy](${websiteUrl})`,
    ].join('\n'),
  );
}
