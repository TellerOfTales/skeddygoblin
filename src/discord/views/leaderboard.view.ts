/**
 * The group-facing leaderboard: the only place everyone's private answers
 * become visible, and only ever as a computed result.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type BaseMessageOptions,
} from 'discord.js';
import {
  DAY_LABELS,
  VIBE_LABELS,
  WINDOW_EMOJI,
  WINDOW_LABELS,
  type Day,
  type VibeTag,
  type Window,
} from '../../domain/constants.js';
import { formatWeekLabel, type IsoDate } from '../../domain/week.js';
import type { SlotAggregate } from '../../domain/overlap.js';
import { encodeCustomId, toBase36 } from '../customId.js';

const MEDALS = ['🥇', '🥈', '🥉'];

export interface LeaderboardParams {
  groupId: number;
  groupName: string;
  weekStartDate: IsoDate;
  windows: SlotAggregate[];
  responded: number;
  total: number;
  topVibes: Array<{ tag: VibeTag; count: number }>;
  suppressedForPrivacy: boolean;
  /** Organizer-only lock-in buttons. */
  showLockIn: boolean;
  /** Shared library, by owner count only - never who owns what. */
  games?: { name: string; ownerCount: number; price: string | null }[];
  /** Why this posted, so the group knows whether more answers are coming. */
  reason?: 'cutoff' | 'everyone-answered';
}

export function leaderboardView(params: LeaderboardParams): BaseMessageOptions {
  const embed = new EmbedBuilder()
    .setTitle(`Best windows — week of ${formatWeekLabel(params.weekStartDate)}`)
    .setColor(0x57f287);

  if (params.windows.length === 0) {
    embed.setDescription(
      params.suppressedForPrivacy
        ? // Honest about *why* it is empty, without revealing the one person.
          'No window works for two or more people yet. A couple more answers and this fills in.'
        : 'No overlap yet this week. Nudge whoever has not answered with `/status`.',
    );
  } else {
    embed.setDescription(
      params.windows
        .map((slot, index) => {
          const medal = MEDALS[index] ?? '•';
          return (
            `${medal} **${DAY_LABELS[slot.dayOfWeek]} ${WINDOW_LABELS[slot.window].toLowerCase()}** ` +
            `${WINDOW_EMOJI[slot.window]} — ${slot.headcount} can make it`
          );
        })
        .join('\n'),
    );
  }

  // Owner counts, never owner names. "6 of you own this" is an aggregate;
  // "Bob owns this" would be a raw disclosure, and this message is public.
  if (params.games && params.games.length > 0) {
    embed.addFields({
      name: 'Games you all share',
      value: params.games
        .map(
          (game) =>
            `**${game.name}** — ${game.ownerCount} of you own it` +
            (game.price ? ` · ${game.price}` : ''),
        )
        .join('\n'),
    });
  }

  if (params.reason === 'everyone-answered') {
    // Worth saying: the board is final, not a work in progress.
    embed.addFields({ name: '\u200b', value: "That's everyone in — this is the full picture." });
  }

  const footerParts = [`${params.responded}/${params.total} answered`];
  if (params.topVibes.length > 0) {
    footerParts.push(
      `mood: ${params.topVibes.map((vibe) => VIBE_LABELS[vibe.tag].toLowerCase()).join(', ')}`,
    );
  }
  // Said out loud, every week, so nobody has to wonder.
  footerParts.push('individual answers stay private');
  embed.setFooter({ text: footerParts.join(' · ') });

  const message: BaseMessageOptions = { embeds: [embed] };

  if (params.showLockIn && params.windows.length > 0) {
    // One row, at most three buttons - the leaderboard never shows more.
    message.components = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...params.windows.map((slot) =>
          new ButtonBuilder()
            .setCustomId(
              encodeCustomId(
                'sess',
                'lock',
                toBase36(params.groupId),
                String(slot.dayOfWeek),
                slot.window,
              ),
            )
            .setLabel(`Lock in ${DAY_LABELS[slot.dayOfWeek].slice(0, 3)} ${lower(slot.window)}`)
            .setStyle(ButtonStyle.Secondary),
        ),
      ),
    ];
  }

  return message;
}

function lower(window: Window): string {
  return WINDOW_LABELS[window].toLowerCase();
}

export function sessionRsvpView(params: {
  proposalId: number;
  groupName: string;
  day: Day;
  window: Window;
  counts: { yes: number; maybe: number; no: number };
  confirmed: boolean;
  showConfirm: boolean;
}): BaseMessageOptions {
  const embed = new EmbedBuilder()
    .setTitle(
      `${params.confirmed ? "It's on" : 'Possible session'} — ${DAY_LABELS[params.day]} ${lower(params.window)}`,
    )
    .setColor(params.confirmed ? 0x57f287 : 0x5865f2)
    // Counts only. Who said what is nobody else's business.
    .setDescription(
      `**${params.counts.yes}** yes · ${params.counts.maybe} maybe · ${params.counts.no} no`,
    );

  if (params.confirmed) return { embeds: [embed] };

  const rsvpRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...(['yes', 'maybe', 'no'] as const).map((response) =>
      new ButtonBuilder()
        .setCustomId(encodeCustomId('sess', 'rsvp', toBase36(params.proposalId), response))
        .setLabel(response === 'yes' ? 'Yes' : response === 'maybe' ? 'Maybe' : 'No')
        .setStyle(response === 'yes' ? ButtonStyle.Success : ButtonStyle.Secondary),
    ),
  );

  const components = [rsvpRow];
  if (params.showConfirm) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(encodeCustomId('sess', 'confirm', toBase36(params.proposalId)))
          .setLabel('Confirm session ✓')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(encodeCustomId('sess', 'cancel', toBase36(params.proposalId)))
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }

  return { embeds: [embed], components };
}
