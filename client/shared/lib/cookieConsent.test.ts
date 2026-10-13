import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getCookieConsent,
  setCookieConsent,
  hasCookieConsent,
  setFunctionalStorage,
  reopenCookieConsent,
  onCookieConsentChange,
  COOKIE_CONSENT_VERSION,
} from "./cookieConsent";

// happy-dom's built-in localStorage needs a backing file in this env, so stub a
// simple in-memory one per test (window events still come from happy-dom).
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cookieConsent", () => {
  it("returns null before a decision (so the banner shows)", () => {
    expect(getCookieConsent()).toBeNull();
  });

  it("grants `necessary` always, and default-denies others before a decision", () => {
    expect(hasCookieConsent("necessary")).toBe(true);
    expect(hasCookieConsent("functional")).toBe(false);
    expect(hasCookieConsent("analytics")).toBe(false);
  });

  it("persists an 'essential only' decision (non-essential stays denied)", () => {
    setCookieConsent({ functional: false, analytics: false });
    const c = getCookieConsent();
    expect(c?.version).toBe(COOKIE_CONSENT_VERSION);
    expect(c?.categories).toEqual({ necessary: true, functional: false, analytics: false });
    expect(hasCookieConsent("necessary")).toBe(true);
    expect(hasCookieConsent("analytics")).toBe(false);
  });

  it("persists 'accept all' and grants the categories", () => {
    setCookieConsent({ functional: true, analytics: true });
    expect(hasCookieConsent("functional")).toBe(true);
    expect(hasCookieConsent("analytics")).toBe(true);
  });

  it("reopen clears the decision so the banner shows again", () => {
    setCookieConsent({ functional: true, analytics: true });
    expect(getCookieConsent()).not.toBeNull();
    reopenCookieConsent();
    expect(getCookieConsent()).toBeNull();
  });

  it("treats a stale-version stored decision as undecided (re-prompt)", () => {
    localStorage.setItem(
      "olio-cookie-consent",
      JSON.stringify({
        version: COOKIE_CONSENT_VERSION + 1,
        decidedAt: "x",
        categories: { necessary: true, functional: true, analytics: true },
      }),
    );
    expect(getCookieConsent()).toBeNull();
  });

  it("setFunctionalStorage writes ONLY with functional consent", () => {
    // Before any decision (default-deny) → not persisted.
    setFunctionalStorage("theme", "dark");
    expect(localStorage.getItem("theme")).toBeNull();

    // Functional denied → still not persisted.
    setCookieConsent({ functional: false, analytics: false });
    setFunctionalStorage("theme", "dark");
    expect(localStorage.getItem("theme")).toBeNull();

    // Functional granted → persisted.
    setCookieConsent({ functional: true, analytics: false });
    setFunctionalStorage("theme", "dark");
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("withdrawing functional consent clears already-set functional storage", () => {
    setCookieConsent({ functional: true, analytics: false });
    setFunctionalStorage("theme", "dark");
    expect(localStorage.getItem("theme")).toBe("dark");

    // Withdraw → the theme cookie is removed.
    setCookieConsent({ functional: false, analytics: false });
    expect(localStorage.getItem("theme")).toBeNull();
  });

  it("notifies subscribers on set + reopen, and stops after unsubscribe", () => {
    const cb = vi.fn();
    const off = onCookieConsentChange(cb);
    setCookieConsent({ functional: true, analytics: true });
    reopenCookieConsent();
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    setCookieConsent({ functional: false, analytics: false });
    expect(cb).toHaveBeenCalledTimes(2); // not called after unsubscribe
  });
});
