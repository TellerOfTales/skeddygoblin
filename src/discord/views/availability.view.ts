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

/**
 * The confirmation, and the natural moment to offer to remember this.
 *
 * Saving defaults belongs here rather than in the prompt itself for two
 * reasons: the prompt's button row is already at Discord's five-button ceiling,
 * and "save what I just built" is a far easier thing to understand than "go and
 * configure a template somewhere".
 */
export function submittedView(params: {
  userId: number;
  groupName: string;
  weekStartDate: IsoDate;
  capacity: Capacity;
  slotCount: number;
  dayCount: number;
  vibes: VibeTag[];
  autoApply: boolean;
  savedAsDefaults?: boolean;
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
      ...(params.savedAsDefaults
        ? ['', "_Saved as your defaults. Windows apply as each server's own local time._"]
        : []),
    ].join('\n'),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(encodeCustomId('av', 'savedef', toBase36(params.userId)))
          .setLabel(params.savedAsDefaults ? 'Defaults saved ✓' : 'Save as my defaults')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(params.savedAsDefaults === true),
        new ButtonBuilder()
          .setCustomId(encodeCustomId('av', 'auto', toBase36(params.userId)))
          .setLabel(params.autoApply ? 'Auto-answer: on' : 'Auto-answer every week')
          .setStyle(params.autoApply ? ButtonStyle.Success : ButtonStyle.Secondary),
      ),
    ],
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

/**
 * The escape hatch's landing screen.
 *
 * It carries exactly one button, and that is the point: opting out used to
 * strip every component and tell people to run `/availability` again - a
 * command that could not be run from the DM they were sitting in. There was
 * genuinely no way back. One tap has to be reversible by one tap.
 *
 * Deliberately Secondary and deliberately alone: no guilt copy, no second ask,
 * nothing that reads as trying to talk them out of it.
 */
export function optedOutView(params: {
  groupId: number;
  groupName: string;
  weekStartDate: IsoDate;
}): InteractionUpdateOptions {
  const reopen = new ButtonBuilder()
    .setCustomId(encodeCustomId('av', 'in', toBase36(params.groupId)))
    .setLabel("Actually, I'm in")
    .setStyle(ButtonStyle.Secondary);

  return {
    content: [
      `**Noted — you're out for the week of ${formatWeekLabel(params.weekStartDate)}.**`,
      '',
      `Nobody will nudge you about ${params.groupName} again until next week.`,
      'Changed your mind? The button below reopens it.',
    ].join('\n'),
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(reopen)],
  };
}

// ---------------------------------------------------------------------------
// The single prompt - everything on one screen, Submit at the bottom
// ---------------------------------------------------------------------------

export interface SinglePromptParams {
  draftId: number;
  groupId: number;
  groupName: string;
  timezone: string;
  weekStartDate: IsoDate;
  selectedDays: Day[];
  /** Cross-product windows: these apply to every selected day. */
  simpleWindows: Window[];
  /** Non-empty once the member has used the per-day picker. Then it wins. */
  windowsByDay: Record<string, Window[]>;
  capacity: Capacity | undefined;
  vibes: VibeTag[];
  /** Enables "Copy last week" - false when there is no last week to copy. */
  hasLastWeek?: boolean;
  /** Enables "Use my defaults" - false when they have not set any. */
  hasDefaults?: boolean;
}

/**
 * One message, five rows, Submit visible from the first second.
 *
 * Discord allows five action rows and a select menu eats a whole row, so this
 * is the entire budget: days, times, sessions, vibe, and a button row. That
 * constraint is what makes rows 1 and 2 a CROSS PRODUCT - "Mon/Wed/Fri" plus
 * "evenings" means evenings on all three - which also happens to be how most
 * people think about their week.
 *
 * Per-day precision is not lost, just moved behind a button. Once the member
 * has used it, `windowsByDay` wins and the row-2 select is disabled: leaving it
 * live would let one careless tap silently flatten work they did deliberately.
 */
