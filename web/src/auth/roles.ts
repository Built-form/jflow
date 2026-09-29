// Copied from workflows/web/src/auth/roles.ts — changes: two account types, `standard | admin` (CONTRACT D5, the pre-2026-09-16 workflows model); dropped `WAREHOUSE_EMAILS`/`isWarehouse`, the manager tier (`canManage`) and the answer-only `isStandard`
import type { Me } from '../api/types';

/**
 * Frontend roles — the same pattern as JFPRO's, ShipLine's and Workflows' `roles` module.
 *
 * Two account types (CONTRACT D5): `standard` is trust-the-team and may do everything
 * except manage the People list; `admin` manages the list too. The server enforces it
 * (403 `ADMIN_REQUIRED` on `POST/PATCH/DELETE /users`); what this helper buys is a build
 * that never offers a button the account would be refused. Presentation-layer scoping,
 * not security: the server still decides.
 */

type Who = Pick<Me, 'email' | 'type'> | null | undefined;

/** Manages the People list. */
export function isAdmin(me: Who): boolean {
  return !!me && me.type === 'admin';
}
