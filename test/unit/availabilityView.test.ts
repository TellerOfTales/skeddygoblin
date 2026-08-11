/**
 * Every view, rendered with a MAXIMAL fixture and checked against Discord's
 * real component limits.
 *
 * This is the test that keeps the 7x6 grid honest. Exceeding a limit surfaces
 * at send time as an opaque 400 from the API, in a member's DM - the worst
 * possible place to find out. Here it is a build failure.
 */

import { describe, expect, it } from 'vitest';
import { assertLegalMessage } from '../../src/discord/componentLimits.js';
import {
  dayPickerView,
  noWindowsChosenView,
  optedOutView,
  singlePromptView,
  submittedView,
  windowPickerView,
} from '../../src/discord/views/availability.view.js';
import { DAYS, DAYS_PER_PAGE, WINDOWS, type Day, type Window } from '../../src/domain/constants.js';
import { parseCustomId } from '../../src/discord/customId.js';

const BASE = {
  draftId: 987_654,
  groupId: 4_096,
  groupName: 'The Basement Crew',
  timezone: 'America/Los_Angeles',
  weekStartDate: '2026-08-10',
};

/** Everything selected: 7 days, all 6 windows each. */
function maximalWindows(): Record<string, Window[]> {
  return Object.fromEntries(DAYS.map((day) => [String(day), [...WINDOWS]]));
}

interface RawComponent {
  type: number;
  custom_id?: string;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  max_values?: number;
  options?: Array<{ value: string; label?: string; default?: boolean }>;
}

interface RawRow {
  components: RawComponent[];
}

function rows(view: { components?: readonly unknown[] | undefined }): RawRow[] {
  return (view.components ?? []).map((row) => (row as { toJSON(): RawRow }).toJSON());
}

describe('dayPickerView', () => {
  it('is legal with every day preselected', () => {
    const view = dayPickerView({ ...BASE, selectedDays: [...DAYS] });
    expect(() => assertLegalMessage(view, 'dayPicker')).not.toThrow();
  });

  it('offers exactly seven days and lets all seven be chosen', () => {
    const [selectRow] = rows(dayPickerView({ ...BASE, selectedDays: [] }));
    const select = selectRow!.components[0]!;
    expect(select.options).toHaveLength(7);
    expect(select.max_values).toBe(7);
  });

  /**
   * Discord forgets a select's selection across update(). If defaults are not
   * re-applied from stored state, going back a step looks like the bot lost
   * the member's answers.
   */
  it('re-applies the current selection as defaults', () => {
    const [selectRow] = rows(dayPickerView({ ...BASE, selectedDays: [1, 4] }));
    const options = selectRow!.components[0]!.options as Array<{
      value: string;
      default?: boolean;
    }>;

    const defaulted = options.filter((option) => option.default).map((option) => option.value);
    expect(defaulted).toEqual(['1', '4']);
  });

  it('always offers the escape hatch', () => {
    const view = dayPickerView({ ...BASE, selectedDays: [0] });
    const navRow = rows(view)[1]!;
    const parsed = parseCustomId(navRow.components[0]!.custom_id!);
    expect(parsed.action).toBe('optout');
  });
});

