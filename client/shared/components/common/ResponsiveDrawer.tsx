import { ReactNode, useEffect, useId, useRef, useState } from "react";
import { Drawer } from "vaul";
import { X, ArrowLeft } from "lucide-react";
import { cn } from "@ui/lib/utils";

interface ResponsiveDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Called when back arrow is pressed. When provided, shows a back arrow left of the title. */
  onBack?: () => void;
  /** Desktop max width class, default "max-w-[480px]" */
  desktopMaxWidth?: string;
}

/**
 * Responsive drawer: bottom sheet on mobile (80vh max), centered modal on desktop (80vh max).
 * Use across the entire platform for any drawer/modal needs.
 */
export function ResponsiveDrawer({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
  footer,
  onBack,
  desktopMaxWidth = "max-w-[480px]",
}: ResponsiveDrawerProps) {
  const [isMobile, setIsMobile] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  // Desktop modal: id wires the title to aria-labelledby; ref scopes the
  // focus trap. (Mobile uses vaul's Drawer, which already traps focus + Escape.)
  const titleId = useId();
  const desktopRef = useRef<HTMLDivElement>(null);
  // Latest onOpenChange, read by the focus-trap's Escape handler. Kept in a ref
  // so the trap effect below does NOT depend on onOpenChange — most callers pass
  // an inline arrow, whose identity changes on every parent re-render. If the
  // effect depended on it, typing one key in a field inside the modal would
  // re-render the parent → new onOpenChange → effect tears down and re-runs →
  // it calls .focus() on the first focusable element, yanking the caret out of
  // the field. (Desktop only, because the trap early-returns on mobile.)
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Desktop accessibility parity with the mobile drawer: trap Tab focus inside
  // the modal, close on Escape, move initial focus in, and restore it on close.
  useEffect(() => {
    if (isMobile || !open) return;
    const node = desktopRef.current;
    if (!node) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusable = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);

    (focusable()[0] ?? node).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onOpenChangeRef.current(false);
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener("keydown", onKeyDown);
    return () => {
      node.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
    // onOpenChange intentionally excluded — read via onOpenChangeRef so the trap
    // runs once per open, not on every keystroke-induced re-render. See ref above.
  }, [isMobile, open]);

  // Track the on-screen keyboard via the Visual Viewport API so the bottom
  // sheet sits above it instead of being hidden behind it on mobile.
  useEffect(() => {
    if (!isMobile || !open) {
      setKeyboardInset(0);
      return;
    }
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const inset = window.innerHeight - vv.height - vv.offsetTop;
      setKeyboardInset(Math.max(0, inset));
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [isMobile, open]);

  // ---------- Mobile: bottom drawer ----------
  if (isMobile) {
    const mobileSize = {
      height: `min(80vh, calc(100vh - ${keyboardInset}px - 40px))`,
      maxHeight: `min(80vh, calc(100vh - ${keyboardInset}px - 40px))`,
    };
    return (
      <Drawer.Root open={open} onOpenChange={onOpenChange} repositionInputs={false} noBodyStyles>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60]" />
          <Drawer.Content
            className="fixed left-0 right-0 z-[60] outline-none"
            style={{ ...mobileSize, bottom: `${keyboardInset}px` }}
          >
            <div
              className="bg-card rounded-t-2xl border-t border-border flex flex-col overflow-hidden"
              style={mobileSize}
            >
              {/* Drag handle */}
              <div className="pt-3 pb-1 flex justify-center shrink-0">
                <div className="w-10 h-1 bg-muted-foreground/30 rounded-full" />
              </div>

              {/* Header */}
              {(title || subtitle) && (
                <div className="flex items-center justify-between px-6 pt-2 pb-4 shrink-0">
                  <div className="flex items-center gap-2">
                    {onBack && (
                      <button
                        type="button"
                        onClick={onBack}
                        aria-label="Go back"
                        className="p-1.5 -ml-1.5 hover:bg-muted rounded-lg transition"
                      >
                        <ArrowLeft size={18} className="text-muted-foreground" />
                      </button>
                    )}
                    <div>
                      {title && <h2 className="text-lg font-semibold text-foreground">{title}</h2>}
                      {subtitle && (
                        <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenChange(false)}
                    aria-label="Close"
                    className="p-2 hover:bg-muted rounded-lg transition"
                  >
                    <X size={18} className="text-muted-foreground" />
                  </button>
                </div>
              )}

              {/* Scrollable content */}
              <div className="flex-1 overflow-y-auto overscroll-contain px-6 pt-2 pb-4">
                {children}
              </div>

              {/* Footer */}
              {footer && <div className="px-6 py-5 border-t border-border shrink-0">{footer}</div>}
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  // ---------- Desktop: centered modal ----------
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />
      <div
        ref={desktopRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cn(
          "relative bg-card w-[95vw] rounded-2xl shadow-2xl flex flex-col max-h-[80vh] outline-none",
          desktopMaxWidth,
        )}
      >
        {/* Header */}
        {(title || subtitle) && (
          <div className="flex items-center justify-between px-8 py-5 border-b border-border shrink-0">
            <div className="flex items-center gap-2">
              {onBack && (
                <button
                  type="button"
                  onClick={onBack}
                  aria-label="Go back"
                  className="p-1.5 -ml-1.5 hover:bg-muted rounded-lg transition"
                >
                  <ArrowLeft size={18} className="text-muted-foreground" />
                </button>
              )}
              <div>
                {title && (
                  <h2 id={titleId} className="text-lg font-semibold text-foreground">
                    {title}
                  </h2>
                )}
                {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
              className="p-2 hover:bg-muted rounded-lg transition"
            >
              <X size={18} className="text-muted-foreground" />
            </button>
          </div>
        )}

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-8 py-7">{children}</div>

        {/* Footer */}
        {footer && <div className="px-8 py-5 border-t border-border shrink-0">{footer}</div>}
      </div>
    </div>
  );
}
