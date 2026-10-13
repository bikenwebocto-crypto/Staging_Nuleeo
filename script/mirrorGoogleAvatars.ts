// One-off backfill: users who signed up with Google before avatar-mirroring
// shipped have a photoURL pointing at Google's CDN (lh3.googleusercontent.com).
// That host is now CSP-allowlisted so it renders, but it's still a volatile
// third-party URL. This copies each such photo into our own Cloud Storage
// bucket and rewrites photoURL to the Storage download URL — exactly what new
// Google sign-ins now do via GET /api/me.
//
// Idempotent: only touches photoURLs on *.googleusercontent.com, so re-running
// skips already-migrated users. Best-effort per user — a fetch/upload failure
// leaves that user's original URL intact (still works via CSP) and is logged.
//
// Usage:
//   npx tsx script/mirrorGoogleAvatars.ts          # dry-run (no writes)
//   npx tsx script/mirrorGoogleAvatars.ts --commit # actually write
//
// Auth: same Admin SDK init as the server (server/firebase.ts) — reads
// serviceAccountKey.json + .env. Run from the repo root.

import "dotenv/config";
import { db } from "../server/firebase";
import { COL, type User } from "../shared/firestore-schema";
import { mirrorRemotePhotoToStorage } from "../server/services/mirrorRemotePhoto";

const COMMIT = process.argv.includes("--commit");

function isGooglePhoto(url: string | undefined): url is string {
  return !!url && url.includes("googleusercontent.com");
}

async function main() {
  const snap = await db().collection(COL.users).get();
  const targets = snap.docs.map((d) => d.data() as User).filter((u) => isGooglePhoto(u.photoURL));

  console.log(
    `[mirrorGoogleAvatars] ${targets.length} user(s) with a Google-CDN photoURL ` +
      `(of ${snap.size} total).`,
  );

  let migrated = 0;
  let failed = 0;
  for (const u of targets) {
    const label = u.email || u.id;
    if (!COMMIT) {
      console.log(`  would mirror  ${u.id}  ${label}`);
      continue;
    }
    const newUrl = await mirrorRemotePhotoToStorage(u.id, u.photoURL!);
    if (!newUrl) {
      failed++;
      console.log(`  FAILED        ${u.id}  ${label}  (original URL left intact)`);
      continue;
    }
    await db().collection(COL.users).doc(u.id).set({ photoURL: newUrl }, { merge: true });
    migrated++;
    console.log(`  mirrored      ${u.id}  ${label}`);
  }

  console.log(
    `[mirrorGoogleAvatars] committed=${COMMIT} scanned=${targets.length} ` +
      `migrated=${migrated} failed=${failed}`,
  );
  console.log(
    COMMIT
      ? "Done — migrated Google avatars are now served from our own Storage bucket."
      : "Dry-run only. Re-run with --commit to write.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
