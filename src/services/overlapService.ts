/**
 * Ranked overlap windows for a group's week.
 *
 * The only group-visible product of everyone's private answers. Everything it
 * returns is an aggregate; nothing it returns can be traced to a member.
 */

import { MIN_AGGREGATE_HEADCOUNT, TOP_WINDOWS } from '../domain/constants.js';
import { rankWindows, type SlotAggregate } from '../domain/overlap.js';
import * as overlap from '../db/repositories/overlap.js';
import * as vibes from '../db/repositories/vibes.js';
import * as weeklyResponses from '../db/repositories/weeklyResponses.js';
import type { GroupId } from '../db/repositories/types.js';
import type { VibeTag } from '../domain/constants.js';
import type { IsoDate } from '../domain/week.js';
import type { AppContext } from './context.js';

export interface OverlapReport {
  weekStartDate: IsoDate;
  /** Top windows, already day-diversified. Never more than TOP_WINDOWS. */
  windows: SlotAggregate[];
  responded: number;
  total: number;
  /** Group mood, as counts only - never who picked what. */
  topVibes: Array<{ tag: VibeTag; count: number }>;
  /**
   * True when there are candidate slots but all fall below the k-anonymity
   * floor, so the board is empty for a privacy reason rather than an
   * availability one. Lets the copy say something honest.
   */
  suppressedForPrivacy: boolean;
}

export async function buildOverlapReport(
  ctx: AppContext,
  params: { groupId: GroupId; weekStartDate: IsoDate; limit?: number },
): Promise<OverlapReport> {
  const scope = { groupId: params.groupId, weekStartDate: params.weekStartDate };

  // Sequential, not Promise.all: a Db may be backed by a single client (inside
  // a transaction, or in tests), and pg cannot run concurrent queries on one
  // connection. These are four indexed reads - the round trips are not the cost
  // worth optimising here.
  const aggregates = await overlap.rankWindowAggregate(ctx.db, {
    ...scope,
    minHeadcount: MIN_AGGREGATE_HEADCOUNT,
  });
  const counts = await weeklyResponses.countRespondersAggregate(ctx.db, scope);
  const vibeCounts = await vibes.countVibesAggregate(ctx.db, scope);
  // The same query with the floor dropped, purely to tell "nobody overlaps"
  // apart from "one person overlaps and we will not say so".
  const unfiltered = await overlap.rankWindowAggregate(ctx.db, {
    ...scope,
    minHeadcount: 1,
    limit: 1,
  });

  return {
    weekStartDate: params.weekStartDate,
    windows: rankWindows(aggregates, params.limit ?? TOP_WINDOWS),
    responded: counts.responded,
    total: counts.total,
    topVibes: vibeCounts.slice(0, 3),
    suppressedForPrivacy: aggregates.length === 0 && unfiltered.length > 0,
  };
}
