/**
 * Closed sets and tunable product constants.
 *
 * This module is pure and dependency-free on purpose: it is the vocabulary a
 * future HTTP API or console client would import, alongside the rest of
 * src/domain/.
 */

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/**
 * 0 = Monday .. 6 = Sunday (ISO). Stored as smallint so it can do arithmetic
 * against week_start_date, which is always the ISO Monday.
 */
export const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export type Day = (typeof DAYS)[number];

export const DAY_LABELS: Record<Day, string> = {
  0: 'Monday',
  1: 'Tuesday',
  2: 'Wednesday',
  3: 'Thursday',
  4: 'Friday',
  5: 'Saturday',
  6: 'Sunday',
};

export const DAY_SHORT: Record<Day, string> = {
  0: 'Mon',
  1: 'Tue',
  2: 'Wed',
  3: 'Thu',
  4: 'Fri',
  5: 'Sat',
  6: 'Sun',
};

export function isDay(value: unknown): value is Day {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * Six fixed buckets per day. Declared chronologically, and the Postgres enum
 * `availability_window` is declared in this same order, so `ORDER BY "window"`
 * is chronological for free.
 *
 * A window is a LABEL, not an interval. There are deliberately no clock times
 * here: assigning ranges would be the timestamp model the brief rules out, and
 * would imply windows can be translated between timezones. They cannot - see
 * src/domain/week.ts for why all buckets are group-local.
 */
export const WINDOWS = ['morning', 'lunch', 'afternoon', 'evening', 'night', 'late_night'] as const;
export type Window = (typeof WINDOWS)[number];

export const WINDOW_LABELS: Record<Window, string> = {
  morning: 'Morning',
  lunch: 'Lunch',
  afternoon: 'Afternoon',
  evening: 'Evening',
  night: 'Night',
  late_night: 'Late night',
};

export const WINDOW_EMOJI: Record<Window, string> = {
  morning: '🌅',
  lunch: '🥪',
  afternoon: '☀️',
  evening: '🌆',
  night: '🌙',
  late_night: '🦉',
};

export function isWindow(value: unknown): value is Window {
  return typeof value === 'string' && (WINDOWS as readonly string[]).includes(value);
}

/**
 * Tie-break order when two slots score identically. This is a product judgment
 * about when busy adults actually play, not a data-driven ranking - tune it
 * freely. Lower sorts first (better).
 */
export const WINDOW_PREFERENCE: Record<Window, number> = {
  evening: 0,
  night: 1,
  afternoon: 2,
  late_night: 3,
  lunch: 4,
  morning: 5,
};

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

/**
 * NOTE: 4 means "4 or more", not exactly four. Every consumer clamps to 4, so
 * the encoding is safe, but do not later treat it as an exact count.
 */
export const CAPACITY_OPTIONS = [1, 2, 3, 4] as const;
export type Capacity = (typeof CAPACITY_OPTIONS)[number];
export const MAX_CAPACITY = 4;

export const CAPACITY_LABELS: Record<Capacity, string> = {
  1: '1',
  2: '2',
  3: '3',
  4: '4+',
};

export function isCapacity(value: unknown): value is Capacity {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

// ---------------------------------------------------------------------------
// Vibe tags
// ---------------------------------------------------------------------------

/**
 * Curated, deliberately small. The brief calls for 6-8 options; adding more
 * costs weekly-flow seconds for every member, every week.
 *
 * Mirrored by a CHECK constraint on vibe_tag.tag, so changing this list means a
 * one-line migration.
 */
export const VIBE_TAGS = [
  'chill',
  'competitive',
  'co_op_story',
  'chaos',
  'sweaty',
  'something_new',
  'old_favorite',
  'low_mic',
] as const;
export type VibeTag = (typeof VIBE_TAGS)[number];

export const VIBE_LABELS: Record<VibeTag, string> = {
  chill: 'Chill',
  competitive: 'Competitive',
  co_op_story: 'Co-op story',
  chaos: 'Chaos',
  sweaty: 'Sweaty',
  something_new: 'Something new',
  old_favorite: 'Old favourite',
  low_mic: 'Low mic / quiet',
};

export const VIBE_DESCRIPTIONS: Record<VibeTag, string> = {
  chill: 'Low stakes, easy to drop in and out of',
  competitive: 'Ranked, PvP, actually trying',
  co_op_story: 'Play through something together',
  chaos: 'Party games, dumb fun, chaos',
  sweaty: 'High effort, high focus',
  something_new: 'Try a game none of us have played',
  old_favorite: 'Comfort pick we already know',
  low_mic: "Quiet house - I'd rather not talk much",
};

export function isVibeTag(value: unknown): value is VibeTag {
  return typeof value === 'string' && (VIBE_TAGS as readonly string[]).includes(value);
}

/** Max vibe tags a member may pick in one week. Keeps the select terse. */
export const MAX_VIBE_SELECTIONS = 3;

// ---------------------------------------------------------------------------
// Component layout
// ---------------------------------------------------------------------------

/**
 * Days shown per page of the window picker.
 *
 * FOUR, not five. Discord allows 5 action rows per message and a row holding a
 * select menu may hold nothing else - so five day-selects would consume every
 * row and leave nowhere for Back / Copy / Next. Seven selected days therefore
 * paginate as 4 + 3.
 *
 * The component-legality test enforces this with a maximal fixture, so raising
 * it fails the build rather than someone's DM.
 */
export const DAYS_PER_PAGE = 4;

// ---------------------------------------------------------------------------
// Aggregation / privacy
// ---------------------------------------------------------------------------

/**
 * k-anonymity floor for anything shown to the group.
 *
 * A leaderboard row with a headcount of 1 says "exactly one person is free at
 * this exact slot" - in a small group that is a raw availability disclosure
 * with extra steps, which principle 2 forbids. Windows below this floor are not
 * returned by the query at all (enforced in SQL HAVING, not in the view).
 *
 * A 2-person group's board is inherently mutual disclosure. That is accepted:
 * both parties already know they are the only two. Do not raise this floor to
 * "fix" that - it would make the product useless for small groups.
 */
export const MIN_AGGREGATE_HEADCOUNT = 2;

/** How many windows the leaderboard shows. */
export const TOP_WINDOWS = 3;

// ---------------------------------------------------------------------------
// Weekly cycle defaults
// ---------------------------------------------------------------------------

/** Group-local time the weekly prompt fires (Monday). */
export const WEEKLY_PROMPT_HOUR = 10;
export const WEEKLY_PROMPT_MINUTE = 0;

/** Default nudge cutoff: Thursday 20:00 group-local. */
export const DEFAULT_NUDGE_CUTOFF_DAY: Day = 3;
export const DEFAULT_NUDGE_CUTOFF_TIME = '20:00';

/** Abandoned drafts are pruned after this many days. */
export const DRAFT_TTL_DAYS = 14;

/**
 * A buzz_log row stuck in 'pending' this long is assumed to be from a process
 * that died between COMMIT and notify(). It gets marked 'failed', which
 * re-enables buzzing that target. This deliberately chooses duplicate-risk over
 * silent-loss: the worst case is one extra DM, not a nudge that never arrives.
 */
export const BUZZ_PENDING_TIMEOUT_MINUTES = 5;
