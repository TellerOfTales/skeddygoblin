/**
 * What happens the second Skeddy is added to a server.
 *
 * Nobody reads a README, and a bot that requires a setup command nobody knows
 * exists is a bot that never gets used. This posts once, unprompted, with
 * everything already configured to a sensible default.
 *
 * Never throws. A server that cannot be posted in is a bad first impression,
 * not a reason to take the process down.
 */

import { ChannelType, PermissionsBitField, type Client, type Guild } from 'discord.js';
import { requireDiscordConfig, config } from '../config.js';
import { ensureGroupForGuild } from '../services/membershipService.js';
import { welcomeView } from './views/onboarding.view.js';
import type { AppContext } from '../services/context.js';

/**
 * Discord's locale is a language, not a place, so it cannot give a timezone.
 * This maps the handful that are unambiguous and falls back to the configured
 * default - a wrong guess would be worse than a neutral one, and /setup fixes
 * it in one command either way.
 */
const LOCALE_TIMEZONES: Record<string, string> = {
  'en-GB': 'Europe/London',
  de: 'Europe/Berlin',
  fr: 'Europe/Paris',
  es: 'Europe/Madrid',
  'es-ES': 'Europe/Madrid',
  it: 'Europe/Rome',
  nl: 'Europe/Amsterdam',
  'pt-BR': 'America/Sao_Paulo',
  ja: 'Asia/Tokyo',
  ko: 'Asia/Seoul',
  'zh-CN': 'Asia/Shanghai',
  ru: 'Europe/Moscow',
  pl: 'Europe/Warsaw',
  sv: 'Europe/Stockholm',
  tr: 'Europe/Istanbul',
};

function guessTimezone(guild: Guild): string {
  return LOCALE_TIMEZONES[guild.preferredLocale] ?? config.defaultGroupTimezone;
}

/** The first channel we can actually post in, preferring the obvious ones. */
function firstPostableChannel(
  guild: Guild,
): { id: string; send: (p: unknown) => Promise<unknown> } | null {
  const me = guild.members.me;
  if (!me) return null;

  const candidates = [
    guild.systemChannel,
    ...guild.channels.cache
      .filter((channel) => channel.type === ChannelType.GuildText)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .values(),
  ];

  for (const channel of candidates) {
    if (!channel || channel.type !== ChannelType.GuildText) continue;
    const permissions = channel.permissionsFor(me);
    if (
      permissions?.has(PermissionsBitField.Flags.ViewChannel) &&
      permissions.has(PermissionsBitField.Flags.SendMessages) &&
      permissions.has(PermissionsBitField.Flags.EmbedLinks)
    ) {
      return channel as unknown as { id: string; send: (p: unknown) => Promise<unknown> };
    }
  }
  return null;
}

export async function onGuildJoined(ctx: AppContext, guild: Guild): Promise<void> {
  try {
    const channel = firstPostableChannel(guild);
    const timezone = guessTimezone(guild);

    // Created with defaults so the bot is usable immediately; /setup changes
    // them rather than switching anything on.
    const group = await ensureGroupForGuild(ctx, {
      discordGuildId: guild.id,
      name: guild.name,
      timezone,
      ...(channel ? { announceChannelId: channel.id } : {}),
    });

    ctx.logger.info('joined a server', {
      guildId: guild.id,
      groupId: group.id,
      timezone,
      posted: channel !== null,
    });

    if (!channel) {
      ctx.logger.warn('joined a server with nowhere to post', { guildId: guild.id });
      return;
    }

    await channel.send(
      welcomeView({
        groupId: group.id,
        timezone,
        websiteUrl: requireDiscordConfig().websiteUrl,
      }),
    );
  } catch (error) {
    ctx.logger.error('onboarding failed', { guildId: guild.id, error });
  }
}

export function registerOnboarding(ctx: AppContext, client: Client): void {
  client.on('guildCreate', (guild) => {
    void onGuildJoined(ctx, guild);
  });
}
