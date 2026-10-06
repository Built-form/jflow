// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ f9499bc — changes: today required; dateOfInstant pinned to Europe/London; JSDoc types only (the TS interfaces); new, not in the TS: BalanceClaim / PaymentsFlow.balanceClaims (claims option) and the JFlow feed types (FeedRow, PaidFact)
'use strict';

// JSDoc types for the payments-flow model — the interfaces of ShipLine's
// paymentsFlowMath.ts (f9499bc) and the api.ts / types.ts shapes it reads,
// trimmed to the fields the model touches. Types only; nothing runs here.
// Other modules refer to them as import('./types').Name.

/** @typedef {string} Ymd  'YYYY-MM-DD', compared as a string. */

// ── Inputs ──────────────────────────────────────────────────────────────

/**
 * An order line (api.ts mapOrder). Only the fields the model reads.
 * @typedef {object} Order
 * @property {string} id
 * @property {string} status  OrderStatus, or a server status such as PARTIALLY_RECEIVED.
 * @property {number} quantity
 * @property {number} [receivedQuantity]
 * @property {number} [unitPrice]
 * @property {number} [purchaseOrderId]
 * @property {string} [poNumber]
 * @property {string} [supplier]
 * @property {string} [containerNumber]  Internal ref (= shipment reference); blank = not booked.
 * @property {string} [externalContainerNumber]  Carrier number, the containerIndex key.
 * @property {string} [awbNumber]
 * @property {string} [eta]
 * @property {string} [poDate]
 * @property {string} [orderedDate]
 * @property {string} [artworkConfirmedDate]
 * @property {string} [estimatedReadyDate]
 * @property {string} [shippedDate]
 * @property {string} [estimatedDepartureDate]
 * @property {string} [deliveryDate]
 * @property {string} [arrivedDate]
 */

/**
 * Live carrier tracking (ShipsGo), keyed by container number in containerIndex.
 * @typedef {object} Container
 * @property {string} containerNumber
 * @property {{ departure?: string|null, departureIsActual?: boolean, arrival?: string|null, arrivalIsActual?: boolean, eta?: string|null, ata?: string|null }|null} [times]
 */

/**
 * @typedef {object} PurchaseOrderInvoice  A PI file on the PO.
 * @property {number} id
 * @property {number} purchaseOrderId
 * @property {string} filename
 * @property {string} uploadedAt
 * @property {{ status: 'pending'|'succeeded'|'failed' }|null} [latestCheck]
 */

/**
 * A purchase order with its sub-resources (GET /orders purchaseOrders[id]).
 * @typedef {object} PurchaseOrderBundle
 * @property {number} id
 * @property {string} poNumber
 * @property {string|null} [supplier]
 * @property {string} [currency]
 * @property {number|null} [shippingTotal]
 * @property {number|null} [companyId]
 * @property {string} createdAt
 * @property {PurchaseOrderInvoice[]} invoices
 * @property {{ uploadedAt: string }[]} signedPis
 * @property {{ uploadedAt: string }[]} payments  Proof-of-payment files (no amount).
 */

/**
 * The payment instruction extracted from one PI.
 * @typedef {object} InvoicePayment
 * @property {number} id
 * @property {number} invoiceId
 * @property {number} purchaseOrderId
 * @property {'deposit'|'balance'|'full'|'other'|'unknown'} paymentType
 * @property {number|null} amountDue  The figure to pay now, not the invoice total.
 * @property {string|null} currency
 * @property {number|null} depositPercentage
 * @property {number|null} invoiceTotal
 * @property {string|null} dueDate
 * @property {string|null} dueTerms
 * @property {string|null} rawTermsText
 * @property {'pending'|'arranged'|'paid'|'skipped'} paymentStatus
 * @property {string} updatedAt
 */

/** @typedef {{ id: number, name: string, type: string }} SupplierTag */

/**
 * A JFPRO supplier. Tags matter: 'shipsline-legacy' marks a legacy record.
 * @typedef {object} MintSoftSupplier
 * @property {number} supplierId
 * @property {string} name
 * @property {string|null} [paymentTerms]
 * @property {SupplierTag[]|null} [tags]
 */

