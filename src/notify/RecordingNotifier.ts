/**
 * Test double. Records what would have been sent instead of sending it.
 *
 * Services receive their notifier through AppContext, so substituting this
 * needs no module mocking - which is why the DI root exists at all.
 */

import type {
  MessageType,
  NotifiableUser,
  Notifier,
  NotifyFailureReason,
  NotifyPayload,
  NotifyResult,
  PreferredChannel,
} from './Notifier.js';

export interface RecordedNotification {
  user: NotifiableUser;
  type: MessageType;
  payload: NotifyPayload;
}

export class RecordingNotifier implements Notifier {
  readonly channel: PreferredChannel = 'discord_dm';
  readonly sent: RecordedNotification[] = [];

  /** When set, every notify() fails with this reason. */
  failWith: NotifyFailureReason | undefined;

  async notify(
    user: NotifiableUser,
    type: MessageType,
    payload: NotifyPayload,
  ): Promise<NotifyResult> {
    if (this.failWith) {
      return { ok: false, reason: this.failWith };
    }
    this.sent.push({ user, type, payload });
    return { ok: true, channel: this.channel };
  }

  reset(): void {
    this.sent.length = 0;
    this.failWith = undefined;
  }

  countOfType(type: MessageType): number {
    return this.sent.filter((notification) => notification.type === type).length;
  }

  lastTo(userId: number): RecordedNotification | undefined {
    return [...this.sent].reverse().find((notification) => notification.user.id === userId);
  }
}
