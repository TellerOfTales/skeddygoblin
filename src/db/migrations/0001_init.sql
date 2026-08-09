-- ===========================================================================
-- Skeddy Goblin initial schema
--
-- The 11 tables from CLAUDE.md's data model, in that shape, plus four additive
-- support tables. Each addition is justified inline; none alters a relationship
-- between the 11.
--
-- RESERVED WORDS: user, group and window are all reserved in PostgreSQL.
-- Tables become app_user / app_group. The `window` column keeps the brief's
-- name and is written "window" -- double-quoted -- in EVERY statement that
-- references it. An unquoted occurrence is a syntax error, which is why all SQL
-- lives in src/db/repositories/ with integration coverage.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Enum types
--
-- Native enums for the genuinely closed structural sets: they self-document in
-- the DDL, arrive over `pg` as plain strings, and ALTER TYPE ... ADD VALUE is
-- exactly the "extend, don't restructure" motion needed when a second notifier
-- channel lands.
-- ---------------------------------------------------------------------------

-- Declared CHRONOLOGICALLY so `ORDER BY "window"` is chronological for free.
CREATE TYPE availability_window AS ENUM (
  'morning', 'lunch', 'afternoon', 'evening', 'night', 'late_night'
);

-- Stage 1 has exactly one delivery channel. 'sms' is added by a later
-- migration when TwilioSMSNotifier is real.
CREATE TYPE preferred_channel AS ENUM ('discord_dm');

CREATE TYPE membership_role AS ENUM ('member', 'organizer');

-- Both values are TERMINAL. There is deliberately no 'in_progress': the
-- existence of a weekly_response row is exactly what makes a member
-- un-buzzable, so a half-finished questionnaire must not create one. Draft
-- state lives in response_draft instead.
CREATE TYPE weekly_response_status AS ENUM ('opted_out', 'submitted');

CREATE TYPE proposal_status AS ENUM ('proposed', 'voting', 'confirmed', 'cancelled');

CREATE TYPE attendance_response AS ENUM ('yes', 'maybe', 'no');

CREATE TYPE buzz_status AS ENUM ('pending', 'sent', 'failed');


