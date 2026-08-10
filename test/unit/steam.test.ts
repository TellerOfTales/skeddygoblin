import { describe, expect, it, vi } from 'vitest';
import { buildAuthUrl, verifyCallback } from '../../src/steam/openid.js';
import {
  fetchAppMeta,
  fetchOwnedGames,
  searchStore,
  SteamProfilePrivateError,
} from '../../src/steam/clients.js';
import {
  formatPrice,
  isMultiplayer,
  matchesVibe,
  vibeScore,
} from '../../src/domain/gameMatching.js';
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

  /** A vibe is a Steam term, so matching is membership rather than a mapping. */
  it('matches a game that literally carries the tag', () => {
    const shooter = { genres: ['Action'], categories: ['Online PvP'] };
    const farm = { genres: ['Simulation', 'Casual'], categories: ['Online Co-op'] };

    expect(matchesVibe(shooter, 'Action')).toBe(true);
    expect(matchesVibe(shooter, 'Online PvP')).toBe(true);
    expect(matchesVibe(farm, 'Simulation')).toBe(true);

    expect(matchesVibe(shooter, 'Simulation')).toBe(false);
    expect(matchesVibe(farm, 'Online PvP')).toBe(false);
  });

  /**
   * Steam's own categories nest: a game tagged only "Online Co-op" is plainly
   * Co-op. Those broadenings are listed explicitly rather than inferred.
   */
  it('accepts the narrower Steam categories that imply a vibe', () => {
    expect(matchesVibe({ genres: [], categories: ['Online Co-op'] }, 'Co-op')).toBe(true);
    expect(matchesVibe({ genres: [], categories: ['LAN PvP'] }, 'Online PvP')).toBe(true);
    // ...but not in the other direction: Co-op does not imply versus.
    expect(matchesVibe({ genres: [], categories: ['Co-op'] }, 'Online PvP')).toBe(false);
  });

  it('weights the fit by how many people picked each vibe', () => {
    const shooter = { genres: ['Action'], categories: ['Online PvP'] };

    // Three of four vibe picks are ones this game carries.
    expect(
      vibeScore(shooter, [
        { tag: 'Online PvP', count: 3 },
        { tag: 'Simulation', count: 1 },
      ]),
    ).toBeCloseTo(0.75, 5);

    // Nobody is in the mood for it.
    expect(vibeScore(shooter, [{ tag: 'Simulation', count: 2 }])).toBe(0);
    // No vibes recorded means no opinion, not no match.
    expect(vibeScore(shooter, [])).toBe(1);
  });
});

describe('price formatting', () => {
  it('renders in the storefront currency, symbol and all', () => {
    expect(formatPrice(1499, 'GBP')).toBe('£14.99');
    // Deliberately "$", not the "US$" a non-US locale would otherwise produce:
    // it has to match what people saw on the store page.
    expect(formatPrice(1499, 'USD')).toBe('$14.99');
    expect(formatPrice(1499, 'EUR')).toBe('€14.99');
  });

  /**
   * Steam reports every currency with two implied decimals, including ones that
   * have no minor unit at all - a 2,970 yen game comes back as 297000, not
   * 2970. So dividing by 100 is right universally, and Intl then drops the
   * decimals that yen does not use.
   */
  it('handles a zero-decimal currency without inventing fractions of a yen', () => {
    const formatted = formatPrice(297_000, 'JPY');
    expect(formatted).toContain('2,970');
    expect(formatted).not.toContain('.');
  });

  it('distinguishes free from unknown', () => {
    expect(formatPrice(0, 'GBP')).toBe('Free');
    // Unreleased or unpriced: "we do not know" is not "it costs nothing".
    expect(formatPrice(null, 'GBP')).toBeNull();
  });

  it('degrades rather than throwing on a currency Intl rejects', () => {
    expect(formatPrice(500, 'NOTACURRENCY')).toBe('5.00 NOTACURRENCY');
  });
});

describe('store search', () => {
  const respond = (body: unknown) =>
    (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

  it('asks the group storefront so the price is in their currency', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: [] })));

    await searchStore({ term: 'hades', countryCode: 'GB' }, fetchImpl as unknown as typeof fetch);

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(new URL(url).searchParams.get('cc')).toBe('GB');
    expect(new URL(url).searchParams.get('term')).toBe('hades');
  });

  it('maps results with price and store link', async () => {
    const results = await searchStore(
      { term: 'hades', countryCode: 'GB' },
      respond({
        items: [{ id: 1145360, name: 'Hades', price: { currency: 'GBP', final: 1699 } }],
      }),
    );

    expect(results).toEqual([
      {
        appId: 1145360,
        name: 'Hades',
        priceCents: 1699,
        currency: 'GBP',
        storeUrl: 'https://store.steampowered.com/app/1145360',
      },
    ]);
  });

  it('reports a missing price as unknown rather than free', async () => {
    const [result] = await searchStore(
      { term: 'unreleased', countryCode: 'GB' },
      respond({ items: [{ id: 99, name: 'Unreleased Thing' }] }),
    );
    expect(result?.priceCents).toBeNull();
  });

  it('does not call Steam for an empty search', async () => {
    const fetchImpl = vi.fn();
    expect(await searchStore({ term: '  ', countryCode: 'GB' }, fetchImpl as never)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
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

describe('formatPrice with a USD reference', () => {
  // Steam prices regionally rather than converting, so the bracketed figure is
  // a second real price - not the local one run through an exchange rate.
  it('shows the local price with USD in brackets', () => {
    expect(formatPrice(1699, 'GBP', { usdMinorUnits: 2199 })).toBe('£16.99 ($21.99)');
  });

  it('drops the brackets when the local currency IS USD', () => {
    expect(formatPrice(2199, 'USD', { usdMinorUnits: 2199 })).toBe('$21.99');
  });

  it('drops the brackets when no reference price was fetched', () => {
    expect(formatPrice(1699, 'GBP', { usdMinorUnits: null })).toBe('£16.99');
    expect(formatPrice(1699, 'GBP')).toBe('£16.99');
  });

  it('drops the brackets when both prices render identically', () => {
    // Nothing is communicated by "£16.99 (£16.99)".
    expect(formatPrice(1699, 'USD', { usdMinorUnits: 1699 })).toBe('$16.99');
  });

  it('says Free once, not twice', () => {
    expect(formatPrice(0, 'GBP', { usdMinorUnits: 0 })).toBe('Free');
  });

  it('still reports an unknown price as unknown', () => {
    expect(formatPrice(null, 'GBP', { usdMinorUnits: 2199 })).toBeNull();
  });

  /**
   * Steam reports every currency with two implied decimals, INCLUDING
   * zero-decimal ones - a ¥2,970 game arrives as 297000, not 2970. Getting this
   * wrong is a factor-of-100 error on the price people decide by.
   */
  it('handles a zero-decimal currency without inventing a factor of 100', () => {
    expect(formatPrice(297000, 'JPY', { usdMinorUnits: 1999 })).toBe('JP¥2,970 ($19.99)');
  });
});
