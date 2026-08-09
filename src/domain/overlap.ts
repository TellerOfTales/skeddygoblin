/**
 * Overlap scoring and ranking. Pure: operates on aggregate rows, never on
 * per-user records.
 *
 * Note the shape of `SlotAggregate` - it has no user-identity field, by
 * construction. That is the privacy invariant expressed as a type: there is
 * nothing in a ranked window that could identify who is free when.
 */

import { WINDOW_PREFERENCE, MAX_CAPACITY, type Day, type Window } from './constants.js';

/** One (day, window) cell with its group-level rollup. No user ids. Ever. */
export interface SlotAggregate {
  dayOfWeek: Day;
  window: Window;
  /** Eligible members who marked this slot. */
  headcount: number;
  /** headcount + bounded capacity bonus. See scoreSlot(). */
  score: number;
}

/**
 * The scoring formula, as a pure function over the remaining capacities of the
 * members available at one slot.
 *
 * The brief asks for "per-slot headcount weighted by remaining capacity". The
 * weighting must never let capacity outrank headcount - three free people
 * beating two is the entire product - so capacity is a *bounded* bonus:
 *
 *     alpha = 0.5 / N                       (N = total submitted responders)
 *     rHat(u) = min(remaining(u), 4) / 4    in (0, 1]
 *     score = sum over available u of [ 1 + alpha * rHat(u) ]
 *
 * Dominance proof: the most k people can score is k*(1+alpha); the least k+1
 * can score is k+1. Since k <= N, k*alpha = 0.5k/N <= 0.5 < 1, so
 * k*(1+alpha) < k+1. Headcount strictly dominates and capacity only ever breaks
 * ties between equal-headcount slots - preferring the slot whose attendees have
 * more sessions left to spend.
 *
 * This is mirrored by the SQL in src/db/repositories/overlap.ts; the O1 test
 * asserts the two agree exactly, including ordering.
 *
 * @param remainingCapacities remaining capacity of each member available here.
 *        Members at zero are expected to be filtered out before this call.
 * @param totalResponders N, the count of submitted responders in the group/week.
 */
export function scoreSlot(remainingCapacities: readonly number[], totalResponders: number): number {
  const n = Math.max(totalResponders, 1);
  const alpha = 0.5 / n;
  let score = 0;
  for (const remaining of remainingCapacities) {
    const rHat = Math.min(remaining, MAX_CAPACITY) / MAX_CAPACITY;
    score += 1 + alpha * rHat;
  }
  return score;
}

/**
 * Total order over slots. Deterministic all the way down so the SQL and the
 * reference implementation can be compared for exact equality.
 *
 * score desc -> headcount desc (redundant given dominance, but explicit and
 * cheap) -> window preference -> day.
 */
export function compareSlots(a: SlotAggregate, b: SlotAggregate): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.headcount !== a.headcount) return b.headcount - a.headcount;
  const pref = WINDOW_PREFERENCE[a.window] - WINDOW_PREFERENCE[b.window];
  if (pref !== 0) return pref;
  return a.dayOfWeek - b.dayOfWeek;
}

/**
 * Picks the top `limit` slots, preferring distinct days.
 *
 * Offering "Wed evening / Wed night / Wed afternoon" is a worse product for
 * busy adults than three different days - if Wednesday doesn't work for you,
 * the whole board is useless. So: greedily take the best slot on each day not
 * yet represented, then backfill in score order if fewer than `limit` distinct
 * days qualify (a group whose only overlap is Saturday still gets a board).
 */
export function rankWindows(aggregates: readonly SlotAggregate[], limit: number): SlotAggregate[] {
  const ordered = [...aggregates].sort(compareSlots);

  const picked: SlotAggregate[] = [];
  const usedDays = new Set<Day>();

  for (const slot of ordered) {
    if (picked.length >= limit) break;
    if (usedDays.has(slot.dayOfWeek)) continue;
    picked.push(slot);
    usedDays.add(slot.dayOfWeek);
  }

  if (picked.length < limit) {
    const alreadyPicked = new Set(picked);
    for (const slot of ordered) {
      if (picked.length >= limit) break;
      if (alreadyPicked.has(slot)) continue;
      picked.push(slot);
    }
  }

  return picked;
}
