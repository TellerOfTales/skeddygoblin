/**
 * Message copy, in one place.
 *
 * Every template returns a channel-agnostic NotifyPayload. Keeping copy here
 * rather than inline at call sites means the tone stays consistent and the
 * "no guilt copy" rule is auditable in a single file.
 */

import type { NotifyPayload } from './Notifier.js';
import { formatWeekLabel, type IsoDate } from '../domain/week.js';
import { DAY_LABELS, WINDOW_LABELS, type Day, type Window } from '../domain/constants.js';

export function weeklyPrompt(params: {
  groupId: number;
  groupName: string;
  weekStartDate: IsoDate;
  timezone: string;
}): NotifyPayload {
  return {
    title: `What does your week look like? — ${params.groupName}`,
    body: [
      `Week of **${formatWeekLabel(params.weekStartDate)}** · times are ${params.groupName} local (${params.timezone})`,
      '',
      'Takes under two minutes. If this week is a write-off, one tap and you are done.',
    ].join('\n'),
    actions: [
      {
        label: "I'm in, let's go",
        style: 'primary',
        action: { kind: 'start_weekly_flow', groupId: params.groupId },
      },
      {
        // No follow-up questions, no guilt, and not styled red.
        label: "Can't this week",
        style: 'secondary',
        action: { kind: 'opt_out_week', groupId: params.groupId },
      },
    ],
  };
}

export function buzz(params: {
  groupId: number;
  groupName: string;
  weekStartDate: IsoDate;
}): NotifyPayload {
  return {
    title: `Nudge from ${params.groupName}`,
    // Deliberately does not name who buzzed. The roster is public, but turning
    // a nudge into "Alex is waiting on you" adds the social pressure the
    // escape-hatch principle is trying to avoid.
    body: [
      `Someone in **${params.groupName}** is waiting on your answer for the week of ` +
        `**${formatWeekLabel(params.weekStartDate)}**.`,
      '',
      'Two minutes, or one tap to sit this one out.',
    ].join('\n'),
    actions: [
      {
        label: "I'm in, let's go",
        style: 'primary',
        action: { kind: 'start_weekly_flow', groupId: params.groupId },
      },
      {
        label: "Can't this week",
        style: 'secondary',
        action: { kind: 'opt_out_week', groupId: params.groupId },
      },
    ],
  };
}

export function sessionProposed(params: {
  proposalId: number;
  groupName: string;
  day: Day;
  window: Window;
}): NotifyPayload {
  return {
    title: `Possible session — ${params.groupName}`,
    body: `**${DAY_LABELS[params.day]} ${WINDOW_LABELS[params.window].toLowerCase()}** is looking good. Can you make it?`,
    actions: [
      {
        label: 'Yes',
        style: 'primary',
        action: { kind: 'session_rsvp', proposalId: params.proposalId, response: 'yes' },
      },
      {
        label: 'Maybe',
        style: 'secondary',
        action: { kind: 'session_rsvp', proposalId: params.proposalId, response: 'maybe' },
      },
      {
        label: 'No',
        style: 'secondary',
        action: { kind: 'session_rsvp', proposalId: params.proposalId, response: 'no' },
      },
    ],
  };
}

export function sessionConfirmed(params: {
  groupName: string;
  day: Day;
  window: Window;
  headcount: number;
}): NotifyPayload {
  return {
    title: `It's on — ${params.groupName}`,
    body: [
      `**${DAY_LABELS[params.day]} ${WINDOW_LABELS[params.window].toLowerCase()}** is confirmed.`,
      `${params.headcount} ${params.headcount === 1 ? 'person is' : 'people are'} in.`,
    ].join('\n'),
  };
}
