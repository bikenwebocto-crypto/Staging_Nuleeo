# client/app — User SPA (`app.oliowallet.com`)

The signed-in product for property owners and tenants. A single React + Vite SPA
that switches between the **owner** and **tenant** experiences in-app (no
cross-subdomain redirect — staff cross to `platform` manually).

## What lives here

- `index.html` — Vite HTML entry; loads `/src/main.tsx`.
- `src/main.tsx` — mounts `<App />` into `#root` inside an `ErrorBoundary`.
- `src/App.tsx` — wouter router; every page is `lazy()`-loaded and persona-bucketed (owner/tenant) for background prefetch.
- `src/pages/` — route screens (`owner/`, common, marketplace, network).
- `src/components/`, `src/lib/` — app-local UI and helpers.

Shared UI/logic comes from `client/shared` via the `@ui` (and `@shared`) aliases;
`@` resolves to this package's `src`.

## Run / build (from repo root)

```bash
npm run dev:app      # vite dev server on http://localhost:5102, /api → :5001
npm run build:app    # → dist/app
```

## How it fits

One of three Vite SPAs (landing / app / platform). It talks to the Express API
under `/api/**`, which Firebase Hosting rewrites to the `api` Cloud Function
(europe-west1). In dev, Vite proxies `/api` to the local Express server on `:5001`.
