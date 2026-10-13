// Add hostnames to Firebase Auth's authorizedDomains allowlist (the list that
// blocks OAuth redirects with auth/unauthorized-domain). Idempotent — domains
// already present are kept; only missing ones are appended.
//
// Usage:
//   DOMAINS=platform.oliowallet.com,app.oliowallet.com \
//     GOOGLE_APPLICATION_CREDENTIALS=server/secrets/serviceAccountKey.json \
//     npx tsx script/add-authorized-domains.ts
//
// Talks to the Identity Toolkit Admin API directly because the firebase-admin
// SDK doesn't surface authorizedDomains.

import { GoogleAuth } from "google-auth-library";
import { readFileSync } from "fs";
import { resolve } from "path";

const DOMAINS_RAW = process.env.DOMAINS;
if (!DOMAINS_RAW) {
  console.error("Missing DOMAINS env var (comma-separated).");
  process.exit(1);
}

const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!credsPath) {
  console.error("GOOGLE_APPLICATION_CREDENTIALS must be set.");
  process.exit(1);
}

const sa = JSON.parse(readFileSync(resolve(process.cwd(), credsPath), "utf8"));
const projectId: string = process.env.FIREBASE_PROJECT_ID ?? sa.project_id;

const desired = DOMAINS_RAW.split(",")
  .map((d) => d.trim())
  .filter(Boolean);

async function main() {
  const auth = new GoogleAuth({
    credentials: sa,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("Failed to obtain access token.");

  const base = `https://identitytoolkit.googleapis.com/v2/projects/${projectId}/config`;

  const getRes = await fetch(base, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!getRes.ok) {
    console.error(`GET config failed: ${getRes.status}`, await getRes.text());
    process.exit(1);
  }
  const config = (await getRes.json()) as { authorizedDomains?: string[] };
  const existing = config.authorizedDomains ?? [];

  const merged = Array.from(new Set([...existing, ...desired]));
  const added = merged.filter((d) => !existing.includes(d));

  if (added.length === 0) {
    console.log("All domains already authorized:");
    existing.forEach((d) => console.log(`  - ${d}`));
    return;
  }

  const patchRes = await fetch(`${base}?updateMask=authorizedDomains`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ authorizedDomains: merged }),
  });
  if (!patchRes.ok) {
    console.error(`PATCH config failed: ${patchRes.status}`, await patchRes.text());
    process.exit(1);
  }

  console.log(`Added ${added.length} domain(s):`);
  added.forEach((d) => console.log(`  + ${d}`));
  console.log(`\nFull authorizedDomains list now:`);
  merged.forEach((d) => console.log(`  - ${d}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
