-- ===========================================================================
-- Stage 2 groundwork: a second notification channel.
--
-- This is the whole cost of adding SMS at the data layer, which is the point
-- of having had preferred_channel on the user record since day one. No table
-- changes, no backfill, no relationship altered - one enum value.
--
-- ALTER TYPE ... ADD VALUE is allowed inside a transaction from PostgreSQL 12
-- onward, provided the new value is not USED in the same transaction. It is
-- not: nothing selects or inserts 'sms' here.
--
-- The value existing does not make it reachable. config.ts refuses to boot a
-- user onto a channel with no registered notifier, and TwilioSMSNotifier
-- currently throws NotImplementedError, so switching someone to 'sms' is a
-- deliberate act that fails loudly rather than silently swallowing messages.
-- ===========================================================================

ALTER TYPE preferred_channel ADD VALUE IF NOT EXISTS 'sms';
