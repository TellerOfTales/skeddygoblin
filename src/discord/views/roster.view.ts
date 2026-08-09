/**
 * The status roster.
 *
 * Two things shape this view:
 *
 * 1. It says only whether someone answered, never HOW. Distinguishing "opted
 *    out" from "submitted" would be a preference disclosure, so the service
 *    hands over a boolean and there is nothing here that could render more.
 *
 * 2. We store no display names - only Discord snowflakes - so members are
 *    rendered as <@id> mentions, which Discord resolves client-side. Pings are
 *    suppressed via allowedMentions, so a roster post nudges nobody by
 *    accident. That is also why buzz buttons are NUMBERED rather than labelled
 *    with names: a button label is plain text, and we have no name to put in it
 *    without either storing PII or fetching the member list behind a privileged
 *    intent.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type BaseMessageOptions,
} from 'discord.js';
import { formatWeekLabel, type IsoDate } from '../../domain/week.js';
import { encodeCustomId, toBase36 } from '../customId.js';

/** 5 buttons per row, and we allow two rows of them. */
export const MAX_BUZZ_BUTTONS = 10;

export interface RosterViewRow {
  userId: number;
  discordId: string;
  hasResponded: boolean;
  buzzedToday: boolean;
}

export interface RosterViewParams {
  groupId: number;
  groupName: string;
  weekStartDate: IsoDate;
  rows: RosterViewRow[];
  responded: number;
  total: number;
}

export function rosterView(params: RosterViewParams): BaseMessageOptions {
  const answered = params.rows.filter((row) => row.hasResponded);
  const waiting = params.rows.filter((row) => !row.hasResponded);

  const embed = new EmbedBuilder()
    .setTitle(`Who's answered — week of ${formatWeekLabel(params.weekStartDate)}`)
    .setColor(waiting.length === 0 ? 0x57f287 : 0xfee75c);

  const sections: string[] = [];

  sections.push(
    answered.length > 0
      ? `**Answered (${answered.length})**\n${answered.map((row) => `<@${row.discordId}>`).join(' ')}`
      : '**Answered (0)**\nNobody yet.',
  );

  if (waiting.length > 0) {
    // Numbered so the buttons below have something to refer to.
    const listed = waiting
      .slice(0, MAX_BUZZ_BUTTONS)
      .map(
        (row, index) =>
          `\`${index + 1}\` <@${row.discordId}>${row.buzzedToday ? ' · buzzed today' : ''}`,
      );
    const overflow = waiting.length - listed.length;

    sections.push(
      `**Still to answer (${waiting.length})**\n${listed.join('\n')}` +
        (overflow > 0 ? `\n_...and ${overflow} more_` : ''),
    );
  }

  embed.setDescription(sections.join('\n\n'));
  embed.setFooter({
    text: `${params.responded}/${params.total} answered · individual answers stay private`,
  });

  const buttons = waiting.slice(0, MAX_BUZZ_BUTTONS).map((row, index) =>
    new ButtonBuilder()
      .setCustomId(encodeCustomId('buzz', 'go', toBase36(params.groupId), toBase36(row.userId)))
      .setLabel(`Buzz ${index + 1}`)
      .setStyle(ButtonStyle.Secondary)
      // A courtesy only. The service refuses regardless of button state, which
      // is what makes the rule hold for any client.
      .setDisabled(row.buzzedToday),
  );

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < buttons.length; index += 5) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(index, index + 5)),
    );
  }

  return {
    embeds: [embed],
    components,
    // Mentions render as names but ping nobody. A roster is information, not a
    // summons.
    allowedMentions: { parse: [] },
  };
}
