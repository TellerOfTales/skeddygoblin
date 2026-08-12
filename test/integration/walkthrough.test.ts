/**
 * A narrated end-to-end walkthrough of one week, printed as it runs.
 *
 * This is the whole product except the Discord transport: real Postgres, real
 * services, real invariants. Run it with `npm run walkthrough`.
 */

import { describe, it } from 'vitest';
import { withRollback } from '../helpers/db.js';
import { makeGroup, makeMember, upsertGame } from '../helpers/fixtures.js';
import * as groups from '../../src/db/repositories/groups.js';
import * as steam from '../../src/db/repositories/steam.js';
import { currentWeek, optOut, submit } from '../../src/services/responseService.js';
import { buildOverlapReport } from '../../src/services/overlapService.js';
import { buildRoster } from '../../src/services/rosterService.js';
import { buzz } from '../../src/services/buzzService.js';
import { suggestGamesPage } from '../../src/services/gameService.js';
import { proposeSession, rsvp, confirmSession } from '../../src/services/sessionService.js';
import { DAY_LABELS, WINDOW_LABELS } from '../../src/domain/constants.js';
import { formatPrice } from '../../src/domain/gameMatching.js';

const say = (s = '') => console.log(s);

describe('walkthrough', () => {
  it('runs one full week', async () => {
    await withRollback(async (ctx) => {
      const base = await makeGroup(ctx, { name: 'The Basement', timezone: 'Europe/London' });
      const group = await groups.updateGroupSettings(ctx.db, base.id, { countryCode: 'GB' });
      const week = currentWeek(ctx, group.timezone);
      const scope = { groupId: group.id, weekStartDate: week };

      const [alex, sam, jo, kit] = [
        await makeMember(ctx, group, { role: 'organizer' }),
        await makeMember(ctx, group),
        await makeMember(ctx, group),
        await makeMember(ctx, group),
      ];

      say(
        `\n=== ${group.name} · week of ${week} · ${group.timezone} · storefront ${group.countryCode} ===`,
      );

      say('\n--- everyone answers ---');
      await submit(ctx, {
        userId: alex.id,
        ...scope,
        sessionsCommitted: 2,
        slots: [
          { dayOfWeek: 2, window: 'evening' },
          { dayOfWeek: 4, window: 'evening' },
          { dayOfWeek: 6, window: 'late_night' },
        ],
        vibes: ['Online PvP', 'Action'],
      });
      say(
        'Alex   submitted · Wed evening, Fri evening, Sun late night · 2 sessions · Versus, Action',
      );

      await submit(ctx, {
        userId: sam.id,
        ...scope,
        sessionsCommitted: 3,
        slots: [
          { dayOfWeek: 2, window: 'evening' },
          { dayOfWeek: 4, window: 'evening' },
        ],
        vibes: ['Online PvP'],
      });
      say('Sam    submitted · Wed evening, Fri evening · 3 sessions · Versus');

      await submit(ctx, {
        userId: jo.id,
        ...scope,
        sessionsCommitted: 1,
        slots: [{ dayOfWeek: 2, window: 'evening' }],
        vibes: ['Co-op'],
      });
      say('Jo     submitted · Wed evening · 1 session · Co-op');

      await optOut(ctx, { userId: kit.id, ...scope });
      say('Kit    tapped "Can\'t this week" — one tap, flow over');
      say('(nobody answered for Sun late night except Alex — watch what happens to it)');

      say('\n--- /overlap ---');
      const report = await buildOverlapReport(ctx, scope);
      for (const [i, w] of report.windows.entries()) {
        say(
          `  ${['🥇', '🥈', '🥉'][i]} ${DAY_LABELS[w.dayOfWeek]} ${WINDOW_LABELS[w.window].toLowerCase()} — ${w.headcount} can make it  (score ${w.score.toFixed(4)})`,
        );
      }
      say(
        `  footer: ${report.responded}/${report.total} answered · mood: ${report.topVibes.map((v) => v.tag).join(', ')}`,
      );
      say(
        `  Alex's solo Sunday slot present? ${report.windows.some((w) => w.dayOfWeek === 6) ? 'YES (BUG)' : 'no — below the k-anonymity floor'}`,
      );

      say('\n--- /status ---');
      const roster = await buildRoster(ctx, { group, weekStartDate: week });
      for (const r of roster.rows) {
        const who = [alex, sam, jo, kit].find((u) => u.id === r.userId)!;
        const name = who === alex ? 'Alex' : who === sam ? 'Sam' : who === jo ? 'Jo' : 'Kit';
        say(
          `  ${r.hasResponded ? '✅' : '⬜'} ${name}${r.hasResponded ? ' (answered)' : ' — buzzable'}`,
        );
      }
      say(
        '  note: Kit opted out but reads identically to "submitted" — that distinction is private',
      );

      say('\n--- buzz rules (service layer, bypassing the buttons) ---');
      for (const [label, target] of [
        ['Kit (opted out)', kit],
        ['Sam (submitted)', sam],
      ] as const) {
        try {
          await buzz(ctx, {
            actorUserId: alex.id,
            targetUserId: target.id,
            groupId: group.id,
            weekStartDate: week,
          });
          say(`  buzz ${label}: SENT (BUG)`);
        } catch (e) {
          say(`  buzz ${label}: refused — ${(e as { code: string }).code}`);
        }
      }
      try {
        await buzz(ctx, {
          actorUserId: alex.id,
          targetUserId: alex.id,
          groupId: group.id,
          weekStartDate: week,
        });
      } catch (e) {
        say(`  buzz self: refused — ${(e as { code: string }).code}`);
      }

      say('\n--- Steam: shared library ---');
      await upsertGame(ctx, {
        appId: 730,
        name: 'Counter-Strike 2',
        categories: ['Online PvP', 'Multi-player'],
        genres: ['Action'],
        multiplayer: true,
        priceCents: 0,
        currency: 'GBP',
        priceCentsUsd: 0,
        priceCountry: 'GB',
        storeUrl: 'https://store.steampowered.com/app/730',
      });
      await upsertGame(ctx, {
        appId: 1145360,
        name: 'Hades',
        categories: ['Single-player'],
        genres: ['Action'],
        multiplayer: false,
        priceCents: 1699,
        currency: 'GBP',
        priceCentsUsd: 2199,
        priceCountry: 'GB',
        storeUrl: 'https://store.steampowered.com/app/1145360',
      });
      await upsertGame(ctx, {
        appId: 413150,
        name: 'Stardew Valley',
        categories: ['Online Co-op', 'Multi-player'],
        genres: ['Simulation', 'Casual'],
        multiplayer: true,
        priceCents: 1099,
        currency: 'GBP',
        priceCentsUsd: 1399,
        priceCountry: 'GB',
        storeUrl: 'https://store.steampowered.com/app/413150',
      });
      await upsertGame(ctx, {
        appId: 892970,
        name: 'Valheim',
        categories: ['Online Co-op', 'Multi-player'],
        genres: ['Action', 'Simulation'],
        multiplayer: true,
        priceCents: 1619,
        currency: 'GBP',
        priceCentsUsd: 2099,
        priceCountry: 'GB',
        storeUrl: 'https://store.steampowered.com/app/892970',
      });

      const cs2 = { appId: 730, gameName: 'Counter-Strike 2', multiplayer: true };
      const hades = { appId: 1145360, gameName: 'Hades', multiplayer: false };
      const stardew = { appId: 413150, gameName: 'Stardew Valley', multiplayer: true };
      const valheim = { appId: 892970, gameName: 'Valheim', multiplayer: true };
      await steam.replaceLibraryForSelf(ctx.db, alex.id, [cs2, hades, stardew, valheim]);
      await steam.replaceLibraryForSelf(ctx.db, sam.id, [cs2, valheim]);
      await steam.replaceLibraryForSelf(ctx.db, jo.id, [cs2, stardew, valheim]);
      say('  Alex: CS2, Hades, Stardew, Valheim   Sam: CS2, Valheim   Jo: CS2, Stardew, Valheim');

      say('\n--- /games (vibe: Versus + Action + Co-op) ---');
      const page = await suggestGamesPage(ctx, { ...scope, pageSize: 3 });
      for (const g of page.games) {
        say(
          `  ${g.name} — ${g.ownerCount} of you own it · ${formatPrice(g.priceCents, g.currency, { usdMinorUnits: g.priceCentsUsd })} · fit ${(g.vibeFit * 100).toFixed(0)}%`,
        );
      }
      say(`  page ${page.page + 1} of ${page.totalPages} (${page.total} shared)`);
      say('  Hades absent: only Alex owns it AND it is single-player');

      say('\n--- lock in a session ---');
      const best = report.windows[0]!;
      const proposal = await proposeSession(ctx, {
        ...scope,
        day: best.dayOfWeek,
        window: best.window,
        createdBy: alex.id,
      });
      for (const u of [alex, sam, jo])
        await rsvp(ctx, { proposalId: proposal.id, userId: u.id, response: 'yes' });
      ctx.notifier.reset();
      const { notified } = await confirmSession(ctx, { proposalId: proposal.id, group });
      say(
        `  ${DAY_LABELS[best.dayOfWeek]} ${WINDOW_LABELS[best.window].toLowerCase()} confirmed — ${notified} people notified via notify()`,
      );

      say('\n--- capacity is now spent, so the board changes ---');
      const after = await buildOverlapReport(ctx, scope);
      for (const w of after.windows)
        say(
          `  ${DAY_LABELS[w.dayOfWeek]} ${WINDOW_LABELS[w.window].toLowerCase()} — ${w.headcount}`,
        );
      say(`  Jo committed their only session, so they stop pulling the group elsewhere`);
      say('');
    });
  }, 60_000);
});
