/**
 * Sending the weekly questionnaire to a person.
 *
 * Lives in the service layer, above the notifier, so the same call works from a
 * slash command, from the scheduler, and from a buzz - and so the rules about
 * who may be prompted are stated once.
 */

import * as users from '../db/repositories/users.js';
import type { GroupRecord, UserRecord } from '../db/repositories/types.js';
import type { IsoDate } from '../domain/week.js';
import type { NotifyResult } from '../notify/Notifier.js';
import * as templates from '../notify/templates.js';
import type { AppContext } from './context.js';

function toNotifiable(user: UserRecord) {
  return {
    id: user.id,
    discordId: user.discordId,
    preferredChannel: user.preferredChannel,
    phoneE164: user.phoneE164,
  };
}

/** DMs a member the two-button quick-out prompt. */
export async function sendWeeklyPrompt(
  ctx: AppContext,
  params: { user: UserRecord; group: GroupRecord; weekStartDate: IsoDate },
): Promise<NotifyResult> {
  return ctx.notifier.notify(
    toNotifiable(params.user),
    'weekly_prompt',
    templates.weeklyPrompt({
      groupId: params.group.id,
      groupName: params.group.name,
      weekStartDate: params.weekStartDate,
      timezone: params.group.timezone,
    }),
  );
}

export async function sendWeeklyPromptToUserId(
  ctx: AppContext,
  params: { userId: number; group: GroupRecord; weekStartDate: IsoDate },
): Promise<NotifyResult> {
  const user = await users.findUserById(ctx.db, params.userId);
  if (!user) return { ok: false, reason: 'unknown', detail: 'user not found' };
  return sendWeeklyPrompt(ctx, { user, group: params.group, weekStartDate: params.weekStartDate });
}
