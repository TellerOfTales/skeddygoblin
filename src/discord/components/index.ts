/**
 * Component handler registry, keyed by custom_id namespace.
 *
 * Each build-order step registers its own namespace here rather than editing a
 * central switch statement.
 */

import type { AnySelectMenuInteraction, ButtonInteraction } from 'discord.js';
import type { ParsedCustomId, Namespace } from '../customId.js';
import type { AppContext } from '../../services/context.js';

export type ComponentInteraction = ButtonInteraction | AnySelectMenuInteraction;

export type ComponentHandler = (
  interaction: ComponentInteraction,
  parsed: ParsedCustomId,
  ctx: AppContext,
) => Promise<void>;

export const componentHandlers = new Map<Namespace, ComponentHandler>();

export function registerComponentHandler(namespace: Namespace, handler: ComponentHandler): void {
  componentHandlers.set(namespace, handler);
}
