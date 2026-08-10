-- ===========================================================================
-- A USD reference price alongside the local one.
--
-- Steam prices regionally, and regional prices are not conversions - a game is
-- often materially cheaper or dearer in one storefront than another. So "£24.99
-- ($29.99)" is not redundant: the bracketed figure is the number people have
-- seen quoted everywhere else, which is what makes the local price legible.
--
-- Stored rather than converted at render time, deliberately. Converting would
-- need a live FX rate - a network dependency, a cache, and a staleness problem -
-- and would produce a number Steam never charges anyone. This column holds what
-- the US storefront actually asks.
--
-- Fetched in the same pass as the local price: one extra appdetails call per
-- app, skipped entirely when the group's storefront IS the US one.
-- ===========================================================================

ALTER TABLE steam_app_meta ADD COLUMN IF NOT EXISTS price_cents_usd integer NULL;

-- The storefront the cached local price was fetched from.
--
-- Known limitation, written down rather than hidden: steam_app_meta is keyed by
-- app_id alone, so a single row holds one storefront's price. With groups in
-- different countries the last refresh wins. This column makes that visible -
-- a price row labelled 'GB' being read by a US group is detectable, where
-- previously it was silent. The fix when it matters is a
-- (app_id, country_code) price table; that is a bigger change than this
-- deployment needs today.
ALTER TABLE steam_app_meta ADD COLUMN IF NOT EXISTS price_country text NULL;

-- Existing rows were all fetched from the US storefront (refreshAppMetadata
-- never passed a country), so their price IS the USD price. Backfilling both
-- columns keeps them honest rather than leaving a null that reads as "unknown".
UPDATE steam_app_meta
SET price_cents_usd = price_cents,
    price_country = 'US'
WHERE price_country IS NULL;
