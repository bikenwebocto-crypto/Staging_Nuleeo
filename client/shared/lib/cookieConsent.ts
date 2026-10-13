// Cookie-consent state (ePrivacy / Cookie Policy). Persisted client-side in
// localStorage — the consent record itself is strictly-necessary.
//
// Olio sets only essential storage (auth/session), a functional theme
// preference, and opt-in push; there are NO advertising or third-party
// analytics cookies today. So this is mainly the consent MECHANISM + the gate
// any future non-essential tech must check via hasCookieConsent(category).
// CookieConsentBanner shows on first visit (or after a COOKIE_CONSENT_VERSION
// bump) until the user decides; reopenCookieConsent() re-shows it (consent must
// be as easy to withdraw as to give).

export type CookieCategory = "necessary" | "functional" | "analytics";

export interface CookieConsentState {
  version: number;
  decidedAt: string;
  categories: Record<CookieCategory, boolean>;
}

const STORAGE_KEY = "olio-cookie-consent";
// Bump to re-prompt everyone (e.g. when a new non-essential category is added).
export const COOKIE_CONSENT_VERSION = 1;
const CHANGE_EVENT = "olio-cookie-consent-change";

function read(): CookieConsentState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CookieConsentState;
    // A decision under an older policy version no longer counts → re-prompt.
    if (parsed?.version !== COOKIE_CONSENT_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

// The saved decision, or null when the user hasn't decided yet (banner shows).
export function getCookieConsent(): CookieConsentState | null {
  return read();
}

// Functional-category localStorage keys. Written only with functional consent
// (setFunctionalStorage) and CLEARED when that consent is withdrawn, so the
// banner decision is honored both ways. Currently just the theme preference.
const FUNCTIONAL_KEYS = ["theme"];

// Persist a decision. `necessary` is always granted (strictly necessary, exempt
// from consent under ePrivacy Art. 5(3)).
export function setCookieConsent(opts: { functional: boolean; analytics: boolean }): void {
  const state: CookieConsentState = {
    version: COOKIE_CONSENT_VERSION,
    decidedAt: new Date().toISOString(),
    categories: { necessary: true, functional: opts.functional, analytics: opts.analytics },
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    // Withdrawing functional consent must remove any functional storage already
    // set — withdrawal is as effective as never granting.
    if (!opts.functional) {
      for (const k of FUNCTIONAL_KEYS) localStorage.removeItem(k);
    }
  } catch {
    // Private mode / storage full — the banner will simply re-show next load.
  }
  notify();
}

// Write a FUNCTIONAL-category preference (e.g. theme) only when the user has
// consented to functional cookies — the Cookie Policy promises these are "set
// only with your consent". Without consent the value is NOT persisted: the
// feature still works for the session via in-memory state, it just isn't
// remembered across loads.
export function setFunctionalStorage(key: string, value: string): void {
  if (!hasCookieConsent("functional")) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode / full — ignore.
  }
}

// Has the user consented to a category? `necessary` is always allowed; anything
// else is default-DENY until they explicitly decide (so analytics etc. can't
// run pre-consent).
export function hasCookieConsent(category: CookieCategory): boolean {
  if (category === "necessary") return true;
  return read()?.categories[category] === true;
}

// Re-open the banner so the user can change their choice. Clears the decision.
export function reopenCookieConsent(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  notify();
}

function notify(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

// Subscribe to consent changes — this tab via CHANGE_EVENT, other tabs via the
// storage event. Returns an unsubscribe fn.
export function onCookieConsentChange(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) cb();
  };
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
}
