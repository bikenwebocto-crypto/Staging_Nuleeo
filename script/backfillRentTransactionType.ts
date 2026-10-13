// One-off migration: flip historical rent transactions that were written with
// the wrong sign (`type: "expense"`) to `type: "income"`.
//
// Background: until 2026-06-07 BOTH automated rent writers —
// recordRentTransactionFromSession (Stripe card capture) and the offline
// payment-log path in server/routes/tenant.ts — stored collected rent as
// `type: "expense"`, while the manual RecordActivityDialog and every reader
// (owner net income / yield, the PDF briefing, and the admin platform-revenue
// dashboard, which filters `type === "income"` before summing
// applicationFeeCents) treat rent as INCOME. The result was inverted owner
// financials and a permanently €0 admin revenue/commission chart. The writers
// are now fixed; this backfills the rows they already produced.
//
// Selection: `category === "rent" && type === "expense"`. No code path ever
// writes a rent row as a legitimate expense (the manual path writes income),
// so this predicate matches exactly the mis-signed automated rows. Idempotent —
// once flipped, re-running finds nothing.
//
// Usage:
//   npx tsx script/backfillRentTransactionType.ts          # dry-run (no writes)
//   npx tsx script/backfillRentTransactionType.ts --commit # actually write
//
// Auth: same Admin SDK init as the server (server/firebase.ts). Run from the
// repo root with server/secrets/serviceAccountKey.json + .env present.

import "dotenv/config";
import { db } from "../server/firebase";
import { COL, type Transaction } from "../shared/firestore-schema";

const COMMIT = process.argv.includes("--commit");

async function main() {
  const snap = await db()
    .collection(COL.transactions)
    .where("category", "==", "rent")
    .where("type", "==", "expense")
    .get();

  const rows = snap.docs.map((d) => d.data() as Transaction);

  for (const t of rows) {
    console.log(
      `  expense → income  ${t.id}  ${t.currency} ${t.amount}  owner=${t.ownerId ?? "?"}  ${t.timestamp}  via=${t.paymentMethod ?? "?"}`,
    );
  }

  if (COMMIT && rows.length > 0) {
    // Firestore batches cap at 500 writes; chunk to be safe.
    for (let i = 0; i < rows.length; i += 500) {
      const batch = db().batch();
      for (const t of rows.slice(i, i + 500)) {
        batch.set(db().collection(COL.transactions).doc(t.id), { type: "income" }, { merge: true });
      }
      await batch.commit();
    }
  }

  console.log(
    `[backfillRentTransactionType] mis-signed rent rows=${rows.length} committed=${COMMIT}`,
  );
  console.log(
    COMMIT
      ? "Done — historical rent transactions are now type=income."
      : "Dry-run only. Re-run with --commit to write.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
