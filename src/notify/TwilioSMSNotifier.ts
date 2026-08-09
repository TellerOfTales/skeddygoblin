/**
 * SCAFFOLD ONLY - not integrated.
 *
 * This file exists to prove the notifier abstraction actually holds: a second
 * channel compiles against the same interface, consumes the same
 * channel-agnostic payload, and needs no change at any call site. Adding real
 * Twilio later means filling in send() and registering this in src/index.ts.
 * Nothing else moves.
 *
 * Note what it does with `actions`: the same ActionRefs that DiscordDMNotifier
 * renders as buttons become a numbered reply menu. That is the payoff for
 * having refused to put discord.js builders in the payload - if the payload had
 * carried them, this file could not exist without a refactor.
 */

import { NotImplementedError } from '../domain/errors.js';
import type { ActionRef } from '../domain/actions.js';
import type {
  MessageType,
  NotifiableUser,
  Notifier,
  NotifyPayload,
  NotifyResult,
  PreferredChannel,
} from './Notifier.js';

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export class TwilioSMSNotifier implements Notifier {
  readonly channel: PreferredChannel = 'sms';

  constructor(private readonly credentials: TwilioCredentials) {}

  async notify(
    user: NotifiableUser,
    _type: MessageType,
    payload: NotifyPayload,
  ): Promise<NotifyResult> {
    if (!user.phoneE164) {
      return { ok: false, reason: 'channel_unavailable', detail: 'no phone number on file' };
    }

    // Rendering already works; only delivery is missing.
    const body = renderSms(payload);
    void body;
    void this.credentials;

    throw new NotImplementedError('TwilioSMSNotifier.notify');
  }
}

/**
 * Flattens a payload into SMS text, turning actions into numbered replies.
 *
 * Exported and tested, so the abstraction is demonstrably channel-agnostic
 * rather than merely claimed to be.
 */
export function renderSms(payload: NotifyPayload): string {
  const lines = [payload.title, stripMarkdown(payload.body)];

  if (payload.actions && payload.actions.length > 0) {
    lines.push('');
    payload.actions.forEach((action, index) => {
      lines.push(`Reply ${index + 1} — ${action.label}`);
    });
  }

  return lines.filter((line) => line !== undefined).join('\n');
}

/** Maps a numbered SMS reply back onto the action it stands for. */
export function resolveSmsReply(payload: NotifyPayload, reply: string): ActionRef | undefined {
  const index = Number.parseInt(reply.trim(), 10);
  if (!Number.isInteger(index)) return undefined;
  return payload.actions?.[index - 1]?.action;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\n{2,}/g, '\n');
}
