// Indexation scheduling math. Builds on the shared rent-cycle date helpers
// (server/services/rentCycle.ts) so the month arithmetic lives in one place —
// the only thing indexation does differently is default a missing frequency to
// YEARLY (rent cycles default to monthly), since that's how indexation terms
// are captured at lease creation.

import { advanceMonths, monthsPerPeriod } from "./rentCycle";
import type { Agreement, PaymentFrequency } from "../../shared/firestore-schema";

// Months between indexation steps. Same period table as rent cycles, but a
// missing/legacy frequency means yearly (the create path seeds "yearly", and
// yearly is the sane default for an indexation clause).
export function indexationStrideMonths(frequency: PaymentFrequency | undefined): number {
  return frequency ? monthsPerPeriod(frequency) : 12;
}

// The date the indexation clock starts from. The schema defines delayMonths as
// "months after signing", so the signing date is preferred, falling back
// through signedAt → startDate → createdAt. Returns null if none are present.
export function indexationAnchor(agreement: Agreement): string | null {
  const anchor =
    agreement.signatureDate ?? agreement.signedAt ?? agreement.startDate ?? agreement.createdAt;
  return anchor ? anchor.slice(0, 10) : null;
}

// The first indexation effective date that is on or after `todayIso`.
//
// The raw first step is anchor + delayMonths. For brand-new leases that is
// usually in the future and returned as-is. For backdated or pre-existing
// leases whose first (or several) steps already fell in the past, we roll
// forward by the frequency stride until we reach the next not-yet-passed step
// — we deliberately do NOT retroactively apply missed increases (a tenant was
// never charged or notified for them; surprise back-billing would be wrong).
export function nextIncreaseDateOnOrAfter(agreement: Agreement, todayIso: string): string | null {
  const idx = agreement.indexation;
  if (!idx) return null;
  const anchor = indexationAnchor(agreement);
  if (!anchor) return null;

  const stride = indexationStrideMonths(idx.frequency);
  let date = advanceMonths(anchor, idx.delayMonths ?? 0);
  const today = todayIso.slice(0, 10);
  // stride is always ≥ 1, so this terminates.
  let guard = 0;
  while (date < today && guard < 1000) {
    date = advanceMonths(date, stride);
    guard += 1;
  }
  return date;
}
