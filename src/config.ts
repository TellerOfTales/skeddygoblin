/**
 * The single reader of process.env in the codebase (enforced by an ESLint
 * rule). Validates at import time and exits with a readable list of every
 * problem at once, so four missing variables are one fix rather than four
 * restarts.
 *
 * Validation is SCOPED to what an entrypoint actually needs. Core settings
 * (database, logging) are validated eagerly because everything needs them;
 * Discord and Steam credentials are validated on first use, so `npm run
 * migrate` does not demand a bot token it will never use.
 */

import { config as loadDotenv } from 'dotenv';
import { isValidTimezone } from './domain/week.js';

if (process.env.NODE_ENV !== 'production') {
  loadDotenv({ quiet: true });
}

const SNOWFLAKE = /^\d{17,20}$/;

class ConfigCollector {
  private readonly problems: string[] = [];

  required(name: string): string {
    const value = process.env[name];
    if (!value || value.trim() === '') {
      this.problems.push(`${name} is required but missing or empty`);
      return '';
    }
    return value.trim();
  }

  optional(name: string): string | undefined {
    const value = process.env[name];
    return value && value.trim() !== '' ? value.trim() : undefined;
  }

  snowflake(name: string): string {
    const value = this.required(name);
    if (value && !SNOWFLAKE.test(value)) {
      this.problems.push(`${name} must be a Discord snowflake (17-20 digits), got "${value}"`);
    }
    return value;
  }

  optionalSnowflake(name: string): string | undefined {
    const value = this.optional(name);
    if (value && !SNOWFLAKE.test(value)) {
      this.problems.push(`${name} must be a Discord snowflake (17-20 digits), got "${value}"`);
    }
    return value;
  }

  postgresUrl(name: string): string {
    const value = this.required(name);
    if (!value) return value;
    try {
      const url = new URL(value);
      if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
        this.problems.push(`${name} must be a postgres:// URL, got protocol "${url.protocol}"`);
      }
    } catch {
      this.problems.push(`${name} is not a valid URL`);
    }
    return value;
  }

  timezone(name: string, fallback: string): string {
    const value = this.optional(name) ?? fallback;
    if (!isValidTimezone(value)) {
      this.problems.push(`${name} is not a known IANA timezone: "${value}"`);
    }
    return value;
  }

  boolean(name: string, fallback: boolean): boolean {
    const value = this.optional(name);
    if (value === undefined) return fallback;
    if (['true', '1', 'yes'].includes(value.toLowerCase())) return true;
    if (['false', '0', 'no'].includes(value.toLowerCase())) return false;
    this.problems.push(`${name} must be true or false, got "${value}"`);
    return fallback;
  }

  integer(name: string, fallback: number, min: number, max: number): number {
    const value = this.optional(name);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      this.problems.push(`${name} must be an integer between ${min} and ${max}, got "${value}"`);
      return fallback;
    }
    return parsed;
  }

  oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const value = this.optional(name);
    if (value === undefined) return fallback;
    if (!(allowed as readonly string[]).includes(value)) {
      this.problems.push(`${name} must be one of ${allowed.join(', ')}, got "${value}"`);
      return fallback;
    }
    return value as T;
  }

  /** Reports every problem at once, then exits. Never boots half-configured. */
  failFast(scope: string): void {
    if (this.problems.length === 0) return;
    console.error(`\n${scope} configuration is invalid:\n`);
    for (const problem of this.problems) console.error(`  - ${problem}`);
    console.error('\nSee .env.example for the full list of settings.\n');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Secrets registry
// ---------------------------------------------------------------------------

const secrets = new Set<string>();

function registerSecret(value: string | undefined): void {
  if (value && value.length > 0) secrets.add(value);
}

/** Values the logger must redact. Grows as scoped configs are resolved. */
export function knownSecrets(): readonly string[] {
  return [...secrets];
}

// ---------------------------------------------------------------------------
// Core config - validated eagerly, needed by every entrypoint
// ---------------------------------------------------------------------------

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const core = new ConfigCollector();

export const config = Object.freeze({
  nodeEnv: core.oneOf('NODE_ENV', ['development', 'test', 'production'] as const, 'development'),
  logLevel: core.oneOf('LOG_LEVEL', LOG_LEVELS, 'info'),

  database: Object.freeze({
    url: core.postgresUrl('DATABASE_URL'),
    ssl: core.boolean('DATABASE_SSL', false),
    poolMax: core.integer('DATABASE_POOL_MAX', 10, 1, 100),
  }),

  scheduler: Object.freeze({
    enabled: core.boolean('SCHEDULER_ENABLED', false),
    tickIntervalMs: core.integer('TICK_INTERVAL_MS', 60_000, 1_000, 3_600_000),
  }),

  defaultGroupTimezone: core.timezone('DEFAULT_GROUP_TIMEZONE', 'UTC'),

  /** Port for the Steam OpenID callback server. Unused until Steam is set up. */
  httpPort: core.integer('HTTP_PORT', 8080, 1, 65_535),
});

core.failFast('Core');

// ---------------------------------------------------------------------------
// Discord config - validated on first use
// ---------------------------------------------------------------------------

export interface DiscordConfig {
  token: string;
  clientId: string;
  guildId: string;
  announceChannelId: string | undefined;
  autoRegisterCommands: boolean;
}

let discordConfig: DiscordConfig | undefined;

export function requireDiscordConfig(): DiscordConfig {
  if (discordConfig) return discordConfig;

  const c = new ConfigCollector();
  const resolved: DiscordConfig = {
    token: c.required('DISCORD_TOKEN'),
    clientId: c.snowflake('DISCORD_CLIENT_ID'),
    /**
     * Required, deliberately. Stage 1 registers guild-scoped commands only, and
     * a missing guild id is the exact failure that tempts you into registering
     * globally - which the brief forbids and which takes an hour to propagate.
     */
    guildId: c.snowflake('DISCORD_GUILD_ID'),
    announceChannelId: c.optionalSnowflake('ANNOUNCE_CHANNEL_ID'),
    autoRegisterCommands: c.boolean('AUTO_REGISTER_COMMANDS', false),
  };
  c.failFast('Discord');

  registerSecret(resolved.token);
  discordConfig = Object.freeze(resolved);
  return discordConfig;
}

// ---------------------------------------------------------------------------
// Steam config (Stage 2) - validated on first use
// ---------------------------------------------------------------------------

export interface SteamConfig {
  apiKey: string;
  publicBaseUrl: string;
}

let steamConfig: SteamConfig | undefined;

/** Returns undefined when Steam is not configured, so Stage 1 runs untouched. */
export function optionalSteamConfig(): SteamConfig | undefined {
  if (steamConfig) return steamConfig;

  const apiKey = process.env.STEAM_API_KEY?.trim();
  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim();
  if (!apiKey || !publicBaseUrl) return undefined;

  registerSecret(apiKey);
  steamConfig = Object.freeze({ apiKey, publicBaseUrl: publicBaseUrl.replace(/\/$/, '') });
  return steamConfig;
}

export type Config = typeof config;
