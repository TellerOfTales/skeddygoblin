/**
 * The status roster: who has answered, who has not.
 *
 * The one place names appear, and the brief explicitly allows it. What it must
 * NOT do is say which way someone answered - "Dana opted out" is a preference
 * disclosure, so the entry carries a boolean and the status column is never
 * selected by a group-scoped query.
 */

import { localDate, type IsoDate } from '../domain/week.js';
import * as buzzLog from '../db/repositories/buzzLog.js';
import * as weeklyResponses from '../db/repositories/weeklyResponses.js';
import * as drafts from '../db/repositories/drafts.js';
import type { GroupId, GroupRecord } from '../db/repositories/types.js';
import type { AppContext } from './context.js';

/**
 * How far someone has got. Progress, deliberately - never content.
 *
 * 'started' says a person has picked at least one window without finishing.
 * That is safe to show: it reveals that they engaged, not when they are free.
 * It also earns its place, because a started-but-unfinished member is the one
 * most worth nudging - they are two taps from done.
 */
export type RosterProgress = 'none' | 'started' | 'answered';

export interface RosterRow {
  userId: number;
  discordId: string;
  hasResponded: boolean;
  progress: RosterProgress;
  /** Already nudged today, so the button would be refused anyway. */
  buzzedToday: boolean;
}

export interface Roster {
  weekStartDate: IsoDate;
  rows: RosterRow[];
  responded: number;
  /** Picked something, did not finish. Still buzzable, and worth buzzing. */
  started: number;
  total: number;
}

export async function buildRoster(
  ctx: AppContext,
  params: { group: GroupRecord; weekStartDate: IsoDate },
): Promise<Roster> {
  const scope: { groupId: GroupId; weekStartDate: IsoDate } = {
    groupId: params.group.id,
    weekStartDate: params.weekStartDate,
  };

  const entries = await weeklyResponses.listRosterEntries(ctx.db, scope);
  const buzzDate = localDate(ctx.clock.now(), params.group.timezone);
  const started = new Set(await drafts.listUserIdsWithProgress(ctx.db, scope));

  const rows: RosterRow[] = [];
  for (const entry of entries) {
    rows.push({
      userId: entry.userId,
      discordId: entry.discordId,
      hasResponded: entry.hasResponded,
      progress: entry.hasResponded ? 'answered' : started.has(entry.userId) ? 'started' : 'none',
      buzzedToday: entry.hasResponded
        ? false
        : await buzzLog.wasBuzzedOn(ctx.db, { targetUserId: entry.userId, buzzDate }),
    });
  }

  return {
    weekStartDate: params.weekStartDate,
    rows,
    responded: rows.filter((row) => row.hasResponded).length,
    started: rows.filter((row) => row.progress === 'started').length,
    total: rows.length,
  };
}
