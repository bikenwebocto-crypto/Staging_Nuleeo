import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

const here = import.meta.dirname;

// One Vitest project for the whole repo. Tests live next to their subjects in
// `*.test.ts(x)` files. The `@/`, `@ui/`, `@shared/` aliases mirror what each
// vite.config.ts exposes so imports look the same in src and test code.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(here, "client", "app", "src"),
      "@ui": path.resolve(here, "client", "shared"),
      "@shared": path.resolve(here, "shared"),
    },
  },
  test: {
    environment: "happy-dom",
    // happy-dom eagerly fetches external resources referenced by test HTML —
    // notably the `<iframe src="https://evil.example.com">` / `<script src>` /
    // `<link>` that sanitizeHtml.test.ts feeds through DOMPurify before stripping
    // them. Those real DNS lookups (getaddrinfo ENOTFOUND) register async tasks
    // that settle AFTER the Window is torn down ("AsyncTaskManager has been
    // destroyed"), corrupting later test files (this turned ~deterministic on
    // happy-dom 20.10.x). No test needs real resource loading — global.fetch is
    // already stubbed in tests/setup.ts — so disable external resource/iframe
    // loading at the environment level.
    environmentOptions: {
      happyDOM: {
        settings: {
          disableIframePageLoading: true,
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
          navigation: {
            disableChildFrameNavigation: true,
            disableChildPageNavigation: true,
          },
        },
      },
    },
    setupFiles: ["./tests/setup.ts"],
    globals: false,
    include: ["**/*.test.ts", "**/*.test.tsx"],
    // tests/firestore-rules/** needs the Firestore emulator (a node env, run via
    // `npm run test:rules` / CI's Firestore Rules job) — keep it out of the main
    // happy-dom suite, which has no emulator.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/functions/lib/**",
      "tests/firestore-rules/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      reportsDirectory: "./coverage",
      // Scope coverage to the tested layers — the server business logic +
      // shared code (where the ~900-case suite lives). The client SPAs are
      // thinly tested by design (a separate quality track) and would only add
      // a misleadingly-low number + noise here.
      include: ["server/**/*.ts", "shared/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*.d.ts",
        "server/index.ts", // http-listen entry; not unit-testable
      ],
      all: true,
      // Floors set ~5pts under the 2026-06-17 baseline (lines 49 / stmts 48 /
      // funcs 50 / branches 39). They catch a real regression — deleting a test
      // suite, or shipping a large untested module — without breaking the build
      // today. Raise them as coverage climbs; never lower to make a red build
      // green (fix the test gap instead).
      thresholds: {
        lines: 44,
        statements: 43,
        functions: 45,
        branches: 33,
      },
    },
  },
});
