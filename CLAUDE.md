# Skeddy Goblin — Project Brief for Claude Code

## What this is
A Discord bot that coordinates gaming sessions for busy adults. Members answer a short weekly questionnaire about their availability, capacity, and mood ("vibe"); the bot finds overlapping windows across the group, matches shared Steam library games to the vibe, and lets people nudge ("buzz") anyone who hasn't responded yet. Built Discord-native for Stage 1 — no separate web frontend until Steam OAuth requires one.

## Non-negotiable design principles
1. **The weekly flow must stay under ~2 minutes.** Before adding any field, step, or question, ask whether it's worth the time cost.
2. **Privacy: aggregate only.** No user's raw availability, capacity, or vibe picks are ever shown to anyone but themselves. Only *computed* results (ranked overlap windows, response status) are visible to the group. Enforce this at the query/service layer, not just in the UI — there should be no code path that lets one user's raw record leak to another user's view.
3. **Escape hatches everywhere.** "Can't this week" is a single tap and ends the flow immediately for that user — no follow-up questions, no guilt copy.
4. **Buzz can never target someone who's already responded.** Enforce this as a hard rule in the service layer (not just disabled UI), so it holds regardless of which client calls it.
5. **Build for maximum automation, minimum input.** Every user action should be a button/select, not free text, except explicit game nominations.

## Tech stack
- Runtime: Node.js (v18+), discord.js
- DB: Postgres (`pg` driver). Use SQLite locally only if Postgres setup becomes a blocker — Postgres is the target for anything committed.
- Slash commands: guild-scoped during development (instant propagation); do not register global commands yet.
- No web frontend yet. Steam OAuth and any calendar-style UI are explicitly out of scope until Stage 2.

## Availability model (do not build a calendar/time-picker)
Availability is captured as discrete buckets, not clock times:
- 7 days × 6 fixed windows per day: `morning, lunch, afternoon, evening, night, late_night`
- Overlap computation is a per-slot headcount across users with remaining capacity > 0 — not interval intersection. Keep it that simple; resist the urge to add real timestamps.

## Notifier abstraction (build this from the start, even though only one implementation exists)
All outbound messages to a user — buzz, weekly prompt, session-confirmed — must go through a single interface, e.g.:
```
notify(user, message_type, payload)
```
Stage 1 has exactly one implementation: `DiscordDMNotifier`. Do not hardcode Discord API calls anywhere outside that implementation. Store a `preferred_channel` field on the user record now (only valid value today: `discord_dm`) so adding `TwilioSMSNotifier` or a WhatsApp notifier later is additive, not a refactor. Buzz eligibility rules and rate-limiting (max one buzz per person per day) live in the shared service layer above the notifier, so they apply identically regardless of which notifier eventually handles delivery.

## Data model (build in this shape; extend, don't restructure)
```
User            id, discord_id, steam_id (nullable), steam_public (bool), timezone, preferred_channel
Group           id, discord_guild_id, name, nudge_cutoff_day, nudge_cutoff_time
GroupMembership user_id, group_id, role (member/organizer)
WeeklyResponse  id, user_id, group_id, week_start_date, status (opted_out/submitted), sessions_committed
AvailabilitySlot user_id, group_id, week_start_date, day_of_week, window (enum: morning/lunch/afternoon/evening/night/late_night)
VibeTag         id, user_id, group_id, week_start_date, tag
SteamLibraryCache  user_id, app_id, game_name, multiplayer (bool), last_synced_at   -- not built until Stage 2
SessionProposal id, group_id, candidate_day, candidate_window, status (proposed/voting/confirmed/cancelled)
SessionAttendance proposal_id, user_id, response (yes/maybe/no)
GameVote        id, proposal_id, app_id (nullable), game_name, nominated_by (nullable user_id)
GameVoteCast    vote_id, user_id
```

## Build order — work through these in sequence, one at a time
Do not skip ahead to Steam or Twilio integration until steps 1–6 work end to end.

1. **Bot skeleton** — client connects, logs in, registers one guild-scoped `/availability` command that replies with a placeholder.
2. **Quick-out flow** — `/availability` DMs the user two buttons: "Can't this week" / "I'm in, let's go." Tapping "Can't this week" writes a `WeeklyResponse` row with `status = opted_out` and ends the flow. This is the first full round trip (Discord → bot → DB → confirmation back to user) — get it fully working and tested before adding anything else.
3. **Windows selection** — if "I'm in," present the 7×6 window grid (button pagination or multi-step select — prototype both and pick whichever is less clunky in Discord's component constraints) and write `AvailabilitySlot` rows.
4. **Capacity + vibe** — simple button selects for session count (1/2/3/4+) and vibe tags (6-8 curated options), writing to `WeeklyResponse.sessions_committed` and `VibeTag`.
5. **Overlap computation + posting** — per-slot headcount weighted by remaining capacity, ranked, top 2-3 windows posted to the group channel as a leaderboard-style message.
6. **Status roster + buzz** — `/status` (or auto-post) lists responded vs. not-responded by name only. `[Buzz]` button next to each non-responder, disabled/unavailable for anyone already responded, calling `DiscordDMNotifier` through the shared `notify()` interface with the daily rate limit enforced.
7. **(Stage 2, do not start yet)** Steam OAuth, library sync, vibe-filtered shared-game matching, game nomination with Steam Store API price/link lookup, `TwilioSMSNotifier`.

## Conventions
- Keep commits scoped to one build-order step at a time.
- Every place that would touch the Discord API directly for user notification should instead call the shared notifier interface — flag it in review if this is violated.
- Favor Discord native components (buttons, select menus) over any free-text input except explicit `/propose [game]` nominations.
