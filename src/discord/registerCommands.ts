/**
 * Guild-scoped command registration.
 *
 * Guild-scoped ONLY during development: it propagates instantly, where global
 * registration can take up to an hour. The brief forbids global commands at
 * this stage, and config.ts makes DISCORD_GUILD_ID required so there is no
 * quiet path into registering them.
 *
 * Re-run this (`npm run register`) whenever a command definition changes.
 */

import { REST, Routes } from 'discord.js';
import { requireDiscordConfig } from '../config.js';
import { logger } from '../logger.js';
import { commandPayload } from './commands/index.js';

export async function registerGuildCommands(): Promise<number> {
  const { token, clientId, guildId } = requireDiscordConfig();
  const payload = commandPayload();

  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: payload });

  logger.info('registered guild commands', {
    guildId,
    count: payload.length,
    names: payload.map((command) => command.name),
  });
  return payload.length;
}

const isCli = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isCli) {
  try {
    await registerGuildCommands();
  } catch (error) {
    logger.error('command registration failed', { error });
    process.exitCode = 1;
  }
}
