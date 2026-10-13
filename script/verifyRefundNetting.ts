// READ-ONLY prod verification for the refund-netting fix (H3).
//
// Reads the live `transactions` collection and runs the EXACT deployed logic
// (isRealizedRent + netRealizedRentAmount from shared/realizedRent.ts, the same
// functions adminQueries/briefing/portfolioInsights call) to confirm:
//   1. whether the charge.refunded webhook has stamped refundedAmountCents /
//      feeRefundedCents on any real Stripe rent row (the capture half), and
//   2. that the netting changes the headline figures, quantifying the delta:
//        - owner realized income  = Σ amount  vs  Σ netRealizedRentAmount
//        - platform revenue (fees) = Σ applicationFeeCents
//                                    vs Σ (applicationFeeCents − feeRefundedCents)
//
// NEVER writes. No --commit. Safe to run against prod.
//
//   npx tsx script/verifyRefundNetting.ts

import "dotenv/config";
import { db } from "../server/firebase";
import { COL, type Transaction } from "../shared/firestore-schema";
import { isRealizedRent, netRealizedRentAmount } from "../shared/realizedRent";

function eur(n: number): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(n);
}

async function main() {
  const snap = await db().collection(COL.transactions).get();
  const txs = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Transaction) }));

  const rentIncome = txs.filter((t) => t.category === "rent" && isRealizedRent(t));
  const stripeLinked = txs.filter((t) => typeof t.stripePaymentIntentId === "string");
  const refunded = txs.filter((t) => (Number(t.refundedAmountCents) || 0) > 0);
  const feeRefunded = txs.filter((t) => (Number(t.feeRefundedCents) || 0) > 0);

  console.log("── Prod transactions snapshot ──────────────────────────────");
  console.log(`total transactions ............... ${txs.length}`);
  console.log(`realized rent income rows ........ ${rentIncome.length}`);
  console.log(`Stripe-linked (stripePaymentIntentId) ${stripeLinked.length}`);
  console.log(`rows with refundedAmountCents > 0  ${refunded.length}`);
  console.log(`rows with feeRefundedCents   > 0  ${feeRefunded.length}`);
  console.log("");

  // Owner realized income: gross vs net.
  const grossIncome = rentIncome.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);
  const netIncome = rentIncome.reduce((s, t) => s + netRealizedRentAmount(t), 0);

  // Platform revenue (application fee), gross vs net of fee refunds. Mirror
  // adminQueries: only realized rows, fee in cents.
  const grossFeeCents = rentIncome.reduce((s, t) => s + (Number(t.applicationFeeCents) || 0), 0);
  const netFeeCents = rentIncome.reduce(
    (s, t) =>
      s +
      Math.max(
        0,
        (Number(t.applicationFeeCents) || 0) - Math.max(0, Number(t.feeRefundedCents) || 0),
      ),
    0,
  );

  console.log("── Netting effect on the deployed aggregations ─────────────");
  console.log(
    `owner realized income  gross=${eur(grossIncome)}  net=${eur(netIncome)}  Δ=${eur(grossIncome - netIncome)}`,
  );
  console.log(
    `platform revenue (fees) gross=${eur(grossFeeCents / 100)}  net=${eur(netFeeCents / 100)}  Δ=${eur((grossFeeCents - netFeeCents) / 100)}`,
  );
  console.log("");

  if (refunded.length === 0 && feeRefunded.length === 0) {
    console.log(
      "RESULT: no refunded rent rows exist in prod yet → the netting path is deployed but\n" +
        "        has no live data to act on (gross == net, Δ = 0). The capture half\n" +
        "        (charge.refunded → refundedAmountCents) has not fired for any real charge.",
    );
    return;
  }

  console.log("── Refunded rows (capture verified) ────────────────────────");
  for (const t of [...refunded, ...feeRefunded.filter((f) => !refunded.includes(f))]) {
    const gross = Math.abs(Number(t.amount) || 0);
    console.log(
      `${t.id}  ${t.timestamp ?? "?"}  amount=${eur(gross)}  refunded=${eur((Number(t.refundedAmountCents) || 0) / 100)}  ` +
        `net=${eur(netRealizedRentAmount(t))}  fee=${(Number(t.applicationFeeCents) || 0) / 100}  feeRefunded=${(Number(t.feeRefundedCents) || 0) / 100}  ` +
        `pi=${t.stripePaymentIntentId ?? "—"}  status=${t.status}`,
    );
  }
  console.log(
    "\nRESULT: refund capture IS present in prod and the deployed netting subtracts it\n" +
      "        from both owner income and platform revenue (Δ above).",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("verify failed:", e);
    process.exit(1);
  });
