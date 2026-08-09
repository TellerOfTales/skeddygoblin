/**
 * Dependency-injection root.
 *
 * Everything below the Discord layer takes its collaborators from this object
 * rather than importing them at module scope. That is what lets services be
 * tested against a transaction-scoped Db and a recording notifier without any
 * module mocking, and what will let a future HTTP API reuse the same services
 * with a different set of collaborators.
 */

import type { Db } from '../db/pool.js';
import type { Logger } from '../logger.js';
import type { Notifier } from '../notify/Notifier.js';

/** Injectable clock so week/cutoff logic is testable without faking timers. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface AppContext {
  db: Db;
  logger: Logger;
  clock: Clock;
  /**
   * The ONLY route to a person. Services call this; they never touch a
   * transport. In tests it is a RecordingNotifier, which is why no service
   * needs module mocking.
   */
  notifier: Notifier;
}

export function buildContext(parts: AppContext): AppContext {
  return parts;
}
