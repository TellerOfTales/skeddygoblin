/**
 * Pure view builders for the weekly questionnaire.
 *
 * These take plain state and return a Discord message payload. No I/O, no
 * services, no interaction object - which is what lets every one of them be
 * rendered with a maximal fixture in tests and checked against Discord's
 * component limits before it ever reaches a DM.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING TO REMEMBER
 * ---------------------------------------------------------------------------
 * Discord does NOT remember a select menu's selection across an update(). Every
 * re-render must set `default: true` from stored state. Forgetting looks
 * exactly like "the bot ate my answers", so the defaults are applied here in
 * the builder rather than at each call site.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type InteractionUpdateOptions,
} from 'discord.js';
import {
  CAPACITY_LABELS,
  CAPACITY_OPTIONS,
  DAYS,
  DAY_LABELS,
  DAY_SHORT,
  DAYS_PER_PAGE,
  MAX_VIBE_SELECTIONS,
  VIBE_DESCRIPTIONS,
  VIBE_LABELS,
  VIBE_TAGS,
  WINDOWS,
  WINDOW_EMOJI,
  WINDOW_LABELS,
  type Capacity,
  type Day,
  type VibeTag,
  type Window,
} from '../../domain/constants.js';
import { formatWeekLabel, type IsoDate } from '../../domain/week.js';
import { encodeCustomId, toBase36 } from '../customId.js';

type Row = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;

function header(groupName: string, timezone: string, weekStartDate: IsoDate): string {
  // Stated once, every screen: buckets are group-local, not the member's local.
  return `Week of **${formatWeekLabel(weekStartDate)}** · times are ${groupName} local (${timezone})`;
}

// ---------------------------------------------------------------------------
// Stage A - which days
// ---------------------------------------------------------------------------

export interface DayPickerParams {
  draftId: number;
  groupId: number;
  groupName: string;
  timezone: string;
  weekStartDate: IsoDate;
  selectedDays: Day[];
}

export function dayPickerView(params: DayPickerParams): InteractionUpdateOptions {
  const selected = new Set(params.selectedDays);

  const select = new StringSelectMenuBuilder()
    .setCustomId(encodeCustomId('av', 'days', toBase36(params.draftId)))
    .setPlaceholder('Which days could you play?')
    .setMinValues(1)
    .setMaxValues(DAYS.length)
    .addOptions(
      DAYS.map((day) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(DAY_LABELS[day])
          .setValue(String(day))
          .setDefault(selected.has(day)),
      ),
    );

  const escapeHatch = new ButtonBuilder()
    .setCustomId(encodeCustomId('av', 'optout', toBase36(params.groupId)))
    .setLabel("Can't this week")
    .setStyle(ButtonStyle.Secondary);

  return {
    content: [
      header(params.groupName, params.timezone, params.weekStartDate),
      '',
      'Step 1 of 3',
    ].join('\n'),
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(escapeHatch),
    ],
  };
}

// ---------------------------------------------------------------------------
// Stage B - which windows, per day, paginated
// ---------------------------------------------------------------------------

export interface WindowPickerParams {
  draftId: number;
  groupName: string;
  timezone: string;
  weekStartDate: IsoDate;
  /** All selected days, in order. */
  days: Day[];
  windowsByDay: Record<string, Window[]>;
  page: number;
}

export function windowPickerView(params: WindowPickerParams): InteractionUpdateOptions {
  const totalPages = Math.max(1, Math.ceil(params.days.length / DAYS_PER_PAGE));
  const page = Math.min(Math.max(params.page, 0), totalPages - 1);
  const pageDays = params.days.slice(page * DAYS_PER_PAGE, page * DAYS_PER_PAGE + DAYS_PER_PAGE);

  const rows: Row[] = pageDays.map((day) => {
    const chosen = new Set(params.windowsByDay[String(day)] ?? []);
    const select = new StringSelectMenuBuilder()
      .setCustomId(encodeCustomId('av', 'win', toBase36(params.draftId), String(day)))
      .setPlaceholder(`${DAY_LABELS[day]} — when?`)
      // min 0 so a member can clear a day without deselecting it upstream.
      .setMinValues(0)
      .setMaxValues(WINDOWS.length)
      .addOptions(
        WINDOWS.map((window) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(WINDOW_LABELS[window])
            .setValue(window)
            .setEmoji(WINDOW_EMOJI[window])
            .setDefault(chosen.has(window)),
        ),
      );
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  });

  // Row 5 is navigation, which is exactly why DAYS_PER_PAGE is 4.
  const firstDay = pageDays[0];
  const nav: ButtonBuilder[] = [];

  nav.push(
    page === 0
      ? new ButtonBuilder()
          .setCustomId(encodeCustomId('av', 'daypick', toBase36(params.draftId)))
          .setLabel('◀ Days')
          .setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder()
          .setCustomId(encodeCustomId('av', 'page', toBase36(params.draftId), String(page - 1)))
          .setLabel('◀ Back')
          .setStyle(ButtonStyle.Secondary),
  );

  if (firstDay !== undefined && params.days.length > 1) {
    nav.push(
      new ButtonBuilder()
        .setCustomId(encodeCustomId('av', 'copy', toBase36(params.draftId), String(firstDay)))
        .setLabel(`Copy ${DAY_SHORT[firstDay]} to all`)
        .setStyle(ButtonStyle.Secondary),
    );
  }

  nav.push(
    page < totalPages - 1
      ? new ButtonBuilder()
          .setCustomId(encodeCustomId('av', 'page', toBase36(params.draftId), String(page + 1)))
          .setLabel('Next ▶')
          .setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder()
          .setCustomId(encodeCustomId('av', 'done', toBase36(params.draftId)))
          .setLabel('Done ✓')
          .setStyle(ButtonStyle.Success),
  );

  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...nav));

  const pageLabel = totalPages > 1 ? ` · page ${page + 1} of ${totalPages}` : '';

  return {
    content: [
      header(params.groupName, params.timezone, params.weekStartDate),
      '',
      `Step 2 of 3${pageLabel} — pick the windows that work. Leave a day empty to skip it.`,
    ].join('\n'),
    components: rows,
  };
}

