/**
 * P5. The brief asks that any direct Discord API call for user notification be
 * flagged in review. This makes it a test instead.
 *
 * There is also an ESLint rule doing the same job, deliberately: a lint step can
 * be skipped or a rule disabled inline, and this invariant is load-bearing for
 * the whole notifier abstraction.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../../src/', import.meta.url).pathname;

/** The one file allowed to talk to the Discord send API. */
const ALLOWED_SEND_SITE = 'notify/DiscordDMNotifier.ts';

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    }),
  );
  return files.flat();
}

describe('notifier boundary', () => {
  it('only DiscordDMNotifier reaches the Discord send API', async () => {
    const files = await sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC, file);
      if (rel === ALLOWED_SEND_SITE) continue;

      const source = await readFile(file, 'utf8');
      // Strip comments so prose about the rule does not trip the rule.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');

      // `.users.fetch(`, `.createDM(`, and sending to a fetched user are the
      // routes to a DM. Interaction replies are NOT covered: those are
      // responses to something the user just did, not outbound notifications.
      if (/\.createDM\s*\(/.test(code)) offenders.push(`${rel}: createDM()`);
      if (/client\.users\b/.test(code)) offenders.push(`${rel}: client.users`);
    }

    expect(offenders).toEqual([]);
  });

  it('no service or domain module imports discord.js', async () => {
    const files = [
      ...(await sourceFiles(join(SRC, 'services'))),
      ...(await sourceFiles(join(SRC, 'domain'))),
    ];
    expect(files.length).toBeGreaterThan(4);

    const offenders = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/from\s+'discord\.js'/.test(source)) offenders.push(relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });
});
