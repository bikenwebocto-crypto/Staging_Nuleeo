import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { readFileSync } from "fs";
import { resolve } from "path";

if (!getApps().length) {
  const credsPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "server/secrets/serviceAccountKey.json";
  const sa = JSON.parse(readFileSync(resolve(process.cwd(), credsPath), "utf8"));
  initializeApp({
    credential: cert(sa),
    projectId: process.env.FIREBASE_PROJECT_ID ?? sa.project_id,
  });
}
const auth = getAuth();

async function main() {
  const email = process.argv[2];
  const plan = process.argv[3];

  const allowedPlans = ["basic", "advance", "pro", "business"];

  if (!email || !allowedPlans.includes(plan)) {
    throw new Error("Usage: npx tsx script/setOwnerPlan.ts <email> <plan>");
  }

  const user = await auth.getUserByEmail(email);

  await auth.setCustomUserClaims(user.uid, {
    ...user.customClaims,
    stripeRole: plan,
  });

  console.log(`Successfully updated ${email}`);
  console.log(`New plan: ${plan}`);
  console.log(`UID: ${user.uid}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
