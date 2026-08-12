/**
 * What a server sees the moment Skeddy is added.
 *
 * A stranger's server gets one chance. Before this, a new install did nothing
 * at all until somebody happened to run /setup - a command they had no way of
 * knowing existed. Most servers would simply never have used the bot.
 *
 * So: no configuration required, no command to memorise, and the two things
 * anyone could want are buttons. Everything has a sensible default already;
 * /setup exists to change them, not to switch the bot on.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type BaseMessageOptions,
} from 'discord.js';
import { encodeCustomId, toBase36 } from '../customId.js';

export function welcomeView(params: {
  groupId: number;
  timezone: string;
  websiteUrl: string;
}): BaseMessageOptions {
  const embed = new EmbedBuilder()
    .setTitle('Skeddy Goblin 🧌')
    .setColor(0x1b2838)
    .setDescription(
      [
        "I find the times you're all actually free, and the games you all actually own.",
        '',
        '**How it works**',
        '• Everyone answers a two-minute question once a week — or one tap to sit it out',
        '• I post the windows that work for the most people, and what you could play',
        "• Nobody ever sees anyone else's answers. Only the totals.",
        '',
        `Set up already — times are **${params.timezone}**, and I will post here. ` +
          'Change either with `/setup`.',
      ].join('\n'),
    )
    .setFooter({ text: 'Tap Count me in, then Start this week. That is the whole setup.' });

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId('join', 'go', toBase36(params.groupId)))
      .setLabel('Count me in')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(encodeCustomId('av', 'in', toBase36(params.groupId)))
      .setLabel('Start this week')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setLabel('How it works')
      .setStyle(ButtonStyle.Link)
      .setURL(params.websiteUrl),
  );

  return { embeds: [embed], components: [buttons] };
}

/**
 * The standalone join post, re-postable with /setup.
 *
 * This is what makes the roster opt-in rather than "everyone who ever joined
 * the server", and it is the thing that removes the need for the privileged
 * members intent entirely.
 */
export function joinBoardView(params: {
  groupId: number;
  memberCount: number;
}): BaseMessageOptions {
  const embed = new EmbedBuilder()
    .setTitle('Who plays?')
    .setColor(0x57f287)
    .setDescription(
      [
        'Tap **Count me in** and I will include you in the weekly question.',
        '',
        'One tap to leave again any time. I only ever show the group totals — never who said what.',
      ].join('\n'),
    )
    .setFooter({
      text:
        params.memberCount === 0
          ? 'Nobody yet'
          : `${params.memberCount} ${params.memberCount === 1 ? 'person' : 'people'} in`,
    });

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(encodeCustomId('join', 'go', toBase36(params.groupId)))
          .setLabel('Count me in')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(encodeCustomId('join', 'out', toBase36(params.groupId)))
          .setLabel('Take me off')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}
