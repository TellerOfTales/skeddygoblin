/**
 * The failure this guards against, seen on a real first deploy:
 *
 *   DiscordAPIError[50001]: Missing Access
 *     at async registerGuildCommands
 *     at async main
 *
 * The bot is invited to a server AFTER it is deployed, so on a first deploy
 * DISCORD_GUILD_ID names a guild the bot is not in yet. That threw out of
 * main(), which exited 1, which the platform restarted - a crash loop whose
 * actual cause was "nobody has clicked the invite link yet".
 */

import { DiscordAPIError, Events, RESTJSONErrorCodes } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

// Set before the module under test is loaded, hence the dynamic import below:
// requireDiscordConfig() reads these on first call and caches the result.
process.env.DISCORD_TOKEN ??= 'test-token';
process.env.DISCORD_CLIENT_ID ??= '100000000000000001';
process.env.DISCORD_GUILD_ID ??= '100000000000000002';

const GUILD_ID = process.env.DISCORD_GUILD_ID;

const { registerGuildCommandsAtBoot } = await import('../../src/discord/registerCommands.js');

function missingAccess(): DiscordAPIError {
  return new DiscordAPIError(
    { code: RESTJSONErrorCodes.MissingAccess, message: 'Missing Access' },
    RESTJSONErrorCodes.MissingAccess,
    403,
    'PUT',
    'https://discord.com/api/v10/applications/x/guilds/y/commands',
    {},
  );
}

/** Records listeners so a guildCreate can be delivered without a gateway. */
function fakeClient() {
  const listeners = new Set<(guild: { id: string }) => void>();
  return {
    on: vi.fn((event: string, handler: (guild: { id: string }) => void) => {
      if (event === Events.GuildCreate) listeners.add(handler);
    }),
    off: vi.fn((event: string, handler: (guild: { id: string }) => void) => {
      if (event === Events.GuildCreate) listeners.delete(handler);
    }),
    joins: (id: string) => {
      for (const handler of [...listeners]) handler({ id });
    },
    listenerCount: () => listeners.size,
  };
}

describe('registerGuildCommandsAtBoot', () => {
  it('does not throw when the bot is not in the guild yet', async () => {
    const client = fakeClient();
    const register = vi.fn<() => Promise<number>>().mockRejectedValue(missingAccess());

    // The whole point: boot survives, so the bot keeps serving and the platform
    // health check does not flap.
    await expect(registerGuildCommandsAtBoot(client, register)).resolves.toBeUndefined();
    expect(client.listenerCount()).toBe(1);
  });

  it('registers the moment the bot is invited, with no redeploy', async () => {
    const client = fakeClient();
    const register = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(missingAccess())
      .mockResolvedValue(7);

    await registerGuildCommandsAtBoot(client, register);
    expect(register).toHaveBeenCalledTimes(1);

    client.joins(GUILD_ID);
    await vi.waitFor(() => {
      expect(register).toHaveBeenCalledTimes(2);
    });

    // ...and the listener retires once it has done its job.
    await vi.waitFor(() => {
      expect(client.listenerCount()).toBe(0);
    });
  });

  it('keeps waiting when the bot is added to some other server', async () => {
    const client = fakeClient();
    const register = vi.fn<() => Promise<number>>().mockRejectedValue(missingAccess());

    await registerGuildCommandsAtBoot(client, register);
    client.joins('999999999999999999');

    expect(register).toHaveBeenCalledTimes(1);
    // `once` would have burned the listener here, stranding the real guild.
    expect(client.listenerCount()).toBe(1);
  });

  it('survives a non-access failure too, rather than taking the bot down', async () => {
    const client = fakeClient();
    const register = vi
      .fn<() => Promise<number>>()
      .mockRejectedValue(new Error('invalid command definition'));

    await expect(registerGuildCommandsAtBoot(client, register)).resolves.toBeUndefined();
    // Not a "waiting to be invited" case, so nothing is armed.
    expect(client.listenerCount()).toBe(0);
  });

  it('arms nothing when registration succeeds', async () => {
    const client = fakeClient();
    const register = vi.fn<() => Promise<number>>().mockResolvedValue(7);

    await registerGuildCommandsAtBoot(client, register);
    expect(client.listenerCount()).toBe(0);
  });
});
