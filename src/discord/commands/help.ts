import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { requireDiscordConfig } from '../../config.js';
import type { AppContext } from '../../services/context.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('What Skeddy Goblin does, and how to use it')
  .setDMPermission(true);

export async function execute(
  interaction: ChatInputCommandInteraction,
  _ctx: AppContext,
): Promise<void> {
  // Ephemeral: help is for the person who asked, and a channel does not need a
  // copy of it every time somebody is curious.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { inviteUrl, websiteUrl } = requireDiscordConfig();

  await interaction.editReply(
    [
      "**Skeddy Goblin** finds when you're all free and what you all own. 🧌",
      '',
      '`/availability` — answer for this week. Two minutes, or one tap to sit it out.',
      '`/overlap` — the windows that work for the most people, and games to match',
      '`/status` — who has answered, and a nudge for whoever has not',
      '`/games` — what your shared Steam libraries have in common',
      '`/link-steam` — connect your library (only counts are ever shown, never who owns what)',
      '`/propose` — nominate a game, with a live price',
      '`/setup` — organiser: timezone, channel, cutoff day, storefront country',
      '',
      'Your own answers are never shown to anyone. The group only ever sees totals.',
      '',
      `[Add Skeddy to another server](${inviteUrl}) · [How it works](${websiteUrl})`,
    ].join('\n'),
  );
}
