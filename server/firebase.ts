import { initializeApp, cert, getApps, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";
import { Storage as GcsStorage, type Bucket } from "@google-cloud/storage";
import { readFileSync } from "fs";
import { resolve } from "path";

const DEFAULT_STORAGE_BUCKET = "olio-wallet.firebasestorage.app";

export const storageBucketName = process.env.FIREBASE_STORAGE_BUCKET ?? DEFAULT_STORAGE_BUCKET;

// Initialize the Admin SDK. Two environments to support:
//   - Local dev: reads service account JSON from GOOGLE_APPLICATION_CREDENTIALS
//   - Firebase Functions runtime: no env var; Application Default Credentials
//     (the function's own service account) are used automatically
export function initFirebase(): App {
  if (getApps().length) return getApps()[0];

  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credsPath) {
    const serviceAccount = JSON.parse(readFileSync(resolve(process.cwd(), credsPath), "utf8"));
    return initializeApp({
      credential: cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID ?? serviceAccount.project_id,
      storageBucket: storageBucketName,
    });
  }

  // Functions runtime: no explicit credentials; ADC is used.
  return initializeApp({ storageBucket: storageBucketName });
}

export const db = (): Firestore => getFirestore(initFirebase());
export const auth = (): Auth => getAuth(initFirebase());

// Storage client. Uses @google-cloud/storage directly (rather than
// firebase-admin/storage) so that v4 signed URLs are produced by signing with
// the JSON key locally instead of calling the IAM `signBlob` API. The IAM path
// requires the running service account to hold `roles/iam.serviceAccountTokenCreator`
// on itself — fine in production once granted, but we don't want local dev to
// require an IAM round-trip.
let cachedBucket: Bucket | null = null;
export function bucket(): Bucket {
  if (cachedBucket) return cachedBucket;
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const client = credsPath
    ? new GcsStorage({
        keyFilename: resolve(process.cwd(), credsPath),
      })
    : new GcsStorage();
  cachedBucket = client.bucket(storageBucketName);
  return cachedBucket;
}
