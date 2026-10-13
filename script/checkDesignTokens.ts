// Design-token guard. Fails CI when a file in the "token-pure" set reintroduces
// a hardcoded chromatic Tailwind palette utility (e.g. text-red-600,
// bg-emerald-500/10) instead of the semantic tokens defined in
// client/shared/index.css (destructive / success / warning / info + the
// monochrome surfaces). Those raw utilities are the recurring dark-mode bug:
// they carry no .dark pairing, so status/brand surfaces go dark-on-dark or
// wash out in dark mode.
//
// SCOPE: only the curated CHECKED set below — the shared ui/ primitives and the
// shared roots + feature dirs already migrated to tokens. As more surfaces are
// cleaned, add them here so they're protected from regression. This keeps the
// gate green today while still failing on NEW violations in the design-system
// core. (A whole-tree sweep still has a backlog of leaf-page offenders.)
//
// ESCAPE HATCH: append `tokens-ok` in a comment on a line that legitimately
// needs a raw color (e.g. a printable "paper" document locked to white, a brand
// logo SVG, a fixed-dark system gate) and the guard will skip that line.
//
// Run locally: `npx tsx script/checkDesignTokens.ts`

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Files (and directories, recursed) that MUST stay free of raw chromatic
// palette utilities. Paths are relative to the repo root.
const CHECKED: string[] = [
  "client/shared/components/ui",
  "client/shared/components/common/ProfileDrawer.tsx",
  "client/shared/components/common/DeleteAccountSection.tsx",
  "client/shared/components/common/PricingModal.tsx",
  "client/shared/components/common/CalculatorBody.tsx",
  "client/shared/components/common/ConfirmDialog.tsx",
  "client/shared/components/common/PropertyImage.tsx",
  "client/shared/components/common/StatusPill.tsx",
  "client/shared/components/owner/BankingSection.tsx",
  "client/shared/components/owner/ConnectStatusBadge.tsx",
  // NOTE: AgreementDocument.tsx is intentionally NOT checked — its status pill
  // renders on a forced-white "paper" card (theme-opted-out, matches the
  // printed PDF) and must use fixed print shades, not theme-adaptive tokens.
  "client/app/src/pages/common/ExpertPage.tsx",
  "client/platform/src/features/email-marketing/ui",
  // Leaf pages migrated to tokens during the a11y/design pass. Added as specific
  // files (not their whole dirs) because sibling pages in tenant/auth/insights
  // still carry a pre-existing chromatic backlog not yet cleaned.
  "client/app/src/pages/tenant/TenantAgreementsPage.tsx",
  "client/app/src/pages/auth/Home.tsx",
  "client/app/src/pages/owner/insights/PropertiesSection.tsx",
];

const CHROMATIC =
  "(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)";
// A Tailwind color utility: <prefix>-<chromatic>-<shade>, optional /<opacity>.
const RULE = new RegExp(
  `\\b(bg|text|border|ring|from|via|to|fill|stroke|divide|placeholder|caret|accent|outline|shadow|ring-offset)-${CHROMATIC}-[0-9]{2,3}\\b`,
);

function filesUnder(path: string): string[] {
  let st;
  try {
    st = statSync(path);
  } catch {
    return []; // path removed/renamed — not this guard's job to complain
  }
  if (st.isFile()) return /\.tsx?$/.test(path) ? [path] : [];
  return readdirSync(path).flatMap((entry) => filesUnder(join(path, entry)));
}

const violations: { file: string; line: number; text: string }[] = [];

for (const root of CHECKED) {
  for (const file of filesUnder(root)) {
    if (/\.test\.tsx?$/.test(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.includes("tokens-ok")) return;
      if (RULE.test(line)) {
        violations.push({ file, line: i + 1, text: line.trim() });
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    `\n✖ Design-token guard: ${violations.length} hardcoded chromatic palette utility(ies) found in the token-pure set.\n` +
      `  Use semantic tokens (bg/text-destructive | success | warning | info, or the monochrome surfaces) so dark mode stays correct.\n` +
      `  Intentional exceptions: add a "tokens-ok" comment on the line.\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}\n    ${v.text}`);
  }
  process.exit(1);
}

console.log(
  `✅ Design-token guard: ${CHECKED.length} checked paths are free of hardcoded chromatic palette utilities.`,
);
