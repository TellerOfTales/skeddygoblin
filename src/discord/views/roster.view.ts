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
import { DAY_LABELS, WINDOW_LABELS, type Day, type Window } from '../../domain/constants.js';
import { encodeCustomId, toBase36 } from '../customId.js';

/** 5 buttons per row, and we allow two rows of them. */
export const MAX_BUZZ_BUTTONS = 10;

export interface RosterViewRow {
  userId: number;
  discordId: string;
  hasResponded: boolean;
  /** 'started' = picked something, never submitted. Still buzzable. */
  progress: 'none' | 'started' | 'answered';
  buzzedToday: boolean;
}

/** Aggregates the roster shows alongside who has answered. Counts only. */
export interface RosterHighlights {
  windows: { dayOfWeek: number; window: string; headcount: number }[];
  vibes: { tag: string; count: number }[];
  games: { name: string; ownerCount: number; price: string | null }[];
  suppressedForPrivacy: boolean;
}

export interface RosterViewParams {
  groupId: number;
  groupName: string;
  weekStartDate: IsoDate;
  rows: RosterViewRow[];
  responded: number;
  started: number;
  total: number;
  highlights?: RosterHighlights;
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
    // Numbered so the buttons below have something to refer to. "half done" is
    // progress, not content - it says someone engaged, never when they are
    // free - and it is the most useful thing on the line, because those people
    // are two taps from finished.
    const listed = waiting.slice(0, MAX_BUZZ_BUTTONS).map((row, index) => {
      const notes = [
        row.progress === 'started' ? 'half done — needs to hit Submit' : null,
        row.buzzedToday ? 'buzzed today' : null,
      ].filter((note): note is string => note !== null);
      return `\`${index + 1}\` <@${row.discordId}>${notes.length > 0 ? ` · ${notes.join(' · ')}` : ''}`;
    });
    const overflow = waiting.length - listed.length;

    sections.push(
      `**Still to answer (${waiting.length})**\n${listed.join('\n')}` +
        (overflow > 0 ? `\n_...and ${overflow} more_` : ''),
    );
  }

  // Everything below is an aggregate. Headcounts, vibe counts and owner counts
  // never name anyone, which is what lets the roster - the one view that DOES
  // name people - carry them without leaking a single person's picks.
  const highlights = params.highlights;
  if (highlights) {
    if (highlights.windows.length > 0) {
      sections.push(
        `**Leading windows so far**\n` +
          highlights.windows
            .map(
              (w, i) =>
                `${['🥇', '🥈', '🥉'][i] ?? '·'} ${DAY_LABELS[w.dayOfWeek as Day]} ${WINDOW_LABELS[
                  w.window as Window
                ].toLowerCase()} — ${w.headcount} can make it`,
            )
            .join('\n'),
      );
    } else if (highlights.suppressedForPrivacy) {
      sections.push('**Leading windows so far**\nNo window works for two or more people yet.');
    }

    if (highlights.vibes.length > 0) {
      sections.push(
        `**Mood**\n${highlights.vibes.map((v) => `${v.tag} (${v.count})`).join(' · ')}`,
      );
    }

    if (highlights.games.length > 0) {
      sections.push(
        `**Games you share**\n` +
          highlights.games
            .map(
              (g) => `${g.name} — ${g.ownerCount} of you own it${g.price ? ` · ${g.price}` : ''}`,
            )
            .join('\n'),
      );
    }
  }

  embed.setDescription(sections.join('\n\n'));

  const footer = [`${params.responded}/${params.total} answered`];
  if (params.started > 0) footer.push(`${params.started} half done`);
  footer.push('individual answers stay private');
  embed.setFooter({ text: footer.join(' · ') });

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
