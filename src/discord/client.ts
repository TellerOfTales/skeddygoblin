import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { requireDiscordConfig } from '../config.js';
import { logger } from '../logger.js';

/**
 * Intents: Guilds ONLY. No privileged intents, deliberately.
 *
 * The obvious way to build the status roster is to fetch the guild member list,
 * which needs the privileged GUILD_MEMBERS intent plus a developer-portal
 * toggle. We avoid it entirely: group membership is opt-in (a Join button on
 * the weekly post), so the roster is group_membership rows - which is more
 * honest anyway, since it lists people who actually play rather than everyone
 * who ever joined the server. Names are rendered as <@id> mentions with pings
 * suppressed, so no member fetch and no stored PII beyond a snowflake.
 *
 * DirectMessages + the Channel partial are needed to receive component
 * interactions on DMs the bot itself sent.
 */
export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
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