-- ---------------------------------------------------------------------------
-- 1. User
-- ---------------------------------------------------------------------------
CREATE TABLE app_user (
  id                bigserial PRIMARY KEY,
  discord_id        text NOT NULL UNIQUE,
  steam_id          text NULL,                       -- Stage 2
  steam_public      boolean NOT NULL DEFAULT false,  -- Stage 2
  -- IANA zone. Stored because the data model requires it, but NEVER used to
  -- translate day/window buckets -- see src/domain/week.ts. Display only.
  timezone          text NOT NULL DEFAULT 'UTC',
  preferred_channel preferred_channel NOT NULL DEFAULT 'discord_dm',
  -- ADDITIVE: reserved now so enabling an SMS notifier later is configuration
  -- rather than a migration plus a backfill.
  phone_e164        text NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------------
-- 2. Group
-- ---------------------------------------------------------------------------
CREATE TABLE app_group (
  id                  bigserial PRIMARY KEY,
  discord_guild_id    text NOT NULL UNIQUE,
  name                text NOT NULL,
  -- ADDITIVE, and mandatory: nudge_cutoff_time is a bare time. Without a zone
  -- to interpret it in, the scheduler literally cannot decide when to fire.
  -- This is also the canonical zone for every day/window bucket in the group.
  timezone            text NOT NULL DEFAULT 'UTC',
  -- ADDITIVE: where the roster and leaderboard get posted.
  announce_channel_id text NULL,
  nudge_cutoff_day    smallint NOT NULL DEFAULT 3    -- 0=Mon .. 6=Sun; Thursday
                      CHECK (nudge_cutoff_day BETWEEN 0 AND 6),
  nudge_cutoff_time   time NOT NULL DEFAULT '20:00', -- in app_group.timezone
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------------
-- 3. GroupMembership
-- ---------------------------------------------------------------------------
CREATE TABLE group_membership (
  user_id   bigint NOT NULL REFERENCES app_user(id)  ON DELETE CASCADE,
  group_id  bigint NOT NULL REFERENCES app_group(id) ON DELETE CASCADE,
  role      membership_role NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, group_id)
);

CREATE INDEX group_membership_group_idx ON group_membership (group_id);


-- ---------------------------------------------------------------------------
-- 4. WeeklyResponse
-- ---------------------------------------------------------------------------
CREATE TABLE weekly_response (
  id                 bigserial PRIMARY KEY,
  user_id            bigint NOT NULL REFERENCES app_user(id)  ON DELETE CASCADE,
  group_id           bigint NOT NULL REFERENCES app_group(id) ON DELETE CASCADE,
  week_start_date    date NOT NULL,
  status             weekly_response_status NOT NULL,
  -- 4 means "4 or more", not exactly four. Every consumer clamps to 4.
  sessions_committed smallint NOT NULL DEFAULT 0
                     CHECK (sessions_committed BETWEEN 0 AND 4),
  submitted_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT weekly_response_uniq UNIQUE (user_id, group_id, week_start_date),
  -- Opting out is a single tap with no follow-up questions, so it can never
  -- carry a capacity.
  CONSTRAINT optout_has_no_capacity
    CHECK (status <> 'opted_out' OR sessions_committed = 0)
);

-- Drives the status roster and the responder set for the overlap query.
CREATE INDEX weekly_response_group_week_idx
  ON weekly_response (group_id, week_start_date, status);

-- Target of availability_slot's and vibe_tag's composite FKs.
CREATE UNIQUE INDEX weekly_response_natural_key_idx
  ON weekly_response (user_id, group_id, week_start_date);


-- ---------------------------------------------------------------------------
-- 5. AvailabilitySlot
--
-- The composite FK is load-bearing: it makes it impossible for slot rows to
-- exist without a submitted response, so a half-finished questionnaire can
-- never contribute to the overlap computation.
-- ---------------------------------------------------------------------------
CREATE TABLE availability_slot (
  user_id         bigint NOT NULL,
  group_id        bigint NOT NULL,
  week_start_date date NOT NULL,
  day_of_week     smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=Mon
  "window"        availability_window NOT NULL,

  -- PK rather than a surrogate id: makes slot writes naturally idempotent, so
  -- re-running the weekly flow cannot duplicate rows.
  PRIMARY KEY (user_id, group_id, week_start_date, day_of_week, "window"),

  FOREIGN KEY (user_id, group_id, week_start_date)
    REFERENCES weekly_response (user_id, group_id, week_start_date) ON DELETE CASCADE
);

-- Drives the overlap aggregate (group+week scan grouped by slot).
CREATE INDEX availability_slot_group_week_slot_idx
  ON availability_slot (group_id, week_start_date, day_of_week, "window");


-- ---------------------------------------------------------------------------
-- 6. VibeTag
-- ---------------------------------------------------------------------------
CREATE TABLE vibe_tag (
  id              bigserial PRIMARY KEY,
  user_id         bigint NOT NULL,
  group_id        bigint NOT NULL,
  week_start_date date NOT NULL,
  -- CHECK rather than an enum: the brief says this curated set will be tuned,
  -- and a CHECK is a one-line migration to change. Mirrors VIBE_TAGS in
  -- src/domain/constants.ts.
  tag             text NOT NULL CHECK (tag IN (
                    'chill', 'competitive', 'co_op_story', 'chaos',
                    'sweaty', 'something_new', 'old_favorite', 'low_mic'
                  )),

  CONSTRAINT vibe_tag_uniq UNIQUE (user_id, group_id, week_start_date, tag),

  FOREIGN KEY (user_id, group_id, week_start_date)
    REFERENCES weekly_response (user_id, group_id, week_start_date) ON DELETE CASCADE
);

CREATE INDEX vibe_tag_group_week_idx ON vibe_tag (group_id, week_start_date, tag);


-- ---------------------------------------------------------------------------
-- 7. SteamLibraryCache  -- created, DORMANT until Stage 2
-- ---------------------------------------------------------------------------
CREATE TABLE steam_library_cache (
  user_id        bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  app_id         integer NOT NULL,
  game_name      text NOT NULL,
  multiplayer    boolean NOT NULL DEFAULT false,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, app_id)
);

