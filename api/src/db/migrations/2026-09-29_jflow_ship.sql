-- JFlow — Phase 2: stock payments (api/docs/CONTRACT.md §3.5; docs/PHASE2.md §4.2).
--
-- The shipping feed snapshot (external_items), its one-row-per-source sync record
-- (external_sync), companies.shipping_company_id (§4.9) and categories.system_key with the
-- "Stock payments" system category (P10).
--
-- Applied by tools/migrate.js on every stage and replayed by local ensureSchema, exactly
-- like the core file; it sorts after it. Every statement is idempotent: CREATE TABLE IF NOT
-- EXISTS, seeds guarded by WHERE NOT EXISTS, and each ALTER behind the information_schema
-- guard (workflows 2026-09-08_stages.sql), so a replay over a migrated schema changes
-- nothing and never leans on the runner's "already done" tolerance. A second
-- `npm run migrate` applies 0 files.
--
-- Feed columns are written by services/shippingRefresh.js only; overlay columns by a user
-- edit or scenario apply only (§10.11, §10.9). No foreign keys; DATETIME is UTC.

CREATE TABLE IF NOT EXISTS external_items (              -- feed snapshot; rows never deleted
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source VARCHAR(8) NOT NULL, ext_id VARCHAR(64) NOT NULL,  -- 'ship'; key = ship.<ext_id> (§4)
  -- feed columns: written by the refresh only
  feed_kind VARCHAR(8) NOT NULL, feed_status VARCHAR(8) NOT NULL,     -- deposit | balance; open | paid
  supplier VARCHAR(255) NULL, shipping_company_id BIGINT UNSIGNED NULL,
  po_id BIGINT UNSIGNED NULL, po_number VARCHAR(64) NULL,
  shipment_id BIGINT UNSIGNED NULL, container_ref VARCHAR(100) NULL,
  currency CHAR(3) NOT NULL, amount DECIMAL(14,2) NOT NULL,           -- open: still owed; paid: this payment
  due_date DATE NULL, paid_on DATE NULL, settles VARCHAR(64) NULL,    -- settles = the open row's ext_id
  date_basis VARCHAR(12) NOT NULL, amount_basis VARCHAR(8) NOT NULL,  -- firm | estimated | undated; stated | derived
  blocked VARCHAR(16) NULL, flags_json JSON NULL,                     -- blocked: shipment | artwork | pi | pi_signed
  feed_hash CHAR(64) NOT NULL,                           -- sha256 of the feed columns
  gone_at DATETIME NULL,                                 -- left the feed; kept for overlays and adjustments
  -- overlay: written by user edit or scenario apply only, never by the refresh
  planned_date DATE NULL, planned_amount DECIMAL(14,2) NULL,
  planned_skipped TINYINT(1) NOT NULL DEFAULT 0,         -- P7
  planned_base_amount DECIMAL(14,2) NULL,                -- feed amount when planned_amount was set (P6)
  planned_note VARCHAR(500) NULL, source_scenario_id BIGINT UNSIGNED NULL,
  planned_by VARCHAR(255) NULL, planned_at DATETIME NULL,
  row_version INT NOT NULL DEFAULT 0, created_by VARCHAR(255) NULL,  -- 'shipping-feed'
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_source_ext (source, ext_id),
  KEY idx_status_due (source, feed_status, due_date), KEY idx_paid_on (paid_on), KEY idx_gone (gone_at)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS external_sync (                -- one row per source; meta, outside §2.9
  source VARCHAR(8) NOT NULL PRIMARY KEY,
  last_attempt_at DATETIME NULL, last_success_at DATETIME NULL, feed_today DATE NULL,
  last_error VARCHAR(500) NULL, item_count INT NOT NULL DEFAULT 0, rejected_count INT NOT NULL DEFAULT 0,
  companies_json JSON NULL,                              -- feed companies[], for the Settings picker
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) DEFAULT CHARSET=utf8mb4;
INSERT INTO external_sync (source)
SELECT 'ship' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM external_sync WHERE source = 'ship');

SET @ship_company_missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'shipping_company_id');
SET @ddl := IF(@ship_company_missing = 1,
  'ALTER TABLE companies ADD COLUMN shipping_company_id BIGINT UNSIGNED NULL AFTER sort_order, ADD KEY idx_shipping_company (shipping_company_id)',
  'SELECT 1');
PREPARE ship_stmt1 FROM @ddl;
EXECUTE ship_stmt1;
DEALLOCATE PREPARE ship_stmt1;

SET @ship_syskey_missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'categories' AND COLUMN_NAME = 'system_key');
SET @ddl := IF(@ship_syskey_missing = 1,
  'ALTER TABLE categories ADD COLUMN system_key VARCHAR(16) NULL AFTER sort_order, ADD KEY idx_system_key (system_key)',
  'SELECT 1');
PREPARE ship_stmt2 FROM @ddl;
EXECUTE ship_stmt2;
DEALLOCATE PREPARE ship_stmt2;

INSERT INTO categories (name, direction, sort_order, system_key)
SELECT 'Stock payments', 'out', 900, 'ship' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE system_key = 'ship');
