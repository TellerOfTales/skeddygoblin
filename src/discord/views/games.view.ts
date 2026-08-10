/**
 * Game suggestions and nomination voting.
 *
 * Everything shown is a count. A game says how MANY of the group own it and how
 * many voted for it, never who - a library is as personal as a calendar.
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
  GAMES_PAGE_SIZE,
  WINDOW_LABELS,
  type Day,
  type Window,
} from '../../domain/constants.js';
import { formatPrice } from '../../domain/gameMatching.js';
import { encodeCustomId, toBase36 } from '../customId.js';
import type { GameOption, SuggestedGame } from '../../services/gameService.js';

function price(game: { priceCents: number | null; currency: string | null }): string {
  const formatted = formatPrice(game.priceCents, game.currency);
  return formatted === null ? '' : ` · ${formatted}`;
}

export function gameSuggestionsView(params: {
  groupId: number;
  groupName: string;
  suggestions: SuggestedGame[];
  page: number;
  totalPages: number;
  total: number;
  multiplayerOnly: boolean;
}): BaseMessageOptions {
  const embed = new EmbedBuilder().setTitle('Games you could actually all play').setColor(0x1b2838);

  if (params.suggestions.length === 0) {
    embed.setDescription(
      [
        'No shared multiplayer games surfaced for this week yet.',
        '',
        'That usually means not enough of the group has linked Steam — `/link-steam` takes a few seconds.',
      ].join('\n'),
    );
    return { embeds: [embed] };
  }

  const offset = params.page * GAMES_PAGE_SIZE;
  embed.setDescription(
    params.suggestions
      .map((game, index) => {
        const link = game.storeUrl ? `[${game.name}](${game.storeUrl})` : `**${game.name}**`;
        return `\`${offset + index + 1}\` ${link} — ${game.ownerCount} of you own it${price(game)}`;
      })
      .join('\n'),
  );
  embed.setFooter({
    text:
      `${params.total} shared ${params.total === 1 ? 'game' : 'games'}` +
      (params.totalPages > 1 ? ` · page ${params.page + 1} of ${params.totalPages}` : '') +
      ' · matched to this week’s vibe · owner counts only, never who',
  });

  const message: BaseMessageOptions = { embeds: [embed] };

  if (params.totalPages > 1) {
    const solo = params.multiplayerOnly ? '0' : '1';
    message.components = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            encodeCustomId('gv', 'page', toBase36(params.groupId), String(params.page - 1), solo),
          )
          .setLabel('◀ Back')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(params.page === 0),
        new ButtonBuilder()
          .setCustomId(
            encodeCustomId('gv', 'page', toBase36(params.groupId), String(params.page + 1), solo),
          )
          .setLabel('Next ▶')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(params.page >= params.totalPages - 1),
      ),
    ];
  }

  return message;
}

export function gameVoteView(params: {
  proposalId: number;
  day: Day;
  window: Window;
  options: GameOption[];
}): BaseMessageOptions {
  const embed = new EmbedBuilder()
    .setTitle(
      `What are we playing? — ${DAY_LABELS[params.day]} ${WINDOW_LABELS[params.window].toLowerCase()}`,
    )
    .setColor(0x5865f2);

  embed.setDescription(
    params.options.length === 0
      ? 'Nothing nominated yet. Use `/propose` to put something forward.'
      : params.options
          .map(
            (option) =>
              `${option.votedByMe ? '✅' : '▫️'} ${
                option.storeUrl
                  ? `[${option.gameName}](${option.storeUrl})`
                  : `**${option.gameName}**`
              } — ${option.votes} ${option.votes === 1 ? 'vote' : 'votes'}${price(option)}`,
          )
          .join('\n'),
  );

  // Five buttons per row, two rows: enough for a realistic shortlist without
  // turning the message into a wall.
  const buttons = params.options.slice(0, 10).map((option) =>
    new ButtonBuilder()
      .setCustomId(encodeCustomId('gv', 'vote', toBase36(option.voteId)))
      .setLabel(option.gameName.slice(0, 40))
      .setStyle(option.votedByMe ? ButtonStyle.Success : ButtonStyle.Secondary),
  );

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < buttons.length; index += 5) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(index, index + 5)),
    );
  }

  return { embeds: [embed], components };
}
