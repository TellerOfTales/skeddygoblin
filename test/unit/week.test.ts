import { describe, expect, it } from 'vitest';
import {
  addDays,
  formatWeekLabel,
  hasWeeklyMomentPassed,
  isValidTimezone,
  localDate,
  localDayOfWeek,
  parseTimeToMinutes,
  weekStartDate,
} from '../../src/domain/week.js';

/**
 * W1. The week boundary is the single piece of arithmetic every other feature
 * depends on, and it is exactly the kind of code that looks right and is wrong
 * at UTC+14 or across a DST transition.
 */
describe('weekStartDate', () => {
  const zones = [
    'UTC',
    'America/Los_Angeles',
    'Pacific/Kiritimati', // UTC+14 - breaks naive implementations
    'Europe/London',
    'America/Santiago', // southern-hemisphere DST
    'Asia/Kolkata', // half-hour offset
  ];

  it('always returns a Monday, for every day of a year, in every zone', () => {
    for (const zone of zones) {
      for (let dayOffset = 0; dayOffset < 366; dayOffset++) {
        const instant = new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + dayOffset * 86_400_000);
        const monday = weekStartDate(instant, zone);

        const asDate = new Date(`${monday}T00:00:00Z`);
        expect(asDate.getUTCDay(), `${zone} @ ${instant.toISOString()} -> ${monday}`).toBe(1);
      }
    }
  });

  it('is stable across a whole ISO week and advances exactly once', () => {
    const zone = 'Europe/London';
    const seen: string[] = [];
    for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
      const instant = new Date(Date.UTC(2026, 5, 1, 12, 0, 0) + dayOffset * 86_400_000);
      seen.push(weekStartDate(instant, zone));
    }
    const distinct = [...new Set(seen)];
    expect(distinct).toHaveLength(2);
    expect(addDays(distinct[0]!, 7)).toBe(distinct[1]);
  });

  it('does not drift across a spring-forward DST boundary', () => {
    // Europe/London springs forward on 2026-03-29 (a Sunday).
    const beforeTransition = new Date('2026-03-28T12:00:00Z');
    const afterTransition = new Date('2026-03-29T12:00:00Z');
    expect(weekStartDate(beforeTransition, 'Europe/London')).toBe('2026-03-23');
    expect(weekStartDate(afterTransition, 'Europe/London')).toBe('2026-03-23');
    // Monday after the transition rolls to the next week.
    expect(weekStartDate(new Date('2026-03-30T12:00:00Z'), 'Europe/London')).toBe('2026-03-30');
  });

  it('respects the zone, not the host clock, at the day boundary', () => {
    // 2026-08-10T02:00Z is still Sunday 2026-08-09 in Los Angeles.
    const instant = new Date('2026-08-10T02:00:00Z');
    expect(weekStartDate(instant, 'UTC')).toBe('2026-08-10');
    expect(weekStartDate(instant, 'America/Los_Angeles')).toBe('2026-08-03');
  });
});

describe('localDate / localDayOfWeek', () => {
  it('reports the calendar date as seen in the zone', () => {
    const instant = new Date('2026-08-10T02:00:00Z');
    expect(localDate(instant, 'UTC')).toBe('2026-08-10');
    expect(localDate(instant, 'America/Los_Angeles')).toBe('2026-08-09');
  });

  it('uses ISO weekday numbering with Monday as 0', () => {
    expect(localDayOfWeek(new Date('2026-08-10T12:00:00Z'), 'UTC')).toBe(0); // Monday
    expect(localDayOfWeek(new Date('2026-08-16T12:00:00Z'), 'UTC')).toBe(6); // Sunday
  });
});

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-08-30', 7)).toBe('2026-09-06');
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('crosses a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
  });
});

describe('parseTimeToMinutes', () => {
  it('accepts HH:MM and Postgres HH:MM:SS', () => {
    expect(parseTimeToMinutes('20:00')).toBe(1200);
    expect(parseTimeToMinutes('20:00:00')).toBe(1200);
    expect(parseTimeToMinutes('00:30')).toBe(30);
  });

  it('rejects nonsense', () => {
    expect(() => parseTimeToMinutes('8pm')).toThrow();
  });
});

describe('hasWeeklyMomentPassed', () => {
  const zone = 'UTC';
  const thursday = 3;
  const eightPm = 20 * 60;

  it('is false earlier in the week', () => {
    expect(hasWeeklyMomentPassed(new Date('2026-08-11T23:00:00Z'), zone, thursday, eightPm)).toBe(
      false,
    );
  });

  it('is false on the day but before the time', () => {
    expect(hasWeeklyMomentPassed(new Date('2026-08-13T19:59:00Z'), zone, thursday, eightPm)).toBe(
      false,
    );
  });

  it('is true exactly at the time', () => {
    expect(hasWeeklyMomentPassed(new Date('2026-08-13T20:00:00Z'), zone, thursday, eightPm)).toBe(
      true,
    );
  });

  it('is true later in the week', () => {
    expect(hasWeeklyMomentPassed(new Date('2026-08-15T09:00:00Z'), zone, thursday, eightPm)).toBe(
      true,
    );
  });

  it('is evaluated in the group zone, not UTC', () => {
    // 2026-08-13T03:00Z is Wednesday 20:00 in Los Angeles - cutoff not reached.
    const instant = new Date('2026-08-13T03:00:00Z');
    expect(hasWeeklyMomentPassed(instant, 'UTC', thursday, eightPm)).toBe(false);
    expect(hasWeeklyMomentPassed(instant, 'America/Los_Angeles', thursday, eightPm)).toBe(false);
    // ...but six hours later it is Thursday 20:00 UTC and only Thursday 13:00 in LA.
    const later = new Date('2026-08-13T20:00:00Z');
    expect(hasWeeklyMomentPassed(later, 'UTC', thursday, eightPm)).toBe(true);
    expect(hasWeeklyMomentPassed(later, 'America/Los_Angeles', thursday, eightPm)).toBe(false);
  });
});

describe('isValidTimezone', () => {
  it('accepts IANA zones and rejects junk', () => {
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
  });
});

describe('formatWeekLabel', () => {
  it('renders a short human label', () => {
    expect(formatWeekLabel('2026-08-10')).toBe('Mon 10 Aug');
  });
});
