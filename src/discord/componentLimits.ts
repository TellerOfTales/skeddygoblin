/**
 * Discord component legality assertions.
 *
 * These limits are the hardest constraint in the whole project - the 7x6
 * availability grid exists in the shape it does because of them. Violating one
 * surfaces at send time as an opaque 400 from the API, in someone's DM, which
 * is a terrible place to discover it. So every view builder is run through
 * assertLegalMessage() with a maximal fixture in tests.
 *
 * Reference limits (discord.js v14 / components v1):
 *   - 5 action rows per message
 *   - a row holds up to 5 buttons OR exactly 1 select menu
 *   - a string select holds up to 25 options
 *   - max_values must not exceed the option count
 *   - custom_id is at most 100 characters
 *   - button labels are at most 80 characters
 */

import { CUSTOM_ID_MAX_LENGTH, parseCustomId } from './customId.js';

export const MAX_ACTION_ROWS = 5;
export const MAX_BUTTONS_PER_ROW = 5;
export const MAX_SELECT_OPTIONS = 25;
export const MAX_BUTTON_LABEL = 80;

/** Discord component type ids we care about. */
const TYPE_ACTION_ROW = 1;
const TYPE_BUTTON = 2;
const SELECT_TYPES = new Set([3, 5, 6, 7, 8]); // string, user, role, mentionable, channel

interface RawComponent {
  type: number;
  custom_id?: string;
  label?: string;
  style?: number;
  url?: string;
  options?: unknown[];
  min_values?: number;
  max_values?: number;
  components?: RawComponent[];
}

export interface MessageLike {
  components?: unknown[];
}

export class ComponentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComponentLimitError';
  }
}

function toRaw(component: unknown): RawComponent {
  if (component && typeof component === 'object' && 'toJSON' in component) {
    return (component as { toJSON(): RawComponent }).toJSON();
  }
  return component as RawComponent;
}

/**
 * Throws if `message` would be rejected by Discord. Returns silently otherwise.
 */
export function assertLegalMessage(message: MessageLike, context = 'message'): void {
  const rows = (message.components ?? []).map(toRaw);

  if (rows.length > MAX_ACTION_ROWS) {
    throw new ComponentLimitError(
      `${context}: ${rows.length} action rows, max is ${MAX_ACTION_ROWS}`,
    );
  }

  rows.forEach((row, rowIndex) => {
    const where = `${context} row ${rowIndex}`;

    if (row.type !== TYPE_ACTION_ROW) {
      throw new ComponentLimitError(`${where}: top-level component must be an action row`);
    }

    const children = row.components ?? [];
    if (children.length === 0) {
      throw new ComponentLimitError(`${where}: action row is empty`);
    }

    const selects = children.filter((child) => SELECT_TYPES.has(child.type));
    const buttons = children.filter((child) => child.type === TYPE_BUTTON);

    if (selects.length > 0 && children.length !== 1) {
      throw new ComponentLimitError(
        `${where}: a row containing a select menu must contain exactly that one component ` +
          `(found ${children.length})`,
      );
    }
    if (buttons.length > MAX_BUTTONS_PER_ROW) {
      throw new ComponentLimitError(
        `${where}: ${buttons.length} buttons, max is ${MAX_BUTTONS_PER_ROW}`,
      );
    }

    children.forEach((child, childIndex) => {
      const label = `${where} component ${childIndex}`;

      // Link buttons (style 5) carry a url and legitimately have no custom_id.
      const isLinkButton = child.type === TYPE_BUTTON && child.style === 5;
      if (!isLinkButton) {
        if (!child.custom_id) {
          throw new ComponentLimitError(`${label}: missing custom_id`);
        }
        if (child.custom_id.length > CUSTOM_ID_MAX_LENGTH) {
          throw new ComponentLimitError(
            `${label}: custom_id is ${child.custom_id.length} chars, max is ${CUSTOM_ID_MAX_LENGTH}`,
          );
        }
        // Must be routable, or the click silently does nothing.
        parseCustomId(child.custom_id);
      }

      if (child.type === TYPE_BUTTON && child.label && child.label.length > MAX_BUTTON_LABEL) {
        throw new ComponentLimitError(
          `${label}: button label is ${child.label.length} chars, max is ${MAX_BUTTON_LABEL}`,
        );
      }

      if (SELECT_TYPES.has(child.type)) {
        const options = child.options ?? [];
        if (child.type === 3) {
          if (options.length === 0) {
            throw new ComponentLimitError(`${label}: string select has no options`);
          }
          if (options.length > MAX_SELECT_OPTIONS) {
            throw new ComponentLimitError(
              `${label}: ${options.length} options, max is ${MAX_SELECT_OPTIONS}`,
            );
          }
          if (child.max_values !== undefined && child.max_values > options.length) {
            throw new ComponentLimitError(
              `${label}: max_values ${child.max_values} exceeds option count ${options.length}`,
            );
          }
        }
        if (
          child.min_values !== undefined &&
          child.max_values !== undefined &&
          child.min_values > child.max_values
        ) {
          throw new ComponentLimitError(
            `${label}: min_values ${child.min_values} exceeds max_values ${child.max_values}`,
          );
        }
      }
    });
  });
}
