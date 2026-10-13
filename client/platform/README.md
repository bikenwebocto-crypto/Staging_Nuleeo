# client/platform — Admin SPA (`platform.oliowallet.com`)

The internal admin console for Olio staff (admins / superadmins): users,
portfolios, agreements, marketplace, transactions, partners, audit logs, email +
push marketing. Separate subdomain from the user app — `app` never auto-redirects
anyone here; staff navigate over manually.

## What lives here

- `index.html` — Vite HTML entry; loads `/src/main.tsx`.
- `src/main.tsx` — mounts `<App />` into `#root`.
- `src/App.tsx` — wouter router; every admin page is `lazy()`-loaded into its own chunk and warmed in the background after mount.
- `src/pages/` — `Admin*Page` screens; `src/features/`, `src/components/`, `src/lib/` — admin-local code.

Shared UI/logic comes from `client/shared` via the `@ui` (and `@shared`) aliases;
`@` resolves to this package's `src`.

## Run / build (from repo root)

```bash
npm run dev:platform     # vite dev server on http://localhost:5103, /api → :5001
npm run build:platform   # → dist/platform
```

## How it fits

One of three Vite SPAs (landing / app / platform). Reads/writes through the
Express API under `/api/**` (Hosting rewrite → `api` Cloud Function, europe-west1;
Vite proxies `/api` to local Express `:5001` in dev). Admin authority is
server-enforced — the client privileges check is UI-only.
