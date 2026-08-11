/**
 * The DM's entry point: which server are you answering for?
 *
 * `/availability` is guild-scoped by construction - every write is keyed to a
 * group_id - so running it from a DM has to resolve that ambiguity before
 * anything else can happen. Buttons rather than a select menu because the
 * common case is two or three servers, and a button is one tap where a select
 * is two.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type InteractionEditReplyOptions,
} from 'discord.js';
import { encodeCustomId, toBase36 } from '../customId.js';

/** 5 buttons per row, 4 rows kept for servers, 1 for the defaults action. */
export const MAX_PICKABLE_SERVERS = 20;

export function serverPickerView(params: {
  groups: { id: number; name: string }[];
  hasDefaults: boolean;
}): InteractionEditReplyOptions {
  const listed = params.groups.slice(0, MAX_PICKABLE_SERVERS);

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < listed.length; index += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        listed.slice(index, index + 5).map((group) =>
          new ButtonBuilder()
            .setCustomId(encodeCustomId('av', 'pick', toBase36(group.id)))
            .setLabel(group.name.slice(0, 80))
            .setStyle(ButtonStyle.Primary),
        ),
      ),
    );
  }

  // Only offered when there is a template to apply - a button that would answer
  // "you have not set any defaults" is a worse outcome than no button.
  if (params.hasDefaults && rows.length < 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(encodeCustomId('av', 'applyall'))
          .setLabel('Apply my defaults everywhere')
          .setStyle(ButtonStyle.Success),
      ),
    );
  }

  const overflow = params.groups.length - listed.length;

  return {
    content: [
      '**Which server are you answering for?**',
      '',
      'Your answers are per-server, because each one plans its own sessions.',
      ...(overflow > 0 ? ['', `_Showing ${listed.length} of ${params.groups.length}._`] : []),
    ].join('\n'),
    // No flags: the caller has already deferred ephemerally, and this is an
    // editReply payload rather than a fresh reply.
    components: rows,
  };
}
