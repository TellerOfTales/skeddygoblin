-- ===========================================================================
-- A wider vibe vocabulary.
--
-- Eight tags was too coarse to describe a week: "Action" covered a horror
-- co-op survival game and a racing sim equally badly, and the matcher can only
-- be as good as the vocabulary it is given.
--
-- Every value is still a real Steam genre or category, so matching stays exact
-- membership against what the API actually returns - no translation layer, and
-- nothing to drift. That constraint is what keeps this honest: a tag nobody
-- can match is worse than no tag.
-- ===========================================================================

ALTER TABLE vibe_tag DROP CONSTRAINT IF EXISTS vibe_tag_tag_check;

-- Purely additive: every previously valid tag is still valid, so nothing is
-- deleted and no week's answers are lost.
ALTER TABLE vibe_tag ADD CONSTRAINT vibe_tag_tag_check CHECK (tag IN (
  'Co-op', 'Online Co-op', 'Online PvP', 'Action', 'Adventure',
  'Strategy', 'RPG', 'Simulation', 'Racing', 'Sports',
  'Casual', 'Indie', 'Massively Multiplayer', 'Early Access', 'Free To Play',
  'Survival', 'Horror', 'Puzzle', 'Shooter', 'Open World'
));

-- app_user.default_vibes is text[] with no CHECK, so personal templates need no
-- migration - they were never constrained to the narrower list.