describe('windowPickerView', () => {
  const allDays = [...DAYS] as Day[];

  it('is legal on every page of the worst case: 7 days, all windows', () => {
    const totalPages = Math.ceil(allDays.length / DAYS_PER_PAGE);
    for (let page = 0; page < totalPages; page++) {
      const view = windowPickerView({
        ...BASE,
        days: allDays,
        windowsByDay: maximalWindows(),
        page,
      });
      expect(() => assertLegalMessage(view, `windowPicker page ${page}`)).not.toThrow();
    }
  });

  /**
   * The reason DAYS_PER_PAGE is 4: five day-selects would consume all five
   * action rows and leave nowhere for Back / Copy / Next.
   */
  it('never uses more than four selects, leaving row five for navigation', () => {
    const view = windowPickerView({ ...BASE, days: allDays, windowsByDay: {}, page: 0 });
    const parsed = rows(view);

    expect(parsed).toHaveLength(5);

    const selectRows = parsed.filter((row) => row.components[0]?.type === 3);
    const buttonRows = parsed.filter((row) => row.components[0]?.type === 2);
    expect(selectRows).toHaveLength(DAYS_PER_PAGE);
    expect(buttonRows).toHaveLength(1);
  });

  it('paginates seven days as 4 + 3', () => {
    const first = rows(windowPickerView({ ...BASE, days: allDays, windowsByDay: {}, page: 0 }));
    const second = rows(windowPickerView({ ...BASE, days: allDays, windowsByDay: {}, page: 1 }));

    expect(first.filter((row) => row.components[0]?.type === 3)).toHaveLength(4);
    expect(second.filter((row) => row.components[0]?.type === 3)).toHaveLength(3);
  });

  it('re-applies each day’s chosen windows as defaults', () => {
    const view = windowPickerView({
      ...BASE,
      days: [0, 1],
      windowsByDay: { '0': ['evening', 'night'], '1': [] },
      page: 0,
    });
    const [mondayRow, tuesdayRow] = rows(view);

    const mondayDefaults = (
      mondayRow!.components[0]!.options as Array<{ value: string; default?: boolean }>
    )
      .filter((option) => option.default)
      .map((option) => option.value);
    const tuesdayDefaults = (
      tuesdayRow!.components[0]!.options as Array<{ value: string; default?: boolean }>
    ).filter((option) => option.default);

    expect(mondayDefaults).toEqual(['evening', 'night']);
    expect(tuesdayDefaults).toEqual([]);
  });

  it('allows clearing a day without deselecting it upstream', () => {
    const view = windowPickerView({ ...BASE, days: [0], windowsByDay: {}, page: 0 });
    const select = rows(view)[0]!.components[0] as { min_values?: number };
    expect(select.min_values).toBe(0);
  });

  it('ends the last page with Done and earlier pages with Next', () => {
    const firstNav = rows(
      windowPickerView({ ...BASE, days: allDays, windowsByDay: {}, page: 0 }),
    ).at(-1)!;
    const lastNav = rows(
      windowPickerView({ ...BASE, days: allDays, windowsByDay: {}, page: 1 }),
    ).at(-1)!;

    expect(parseCustomId(firstNav.components.at(-1)!.custom_id!).action).toBe('page');
    expect(parseCustomId(lastNav.components.at(-1)!.custom_id!).action).toBe('done');
  });

  it('omits copy-to-all when only one day is selected', () => {
    const nav = rows(windowPickerView({ ...BASE, days: [3], windowsByDay: {}, page: 0 })).at(-1)!;
    const actions = nav.components.map((component) => parseCustomId(component.custom_id!).action);
    expect(actions).not.toContain('copy');
  });

  it('clamps an out-of-range page rather than rendering nothing', () => {
    const view = windowPickerView({ ...BASE, days: [0, 1], windowsByDay: {}, page: 99 });
    expect(() => assertLegalMessage(view, 'clamped')).not.toThrow();
    expect(rows(view).filter((row) => row.components[0]?.type === 3).length).toBeGreaterThan(0);
  });

  it('every custom_id is routable and within budget', () => {
    const view = windowPickerView({
      ...BASE,
      draftId: Number.MAX_SAFE_INTEGER,
      days: allDays,
      windowsByDay: maximalWindows(),
      page: 0,
    });
    for (const row of rows(view)) {
      for (const component of row.components) {
        expect(component.custom_id!.length).toBeLessThanOrEqual(100);
        expect(() => parseCustomId(component.custom_id!)).not.toThrow();
      }
    }
  });
});