/** @typedef {'po'|'pi'|'pi_signed'|'artwork'|'deposit_paid'|'ready'|'etd'|'bl'|'arrival'} EstimateAnchor */
/** @typedef {{ from: EstimateAnchor, days: number }} EstimateStep */
/** @typedef {'sea'|'air'|'road'} FreightMode */

/**
 * Lead times that date an event which has not happened yet (forecast only).
 * @typedef {object} PaymentRuleEstimates
 * @property {EstimateStep|null} artwork
 * @property {EstimateStep|null} pi
 * @property {EstimateStep|null} piSigned
 * @property {EstimateStep|null} ready
 * @property {EstimateStep|null} telex
 * @property {EstimateStep|null} document
 * @property {{ sea: number|null, air: number|null, road: number|null }} transit
 */

/** @typedef {'po_sent'|'artwork_confirmed'|'pi_uploaded'|'pi_signed'} PaymentRuleDepositTrigger */
/** @typedef {'terms'|'before_dispatch'|'bl'|'telex_release'|'container_document'|'arrival'|'delivery'|'invoice'} PaymentRuleBalanceTrigger */

/**
 * A company payment rule (payment_rules): one default plus per-supplier overrides.
 * @typedef {object} PaymentRule
 * @property {number} id
 * @property {'default'|'supplier'} scope
 * @property {string|null} supplierName
 * @property {number|null} depositPct
 * @property {PaymentRuleDepositTrigger|null} depositTrigger
 * @property {number} depositGraceDays
 * @property {number|null} depositOffsetDays
 * @property {PaymentRuleBalanceTrigger|null} balanceTrigger
 * @property {string|null} balanceDocumentType
 * @property {number|null} balanceOffsetDays
 * @property {number} balanceGraceDays
 * @property {PaymentRuleEstimates} estimates
 * @property {string|null} airOwedFrom  Default rule only: air delivered on/after this date stays owed.
 * @property {number|null} airLimitDays
 */

/**
 * What the shipment entity knows about one booked container, keyed by its
 * reference (= the orders' containerNumber). Stage moments are dates here.
 * @typedef {object} ContainerEvents
 * @property {string|null} [stage]  PLANNED · DRAFT · BOOKED · IN_TRANSIT · ARRIVED · CLOSED · CANCELLED
 * @property {string|null} [mode]  SEA · AIR · ROAD
 * @property {Ymd|null} [ata]
 * @property {Ymd|null} [departedAt]
 * @property {Ymd|null} [arrivedAt]
 * @property {string|null} [blNumber]
 * @property {Ymd|null} [telexReleasedAt]
 * @property {{ type: string, attachedAt: Ymd|null }[]} [documents]
 */

/**
 * @typedef {object} ShipmentPaymentAllocation
 * @property {number|null} purchaseOrderId  Null = unresolved, counts as unallocated.
 * @property {string|null} poRef
 * @property {string|null} poNumber
 * @property {number} amount
 */

/**
 * A supplier's balance invoice for one shipment (shipment_payments).
 * @typedef {object} ShipmentPayment
 * @property {number} id
 * @property {number} shipmentId
 * @property {string} shipmentReference
 * @property {string} supplierName
 * @property {number} amount
 * @property {string} currency
 * @property {number|null} depositDeducted
 * @property {'pending'|'arranged'|'paid'|'skipped'} status
 * @property {string|null} paidOn
 * @property {ShipmentPaymentAllocation[]} allocations
 */

/**
 * @typedef {object} ShipmentPaymentDocument
 * @property {number} id
 * @property {string|null} shipmentReference
 * @property {string|null} supplierName
 * @property {string} filename
 * @property {'none'|'processing'|'succeeded'|'failed'} extractStatus
 * @property {string|null} extractError
 */

/**
 * @typedef {object} SupplierPaymentLine
 * @property {number} id
 * @property {'balance'|'pi'|'po_deposit'} kind
 * @property {number} targetId  shipment_payments.id | purchase_order_invoice_payments.id | purchase_orders.id
 * @property {number} amount
 * @property {string|null} shipmentReference
 * @property {number|null} purchaseOrderId
 */

