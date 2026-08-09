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

export function selectedDays(state: DraftState): Day[] {
  const days = (state.days ?? []).filter(isDay);
  return [...new Set(days)].sort((a, b) => a - b);
}

export function windowsForDay(state: DraftState, day: Day): Window[] {
  const windows = state.windows?.[String(day)] ?? [];
  return windows.filter(isWindow);
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
  for (const day of selectedDays(state)) {
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
