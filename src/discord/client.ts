import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { requireDiscordConfig } from '../config.js';
import { logger } from '../logger.js';

/**
 * Intents: Guilds, DirectMessages, and - deliberately, with eyes open -
 * the privileged GuildMembers.
 *
 * The original design avoided GuildMembers entirely: membership was opt-in, so
 * the roster listed people who actually play rather than everyone who ever
 * joined the server. That is still the more honest roster, but it cannot
 * satisfy the thing this bot is FOR: one person running /availability should
 * pull the whole group in, not just themselves. Without the member list the bot
 * has no way to learn who to ask.
 *
 * The cost is real and worth stating: GuildMembers must be toggled on in the
 * Discord developer portal, and a bot in 100+ servers needs verification to
 * keep it. What we do with it stays narrow - fetch snowflakes, store snowflakes,
 * DM them. No names, no avatars, no presence; the roster still renders <@id>
 * with pings suppressed and still stores no PII beyond the id.
 *
 * DirectMessages + the Channel partial are needed to receive component
 * interactions on DMs the bot itself sent.
 */
export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel],
  });
}

export function loginAndWaitReady(client: Client): Promise<Client<true>> {
  const { token } = requireDiscordConfig();

  return new Promise((resolve, reject) => {
    client.once(Events.ClientReady, (ready) => {
      logger.info('discord client ready', {
        user: ready.user.tag,
        guilds: ready.guilds.cache.size,
      });
      resolve(ready);
    });
    client.once(Events.Error, reject);
    client.login(token).catch(reject);
  });
}
