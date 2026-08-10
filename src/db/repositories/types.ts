/**
 * Row shapes returned by the repository layer.
 *
 * ---------------------------------------------------------------------------
 * THE NAMING RULE THAT ENFORCES PRIVACY
 * ---------------------------------------------------------------------------
 * Every repository export falls into exactly one of two shapes, and the P2 test
 * fails the build if a new one fits neither:
 *
 *   1. Self-scoped reads. Name ends in `ForSelf`. First parameter is named
 *      `selfUserId`. The SQL always carries `user_id = $1` bound to it. These
 *      are the only functions that may return a raw personal record.
 *
 *   2. Aggregate reads. Name starts with `count`/`rank`/`list` or ends in
 *      `Aggregate`. Their return TYPES have no user-identity field alongside a
 *      preference value, by construction.
 *
 * There is deliberately no function that takes a viewer id and a target id and
 * returns raw rows. The leaking call is not expressible, which is what makes
 * this a structural guarantee rather than a convention.
 *
 * `listRosterEntries` is the one deliberate seam: identity WITHOUT preference.
 * The roster needs to say who has not answered, and that is explicitly allowed.
 */

import type { Day, VibeTag, Window } from '../../domain/constants.js';
import type { IsoDate } from '../../domain/week.js';
import type { PreferredChannel } from '../../notify/Notifier.js';

export type UserId = number;
export type GroupId = number;

export interface UserRecord {
  id: UserId;
  discordId: string;
  steamId: string | null;
  steamPublic: boolean;
  timezone: string;
  preferredChannel: PreferredChannel;
  phoneE164: string | null;
}

export interface GroupRecord {
  id: GroupId;
  discordGuildId: string;
  name: string;
  timezone: string;
  /** Steam storefront country. Decides both the price and the currency. */
  countryCode: string;
  announceChannelId: string | null;
  nudgeCutoffDay: Day;
  nudgeCutoffTime: string;
}

export type MembershipRole = 'member' | 'organizer';

export interface MembershipRecord {
  userId: UserId;
  groupId: GroupId;
  role: MembershipRole;
}

export type WeeklyResponseStatus = 'opted_out' | 'submitted';

export interface WeeklyResponseRecord {
  id: number;
  userId: UserId;
  groupId: GroupId;
  weekStartDate: IsoDate;
  status: WeeklyResponseStatus;
  sessionsCommitted: number;
}

export interface SlotRow {
  dayOfWeek: Day;
  window: Window;
}

/** The mutable state of an in-progress questionnaire. */
export interface DraftState {
  days?: Day[];
  /** day index (as a string key, because JSON) -> chosen windows */
  windows?: Record<string, Window[]>;
  capacity?: number;
  vibes?: VibeTag[];
}

export interface DraftRecord {
  id: number;
  userId: UserId;
  groupId: GroupId;
  weekStartDate: IsoDate;
  state: DraftState;
}

/**
 * Roster entry: identity plus a BOOLEAN, never the status value.
 *
 * Distinguishing "opted out" from "submitted" would itself be a preference
 * disclosure, so the status column is never selected in a group-scoped query.
 * See the P3 test.
 */
export interface RosterEntry {
  userId: UserId;
  discordId: string;
  hasResponded: boolean;
}