/**
 * One bank transfer to a supplier and what it was applied to.
 * @typedef {object} SupplierPayment
 * @property {number} id
 * @property {string} supplierName
 * @property {number} amount
 * @property {string} currency
 * @property {string} paidOn
 * @property {SupplierPaymentLine[]} lines
 */

/**
 * @typedef {object} PaymentsFlowInput
 * @property {Order[]} orders
 * @property {Record<string, PurchaseOrderBundle>} poBundles
 * @property {InvoicePayment[]} invoicePayments
 * @property {MintSoftSupplier[]} suppliers
 * @property {Map<string, Container>|null} [containerIndex]
 * @property {PaymentRule[]|null} [rules]
 * @property {Map<string, ContainerEvents>|null} [containerEvents]
 * @property {ShipmentPayment[]|null} [shipmentPayments]
 * @property {ShipmentPaymentDocument[]|null} [shipmentPaymentDocuments]
 * @property {SupplierPayment[]|null} [supplierPayments]
 * @property {PaymentDueDate[]|null} [dueOverrides]  Due dates set by hand (ShipLine 6565188; overrides.js): a row key beats its payment's.
 * @property {Ymd} today  Required (the TS read the clock when absent; the port throws).
 */

/**
 * A due date set by hand — one row of shipping's `payment_due_dates` as ShipLine's
 * GET /api/v1/payment-due-dates sends it (lib/shippingCopy/paymentDueDates.js).
 * @typedef {object} PaymentDueDate
 * @property {number} id
 * @property {string} key  `deposit:<po>` | `balance:<CUR>:<CONTAINER>|<supplier>` | `item:<row id>`.
 * @property {'payment'|'item'} scope
 * @property {Ymd} dueDate
 * @property {string|null} note
 * @property {string} setByEmail
 * @property {string|null} setByName
 * @property {string} setAt  ISO instant: the row's updated_at.
 */

/**
 * A due date set by hand, as the row it dates carries it (PaymentItem.dueOverride).
 * @typedef {object} DueOverrideInfo
 * @property {number} id
 * @property {string} key
 * @property {'payment'|'item'} scope  'item': set on this row alone; 'payment': on the whole payment.
 * @property {Ymd} dueDate  The date set (the row's dueDate now).
 * @property {Ymd|null} derivedDueDate  What the model would have said.
 * @property {string} setByEmail
 * @property {string|null} setByName
 * @property {string} setAt
 * @property {string|null} note
 */

// ── Terms and suppliers ─────────────────────────────────────────────────

/** @typedef {'before_dispatch'|'bl'|'telex_release'|'container_document'|'arrival'|'delivery'|'invoice'|'order'|'unknown'} BalanceTrigger */

/**
 * @typedef {object} PaymentTermsRule
 * @property {number|null} depositPct  0–100, null when the text gives no split.
 * @property {BalanceTrigger} balanceTrigger
 * @property {number} balanceOffsetDays  Days after (negative: before) the trigger's anchor date.
 * @property {'invoice'|'supplier'|'none'} source
 * @property {string|null} raw
 * @property {'parsed'|'partial'|'none'} confidence
 * @property {string[]} notes
 */

/**
 * @typedef {object} SupplierMatch
 * @property {MintSoftSupplier} supplier
 * @property {'exact'|'alias'|'legacy'} how
 */

// ── Policy and dates ────────────────────────────────────────────────────

/**
 * The rule in force for one PO: the default rule with the supplier's laid over it.
 * @typedef {object} EffectivePolicy
 * @property {number|null} depositPct
 * @property {PaymentRuleDepositTrigger} depositTrigger
 * @property {number|null} depositOffsetDays
 * @property {number} depositGraceDays
 * @property {Exclude<PaymentRuleBalanceTrigger, 'terms'>|null} balanceTrigger
 * @property {string|null} balanceDocumentType
 * @property {number|null} balanceOffsetDays
 * @property {number} balanceGraceDays
 * @property {PaymentRuleEstimates} estimates
 * @property {Ymd|null} airOwedFrom
 * @property {number} airLimitDays
 * @property {PaymentRule|null} defaultRule
 * @property {PaymentRule|null} supplierRule
 */

