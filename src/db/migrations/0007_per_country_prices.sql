-- ===========================================================================
-- Prices become per-storefront, and stop being confused with app facts.
--
-- THE BUG: steam_app_meta is keyed by app_id alone and carries a price, so one
-- row could only hold one country's price. The metadata refresh picked a single
-- country per tick - the lowest group id - so with groups in different
-- countries, everybody saw whichever server signed up first's storefront.
-- Silently, and in their own currency symbol, which is what makes it nasty:
-- a UK group saw "£24.99" that was actually a converted US number.
--
-- THE INSIGHT that also fixes the rate limit: a game's NAME, GENRES,
-- CATEGORIES and multiplayer flag are the same in every country. Only the price
-- differs. Splitting them means the expensive part - facts - is fetched exactly
-- once per app ever, and the per-country work shrinks to just prices for the
-- countries actually in use. At 200 servers across, say, 12 countries, that is
-- one fetch plus twelve rather than 200 competing fetches of everything.
-- ===========================================================================

CREATE TABLE steam_app_price (
  app_id       integer NOT NULL REFERENCES steam_app_meta(app_id) ON DELETE CASCADE,
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  price_cents  integer NULL,
  currency     text NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, country_code)
);

-- Drives "which prices are missing or stale for this country".
CREATE INDEX steam_app_price_country_fetched_idx
  ON steam_app_price (country_code, fetched_at);

-- Carry over what we already have rather than refetching it. price_country
-- records which storefront each cached price actually came from, so this is
-- accurate even for rows written while the bug was live.
INSERT INTO steam_app_price (app_id, country_code, price_cents, currency, fetched_at)
SELECT app_id, COALESCE(price_country, 'US'), price_cents, currency, fetched_at
FROM steam_app_meta
WHERE price_cents IS NOT NULL
ON CONFLICT DO NOTHING;

-- The USD reference price is just the US storefront's row.
INSERT INTO steam_app_price (app_id, country_code, price_cents, currency, fetched_at)
SELECT app_id, 'US', price_cents_usd, 'USD', fetched_at
FROM steam_app_meta
WHERE price_cents_usd IS NOT NULL
ON CONFLICT DO NOTHING;

-- steam_app_meta keeps its price columns for now, unread. Dropping them in the
-- same migration that starts writing elsewhere would leave no way back if the
-- backfill turned out wrong; a later migration can remove them once this has
-- run in production for a week.
COMMENT ON COLUMN steam_app_meta.price_cents IS
  'DEPRECATED: superseded by steam_app_price. Retained for one release.';
COMMENT ON COLUMN steam_app_meta.price_cents_usd IS
  'DEPRECATED: superseded by steam_app_price where country_code = US.';
