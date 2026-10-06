-- JFlow — Phase 2: dates set by hand in ShipLine (handover doc "JFlow ↔ Payments flow
-- handover", section "Dates set by hand", 2026-10-06; api/docs/CONTRACT.md §3.5).
--
-- Three nullable columns on external_items:
--   due_set_json       a FEED column (hashed, written by the refresh only): the story of a
--                      due date set by hand on ShipLine's Payments flow page —
--                      {by, email, at, derivedDate, scope, note}; NULL when the date is derived.
--   due_date_prev      refresh-owned bookkeeping beside gone_at, not hashed: the due_date the
--   due_date_moved_at  row had before the refresh last moved it, and when (UTC). Written when
--                      an UPDATE changes due_date (a date set or cleared by hand, a derived
--                      date that changed), never when a `from_today` row only slid a day.
--
-- Applied by tools/migrate.js on every stage and replayed by local ensureSchema; sorts after
-- the Phase 2 file. Each ALTER sits behind the information_schema guard (workflows
-- 2026-09-08_stages.sql; CONTRACT §3.1), so a replay changes nothing. No foreign keys.

SET @due_set_missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'external_items' AND COLUMN_NAME = 'due_set_json');
SET @ddl := IF(@due_set_missing = 1,
  'ALTER TABLE external_items ADD COLUMN due_set_json JSON NULL AFTER flags_json',
  'SELECT 1');
PREPARE due_set_stmt1 FROM @ddl;
EXECUTE due_set_stmt1;
DEALLOCATE PREPARE due_set_stmt1;

SET @due_prev_missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'external_items' AND COLUMN_NAME = 'due_date_prev');
SET @ddl := IF(@due_prev_missing = 1,
  'ALTER TABLE external_items ADD COLUMN due_date_prev DATE NULL AFTER gone_at, ADD COLUMN due_date_moved_at DATETIME NULL AFTER due_date_prev',
  'SELECT 1');
PREPARE due_set_stmt2 FROM @ddl;
EXECUTE due_set_stmt2;
DEALLOCATE PREPARE due_set_stmt2;
