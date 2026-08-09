# Skeddy Goblin

Skeddy Goblin coordinates gaming sessions for busy people. Answer a few quick questions about
your week and it finds when your friend group overlaps, matches shared Steam Library games to
the vibe, and nudges anyone who hasn't responded. Skeddy Goblin does the work for you —
scheduling, coordinating, and pinging.

## Quick start

```bash
npm install
cp .env.example .env          # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID

# Postgres: either of these works
docker compose up -d db       # if you have Docker
npm run db:up                 # otherwise: a throwaway local cluster via initdb/pg_ctl

npm run migrate
npm run register              # guild-scoped slash commands (instant propagation)
npm run dev
```

Then run `/availability` in your test guild.

## Design constraints worth knowing before you change things

These are load-bearing. Each one is enforced somewhere other than a code review comment.

**The weekly flow must stay under ~2 minutes.** Before adding a field, step, or question, ask
whether it is worth the seconds it costs every member, every week.

**Privacy is aggregate-only.** No member's raw availability, capacity, or vibe picks are ever
visible to anyone but themselves. This is enforced at the query layer, not the UI: repository
functions are either self-scoped (name ends in `ForSelf`, first parameter is `selfUserId`, SQL
carries `user_id = $1`) or aggregate (return types have no user-identity field at all). There is
no function that takes a viewer and a target and returns raw rows, so the leaking call is not
expressible. An ESLint rule additionally stops the Discord layer from importing the database
layer, so a view cannot hold a raw record even by accident.

The status roster is the one place names appear, and it reports only a boolean — "responded" or
not. It never distinguishes _opted out_ from _submitted_, because that distinction is itself a
preference disclosure.

**Escape hatches everywhere.** "Can't this week" is one tap, ends the flow immediately, and asks
nothing further. No guilt copy, and the button is deliberately not styled red.

**Buzz can never target someone who has already responded.** Enforced in the service layer, so it
holds regardless of which client calls it — the disabled button in the roster is a courtesy, not
the control. Rate limiting (one buzz per person per day) is enforced by a partial unique index,
so two simultaneous presses resolve to exactly one DM rather than usually one.

**Every outbound user message goes through `notify()`.** `DiscordDMNotifier` is the only file
permitted to call the Discord send API, and an ESLint rule plus a test both enforce it. The
payload is channel-agnostic (`{ title, body, actions }`) rather than discord.js builders —
that is what makes adding an SMS or WhatsApp notifier additive instead of a refactor.

**Availability is buckets, not a calendar.** 7 days × 6 named windows, no timestamps, no
time-picker. Overlap is a per-slot headcount, not interval intersection.

## Timezones

All day/window buckets, the week boundary, and the nudge cutoff are interpreted in the **group's**
timezone. `User.timezone` is stored but is display-only.

This is forced, not a preference: with no timestamps, a window is a _label_, not an interval, so
it cannot be converted between zones. Translating "Alice's Wednesday evening" into "Bob's
Wednesday evening" would require assigning clock ranges to windows — exactly the timestamp model
this design rules out. See `src/domain/week.ts`.

`week_start_date` is always the ISO Monday, and is captured when a member starts the flow and
never recomputed, so an answer that begins at 23:58 Sunday and finishes at 00:03 Monday still
writes one consistent week.

## Architecture

Dependencies run one way: `discord/ → services/ → db/repositories/`, with `domain/` pure and
importable by anything. Nothing in `services/` imports discord.js. That boundary is what will let
a future HTTP API or console client reuse the same services.

```
src/
  domain/      pure: windows, week maths, overlap scoring. no I/O.
  db/          pool, migration runner, plain-SQL migrations, repositories
  services/    business rules and the two hard invariants
  notify/      Notifier interface + DiscordDMNotifier (the only send site)
  discord/     commands, component handlers, pure view builders
  scheduler/   weekly prompt and nudge cutoff jobs
```

## Steam (Stage 2)

Steam features stay completely dormant unless both `STEAM_API_KEY` and
`PUBLIC_BASE_URL` are set. Nothing about Stage 1 changes when they are absent — no HTTP
server starts, no sync runs, and `/link-steam` says so plainly.

**Steam auth is OpenID 2.0, not OAuth.** There is no client secret and no token exchange.
The user is redirected to Steam, Steam redirects back with a bundle of `openid.*`
parameters, and those parameters are POSTed straight back to Steam for authentication.
That last step is not optional: everything in the callback arrives via the user's browser
and is trivially forgeable, so the round trip is the only thing that makes the claimed
SteamID trustworthy. `src/http/server.ts` exists solely to receive that callback.

`GetOwnedGames` needs the member's profile to have **Game details** set to Public. That is
probed at link time so the failure is reported with an actionable message, rather than
surfacing later as a mysteriously empty shared-library list.

Game _metadata_ lives in `steam_app_meta`, keyed by app id and shared across everyone —
so eight members owning the same game costs one Store API call, not eight. The Store
endpoint allows roughly 200 requests per 5 minutes, which is what makes that cache the
difference between sync working and getting the bot blocked.

**The same privacy rule applies to libraries.** A game carries an owner _count_ and never
an owner list: "6 of you own this" is an aggregate, "Bob owns this" is a disclosure about
Bob. Only members who submitted this week are counted, because the question is what
_this week's players_ can actually load up.

## Adding a second notification channel

`TwilioSMSNotifier` is a scaffold, not an integration — it throws `NotImplementedError`.
It exists to prove the abstraction holds: it compiles against the same `Notifier`
interface, consumes the same channel-agnostic payload, and turns the very same
`ActionRef`s that Discord renders as buttons into a numbered reply menu. `renderSms` and
`resolveSmsReply` are real and tested.

Making it live is: fill in `send()`, register it in `src/index.ts`, and set a member's
`preferred_channel` to `sms`. No call site changes. Until then, a member switched to
`sms` gets a clean `channel_unavailable` rather than a silently swallowed message.

## Deployment

**Run exactly one instance.** The scheduler is in-process.

That said, correctness does not depend on it: every scheduled job claims its run with an
`INSERT ... ON CONFLICT DO NOTHING` against `job_run`, whose primary key _is_ the lock, and a
second process additionally fails to take a session advisory lock and logs that it is serving
interactions only. So a brief overlap during a deploy will not double-post a leaderboard or
double-DM the group.

Scheduled jobs are evaluated by a 60-second tick rather than cron. Cron fires at a wall-clock
instant and silently skips forever if the process is down at that moment — for a _weekly_ prompt
that means a dead week. The tick plus a persisted marker gets catch-up semantics for free.

## Node versions

The application runtime floor is **Node 18**, and CI proves it by booting the compiled output
there. The development toolchain needs **Node 20+**, because vitest does.

## Commands

| Script             | What it does                                        |
| ------------------ | --------------------------------------------------- |
| `npm run dev`      | Run with reload                                     |
| `npm run migrate`  | Apply pending migrations (no Discord token needed)  |
| `npm run register` | Register guild-scoped slash commands                |
| `npm test`         | Unit + integration suites                           |
| `npm run lint`     | ESLint, including the layer and notifier boundaries |
| `npm run db:up`    | Start a local Postgres cluster without Docker       |
