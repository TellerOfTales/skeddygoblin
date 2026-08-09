/**
 * Fixture builders for integration tests.
 *
 * Users get sentinel-friendly discord ids so the privacy sweep (P1) can assert
 * that one member's identifiers never appear in another member's view.
 */

import { randomUUID } from 'node:crypto';
import * as groups from '../../src/db/repositories/groups.js';
import * as memberships from '../../src/db/repositories/memberships.js';
import * as users from '../../src/db/repositories/users.js';
import type { GroupRecord, MembershipRole, UserRecord } from '../../src/db/repositories/types.js';
import type { AppContext } from '../../src/services/context.js';

export async function makeGroup(
  ctx: AppContext,
  overrides: { guildId?: string; name?: string; timezone?: string } = {},
): Promise<GroupRecord> {
  return groups.ensureGroup(ctx.db, overrides.guildId ?? `guild-${randomUUID()}`, {
    name: overrides.name ?? 'Test Group',
    timezone: overrides.timezone ?? 'UTC',
    announceChannelId: '100000000000000001',
  });
}

export async function makeUser(
  ctx: AppContext,
  overrides: { discordId?: string; timezone?: string } = {},
): Promise<UserRecord> {
  return users.ensureUser(ctx.db, overrides.discordId ?? `user-${randomUUID()}`, {
    timezone: overrides.timezone ?? 'UTC',
  });
}

export async function makeMember(
  ctx: AppContext,
  group: GroupRecord,
  overrides: { discordId?: string; role?: MembershipRole } = {},
): Promise<UserRecord> {
  const user = await makeUser(ctx, overrides.discordId ? { discordId: overrides.discordId } : {});
  await memberships.ensureMembership(ctx.db, user.id, group.id, overrides.role ?? 'member');
  return user;
}

/** A group with `count` members, returned in creation order. */
export async function makeGroupWithMembers(
  ctx: AppContext,
  count: number,
  overrides: { timezone?: string } = {},
): Promise<{ group: GroupRecord; members: UserRecord[] }> {
  const group = await makeGroup(ctx, overrides.timezone ? { timezone: overrides.timezone } : {});
  const members: UserRecord[] = [];
  for (let index = 0; index < count; index++) {
    members.push(await makeMember(ctx, group));
  }
  return { group, members };
}

export function notifiable(user: UserRecord) {
  return {
    id: user.id,
    discordId: user.discordId,
    preferredChannel: user.preferredChannel,
    phoneE164: user.phoneE164,
  };
}
