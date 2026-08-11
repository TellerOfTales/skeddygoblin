/**
 * Draft mutation for the weekly questionnaire.
 *
 * The draft is the single source of truth while the flow is in progress.
 * availability_slot rows are NOT written here: that table carries a composite
 * foreign key to weekly_response, so slots cannot exist without a submitted
 * response. That is deliberate - it is what makes "a half-finished
 * questionnaire can never contribute to the overlap computation" a structural
 * guarantee rather than something the query has to remember to filter.
 *
 * Everything is written straight to Postgres rather than held in memory, so a
 * deploy mid-flow costs nobody their answers.
 */

import { DomainError } from '../domain/errors.js';
import { DAYS_PER_PAGE } from '../domain/constants.js';
import * as drafts from '../db/repositories/drafts.js';
import type {
  DraftRecord,
  DraftState,
  GroupRecord,
  SlotRow,
  UserId,
  UserRecord,
} from '../db/repositories/types.js';
import type { Capacity, Day, VibeTag, Window } from '../domain/constants.js';
import {
  isCapacity,
  isDay,
  isVibeTag,
  isWindow,
  MAX_VIBE_SELECTIONS,
} from '../domain/constants.js';
import type { AppContext } from './context.js';
import { resolveMemberByDiscordId } from './membershipService.js';

/**
 * Loads a draft and proves the caller owns it.
 *
 * A draft id travels inside a custom_id, and a custom_id is just a string the
 * client hands back - so possessing one is not authorization. Without this
 * check, a forged custom_id would let anyone drive someone else's
 * questionnaire, which is both a correctness bug and a privacy breach.
 */
export async function loadOwnedDraft(
  ctx: AppContext,
  draftId: number,
  selfUserId: UserId,
): Promise<DraftRecord> {
  const draft = await drafts.findDraftById(ctx.db, draftId);
  if (!draft) throw new DomainError('DRAFT_NOT_FOUND');
  if (draft.userId !== selfUserId) throw new DomainError('DRAFT_NOT_OWNED');
  return draft;
}

export interface DraftContext {
  draft: DraftRecord;
  group: GroupRecord;
  user: UserRecord;
}

/**
 * Everything a component handler needs, given only the draft id from a
 * custom_id and the Discord id of whoever clicked.
 *
 * The draft carries its own group, so the handler never has to reach into the
 * database itself - it stays on the service side of the layer boundary, where
 * the ownership check lives.
 */
export async function loadDraftContext(
  ctx: AppContext,
  draftId: number,
  discordUserId: string,
): Promise<DraftContext> {
  const draft = await drafts.findDraftById(ctx.db, draftId);
  if (!draft) throw new DomainError('DRAFT_NOT_FOUND');

  const actor = await resolveMemberByDiscordId(ctx, {
    discordUserId,
    groupId: draft.groupId,
  });

  // Possessing a draft id is not authorization: a custom_id is just a string
  // the client hands back, so ownership is proved here rather than assumed.
  if (draft.userId !== actor.user.id) throw new DomainError('DRAFT_NOT_OWNED');

  return { draft, group: actor.group, user: actor.user };
}

// ---------------------------------------------------------------------------
// Reading draft state (defensively - it is jsonb, so anything could be in it)
// ---------------------------------------------------------------------------

