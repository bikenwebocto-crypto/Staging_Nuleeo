// Docs-lint: keeps README.md's advertised test-file count honest.
//
// Why: a diligence reviewer reads the README first, and a stale "~N tests
// across ~M files" line is the cheapest credibility hit there is. This script
// recomputes the REAL number of test files (*.test.ts / *.test.tsx, excluding
// build artifacts) and fails CI if the count cited in README.md has drifted
// too far from reality. It is intentionally filesystem-only — no Firebase, no
// network — so it runs in CI with zero secrets.
//
// We anchor on the test-FILE count, not the test-CASE count: the case count
// shifts every time anyone adds an assertion, which would make this gate noisy
// to the point of useless. File count moves only when whole test files are
// added/removed, which is exactly when the README line should be revisited.
//
// Tolerance: the README says "~N files" (deliberately approximate prose), so
// we allow a small ± drift band rather than demanding an exact match. The gate
// fires only on a real divergence (someone added a batch of test files and
// never touched the README), not on a single new file.
//
// Severity: a stale README number is a *documentation* nit, not a correctness
// failure — so by default this WARNS (emits a GitHub annotation + exits 0) and
// never reddens the build or blocks a deploy. This matches the "warn on legacy,
// fail on new" posture of the Lint and Audit gates in ci.yml: blocking a ship
// over a drifted doc string is wildly disproportionate, and historically it
// flooded the repo with failure emails every time a batch of test files landed
// without a matching README bump. Pass --strict to make drift a hard error
// (exit 1) — useful for a deliberate "tidy the docs" pass locally.
//
// Usage:
//   npx tsx script/checkDocs.ts            # warn on drift, always exit 0
//   npx tsx script/checkDocs.ts --strict   # exit 1 on drift, 0 when in sync

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Dir names that NEVER hold source tests, wherever they appear: deps, VCS, and
// transient tool output. Safe to skip by bare name.
const SKIP_BY_NAME = new Set(["node_modules", ".git", "coverage", ".firebase"]);

// Build-output dirs, matched by REPO-RELATIVE path (POSIX-style). We must NOT
// skip every dir literally named `lib` / `dist` — `client/shared/lib` is real
// source and holds several *.test.ts files. Only these specific paths are
// compiled artifacts whose *.test.* are duplicates of the real source ones.
const SKIP_BY_PATH = new Set([
  "dist", // server bundle output (build:server)
  "functions/lib", // tsc output for Functions
  "client/landing/dist",
  "client/app/dist",
  "client/platform/dist",
  "server/public", // mirrors .prettierignore build-output list
]);

const TEST_FILE_RE = /\.test\.tsx?$/;

function relPosix(full: string): string {
  return relative(REPO_ROOT, full).split(sep).join("/");
}

function countTestFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir)) {
    if (SKIP_BY_NAME.has(entry)) continue;
    const full = join(dir, entry);
    if (SKIP_BY_PATH.has(relPosix(full))) continue;
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue; // race: file vanished mid-walk — ignore
    }
    if (isDir) {
      count += countTestFiles(full);
    } else if (TEST_FILE_RE.test(entry)) {
      count += 1;
    }
  }
  return count;
}

// The README anchors its claim with an HTML comment marker so we match on
// structure, not brittle prose. Format:
//   <!-- test-count:files --> ... ~50 ...
// We pull the first integer that appears on the SAME line as the marker.
const MARKER = "<!-- test-count:files -->";

function citedCount(readme: string): number | null {
  for (const line of readme.split("\n")) {
    if (!line.includes(MARKER)) continue;
    const m = line.match(/(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

// Allowed ± drift between the cited "~N" and reality before we fail. Small
// enough to catch a forgotten batch of new tests, loose enough to tolerate the
// "~" approximation and one-off additions.
const TOLERANCE = 5;

// --strict turns drift into a hard failure (exit 1). Default is warn-only:
// emit a GitHub annotation so the drift is visible on the run, but exit 0 so a
// documentation nit never blocks a deploy or fires a failure email.
const STRICT = process.argv.includes("--strict");

// Report a docs-lint problem at the configured severity. In strict mode this
// errors and exits 1; otherwise it prints a `::warning::` annotation (GitHub
// surfaces it on the run summary) and returns so the script exits 0.
function report(message: string): void {
  if (STRICT) {
    console.error(message);
    process.exit(1);
  }
  // GitHub Actions annotations are single-line; collapse newlines into the
  // workflow-command escape so the whole note still renders in the summary.
  const annotation = message.replace(/\n/g, "%0A");
  console.log(`::warning title=docs-lint::${annotation}`);
}

function main(): void {
  const actual = countTestFiles(REPO_ROOT);

  const readmePath = join(REPO_ROOT, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const cited = citedCount(readme);

  if (cited === null) {
    report(
      `docs-lint: could not find the test-count marker "${MARKER}" in README.md.\n` +
        `Add it to the line that cites the test-file count, e.g.:\n` +
        `  vitest (~${actual} files) <!-- test-count:files -->`,
    );
    return;
  }

  const drift = Math.abs(actual - cited);
  if (drift > TOLERANCE) {
    report(
      `docs-lint: README test-file count is stale.\n` +
        `  README says: ~${cited} files (near "${MARKER}")\n` +
        `  actual:      ${actual} test files (*.test.ts / *.test.tsx)\n` +
        `  drift:       ${drift} (tolerance ±${TOLERANCE})\n` +
        `Update the test-count line in README.md so it reflects reality` +
        `${STRICT ? "" : " (or run `npx tsx script/checkDocs.ts --strict` to enforce)"}.`,
    );
    return;
  }

  console.log(
    `docs-lint OK: README cites ~${cited} test files, actual is ${actual} (drift ${drift} ≤ ${TOLERANCE}).`,
  );
}

main();
