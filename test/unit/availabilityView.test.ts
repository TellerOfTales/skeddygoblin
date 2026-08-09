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
  capacityVibeView,
  dayPickerView,
  noWindowsChosenView,
  optedOutView,
  submittedView,
  windowPickerView,
} from '../../src/discord/views/availability.view.js';
import {
  DAYS,
  DAYS_PER_PAGE,
  MAX_VIBE_SELECTIONS,
  VIBE_TAGS,
  WINDOWS,
  type Day,
  type VibeTag,
  type Window,
} from '../../src/domain/constants.js';
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

interface RawRow {
  components: Array<{ type: number; custom_id?: string; options?: unknown[]; max_values?: number }>;
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

describe('capacityVibeView', () => {
  const params = {
    ...BASE,
    capacity: undefined,
    vibes: [] as VibeTag[],
    slotCount: 12,
    dayCount: 4,
  };

  it('is legal with every vibe selected and a maximal draft id', () => {
    const view = capacityVibeView({
      ...params,
      draftId: Number.MAX_SAFE_INTEGER,
      capacity: 4,
      vibes: [...VIBE_TAGS].slice(0, MAX_VIBE_SELECTIONS),
    });
    expect(() => assertLegalMessage(view, 'capacityVibe')).not.toThrow();
  });

  it('fits capacity, vibe and navigation into three rows', () => {
    const parsed = rows(capacityVibeView(params));
    expect(parsed).toHaveLength(3);
    expect(parsed[0]!.components).toHaveLength(4); // 1 / 2 / 3 / 4+
    expect(parsed[1]!.components[0]!.type).toBe(3); // vibe select
  });

  /**
   * Capacity is the one genuinely required answer. Disabling Submit until it is
   * given beats letting the tap fail.
   */
  it('disables Submit until a capacity is chosen, then enables it', () => {
    const before = rows(capacityVibeView(params)).at(-1)!;
    const after = rows(capacityVibeView({ ...params, capacity: 2 })).at(-1)!;

    const submitOf = (row: RawRow) =>
      row.components.find(
        (component) => parseCustomId(component.custom_id!).action === 'submit',
      ) as { disabled?: boolean };

    expect(submitOf(before).disabled).toBe(true);
    expect(submitOf(after).disabled).toBeFalsy();
  });

  it('shows the chosen capacity as the only highlighted button', () => {
    const capacityRow = rows(capacityVibeView({ ...params, capacity: 3 }))[0]!;
    const highlighted = capacityRow.components.filter(
      (component) => (component as { style?: number }).style === 3, // ButtonStyle.Success
    );
    expect(highlighted).toHaveLength(1);
  });

  it('caps vibe selection at the curated maximum', () => {
    const select = rows(capacityVibeView(params))[1]!.components[0]!;
    expect(select.options).toHaveLength(VIBE_TAGS.length);
    expect(select.max_values).toBe(MAX_VIBE_SELECTIONS);
  });

  it('keeps the escape hatch reachable at the last step', () => {
    const nav = rows(capacityVibeView(params)).at(-1)!;
    const actions = nav.components.map((component) => parseCustomId(component.custom_id!).action);
    expect(actions).toContain('optout');
  });
});

describe('terminal views', () => {
  it('the submitted view reassures about privacy and strips components', () => {
    const view = submittedView({
      groupName: 'The Basement',
      weekStartDate: '2026-08-10',
      capacity: 2,
      slotCount: 6,
      dayCount: 3,
      vibes: ['chill'],
    });
    expect(view.components).toEqual([]);
    expect(view.content).toMatch(/never your individual picks/);
  });

  it('the opted-out view strips all components, so the flow is visibly over', () => {
    const view = optedOutView({ groupName: 'The Basement', weekStartDate: '2026-08-10' });
    expect(view.components).toEqual([]);
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