/** @typedef {{ date: Ymd|null, estimated: boolean }} ChainEvent */
/** @typedef {{ get(anchor: 'po'|'pi'|'pi_signed'|'artwork'|'deposit_paid'|'ready'): ChainEvent }} PoEventChain */

/** @typedef {'shipment'|'artwork'|'pi'|'pi_signed'} PaymentBlocker */

/**
 * @typedef {object} DueResult
 * @property {Ymd|null} dueDate
 * @property {Ymd|null} contractualDate
 * @property {boolean} estimated
 * @property {PaymentBlocker|null} blocked
 * @property {PaymentFlag[]} flags
 */

/**
 * One PO's slice of a balance invoice for one container.
 * @typedef {object} ShipmentPaymentClaim
 * @property {ShipmentPayment} payment
 * @property {string} containerNumber
 * @property {number} amount
 * @property {'allocated'|'share'} source
 * @property {boolean} [settled]  The part a transfer already covered — counts as paid.
 * @property {boolean} [partlyPaid]  The rest of that record, still owed.
 */

// ── Output ──────────────────────────────────────────────────────────────

/** @typedef {'estimated'|'derived_date'|'terms_unclear'|'terms_partial'|'no_container'|'landed_fallback'|'departed_no_date'|'po_not_sent'|'prorated_by_qty'|'unpriced_lines'|'overpaid'|'currency_mismatch'|'type_unknown'|'multi_container'|'arranged'|'invoice_total_used'|'total_mismatch'|'duplicate_stated'|'goods_moved'|'assumed_paid'|'estimate_passed'|'policy_applied'|'grace_applied'|'awaiting_artwork'|'awaiting_pi'|'awaiting_pi_signed'|'awaiting_telex'|'awaiting_document'|'bl_issued'|'shipment_invoice'|'invoice_vs_share'|'allocated_by_share'|'superseded_by_shipment_invoice'|'deposit_deducted'|'partly_paid'|'air_owed'|'air_rides_next'|'air_missed'|'due_set'} PaymentFlag */

/** @typedef {'pending'|'arranged'|'projected'} PaymentItemStatus */

/**
 * One line of an item's working: '=' states a figure, '−' / '+' change it,
 * '×' multiplies it. `result` is the running figure, cent-rounded.
 * @typedef {object} DerivationStep
 * @property {'='|'−'|'+'|'×'} op
 * @property {string} label
 * @property {string} [source]
 * @property {number} value
 * @property {number} result
 */

/**
 * A payment still to make. Ids are the TS's (`stated:<pi>[:<ctr>]`,
 * `derived:dep:<po>`, `derived:bal:<po>:<ctr|none>`); feed ids come from ids.js.
 * @typedef {object} PaymentItem
 * @property {string} id
 * @property {'deposit'|'balance'} kind
 * @property {'stated'|'derived'} basis
 * @property {number} poId
 * @property {string} poNumber
 * @property {string|null} supplier
 * @property {string} currency
 * @property {number} amount
 * @property {Ymd|null} dueDate
 * @property {Ymd|null} contractualDate  Before grace days.
 * @property {BalanceTrigger} trigger
 * @property {string|null} containerNumber
 * @property {number|null} containerShare
 * @property {PaymentItemStatus} status
 * @property {PaymentBlocker|null} blocked
 * @property {number|null} shipmentPaymentId
 * @property {PaymentFlag[]} flags
 * @property {number|null} invoiceId
 * @property {number|null} paymentId  The invoice payment (PI) row, for stated items.
 * @property {Ymd|null} [deliveredOn]
 * @property {number} [owedInFull]
 * @property {Ymd|null} [airLimitDate]
 * @property {DerivationStep[]} [derivation]
 * @property {DueOverrideInfo} [dueOverride]  Set only when a date set by hand replaced the derived one (flag `due_set`).
 */

