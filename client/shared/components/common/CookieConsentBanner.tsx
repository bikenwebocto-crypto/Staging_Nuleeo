import { useEffect, useState } from "react";
import { getCookieConsent, setCookieConsent, onCookieConsentChange } from "@ui/lib/cookieConsent";

// First-visit cookie-consent banner (ePrivacy). Shows until the user decides,
// or again after a COOKIE_CONSENT_VERSION bump, or when reopenCookieConsent()
// fires (e.g. a footer "Cookie preferences" link). Fixed to the bottom and
// theme-token styled so it matches all three apps.
//
// `cookiePolicyHref` differs per app: the legal docs live on the app subdomain,
// and landing/platform have no in-app /legal route — so landing passes an
// absolute appUrl("/legal/cookies"). Defaults to the in-app relative path.
export function CookieConsentBanner({
  cookiePolicyHref = "/legal/cookies",
}: {
  cookiePolicyHref?: string;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const sync = () => setVisible(getCookieConsent() === null);
    sync();
    return onCookieConsentChange(sync);
  }, []);

  if (!visible) return null;

  const decide = (all: boolean) => setCookieConsent({ functional: all, analytics: all });

  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-[100] p-4 sm:p-5"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3 rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-lg sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <p className="text-sm leading-relaxed text-muted-foreground">
          We use essential cookies to run Olio and to remember preferences like your theme. We don't
          use advertising or third-party analytics cookies. See our{" "}
          <a
            href={cookiePolicyHref}
            className="font-medium text-foreground underline underline-offset-2"
          >
            Cookie Policy
          </a>
          .
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => decide(false)}
            className="rounded-lg bg-secondary px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-secondary/80"
          >
            Essential only
          </button>
          <button
            type="button"
            onClick={() => decide(true)}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
          >
            Accept all
          </button>
        </div>
      </div>
    </div>
  );
}
