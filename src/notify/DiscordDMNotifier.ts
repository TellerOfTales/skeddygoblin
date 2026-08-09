/**
 * The ONLY file in the codebase permitted to call the Discord send API.
 *
 * Two guards enforce that: an ESLint rule that lists this file as its sole
 * exemption, and the P5 test which scans source for send sites. If you find
 * yourself wanting to DM someone from anywhere else, call notify() instead.
 *
 * This is also where channel-neutral ActionRefs become Discord custom_ids. The
 * translation lives here, not in the caller, so a second notifier can map the
 * same ActionRefs onto a completely different interaction model.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  type Client,
  type MessageCreateOptions,
} from 'discord.js';
import type {
  NotifiableUser,
  Notifier,
  NotifyPayload,
  NotifyResult,
  MessageType,
  PreferredChannel,
} from './Notifier.js';
import type { ActionRef, ActionStyle } from '../domain/actions.js';
import { encodeCustomId, toBase36 } from '../discord/customId.js';
import { assertLegalMessage } from '../discord/componentLimits.js';
import type { Logger } from '../logger.js';

/** Discord: recipient has DMs closed, or shares no guild with the bot. */
const CANNOT_SEND_TO_USER = 50007;

/**
 * ActionRef -> custom_id.
 *
 * Exported because the component handlers must decode exactly what this
 * encodes; a round-trip test pins the two together.
 */
export function actionRefToCustomId(ref: ActionRef): string {
  switch (ref.kind) {
    case 'start_weekly_flow':
      return encodeCustomId('av', 'in', toBase36(ref.groupId));
    case 'opt_out_week':
      return encodeCustomId('av', 'optout', toBase36(ref.groupId));
    case 'session_rsvp':
      return encodeCustomId('sess', 'rsvp', toBase36(ref.proposalId), ref.response);
    case 'join_group':
      return encodeCustomId('grp', 'join', toBase36(ref.groupId));
  }
}

/**
 * Only two styles map through, and neither is Danger. An escape hatch can never
 * render red, because there is no ActionStyle that produces it.
 */
function toButtonStyle(style: ActionStyle): ButtonStyle {
  return style === 'primary' ? ButtonStyle.Success : ButtonStyle.Secondary;
}

/** Renders a channel-agnostic payload into a Discord message. */
export function renderPayload(payload: NotifyPayload): MessageCreateOptions {
  const content = payload.title ? `**${payload.title}**\n${payload.body}` : payload.body;

  const message: MessageCreateOptions = { content };

  if (payload.actions && payload.actions.length > 0) {
    const buttons = payload.actions.map((action) =>
      new ButtonBuilder()
        .setCustomId(actionRefToCustomId(action.action))
        .setLabel(action.label)
        .setStyle(toButtonStyle(action.style)),
    );
    message.components = [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
  }

  // Catch a too-long custom_id or an over-full row here rather than as an
  // opaque 400 from the API, in someone's DM.
  assertLegalMessage(message as { components?: unknown[] }, 'DM');

  return message;
}

export class DiscordDMNotifier implements Notifier {
  readonly channel: PreferredChannel = 'discord_dm';

  constructor(
    private readonly client: Client,
    private readonly logger: Logger,
  ) {}

  async notify(
    user: NotifiableUser,
    type: MessageType,
    payload: NotifyPayload,
  ): Promise<NotifyResult> {
    let message: MessageCreateOptions;
    try {
      message = renderPayload(payload);
    } catch (error) {
      this.logger.error('failed to render notification', { type, userId: user.id, error });
      return { ok: false, reason: 'unknown', detail: (error as Error).message };
    }

    try {
      const recipient = await this.client.users.fetch(user.discordId);
      await recipient.send(message);
      this.logger.debug('notification delivered', { type, userId: user.id });
      return { ok: true, channel: this.channel };
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === CANNOT_SEND_TO_USER) {
        // Routine, not a bug: plenty of people have DMs closed.
        this.logger.info('dm closed, notification undelivered', { type, userId: user.id });
        return { ok: false, reason: 'dm_closed' };
      }
      this.logger.error('notification failed', { type, userId: user.id, error });
      return { ok: false, reason: 'unknown', detail: (error as Error).message };
    }
  }
}
