/**
 * The single outbound-message interface.
 *
 * Every message the bot sends to a *person* goes through here: the weekly
 * prompt, a buzz, a session confirmation. Stage 1 has exactly one
 * implementation (DiscordDMNotifier) and it is the only file in the codebase
 * permitted to call the Discord send API - enforced by an ESLint rule and by
 * the P5 test.
 *
 * The payload is deliberately channel-agnostic: a title, a body, and abstract
 * ActionRefs. It does NOT contain discord.js builders. That is the whole point
 * - it is what makes adding an SMS or WhatsApp notifier additive rather than a
 * refactor of every call site.
 */

import type { NotifyAction } from '../domain/actions.js';

/**
 * Mirrors the preferred_channel Postgres enum (see migration 0002).
 *
 * 'sms' existing here does NOT make it reachable: NotifierRegistry only routes
 * to implementations that were registered at boot, and TwilioSMSNotifier is a
 * scaffold that throws. A user switched to 'sms' today gets a clean
 * channel_unavailable, not a silently swallowed message.
 */
export const PREFERRED_CHANNELS = ['discord_dm', 'sms'] as const;
export type PreferredChannel = (typeof PREFERRED_CHANNELS)[number];

/** Every kind of message a person can receive. */
export const MESSAGE_TYPES = [
  'weekly_prompt',
  'buzz',
  'session_confirmed',
  'session_proposed',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface NotifyPayload {
  title: string;
  body: string;
  actions?: NotifyAction[];
}

/** The subset of a user a notifier needs. Never the whole record. */
export interface NotifiableUser {
  id: number;
  discordId: string;
  preferredChannel: PreferredChannel;
  phoneE164: string | null;
}

/**
 * Delivery outcome.
 *
 * Structured rather than a thrown error because callers must distinguish
 * "undeliverable" from other failures. The buzz service in particular treats a
 * closed DM differently from a bug: an undeliverable buzz must not burn the
 * target's once-per-day quota.
 */
export type NotifyFailureReason =
  /** Discord 50007: recipient has DMs closed, or shares no guild with the bot. */
  | 'dm_closed'
  /** The channel this user prefers has no implementation registered. */
  | 'channel_unavailable'
  /** Anything else - network, rate limit exhaustion, unexpected API error. */
  | 'unknown';

export type NotifyResult =
  | { ok: true; channel: PreferredChannel }
  | { ok: false; reason: NotifyFailureReason; detail?: string };

export interface Notifier {
  /** Which preferred_channel value this implementation serves. */
  readonly channel: PreferredChannel;

  notify(user: NotifiableUser, type: MessageType, payload: NotifyPayload): Promise<NotifyResult>;
}
