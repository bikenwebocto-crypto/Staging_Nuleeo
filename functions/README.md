# functions — Firebase Functions (2nd gen)

The deployable backend. Wraps the Express API as a single HTTPS function and adds
the scheduled (cron) jobs. Runtime: Node 22, region `europe-west1`, project
`olio-wallet`.

## What lives here

- `src/index.ts` — entry. Exports the `api` HTTPS function (built from
  `server/app` via `createApp`) plus the scheduled functions; declares the
  Stripe / Resend / OpenAI / OneSignal secrets bound at runtime.
- `src/rentReminders.ts`, `src/rentIndexation.ts` — daily rent-cycle + auto rent-increase sweeps.
- `src/emailDispatch.ts` — scheduled Resend campaign dispatcher.
- `src/orphanPhotoSweep.ts` — Storage cleanup sweep.
- `lib/` — compiled `tsc` output (the deployed JS; `main` → `lib/functions/src/index.js`).

Business logic is imported from the repo's `server/` and `shared/` — this package
is mostly the Functions wrapper + schedulers.

## Run / build (in `functions/`)

```bash
npm run build      # tsc → lib/
npm run serve      # build, then firebase emulators:start --only functions
npm run lint       # tsc --noEmit type-check
```

## How it fits

The `api` function is the single backend for both signed-in SPAs: Hosting on
`app` and `platform` rewrites `/api/**` to it. The three Vite SPAs are deployed
separately as static Hosting sites.
