import { build as esbuild } from "esbuild";
import { readFile } from "fs/promises";

// Server deps to bundle into dist/index.cjs (instead of leaving external).
// Reduces openat(2) syscalls on cold start. Only list packages that are
// actually imported from server/ — putting an unused package here is a no-op,
// but stale entries make this file misleading. Verify with:
//   grep -rE "from ['\"]<pkg>['\"]" server shared
const allowlist = ["express", "openai", "stripe"];

async function buildAll() {
  // Frontends are built by per-app Vite configs; this script only builds the server.
  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
