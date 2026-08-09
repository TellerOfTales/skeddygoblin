/**
 * Channel-neutral action references.
 *
 * An outbound notification can offer the recipient things to do. Those actions
 * must be describable without knowing how they will be rendered: as Discord
 * buttons today, and as "reply 1 / reply 2" over SMS tomorrow.
 *
 * So a notification carries an ActionRef - what the action MEANS - and each
 * notifier translates it into its own transport. DiscordDMNotifier maps an
 * ActionRef to a custom_id; a future TwilioSMSNotifier would map the same
 * ActionRef to a numbered reply.
 *
 * This is the reason services and domain never touch custom_id encoding, and
 * the reason adding a second channel is additive rather than a refactor. If a
 * payload carried discord.js builders instead, the abstraction would be a lie.
 */

export type ActionRef =
  /** Begin (or resume) the weekly questionnaire for a group. */
  | { kind: 'start_weekly_flow'; groupId: number }
  /** The escape hatch: end the week in one tap, no follow-up. */
  | { kind: 'opt_out_week'; groupId: number }
  /** RSVP to a proposed session. */
  | { kind: 'session_rsvp'; proposalId: number; response: 'yes' | 'maybe' | 'no' }
  /** Join a group from a public post. */
  | { kind: 'join_group'; groupId: number };

export type ActionKind = ActionRef['kind'];

/**
 * Only two styles exist, deliberately. There is no 'danger' variant, so no
 * escape-hatch button can ever be rendered red - "no guilt copy" is enforced by
 * the type rather than by remembering it at each call site.
 */
export type ActionStyle = 'primary' | 'secondary';

export interface NotifyAction {
  label: string;
  style: ActionStyle;
  action: ActionRef;
}
