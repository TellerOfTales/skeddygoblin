/**
 * Week and timezone maths. Pure - takes `now` as an argument, never reads the
 * clock itself, so every branch is testable without mocking time.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERYTHING IS GROUP-LOCAL (read before "fixing" this)
 * ---------------------------------------------------------------------------
 * Availability is captured as day + named window, with no timestamps. That
 * makes a window a LABEL, not an interval - and labels cannot be converted
 * between timezones. Translating "Alice's Wednesday evening" into "Bob's
 * Wednesday evening" would require assigning clock ranges to windows, which is
 * exactly the timestamp model the brief rules out.
 *
 * So: every day/window bucket, the week boundary, and nudge_cutoff_time are
 * interpreted in the GROUP's timezone. app_user.timezone is still stored (the
 * data model requires it) and is used only for rendering absolute times in
 * confirmation copy and for seeding a new group's zone. It is never used in
 * overlap computation.
 */

import type { Day } from './constants.js';

/** A calendar date with no time or zone attached, as 'YYYY-MM-DD'. */
export type IsoDate = string;

const MS_PER_DAY = 86_400_000;

/** Maps Intl's English short weekday onto our ISO index (0 = Monday). */
const WEEKDAY_INDEX: Record<string, Day> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

export class InvalidTimezoneError extends Error {
  constructor(timezone: string) {
    super(`Unknown IANA timezone: ${timezone}`);
    this.name = 'InvalidTimezoneError';
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: Day;
}

/** Decomposes an instant into wall-clock fields as observed in `timezone`. */
function localParts(now: Date, timezone: string): LocalParts {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    throw new InvalidTimezoneError(timezone);
  }

  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`Intl did not return a '${type}' part`);
    return found.value;
  };

  const weekday = WEEKDAY_INDEX[get('weekday')];
  if (weekday === undefined) throw new Error(`Unrecognised weekday: ${get('weekday')}`);

  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday,
  };
}

function formatIsoDate(year: number, month: number, day: number): IsoDate {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * The ISO Monday of the week containing `now`, as observed in `timezone`.
 *
 * Implementation note that matters: the day subtraction happens on a Date built
 * at midnight UTC from the already-localised Y/M/D. Doing the arithmetic on a
 * local-zone Date breaks on DST-transition weeks, where a "day" is 23 or 25
 * hours long. Here we are only ever doing calendar arithmetic on a fixed-offset
 * timeline, so a day is always exactly 86400000ms.
 */
export function weekStartDate(now: Date, timezone: string): IsoDate {
  const { year, month, day, weekday } = localParts(now, timezone);
  const localMidnightUtc = Date.UTC(year, month - 1, day);
  const monday = new Date(localMidnightUtc - weekday * MS_PER_DAY);
  return formatIsoDate(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
}

/** Adds whole days to an IsoDate. Pure calendar arithmetic, zone-independent. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const parsed = parseIsoDate(date);
  const shifted = new Date(parsed.getTime() + days * MS_PER_DAY);
  return formatIsoDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function parseIsoDate(date: IsoDate): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Not an ISO date: ${date}`);
  const [, y, m, d] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

/** The calendar date in `timezone` right now, used as buzz_log.buzz_date. */
export function localDate(now: Date, timezone: string): IsoDate {
  const { year, month, day } = localParts(now, timezone);
  return formatIsoDate(year, month, day);
}

/** Minutes since local midnight, used to compare against a cutoff time. */
export function localMinutesSinceMidnight(now: Date, timezone: string): number {
  const { hour, minute } = localParts(now, timezone);
  return hour * 60 + minute;
}

/** Which ISO weekday it currently is in `timezone`. */
export function localDayOfWeek(now: Date, timezone: string): Day {
  return localParts(now, timezone).weekday;
}

/** Parses 'HH:MM' or 'HH:MM:SS' (Postgres `time`) into minutes since midnight. */
export function parseTimeToMinutes(time: string): number {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!match) throw new Error(`Not a HH:MM time: ${time}`);
  const [, h, m] = match;
  return Number(h) * 60 + Number(m);
}

/**
 * Has a group-local `day` + `time` moment passed, within the current week?
 *
 * Both scheduler predicates reduce to this. Comparing (day, minutes) pairs
 * rather than instants keeps it on the same fuzzy footing as the rest of the
 * model and sidesteps DST entirely.
 */
export function hasWeeklyMomentPassed(
  now: Date,
  timezone: string,
  day: Day,
  minutesSinceMidnight: number,
): boolean {
  const parts = localParts(now, timezone);
  const nowMinutes = parts.hour * 60 + parts.minute;
  if (parts.weekday > day) return true;
  if (parts.weekday < day) return false;
  return nowMinutes >= minutesSinceMidnight;
}

/** Renders 'Mon 10 Aug' for a header line. Display only. */
export function formatWeekLabel(weekStart: IsoDate): string {
  const date = parseIsoDate(weekStart);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date);
}

/**
 * The Monday before a given week start.
 *
 * Arithmetic on a UTC-midnight Date, never a local one: doing it locally breaks
 * on the DST-transition weeks, which is exactly when someone is most likely to
 * be checking what they said last week.
 */
export function previousWeek(weekStartDate: IsoDate): IsoDate {
  const date = new Date(`${weekStartDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 7);
  return date.toISOString().slice(0, 10) as IsoDate;
}
