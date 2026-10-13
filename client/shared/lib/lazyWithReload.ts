// React.lazy wrapper that survives a deploy happening under an open tab.
//
// The problem it solves (seen in production as the "Something went wrong"
// screen): pages are code-split, so each route is its own hashed chunk loaded
// on demand via import(). When we deploy, Vite emits NEW hashed filenames and
// the OLD chunks are removed from Hosting. A user whose tab loaded the previous
// index.html still references the old chunk URLs; navigating to a lazy route
// requests a file that no longer exists. Under our SPA rewrite (** -> index.html)
// that 404 comes back as index.html — i.e. HTML — so the browser refuses to run
// it as a module ("'text/html' is not a valid JavaScript MIME type" in Safari,
// "Failed to fetch dynamically imported module" in Chrome/Firefox). React.lazy
// has no Suspense-level error handling, so the rejection bubbles to the root
// ErrorBoundary and the user sees a crash instead of their page.
//
// Fix: when a chunk import fails with that signature, do a hard reload. Because
// index.html is served no-cache (see firebase.json), the reload fetches the
// fresh HTML, which points at the new chunk URLs, and the user lands on the page
// they wanted — no visible error.
//
// Loop safety (this is the subtle part): a *genuinely broken* deploy — index.html
// referencing a chunk that 404s even after reload — must NOT reload forever. We
// bound this with a sessionStorage reload counter rather than wall-clock time:
//   - A SUCCESSFUL chunk load clears the streak counter, so a long-lived tab
//     that self-heals from one deploy gets a fresh budget for the next.
//   - The streak counter caps auto-reloads per unhealthy streak; once exhausted
//     we let the error reach the ErrorBoundary (the user gets a Reload button).
//   - A separate per-tab lifetime counter is NEVER cleared, as an absolute
//     backstop: even in some pathological success/fail oscillation it guarantees
//     termination. Both are immune to slow cold boots — there is no timer to
//     race, unlike a wall-clock window (which re-permits reloads once enough time
//     has passed and can loop on slow clients).
//
// Note: this wraps ONLY the lazy component used for real navigation. Background
// route prefetching (PreloadRoutes) calls the raw loader with its own silent
// .catch, so a speculative prefetch hitting a stale chunk never forces a reload.

import { lazy, type ComponentType } from "react";

// Matches the various ways browsers report a failed dynamic import of a chunk
// that no longer exists (or came back as HTML under the SPA rewrite). Exported
// for unit testing — it must catch the real deploy-stale-chunk errors WITHOUT
// misclassifying unrelated app crashes (which should reach the ErrorBoundary,
// not trigger a reload).
export function isChunkLoadError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  return (
    msg.includes("dynamically imported module") || // Chrome / Firefox
    msg.includes("error loading dynamically") ||
    msg.includes("failed to fetch") ||
    msg.includes("importing a module script failed") || // Safari
    msg.includes("not a valid javascript mime type") || // Safari — our exact prod error
    msg.includes("text/html") ||
    msg.includes("chunkloaderror")
  );
}

// Auto-reloads allowed per unhealthy streak (cleared by any successful chunk
// load). A stale chunk needs exactly one reload to fix; 2 leaves slack for a
// transient failure during the reload itself.
const MAX_STREAK_RELOADS = 2;
// Absolute ceiling per tab session, never cleared — the loop backstop.
const MAX_LIFETIME_RELOADS = 5;

const STREAK_KEY = "olio:chunkReloadStreak";
const LIFETIME_KEY = "olio:chunkReloadLifetime";

// Read a counter, returning a value >= the cap when sessionStorage is
// unavailable (e.g. Safari Private Browsing) so decideChunkAction falls through
// to "rethrow" — without storage we can't bound reloads, so we must not risk a
// loop and instead surface the ErrorBoundary's manual Reload button.
function readCount(key: string): number {
  try {
    return Number(sessionStorage.getItem(key) || 0) || 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
function bumpCount(key: string): void {
  try {
    sessionStorage.setItem(key, String((Number(sessionStorage.getItem(key) || 0) || 0) + 1));
  } catch {
    /* storage unavailable — readCount() already returns Infinity, so no reload */
  }
}
function clearStreak(): void {
  try {
    sessionStorage.removeItem(STREAK_KEY);
  } catch {
    /* ignore */
  }
}

export type ChunkAction = "reload" | "rethrow" | "hang";

// Pure decision so the loop-safety logic is unit-testable without touching
// sessionStorage, window.location, or React.
export function decideChunkAction(opts: {
  isChunk: boolean;
  reloadInFlight: boolean;
  streak: number;
  lifetime: number;
}): ChunkAction {
  if (!opts.isChunk) return "rethrow"; // a real app crash — let the ErrorBoundary show
  if (opts.reloadInFlight) return "hang"; // a sibling already triggered a reload
  if (opts.streak < MAX_STREAK_RELOADS && opts.lifetime < MAX_LIFETIME_RELOADS) return "reload";
  return "rethrow"; // budget exhausted: deploy is genuinely broken, show the error
}

// Set once we've kicked off a reload, so sibling chunk failures in the same
// frame keep Suspense up instead of flashing the error boundary for a tick.
// Resets naturally on reload (fresh JS context).
let reloadTriggered = false;

export function lazyWithReload<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    loader().then(
      (mod) => {
        // A chunk loaded fine — we're healthy. Reset the streak so a future
        // deploy in this same long-lived tab gets a fresh reload budget. The
        // lifetime backstop is intentionally NOT reset.
        clearStreak();
        return mod;
      },
      (err: unknown) => {
        if (typeof window === "undefined") throw err;
        const action = decideChunkAction({
          isChunk: isChunkLoadError(err),
          reloadInFlight: reloadTriggered,
          streak: readCount(STREAK_KEY),
          lifetime: readCount(LIFETIME_KEY),
        });
        if (action === "hang") {
          // A reload is already in flight — hang so React holds the Suspense
          // fallback rather than rendering the error for a frame.
          return new Promise<{ default: T }>(() => {});
        }
        if (action === "reload") {
          bumpCount(STREAK_KEY);
          bumpCount(LIFETIME_KEY);
          reloadTriggered = true;
          window.location.reload();
          return new Promise<{ default: T }>(() => {});
        }
        // Not a chunk error, or we've exhausted the reload budget and it still
        // fails — let it reach the ErrorBoundary so the user gets the Reload button.
        throw err;
      },
    ),
  );
}
