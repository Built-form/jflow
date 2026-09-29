/**
 * Rows shaped exactly as CONTRACT §6.2–6.9 describes them, for the step-9 screen tests. The
 * items and schedules routes are stubbed, never reached (`src/test/setup.ts`).
 */

import type { Item } from '../../api/items';
import type { Instance, Schedule } from '../../api/schedules';
import type { Account, Category, Company } from '../../api/types';

export const TODAY_STAMP = '2026-09-29T08:00:00Z';

export const company: Company = {
  id: 1, code: 'JFA', name: 'JFA', sortOrder: 1, shippingCompanyId: null, rowVersion: 0, createdBy: null,
  createdAt: TODAY_STAMP, updatedAt: TODAY_STAMP, deletedAt: null,
};

export function account(id: number, name: string, currency = 'GBP'): Account {
  return {
    id, companyId: 1, name, currency, sortOrder: id, isActive: true, isDefault: id === 1, rowVersion: 0,
    createdBy: null, createdAt: TODAY_STAMP, updatedAt: TODAY_STAMP, deletedAt: null, anchorDate: '2026-09-25',
    anchorBalance: '1000.00',
  };
}

export function category(id: number, name: string, direction: 'in' | 'out'): Category {
  return {
    id, name, direction, sortOrder: id, systemKey: null, rowVersion: 0, createdBy: null,
    createdAt: TODAY_STAMP, updatedAt: TODAY_STAMP, deletedAt: null,
  };
}

export function item(id: number, over: Partial<Item> = {}): Item {
  return {
    id, key: `item.${id}`, accountId: 1, companyId: 1, categoryId: 2, direction: 'out', name: `Item ${id}`,
    counterparty: null, amount: '100.00', currency: 'GBP', dueDate: '2026-10-05', status: 'expected',
    paidOn: null, paidAmount: null, remainingAmount: '100.00', payments: [], settleMode: 'auto', notes: null,
    sourceScenarioId: null, derivedStatus: 'expected', rowVersion: 3, createdBy: 'dev@built-form.co.uk',
    createdAt: TODAY_STAMP, updatedAt: TODAY_STAMP, deletedAt: null,
    ...over,
  };
}

export function schedule(id: number, over: Partial<Schedule> = {}): Schedule {
  return {
    id, accountId: 1, companyId: 1, categoryId: 2, direction: 'out', name: `Rent ${id}`, counterparty: null,
    amount: '1000.00', currency: 'GBP', frequency: 'monthly', intervalCount: 1, startDate: '2026-01-31',
    activeFrom: null, occurrenceCount: null, endDate: null, weekendRule: 'none', settleMode: 'auto',
    predecessorId: null, successorId: null, status: 'active', notes: null, structureLocked: true, rowVersion: 5,
    createdBy: null, createdAt: TODAY_STAMP, updatedAt: TODAY_STAMP, deletedAt: null,
    ...over,
  };
}

export function instance(scheduleId: number, naturalDate: string, over: Partial<Instance> = {}): Instance {
  return {
    key: `sched.${scheduleId}.${naturalDate}`, scheduleId, naturalDate, dueDate: naturalDate, amount: '1000.00',
    currency: 'GBP', direction: 'out', status: 'expected', settleMode: 'auto', tuned: false, override: null,
    payments: [], derivedStatus: 'expected',
    ...over,
  };
}

export const list = <T,>(rows: T[]) => ({ data: rows, page: 1, limit: 500, total: rows.length });
