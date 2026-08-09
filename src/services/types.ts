/**
 * The service layer's public vocabulary.
 *
 * The Discord layer is barred from importing src/db/** so that a view can never
 * hold a raw per-user record. It still needs to *name* the shapes services hand
 * it, though, so those types are re-exported here.
 *
 * This is not laundering the boundary: the rule exists to stop the adapter
 * reaching the database, and these are exactly the records the service layer
 * has already decided to expose. Anything not re-exported here is not the
 * adapter's business - notably DraftState internals, raw slot rows, and
 * anything self-scoped.
 */

export type {
  DraftRecord,
  GroupId,
  GroupRecord,
  MembershipRole,
  RosterEntry,
  UserId,
  UserRecord,
  WeeklyResponseRecord,
} from '../db/repositories/types.js';
