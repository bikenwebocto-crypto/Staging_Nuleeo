// Keyboard skip link — the first focusable element on the page. Visually hidden
// until focused (Tab), then appears top-left as a button; activating it jumps
// focus to the <main> landmark (id="main-content", rendered by MainRegion) so
// keyboard + screen-reader users can bypass the sidebar/header on every page.
export function SkipToContent() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
    >
      Skip to main content
    </a>
  );
}
