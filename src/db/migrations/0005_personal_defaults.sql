-- ===========================================================================
-- Personal availability that spans servers.
--
-- Someone in three guilds answered the same questions three times. This stores
-- one template per person, group-less, that can be projected onto every group
-- they belong to.
--
-- Nothing here is week-scoped, deliberately: a default is not about a week. The
-- projection writes ordinary weekly_response / availability_slot / vibe_tag
-- rows, so every downstream query - overlap, roster, buzz - keeps working with
-- no knowledge that a template was involved.
--
-- TIMEZONE, stated rather than discovered later: day+window labels carry no
-- zone, and windows render as GROUP-local everywhere (see domain/week.ts - that
-- is forced by the no-timestamps rule, not a preference). So "Wednesday
-- evening" applied to two groups in different countries means two different
-- real times. The copy says so. Inventing a conversion here would require the
-- timestamp model the brief rules out.
-- ===========================================================================

CREATE TABLE user_default_slot (
  user_id     bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  -- Quoted, as everywhere: WINDOW is a reserved word in PostgreSQL.
  "window"    availability_window NOT NULL,
  PRIMARY KEY (user_id, day_of_week, "window")
);

ALTER TABLE app_user
  ADD COLUMN default_capacity smallint NULL CHECK (default_capacity BETWEEN 1 AND 4);

ALTER TABLE app_user
  ADD COLUMN default_vibes text[] NOT NULL DEFAULT '{}';

-- The difference between "a template I apply when I feel like it" and "stop
-- asking me, just say yes". The second is what actually saves anyone two
-- minutes a week, so it is a stored preference rather than a per-use choice.
ALTER TABLE app_user
  ADD COLUMN auto_apply_defaults boolean NOT NULL DEFAULT false;
