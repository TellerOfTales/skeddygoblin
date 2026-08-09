/**
 * The single interactionCreate dispatcher.
 *
 * Handlers receive (interaction, parsed, ctx) and never touch the client or the
 * database directly, which is what makes them testable with a plain fake
 * interaction object and no gateway connection.
 */

import { MessageFlags, type Interaction, type RepliableInteraction } from 'discord.js';
import { commands } from './commands/index.js';
import { componentHandlers } from './components/index.js';
import { parseCustomId, UnknownVersionError, MalformedCustomIdError } from './customId.js';
import { isDomainError, type DomainErrorCode } from '../domain/errors.js';
import type { AppContext } from '../services/context.js';

/**
 * Discord API errors that are expected in normal operation and must not spam
 * the logs at error level:
 *   10062 Unknown interaction     - we blew the 3 second ack window
 *   50027 Invalid Webhook Token   - the 15 minute interaction token expired
 */
const EXPECTED_DISCORD_ERRORS = new Set([10062, 50027]);

/** User-facing copy per domain error code. Keep it plain and blame-free. */
const ERROR_COPY: Partial<Record<DomainErrorCode, string>> = {
  GROUP_NOT_FOUND:
    'This server is not set up for Skeddy Goblin yet. An organizer can run `/setup`.',
  GROUP_NOT_CONFIGURED: 'An organizer needs to finish `/setup` before this works.',
  NOT_ORGANIZER: 'Only an organizer can do that.',
  ACTOR_NOT_MEMBER: "You're not in this group yet — join from the weekly post and try again.",
  TARGET_NOT_MEMBER: "That person isn't in this group.",
  DRAFT_NOT_FOUND: 'That flow has expired — run `/availability` to pick up where you left off.',
  DRAFT_NOT_OWNED: "That prompt belongs to someone else's flow.",
  ALREADY_SUBMITTED: "You've already answered for this week. Run `/availability` to change it.",
  NO_DAYS_SELECTED: 'Pick at least one day first.',
  NO_CAPACITY_SELECTED: 'Pick how many sessions you can make first.',
  SELF_BUZZ: "You can't buzz yourself.",
  ALREADY_RESPONDED: "They've already answered this week — no buzz needed.",
  RATE_LIMITED: "They've already been buzzed today. Give them a day.",
  DELIVERY_FAILED: "Couldn't deliver that — their DMs may be closed.",
  PROPOSAL_NOT_FOUND: 'That session is no longer available.',
  PROPOSAL_CLOSED: 'That session is already settled.',
  STEAM_NOT_LINKED: 'Link your Steam account first with `/link-steam`.',
  STEAM_PROFILE_PRIVATE:
    'Your Steam profile is private, so Skeddy Goblin cannot read your library. ' +
    'Set "Game details" to Public in your Steam privacy settings.',
};

function discordErrorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

/** True for errors that mean "the interaction is gone", not "we have a bug". */
export function isExpiredInteraction(error: unknown): boolean {
  const code = discordErrorCode(error);
  return code !== undefined && EXPECTED_DISCORD_ERRORS.has(code);
}

async function respondWithError(interaction: RepliableInteraction, message: string): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    if (!isExpiredInteraction(error)) throw error;
  }
}

export function createRouter(ctx: AppContext) {
  return async function route(interaction: Interaction): Promise<void> {
    const log = ctx.logger.child({ interactionId: interaction.id });

    try {
      if (interaction.isChatInputCommand()) {
        const command = commands.get(interaction.commandName);
        if (!command) {
          log.warn('unknown command', { name: interaction.commandName });
          return;
        }
        await command.execute(interaction, ctx);
        return;
      }

      if (interaction.isAutocomplete()) {
        const command = commands.get(interaction.commandName);
        // Autocomplete has a hard 3s budget and no way to defer, so a failure
        // here must degrade to an empty list rather than an error.
        await command?.autocomplete?.(interaction, ctx);
        return;
      }

      if (interaction.isButton() || interaction.isAnySelectMenu()) {
        let parsed;
        try {
          parsed = parseCustomId(interaction.customId);
        } catch (error) {
          if (error instanceof UnknownVersionError) {
            await respondWithError(
              interaction,
              'This prompt is from an older version of the bot — run `/availability` again.',
            );
            return;
          }
          if (error instanceof MalformedCustomIdError) {
            log.warn('malformed custom_id', { customId: interaction.customId });
            return;
          }
          throw error;
        }

        const handler = componentHandlers.get(parsed.namespace);
        if (!handler) {
          log.warn('no handler for namespace', { namespace: parsed.namespace });
          return;
        }
        await handler(interaction, parsed, ctx);
        return;
      }
    } catch (error) {
      if (isExpiredInteraction(error)) {
        log.warn('interaction expired before we could respond', {
          code: discordErrorCode(error),
        });
        return;
      }

      if (isDomainError(error)) {
        log.info('domain error', { code: error.code, details: error.details });
        await respondWithError(
          interaction as RepliableInteraction,
          ERROR_COPY[error.code] ?? 'That did not work. Try again in a moment.',
        );
        return;
      }

      log.error('unhandled interaction error', { error });
      await respondWithError(
        interaction as RepliableInteraction,
        'Something went wrong on our end. Try again in a moment.',
      );
    }
  };
}
