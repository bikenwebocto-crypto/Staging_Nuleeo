# script — build + one-off operational scripts

Standalone `tsx` scripts: the production server build plus admin/migration/
diagnostic tools run by hand. Not part of the deployed app.

## What lives here

- `build.ts` — bundles `server/index.ts` → `dist/index.cjs` with esbuild (the
  server half of `npm run build`; the SPAs are built by their Vite configs).
- `promote-user.ts` — grant a user admin/superadmin roles.
- `add-authorized-domains.ts` — add hostnames to Firebase Auth's authorized-domain allowlist.
- `migrateDraftAgreements.ts`, `seedIndexationDates.ts`, `backfillRentTransactionType.ts` — one-off data migrations.
- `checkPropertyImage.ts`, `checkSortFieldCoverage.ts` — read-only diagnostics.
- `symbolicate.ts` — de-minify a production `client.error` stack from Cloud Logging
  using the deploy's private sourcemap artifact. Download the maps, then pipe the
  stack in:

  ```bash
  gh run download <deploy-run-id> -n sourcemaps-<sha> -D ./_sourcemaps
  pbpaste | npx tsx script/symbolicate.ts --maps ./_sourcemaps
  ```

  Read prod crashes with:
  `gcloud logging read 'jsonPayload.event="client.error"' --project=olio-wallet --freshness=7d`.

## Run

The build script runs via the root npm script:

```bash
npm run build:server     # tsx script/build.ts → dist/index.cjs
```

The migration/diagnostic scripts are run directly with `tsx` from the repo root.
They authenticate to Firestore via `server/secrets/serviceAccountKey.json` + `.env`
(not gcloud) and load `import "dotenv/config"` first. Dry-run first, then re-run
with `--commit`; see each file's header comment for its exact usage and flags.

## How it fits

`build.ts` produces the server bundle that the `api` Cloud Function /
`npm start` runs. The other scripts are out-of-band Admin-SDK tools against the
`olio-wallet` project — never wired into request handling.
