/**
 * The public board. Everything on it is an aggregate - headcounts, vibe counts,
 * owner counts, an unlinked count - which is exactly what makes it safe to post
 * where the whole group can read it.
 */

import { describe, expect, it } from 'vitest';
import { assertLegalMessage } from '../../src/discord/componentLimits.js';
import { leaderboardView } from '../../src/discord/views/leaderboard.view.js';

const BASE = {
  groupId: 7,
  groupName: 'The Basement',
  weekStartDate: '2026-08-10' as const,
  windows: [{ dayOfWeek: 2 as const, window: 'evening' as const, headcount: 3, score: 3.25 }],
  responded: 4,
  total: 4,
  topVibes: [{ tag: 'Co-op' as const, count: 3 }],
  suppressedForPrivacy: false,
  showLockIn: false,
};

function text(view: { embeds?: readonly unknown[] | undefined }): string {
  return JSON.stringify(
    (view.embeds ?? []).map((embed) => (embed as { toJSON(): unknown }).toJSON()),
  );
}

describe('leaderboardView', () => {
  it('stays legal with games, a steam nudge and lock-in buttons', () => {
    assertLegalMessage(
      leaderboardView({
        ...BASE,
        showLockIn: true,
        games: [
          { name: 'Valheim', ownerCount: 3, price: '£16.19 ($20.99)' },
          { name: 'Stardew Valley', ownerCount: 2, price: 'Free' },
        ],
        steam: { unlinked: 2, total: 5 },
        reason: 'everyone-answered',
      }),
      'leaderboard',
    );
  });

  it('names the section for the mood that picked the games', () => {
    const view = leaderboardView({
      ...BASE,
      topVibes: [
        { tag: 'Co-op', count: 3 },
        { tag: 'Survival', count: 2 },
      ],
      games: [
        {
          name: 'Valheim',
          ownerCount: 3,
          price: '£16.19',
          matchedVibes: ['Co-op', 'Survival'],
        },
      ],
    });
    const rendered = text(view);

    // Suggestions are shared games filtered by the week's vibes, and the board
    // says so - a ranked list nobody can check is one you take on trust.
    expect(rendered).toContain('Games that fit co-op, survival');
    expect(rendered).toContain('matches Co-op, Survival');
  });

  it('shows games by owner count and price, never by owner', () => {
    const view = leaderboardView({
      ...BASE,
      games: [{ name: 'Valheim', ownerCount: 3, price: '£16.19' }],
    });
    expect(text(view)).toContain('3 of you own it');
    expect(text(view)).toContain('£16.19');
  });

  it('nudges about Steam with a count, never a name', () => {
    const view = leaderboardView({ ...BASE, steam: { unlinked: 2, total: 5 } });
    const rendered = text(view);

    expect(rendered).toContain('2 of 5');
    expect(rendered).toContain('/link-steam');
    // The reassurance is the point of the nudge: linking shows counts, not you.
    expect(rendered).toContain('never who');
  });

  it('says nothing about Steam once everyone has linked', () => {
    const view = leaderboardView({ ...BASE, steam: { unlinked: 0, total: 5 } });
    expect(text(view)).not.toContain('link-steam');
  });

  it('reads as final when it posted because everyone answered', () => {
    const view = leaderboardView({ ...BASE, reason: 'everyone-answered' });
    expect(text(view)).toContain("That's everyone in");
  });
});
