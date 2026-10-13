// symbolicate.ts — turn a minified production client.error stack (the kind that
// lands in Cloud Logging via reportClientError) back into original source
// locations, using the sourcemaps the deploy uploaded as a private artifact.
//
// WHY: prod bundles are minified and we ship sourcemaps as `hidden` (generated
// but never served), so a Cloud Logging stack looks like
//   mr@https://app.oliowallet.com/assets/index-4npgxIfa.js:759:112283
// This resolves each such frame to e.g. client/app/src/pages/.../Foo.tsx:120:7.
//
// USAGE:
//   1. Get the maps for the relevant deploy. Prod = the latest Deploy run:
//        gh run list --workflow "Deploy to Firebase" --limit 1   # find the run id
//        gh run download <run-id> -n sourcemaps-<head_sha> -D ./_sourcemaps
//      (artifact name is `sourcemaps-<commit-sha>`; tab-complete or list with
//       `gh run view <run-id>`). Any folder layout works — it searches recursively.
//   2. Pipe the stack in (copy jsonPayload.stack from Cloud Logging):
//        pbpaste | npx tsx script/symbolicate.ts --maps ./_sourcemaps
//      or read it from a file:
//        npx tsx script/symbolicate.ts --maps ./_sourcemaps --file stack.txt
//
//   With no --maps it looks in ./_sourcemaps then ./dist (handy right after a
//   local `npm run build:app`).
//
// Zero dependencies: uses Node's built-in SourceMap (node:module). findEntry is
// 0-indexed for input and output; browser stack frames are 1-indexed for both
// line and column, so we query findEntry(line-1, col-1) and display +1.

import { SourceMap } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv: string[]): { mapsDir: string; file: string } {
  let mapsDir = "";
  let file = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--maps") mapsDir = argv[++i] ?? "";
    else if (argv[i] === "--file") file = argv[++i] ?? "";
  }
  return { mapsDir, file };
}

// Recursively index every *.js.map under `dir`, keyed by the chunk filename it
// maps (e.g. "index-4npgxIfa.js" -> "/abs/path/index-4npgxIfa.js.map"). Chunk
// names are content-hashed, so a name uniquely identifies its map regardless of
// which app subfolder it came from.
function findMapFiles(dir: string, acc: Record<string, string> = {}): Record<string, string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) findMapFiles(full, acc);
    else if (name.endsWith(".js.map")) acc[name.slice(0, -4)] = full; // strip ".map"
  }
  return acc;
}

// Matches the chunk + position in a stack frame, in any browser's format:
//   Safari/FF:  fn@https://host/assets/index-abc.js:759:112283
//   Chrome:     at fn (https://host/assets/index-abc.js:759:112283)
const FRAME_RE = /\/assets\/([A-Za-z0-9_.-]+\.js):(\d+):(\d+)/;

function fnNameOf(line: string): string {
  const chrome = line.match(/\bat\s+([^\s(]+)\s*\(/);
  if (chrome) return chrome[1];
  const safari = line.match(/^\s*([^@\s]+)@/);
  if (safari && safari[1] !== "@") return safari[1];
  return "";
}

function main(): void {
  const { mapsDir, file } = parseArgs(process.argv.slice(2));
  const dirs = mapsDir ? [mapsDir] : ["./_sourcemaps", "./dist"];

  let index: Record<string, string> = {};
  let usedDir = "";
  for (const d of dirs) {
    const found = findMapFiles(d);
    if (Object.keys(found).length) {
      index = found;
      usedDir = d;
      break;
    }
  }
  if (!Object.keys(index).length) {
    console.error(`No *.js.map files found in: ${dirs.join(", ")}`);
    console.error("Download them first, e.g.:");
    console.error("  gh run download <deploy-run-id> -n sourcemaps-<sha> -D ./_sourcemaps");
    process.exit(1);
  }
  console.error(`# loaded ${Object.keys(index).length} sourcemaps from ${usedDir}\n`);

  const input = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
  if (!input.trim()) {
    console.error("No stack input. Pipe the stack in (pbpaste | …) or pass --file <path>.");
    process.exit(1);
  }

  // Lazily build + cache one SourceMap per chunk (null = chunk has no map).
  const cache = new Map<string, SourceMap | null>();
  const getMap = (chunk: string): SourceMap | null => {
    if (cache.has(chunk)) return cache.get(chunk) ?? null;
    let sm: SourceMap | null = null;
    const path = index[chunk];
    if (path) {
      try {
        sm = new SourceMap(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        sm = null;
      }
    }
    cache.set(chunk, sm);
    return sm;
  };

  const missing = new Set<string>();
  let resolved = 0;
  for (const raw of input.split("\n")) {
    const m = raw.match(FRAME_RE);
    if (!m) {
      console.log(raw); // not a chunk frame (e.g. the error message line) — echo it
      continue;
    }
    const chunk = m[1];
    const line = Number(m[2]);
    const col = Number(m[3]);
    const sm = getMap(chunk);
    if (!sm) {
      missing.add(chunk);
      console.log(`${raw}   ⟶  (no map for ${chunk})`);
      continue;
    }
    const entry = sm.findEntry(line - 1, col - 1);
    if (entry && entry.originalSource) {
      const fn = entry.name || fnNameOf(raw) || "<anonymous>";
      const src = String(entry.originalSource).replace(/^(?:\.\.\/)+/, "");
      console.log(`${fn}  ⟶  ${src}:${entry.originalLine + 1}:${entry.originalColumn + 1}`);
      resolved++;
    } else {
      console.log(`${raw}   ⟶  (unmapped ${chunk}:${line}:${col})`);
    }
  }

  console.error(`\n# resolved ${resolved} frame(s)`);
  if (missing.size) {
    console.error(`# no map for: ${[...missing].join(", ")}`);
    console.error("# (stack is likely from a different build than the downloaded artifact)");
  }
}

main();
