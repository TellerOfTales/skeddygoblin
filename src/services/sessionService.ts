/**
 * The thin proposal loop: lock in a window, collect RSVPs, confirm.
 *
 * Deliberately included in Stage 1 even though the build order stops at the
 * roster. The overlap score's remaining-capacity term counts a member's
 * confirmed sessions, so shipping without any way to confirm one would leave
 * that term permanently zero - and a formula whose central variable is never
 * exercised is a formula nobody has actually tested.
 */

import { DomainError } from '../domain/errors.js';
import type { Day, Window } from '../domain/constants.js';
import type { IsoDate } from '../domain/week.js';
import * as sessions from '../db/repositories/sessions.js';
import * as users from '../db/repositories/users.js';
import type { AttendanceResponse, ProposalRecord } from '../db/repositories/sessions.js';
import type { GroupId, GroupRecord, UserId } from '../db/repositories/types.js';
import * as templates from '../notify/templates.js';
import type { AppContext } from './context.js';

export async function proposeSession(
  ctx: AppContext,
  params: {
    groupId: GroupId;
    weekStartDate: IsoDate;
    day: Day;
    window: Window;
    createdBy: UserId;
  },
): Promise<ProposalRecord> {
  // The unique constraint on (group, week, day, window) means two organizers
  // tapping the same button produce one session, not two.
  return sessions.createProposal(ctx.db, {
    groupId: params.groupId,
    weekStartDate: params.weekStartDate,
    candidateDay: params.day,
    candidateWindow: params.window,
    createdBy: params.createdBy,
  });
}

export async function rsvp(
  ctx: AppContext,
  params: { proposalId: number; userId: UserId; response: AttendanceResponse },
): Promise<{ counts: Record<AttendanceResponse, number>; proposal: ProposalRecord }> {
  const proposal = await sessions.findProposalById(ctx.db, params.proposalId);
  if (!proposal) throw new DomainError('PROPOSAL_NOT_FOUND');
  if (proposal.status === 'confirmed' || proposal.status === 'cancelled') {
    throw new DomainError('PROPOSAL_CLOSED');
  }

  await sessions.setAttendance(ctx.db, params.proposalId, params.userId, params.response);

  return {
    proposal,
    counts: await sessions.countAttendanceAggregate(ctx.db, params.proposalId),
  };
}

/**
 * Confirms a session and tells everyone who said yes.
 *
 * The notification goes through notify(), like every other outbound message, so
 * it will reach an SMS user unchanged once that notifier exists.
 */
export async function confirmSession(
  ctx: AppContext,
  params: { proposalId: number; group: GroupRecord },
): Promise<{ proposal: ProposalRecord; notified: number }> {
  const proposal = await sessions.findProposalById(ctx.db, params.proposalId);
  if (!proposal) throw new DomainError('PROPOSAL_NOT_FOUND');
  if (proposal.status === 'cancelled') throw new DomainError('PROPOSAL_CLOSED');

  const confirmed = await sessions.setProposalStatus(ctx.db, params.proposalId, 'confirmed');
  const yesIds = await sessions.listYesUserIds(ctx.db, params.proposalId);
  const attendees = await users.listUsersByIds(ctx.db, yesIds);

  const payload = templates.sessionConfirmed({
    groupName: params.group.name,
    day: confirmed.candidateDay,
    window: confirmed.candidateWindow,
    headcount: yesIds.length,
  });

  let notified = 0;
  for (const attendee of attendees) {
    const result = await ctx.notifier.notify(
      {
        id: attendee.id,
        discordId: attendee.discordId,
        preferredChannel: attendee.preferredChannel,
        phoneE164: attendee.phoneE164,
      },
      'session_confirmed',
      payload,
    );
    if (result.ok) notified++;
  }

  return { proposal: confirmed, notified };
}

export async function cancelSession(ctx: AppContext, proposalId: number): Promise<ProposalRecord> {
  const proposal = await sessions.findProposalById(ctx.db, proposalId);
  if (!proposal) throw new DomainError('PROPOSAL_NOT_FOUND');
  return sessions.setProposalStatus(ctx.db, proposalId, 'cancelled');
}

export async function attendanceCounts(
  ctx: AppContext,
  proposalId: number,
): Promise<Record<AttendanceResponse, number>> {
  return sessions.countAttendanceAggregate(ctx.db, proposalId);
}

/** Proposals still open for nominations and RSVPs this week. */
export async function listOpenProposals(
  ctx: AppContext,
  params: { groupId: GroupId; weekStartDate: IsoDate },
): Promise<ProposalRecord[]> {
  const all = await sessions.listProposalsForWeek(ctx.db, params);
  return all.filter((proposal) => proposal.status !== 'cancelled');
}

export async function requireProposal(
  ctx: AppContext,
  proposalId: number,
): Promise<ProposalRecord> {
  const proposal = await sessions.findProposalById(ctx.db, proposalId);
  if (!proposal) throw new DomainError('PROPOSAL_NOT_FOUND');
  return proposal;
}

/** Remembers the public RSVP message so its counts can be edited in place. */
export async function attachMessageId(
  ctx: AppContext,
  proposalId: number,
  messageId: string,
): Promise<void> {
  await sessions.setProposalMessageId(ctx.db, proposalId, messageId);
}
