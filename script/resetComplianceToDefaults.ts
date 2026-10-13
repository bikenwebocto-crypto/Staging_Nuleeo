// One-off reset: overwrite the live `config/compliance` Firestore doc with the
// corrected compliance copy from shared/compliance-defaults.ts.
//
// WHY: the stored doc (last saved 2026-05-26) is a frozen snapshot of the OLD
// defaults and still serves the false claims removed on 2026-06-17 (phantom
// cookie banner, Mapbox subprocessor, "daily point-in-time backups",
// "Settings → Plans → Cancel", recurring SEPA mandate, etc.). Because
// GET /api/compliance / the client store serve `{ ...DEFAULT, ...stored }` and
// the editor writes with merge:false, the stored values shadow the shipped
// defaults for every key — so the corrected copy will NOT reach users until
// this doc is overwritten. script/checkComplianceOverrides.ts confirmed there
// are ZERO genuine admin customizations (every stale doc differs from default
// only because it's the old-default text), so a full reset loses nothing.
//
// This mirrors the server's own write (server/routes/config.ts:328-334):
// sets every key from DEFAULT_COMPLIANCE_DOCS + a fresh `updatedAt`, with
// merge:false, and deliberately does NOT persist `updatedBy` (config/compliance
// is public-read; we don't leak admin identity).
//
// Equivalent to clicking "Reset to Default" on every tab in the admin
// Compliance editor, in one shot.
//
// Usage:
//   npx tsx script/resetComplianceToDefaults.ts            # dry-run (no writes)
//   npx tsx script/resetComplianceToDefaults.ts --commit   # actually overwrite
//
// Auth: same Admin SDK init as the server (server/firebase.ts) — reads
// serviceAccountKey.json + .env. Run from the repo root.

import "dotenv/config";
import { db } from "../server/firebase";
import {
  COL,
  CONFIG_DOC_COMPLIANCE,
  type ComplianceDocKey,
  type ComplianceDocs,
} from "../shared/firestore-schema";
import { DEFAULT_COMPLIANCE_DOCS } from "../shared/compliance-defaults";

const COMMIT = process.argv.includes("--commit");

const DOC_KEYS: ComplianceDocKey[] = [
  "terms",
  "privacy",
  "gdpr",
  "owner-terms",
  "tenant-terms",
  "cookies",
  "aup",
  "dpa",
  "subprocessors",
  "ai-terms",
  "payments-terms",
  "aml-kyc",
  "community-guidelines",
  "notice-takedown",
  "complaints",
  "accessibility",
  "security",
  "ip-policy",
];

// Substrings removed on 2026-06-17 — shown in the dry-run so you can see which
// false claims each overwrite eliminates.
const PHANTOM_PHRASES: string[] = [
  "cookie banner",
  "consent banner state",
  "consent mechanism we use",
  "cookie preferences panel",
  "First-party analytics events",
  "Settings → Privacy → Cookies",
  "Settings → Privacy → Export",
  "account download",
  "Settings → AI",
  "AskOlio improvement opt-in",
  "Settings → Plans",
  "Settings → Account",
  "daily point-in-time backups",
  "Disaster-recovery drills are run",
  "disaster-recovery testing",
  "with KMS",
  "sanitised server-side before persistence",
  "Mapbox",
  "push (FCM)",
  "recurring mandate",
  "download or export your payment history",
  "retry up to three times over seven days",
  "Help → Report",
  "→ Report",
  "Skip-to-content links and consistent landmarks",
  'click "Appeal"',
];

const phantomHits = (html: string): string[] => PHANTOM_PHRASES.filter((p) => html.includes(p));

async function main(): Promise<void> {
  const ref = db().collection(COL.config).doc(CONFIG_DOC_COMPLIANCE);
  const snap = await ref.get();

  console.log(
    COMMIT ? "RESET compliance docs — COMMIT" : "RESET compliance docs — DRY RUN (no writes)",
  );
  console.log("====================================================");
  console.log(`Firestore doc: ${COL.config}/${CONFIG_DOC_COMPLIANCE}`);
  console.log("");

  const current = (snap.exists ? snap.data() : {}) as Partial<ComplianceDocs>;

  let willChange = 0;
  let unchanged = 0;
  for (const key of DOC_KEYS) {
    const stored = typeof current[key] === "string" ? (current[key] as string) : undefined;
    const def = DEFAULT_COMPLIANCE_DOCS[key];
    if (stored === def) {
      unchanged++;
      continue;
    }
    willChange++;
    const hits = stored ? phantomHits(stored) : [];
    const removes = hits.length
      ? ` — removes: ${hits.map((h) => JSON.stringify(h)).join(", ")}`
      : "";
    console.log(`  • ${key}: will overwrite with corrected default${removes}`);
  }

  console.log("");
  console.log(
    `${willChange} key(s) will change, ${unchanged} already match the corrected default.`,
  );
  console.log("");

  if (willChange === 0) {
    console.log("Nothing to do — the stored doc already matches the corrected defaults.");
    return;
  }

  if (!COMMIT) {
    console.log("DRY RUN — no writes performed. Re-run with --commit to overwrite.");
    return;
  }

  // Mirror the server write exactly: full corrected defaults + fresh
  // updatedAt, merge:false, no updatedBy.
  const next: ComplianceDocs = {
    ...DEFAULT_COMPLIANCE_DOCS,
    updatedAt: new Date().toISOString(),
  };
  await ref.set(next, { merge: false });

  // Verify the write landed and no phantom phrase survived.
  const after = (await ref.get()).data() as Partial<ComplianceDocs>;
  const remaining: { key: ComplianceDocKey; hits: string[] }[] = [];
  for (const key of DOC_KEYS) {
    const v = after[key];
    if (typeof v === "string") {
      const hits = phantomHits(v);
      if (hits.length) remaining.push({ key, hits });
    }
  }

  console.log(`✅ Overwrote config/compliance (updatedAt ${next.updatedAt}).`);
  if (remaining.length === 0) {
    console.log("✅ Verified: no removed phantom phrase remains in any stored doc.");
  } else {
    console.log("⚠️  Some phantom phrases still present after write (investigate):");
    for (const { key, hits } of remaining) {
      console.log(`   • ${key}: ${hits.map((h) => JSON.stringify(h)).join(", ")}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("reset failed:", err);
    process.exit(1);
  });
