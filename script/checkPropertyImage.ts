// Read-only diagnostic: print the `image` field of properties whose name or
// address matches a search term, and (best-effort) whether the referenced
// Storage object actually exists. Answers "is this property just photoless,
// or does it have a broken/missing photo URL?" without touching any data.
//
// Usage:
//   npx tsx script/checkPropertyImage.ts                 # defaults to "Seaside"
//   npx tsx script/checkPropertyImage.ts "Seaside Apartment"
//   npx tsx script/checkPropertyImage.ts --all           # every property
//
// Auth: same Admin SDK init as the server (server/firebase.ts) — reads
// serviceAccountKey.json + .env. NEVER writes; safe to run anytime.

import "dotenv/config";
import { db, bucket } from "../server/firebase";
import { COL, type Property } from "../shared/firestore-schema";
import { extractFirebaseStoragePath } from "../server/services/storagePath";

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const term = (args.find((a) => !a.startsWith("--")) ?? "Seaside").toLowerCase();

  const snap = await db().collection(COL.properties).get();
  const props = snap.docs.map((d) => d.data() as Property);

  const matches = all
    ? props
    : props.filter(
        (p) =>
          (p.name ?? "").toLowerCase().includes(term) ||
          (p.address ?? "").toLowerCase().includes(term),
      );

  if (matches.length === 0) {
    console.log(all ? "No properties found." : `No property matches "${term}".`);
    return;
  }

  console.log(
    `\n${matches.length} ${all ? "" : `match(es) for "${term}" `}` +
      `(of ${props.length} properties total):\n`,
  );

  for (const p of matches) {
    const label = p.name || p.address || p.id;
    console.log(`• ${label}`);
    console.log(`    id:      ${p.id}`);
    console.log(`    address: ${p.address ?? "—"}`);

    if (!p.image) {
      console.log(`    image:   (no image field) → just photoless, NOT a bug ✅`);
      console.log("");
      continue;
    }

    console.log(`    image:   ${p.image}`);
    const path = extractFirebaseStoragePath(p.image);
    if (!path) {
      console.log(
        `    storage: URL is not a Firebase Storage download URL → likely a stale/bad value ⚠️`,
      );
      console.log("");
      continue;
    }
    try {
      const [exists] = await bucket().file(path).exists();
      console.log(
        exists
          ? `    storage: object EXISTS at ${path} → photo is fine ✅`
          : `    storage: object MISSING at ${path} → broken reference (data bug) ❌`,
      );
    } catch (err) {
      console.log(`    storage: could not check (${(err as Error).message}) — skipped`);
    }
    console.log("");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
