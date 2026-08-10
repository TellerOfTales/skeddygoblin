-- ===========================================================================
-- Vibe tags become real Steam vocabulary, and groups get a storefront country.
--
-- Previously the eight vibe tags were invented ('chill', 'sweaty', ...) and a
-- hand-written table mapped each one onto Steam genres and categories. That
-- mapping was guesswork, and guesswork sitting between what a member picked and
-- what they get suggested is the worst place for it.
--
-- Now a vibe IS a Steam term, so matching is exact membership: does this game's
-- genres/categories contain the tag the group picked? No translation layer, and
-- nothing to drift.
--
-- Worth knowing: Steam's USER tags ("Relaxing", "Story Rich") are not returned
-- by the official appdetails endpoint - only `genres` and `categories` are.
-- These values are drawn from those two lists, so every one of them can
-- actually be matched against real API data rather than scraped.
-- ===========================================================================

ALTER TABLE vibe_tag DROP CONSTRAINT IF EXISTS vibe_tag_tag_check;

-- The old invented values cannot satisfy the new constraint. Nothing is in
-- production yet, and a vibe is a single week's mood rather than durable user
-- data, so dropping them is the honest move - members simply pick again next
-- week. If this ever runs against real data, the rows lost are at most one
-- week old.
DELETE FROM vibe_tag
WHERE tag NOT IN (
  'Co-op', 'Online PvP', 'Casual', 'Action',
  'Strategy', 'RPG', 'Simulation', 'Racing'
);

ALTER TABLE vibe_tag ADD CONSTRAINT vibe_tag_tag_check CHECK (tag IN (
  'Co-op', 'Online PvP', 'Casual', 'Action',
  'Strategy', 'RPG', 'Simulation', 'Racing'
));

-- ---------------------------------------------------------------------------
-- Storefront country
--
-- Steam prices are per-country, and the appdetails/storesearch endpoints both
-- take a `cc` parameter. Without one, every group sees US dollars regardless of
-- where they are - so this is the difference between a useful price and a
-- misleading one.
-- ---------------------------------------------------------------------------
ALTER TABLE app_group ADD COLUMN IF NOT EXISTS country_code text NOT NULL DEFAULT 'US';

ALTER TABLE app_group ADD CONSTRAINT app_group_country_code_check
  CHECK (country_code ~ '^[A-Z]{2}$');
