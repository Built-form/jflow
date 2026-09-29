-- JFlow — core schema (api/docs/CONTRACT.md §3).
--
-- The ONE source of DDL: tools/migrate.js applies it on every stage (deploy.sh runs the
-- migration before packaging) and src/lib/schema.js replays it locally (IS_LOCAL only).
-- The deployed Lambda never runs DDL.
--
-- Every statement is idempotent: CREATE TABLE IF NOT EXISTS, plus the company seed
-- guarded by WHERE NOT EXISTS. No foreign keys, no MySQL ENUMs (VARCHAR validated in
-- code). All DATETIME columns are UTC.
--
-- `schema_migrations` is created by tools/migrate.js itself, so a fully migrated schema
-- holds 15 tables: the 14 below plus that one.
--
-- EDITABLE UNTIL THE FIRST REAL DEPLOY: nothing depends on this database yet, so
-- correcting a column means editing this file, deleting its schema_migrations row and
-- re-running `npm run migrate` — not stacking ALTER migrations on top. After step 11,
-- later files use the information_schema guard pattern (workflows 2026-09-08_stages.sql).

-- ── Platform (as workflows) ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jflow_schema_meta (
  k VARCHAR(64) NOT NULL PRIMARY KEY, v VARCHAR(64) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS allowed_emails (
  email VARCHAR(255) NOT NULL PRIMARY KEY,
  type  VARCHAR(32) NOT NULL DEFAULT 'standard',           -- standard | admin (D5)
  display_name VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(64) NOT NULL,                        -- CONTRACT §2.8
  entity_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(32) NOT NULL,
  before_json JSON NULL, after_json JSON NULL,
  reason VARCHAR(500) NULL,                                -- reserved, unused in phase 1
  user_email VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_entity (entity_type, entity_id), KEY idx_created (created_at)
) DEFAULT CHARSET=utf8mb4;

-- ── Reference data ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS companies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(16) NOT NULL,                               -- ^[A-Z0-9_]{1,16}$, unique among live rows (code-enforced)
  name VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  KEY idx_code (code), KEY idx_deleted (deleted_at)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bank_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  currency CHAR(3) NOT NULL,                               -- ^[A-Z]{3}$
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_default TINYINT(1) NOT NULL DEFAULT 0,                -- at most one per company (D16)
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  KEY idx_company (company_id, deleted_at), KEY idx_deleted (deleted_at)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bank_balances (                 -- HARD delete
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  balance_date DATE NOT NULL,                              -- <= today on write
  balance DECIMAL(14,2) NOT NULL,                          -- cash at bank at the START of balance_date
  note VARCHAR(500) NULL,
  entered_by VARCHAR(255) NULL,
  row_version INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_account_date (account_id, balance_date)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS fx_rates (                      -- HARD delete
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  currency CHAR(3) NOT NULL,                               -- never GBP (D3)
  rate_to_gbp DECIMAL(12,6) NOT NULL,                      -- 1 unit of currency = rate_to_gbp GBP
  effective_from DATE NOT NULL,
  note VARCHAR(500) NULL,
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_currency_from (currency, effective_from)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  direction VARCHAR(8) NOT NULL,                           -- in | out
  sort_order INT NOT NULL DEFAULT 0,
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  KEY idx_deleted (deleted_at)
) DEFAULT CHARSET=utf8mb4;

-- ── Items, schedules, overrides, payments ────────────────────────────────────
-- Company is derived through the account on both items and schedules.

CREATE TABLE IF NOT EXISTS cash_items (                    -- one-offs
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  direction VARCHAR(8) NOT NULL,                           -- in | out, equals the category's
  name VARCHAR(255) NOT NULL,
  counterparty VARCHAR(255) NULL,
  amount DECIMAL(14,2) NOT NULL,                           -- > 0
  currency CHAR(3) NOT NULL,                               -- defaults to the account's
  due_date DATE NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'expected',          -- expected | part_paid | paid | skipped
  paid_on DATE NULL,                                       -- cache: MAX(payments.paid_on) (D23)
  paid_amount DECIMAL(14,2) NULL,                          -- cache: SUM(payments.amount)
  settle_mode VARCHAR(8) NOT NULL DEFAULT 'auto',          -- auto | manual
  notes TEXT NULL,
  source_scenario_id BIGINT UNSIGNED NULL,                 -- stamped by scenario apply
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  KEY idx_account_status_due (account_id, status, due_date),
  KEY idx_status_due (status, due_date),
  KEY idx_paid_on (paid_on),
  KEY idx_category (category_id),
  KEY idx_deleted (deleted_at)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS schedules (                     -- recurring rules
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  direction VARCHAR(8) NOT NULL,                           -- in | out
  name VARCHAR(255) NOT NULL,
  counterparty VARCHAR(255) NULL,
  amount DECIMAL(14,2) NOT NULL,                           -- > 0
  currency CHAR(3) NOT NULL,
  frequency VARCHAR(16) NOT NULL,                          -- weekly | fortnightly | four_weekly | monthly | quarterly | annually
  interval_count INT NOT NULL DEFAULT 1,                   -- >= 1
  start_date DATE NOT NULL,                                -- occurrence 0; n always counts from here (§5.1)
  active_from DATE NULL,                                   -- natural dates before it belong to the predecessor; NULL = from start_date (D21)
  occurrence_count INT NULL,                               -- >= 1; NULL = open-ended (D22: not with end_date)
  end_date DATE NULL,                                      -- last natural date allowed
  weekend_rule VARCHAR(8) NOT NULL DEFAULT 'none',         -- none | previous | next
  settle_mode VARCHAR(8) NOT NULL DEFAULT 'auto',          -- auto | manual
  predecessor_id BIGINT UNSIGNED NULL,                     -- the schedule this one was split from
  status VARCHAR(16) NOT NULL DEFAULT 'active',            -- active | ended
  notes TEXT NULL,
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  KEY idx_account_status (account_id, status),
  KEY idx_predecessor (predecessor_id),
  KEY idx_category (category_id),
  KEY idx_deleted (deleted_at)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS schedule_overrides (            -- one per tuned instance; HARD delete = revert
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  schedule_id BIGINT UNSIGNED NOT NULL,
  natural_date DATE NOT NULL,                              -- the instance identity (unadjusted date)
  amount DECIMAL(14,2) NULL,                               -- NULL = the schedule amount
  due_date DATE NULL,                                      -- NULL = weekend-adjusted natural date; set = verbatim
  status VARCHAR(16) NULL,                                 -- NULL = expected | expected | part_paid | paid | skipped
  settle_mode VARCHAR(8) NULL,                             -- NULL = the schedule settle mode | auto | manual
  paid_on DATE NULL,                                       -- cache: MAX(payments.paid_on) (D23)
  paid_amount DECIMAL(14,2) NULL,                          -- cache: SUM(payments.amount)
  note VARCHAR(500) NULL,
  source_scenario_id BIGINT UNSIGNED NULL,
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_schedule_natural (schedule_id, natural_date),
  KEY idx_status (status)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payments (                      -- one row per payment; HARD delete by unpay only
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  cash_item_id BIGINT UNSIGNED NULL,                       -- exactly one of cash_item_id / override_id (code-validated)
  override_id BIGINT UNSIGNED NULL,
  paid_on DATE NOT NULL,                                   -- <= today at write
  amount DECIMAL(14,2) NOT NULL,                           -- > 0
  note VARCHAR(500) NULL,
  created_by VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cash_item (cash_item_id),
  KEY idx_override (override_id),
  KEY idx_paid_on (paid_on)
) DEFAULT CHARSET=utf8mb4;

-- ── Scenarios ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scenarios (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  company_id BIGINT UNSIGNED NULL,                         -- view scope hint (D20); NULL = all
  status VARCHAR(16) NOT NULL DEFAULT 'draft',             -- draft | applied | archived
  applied_at DATETIME NULL,
  applied_by VARCHAR(255) NULL,
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  KEY idx_status (status, deleted_at), KEY idx_company (company_id)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scenario_adjustments (          -- HARD delete while the scenario is draft; immutable after
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  scenario_id BIGINT UNSIGNED NOT NULL,
  item_key VARCHAR(80) NOT NULL,                           -- CONTRACT §4, verbatim
  target_kind VARCHAR(8) NOT NULL,                         -- item | sched | ship
  target_id VARCHAR(64) NOT NULL,                          -- parsed id (D32)
  target_date DATE NULL,                                   -- natural date for sched, else NULL
  kind VARCHAR(8) NOT NULL,                                -- adjust | exclude
  new_date DATE NULL,                                      -- adjust: >= today at write
  new_amount DECIMAL(14,2) NULL,                           -- adjust: > 0
  base_date DATE NOT NULL,                                 -- target effective date at write / rebase
  base_amount DECIMAL(14,2) NOT NULL,                      -- target effective amount at write / rebase
  note VARCHAR(500) NULL,
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_scenario_key (scenario_id, item_key),
  KEY idx_target (target_kind, target_id)
) DEFAULT CHARSET=utf8mb4;

-- ── Seed (D26, confirmed by Dev 2026-09-29) ──────────────────────────────────

INSERT INTO companies (code, name, sort_order)
SELECT 'JFA', 'JFA', 1 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM companies WHERE code = 'JFA');

INSERT INTO companies (code, name, sort_order)
SELECT 'HW', 'Hangerworld', 2 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM companies WHERE code = 'HW');
