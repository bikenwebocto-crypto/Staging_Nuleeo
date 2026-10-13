// READ-ONLY diagnostic for QA-03. Counts docs missing the field that the
// bounded admin list endpoints orderBy() on. Firestore's orderBy silently
// excludes docs lacking the field, so any "missing" count > 0 means the
// bounded query would hide those records from the admin views — which must
// be backfilled before the bounding is safe to ship.
//
// Run:  npx tsx script/checkSortFieldCoverage.ts
import "dotenv/config";
import { db } from "../server/firebase";
import { COL } from "../shared/firestore-schema";

const CHECKS: Array<[keyof typeof COL, string]> = [
  ["users", "joinedAt"],
  ["transactions", "timestamp"],
  ["agreements", "createdAt"],
  ["properties", "createdAt"],
  ["tickets", "createdAt"],
  ["portfolioAccessContacts", "invitedAt"],
  ["impersonations", "createdAt"],
  ["userAudit", "createdAt"],
];

async function main() {
  console.log("project:", process.env.FIREBASE_PROJECT_ID);
  let anyMissing = false;
  for (const [key, field] of CHECKS) {
    const col = COL[key];
    const snap = await db().collection(col).select(field).get();
    const missingIds: string[] = [];
    snap.docs.forEach((d) => {
      const v = (d.data() as Record<string, unknown>)[field];
      if (v === undefined || v === null || v === "") {
        if (missingIds.length < 8) missingIds.push(d.id);
        else missingIds.push("…");
      }
    });
    const missing = snap.docs.filter((d) => {
      const v = (d.data() as Record<string, unknown>)[field];
      return v === undefined || v === null || v === "";
    }).length;
    if (missing > 0) anyMissing = true;
    console.log(
      `${col}.${field}: total=${snap.size}  missing=${missing}` +
        (missing ? `  e.g. [${missingIds.slice(0, 8).join(", ")}]` : "  ✓"),
    );
  }
  console.log(
    anyMissing
      ? "\nRESULT: backfill needed before bounding is safe."
      : "\nRESULT: all docs covered — bounding is safe.",
  );
  process.exit(0);
}
main().catch((e) => {
  console.error("diagnostic failed:", e);
  process.exit(1);
});
