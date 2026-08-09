/**
 * Boot sequence: config -> pool -> migrate -> client -> notifier -> context ->
 * login.
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
import { registerAllComponentHandlers } from './discord/components/registerAll.js';
import { registerGuildCommands } from './discord/registerCommands.js';
import { DiscordDMNotifier } from './notify/DiscordDMNotifier.js';
import { NotifierRegistry } from './notify/registry.js';
import { leaderboardView } from './discord/views/leaderboard.view.js';
import { buildOverlapReport } from './services/overlapService.js';
import { startScheduler } from './scheduler/index.js';
import { startHttpServer } from './http/server.js';
import { config as appConfig } from './config.js';
import { systemClock, type AppContext } from './services/context.js';

async function main(): Promise<void> {
  const discord = requireDiscordConfig();

  const pool = createPool();
  const migration = await migrate(pool, (message) => logger.info(message));
  logger.info('database ready', {
    applied: migration.applied.length,
    total: migration.applied.length + migration.alreadyApplied.length,
  });

  if (discord.autoRegisterCommands) {
    await registerGuildCommands();
  }

  const client = createClient();
  registerAllComponentHandlers();

  // The registry is what makes preferred_channel meaningful. Stage 1 registers
  // exactly one implementation; adding an SMS notifier later is one more
  // .register() call rather than a change at any call site.
  const notifier = new NotifierRegistry(logger).register(new DiscordDMNotifier(client, logger));

  const ctx: AppContext = {
    db: createDb(pool),
    logger,
    clock: systemClock,
    notifier,
  };

  const route = createRouter(ctx);
  client.on(Events.InteractionCreate, (interaction) => {
    void route(interaction);
  });

  const ready = await loginAndWaitReady(client);

  // Posting is the one scheduler job that genuinely needs a Discord channel, so
  // it is injected rather than reached for from inside the service layer.
  const scheduler = await startScheduler(ctx, {
    async postCutoff(group, week) {
      if (!group.announceChannelId) {
        logger.warn('cutoff due but no announce channel configured', { groupId: group.id });
        return;
      }
      const channel = await ready.channels.fetch(group.announceChannelId);
      if (!channel?.isTextBased() || !('send' in channel)) {
        logger.warn('announce channel is not postable', { groupId: group.id });
        return;
      }

      const report = await buildOverlapReport(ctx, { groupId: group.id, weekStartDate: week });
      await channel.send(
        leaderboardView({
          groupId: group.id,
          groupName: group.name,
          weekStartDate: report.weekStartDate,
          windows: report.windows,
          responded: report.responded,
          total: report.total,
          topVibes: report.topVibes,
          suppressedForPrivacy: report.suppressedForPrivacy,
          showLockIn: true,
        }),
      );
    },
  });

  // Stage 2 only: starts nothing unless STEAM_API_KEY and PUBLIC_BASE_URL are set.
  const httpServer = startHttpServer(ctx, appConfig.httpPort);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    scheduler?.stop();
    httpServer?.close();
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
