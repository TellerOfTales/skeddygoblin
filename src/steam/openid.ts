/**
 * "Sign in through Steam" is OpenID 2.0, NOT OAuth.
 *
 * This is the single most common wrong assumption about Steam auth, and it
 * changes the implementation completely: there is no client secret, no token
 * exchange, and no scopes. The flow is:
 *
 *   1. Redirect the user to Steam with openid.mode=checkid_setup.
 *   2. Steam redirects back to return_to with a bundle of openid.* parameters.
 *   3. We POST that bundle straight back to Steam with
 *      openid.mode=check_authentication, and Steam answers is_valid:true/false.
 *
 * Step 3 is not optional. Everything in step 2 arrives via the user's browser
 * and is trivially forgeable; the round trip is the only thing that makes the
 * claimed SteamID trustworthy.
 */

const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';

/** Steam's claimed_id always looks like .../openid/id/<steamid64>. */
const CLAIMED_ID_PATTERN = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

export function buildAuthUrl(params: { returnTo: string; realm: string }): string {
  const query = new URLSearchParams({
    'openid.ns': OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': params.returnTo,
    'openid.realm': params.realm,
    'openid.identity': IDENTIFIER_SELECT,
    'openid.claimed_id': IDENTIFIER_SELECT,
  });
  return `${STEAM_OPENID_ENDPOINT}?${query.toString()}`;
}

export interface VerifyResult {
  ok: boolean;
  steamId?: string;
  reason?: string;
}

/**
 * Verifies a callback by asking Steam to authenticate its own assertion.
 *
 * @param query the openid.* parameters exactly as received, unmodified.
 */
export async function verifyCallback(
  query: URLSearchParams,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  if (query.get('openid.mode') !== 'id_res') {
    return { ok: false, reason: 'not an id_res assertion' };
  }

  const claimedId = query.get('openid.claimed_id');
  if (!claimedId) return { ok: false, reason: 'missing claimed_id' };

  const match = CLAIMED_ID_PATTERN.exec(claimedId);
  if (!match) return { ok: false, reason: 'claimed_id is not a Steam identity' };

  // Echo every parameter back verbatim, with only the mode swapped. Dropping or
  // reordering any of them invalidates the signature Steam is checking.
  const body = new URLSearchParams(query);
  body.set('openid.mode', 'check_authentication');

  let text: string;
  try {
    const response = await fetchImpl(STEAM_OPENID_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) return { ok: false, reason: `steam returned ${response.status}` };
    text = await response.text();
  } catch (error) {
    return { ok: false, reason: `could not reach steam: ${(error as Error).message}` };
  }

  const isValid = /^is_valid:\s*true\s*$/m.test(text);
  if (!isValid) return { ok: false, reason: 'steam did not validate the assertion' };

  return { ok: true, steamId: match[1]! };
}
