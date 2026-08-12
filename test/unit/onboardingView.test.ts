/**
 * A stranger's server gets one chance. Before this, a new install did nothing
 * until somebody ran a command they had no way of knowing existed.
 */

import { describe, expect, it } from 'vitest';
import { assertLegalMessage } from '../../src/discord/componentLimits.js';
import { joinBoardView, welcomeView } from '../../src/discord/views/onboarding.view.js';
import { parseCustomId } from '../../src/discord/customId.js';

interface RawButton {
  label?: string;
  custom_id?: string;
  url?: string;
  style?: number;
}

function buttons(view: { components?: readonly unknown[] | undefined }): RawButton[] {
  return (view.components ?? []).flatMap(
    (row) => (row as { toJSON(): { components: RawButton[] } }).toJSON().components,
  );
}

function text(view: { embeds?: readonly unknown[] | undefined }): string {
  return JSON.stringify(
    (view.embeds ?? []).map((embed) => (embed as { toJSON(): unknown }).toJSON()),
  );
}

const SITE = 'https://connectioneering.design/skeddy-goblin';

describe('welcomeView', () => {
  it('is legal and needs no setup command to act on', () => {
    const view = welcomeView({ groupId: 7, timezone: 'Europe/London', websiteUrl: SITE });
    assertLegalMessage(view, 'welcome');

    const labels = buttons(view).map((button) => button.label);
    expect(labels).toEqual(['Count me in', 'Start this week', 'How it works']);
  });

  it('says the defaults out loud, so nobody has to configure anything first', () => {
    const view = welcomeView({ groupId: 7, timezone: 'Europe/London', websiteUrl: SITE });
    const rendered = text(view);

    expect(rendered).toContain('Europe/London');
    expect(rendered).toContain('/setup');
    // The privacy promise belongs in the first thing a server ever reads.
    expect(rendered).toMatch(/Nobody ever sees anyone else/i);
  });

  it('links out rather than burning a button on a custom id', () => {
    const link = buttons(welcomeView({ groupId: 7, timezone: 'UTC', websiteUrl: SITE })).at(-1)!;
    expect(link.url).toBe(SITE);
    expect(link.custom_id).toBeUndefined();
  });
});

describe('joinBoardView', () => {
  it('offers joining and leaving, both parseable', () => {
    const view = joinBoardView({ groupId: 7, memberCount: 3 });
    assertLegalMessage(view, 'joinBoard');

    const [join, leave] = buttons(view);
    expect(parseCustomId(join!.custom_id!).action).toBe('go');
    expect(parseCustomId(leave!.custom_id!).action).toBe('out');
  });

  it('shows a live count so the button visibly does something', () => {
    expect(text(joinBoardView({ groupId: 7, memberCount: 0 }))).toContain('Nobody yet');
    expect(text(joinBoardView({ groupId: 7, memberCount: 1 }))).toContain('1 person in');
    expect(text(joinBoardView({ groupId: 7, memberCount: 4 }))).toContain('4 people in');
  });
});
