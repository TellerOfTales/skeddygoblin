import { describe, expect, it } from 'vitest';
import {
  compareSlots,
  rankWindows,
  scoreSlot,
  type SlotAggregate,
} from '../../src/domain/overlap.js';
import { MAX_CAPACITY, type Day, type Window } from '../../src/domain/constants.js';

function slot(dayOfWeek: Day, window: Window, headcount: number, score: number): SlotAggregate {
  return { dayOfWeek, window, headcount, score };
}

describe('scoreSlot', () => {
  it('is headcount plus a bounded capacity bonus', () => {
    // Two people, both at full capacity, in a group of 2: alpha = 0.25.
    expect(scoreSlot([4, 4], 2)).toBeCloseTo(2 + 2 * 0.25, 10);
  });

  it('gives a larger bonus to attendees with more sessions left', () => {
    const lowCapacity = scoreSlot([1, 1], 4);
    const highCapacity = scoreSlot([4, 4], 4);
    expect(highCapacity).toBeGreaterThan(lowCapacity);
    expect(lowCapacity).toBeGreaterThan(2); // still strictly above raw headcount
  });

  it('scores an empty slot as zero', () => {
    expect(scoreSlot([], 5)).toBe(0);
  });

  it('clamps capacity at MAX_CAPACITY so "4+" cannot buy extra weight', () => {
    expect(scoreSlot([MAX_CAPACITY], 3)).toBeCloseTo(scoreSlot([99], 3), 10);
  });
});

/**
 * O2. The single property the whole scoring design rests on: capacity is a
 * tie-breaker and must never overturn headcount. Three people who can play beat
 * two people who can play, whatever their remaining capacities.
 */
describe('headcount dominance', () => {
  it('k+1 people always outrank k people, for every capacity assignment', () => {
    for (let totalResponders = 1; totalResponders <= 12; totalResponders++) {
      for (let k = 1; k < totalResponders; k++) {
        // Best possible case for k people: everyone at maximum capacity.
        const bestForK = scoreSlot(Array(k).fill(MAX_CAPACITY), totalResponders);
        // Worst possible case for k+1 people: everyone at minimum capacity.
        const worstForKPlusOne = scoreSlot(Array(k + 1).fill(1), totalResponders);

        expect(
          worstForKPlusOne,
          `N=${totalResponders}, k=${k}: ${worstForKPlusOne} should beat ${bestForK}`,
        ).toBeGreaterThan(bestForK);
      }
    }
  });
});

describe('compareSlots', () => {
  it('orders by score, then headcount, then window preference, then day', () => {
    const higherScore = slot(4, 'morning', 2, 2.5);
    const lowerScore = slot(0, 'evening', 2, 2.1);
    expect(compareSlots(higherScore, lowerScore)).toBeLessThan(0);

    // Equal score and headcount: evening (pref 0) beats morning (pref 5).
    const evening = slot(4, 'evening', 2, 2.0);
    const morning = slot(0, 'morning', 2, 2.0);
    expect(compareSlots(evening, morning)).toBeLessThan(0);

    // Equal on everything but the day: earlier day first.
    const monday = slot(0, 'evening', 2, 2.0);
    const friday = slot(4, 'evening', 2, 2.0);
    expect(compareSlots(monday, friday)).toBeLessThan(0);
  });

  it('is a total order - no two distinct slots compare equal', () => {
    const slots: SlotAggregate[] = [
      slot(0, 'evening', 2, 2.0),
      slot(0, 'night', 2, 2.0),
      slot(1, 'evening', 2, 2.0),
      slot(2, 'morning', 3, 3.1),
    ];
    for (const a of slots) {
      for (const b of slots) {
        if (a === b) continue;
        expect(compareSlots(a, b)).not.toBe(0);
      }
    }
  });
});

describe('rankWindows', () => {
  it('prefers distinct days over consecutive windows on one strong day', () => {
    const aggregates = [
      slot(2, 'evening', 4, 4.4), // Wednesday, best
      slot(2, 'night', 4, 4.3), // Wednesday again
      slot(2, 'afternoon', 4, 4.2), // Wednesday again
      slot(0, 'evening', 3, 3.3), // Monday
      slot(5, 'afternoon', 3, 3.2), // Saturday
    ];

    const ranked = rankWindows(aggregates, 3);

    expect(ranked.map((s) => s.dayOfWeek)).toEqual([2, 0, 5]);
    expect(new Set(ranked.map((s) => s.dayOfWeek)).size).toBe(3);
  });

  it('backfills from the same day when there are not enough distinct days', () => {
    const aggregates = [
      slot(5, 'evening', 4, 4.4),
      slot(5, 'night', 4, 4.3),
      slot(5, 'afternoon', 3, 3.2),
    ];

    const ranked = rankWindows(aggregates, 3);

    expect(ranked).toHaveLength(3);
    expect(ranked.map((s) => s.window)).toEqual(['evening', 'night', 'afternoon']);
  });

  it('returns fewer than the limit when there is not enough overlap', () => {
    expect(rankWindows([slot(1, 'evening', 2, 2.2)], 3)).toHaveLength(1);
    expect(rankWindows([], 3)).toEqual([]);
  });

  it('does not mutate its input', () => {
    const aggregates = [slot(3, 'night', 2, 2.1), slot(1, 'evening', 4, 4.4)];
    const snapshot = [...aggregates];
    rankWindows(aggregates, 2);
    expect(aggregates).toEqual(snapshot);
  });

  it('never exposes a user identity field', () => {
    const ranked = rankWindows([slot(1, 'evening', 3, 3.3)], 3);
    for (const row of ranked) {
      expect(Object.keys(row).sort()).toEqual(['dayOfWeek', 'headcount', 'score', 'window']);
    }
  });
});
