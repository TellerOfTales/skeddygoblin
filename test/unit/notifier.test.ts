import { describe, expect, it } from 'vitest';
import { ButtonStyle } from 'discord.js';
import { actionRefToCustomId, renderPayload } from '../../src/notify/DiscordDMNotifier.js';
import { parseCustomId, toBase36 } from '../../src/discord/customId.js';
import { NotifierRegistry } from '../../src/notify/registry.js';
import { RecordingNotifier } from '../../src/notify/RecordingNotifier.js';
import { silentLogger } from '../helpers/db.js';
import * as templates from '../../src/notify/templates.js';
import type { ActionRef } from '../../src/domain/actions.js';

/**
 * The ActionRef -> custom_id mapping is the seam between the channel-agnostic
 * payload and the Discord transport. If it drifts from what the component
 * handlers decode, buttons silently stop working, so it is pinned here.
 */
describe('actionRefToCustomId', () => {
  const cases: Array<[ActionRef, { namespace: string; action: string; args: string[] }]> = [
    [
      { kind: 'start_weekly_flow', groupId: 42 },
      { namespace: 'av', action: 'in', args: [toBase36(42)] },
    ],
    [
      { kind: 'opt_out_week', groupId: 42 },
      { namespace: 'av', action: 'optout', args: [toBase36(42)] },
    ],
    [
      { kind: 'session_rsvp', proposalId: 7, response: 'maybe' },
      { namespace: 'sess', action: 'rsvp', args: [toBase36(7), 'maybe'] },
    ],
    [
      { kind: 'join_group', groupId: 9 },
      { namespace: 'grp', action: 'join', args: [toBase36(9)] },
    ],
  ];

  it.each(cases)('encodes %j into a routable custom_id', (ref, expected) => {
    const parsed = parseCustomId(actionRefToCustomId(ref));
    expect(parsed).toEqual(expected);
  });

  it('stays inside the 100-character budget for large ids', () => {
    const id = actionRefToCustomId({ kind: 'start_weekly_flow', groupId: 9_007_199_254 });
    expect(id.length).toBeLessThanOrEqual(100);
  });
});

describe('renderPayload', () => {
  it('renders actions as buttons and never as a red one', () => {
    const payload = templates.weeklyPrompt({
      groupId: 1,
      groupName: 'The Basement',
      weekStartDate: '2026-08-10',
      timezone: 'Europe/London',
    });

    const message = renderPayload(payload);
    const row = (
      message.components?.[0] as unknown as {
        toJSON(): { components: Array<Record<string, unknown>> };
      }
    ).toJSON();

    expect(row.components).toHaveLength(2);
    expect(row.components[0]?.style).toBe(ButtonStyle.Success);
    expect(row.components[1]?.style).toBe(ButtonStyle.Secondary);
    // ButtonStyle.Danger is 4. Nothing in the escape hatch may be red.
    expect(row.components.map((c) => c.style)).not.toContain(ButtonStyle.Danger);
  });

  it('omits components entirely when a message has no actions', () => {
    const message = renderPayload(
      templates.sessionConfirmed({
        groupName: 'The Basement',
        day: 2,
        window: 'evening',
        headcount: 4,
      }),
    );
    expect(message.components).toBeUndefined();
    expect(message.content).toContain('confirmed');
  });

  it('validates component legality at render time, not at send time', () => {
    expect(() =>
      renderPayload({
        title: 'Too many',
        body: 'x',
        actions: Array.from({ length: 6 }, (_unused, index) => ({
          label: `Option ${index}`,
          style: 'secondary' as const,
          action: { kind: 'join_group' as const, groupId: index },
        })),
      }),
    ).toThrow(/buttons, max is 5/);
  });

  it('does not name who sent a buzz', () => {
    const payload = templates.buzz({
      groupId: 1,
      groupName: 'The Basement',
      weekStartDate: '2026-08-10',
    });
    expect(payload.body.toLowerCase()).toContain('someone');
  });
});

describe('NotifierRegistry', () => {
  const user = {
    id: 1,
    discordId: '123',
    preferredChannel: 'discord_dm' as const,
    phoneE164: null,
  };
  const payload = { title: 't', body: 'b' };

  it('routes to the implementation serving the user preferred_channel', async () => {
    const recording = new RecordingNotifier();
    const registry = new NotifierRegistry(silentLogger).register(recording);

    const result = await registry.notify(user, 'buzz', payload);

    expect(result).toEqual({ ok: true, channel: 'discord_dm' });
    expect(recording.sent).toHaveLength(1);
  });

  it('fails cleanly when no implementation is registered for the channel', async () => {
    const registry = new NotifierRegistry(silentLogger);

    const result = await registry.notify(user, 'buzz', payload);

    expect(result).toEqual({ ok: false, reason: 'channel_unavailable' });
  });
});
