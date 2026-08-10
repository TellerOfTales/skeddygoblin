/**
 * Group configuration. Thin, but it keeps the Discord layer out of the
 * repository layer and gives timezone changes one place to be validated.
 */

import * as groups from '../db/repositories/groups.js';
import { DomainError } from '../domain/errors.js';
import { isValidTimezone } from '../domain/week.js';
import type { Day } from '../domain/constants.js';
import type { GroupId, GroupRecord } from '../db/repositories/types.js';
import type { AppContext } from './context.js';

export async function updateGroupSettings(
  ctx: AppContext,
  groupId: GroupId,
  settings: {
    timezone?: string;
    countryCode?: string;
    announceChannelId?: string | null;
    nudgeCutoffDay?: Day;
    nudgeCutoffTime?: string;
  },
): Promise<GroupRecord> {
  if (settings.timezone !== undefined && !isValidTimezone(settings.timezone)) {
    throw new DomainError('INVALID_INPUT', `Unknown timezone: ${settings.timezone}`);
  }
  if (settings.countryCode !== undefined && !/^[A-Z]{2}$/.test(settings.countryCode)) {
    throw new DomainError(
      'INVALID_INPUT',
      `Country must be a two-letter code like GB or US, got: ${settings.countryCode}`,
    );
  }
  return groups.updateGroupSettings(ctx.db, groupId, settings);
}

export async function requireConfiguredGroup(
  ctx: AppContext,
  groupId: GroupId,
): Promise<GroupRecord> {
  const group = await groups.findGroupById(ctx.db, groupId);
  if (!group) throw new DomainError('GROUP_NOT_FOUND');
  if (!group.announceChannelId) throw new DomainError('GROUP_NOT_CONFIGURED');
  return group;
}
