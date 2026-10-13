import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

import { ResponsiveDrawer } from "./ResponsiveDrawer";

// Regression guard for the "every keystroke loses input focus" bug (desktop).
//
// The desktop focus-trap effect used to list `onOpenChange` in its deps. Almost
// every caller passes an inline arrow for onOpenChange, so its identity changed
// on every parent re-render — and a re-render happens on every keystroke in any
// input inside the modal. That re-ran the trap effect, whose body calls
// `.focus()` on the first focusable element, yanking the caret out of the field
// the user was typing in. It was desktop-only because the trap early-returns on
// mobile (vaul handles focus there). The fix reads onOpenChange via a ref so the
// trap runs once per open, never per keystroke.

function Drawer({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  return (
    <ResponsiveDrawer open onOpenChange={onOpenChange} title="Test">
      <input data-testid="first" />
      <input data-testid="second" />
    </ResponsiveDrawer>
  );
}

describe("ResponsiveDrawer · desktop focus stability", () => {
  beforeEach(() => {
    // Force the desktop branch (the trap is mobile-exempt). innerWidth < 768
    // would render the vaul bottom-sheet instead.
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  });
  afterEach(() => cleanup());

  it("does NOT re-grab focus when only onOpenChange identity changes (the per-keystroke bug)", () => {
    const { rerender } = render(<Drawer onOpenChange={() => {}} />);

    // Ignore the one-time initial focus-on-open; only watch what happens after.
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");

    // A brand-new inline onOpenChange == exactly what a keystroke-driven parent
    // re-render passes. Pre-fix this re-ran the trap and called .focus() again.
    rerender(<Drawer onOpenChange={() => {}} />);

    expect(focusSpy).not.toHaveBeenCalled();
    focusSpy.mockRestore();
  });

  it("Escape closes via the LATEST onOpenChange (ref, not a stale closure)", () => {
    const stale = vi.fn();
    const { rerender } = render(<Drawer onOpenChange={stale} />);

    const latest = vi.fn();
    rerender(<Drawer onOpenChange={latest} />);

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    fireEvent.keyDown(dialog!, { key: "Escape" });

    expect(latest).toHaveBeenCalledWith(false);
    expect(stale).not.toHaveBeenCalled();
  });
});