CREATE INDEX steam_library_cache_app_idx ON steam_library_cache (app_id);

-- ADDITIVE (Stage 2): shared, per-app metadata cache.
-- steam_library_cache is per-user by design, but game metadata is not
-- user-specific. Eight members owning the same game must cost one Store API
-- call, not eight -- the Steam Store endpoint is rate-limited at roughly 200
-- requests per 5 minutes, so this cache is what makes library sync viable.
CREATE TABLE steam_app_meta (
  app_id      integer PRIMARY KEY,
  name        text NOT NULL,
  categories  text[] NOT NULL DEFAULT '{}',
  genres      text[] NOT NULL DEFAULT '{}',
  multiplayer boolean NOT NULL DEFAULT false,
  price_cents integer NULL,
  currency    text NULL,
  store_url   text NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------------
-- 8. SessionProposal
-- ---------------------------------------------------------------------------
CREATE TABLE session_proposal (
  id               bigserial PRIMARY KEY,
  group_id         bigint NOT NULL REFERENCES app_group(id) ON DELETE CASCADE,
  -- ADDITIVE: remaining-capacity in the overlap query counts a member's
  -- confirmed sessions *this week*, so a proposal must know its week.
  week_start_date  date NOT NULL,
  candidate_day    smallint NOT NULL CHECK (candidate_day BETWEEN 0 AND 6),
  candidate_window availability_window NOT NULL,
  status           proposal_status NOT NULL DEFAULT 'proposed',
  -- ADDITIVE: the public RSVP message, so counts can be edited in place.
  message_id       text NULL,
  created_by       bigint NULL REFERENCES app_user(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT session_proposal_slot_uniq
    UNIQUE (group_id, week_start_date, candidate_day, candidate_window)
);

CREATE INDEX session_proposal_group_week_idx
  ON session_proposal (group_id, week_start_date, status);


-- ---------------------------------------------------------------------------
-- 9. SessionAttendance
-- ---------------------------------------------------------------------------
CREATE TABLE session_attendance (
  proposal_id  bigint NOT NULL REFERENCES session_proposal(id) ON DELETE CASCADE,
  user_id      bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  response     attendance_response NOT NULL,
  responded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, user_id)
);

CREATE INDEX session_attendance_user_idx ON session_attendance (user_id, response);


-- ---------------------------------------------------------------------------
-- 10. GameVote  -- created, DORMANT until Stage 2
-- ---------------------------------------------------------------------------
CREATE TABLE game_vote (
  id           bigserial PRIMARY KEY,
  proposal_id  bigint NOT NULL REFERENCES session_proposal(id) ON DELETE CASCADE,
  app_id       integer NULL,
  game_name    text NOT NULL,
  nominated_by bigint NULL REFERENCES app_user(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_vote_uniq UNIQUE (proposal_id, game_name)
);


-- ---------------------------------------------------------------------------
-- 11. GameVoteCast  -- created, DORMANT until Stage 2
-- ---------------------------------------------------------------------------
CREATE TABLE game_vote_cast (
  vote_id bigint NOT NULL REFERENCES game_vote(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES app_user(id)  ON DELETE CASCADE,
  cast_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vote_id, user_id)
);


-- ===========================================================================
-- ADDITIVE SUPPORT TABLES
--
-- Each exists because a requirement in the brief is otherwise unimplementable.
-- None of them alters a relationship between the 11 tables above.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- response_draft
--
-- The weekly questionnaire is multi-step, so it needs resumable state. It
-- deliberately does NOT live on weekly_response as an 'in_progress' status:
-- that row's existence is precisely what makes a member un-buzzable, so a
-- half-finished questionnaire would make someone immune to buzzing -- inverting
-- the brief's own rule.
--
-- Keeping the draft separate also means availability_slot's composite FK keeps
-- partial answers out of the overlap query for free.
-- ---------------------------------------------------------------------------
CREATE TABLE response_draft (
  id              bigserial PRIMARY KEY,
  user_id         bigint NOT NULL REFERENCES app_user(id)  ON DELETE CASCADE,
  group_id        bigint NOT NULL REFERENCES app_group(id) ON DELETE CASCADE,
  -- Captured at flow start and never recomputed, so a flow that starts at 23:58
  -- Sunday and finishes at 00:03 Monday still writes one consistent week.
  week_start_date date NOT NULL,
  -- { days: [0,2,4], windows: { "0": ["evening"] }, capacity: 3, vibes: [...] }
  state           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT response_draft_uniq UNIQUE (user_id, group_id, week_start_date)
);

CREATE INDEX response_draft_stale_idx ON response_draft (updated_at);


-- ---------------------------------------------------------------------------
-- buzz_log
--
-- "Max one buzz per person per day" is a stateful temporal rule and is
-- derivable from none of the 11 tables -- weekly_response records outcomes, not
-- attempts. This also becomes the delivery audit trail, which is wanted anyway
-- the moment a notifier starts costing money per message.
-- ---------------------------------------------------------------------------
CREATE TABLE buzz_log (
  id              bigserial PRIMARY KEY,
  group_id        bigint NOT NULL REFERENCES app_group(id) ON DELETE CASCADE,
  actor_user_id   bigint NOT NULL REFERENCES app_user(id)  ON DELETE CASCADE,
  target_user_id  bigint NOT NULL REFERENCES app_user(id)  ON DELETE CASCADE,
  week_start_date date NOT NULL,
  -- Calendar day in app_group.timezone, not UTC.
  buzz_date       date NOT NULL,
  status          buzz_status NOT NULL DEFAULT 'pending',
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT buzz_not_self CHECK (actor_user_id <> target_user_id)
);

-- THE rate limit, enforced by the database rather than by a read-then-write
-- check, so two simultaneous buzz presses resolve to exactly one DM.
--
-- Scope is per TARGET per day, across all senders and all groups: the rule
-- protects a human from being pestered, and five people buzzing at once is
-- still five buzzes.
--
-- Partial on status <> 'failed' so an undeliverable DM (closed DMs, no mutual
-- guild) does not burn the target's daily quota.
CREATE UNIQUE INDEX buzz_log_daily_uniq
  ON buzz_log (target_user_id, buzz_date)
  WHERE status <> 'failed';

CREATE INDEX buzz_log_pending_idx ON buzz_log (status, created_at)
  WHERE status = 'pending';


-- ---------------------------------------------------------------------------
-- job_run
--
-- The primary key IS the scheduler lock: an INSERT ... ON CONFLICT DO NOTHING
-- that returns a row means this process won the race and should run the job.
-- That keeps the design correct even if the single-instance assumption is
-- violated -- no double-posted leaderboards, no double weekly prompts.
-- ---------------------------------------------------------------------------
CREATE TABLE job_run (
  group_id        bigint NOT NULL REFERENCES app_group(id) ON DELETE CASCADE,
  job_kind        text NOT NULL,
  week_start_date date NOT NULL,
  ran_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, job_kind, week_start_date)
);


-- ---------------------------------------------------------------------------
-- steam_link_state  -- Stage 2
--
-- One-time, short-lived tokens for the Steam OpenID round trip. Separate from
-- app_user so an abandoned link attempt leaves no trace on the user record.
-- ---------------------------------------------------------------------------
CREATE TABLE steam_link_state (
  state      text PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz NULL
);
