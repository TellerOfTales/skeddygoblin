/**
 * Command registration, global plus optionally guild-scoped.
 *
 * GLOBAL is what makes the bot usable in more than one server: guild-scoped
 * commands exist only in the guild they were registered to, so a bot invited
 * anywhere else shows no commands at all - which looks exactly like a broken
 * install.
 *
 * The cost of global is propagation: up to an hour before commands appear.
 * That is why DISCORD_GUILD_ID still exists and still registers a guild-scoped
 * copy alongside: in your own server the commands appear instantly, and Discord
 * shows the guild copy in preference to the global one where the names collide,
 * so nothing is duplicated.
 *
 * Re-run this (`npm run register`) whenever a command definition changes.
 */

import { DiscordAPIError, Events, REST, RESTJSONErrorCodes, Routes } from 'discord.js';
import { requireDiscordConfig } from '../config.js';
import { logger } from '../logger.js';
import { commandPayload } from './commands/index.js';

export async function registerGuildCommands(): Promise<number> {
  const { token, clientId, guildId } = requireDiscordConfig();
  const payload = commandPayload();

  const rest = new REST({ version: '10' }).setToken(token);

  // Global first: this is the registration that matters for every server other
  // than the development one, and it must not be skipped just because a guild
  // registration failed.
  await rest.put(Routes.applicationCommands(clientId), { body: payload });
  logger.info('registered global commands', {
    count: payload.length,
    names: payload.map((command) => command.name),
    note: 'global commands can take up to an hour to appear in a new server',
  });

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: payload });
    logger.info('registered guild commands', { guildId, count: payload.length });
  }

  return payload.length;
}

/**
 * Boot-time registration, which must never be fatal.
 *
 * The bot is invited to a server AFTER it is deployed, so on a first deploy
 * there is a window - possibly a long one - where DISCORD_GUILD_ID names a
 * guild the bot is not in yet. Discord answers that with 50001 Missing Access.
 * Treating it as a boot error turns "you have not clicked the invite link yet"
 * into a crash loop, which is exactly the wrong shape: the process is fine, it
 * is waiting on a human.
 *
 * So: 50001 arms a guildCreate listener and registration happens the moment the
 * bot is invited, with no redeploy. Any other failure is logged loudly and the
 * bot still serves - previously registered commands keep working, and losing
 * the whole bot over a bad command definition helps nobody.
 */
/**
 * Just enough of a Client to hear about a guild join. Narrow on purpose: a test
 * can satisfy this in six lines, where faking Client cannot be done at all.
 */
export interface GuildJoinEmitter {
  on(event: typeof Events.GuildCreate, handler: (guild: { id: string }) => void): unknown;
  off(event: typeof Events.GuildCreate, handler: (guild: { id: string }) => void): unknown;
}

export async function registerGuildCommandsAtBoot(
  client: GuildJoinEmitter,
  // Seam for tests: the retry logic is the part worth testing, and it should be
  // testable without a network.
  register: () => Promise<number> = registerGuildCommands,
): Promise<void> {
  const { guildId } = requireDiscordConfig();

  try {
    await register();
    return;
  } catch (error) {
    const missingAccess =
      error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.MissingAccess;

    if (!missingAccess) {
      logger.error('command registration failed; serving with whatever is already registered', {
        guildId,
        error,
      });
      return;
    }

    logger.warn(
      'not in the configured guild yet, so commands could not be registered - ' +
        'invite the bot with the applications.commands scope and this will retry automatically',
      { guildId },
    );
  }

  // `on`, not `once`: being added to some OTHER server must not consume the
  // listener and leave the configured guild permanently without commands.
  const onJoin = (guild: { id: string }): void => {
    if (guildId === undefined || guild.id !== guildId) return;
    void register()
      .then(() => {
        client.off(Events.GuildCreate, onJoin);
      })
      .catch((error: unknown) => {
        logger.error('command registration failed after joining the guild', { guildId, error });
      });
  };
  client.on(Events.GuildCreate, onJoin);
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
