// Grant a user an admin/superadmin role on the olio-wallet project.
//
// Usage:
//   EMAIL=oliowallet@gmail.com ROLES=admin,superadmin \
//     GOOGLE_APPLICATION_CREDENTIALS=server/secrets/serviceAccountKey.json \
//     npx tsx script/promote-user.ts
//
// Idempotent: re-running merges the requested roles into the existing User
// profile (does not strip other roles the user already has). If the Firebase
// Auth account doesn't exist yet, it's created with email-only auth so the
// matching identity can later sign in via Google with the same address.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { readFileSync } from "fs";
import { resolve } from "path";

import { COL, type Role, type User } from "../shared/firestore-schema";

const EMAIL = process.env.EMAIL;
const ROLES_RAW = process.env.ROLES ?? "admin";

if (!EMAIL) {
  console.error("Missing EMAIL env var.");
  process.exit(1);
}

const VALID_ROLES: Role[] = ["tenant", "owner", "admin", "superadmin"];
const requestedRoles = ROLES_RAW.split(",")
  .map((r) => r.trim())
  .filter((r): r is Role => (VALID_ROLES as string[]).includes(r));

if (requestedRoles.length === 0) {
  console.error(`No valid roles in ROLES="${ROLES_RAW}". Valid: ${VALID_ROLES.join(", ")}`);
  process.exit(1);
}

function init() {
  if (getApps().length) return;
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credsPath) {
    console.error("GOOGLE_APPLICATION_CREDENTIALS must be set.");
    process.exit(1);
  }
  const sa = JSON.parse(readFileSync(resolve(process.cwd(), credsPath), "utf8"));
  initializeApp({
    credential: cert(sa),
    projectId: process.env.FIREBASE_PROJECT_ID ?? sa.project_id,
  });
}

async function main() {
  init();
  const db = getFirestore();
  const auth = getAuth();

  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(EMAIL!);
    console.log(`Found existing Auth user ${EMAIL} (uid=${userRecord.uid})`);
  } catch (err: any) {
    if (err?.code !== "auth/user-not-found") throw err;
    userRecord = await auth.createUser({ email: EMAIL });
    console.log(`Created Auth user ${EMAIL} (uid=${userRecord.uid})`);
  }

  // Mirror admin status onto a custom claim so client-side guards (and Firestore
  // rules, if they reference `request.auth.token.admin`) can short-circuit.
  await auth.setCustomUserClaims(userRecord.uid, {
    admin: requestedRoles.includes("admin") || requestedRoles.includes("superadmin"),
    superadmin: requestedRoles.includes("superadmin"),
  });

  const ref = db.collection(COL.users).doc(userRecord.uid);
  const snap = await ref.get();
  const now = new Date().toISOString();

  if (snap.exists) {
    const existing = snap.data() as User;
    const merged = Array.from(new Set([...existing.roles, ...requestedRoles]));
    await ref.update({ roles: merged });
    console.log(`Updated users/${userRecord.uid} roles → [${merged.join(", ")}]`);
  } else {
    const profile: User = {
      id: userRecord.uid,
      email: EMAIL!,
      firstName: userRecord.displayName?.split(" ")[0] ?? "",
      lastName: userRecord.displayName?.split(" ").slice(1).join(" ") ?? "",
      roles: requestedRoles,
      status: "active",
      joinedAt: now,
      lastLoginAt: now,
    };
    await ref.set(profile);
    console.log(`Created users/${userRecord.uid} with roles [${requestedRoles.join(", ")}]`);
  }

  console.log(`\n${EMAIL} can now sign in via Google on platform.oliowallet.com.`);
  console.log("Note: an existing signed-in session will need to refresh its token");
  console.log("(sign out + back in) for the new custom claims to take effect.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
