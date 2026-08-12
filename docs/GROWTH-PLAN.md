# 200 servers by Christmas

Written 12 August 2026. Nineteen weeks to 25 December.

## The honest framing

Two things cannot be automated, and pretending otherwise would waste the nineteen weeks:

**Distribution is not a build task.** Nobody installs a Discord bot because it exists. Growth
comes from a link being shared by someone who found it useful. What engineering can do is
make the bot _worth_ sharing and make sharing _frictionless_ — not manufacture demand.

**The tactics that look like automated growth are bannable.** Mass-DMing users, auto-joining
servers, scripted advertising in servers you were not invited to: all against Discord's
Developer Terms, and the penalty is the application being terminated. Not "risky" — the
single fastest way to end this project. Nothing in this plan does any of it.

What follows is: remove the hard blockers, make the bot survive contact with strangers, make
it spread by being used, and put the manual promotion on a schedule.

---

## The blocker that decides everything: verification

**At 75 servers, Discord requires application verification to keep a privileged intent.**
Skeddy uses `GUILD_MEMBERS`. Unverified, the bot stops being able to connect **in every
server at once** once it crosses 75 — not just new ones. It is a cliff, not a taper.

Verification requires: a verified Discord account with 2FA, government ID, a filled-out
application describing intent usage, plus **a Privacy Policy and Terms of Service at public
URLs**. Turnaround has historically been days to several weeks and is not something to start
in December.

There are two routes and the choice is genuinely open:

### Route A — verify (keeps the current onboarding)

Start the application **this month**. The intent justification writes itself: the bot needs
the member list to know who to ask for availability, stores only snowflakes, and shows no
names to anyone who cannot already see them.

Cost: a few hours of paperwork, weeks of waiting, and a permanent dependency on Discord's
review for every future intent change.

### Route B — drop the intent (removes the cliff entirely)

`GUILD_MEMBERS` buys exactly one thing: one person running `/availability` enrols everybody
else automatically. Without it, membership is opt-in — the original design, before that
feature.

The replacement is the **"Count me in" button** that was specced in the original plan and
never built: the bot posts a public message with a Join button, and the roster becomes the
people who tapped it. That roster is arguably better — it lists people who actually play
rather than everyone who ever joined the server — and it removes the 75-server cliff, the ID
check, and the review dependency in one move.

Cost: onboarding a server takes one extra tap per person.

**Recommendation: do both, in this order.** Build the Join button now (it is a day of work
and makes onboarding better regardless), _and_ start verification this month. If
verification lands, keep the auto-enrol as a bonus; if it stalls, the bot is already free of
the dependency and 200 servers is unblocked. Doing only one of them means either waiting on
Discord or discovering in November that you needed to.

---

## Milestones

| By     | Target                            | Gate                                            |
| ------ | --------------------------------- | ----------------------------------------------- |
| 31 Aug | 5 servers, verification submitted | Onboarding works with zero instructions         |
| 30 Sep | 25 servers                        | Week-2 retention above 50%; listings live       |
| 31 Oct | 75 servers                        | Verified, or intent dropped. **Hard gate.**     |
| 30 Nov | 140 servers                       | Scale bugs below fixed; Steam key not saturated |
| 25 Dec | 200 servers                       | —                                               |

The shape that matters: **25 by end of September or the target is not happening.** Bot growth
compounds through sharing, and there is no compounding without a base. If September closes
under 15, the problem is the product, not the promotion — stop pushing and fix retention.

---

## Phase 1 — Survive a stranger (August)

Everything here is engineering, and all of it is required before promoting anything. A
stranger's server gets one chance.

**1.1 Zero-instruction onboarding.** Today a new server does nothing until someone runs
`/setup`. Nobody reads a README. On `guildCreate`, post to the system channel (or the first
channel the bot can write to): what Skeddy does in two lines, a **Get Started** button, and a
**Count me in** button. Defaults picked automatically — timezone from the guild's locale
region, announce channel from where the post landed, cutoff Thursday 18:00.

**1.2 The Join button** (Route B above). Public, persistent, re-postable with `/setup`.

