// Copied from shipping/src/lib/shipments.js — changes: only BOOKED_STAGES, isBookedStage, stageRank, laterStage, effectiveStage, iso, dateOnly and rowToShipment; rowToShipment trimmed to the fields ShipLine's containerEvents and shipmentIdByRef read (id, reference, mode, stage, blNumber, ata, departedAt, arrivedAt), key order kept
'use strict';

// The API shape of a shipments row, as GET /api/v1/shipments sends it. Pure.
// The row comes from the effective-stage query (services/shippingReads.js,
// shipping's shipment-sync.js shipmentSelect), which carries derived_stage and
// effective_stage.

const BOOKED_STAGES = ['BOOKED', 'IN_TRANSIT', 'ARRIVED', 'CLOSED'];

function isBookedStage(v) { return BOOKED_STAGES.includes(v); }

// BOOKED < IN_TRANSIT < ARRIVED < CLOSED; anything else ranks 0.
function stageRank(stage) {
    return BOOKED_STAGES.indexOf(stage) + 1;
}

function laterStage(a, b) {
    return stageRank(b) > stageRank(a) ? b : a;
}

// The stage a shipment shows: a booked one never lags what its live members
// say (derived); open and cancelled ones are what they are.
function effectiveStage(stored, derived) {
    if (!isBookedStage(stored)) return stored;
    return laterStage(stored, derived);
}

function iso(v) {
    if (v == null) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    return v;
}

function dateOnly(v) {
    if (v == null) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    return String(v).slice(0, 10);
}

function rowToShipment(row) {
    if (!row) return null;
    const stored = row.stage;
    const derived = row.derived_stage !== undefined ? (row.derived_stage || null) : null;
    const stage = row.effective_stage || effectiveStage(stored, derived);
    return {
        id: row.id,
        reference: row.reference || null,
        mode: row.mode || null,
        stage,
        blNumber: row.bl_number || null,
        ata: dateOnly(row.ata),
        departedAt: iso(row.departed_at),
        arrivedAt: iso(row.arrived_at),
    };
}

module.exports = {
    BOOKED_STAGES,
    isBookedStage,
    effectiveStage,
    iso,
    dateOnly,
    rowToShipment,
};
