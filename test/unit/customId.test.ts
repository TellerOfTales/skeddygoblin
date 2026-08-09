import { describe, expect, it } from 'vitest';
import {
  CUSTOM_ID_MAX_LENGTH,
  encodeCustomId,
  fromBase36,
  MalformedCustomIdError,
  parseCustomId,
  toBase36,
  UnknownVersionError,
} from '../../src/discord/customId.js';

describe('customId codec', () => {
  it('round-trips namespace, action and args', () => {
    const id = encodeCustomId('av', 'win', '1f3a', 2);
    expect(id).toBe('v1:av:win:1f3a:2');

    const parsed = parseCustomId(id);
    expect(parsed).toEqual({ namespace: 'av', action: 'win', args: ['1f3a', '2'] });
  });

  it('handles an action with no args', () => {
    expect(parseCustomId(encodeCustomId('av', 'optout'))).toEqual({
      namespace: 'av',
      action: 'optout',
      args: [],
    });
  });

  it('rejects args containing the delimiter or unsafe characters', () => {
    expect(() => encodeCustomId('av', 'win', 'a:b')).toThrow(/delimiter or unsafe/);
    expect(() => encodeCustomId('av', 'win', 'display name')).toThrow(/delimiter or unsafe/);
  });

  it('refuses to build an id longer than Discord allows', () => {
    const tooLong = 'x'.repeat(CUSTOM_ID_MAX_LENGTH);
    expect(() => encodeCustomId('av', 'win', tooLong)).toThrow(/exceeds 100 chars/);
  });

  it('keeps realistic ids well under the limit', () => {
    const ids = [
      encodeCustomId('av', 'win', toBase36(999999), 6),
      encodeCustomId('buzz', 'go', toBase36(4096), toBase36(999999), toBase36(20315)),
      encodeCustomId('sess', 'rsvp', toBase36(123456), 'yes'),
    ];
    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(CUSTOM_ID_MAX_LENGTH);
    }
  });

  /**
   * Components live in people's DMs indefinitely. When the scheme changes, an
   * old button must produce a clear message rather than a crash - which is only
   * possible because the version is checked before the rest is trusted.
   */
  it('flags an unknown version distinctly from malformed input', () => {
    expect(() => parseCustomId('v2:av:win:1')).toThrow(UnknownVersionError);
    expect(() => parseCustomId('garbage')).toThrow(MalformedCustomIdError);
    expect(() => parseCustomId('v1:nope:win')).toThrow(MalformedCustomIdError);
  });
});

describe('base36 helpers', () => {
  it('round-trips ids', () => {
    for (const value of [0, 1, 42, 4096, 999_999, 2_147_483_647]) {
      expect(fromBase36(toBase36(value))).toBe(value);
    }
  });

  it('is meaningfully shorter than decimal for realistic ids', () => {
    expect(toBase36(999_999).length).toBeLessThan(String(999_999).length);
  });
});
