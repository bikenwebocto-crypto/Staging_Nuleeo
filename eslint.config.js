// ESLint 9/10 flat config (ESM). Intentionally NON-type-checked:
// we use typescript-eslint's `recommended` (syntax-only) rather than
// `recommendedTypeChecked`/projectService. Type-aware linting is slow and
// brittle across the five tsconfigs in this repo (root + client/{landing,
// app,platform} + functions) and would emit "file not in project" errors
// for scripts and configs. The four `tsc` passes in `npm run check`
// already provide full type coverage; this lint gate catches lint-only
// issues (unused vars, hooks rules, etc.).
//
// eslint-config-prettier is applied LAST so it switches off every
// formatting-related rule — Prettier owns formatting, ESLint owns logic.
//
// Severity strategy (see CI-1): rules that the existing ~79k-line codebase
// already passes clean stay at "error" so NEW violations redden CI. Rules
// with a pre-existing backlog are downgraded to "warn" below — warnings do
// not fail `eslint .`, so the gate is green today while still surfacing the
// backlog. Inline `eslint-disable` comments remain meaningful.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // Paths ESLint must never look at. Globs here apply repo-wide.
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "functions/lib/**",
      "functions/node_modules/**",
      "coverage/**",
      ".firebase/**",
      "server/public/**",
      "branding/**",
      "emails/**",
      "**/public/**",
      // Build/tool config files are plain Node scripts, not app code.
      "**/*.config.js",
      "**/*.config.ts",
      "**/*.config.cjs",
      "**/*.config.mjs",
      "vitest.config.ts",
      "postcss.config.*",
      "tailwind.config.*",
    ],
  },

  // Base JS + TS recommended (syntax-only, no type info).
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // React hooks rules apply to the client TSX (and any hook-using TS).
  {
    files: ["client/**/*.{ts,tsx}", "shared/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // eslint-plugin-react-hooks v7's "recommended" preset now bundles the full
      // React Compiler rule set (~14 new rules — immutability / purity / refs /
      // set-state-in-render / static-components / etc., mostly "error"). Opting
      // into those is a separate, deliberate decision, NOT a side effect of an
      // ESLint major bump, so we keep enforcing exactly the two classic hooks
      // rules this repo already gates on. Revisit the compiler rules (likely
      // staged in as "warn") as its own task.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Fast-refresh hygiene: warn only — many files legitimately export
      // constants alongside components and we are not rewriting them.
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },

  // Severity tuning for the existing backlog. These rules report against
  // current code, so they are warnings (non-fatal) rather than errors.
  // Keeping them on (as warn) means the violations stay visible; flipping
  // any of them back to "error" later would be a deliberate cleanup task.
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      "@typescript-eslint/no-this-alias": "warn",
      // `declare global { namespace Express { interface Request } }` in
      // server/auth.ts is the canonical Express type-augmentation idiom and
      // cannot be expressed as an ES2015 module — keep the rule on as a warn.
      "@typescript-eslint/no-namespace": "warn",
      "no-empty": "warn",
      "no-useless-escape": "warn",
      "no-control-regex": "warn",
      "no-prototype-builtins": "warn",
      "no-cond-assign": "warn",
      "no-fallthrough": "warn",
      "no-case-declarations": "warn",
      "no-async-promise-executor": "warn",
      "no-constant-condition": "warn",
      // New in ESLint 10's recommended set; the codebase has a small pre-existing
      // backlog (6 dead assignments across 4 files). Downgraded to "warn" per the
      // backlog strategy above — surfaced, non-fatal; flip back to "error" after a
      // cleanup pass.
      "no-useless-assignment": "warn",
    },
  },

  // Node/CommonJS-ish scripts and the server may use `require`-free ESM
  // but reference Node globals; nothing special needed beyond the above.

  // MUST be last: turn off all formatting rules (Prettier owns those).
  prettier,
);
