// Prepaid rent → activity row.
//
// When a lease is set up with rent paid up front (Agreement.prepaidRents, a
// count of MONTHS), that money is only ever recorded as a number on the
// Agreement — it never lands in the transactions ledger, and the rent-reminder
// cron simply advances nextPaymentDate past the prepaid window so it doesn't
// nag. The consequence: neither the owner nor the tenant ever saw that money in
// their Activity feed, and the owner's realized-income totals understated it
// (no per-month rows are ever generated for the prepaid window).
//
// This derives a single read-only, ledger-shaped row per agreement so both
// feeds surface the prepaid amount — owner income / tenant expense, exactly
// like normal rent. It is DERIVED at read time, never written, so it:
//   • works retroactively for every existing lease (no backfill);
//   • can't double-count real rent (the prepaid months never generate their own
//     transaction — nextPaymentDate was advanced past them at creation);
//   • stays correct through the lease lifecycle (a declined / not-yet-accepted
//     lease produces no row — see EFFECTIVE_STATUSES below).

import type { Agreement, Transaction } from "../../shared/firestore-schema";

// Lease statuses for which the prepaid money actually changed hands. Excludes
// "draft" + "pending_tenant" (owner set it up, tenant hasn't accepted — showing
// a completed "payment" would be a lie) and "declined" (tenant rejected it).
// "active" is the live case; "expired" / "terminated" keep the historical row
// visible on past leases. "suspended" (plan-downgrade hold) MUST be included so
// the prepaid money stays in BOTH the owner's and the tenant's Activity feed
// during the inactive window and after — the product rule is that activity is
// never hidden by deactivation.
const EFFECTIVE_STATUSES: ReadonlySet<Agreement["status"]> = new Set<Agreement["status"]>([
  "active",
  "expired",
  "terminated",
  "suspended",
]);

// Synthesize the prepaid-rent activity row for one agreement, or null when the
// lease has no prepaid rent or hasn't taken effect. The id is deterministic
// (`prepaid_<agreementId>`) so it's a stable React key and never collides with a
// real ledger doc id. type/category mirror a normal collected-rent row so the
// existing owner (income) and tenant (expense, via tenantActivityDisplayType)
// transforms render it correctly; source:"prepaid" keeps it out of the owner's
// 24h manual-edit window and lets the client label it "Prepaid rent" instead of
// the generic "Rent Payment".
export function prepaidRentActivityRow(agreement: Agreement): Transaction | null {
  const months = Math.floor(agreement.prepaidRents ?? 0);
  if (!(months > 0)) return null;
  if (!EFFECTIVE_STATUSES.has(agreement.status)) return null;

  const monthlyRent = agreement.monthlyRent;
  if (typeof monthlyRent !== "number" || !(monthlyRent > 0)) return null;

  // Prefer the amount FROZEN at creation (rate × months at the time the money
  // was actually paid). Falling back to live monthlyRent × months only for older
  // leases predating the snapshot field — otherwise the historical prepaid
  // figure would shift every time rent is indexed or edited.
  const amount =
    typeof agreement.prepaidRentAmount === "number" && agreement.prepaidRentAmount > 0
      ? agreement.prepaidRentAmount
      : monthlyRent * months;

  // Anchor the activity date to when the money was paid — lease signing, else
  // lease start, else the row's creation time. Pin to noon UTC so the date never
  // rolls back a day in Cyprus (UTC+2/3) the way a midnight-UTC date-only string
  // would; mirrors the app-wide date-only timestamp rule.
  const dateOnly = (agreement.signatureDate || agreement.startDate || "").slice(0, 10);
  const timestamp = dateOnly ? `${dateOnly}T12:00:00.000Z` : agreement.createdAt;
  if (!timestamp) return null;

  return {
    id: `prepaid_${agreement.id}`,
    propertyId: agreement.propertyId,
    unitId: agreement.unitId,
    tenantId: agreement.tenantId,
    agreementId: agreement.id,
    ownerId: agreement.ownerId,
    name: `Prepaid rent · ${months} ${months === 1 ? "month" : "months"}`,
    amount,
    currency: "EUR",
    type: "income",
    category: "rent",
    status: "completed",
    timestamp,
    source: "prepaid",
    ...(agreement.portfolioId ? { portfolioId: agreement.portfolioId } : {}),
    ...(agreement.createdAt ? { createdAt: agreement.createdAt } : {}),
  };
}
