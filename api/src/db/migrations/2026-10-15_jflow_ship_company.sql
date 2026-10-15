-- JFlow — a company chosen in JFlow for a stock payment shipping gives none (Dev, 2026-10-15;
-- api/docs/CONTRACT.md §3.4, §3.5, §10.11a).
--
--   external_items.assigned_company_id   a JFlow company id, set by a user on one ship row
--                                        (PUT /external-items/:key/company). Read only while
--                                        the row's shipping_company_id is NULL: shipping's
--                                        company always wins once it has one. Never written
--                                        by the refresh, never hashed (not a feed column).
--   company_set_by / company_set_at      who chose it, and when (UTC).
--
-- Applied by tools/migrate.js on every stage and replayed by local ensureSchema; sorts after
-- the scenario-adds file. The statement sits behind its information_schema guard (CONTRACT
-- §3.1), so a replay against a migrated schema changes nothing. No foreign keys.

SET @ship_company_missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'external_items' AND COLUMN_NAME = 'assigned_company_id');
SET @ddl := IF(@ship_company_missing = 1,
  'ALTER TABLE external_items ADD COLUMN assigned_company_id BIGINT UNSIGNED NULL AFTER planned_at, ADD COLUMN company_set_by VARCHAR(255) NULL AFTER assigned_company_id, ADD COLUMN company_set_at DATETIME NULL AFTER company_set_by',
  'SELECT 1');
PREPARE ship_company_stmt1 FROM @ddl;
EXECUTE ship_company_stmt1;
DEALLOCATE PREPARE ship_company_stmt1;
