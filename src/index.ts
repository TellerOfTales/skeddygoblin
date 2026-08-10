/**
 * Boot sequence: config -> pool -> client -> notifier -> context -> HTTP ->
 * migrate -> login -> scheduler.
 *
 * The HTTP server comes BEFORE migrations and login, deliberately. Everything
 * after it can take an unbounded amount of time - a cold managed Postgres, a
 * slow gateway handshake - and a hosting platform that cannot reach /healthz
 * within its window kills the deployment and reports it as a failed health
 * check, which looks nothing like the real cause. Binding the port first means
 * the platform can always tell the process is alive, and /healthz reports which
 * phase it is in.
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
import { registerGuildCommandsAtBoot } from './discord/registerCommands.js';
import { DiscordDMNotifier } from './notify/DiscordDMNotifier.js';
import { NotifierRegistry } from './notify/registry.js';
import { leaderboardView } from './discord/views/leaderboard.view.js';
import { buildOverlapReport } from './services/overlapService.js';
import { startScheduler } from './scheduler/index.js';
import { startHttpServer, type BootPhase } from './http/server.js';
import { config as appConfig } from './config.js';
import { systemClock, type AppContext } from './services/context.js';

async function main(): Promise<void> {
  const discord = requireDiscordConfig();

  // createPool() does not connect - the first query does - so nothing here can
  // block the port from binding a few lines below.
  const pool = createPool();

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

  let phase: BootPhase = 'starting';
  const httpServer = startHttpServer(ctx, appConfig.httpPort, () => phase);

  phase = 'migrating';
  const migration = await migrate(pool, (message) => logger.info(message));
  logger.info('database ready', {
    applied: migration.applied.length,
    total: migration.applied.length + migration.alreadyApplied.length,
  });

  phase = 'connecting-to-discord';
  const ready = await loginAndWaitReady(client);

  // After login, not before: registration needs the bot to actually be in the
  // guild, and having a live client is what lets a "not invited yet" failure
  // resolve itself on guildCreate instead of needing a redeploy.
  if (discord.autoRegisterCommands) {
    phase = 'registering-commands';
    await registerGuildCommandsAtBoot(ready);
  }

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

  phase = 'ready';

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    scheduler?.stop();
    httpServer.close();
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

// Without these, a rejected promise outside the boot chain - a gateway error
// after login, say - terminates Node with a bare stack trace that a hosting
// platform's log viewer routinely truncates or drops. Logging it through the
// same serializer means it is redacted and shaped like every other line.
process.on('unhandledRejection', (error: unknown) => {
  logger.error('unhandled rejection', { error });
});
process.on('uncaughtException', (error: unknown) => {
  logger.error('uncaught exception', { error });
  process.exit(1);
});

main().catch((error: unknown) => {
  logger.error('fatal boot error', { error });
  process.exit(1);
});
