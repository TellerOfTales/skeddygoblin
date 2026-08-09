/**
 * Boot sequence: config -> pool -> migrate -> context -> client -> login.
 *
 * Migrations run at boot on purpose. This is a single-instance bot with a
 * roll-forward-only migration set, and the advisory lock inside the runner
 * makes a concurrent start safe; the alternative (a separate deploy step people
 * forget) fails in a much worse way.
 */

import { Events } from 'discord.js';
import { config, requireDiscordConfig } from './config.js';
import { logger } from './logger.js';
import { createDb, createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createClient, loginAndWaitReady } from './discord/client.js';
import { createRouter } from './discord/router.js';
import { registerGuildCommands } from './discord/registerCommands.js';
import { systemClock, type AppContext } from './services/context.js';

async function main(): Promise<void> {
  const discord = requireDiscordConfig();

  const pool = createPool();
  const migration = await migrate(pool, (message) => logger.info(message));
  logger.info('database ready', {
    applied: migration.applied.length,
    total: migration.applied.length + migration.alreadyApplied.length,
  });

  const ctx: AppContext = {
    db: createDb(pool),
    logger,
    clock: systemClock,
  };

  if (discord.autoRegisterCommands) {
    await registerGuildCommands();
  }

  const client = createClient();
  const route = createRouter(ctx);
  client.on(Events.InteractionCreate, (interaction) => {
    void route(interaction);
  });

  await loginAndWaitReady(client);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    await client.destroy();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info('skeddy goblin is up', {
    env: config.nodeEnv,
    guildId: discord.guildId,
    schedulerEnabled: config.scheduler.enabled,
  });
}

main().catch((error: unknown) => {
  logger.error('fatal boot error', { error });
  process.exit(1);
});