**1.3 `/help`.** One ephemeral message listing what the five commands do. Cheap, and its
absence looks broken.

**1.4 An install page.** A single static page: what it does, three screenshots, the install
button, plus the **Privacy Policy and Terms of Service that verification requires anyway**.
Host it on the Railway instance that is already serving `/healthz`. This doubles as the link
you share everywhere.

**1.5 Metrics.** You cannot manage this blind. A `/stats` command restricted to your own
Discord id, reporting: servers, servers with ≥1 response this week, weekly active members,
Steam-linked members, and the **activation rate** — the share of servers that ever got a
second week. Activation rate is the number that tells you whether promotion is worth doing.

## Phase 2 — Make it spread by being used (September)

**2.1 An invite footer.** The weekly board is the bot's best advert and it is already public.
A small "Add Skeddy to your server" link in the footer, shown only in servers with ≥2 weeks
of use, is the entire viral loop. Do not put it on the first post — it reads as spam before
the bot has earned anything.

**2.2 `/invite`.** Returns the install link. Obvious, missing, one file.

**2.3 A first-week sequence.** A server that goes quiet after week one is churned. If a group
answered in week 1 and nobody has answered by Wednesday of week 2, post one gentle prompt.
Once, not weekly — a bot that nags a dead server is a bot that gets kicked.

**2.4 Listings.** Submit to top.gg, discord.bots.gg, discordbotlist.com. Free, permanent,
and roughly half of organic bot discovery. Each needs the install page from 1.4 to exist.
This is manual and takes an afternoon.

## Phase 3 — Survive the scale (DONE, August)

Four things were correct at 1 server and wrong at 200. Three are fixed; the fourth was never
a problem. Kept here as the record of what was wrong and why.

**3.1 ~~`primaryCountryCode`~~ — FIXED.** `refreshAppMetadata` fetches prices for _one_
country per tick, chosen as the lowest group id. At 200 servers every group sees the
storefront of whichever server signed up first. `steam_app_meta` needs to become
`(app_id, country_code)` keyed — the migration comment already predicts this.

**3.2 ~~Steam key bottleneck~~ — FIXED** by splitting country-independent facts from
per-country prices, so a game is described once globally and priced only for storefronts
actually in use, under a fixed global per-tick budget.

Original diagnosis: One key, ~200 Store requests per 5 minutes,
across every server. At 40 apps/tick the metadata backlog for 200 servers never drains.
Needs: per-app-id global dedupe (already there), a cap on how much any one guild can consume
per cycle, and a fallback that degrades to "no price yet" rather than starving.

**3.3 ~~DM fan-out~~ — FIXED** with a global bounded-concurrency queue (`services/sendQueue.ts`).

Original diagnosis: Fine to 200 — `job_run`'s primary key
makes correctness independent of instance count — but the weekly DM fan-out becomes the
constraint. DM channel creation is a heavy rate-limit bucket. Needs a global send queue with
concurrency limits rather than per-group loops.

**3.4 Postgres.** 200 servers × ~10 members × 42 slots is trivial. Railway's smallest plan
handles this. Not a concern; noted so it does not become a worry.

## Phase 4 — Promotion (rolling, manual)

This is the part that is honestly not automatable, and it is a few hours a week:

- Post in communities where the problem is felt: r/gamingbuddies, r/DiscordApps, adult-gamer
  Discord communities, guild/clan servers. **Read each community's self-promotion rules
  first** — one ban does more damage than ten posts gain.
- A short demo video. The single highest-leverage asset: the two-minute flow is the pitch,
  and it does not survive being described in text.
- Ask the first twenty servers directly for a share. Direct asks convert enormously better
  than broadcasts, and twenty is a number you can personally handle.

---

## What I would cut if time runs short

In order of what to drop first: Phase 4's video, then the first-week sequence, then listings.

**Never cut:** the verification decision (Phase 1's blocker), zero-instruction onboarding, or
the `primaryCountryCode` fix. The first makes 200 impossible, the second makes every new
server churn, and the third quietly shows people the wrong prices in their own currency.