export function singlePromptView(params: SinglePromptParams): InteractionUpdateOptions {
  const perDay = Object.values(params.windowsByDay).some((windows) => windows.length > 0);
  const selectedDays = new Set(params.selectedDays);
  const selectedWindows = new Set(params.simpleWindows);

  const daySelect = new StringSelectMenuBuilder()
    .setCustomId(encodeCustomId('av', 'days', toBase36(params.draftId)))
    .setPlaceholder('Which days could you play?')
    .setMinValues(0)
    .setMaxValues(DAYS.length)
    .addOptions(
      DAYS.map((day) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(DAY_LABELS[day])
          .setValue(String(day))
          .setDefault(selectedDays.has(day)),
      ),
    );

  const windowSelect = new StringSelectMenuBuilder()
    .setCustomId(encodeCustomId('av', 'simplewin', toBase36(params.draftId)))
    .setPlaceholder(perDay ? 'Set per day — use the button below' : 'What times suit you?')
    .setMinValues(0)
    .setMaxValues(WINDOWS.length)
    .setDisabled(perDay)
    .addOptions(
      WINDOWS.map((window) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(WINDOW_LABELS[window])
          .setEmoji(WINDOW_EMOJI[window])
          .setValue(window)
          .setDefault(!perDay && selectedWindows.has(window)),
      ),
    );

  const capacitySelect = new StringSelectMenuBuilder()
    .setCustomId(encodeCustomId('av', 'cap', toBase36(params.draftId)))
    .setPlaceholder('How many sessions this week?')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      CAPACITY_OPTIONS.map((capacity) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(CAPACITY_LABELS[capacity])
          .setValue(String(capacity))
          .setDefault(params.capacity === capacity),
      ),
    );

  const vibeSelect = new StringSelectMenuBuilder()
    .setCustomId(encodeCustomId('av', 'vibe', toBase36(params.draftId)))
    .setPlaceholder('What are you in the mood for? (optional)')
    .setMinValues(0)
    .setMaxValues(MAX_VIBE_SELECTIONS)
    .addOptions(
      VIBE_TAGS.map((tag) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(VIBE_LABELS[tag])
          .setDescription(VIBE_DESCRIPTIONS[tag])
          .setValue(tag)
          .setDefault(params.vibes.includes(tag)),
      ),
    );

  // Submit needs something to submit. Days alone are not availability, and
  // windows alone do not say which days - both halves, or the per-day picker.
  const hasAvailability =
    perDay || (params.selectedDays.length > 0 && params.simpleWindows.length > 0);

  // Five buttons is Discord's hard maximum for one row, and this is all five.
  // The prefills cannot sit above the selects without costing a whole select
  // row, which the four questions already spend in full.
  const buttons = [
    new ButtonBuilder()
      .setCustomId(encodeCustomId('av', 'submit', toBase36(params.draftId)))
      .setLabel('Submit ✓')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!hasAvailability),
    new ButtonBuilder()
      .setCustomId(encodeCustomId('av', 'last', toBase36(params.draftId)))
      .setLabel('Copy last week')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(params.hasLastWeek !== true),
    new ButtonBuilder()
      .setCustomId(encodeCustomId('av', 'usedef', toBase36(params.draftId)))
      .setLabel('Use my defaults')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(params.hasDefaults !== true),
    new ButtonBuilder()
      .setCustomId(encodeCustomId('av', 'perday', toBase36(params.draftId)))
      .setLabel('Per-day times')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(params.selectedDays.length === 0),
    new ButtonBuilder()
      .setCustomId(encodeCustomId('av', 'optout', toBase36(params.groupId)))
      .setLabel("Can't this week")
      .setStyle(ButtonStyle.Secondary),
  ];

  const notes: string[] = [];
  if (perDay) {
    notes.push('Times are set per day. Use **Different times per day** to change them.');
  } else if (params.selectedDays.length > 0 && params.simpleWindows.length > 0) {
    notes.push(
      `That's **${params.simpleWindows.length} window${params.simpleWindows.length === 1 ? '' : 's'}** ` +
        `on each of **${params.selectedDays.length} day${params.selectedDays.length === 1 ? '' : 's'}**.`,
    );
  }

  return {
    content: [
      header(params.groupName, params.timezone, params.weekStartDate),
      '',
      ...(notes.length > 0 ? [notes.join(' '), ''] : []),
      '_Only the group totals are ever shown — never your individual picks._',
    ].join('\n'),
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(daySelect),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(windowSelect),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(capacitySelect),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(vibeSelect),
      new ActionRowBuilder<ButtonBuilder>().addComponents(buttons),
    ],
  };
}