/**
 * @typedef {object} PoContainerShare
 * @property {string|null} containerNumber
 * @property {number} share
 * @property {number} lineCount
 * @property {number} units
 * @property {number|null} value
 * @property {Ymd|null} dueDate
 * @property {Ymd|null} contractualDate
 * @property {boolean} landed
 * @property {boolean} departed
 * @property {boolean} estimated
 * @property {PaymentBlocker|null} blocked
 * @property {PaymentFlag[]} flags
 * @property {Ymd|null} etd
 * @property {Ymd|null} eta
 * @property {'landed'|'proof'|'payment'|null} settledBy
 * @property {boolean} airOwed
 * @property {Ymd|null} deliveredOn
 */

/**
 * @typedef {object} PoPaymentSummary
 * @property {number} poId
 * @property {string} poNumber
 * @property {string|null} supplier
 * @property {string|null} supplierRaw
 * @property {string} currency
 * @property {number|null} poTotal
 * @property {'invoice'|'lines'|'none'} totalBasis
 * @property {number|null} invoiceTotalFrom
 * @property {number|null} linesValue
 * @property {number} shippingTotal
 * @property {number} lineCount
 * @property {number} unpricedLines
 * @property {number} destroyedLines
 * @property {number} paid
 * @property {number} assumedPaid
 * @property {number} shipmentPaid
 * @property {number} shipmentStated
 * @property {number} stated
 * @property {number} remainder
 * @property {number} derivedDeposit
 * @property {number} derivedBalance
 * @property {number} outstanding
 * @property {PaymentTermsRule} rule
 * @property {EffectivePolicy} policy
 * @property {PoContainerShare[]} containers
 * @property {number} proofCount
 * @property {number} proofsMatched
 * @property {'complete'|'fully_paid'|null} excluded
 * @property {PaymentFlag[]} flags
 * @property {PaymentItem[]} items
 */

/**
 * @typedef {object} SupplierRollup
 * @property {string} supplier
 * @property {string} currency
 * @property {number} outstanding
 * @property {number} overdue
 * @property {number} due30
 * @property {number} unscheduled
 * @property {number} paid
 * @property {number} assumedPaid
 * @property {number} poCount
 * @property {number} itemCount
 * @property {Ymd|null} nextDue
 * @property {PaymentTermsRule|null} supplierRule
 * @property {string|null} supplierTerms
 * @property {string|null} jfproName
 * @property {'exact'|'alias'|'legacy'|null} matchHow
 * @property {string[]} aliases
 */

/**
 * @typedef {object} ContainerPayable
 * @property {string} supplier
 * @property {number} amount
 * @property {Ymd|null} dueDate
 * @property {string[]} poNumbers
 * @property {PaymentItem[]} items
 * @property {ShipmentPayment[]} payments
 * @property {ShipmentPaymentDocument[]} documents
 */

/**
 * @typedef {object} ContainerRollup
 * @property {string|null} containerNumber
 * @property {string} currency
 * @property {number} amount
 * @property {Ymd|null} dueDate
 * @property {Ymd|null} etd
 * @property {Ymd|null} eta
 * @property {boolean} landed
 * @property {boolean} departed
 * @property {boolean} estimated
 * @property {string[]} poNumbers
 * @property {number} itemCount
 * @property {ContainerPayable[]} payables
 */

/** @typedef {'overpaid'|'unvalued'|'terms_unclear'|'currency_mismatch'|'invoice_no_payment'|'paid_no_amount'|'duplicate_stated'|'stale_status'|'proof_assumed_paid'|'terms_partial'|'unpriced_lines'|'total_mismatch'|'type_unknown'|'shipment_payment_unallocated'|'shipment_payment_mismatch'|'extraction_failed'|'shipment_payment_currency'|'air_unpriced'|'air_missed'|'air_no_next'} DataQualityKind */

/**
 * @typedef {object} DataQualityIssue
 * @property {DataQualityKind} kind
 * @property {number} poId  0 for a balance record with no PO behind it.
 * @property {string} poNumber
 * @property {string|null} [shipmentReference]
 * @property {string|null} supplier
 * @property {string} currency
 * @property {string} detail
 * @property {number|null} amount
 */

