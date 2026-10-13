import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Menu, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Logo } from "@ui/components/Logo";
import { appUrl } from "@/lib/appUrl";

const navLinks = [
  { label: "Features", href: "#features" },
  { label: "How it Works", href: "#how-it-works" },
  { label: "Pricing", href: "#pricing" },
];

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  const goToApp = (path: string = "/auth") => {
    window.location.assign(appUrl(path));
  };

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The mobile-menu overlay is a modal dialog. While it's open we: lock body
  // scroll; mark the rest of the page (#root) inert so neither Tab nor a
  // screen reader's virtual cursor can reach the content behind it; move focus
  // into the overlay; trap Tab within it; close on Escape; auto-close if the
  // viewport grows to desktop (the menu is mobile-only); and restore focus to
  // the hamburger on close. The overlay is portaled to <body> (see render) so
  // it lives OUTSIDE the inert #root and stays interactive.
  useEffect(() => {
    if (!menuOpen) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    // Captured once: the hamburger node is stable for the menu's lifetime, and
    // the cleanup needs the same element it had at open time.
    const hamburger = hamburgerRef.current;

    const focusable = () =>
      Array.from(
        overlay.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled"));

    // Move focus to the first control (the Close button) on open.
    focusable()[0]?.focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const els = focusable();
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    // Auto-close if the viewport crosses to desktop while open — the overlay is
    // mobile-only and would otherwise linger over the desktop layout.
    const desktopMq = window.matchMedia("(min-width: 768px)");
    const onDesktop = (e: MediaQueryListEvent) => {
      if (e.matches) setMenuOpen(false);
    };
    desktopMq.addEventListener("change", onDesktop);

    // Make everything behind the overlay inert (removed from tab order AND the
    // accessibility tree) so aria-modal is truthful. The overlay is portaled
    // outside #root, so it remains reachable.
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    root?.setAttribute("aria-hidden", "true");

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      desktopMq.removeEventListener("change", onDesktop);
      root?.removeAttribute("inert");
      root?.removeAttribute("aria-hidden");
      document.body.style.overflow = prevOverflow;
      // Return focus to the trigger, but only if focus is still inside the
      // overlay (closed via X / Escape / nav link) — don't yank it otherwise.
      if (overlay.contains(document.activeElement)) {
        hamburger?.focus({ preventScroll: true });
      }
    };
  }, [menuOpen]);

  const scrollTo = (id: string) => {
    setMenuOpen(false);
    document.querySelector(id)?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <>
      <nav
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 pt-[env(safe-area-inset-top)] ${
          scrolled
            ? "bg-white/80 dark:bg-black/80 backdrop-blur-xl border-b border-black/5 dark:border-white/10 shadow-sm"
            : "bg-transparent"
        }`}
      >
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between h-16">
          <button
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            className="flex items-center transition-opacity duration-300 hover:opacity-80"
            aria-label="Olio home"
          >
            <Logo variant="wordmark" color={scrolled ? "auto" : "white"} className="h-7 w-auto" />
          </button>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => (
              <button
                key={link.href}
                onClick={() => scrollTo(link.href)}
                className={`text-sm font-medium transition-colors duration-300 ${
                  scrolled
                    ? "text-muted-foreground hover:text-foreground"
                    : "text-white/80 hover:text-white"
                }`}
              >
                {link.label}
              </button>
            ))}
          </div>

          {/* Desktop CTA */}
          <div className="hidden md:flex items-center gap-3">
            <button
              onClick={() => goToApp()}
              className={`text-sm font-medium px-4 py-2 rounded-full transition-all duration-300 ${
                scrolled ? "text-foreground hover:bg-secondary" : "text-white/90 hover:text-white"
              }`}
            >
              Sign In
            </button>
            <button
              onClick={() => goToApp()}
              className={`text-sm font-semibold px-5 py-2 rounded-full transition-all duration-300 ${
                scrolled
                  ? "bg-black dark:bg-white text-white dark:text-black hover:opacity-90"
                  : "bg-white text-black hover:bg-white/90"
              }`}
            >
              Get Started
            </button>
          </div>

          {/* Mobile hamburger */}
          <button
            ref={hamburgerRef}
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Open navigation menu"
            aria-expanded={menuOpen}
            aria-controls="mobile-nav-menu"
            className={`md:hidden p-2 transition-colors ${
              scrolled ? "text-foreground" : "text-white"
            }`}
          >
            <Menu size={24} />
          </button>
        </div>
      </nav>

      {/* Mobile menu overlay — portaled to <body> so it sits outside the
          #root we mark inert while it's open. md:hidden is a belt-and-braces
          with the matchMedia auto-close: the menu never shows at desktop. */}
      {createPortal(
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              ref={overlayRef}
              id="mobile-nav-menu"
              role="dialog"
              aria-modal="true"
              aria-label="Site navigation"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[99999] bg-black/95 backdrop-blur-xl flex flex-col items-center justify-center gap-8 md:hidden"
            >
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label="Close navigation menu"
                className="absolute top-[calc(36px+16px)] right-6 text-white p-2"
              >
                <X size={28} />
              </button>

              {navLinks.map((link) => (
                <button
                  key={link.href}
                  onClick={() => scrollTo(link.href)}
                  className="text-white text-2xl font-medium hover:text-white/70 transition-colors"
                >
                  {link.label}
                </button>
              ))}

              <div className="flex flex-col gap-3 mt-4 w-64">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    goToApp();
                  }}
                  className="w-full py-3 rounded-full border border-white/30 text-white font-semibold text-lg hover:bg-white/10 transition"
                >
                  Sign In
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    goToApp();
                  }}
                  className="w-full py-3 rounded-full bg-white text-black font-semibold text-lg hover:bg-white/90 transition"
                >
                  Get Started
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
