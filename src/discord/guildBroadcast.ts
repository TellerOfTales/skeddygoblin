/**
 * "One person asks, everybody gets asked."
 *
 * The bot holds no member list of its own, so this is the seam where Discord's
 * view of who is in a server becomes group_membership rows the services can
 * work with. It lives in the discord layer precisely so the services never
 * import discord.js: they receive snowflakes, not guild objects.
 *
 * Exactly-once-per-week comes free from runWeeklyPrompt, which claims
 * job_run (group_id, 'weekly_prompt', week_start_date) - a primary key, so the
 * database refuses a second claim regardless of how many people run
 * /availability or whether the scheduler got there first.
 */

import type { Guild } from 'discord.js';
import { enrolDiscordMembers } from '../services/membershipService.js';
import { runWeeklyPrompt } from '../services/weeklyCycleService.js';
import type { AppContext } from '../services/context.js';
import type { GroupRecord } from '../services/types.js';

/**
 * Enrols everyone in the guild, then DMs this week's prompt to whoever has not
 * answered yet.
 *
 * Never throws. Callers fire this and forget: it runs after the interaction has
 * already been answered, and DMing twenty people sequentially takes far longer
 * than the fifteen minutes an interaction token lives. A failure here must not
 * turn one person's successful /availability into a visible error.
 */
export async function broadcastWeeklyPrompt(
  ctx: AppContext,
  params: { guild: Guild; group: GroupRecord; week: string; excludeUserId?: number },
): Promise<void> {
  try {
    // Requires the GuildMembers privileged intent; see discord/client.ts for
    // why that trade was made. Without it this resolves to the bot alone and
    // the broadcast quietly reaches nobody, so the count is logged.
    const members = await params.guild.members.fetch();
    const humanIds = members.filter((member) => !member.user.bot).map((member) => member.id);

    const enrolled = await enrolDiscordMembers(ctx, params.group.id, humanIds);
    if (enrolled > 0) {
      ctx.logger.info('enrolled new members from the guild', {
        groupId: params.group.id,
        enrolled,
        seen: humanIds.length,
      });
    }

    const outcome = await runWeeklyPrompt(ctx, params.group, params.week, {
      ...(params.excludeUserId !== undefined ? { excludeUserId: params.excludeUserId } : {}),
    });

    if (outcome.ran) {
      ctx.logger.info('weekly prompt broadcast', {
        groupId: params.group.id,
        week: params.week,
        prompted: outcome.prompted,
        undeliverable: outcome.undeliverable,
      });
    } else {
      ctx.logger.debug('weekly prompt already went out this week', {
        groupId: params.group.id,
        week: params.week,
      });
    }
  } catch (error) {
    ctx.logger.error('weekly prompt broadcast failed', { groupId: params.group.id, error });
  }
}
