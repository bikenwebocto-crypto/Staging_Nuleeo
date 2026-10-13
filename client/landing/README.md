# client/landing — Marketing site (`oliowallet.com`)

The public, unauthenticated landing/marketing site. No API calls or auth — just
the product pitch that funnels visitors toward sign-up on the user app.

## What lives here

- `index.html` — Vite HTML entry; loads `/src/main.tsx`.
- `src/main.tsx` — mounts the React app into `#root`.
- `src/pages/LandingPage.tsx` + `src/pages/sections/` — the page and its sections.
- `src/lib/`, `src/assets/` — landing-local helpers and media.

Shared UI comes from `client/shared` via the `@ui` (and `@shared`) aliases; `@`
resolves to this package's `src`.

## Run / build (from repo root)

```bash
npm run dev:landing      # vite dev server on http://localhost:5101
npm run build:landing    # → dist/landing
```

## How it fits

One of three Vite SPAs (landing / app / platform). Unlike `app` and `platform`,
it has no `/api` proxy — it ships as static files on its own Hosting site and
links out to `app.oliowallet.com` for the signed-in product.
