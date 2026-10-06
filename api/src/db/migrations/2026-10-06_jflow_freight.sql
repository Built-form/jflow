-- JFlow — Phase 2: the re-pin to ShipLine 77577a1 (handover doc section 7; Dev's decisions of
-- 2026-10-06 on its open question 4; api/docs/CONTRACT.md §3.5, P10).
--
--   external_items.label   a FEED column (hashed, written by the refresh only): what a row is
--                          when it is not a PO's goods — an extra's kind ("Mould cost",
--                          "Freight"), "PO charges", "Top-up", "QC units <code>"; NULL for goods.
--   "Freight and forwarders"   a second system category (system_key 'freight'): a forwarder's
--                          cost of the shipment itself (feed kind 'extra', flag shipment_cost)
--                          is paid to its own payee, so it does not sit with the supplier's
--                          stock payments. The engine falls back to "Stock payments" when it is
--                          missing. Refuses delete and direction change like the 'ship' one.
--
-- Applied by tools/migrate.js on every stage and replayed by local ensureSchema; sorts after
-- the due-set file. Each statement is idempotent (CONTRACT §3.1). No foreign keys.

SET @label_missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'external_items' AND COLUMN_NAME = 'label');
SET @ddl := IF(@label_missing = 1,
  'ALTER TABLE external_items ADD COLUMN label VARCHAR(255) NULL AFTER due_set_json',
  'SELECT 1');
PREPARE freight_stmt1 FROM @ddl;
EXECUTE freight_stmt1;
DEALLOCATE PREPARE freight_stmt1;

INSERT INTO categories (name, direction, sort_order, system_key)
SELECT 'Freight and forwarders', 'out', 910, 'freight' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE system_key = 'freight');