// ---------------------------------------------------------------------------
// Stage C - capacity and vibe, on ONE message
//
// Splitting these across two messages would cost a round trip for no benefit,
// and the whole flow is budgeted at under two minutes.
// ---------------------------------------------------------------------------

export interface CapacityVibeParams {
  draftId: number;
  groupId: number;
  groupName: string;
  timezone: string;
  weekStartDate: IsoDate;
  capacity: Capacity | undefined;
  vibes: VibeTag[];
  slotCount: number;
  dayCount: number;
}

export function capacityVibeView(params: CapacityVibeParams): InteractionUpdateOptions {
  const capacityRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...CAPACITY_OPTIONS.map((option) =>
      new ButtonBuilder()
        .setCustomId(encodeCustomId('av', 'cap', toBase36(params.draftId), String(option)))
        .setLabel(CAPACITY_LABELS[option])
        .setStyle(params.capacity === option ? ButtonStyle.Success : ButtonStyle.Secondary),
    ),
  );

  const chosenVibes = new Set(params.vibes);
  const vibeSelect = new StringSelectMenuBuilder()
    .setCustomId(encodeCustomId('av', 'vibe', toBase36(params.draftId)))
    .setPlaceholder(`What are you in the mood for? (up to ${MAX_VIBE_SELECTIONS})`)
    .setMinValues(0)
    .setMaxValues(MAX_VIBE_SELECTIONS)
    .addOptions(
      VIBE_TAGS.map((tag) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(VIBE_LABELS[tag])
          .setDescription(VIBE_DESCRIPTIONS[tag])
          .setValue(tag)
          .setDefault(chosenVibes.has(tag)),
      ),
    );

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId('av', 'page', toBase36(params.draftId), '0'))
      .setLabel('◀ Back')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(encodeCustomId('av', 'submit', toBase36(params.draftId)))
      .setLabel('Submit ✓')
      .setStyle(ButtonStyle.Success)
      // Capacity is the one genuinely required answer, so Submit stays inert
      // until it is given rather than failing after the tap.
      .setDisabled(params.capacity === undefined),
    new ButtonBuilder()
      .setCustomId(encodeCustomId('av', 'optout', toBase36(params.groupId)))
      .setLabel("Can't this week")
      .setStyle(ButtonStyle.Secondary),
  );

  return {
    content: [
      header(params.groupName, params.timezone, params.weekStartDate),
      '',
      `Step 3 of 3 — ${params.slotCount} windows across ${params.dayCount} ` +
        `${params.dayCount === 1 ? 'day' : 'days'}.`,
      'How many sessions can you actually make this week?',
    ].join('\n'),
    components: [
      capacityRow,
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(vibeSelect),
      navRow,
    ],
  };
}

// ---------------------------------------------------------------------------
// Terminal screens
// ---------------------------------------------------------------------------

export function submittedView(params: {
  groupName: string;
  weekStartDate: IsoDate;
  capacity: Capacity;
  slotCount: number;
  dayCount: number;
  vibes: VibeTag[];
}): InteractionUpdateOptions {
  const vibeLine =
    params.vibes.length > 0 ? ` · ${params.vibes.map((tag) => VIBE_LABELS[tag]).join(', ')}` : '';

  return {
    content: [
      `**You're in for the week of ${formatWeekLabel(params.weekStartDate)}.** 🧌`,
      '',
      `Up to ${CAPACITY_LABELS[params.capacity]} ${params.capacity === 1 ? 'session' : 'sessions'} · ` +
        `${params.slotCount} windows across ${params.dayCount} ` +
        `${params.dayCount === 1 ? 'day' : 'days'}${vibeLine}`,
      '',
      `${params.groupName} sees only the combined result — never your individual picks.`,
      'Change anything by running `/availability` again.',
    ].join('\n'),
    components: [],
  };
}

export function noWindowsChosenView(params: {
  draftId: number;
  groupName: string;
  timezone: string;
  weekStartDate: IsoDate;
  days: Day[];
  windowsByDay: Record<string, Window[]>;
}): InteractionUpdateOptions {
  const view = windowPickerView({ ...params, page: 0 });
  view.content = [
    header(params.groupName, params.timezone, params.weekStartDate),
    '',
    "Pick at least one window before finishing — or tap **Can't this week** to sit this one out.",
  ].join('\n');
  return view;
}

export function optedOutView(params: {
  groupName: string;
  weekStartDate: IsoDate;
}): InteractionUpdateOptions {
  return {
    content: [
      `**Noted — you're out for the week of ${formatWeekLabel(params.weekStartDate)}.**`,
      '',
      `Nobody will nudge you about ${params.groupName} again until next week.`,
      'Changed your mind? `/availability` reopens it any time.',
    ].join('\n'),
    components: [],
  };
}
