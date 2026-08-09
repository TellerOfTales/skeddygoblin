/**
 * custom_id codec.
 *
 *   v1:<ns>:<action>[:<arg>...]
 *
 * Two properties matter and are asserted, not assumed:
 *
 * 1. Length. Discord rejects a custom_id over 100 characters, and the failure
 *    surfaces at send time as an opaque API error. encode() throws instead.
 * 2. Version. Components live in people's DMs indefinitely. A leading version
 *    tag lets the scheme change without those old messages producing garbage:
 *    an unknown version renders "this prompt is from an older version of the
 *    bot" rather than a crash.
 *
 * Args are numeric or enum-index only - never user-supplied text and never a
 * display name, both because ':' is the delimiter and because a custom_id is
 * echoed back by the client and should carry no personal data.
 */

export const CUSTOM_ID_VERSION = 'v1';
export const CUSTOM_ID_MAX_LENGTH = 100;

/** Router namespaces. One handler module per namespace. */
export const NAMESPACES = ['av', 'buzz', 'sess', 'gv', 'grp'] as const;
export type Namespace = (typeof NAMESPACES)[number];

export interface ParsedCustomId {
  namespace: Namespace;
  action: string;
  args: string[];
}

export class UnknownVersionError extends Error {
  constructor(readonly version: string) {
    super(`Unknown custom_id version: ${version}`);
    this.name = 'UnknownVersionError';
  }
}

export class MalformedCustomIdError extends Error {
  constructor(readonly raw: string) {
    super(`Malformed custom_id: ${raw}`);
    this.name = 'MalformedCustomIdError';
  }
}

const SAFE_ARG = /^[A-Za-z0-9_-]*$/;

export function encodeCustomId(
  namespace: Namespace,
  action: string,
  ...args: (string | number)[]
): string {
  const parts = [CUSTOM_ID_VERSION, namespace, action, ...args.map(String)];

  for (const part of parts) {
    if (!SAFE_ARG.test(part)) {
      throw new Error(
        `custom_id part "${part}" contains a delimiter or unsafe character. ` +
          'Args must be numeric or enum-index only.',
      );
    }
  }

  const id = parts.join(':');
  if (id.length > CUSTOM_ID_MAX_LENGTH) {
    throw new Error(`custom_id exceeds ${CUSTOM_ID_MAX_LENGTH} chars (${id.length}): ${id}`);
  }
  return id;
}

export function parseCustomId(raw: string): ParsedCustomId {
  const parts = raw.split(':');
  const [version, namespace, action, ...args] = parts;

  if (version === undefined || namespace === undefined || action === undefined) {
    throw new MalformedCustomIdError(raw);
  }
  if (version !== CUSTOM_ID_VERSION) {
    throw new UnknownVersionError(version);
  }
  if (!(NAMESPACES as readonly string[]).includes(namespace)) {
    throw new MalformedCustomIdError(raw);
  }

  return { namespace: namespace as Namespace, action, args };
}

/** base36 keeps draft/group/user ids short inside a 100-char budget. */
export function toBase36(value: number | string): string {
  return Number(value).toString(36);
}

export function fromBase36(value: string): number {
  const parsed = Number.parseInt(value, 36);
  if (!Number.isFinite(parsed)) throw new Error(`Not a base36 integer: ${value}`);
  return parsed;
}