describe('terminal views', () => {
  it('the submitted view reassures about privacy and offers to remember it', () => {
    const view = submittedView({
      userId: 3,
      autoApply: false,
      groupName: 'The Basement',
      weekStartDate: '2026-08-10',
      capacity: 2,
      slotCount: 6,
      dayCount: 3,
      vibes: ['Casual'],
    });
    expect(view.content).toMatch(/never your individual picks/);

    // Saving a template belongs here, not in the prompt: that button row is
    // already at Discord's five-button ceiling, and "remember what I just
    // built" is easier to understand than configuring a template elsewhere.
    const [row] = rows(view);
    expect(row!.components.map((component) => component.label)).toEqual([
      'Save as my defaults',
      'Auto-answer every week',
    ]);
  });

  it('reflects saved defaults rather than offering to save them twice', () => {
    const view = submittedView({
      userId: 3,
      autoApply: true,
      savedAsDefaults: true,
      groupName: 'The Basement',
      weekStartDate: '2026-08-10',
      capacity: 2,
      slotCount: 6,
      dayCount: 3,
      vibes: [],
    });
    const [save, auto] = rows(view)[0]!.components;

    expect(save!.label).toBe('Defaults saved ✓');
    expect(save!.disabled).toBe(true);
    expect(auto!.label).toBe('Auto-answer: on');
    // The cross-server timezone caveat is stated where it applies.
    expect(view.content).toMatch(/each server's own local time/);
  });

  it('the opted-out view offers exactly one way back and no guilt', () => {
    const view = optedOutView({
      groupId: 7,
      groupName: 'The Basement',
      weekStartDate: '2026-08-10',
    });

    // Exactly one button. Opting out inside a DM used to strip every component
    // and point at a slash command that could not be run from there, which left
    // people with no way back in at all.
    const [row, ...rest] = rows(view);
    expect(rest).toHaveLength(0);
    expect(row!.components).toHaveLength(1);
    expect(row!.components[0]!.label).toBe("Actually, I'm in");

    // No guilt copy, no "are you sure".
    expect(view.content).not.toMatch(/sure|really|sorry|miss/i);
  });

  it('the empty-selection view stays legal and keeps the picker on screen', () => {
    const view = noWindowsChosenView({
      draftId: BASE.draftId,
      groupName: BASE.groupName,
      timezone: BASE.timezone,
      weekStartDate: BASE.weekStartDate,
      days: [...DAYS],
      windowsByDay: {},
    });
    expect(() => assertLegalMessage(view, 'noWindowsChosen')).not.toThrow();
  });
});

describe('singlePromptView', () => {
  const base = {
    draftId: 42,
    groupId: 7,
    groupName: 'The Basement',
    timezone: 'Europe/London',
    weekStartDate: '2026-08-10' as const,
    selectedDays: [] as Day[],
    simpleWindows: [] as Window[],
    windowsByDay: {},
    capacity: undefined,
    vibes: [],
  };

  it('fits Discord: five rows, everything on one message', () => {
    assertLegalMessage(
      singlePromptView({
        ...base,
        selectedDays: [0, 1, 2, 3, 4, 5, 6],
        simpleWindows: [...WINDOWS],
        capacity: 4,
        vibes: ['Co-op', 'Action', 'Strategy'],
      }),
    );
    expect(rows(singlePromptView(base))).toHaveLength(5);
  });

  it('puts Submit at the bottom, disabled until there is something to submit', () => {
    const empty = rows(singlePromptView(base)).at(-1)!.components[0]!;
    expect(empty.label).toBe('Submit ✓');
    expect(empty.disabled).toBe(true);

    // Days alone are not availability, and windows alone do not say which days.
    const daysOnly = rows(singlePromptView({ ...base, selectedDays: [2] })).at(-1)!.components[0]!;
    expect(daysOnly.disabled).toBe(true);

    const both = rows(
      singlePromptView({ ...base, selectedDays: [2], simpleWindows: ['evening'] }),
    ).at(-1)!.components[0]!;
    expect(both.disabled).toBe(false);
  });

  it('re-renders every selection as selected, so the bot never looks like it ate an answer', () => {
    const view = singlePromptView({
      ...base,
      selectedDays: [2, 4],
      simpleWindows: ['evening'],
      capacity: 2,
      vibes: ['Co-op'],
    });
    const parsed = rows(view);

    const defaults = (row: number) =>
      parsed[row]!.components[0]!.options!.filter((option) => option.default).map(
        (option) => option.value,
      );

    expect(defaults(0)).toEqual(['2', '4']);
    expect(defaults(1)).toEqual(['evening']);
    expect(defaults(2)).toEqual(['2']);
    expect(defaults(3)).toEqual(['Co-op']);
  });

  /**
   * The precedence rule. Once someone has set windows per day, one careless tap
   * on the broad select must not be able to flatten that back to a cross
   * product - which would be indistinguishable from losing their answers.
   */
  it('disables the shared window select once per-day windows exist', () => {
    const view = singlePromptView({
      ...base,
      selectedDays: [2, 4],
      simpleWindows: ['evening'],
      windowsByDay: { '2': ['evening'], '4': ['afternoon'] },
    });
    const windowSelect = rows(view)[1]!.components[0]!;

    expect(windowSelect.disabled).toBe(true);
    expect(windowSelect.placeholder).toContain('per day');
    // ...and it shows nothing selected, rather than a misleading subset.
    expect(windowSelect.options!.every((option) => !option.default)).toBe(true);
  });

  it('offers per-day times only once there are days to apply them to', () => {
    const button = (params: Parameters<typeof singlePromptView>[0], label: string) =>
      rows(singlePromptView(params))
        .at(-1)!
        .components.find((component) => component.label === label)!;

    expect(button(base, 'Per-day times').disabled).toBe(true);
    expect(button({ ...base, selectedDays: [2] }, 'Per-day times').disabled).toBe(false);
  });

  /**
   * Five buttons is Discord's hard maximum for a row, and this view uses all
   * five. Adding a sixth silently breaks the message, so pin the count.
   */
  it('fills the button row exactly, prefills included', () => {
    const buttons = rows(singlePromptView(base)).at(-1)!.components;
    expect(buttons.map((component) => component.label)).toEqual([
      'Submit ✓',
      'Copy last week',
      'Use my defaults',
      'Per-day times',
      "Can't this week",
    ]);
  });

  it('disables a prefill that has nothing to offer, rather than lying', () => {
    const find = (params: Parameters<typeof singlePromptView>[0], label: string) =>
      rows(singlePromptView(params))
        .at(-1)!
        .components.find((component) => component.label === label)!;

    expect(find(base, 'Copy last week').disabled).toBe(true);
    expect(find(base, 'Use my defaults').disabled).toBe(true);

    const offered = { ...base, hasLastWeek: true, hasDefaults: true };
    expect(find(offered, 'Copy last week').disabled).toBe(false);
    expect(find(offered, 'Use my defaults').disabled).toBe(false);
  });

  it('always leaves the escape hatch available', () => {
    const escape = rows(singlePromptView(base)).at(-1)!.components.at(-1)!;
    expect(escape.label).toBe("Can't this week");
    expect(escape.disabled).toBeFalsy();
  });
});
