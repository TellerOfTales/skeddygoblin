import { describe, expect, it, vi } from 'vitest';
import { buildAuthUrl, verifyCallback } from '../../src/steam/openid.js';
import {
  fetchAppMeta,
  fetchOwnedGames,
  SteamProfilePrivateError,
} from '../../src/steam/clients.js';
import { isMultiplayer, matchesVibe, vibeScore } from '../../src/domain/gameMatching.js';
import { renderSms, resolveSmsReply } from '../../src/notify/TwilioSMSNotifier.js';
import * as templates from '../../src/notify/templates.js';

/**
 * Steam auth is OpenID 2.0, not OAuth. There is no client secret and no token
 * exchange - the security of the whole flow rests on re-posting the assertion
 * back to Steam for authentication.
 */
describe('Steam OpenID 2.0', () => {
  it('builds a checkid_setup URL with identifier_select', () => {
    const url = new URL(
      buildAuthUrl({
        returnTo: 'https://bot.example/steam/callback',
        realm: 'https://bot.example',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://steamcommunity.com/openid/login');
    expect(url.searchParams.get('openid.mode')).toBe('checkid_setup');
    expect(url.searchParams.get('openid.identity')).toBe(
      'http://specs.openid.net/auth/2.0/identifier_select',
    );
    expect(url.searchParams.get('openid.return_to')).toBe('https://bot.example/steam/callback');
  });

  function assertion(overrides: Record<string, string> = {}): URLSearchParams {
    return new URLSearchParams({
      'openid.mode': 'id_res',
      'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000001',
      'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000001',
      'openid.sig': 'abc',
      'openid.signed': 'mode,identity,claimed_id',
      ...overrides,
    });
  }

  it('accepts an assertion Steam confirms, and extracts the SteamID', async () => {
    const fetchImpl = vi.fn(async () => new Response('ns:...\nis_valid:true\n'));

    const result = await verifyCallback(assertion(), fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ ok: true, steamId: '76561198000000001' });

    // The bundle must go back verbatim apart from the mode, or the signature
    // Steam is checking will not match.
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const posted = new URLSearchParams(init.body as string);
    expect(posted.get('openid.mode')).toBe('check_authentication');
    expect(posted.get('openid.sig')).toBe('abc');
    expect(posted.get('openid.signed')).toBe('mode,identity,claimed_id');
  });

  /** The whole reason step 3 exists: the callback arrives via the user's browser. */
  it('rejects a forged assertion Steam does not confirm', async () => {
    const fetchImpl = vi.fn(async () => new Response('ns:...\nis_valid:false\n'));

    const result = await verifyCallback(
      assertion({ 'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000999' }),
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.ok).toBe(false);
    expect(result.steamId).toBeUndefined();
  });

  it('rejects a claimed_id that is not a Steam identity', async () => {
    const fetchImpl = vi.fn(async () => new Response('is_valid:true'));

    const result = await verifyCallback(
      assertion({ 'openid.claimed_id': 'https://evil.example/openid/id/76561198000000001' }),
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.ok).toBe(false);
    // Never even asks Steam about an identity that is not Steam's.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a cancelled sign-in', async () => {
    const result = await verifyCallback(
      new URLSearchParams({ 'openid.mode': 'cancel' }),
      (async () => new Response('')) as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
  });

  it('fails closed when Steam is unreachable', async () => {
    const result = await verifyCallback(assertion(), (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    expect(result.ok).toBe(false);
  });
});

describe('GetOwnedGames', () => {
  const ok = (body: unknown) =>
    (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

  it('maps owned games', async () => {
    const games = await fetchOwnedGames(
      { apiKey: 'k', steamId: '1' },
      ok({
        response: {
          game_count: 2,
          games: [
            { appid: 570, name: 'Dota 2' },
            { appid: 730, name: 'CS2' },
          ],
        },
      }),
    );

    expect(games).toEqual([
      { appId: 570, gameName: 'Dota 2', multiplayer: false },
      { appId: 730, gameName: 'CS2', multiplayer: false },
    ]);
  });

  /**
   * A private profile returns HTTP 200 with an empty response object rather
   * than an error, so it has to be told apart from a genuinely empty library.
   */
  it('distinguishes a private profile from an empty library', async () => {
    await expect(
      fetchOwnedGames({ apiKey: 'k', steamId: '1' }, ok({ response: {} })),
    ).rejects.toThrow(SteamProfilePrivateError);

    await expect(
      fetchOwnedGames({ apiKey: 'k', steamId: '1' }, ok({ response: { game_count: 0 } })),
    ).resolves.toEqual([]);
  });
});

describe('appdetails', () => {
  const respond = (body: unknown) =>
    (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

  it('derives multiplayer, price and store link', async () => {
    const meta = await fetchAppMeta(
      730,
      {},
      respond({
        '730': {
          success: true,
          data: {
            name: 'Counter-Strike 2',
            categories: [{ description: 'Online PvP' }, { description: 'Steam Achievements' }],
            genres: [{ description: 'Action' }, { description: 'Free To Play' }],
            is_free: true,
          },
        },
      }),
    );

    expect(meta).toMatchObject({
      appId: 730,
      name: 'Counter-Strike 2',
      multiplayer: true,
      priceCents: 0,
      storeUrl: 'https://store.steampowered.com/app/730',
    });
  });

  it('returns null for apps Steam will not describe', async () => {
    expect(await fetchAppMeta(1, {}, respond({ '1': { success: false } }))).toBeNull();
  });
});

describe('vibe matching', () => {
  it('recognises the multiplayer categories', () => {
    expect(isMultiplayer(['Online Co-op'])).toBe(true);
    expect(isMultiplayer(['Single-player', 'Steam Cloud'])).toBe(false);
  });

  it('matches games to a vibe', () => {
    const shooter = { genres: ['Action'], categories: ['Online PvP'] };
    const cosy = { genres: ['Casual', 'Simulation'], categories: ['Online Co-op'] };

    expect(matchesVibe(shooter, 'competitive')).toBe(true);
    expect(matchesVibe(cosy, 'chill')).toBe(true);
    expect(matchesVibe(shooter, 'chill')).toBe(false);
  });

  it('treats mood-only vibes as matching everything', () => {
    const anything = { genres: ['Strategy'], categories: [] };
    expect(matchesVibe(anything, 'something_new')).toBe(true);
    expect(matchesVibe(anything, 'old_favorite')).toBe(true);
  });

  it('weights the fit by how many people picked each vibe', () => {
    const shooter = { genres: ['Action'], categories: ['Online PvP'] };

    // Three of four vibe picks are competitive.
    const fit = vibeScore(shooter, [
      { tag: 'competitive', count: 3 },
      { tag: 'chill', count: 1 },
    ]);
    expect(fit).toBeCloseTo(0.75, 5);

    // Nobody is in the mood for it.
    expect(vibeScore(shooter, [{ tag: 'chill', count: 2 }])).toBe(0);
    // No vibes recorded means no opinion, not no match.
    expect(vibeScore(shooter, [])).toBe(1);
  });
});

/**
 * The Twilio scaffold is not wired up, but it proves the payload really is
 * channel-agnostic: the same ActionRefs Discord renders as buttons become a
 * numbered reply menu, with no change to any caller.
 */
describe('TwilioSMSNotifier scaffold', () => {
  const payload = templates.weeklyPrompt({
    groupId: 1,
    groupName: 'The Basement',
    weekStartDate: '2026-08-10',
    timezone: 'Europe/London',
  });

  it('renders the same payload as numbered SMS replies', () => {
    const text = renderSms(payload);

    expect(text).toContain('Reply 1 — I&apos;m in, let&apos;s go'.replace(/&apos;/g, "'"));
    expect(text).toContain("Reply 2 — Can't this week");
    // Discord markdown does not belong in an SMS.
    expect(text).not.toContain('**');
  });

  it('maps a numbered reply back to the action it stands for', () => {
    expect(resolveSmsReply(payload, '1')).toEqual({ kind: 'start_weekly_flow', groupId: 1 });
    expect(resolveSmsReply(payload, ' 2 ')).toEqual({ kind: 'opt_out_week', groupId: 1 });
    expect(resolveSmsReply(payload, '9')).toBeUndefined();
    expect(resolveSmsReply(payload, 'yes please')).toBeUndefined();
  });
});
