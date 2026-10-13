// Daily orphaned-photo sweep. Property/listing photos are uploaded to Cloud
// Storage BEFORE the doc that references them is written, and the upload-url
// gateway mints objects flat under `properties/{uid}/…` and `listings/{uid}/…`
// (not scoped by property/listing id). Two paths leave bytes behind that
// nothing else cleans up:
//   - a create that fails or is cancelled after the photo uploaded, and
//   - a "replace photo" on edit (the new URL is written; the old object isn't
//     deleted — per-finalize cleanup can't run because many photos share one
//     uid prefix).
// Property *deletes* already best-effort-delete their photos (routes/
// properties.ts), so this catches the rest.
//
// SAFETY MODEL — the reference set is a deliberate SUPERSET:
//   - We collect referenced object paths from EVERY collection that can hold a
//     reference into the swept prefixes: firebasestorage download URLs
//     (properties, units, listings, partners, users) AND raw document
//     storagePaths (documents, agreements' signed-lease PDFs). Missing one
//     reference would delete a live photo/document; an extra reference only
//     makes us keep an orphan. We err toward keeping.
//   - We only delete objects older than GRACE_MS. An in-flight upload whose
//     doc hasn't been written yet is younger than the grace window, so it's
//     never swept out from under a save in progress.
// Together: an object is deleted only if it is unreferenced by any doc AND at
// least GRACE_MS old. (Even if this were ever wrong, <PropertyImage> now shows
// a placeholder for a missing photo rather than breaking — defence in depth.)

import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, bucket } from "../../server/firebase";
import { logInfo, logWarn } from "../../server/services/log";
import { COL } from "../../shared/firestore-schema";
import { extractFirebaseStoragePath } from "../../server/services/storagePath";
import {
  PROPERTY_PHOTO_PREFIX,
  LISTING_PHOTO_PREFIX,
  DOCUMENT_PREFIX,
} from "../../server/services/storageTypes";

// Grace window: never delete an object younger than this, so a freshly
// uploaded photo whose owning doc isn't written yet is always safe.
const GRACE_MS = 48 * 60 * 60 * 1000; // 48 hours

export async function runOrphanPhotoSweep(): Promise<void> {
  // 1. Build the referenced-path superset.
  const referenced = new Set<string>();
  // Photos are stored as firebasestorage download URLs — extract the object
  // path. Documents store the raw object path directly (DocumentRecord/Agreement
  // .storagePath), so add those verbatim.
  const addRef = (url: unknown) => {
    if (typeof url === "string" && url.length > 0) {
      const path = extractFirebaseStoragePath(url);
      if (path) referenced.add(path);
    }
  };
  const addPath = (path: unknown) => {
    if (typeof path === "string" && path.length > 0) referenced.add(path);
  };

  const [
    propsSnap,
    unitsSnap,
    listingsSnap,
    partnersSnap,
    usersSnap,
    documentsSnap,
    agreementsSnap,
  ] = await Promise.all([
    db().collection(COL.properties).get(),
    db().collection(COL.units).get(),
    db().collection(COL.marketplaceListings).get(),
    db().collection(COL.partners).get(),
    db().collection(COL.users).get(),
    db().collection(COL.documents).get(),
    db().collection(COL.agreements).get(),
  ]);

  propsSnap.forEach((d) => addRef((d.data() as { image?: string }).image));
  unitsSnap.forEach((d) => addRef((d.data() as { image?: string }).image));
  listingsSnap.forEach((d) => addRef((d.data() as { image?: string }).image));
  partnersSnap.forEach((d) => addRef((d.data() as { image?: string }).image));
  usersSnap.forEach((d) => addRef((d.data() as { photoURL?: string }).photoURL));
  // Property documents + signed-lease PDFs live under DOCUMENT_PREFIX — the ONLY
  // two writers of that prefix (grep-verified). Both store a raw storagePath.
  documentsSnap.forEach((d) => addPath((d.data() as { storagePath?: string }).storagePath));
  agreementsSnap.forEach((d) =>
    addPath(
      (d.data() as { signedLeaseDocument?: { storagePath?: string } }).signedLeaseDocument
        ?.storagePath,
    ),
  );

  // 2. Scan the photo prefixes and delete only objects that are BOTH
  //    unreferenced AND older than the grace window.
  const cutoff = Date.now() - GRACE_MS;
  const b = bucket();
  let scanned = 0;
  let deleted = 0;
  let keptYoung = 0;

  for (const prefix of [PROPERTY_PHOTO_PREFIX, LISTING_PHOTO_PREFIX, DOCUMENT_PREFIX]) {
    const [files] = await b.getFiles({ prefix: `${prefix}/` });
    for (const file of files) {
      scanned++;
      if (referenced.has(file.name)) continue;

      const created = Date.parse(String(file.metadata?.timeCreated ?? ""));
      // Unknown age or still within the grace window → leave for a later run.
      if (!Number.isFinite(created) || created > cutoff) {
        keptYoung++;
        continue;
      }

      try {
        await file.delete();
        deleted++;
        logInfo("orphan_photo.deleted", {
          object: file.name,
          ageHours: Math.round((Date.now() - created) / 3.6e6),
        });
      } catch (err) {
        // Best-effort — a transient failure is retried next run.
        logWarn("orphan_photo.delete-failed", {
          object: file.name,
          err: String(err).slice(0, 200),
        });
      }
    }
  }

  logInfo("orphan_photo.sweep-complete", {
    scanned,
    deleted,
    keptYoung,
    referenced: referenced.size,
  });
}

export function makeOrphanPhotoSweep() {
  return onSchedule(
    {
      region: "europe-west1",
      // 04:30 Athens — after sweepRateLimits (04:00), clear of the other crons.
      schedule: "every day 04:30",
      timeZone: "Europe/Athens",
      timeoutSeconds: 540,
    },
    async () => {
      await runOrphanPhotoSweep();
    },
  );
}
