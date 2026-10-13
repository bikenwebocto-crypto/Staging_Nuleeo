// Per-plan unit cap enforcement. The cap is the maximum number of properties
// an owner can have on their plan — used to gate POST /api/properties.
//
// Source of truth:
//   - `config/planLabels.plans[plan].unitCap` (admin-editable on
//     /admin/owner-plans, defaults to 2/5/20/null per plan tier)
//   - `config/privileges.ownerPlan["units.unlimited"][plan]` — when granted
//     to the caller's plan, the cap is bypassed regardless of label config.
//
// Returns `{ cap: null }` for unlimited, otherwise the integer cap.

import { db } from "../firebase";
import { COL, DEFAULT_PLAN_LABELS, type OwnerPlanKey } from "../../shared/firestore-schema";
import { resolveOwnerPlan } from "./commission";
import { loadPlanLabels, loadPrivilegesConfig } from "./configCache";
import { getPortfolio } from "./portfolioBanking";

export interface UnitCapInfo {
  plan: OwnerPlanKey;
  // Integer cap on properties. `null` means unlimited.
  cap: number | null;
  // Current property count for the owner. Read by callers that want to
  // surface "X / Y" copy without an extra query.
  used: number;
}

export async function resolveUnitCap(ownerUid: string): Promise<UnitCapInfo> {
  const [plan, labels, privileges, portfolio] = await Promise.all([
    resolveOwnerPlan(ownerUid),
    loadPlanLabels(),
    loadPrivilegesConfig(),
    getPortfolio(ownerUid),
  ]);

  // Phase-2 portfolio re-key: the cap counts properties keyed by the STABLE
  // portfolio doc id. No portfolio → no stamped properties by construction
  // (every create path ensures + stamps it) → used = 0.
  //
  // Soft-deactivated properties (plan-downgrade hold, status "inactive") must
  // NOT consume a slot — otherwise an owner whose plan hid some properties
  // couldn't add new ones even though the hidden ones don't count against them,
  // and the reconcile/restore math would disagree with the gate. So used =
  // total − inactive. (Firestore `!=` would drop legacy docs missing the status
  // field, so we subtract an explicit inactive count instead.)
  let used = 0;
  if (portfolio) {
    const propsCol = db().collection(COL.properties).where("portfolioId", "==", portfolio.id);
    const [total, inactive] = await Promise.all([
      propsCol.count().get(),
      propsCol.where("status", "==", "inactive").count().get(),
    ]);
    used = Math.max(0, total.data().count - inactive.data().count);
  }
  // Privilege override — Business (and anyone an admin grants
  // units.unlimited via the matrix) skips the cap entirely.
  const unlimitedGrant = Boolean(privileges.ownerPlan["units.unlimited"]?.[plan]);
  if (unlimitedGrant) return { plan, cap: null, used };

  const cap = labels.plans[plan]?.unitCap ?? DEFAULT_PLAN_LABELS.plans[plan].unitCap;
  return { plan, cap, used };
}
