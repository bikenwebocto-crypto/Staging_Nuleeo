// One-off cleanup: the Firebase Stripe Payments extension synced product/price
// docs while it was pointed at the SANDBOX account, then those docs were left
// `active: true` after the live cutover. The client's useProducts() reads every
// active product and hands its price to Checkout — and the sandbox products sort
// first, so new subscribers get a sandbox price the LIVE account rejects
// ("No such price"). This deactivates any product whose price carries the sandbox
// account fingerprint, leaving the live Growth (€69) / Pro (€290) products.
//
// Identifies sandbox objects by the account fingerprint embedded in Stripe ids:
//   sandbox acct_1TPNVi[H79Nk7s7Fo]  ->  price_1TUdS6[H79Nk7s7Fo]...
//   live                              ->  price_1TlanG[HIe9iczXCy]...
// So a price id containing SANDBOX_FP belongs to the sandbox account.
//
// Reversible: re-run won't touch already-inactive docs; to undo, flip active back.
//
// Usage (dry-run):
//   GOOGLE_APPLICATION_CREDENTIALS=server/secrets/serviceAccountKey.json \
//     npx tsx script/deactivateSandboxProducts.ts
// Apply:
//   GOOGLE_APPLICATION_CREDENTIALS=server/secrets/serviceAccountKey.json \
//     npx tsx script/deactivateSandboxProducts.ts --commit

import "dotenv/config";
import { db } from "../server/firebase";

const SANDBOX_FP = "H79Nk7s7Fo"; // acct_1TPNViH79Nk7s7Fo (Olio Wallet sandbox)
const COMMIT = process.argv.includes("--commit");

async function main() {
  const prods = await db().collection("products").get();
  console.log(`Scanning ${prods.size} products (${COMMIT ? "COMMIT" : "DRY-RUN"})\n`);

  let deactivated = 0;
  let kept = 0;

  for (const prod of prods.docs) {
    const pd = prod.data() as {
      active?: boolean;
      name?: string;
      metadata?: { firebaseRole?: string };
    };
    const priceSnap = await prod.ref.collection("prices").get();
    const priceIds = priceSnap.docs.map((d) => d.id);
    const isSandbox = priceIds.some((id) => id.includes(SANDBOX_FP));
    const role = pd.metadata?.firebaseRole ?? "-";

    if (!isSandbox) {
      console.log(`KEEP  ${prod.id}  "${pd.name}"  role=${role}  (live)`);
      kept++;
      continue;
    }

    if (pd.active === false) {
      console.log(`skip  ${prod.id}  "${pd.name}"  role=${role}  (already inactive)`);
      continue;
    }

    console.log(
      `${COMMIT ? "DEACTIVATE" : "would deactivate"}  ${prod.id}  "${pd.name}"  role=${role}  prices=[${priceIds.join(", ")}]`,
    );

    if (COMMIT) {
      const batch = db().batch();
      batch.update(prod.ref, { active: false });
      for (const priceDoc of priceSnap.docs) {
        if ((priceDoc.data() as { active?: boolean }).active !== false) {
          batch.update(priceDoc.ref, { active: false });
        }
      }
      await batch.commit();
    }
    deactivated++;
  }

  console.log(
    `\n${COMMIT ? "Deactivated" : "Would deactivate"} ${deactivated} sandbox product(s); kept ${kept} live product(s).`,
  );
  if (!COMMIT) console.log("Re-run with --commit to apply.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
