// Daily audit-log retention sweep.
//
// userAudit + impersonations are security/accountability logs that hold actor +
// target identifiers (including the EMAIL of users who have since been erased).
// The Privacy Policy §6 ("Retention") promises bounded retention — "Security
// logs: up to 12 months" — but nothing enforced it, so these grew unbounded and
// kept erased users' PII forever. This purges any entry older than the stated
// window, honoring the promise. (Other collections keep their own statutory
// periods — tenancy/payment records for 6 years, etc. — and are NOT touched.)

import { onSchedule } from "firebase-functions/v2/scheduler";
import { db } from "../../server/firebase";
import { logInfo } from "../../server/services/log";
import { COL } from "../../shared/firestore-schema";

// "Security logs: up to 12 months" (Privacy Policy §6). createdAt is an ISO
// string, so the cutoff is an ISO string too (ISO sorts chronologically, and a
// single-field `<` range rides the automatic index — no composite needed).
export const AUDIT_RETENTION_DAYS = 365;

const COLLECTIONS = [COL.userAudit, COL.impersonations] as const;

// Delete every doc in `col` whose createdAt is older than `cutoffIso`, in
// ≤500-doc batches (under the commit cap) until a short batch signals the tail.
// A doc with no createdAt is never matched (we don't delete what we can't date).
async function purgeOlderThan(col: string, cutoffIso: string): Promise<number> {
  let total = 0;
  for (;;) {
    const snap = await db().collection(col).where("createdAt", "<", cutoffIso).limit(500).get();
    if (snap.empty) break;
    const batch = db().batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    total += snap.size;
    if (snap.size < 500) break;
  }
  return total;
}

// `nowMs` is injected so the cutoff is deterministic in tests.
export async function runAuditRetentionSweep(nowMs: number): Promise<Record<string, number>> {
  const cutoffIso = new Date(nowMs - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const counts: Record<string, number> = {};
  let any = 0;
  for (const col of COLLECTIONS) {
    counts[col] = await purgeOlderThan(col, cutoffIso);
    any += counts[col];
  }
  if (any > 0) logInfo("audit_retention.purged", { ...counts, cutoffIso });
  return counts;
}

export function makeAuditRetentionSweep() {
  return onSchedule(
    {
      region: "europe-west1",
      schedule: "every day 03:30",
      timeZone: "Europe/Athens",
      timeoutSeconds: 540,
    },
    async () => {
      await runAuditRetentionSweep(Date.now());
    },
  );
}
