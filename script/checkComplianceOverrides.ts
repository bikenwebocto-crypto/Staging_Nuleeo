// Read-only diagnostic: does the live `config/compliance` Firestore doc shadow
// the compliance copy we ship as defaults in shared/compliance-defaults.ts —
// and, crucially, does any stored doc still contain the outdated/false claims
// we removed on 2026-06-17 (phantom cookie banner, Mapbox subprocessor, "daily
// point-in-time backups", "Settings → Plans → Cancel", recurring SEPA mandate,
// etc.)?
//
// WHY THIS EXISTS: GET /api/compliance and the client store both serve
// `{ ...DEFAULT_COMPLIANCE_DOCS, ...stored }` — a PER-KEY merge. And the write
// path (PUT /api/compliance) saves with merge:false AFTER spreading the full
// DEFAULT_COMPLIANCE_DOCS (server/routes/config.ts:328-334), so the moment ANY
// admin saves the Compliance editor even once, the stored doc contains EVERY
// key (their edits PLUS a frozen snapshot of the old defaults for everything
// they didn't touch). Net effect: if the doc exists, the stored values shadow
// our corrected defaults for every key — so the 2026-06-17 copy fix will NOT
// reach users until the affected docs are reset.
//
// This script tells you exactly which docs are (a) already equal to the current
// default, (b) genuinely customized, or (c) stale copies that still carry the
// removed false claims and therefore need a "Reset to Default" in the admin
// Compliance editor (or a one-off overwrite).
//
// READ-ONLY: makes no writes. There is no --commit flag.
//
// Usage:
//   npx tsx script/checkComplianceOverrides.ts   # from repo root
//
// Auth: same Admin SDK init as the server (server/firebase.ts) — reads
// serviceAccountKey.json + .env. Run from the repo root.

import "dotenv/config";
import { db } from "../server/firebase";
import { COL, CONFIG_DOC_COMPLIANCE, type ComplianceDocKey } from "../shared/firestore-schema";
import { DEFAULT_COMPLIANCE_DOCS } from "../shared/compliance-defaults";

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

// Substrings REMOVED from the defaults on 2026-06-17. If a stored value still
// contains one, that doc is a stale pre-fix copy and must be reset/overwritten
// — it is still showing a false claim to users.
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

function phantomHits(html: string): string[] {
  return PHANTOM_PHRASES.filter((p) => html.includes(p));
}

async function main(): Promise<void> {
  const ref = db().collection(COL.config).doc(CONFIG_DOC_COMPLIANCE);
  const snap = await ref.get();

  console.log("Compliance-copy override check");
  console.log("==============================");
  console.log(`Firestore doc: ${COL.config}/${CONFIG_DOC_COMPLIANCE}`);
  console.log("");

  if (!snap.exists) {
    console.log("✅ No config/compliance doc exists in Firestore.");
    console.log("   The defaults in shared/compliance-defaults.ts are served verbatim —");
    console.log("   your corrected copy goes live on the next deploy. Nothing to reset.");
    return;
  }

  const data = snap.data() as Record<string, unknown>;
  const updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : "(unknown)";
  console.log(`Doc EXISTS. Last saved (updatedAt): ${updatedAt}`);
  console.log("(Stored values shadow the shipped defaults for every key present.)");
  console.log("");

  const matches: ComplianceDocKey[] = [];
  const stale: { key: ComplianceDocKey; hits: string[] }[] = [];
  const customized: ComplianceDocKey[] = [];
  const servedFromDefault: ComplianceDocKey[] = [];

  for (const key of DOC_KEYS) {
    const stored = data[key];
    const def = DEFAULT_COMPLIANCE_DOCS[key];
    if (typeof stored !== "string") {
      // Key absent from the stored doc → the merge serves our default for it.
      servedFromDefault.push(key);
      continue;
    }
    if (stored === def) {
      matches.push(key);
      continue;
    }
    const hits = phantomHits(stored);
    if (hits.length > 0) stale.push({ key, hits });
    else customized.push(key);
  }

  const line = (label: string, n: number) => console.log(`  ${label}: ${n}`);
  console.log("Summary");
  console.log("-------");
  line("✓ match current default (correct, no action)", matches.length);
  line("✗ STALE — still contain removed false claims (RESET needed)", stale.length);
  line("● customized — differ, no known phantom phrase (review manually)", customized.length);
  line("· served from default (key absent in stored doc — OK)", servedFromDefault.length);
  console.log("");

  if (stale.length > 0) {
    console.log("✗ STALE — Reset these to Default in admin → Compliance editor:");
    for (const { key, hits } of stale) {
      console.log(`   • ${key}`);
      console.log(`       still contains: ${hits.map((h) => JSON.stringify(h)).join(", ")}`);
    }
    console.log("");
  }
  if (customized.length > 0) {
    console.log("● Customized (differ from default, no known phantom phrase — likely genuine");
    console.log("  admin edits; review by hand to confirm they don't repeat the same claims):");
    console.log(`   ${customized.join(", ")}`);
    console.log("");
  }
  if (matches.length > 0) {
    console.log(`✓ Already match the corrected default: ${matches.join(", ")}`);
    console.log("");
  }
  if (servedFromDefault.length > 0) {
    console.log(`· Served from default (not in stored doc): ${servedFromDefault.join(", ")}`);
    console.log("");
  }

  console.log("RECOMMENDED ACTION");
  console.log("------------------");
  if (stale.length === 0 && customized.length === 0) {
    console.log("Nothing to do — every stored doc matches the corrected default.");
    console.log("Deploy and the fix is live.");
  } else {
    if (stale.length > 0) {
      console.log(
        `Reset ${stale.length} stale doc(s) to Default — they still show false claims to users.`,
      );
    }
    if (customized.length > 0) {
      console.log(
        `Review ${customized.length} customized doc(s) for the same claims corrected on 2026-06-17`,
      );
      console.log("  (cookie banner, Mapbox, backups, Settings→Plans→Cancel, SEPA mandate, etc.).");
    }
    console.log("Alternatively, run a one-off --commit overwrite of the affected keys with the");
    console.log("corrected defaults.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("check failed:", err);
    process.exit(1);
  });