/** Selected days, plus any day carrying explicit per-day windows. */
function daysToEmit(state: DraftState): Day[] {
  const days = new Set<Day>(selectedDays(state));
  for (const key of Object.keys(state.windows ?? {})) {
    const day = Number(key);
    if (isDay(day) && (state.windows?.[key]?.length ?? 0) > 0) days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

export function selectedDays(state: DraftState): Day[] {
  const days = (state.days ?? []).filter(isDay);
  return [...new Set(days)].sort((a, b) => a - b);
}

/** True once the member has set anything in the per-day picker. */
export function hasPerDayWindows(state: DraftState): boolean {
  return Object.values(state.windows ?? {}).some((windows) => windows.length > 0);
}

/** The cross-product windows from the single prompt, applied to every day. */
export function simpleWindows(state: DraftState): Window[] {
  return (state.simpleWindows ?? []).filter(isWindow);
}

/**
 * What this member is actually available for on a given day.
 *
 * Per-day picks win outright when present; otherwise the single prompt's
 * cross-product windows apply to every selected day. Resolving it here, once,
 * is what keeps the precedence rule out of every caller.
 */
export function windowsForDay(state: DraftState, day: Day): Window[] {
  if (hasPerDayWindows(state)) {
    return (state.windows?.[String(day)] ?? []).filter(isWindow);
  }
  return selectedDays(state).includes(day) ? simpleWindows(state) : [];
}

/** Per-day picks only, ignoring the cross product. For rendering the picker. */
export function explicitWindowsForDay(state: DraftState, day: Day): Window[] {
  return (state.windows?.[String(day)] ?? []).filter(isWindow);
}

/** Days with at least one window chosen. */
export function daysWithWindows(state: DraftState): Day[] {
  return selectedDays(state).filter((day) => windowsForDay(state, day).length > 0);
}

export function totalSlotCount(state: DraftState): number {
  return selectedDays(state).reduce<number>(
    (sum, day) => sum + windowsForDay(state, day).length,
    0,
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export function pageCount(state: DraftState): number {
  return Math.max(1, Math.ceil(selectedDays(state).length / DAYS_PER_PAGE));
}

export function daysOnPage(state: DraftState, page: number): Day[] {
  const days = selectedDays(state);
  return days.slice(page * DAYS_PER_PAGE, page * DAYS_PER_PAGE + DAYS_PER_PAGE);
}

export function pageForDay(state: DraftState, day: Day): number {
  const index = selectedDays(state).indexOf(day);
  return index < 0 ? 0 : Math.floor(index / DAYS_PER_PAGE);
}

export function clampPage(state: DraftState, page: number): number {
  return Math.min(Math.max(page, 0), pageCount(state) - 1);
}

// ---------------------------------------------------------------------------
// Mutations. Each is a whole-object write - the state is well under 1KB.
// ---------------------------------------------------------------------------

/**
 * Replaces the chosen days.
 *
 * Windows for days that are no longer selected are dropped, so deselecting
 * Wednesday and re-selecting it later does not silently resurrect answers the
 * member thought they had removed.
 */
/** Row 2 of the single prompt. A no-op on per-day state, which always wins. */
export async function setSimpleWindows(
  ctx: AppContext,
  draft: DraftRecord,
  windows: Window[],
): Promise<DraftRecord> {
  return drafts.saveDraftState(ctx.db, draft.id, {
    ...draft.state,
    simpleWindows: [...new Set(windows.filter(isWindow))],
  });
}

/**
 * Seeds the per-day picker from the cross product, so it opens showing what the
 * member already said rather than blank. This is what makes the switch from the
 * single prompt to per-day editing lossless - they are editing, not restarting.
 */
export async function seedPerDayWindows(ctx: AppContext, draft: DraftRecord): Promise<DraftRecord> {
  if (hasPerDayWindows(draft.state)) return draft;

  const seed = simpleWindows(draft.state);
  if (seed.length === 0) return draft;

  const windows: Record<string, Window[]> = {};
  for (const day of selectedDays(draft.state)) windows[String(day)] = [...seed];

  return drafts.saveDraftState(ctx.db, draft.id, { ...draft.state, windows });
}

export async function setDays(
  ctx: AppContext,
  draft: DraftRecord,
  days: Day[],
): Promise<DraftRecord> {
  const keep = [...new Set(days.filter(isDay))].sort((a, b) => a - b);
  const previous = draft.state.windows ?? {};
  const windows: Record<string, Window[]> = {};
  for (const day of keep) {
    const existing = previous[String(day)];
    if (existing && existing.length > 0) windows[String(day)] = existing.filter(isWindow);
  }

  return drafts.saveDraftState(ctx.db, draft.id, { ...draft.state, days: keep, windows });
}

export async function setWindowsForDay(
  ctx: AppContext,
  draft: DraftRecord,
  day: Day,
  windows: Window[],
): Promise<DraftRecord> {
  const next: Record<string, Window[]> = { ...(draft.state.windows ?? {}) };
  const cleaned = [...new Set(windows.filter(isWindow))];

  if (cleaned.length === 0) delete next[String(day)];
  else next[String(day)] = cleaned;

  return drafts.saveDraftState(ctx.db, draft.id, { ...draft.state, windows: next });
}

export async function setCapacity(
  ctx: AppContext,
  draft: DraftRecord,
  capacity: Capacity,
): Promise<DraftRecord> {
  return drafts.saveDraftState(ctx.db, draft.id, { ...draft.state, capacity });
}

export async function setVibes(
  ctx: AppContext,
  draft: DraftRecord,
  vibes: VibeTag[],
): Promise<DraftRecord> {
  const cleaned = [...new Set(vibes.filter(isVibeTag))].slice(0, MAX_VIBE_SELECTIONS);
  return drafts.saveDraftState(ctx.db, draft.id, { ...draft.state, vibes: cleaned });
}

export function chosenCapacity(state: DraftState): Capacity | undefined {
  return isCapacity(state.capacity) ? state.capacity : undefined;
}

export function chosenVibes(state: DraftState): VibeTag[] {
  return (state.vibes ?? []).filter(isVibeTag);
}

/**
 * Flattens the draft into the slot rows that will be written on submit.
 *
 * Days with no windows contribute nothing, which is how "leave a day empty to
 * skip it" works without a separate deselect step.
 */
export function toSlotRows(state: DraftState): SlotRow[] {
  const rows: SlotRow[] = [];
  // Union rather than selectedDays alone: a per-day entry for a day missing
  // from `days` would otherwise be silently dropped, and quietly losing
  // someone's stated availability is the one failure mode worth being
  // defensive about here.
  for (const day of daysToEmit(state)) {
    for (const window of windowsForDay(state, day)) {
      rows.push({ dayOfWeek: day, window });
    }
  }
  return rows;
}

/**
 * Copies one day's windows onto every selected day.
 *
 * This is the highest-leverage affordance in the whole flow: "I'm free
 * evenings, always" is the single most common shape of answer, and this turns
 * it from up to seven interactions into one.
 */
export async function copyWindowsToAllDays(
  ctx: AppContext,
  draft: DraftRecord,
  sourceDay: Day,
): Promise<DraftRecord> {
  const source = windowsForDay(draft.state, sourceDay);
  const next: Record<string, Window[]> = {};

  for (const day of selectedDays(draft.state)) {
    if (source.length > 0) next[String(day)] = [...source];
  }

  return drafts.saveDraftState(ctx.db, draft.id, { ...draft.state, windows: next });
}
