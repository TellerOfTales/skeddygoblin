import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { AppContext } from '../../services/context.js';

export const data = new SlashCommandBuilder()
  .setName('availability')
  .setDescription("Tell Skeddy Goblin when you're around this week (takes under two minutes)")
  .setDMPermission(false);

export async function execute(
  interaction: ChatInputCommandInteraction,
  _ctx: AppContext,
): Promise<void> {
  // Always defer first. A cold pool or a GC pause is enough to blow the 3s ack
  // window, and "This interaction failed" is user-visible and unrecoverable.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await interaction.editReply(
    [
      '**Skeddy Goblin is awake.** 🧌',
      '',
      'The weekly flow lands in the next build step — this is a placeholder so the',
      'command round trip can be verified end to end.',
    ].join('\n'),
  );
}
