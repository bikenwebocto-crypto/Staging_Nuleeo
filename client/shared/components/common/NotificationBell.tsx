import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bell } from "lucide-react";

// Shared header-bell shell for every persona's notification panel (the user
// app's pending-decisions bell, the admin platform's new-lead bell, …). It owns
// the trigger button, the unread dot, open/close, click-outside, and — crucially
// — the dropdown POSITIONING: the panel is portaled to document.body and fixed
// under the bell, clamped to the viewport, so the layout's `overflow-x-hidden`
// scroll column can never clip it on a narrow window. Consumers supply only the
// count + the rows.
//
// `children` is a render prop receiving `close` so a row that navigates away can
// dismiss the panel: <NotificationBell count={n}>{(close) => rows}</NotificationBell>
interface NotificationBellProps {
  count: number;
  title?: string;
  subtitle?: string;
  emptyTitle?: string;
  emptySubtitle?: string;
  size?: "desktop" | "mobile";
  children: (close: () => void) => ReactNode;
}

export function NotificationBell({
  count,
  title = "Notifications",
  subtitle = "Requests that need your decision.",
  emptyTitle = "You're all caught up",
  emptySubtitle = "No new notifications.",
  size = "desktop",
  children,
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Viewport-fixed coordinates for the (portaled) panel. Rendered at
  // document.body so no overflow ancestor can clip it — see placement effect.
  const [coords, setCoords] = useState<{ top: number; right: number; maxWidth: number } | null>(
    null,
  );
  const hasUnread = count > 0;
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      const t = e.target as Node;
      // The panel is portaled out of this wrapper, so check it separately —
      // otherwise clicks inside the panel would read as "outside" and close it.
      const inWrapper = wrapperRef.current?.contains(t);
      const inPanel = panelRef.current?.contains(t);
      if (!inWrapper && !inPanel) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  // Anchor the panel under the bell, aligned to its right edge, and clamp the
  // width to the viewport so it can never overflow off-screen or be clipped by
  // the layout's overflow column on a narrow window. useLayoutEffect (not
  // useEffect) + clearing coords on close means it positions synchronously
  // BEFORE paint, so reopening never flashes a frame at stale coordinates.
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const place = () => {
      const r = wrapperRef.current?.getBoundingClientRect();
      if (!r) return;
      const right = Math.max(8, window.innerWidth - r.right);
      setCoords({
        top: r.bottom + 8,
        right,
        maxWidth: Math.max(0, window.innerWidth - right - 8),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const buttonClass =
    size === "desktop"
      ? "w-9 h-9 rounded-full flex items-center justify-center border border-border hover:bg-muted/60 transition text-muted-foreground hover:text-foreground"
      : "w-10 h-10 rounded-full backdrop-blur-xl flex items-center justify-center transition-all active:scale-95 border";

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={hasUnread ? `${title} (${count})` : title}
        className={buttonClass}
      >
        <Bell size={17} strokeWidth={2} />
        {hasUnread && (
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500 ring-2 ring-background" />
        )}
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: "fixed",
              top: coords.top,
              right: coords.right,
              maxWidth: coords.maxWidth,
              maxHeight: `calc(var(--app-vh) - ${coords.top + 16}px)`,
            }}
            className="w-[22rem] bg-card rounded-xl border border-border shadow-lg z-[60] overflow-hidden flex flex-col"
          >
            <div className="px-4 py-3 border-b border-border/60 shrink-0">
              <div className="text-sm font-semibold text-foreground">{title}</div>
              <div className="text-xs text-muted-foreground">{subtitle}</div>
            </div>

            {count === 0 ? (
              <div className="px-4 py-8 text-center">
                <div className="mx-auto w-10 h-10 rounded-full bg-muted/60 flex items-center justify-center mb-2">
                  <Bell size={18} className="text-muted-foreground" />
                </div>
                <div className="text-sm font-medium text-foreground">{emptyTitle}</div>
                <div className="text-xs text-muted-foreground mt-1">{emptySubtitle}</div>
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-border/60">
                {children(close)}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
