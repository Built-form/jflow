-- JFlow — scenario adds, splits and un-apply (Dev, 2026-10-07; api/docs/CONTRACT.md §3.6,
-- D39–D41).
--
--   base_date, base_amount   relaxed to NULL: an `add` has nothing to compare with (D39).
--   account_id … currency    an `add`'s own one-off — account, category, direction, name,
--                            counterparty, currency; NULL on `adjust` / `exclude` (D39).
--   split_group              the anchor adjustment's id on every row of a split, the anchor's
--                            own id on the anchor; NULL when not in a split (D40).
--   applied_state            what apply wrote, the before image un-apply restores (D41);
--                            NULL while draft; never served (D42).
--   idx_split_group          deleting an anchor deletes its group.
--
-- `target_kind` now also takes `new` (target_id = the row's own id, target_date NULL) and
-- `kind` takes `add`: both VARCHAR enums validated in code, so no DDL.
--
-- Applied by tools/migrate.js on every stage and replayed by local ensureSchema; sorts after
-- the freight file. Each statement sits behind its information_schema guard (CONTRACT §3.1):
-- COLUMNS.IS_NULLABLE for the two relaxed columns, COLUMNS for each new column, STATISTICS
-- for the index — so a replay against a migrated schema changes nothing. No foreign keys.

SET @adds_base_date_strict := (SELECT COUNT(*) > 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scenario_adjustments' AND COLUMN_NAME = 'base_date'
    AND IS_NULLABLE = 'NO');
SET @ddl := IF(@adds_base_date_strict = 1,
  'ALTER TABLE scenario_adjustments MODIFY base_date DATE NULL',
  'SELECT 1');
PREPARE adds_stmt1 FROM @ddl;
EXECUTE adds_stmt1;
DEALLOCATE PREPARE adds_stmt1;

SET @adds_base_amount_strict := (SELECT COUNT(*) > 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scenario_adjustments' AND COLUMN_NAME = 'base_amount'
    AND IS_NULLABLE = 'NO');
SET @ddl := IF(@adds_base_amount_strict = 1,
  'ALTER TABLE scenario_adjustments MODIFY base_amount DECIMAL(14,2) NULL',
  'SELECT 1');
PREPARE adds_stmt2 FROM @ddl;
EXECUTE adds_stmt2;
DEALLOCATE PREPARE adds_stmt2;

SET @adds_account_missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scenario_adjustments' AND COLUMN_NAME = 'account_id');
SET @ddl := IF(@adds_account_missing = 1,
  'ALTER TABLE scenario_adjustments ADD COLUMN account_id BIGINT UNSIGNED NULL AFTER note',
  'SELECT 1');
PREPARE adds_stmt3 FROM @ddl;
EXECUTE adds_stmt3;
DEALLOCATE PREPARE adds_stmt3;

SET @adds_category_missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scenario_adjustments' AND COLUMN_NAME = 'category_id');
SET @ddl := IF(@adds_category_missing = 1,
  'ALTER TABLE scenario_adjustments ADD COLUMN category_id BIGINT UNSIGNED NULL AFTER account_id',
  'SELECT 1');
PREPARE adds_stmt4 FROM @ddl;
EXECUTE adds_stmt4;
DEALLOCATE PREPARE adds_stmt4;

SET @adds_direction_missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scenario_adjustments' AND COLUMN_NAME = 'direction');
SET @ddl := IF(@adds_direction_missing = 1,
  'ALTER TABLE scenario_adjustments ADD COLUMN direction VARCHAR(8) NULL AFTER category_id',
  'SELECT 1');
PREPARE adds_stmt5 FROM @ddl;
EXECUTE adds_stmt5;
DEALLOCATE PREPARE adds_stmt5;

SET @adds_name_missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scenario_adjustments' AND COLUMN_NAME = 'name');
SET @ddl := IF(@adds_name_missing = 1,
  'ALTER TABLE scenario_adjustments ADD COLUMN name VARCHAR(255) NULL AFTER direction',
  'SELECT 1');
PREPARE adds_stmt6 FROM @ddl;
EXECUTE adds_stmt6;
DEALLOCATE PREPARE adds_stmt6;

SET @adds_counterparty_missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scenario_adjustments' AND COLUMN_NAME = 'counterparty');
SET @ddl := IF(@adds_counterparty_missing = 1,
  'ALTER TABLE scenario_adjustments ADD COLUMN counterparty VARCHAR(255) NULL AFTER name',
  'SELECT 1');
PREPARE adds_stmt7 FROM @ddl;
EXECUTE adds_stmt7;
DEALLOCATE PREPARE adds_stmt7;

SET @adds_currency_missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scenario_adjustments' AND COLUMN_NAME = 'currency');
SET @ddl := IF(@adds_currency_missing = 1,
  'ALTER TABLE scenario_adjustments ADD COLUMN currency CHAR(3) NULL AFTER counterparty',
  'SELECT 1');
PREPARE adds_stmt8 FROM @ddl;
EXECUTE adds_stmt8;
DEALLOCATE PREPARE adds_stmt8;

SET @adds_split_group_missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scenario_adjustments' AND COLUMN_NAME = 'split_group');
SET @ddl := IF(@adds_split_group_missing = 1,
  'ALTER TABLE scenario_adjustments ADD COLUMN split_group BIGINT UNSIGNED NULL AFTER currency',
  'SELECT 1');
PREPARE adds_stmt9 FROM @ddl;
EXECUTE adds_stmt9;
DEALLOCATE PREPARE adds_stmt9;

SET @adds_applied_state_missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scenario_adjustments' AND COLUMN_NAME = 'applied_state');
SET @ddl := IF(@adds_applied_state_missing = 1,
  'ALTER TABLE scenario_adjustments ADD COLUMN applied_state JSON NULL AFTER split_group',
  'SELECT 1');
PREPARE adds_stmt10 FROM @ddl;
EXECUTE adds_stmt10;
DEALLOCATE PREPARE adds_stmt10;

SET @adds_split_index_missing := (SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scenario_adjustments' AND INDEX_NAME = 'idx_split_group');
SET @ddl := IF(@adds_split_index_missing = 1,
  'ALTER TABLE scenario_adjustments ADD KEY idx_split_group (split_group)',
  'SELECT 1');
PREPARE adds_stmt11 FROM @ddl;
EXECUTE adds_stmt11;
DEALLOCATE PREPARE adds_stmt11;
