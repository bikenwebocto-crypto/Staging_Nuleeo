# Olio

Property-management SaaS for owners (track properties, collect rent
through Stripe, manage tenants + agreements) and tenants (pay rent,
message landlords, view lease details). Cyprus-based, EU-first.

Live at **[oliowallet.com](https://oliowallet.com)** (marketing),
**[app.oliowallet.com](https://app.oliowallet.com)** (owners + tenants),
**[platform.oliowallet.com](https://platform.oliowallet.com)** (admin).

## Architecture

```
            ┌───────────────────────────────────────────────────┐
            │                  Firebase Hosting                 │
            │ ┌────────────┐ ┌────────────┐ ┌────────────────┐ │
            │ │ landing/   │ │   app/     │ │  platform/     │ │
            │ │ (marketing │ │ (tenants + │ │   (admin)      │ │
            │ │  static)   │ │  owners)   │ │                │ │
            │ └────────────┘ └─────┬──────┘ └────────┬───────┘ │
            └──────────────────────┼─────────────────┼─────────┘
                                   │                 │
                              /api/** rewrite to ↓
            ┌──────────────────────────────────────────────────┐
            │       Cloud Functions 2nd gen (europe-west1)     │
            │  ┌──────────────────────────────────────────┐    │
            │  │  api          — Express server           │    │
            │  │  dispatcher   — scheduled email send     │    │
            │  │  rentReminder — scheduled rent push      │    │
            │  │  rentIndexationSweep — scheduled rent     │    │
            │  │                 auto-increase            │    │
            │  │  orphanPhotoSweep — scheduled storage GC │    │
            │  │  compExpirer  — scheduled comp-plan GC   │    │
            │  │  rateLimitSweep — scheduled cache GC     │    │
            │  └──────────────────────────────────────────┘    │
            └─────────┬───────────────────────────────┬────────┘
                      │                               │
              ┌───────▼──────┐                ┌───────▼────────┐
              │  Firestore   │                │ Cloud Storage  │
              │  (deny-by-   │                │ (deny-by-      │
              │   default)   │                │  default)      │
              └──────────────┘                └────────────────┘
              ┌──────────────────────────────────────────────────┐
              │  External integrations (server-side only)        │
              │  Stripe (payments + Connect) · Resend (email) ·  │
              │  OneSignal (push) · OpenAI (Ask Olio) · Leaflet  │
              └──────────────────────────────────────────────────┘
```

**Three SPAs** (`client/landing`, `client/app`, `client/platform`) hit
**one Express API** running on Cloud Functions 2nd gen via the
`/api/**` hosting rewrite. Firestore + Storage are deny-by-default; all
reads/writes flow through the API where they're gated by `requireAuth`,
roles, and the admin-editable privilege matrix in `config/privileges`.
The narrow client-readable exceptions in `firestore.rules` are the Stripe
extension's `customers/*` subcollections, the public Stripe catalog
(`products/prices/tax_rates`), public config docs
(`config/{compliance,social,system,planLabels}`), signed-in config docs
(`config/{privileges,banners}`), and participant-only reads of
`conversations/*` + their `messages` subcollection.

For the threat model + control surface, see **[SECURITY.md](SECURITY.md)**.
For infra (deletion-protection lien, bucket lifecycle, monitoring alerts),
see **[infra/README.md](infra/README.md)**.

## Tech stack

- **Client**: React 19 + Vite (one config per SPA) · TypeScript · Tailwind 4
  · TanStack Query · Wouter · Radix UI · Framer Motion · Leaflet
  (react-leaflet) for maps
- **Server**: Express 4 (Cloud Functions 2nd gen, Node 22) · Firebase Admin
  SDK · Stripe SDK · Resend SDK · OneSignal REST
- **Data**: Firestore (denormalized; one collection per entity) · Cloud
  Storage (signed-URL gateway pattern; rules deny-by-default)
- **Auth**: Firebase Auth (email/password + Google) · custom claims
  (`stripeRole`) set by the Stripe Payments extension
- **Tests**: vitest — <!-- test-count:files --> ~85 test files (~1035 cases);
  `script/checkDocs.ts` fails CI if this file count drifts from reality
- **Build**: tsc (typecheck) · vite per-app (client bundles) · esbuild
  (server bundle). Local dev runs the server under `tsx`; production
  Cloud Functions run the `tsc`-compiled JS from `functions/lib/`
  (`functions/package.json` `build` = `tsc`, `main` = `lib/.../index.js`).

## Local development

Requirements: Node 22 + npm 10. (Match `functions/package.json`'s
`engines.node` so your local build mirrors what production runs.)

```bash
# Install everything
npm install
npm install --prefix functions

# Local dev — three terminals, one per SPA:
npm run dev:landing      # localhost on Vite's chosen port
npm run dev:app
npm run dev:platform

# Plus the API:
npm run dev              # Express on PORT or 3000
```

### Required environment variables

Drop a `.env` in the repo root (gitignored) with at minimum:

```bash
# Firebase web SDK config — public, ends up in client bundles
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=olio-wallet.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=olio-wallet
VITE_FIREBASE_STORAGE_BUCKET=olio-wallet.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_FIREBASE_MEASUREMENT_ID=...        # currently unused by client code (no Analytics reader)
VITE_ONESIGNAL_APP_ID=...

# Server-only secrets (mirror what Firebase Functions runtime has)
STRIPE_SECRET_KEY=sk_test_...             # local dev = test; production runs LIVE (Functions secret, since 2026-06-24)
STRIPE_WEBHOOK_SECRET=whsec_...           # platform "Your account" endpoint — events: account.updated, customer.subscription.{created,updated,deleted}, invoice.payment_failed
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...   # "Connected accounts" endpoint — events: checkout.session.completed, payment_intent.succeeded, charge.refunded, account.updated
RESEND_API_KEY=re_...
RESEND_FROM=hello@oliowallet.com
RESEND_WEBHOOK_SECRET=...
UNSUBSCRIBE_SECRET=long-random-value
OPENAI_API_KEY=sk-...
ONESIGNAL_REST_API_KEY=...

# Service account for local Admin SDK access
GOOGLE_APPLICATION_CREDENTIALS=./server/secrets/serviceAccountKey.json
```

In production these come from Firebase Functions secrets
(`firebase functions:secrets:set NAME --project olio-wallet`) — never
commit a `.env` or service-account JSON. `.gitignore` already excludes
`server/secrets/**` and `.env*`.

## Project layout

```
client/
  landing/    — Marketing SPA (oliowallet.com)
  app/        — Tenant + owner SPA (app.oliowallet.com)
  platform/   — Admin SPA (platform.oliowallet.com)
  shared/     — Components / hooks / lib reused across all three

server/
  app.ts         — Express bootstrap, middleware, security headers
  auth.ts        — requireAuth + Firebase ID-token verification
  routes.ts      — Top-level API router that wires in the domain
                   sub-routers (~275 lines after the split below)
  routes/        — Sub-routers extracted by domain (stripeWebhook,
                   emailMarketing, notifications, messages)
  services/      — Reusable business logic — every one has tests
  jobs/          — Scheduled-function tick bodies

functions/
  src/index.ts   — Firebase Functions 2nd gen entry points

shared/
  firestore-schema.ts — entity types + default privilege/plan/compliance
                        configs shared between client + server

infra/             — gcloud / gsutil / monitoring config (apply manually)
firestore.rules    — deny-by-default + narrow allow paths for the Stripe
                     extension's `customers/*` subcollections
storage.rules      — pure deny-by-default; uploads happen via signed URLs
```

## Testing

```bash
npm test           # one-shot
npm run test:watch # watch mode
```

Every security primitive has a focused test file (see the test-coverage
section in [SECURITY.md](SECURITY.md)). Adding a new one? Mirror the
shape — extract to a service, write tests against the pure surface,
keep the regression set explicit so a future refactor can't quietly
re-open whatever hole the primitive defends against.

The CI workflow (`.github/workflows/ci.yml`) runs `npm run check` + `npm
test` + `npm run build` + the functions build on every push/PR. The
deploy workflow (`.github/workflows/deploy.yml`) triggers via
`workflow_run` only after CI succeeds on main — it does NOT re-run
typecheck/test (it trusts that gate) and runs only the client + server +
functions builds, then `firebase deploy`. Gated on the `production`
environment for secret access.

## Deploying

```bash
git push origin main
```

That's it — Firebase deploy fires from the workflow, ships hosting +
functions + Firestore rules + Storage rules in one atomic deploy.
Track at the GitHub Actions **Deploy to Firebase** workflow.

**Infra** that lives OUTSIDE the deploy pipeline (deletion-protection
lien, bucket lifecycle, Cloud Monitoring policies) is documented in
[infra/README.md](infra/README.md). Apply once with `gcloud` / `gsutil`
when introducing each item.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow + commit-style
conventions + the test bar.

## Security

Report vulnerabilities to **security@oliowallet.com** — please don't
open a public GitHub issue, they're indexed by attackers within hours.
See [SECURITY.md](SECURITY.md) for the full threat model + disclosure
policy.

## License

MIT — see package.json. (Source-available repo for the Olio team;
external contributions out of scope today.)
