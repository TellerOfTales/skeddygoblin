/**
 * Resolving a Discord identity into our own records.
 *
 * Every entrypoint starts here, so there is never a "user not found" branch
 * inside a flow.
 */

import { config } from '../config.js';
import { DomainError } from '../domain/errors.js';
import * as groups from '../db/repositories/groups.js';
import * as memberships from '../db/repositories/memberships.js';
import * as users from '../db/repositories/users.js';
import type { GroupRecord, MembershipRole, UserRecord } from '../db/repositories/types.js';
import type { AppContext } from './context.js';

export interface Actor {
  user: UserRecord;
  group: GroupRecord;
  role: MembershipRole;
}

/**
 * Resolves the acting user and their group, creating all three records if this
 * is their first interaction.
 *
 * `joinIfAbsent` is the difference between a command that implies consent to
 * take part (running /availability) and one that does not (pressing Buzz on
 * someone else's roster row).
 */
export async function resolveActor(
  ctx: AppContext,
  params: {
    discordUserId: string;
    discordGuildId: string;
    guildName: string;
    announceChannelId?: string | undefined;
    joinIfAbsent?: boolean;
  },
): Promise<Actor> {
  return ctx.db.withTransaction(async (tx) => {
    const user = await users.ensureUser(tx, params.discordUserId, {
      timezone: config.defaultGroupTimezone,
    });
    const group = await groups.ensureGroup(tx, params.discordGuildId, {
      name: params.guildName,
      timezone: config.defaultGroupTimezone,
      announceChannelId: params.announceChannelId,
    });

    let membership = await memberships.findMembership(tx, user.id, group.id);
    if (!membership) {
      if (params.joinIfAbsent === false) {
        throw new DomainError('ACTOR_NOT_MEMBER');
      }
      membership = await memberships.ensureMembership(tx, user.id, group.id);
    }

    return { user, group, role: membership.role };
  });
}

/** Resolves a user + group already known to exist, e.g. from a DM custom_id. */
export async function resolveMemberByDiscordId(
  ctx: AppContext,
  params: { discordUserId: string; groupId: number },
): Promise<Actor> {
  const user = await users.findUserByDiscordId(ctx.db, params.discordUserId);
  if (!user) throw new DomainError('USER_NOT_FOUND');

  const group = await groups.findGroupById(ctx.db, params.groupId);
  if (!group) throw new DomainError('GROUP_NOT_FOUND');

  const membership = await memberships.findMembership(ctx.db, user.id, group.id);
  if (!membership) throw new DomainError('ACTOR_NOT_MEMBER');

  return { user, group, role: membership.role };
}

export async function requireOrganizer(actor: Actor): Promise<void> {
  if (actor.role !== 'organizer') throw new DomainError('NOT_ORGANIZER');
}

/**
 * Enrols a whole server's worth of people at once.
 *
 * The bot cannot know who is in a Discord server without being told - it holds
 * no member list of its own - so the caller passes the snowflakes it fetched
 * and this turns them into users and memberships. Idempotent: ensureUser and
 * ensureMembership both upsert, so re-running it every week costs nothing and
 * picks up anyone who joined since.
 *
 * Returns how many were newly enrolled, which is only useful for logging.
 */
export async function enrolDiscordMembers(
  ctx: AppContext,
  groupId: number,
  discordUserIds: readonly string[],
): Promise<number> {
  let enrolled = 0;

  for (const discordUserId of discordUserIds) {
    await ctx.db.withTransaction(async (tx) => {
      const user = await users.ensureUser(tx, discordUserId, {
        timezone: config.defaultGroupTimezone,
      });
      const existing = await memberships.findMembership(tx, user.id, groupId);
      if (!existing) {
        await memberships.ensureMembership(tx, user.id, groupId);
        enrolled++;
      }
    });
  }

  return enrolled;
}

export async function joinGroup(ctx: AppContext, userId: number, groupId: number): Promise<void> {
  await memberships.ensureMembership(ctx.db, userId, groupId);
}

/**
 * Seeds the first member of a group as its organizer, so a brand-new install
 * is not stuck with nobody able to run /setup.
 */
export async function promoteFirstMemberToOrganizer(
  ctx: AppContext,
  groupId: number,
  userId: number,
): Promise<void> {
  const count = await memberships.countMembers(ctx.db, groupId);
  if (count === 1) {
    await memberships.setRole(ctx.db, userId, groupId, 'organizer');
  }
}

export interface MyGroup {
  id: number;
  name: string;
}

/**
 * The servers this member belongs to, for the DM server picker.
 *
 * Self-scoped by construction: the only membership question that can be asked
 * in this direction is "which groups am I in", never "who is in this group with
 * their preferences".
 *
 * Returns null when the Discord account is unknown to us - someone who has
 * DM'd the bot without ever having used it in a server. That is a different
 * message from "you are in no groups", and conflating them would tell a
 * stranger they had been removed from something.
 */
export async function listMyGroups(
  ctx: AppContext,
  discordUserId: string,
): Promise<{ userId: number; groups: MyGroup[] } | null> {
  const user = await users.findUserByDiscordId(ctx.db, discordUserId);
  if (!user) return null;

  const groupIds = await memberships.listGroupIdsForSelf(ctx.db, user.id);
  const found: MyGroup[] = [];

  for (const groupId of groupIds) {
    const group = await groups.findGroupById(ctx.db, groupId);
    if (group) found.push({ id: group.id, name: group.name });
  }

  return { userId: user.id, groups: found };
}

/**
 * Resolves a member for a group we already know exists, creating the user row
 * if this is their first interaction but NOT joining them to the group.
 *
 * The distinction matters for the Join button: tapping it is what joins you,
 * so resolving must not do it as a side effect - otherwise the button would be
 * decorative and "take me off" could never stick.
 */
export async function resolveActorInGroup(
  ctx: AppContext,
  params: { discordUserId: string; groupId: number },
): Promise<{ user: UserRecord; group: GroupRecord }> {
  const group = await groups.findGroupById(ctx.db, params.groupId);
  if (!group) throw new DomainError('GROUP_NOT_FOUND');

  const user = await users.ensureUser(ctx.db, params.discordUserId, {
    timezone: config.defaultGroupTimezone,
  });
  return { user, group };
}

/** Opting back out. Their answers stay; they simply stop being asked. */
export async function leaveGroup(ctx: AppContext, userId: number, groupId: number): Promise<void> {
  await memberships.removeMembership(ctx.db, userId, groupId);
}

/** Creates or finds the group for a guild, with onboarding defaults applied. */
export async function ensureGroupForGuild(
  ctx: AppContext,
  params: {
    discordGuildId: string;
    name: string;
    timezone: string;
    announceChannelId?: string;
  },
): Promise<GroupRecord> {
  return groups.ensureGroup(ctx.db, params.discordGuildId, {
    name: params.name,
    timezone: params.timezone,
    ...(params.announceChannelId ? { announceChannelId: params.announceChannelId } : {}),
  });
}
