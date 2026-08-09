import type {
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import type { AppContext } from '../../services/context.js';
import * as availability from './availability.js';
import * as overlap from './overlap.js';
import * as setup from './setup.js';
import * as status from './status.js';

export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void>;
}

const ALL: Command[] = [availability, overlap, setup, status];

export const commands: ReadonlyMap<string, Command> = new Map(
  ALL.map((command) => [command.data.name, command]),
);

/** Payload for guild-scoped registration. */
export function commandPayload(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return ALL.map(
    (command) => command.data.toJSON() as RESTPostAPIChatInputApplicationCommandsJSONBody,
  );
}