/**
 * @typedef {object} CurrencyKpis
 * @property {number} overdue
 * @property {number} due7
 * @property {number} due30
 * @property {number} unscheduled
 * @property {number} outstanding
 * @property {number} later
 * @property {number} notPayable
 * @property {number} overdueCount
 * @property {number} itemCount
 */

/**
 * @typedef {object} CurrencyFlow
 * @property {string} currency
 * @property {CurrencyKpis} kpis
 * @property {PaymentItem[]} items
 * @property {PoPaymentSummary[]} pos
 * @property {SupplierRollup[]} bySupplier
 * @property {ContainerRollup[]} byContainer
 * @property {DataQualityIssue[]} dataQuality
 */

/**
 * One PO's claim on one balance record, as buildPaymentsFlow resolved it:
 * named in the record's split ('allocated') or its share of the unnamed
 * remainder, by what the PO has on board ('share'). The whole claim, before a
 * part payment splits it into settled and still-owed parts. Port addition
 * (JFlow PHASE2 step 18), returned only with options.claims.
 * @typedef {object} BalanceClaim
 * @property {number} shipmentPaymentId
 * @property {number} poId
 * @property {string} containerNumber  The record's shipment reference, trimmed.
 * @property {'allocated'|'share'} source
 * @property {number} amount
 */

/**
 * @typedef {object} PaymentsFlow
 * @property {Ymd} today
 * @property {CurrencyFlow[]} currencies
 * @property {number} poCount  POs considered (with ≥1 live line), before exclusions.
 * @property {BalanceClaim[]} [balanceClaims]  Only with buildPaymentsFlow(input, { claims: true }).
 */

// ── JFlow feed (forecast.js) ────────────────────────────────────────────

/**
 * A feed row (JFlow PHASE2 §3): an `items` entry of services/shippingSource.js's body.
 * @typedef {object} FeedRow
 * @property {string} id  [A-Za-z0-9_-]{1,64}, from ids.js.
 * @property {'deposit'|'balance'} kind
 * @property {'open'|'paid'} status
 * @property {string|null} supplier
 * @property {number|null} companyId  The PO's company; null when unknown.
 * @property {number|null} poId
 * @property {string|null} poNumber
 * @property {number|null} shipmentId
 * @property {string|null} containerRef
 * @property {string} currency
 * @property {string} amount  2-dp string; open = still owed, paid = this payment.
 * @property {Ymd|null} dueDate  Open rows.
 * @property {'firm'|'estimated'|'undated'} dateBasis
 * @property {'stated'|'derived'} amountBasis
 * @property {PaymentBlocker|null} blocked
 * @property {boolean} arranged
 * @property {Ymd|null} paidOn  Paid rows.
 * @property {string|null} settles  Paid rows: the open row id of what it paid.
 * @property {string[]} flags
 * @property {FeedDueSet|null} dueSet  Open rows whose date was set by hand in ShipLine; else null.
 */

/**
 * The story of a date set by hand, as the feed carries it (external_items.due_set_json).
 * @typedef {object} FeedDueSet
 * @property {string} by  The setter's display name, else the part of the email before @.
 * @property {string} email
 * @property {string} at  ISO instant of the last change.
 * @property {Ymd|null} derivedDate  The date the model would have given.
 * @property {'payment'|'item'} scope
 * @property {string|null} note
 */

/**
 * A payment made, before it is split per PO (forecast.js collectPaidRows).
 * @typedef {{ source: 'transfer', supplierPaymentId: number, lineKind: 'balance'|'pi'|'po_deposit', targetId: number,
 *   amount: number, currency: string, paidOn: Ymd, supplier: string|null, purchaseOrderId: number|null,
 *   poNumber: string|null, shipmentId: number|null, shipmentReference: string|null, paymentType: string|null }
 *   | { source: 'record', shipmentPaymentId: number, amount: number, currency: string, paidOn: Ymd,
 *   supplier: string|null, shipmentId: number|null, shipmentReference: string|null }} PaidFact
 */

module.exports = {};
