/**
 * Routes a notification to the implementation serving the user's
 * preferred_channel.
 *
 * Stage 1 registers exactly one implementation. The indirection exists now so
 * that adding TwilioSMSNotifier later is a registration line rather than a hunt
 * through call sites - which is the entire reason preferred_channel is on the
 * user record from day one.
 */

import type {
  MessageType,
  NotifiableUser,
  Notifier,
  NotifyPayload,
  NotifyResult,
  PreferredChannel,
} from './Notifier.js';
import type { Logger } from '../logger.js';

export class NotifierRegistry implements Notifier {
  /** The channel used when a user's preference has no implementation. */
  readonly channel: PreferredChannel = 'discord_dm';

  private readonly implementations = new Map<PreferredChannel, Notifier>();

  constructor(private readonly logger: Logger) {}

  register(notifier: Notifier): this {
    this.implementations.set(notifier.channel, notifier);
    return this;
  }

  async notify(
    user: NotifiableUser,
    type: MessageType,
    payload: NotifyPayload,
  ): Promise<NotifyResult> {
    const notifier = this.implementations.get(user.preferredChannel);
    if (!notifier) {
      this.logger.error('no notifier registered for channel', {
        channel: user.preferredChannel,
        userId: user.id,
      });
      return { ok: false, reason: 'channel_unavailable' };
    }
    return notifier.notify(user, type, payload);
  }
}
