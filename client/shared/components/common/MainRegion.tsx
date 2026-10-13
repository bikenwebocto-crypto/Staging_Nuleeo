import { useEffect, useRef, type ReactNode } from "react";
import { useLocation } from "wouter";

// The page's <main> landmark + route-change focus management.
//
// - Gives every page a single `main` landmark (id="main-content") so screen
//   readers can jump to content and the SkipToContent link has a target.
// - On client-side navigation, SPAs leave keyboard/SR focus stranded on the
//   just-clicked link (or nowhere), so the next Tab restarts from the top of
//   the nav. Here we move focus to the main region on each route change so
//   users land in the new page's content. tabIndex={-1} makes it programmatically
//   focusable without joining the tab order; outline-none avoids a jarring
//   full-region ring (the SR announcement + content change is the feedback).
// - The initial mount is skipped so we don't yank focus on first load.
export function MainRegion({ children, className }: { children: ReactNode; className?: string }) {
  const [location] = useLocation();
  const ref = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    // preventScroll: don't disturb the app's own scroll behavior — this is
    // about WHERE focus is, not the viewport position.
    ref.current?.focus({ preventScroll: true });
  }, [location]);

  return (
    <main
      id="main-content"
      ref={ref}
      tabIndex={-1}
      className={className ? `outline-none ${className}` : "outline-none"}
    >
      {children}
    </main>
  );
}
