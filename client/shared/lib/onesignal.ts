// OneSignal Web Push integration for app.oliowallet.com.
//
// The SDK is loaded lazily from OneSignal's CDN — we never bundle it. After
// load, OneSignal.init() registers the service worker at /OneSignalSDKWorker.js
// (a one-liner in client/app/public that re-exports the OneSignal SW) and
// surfaces the browser's permission prompt only when the user explicitly
// enables push from the profile drawer (see useOneSignalSubscription below).
//
// We address pushes by `external_id` (the Firebase UID), which is set via
// OneSignal.login() on auth and cleared via OneSignal.logout() on sign-out.
// The server (server/services/push.ts) addresses the same id when sending.
//
// Docs: https://documentation.onesignal.com/docs/web-sdk-reference

import { useCallback, useEffect, useState } from "react";

type NativePermission = "default" | "granted" | "denied";

interface OneSignalNotifications {
  permission: boolean;
  permissionNative: NativePermission;
  requestPermission: () => Promise<void>;
  addEventListener: (event: "permissionChange", listener: (granted: boolean) => void) => void;
  removeEventListener: (event: "permissionChange", listener: (granted: boolean) => void) => void;
}

interface OneSignalPushSubscription {
  optedIn: boolean;
  optIn: () => Promise<void>;
  optOut: () => Promise<void>;
  addEventListener: (
    event: "change",
    listener: (change: { previous: unknown; current: unknown }) => void,
  ) => void;
  removeEventListener: (
    event: "change",
    listener: (change: { previous: unknown; current: unknown }) => void,
  ) => void;
}

interface OneSignalSDK {
  init: (config: { appId: string; allowLocalhostAsSecureOrigin?: boolean }) => Promise<void>;
  login: (externalId: string) => Promise<void>;
  logout: () => Promise<void>;
  Notifications: OneSignalNotifications;
  User: { PushSubscription: OneSignalPushSubscription };
}

type Deferred = (os: OneSignalSDK) => void | Promise<void>;

declare global {
  interface Window {
    OneSignalDeferred?: Deferred[];
    OneSignal?: OneSignalSDK;
  }
}

// Web push binds a subscription to one origin per OneSignal app, so the staff
// subdomain (platform.oliowallet.com) is its OWN app. Resolve the app id by
// origin: the platform build runs on platform.* and addresses the staff app;
// everything else (app.oliowallet.com + localhost dev) uses the primary user
// app. Both IDs are public — they ship in the bundle — so picking client-side
// is safe. The staff id is hardcoded (mirrors the server's DEFAULT_PLATFORM_APP_ID)
// so a missing build env var can't silently break staff push; `||` (not `??`)
// so an empty-string env also falls back.
const DEFAULT_PLATFORM_APP_ID = "09997d0a-2388-4603-aaef-4fed165fc9a3";
const ON_PLATFORM_ORIGIN =
  typeof window !== "undefined" && window.location.hostname.startsWith("platform.");
const APP_ID = (
  ON_PLATFORM_ORIGIN
    ? (import.meta.env.VITE_ONESIGNAL_PLATFORM_APP_ID as string | undefined) ||
      DEFAULT_PLATFORM_APP_ID
    : (import.meta.env.VITE_ONESIGNAL_APP_ID as string | undefined)
) as string | undefined;
let scriptInjected = false;

// How long to wait for OneSignal to report a usable state before we give up
// and show an explanatory badge instead of a forever-disabled toggle. The
// common stuck case is Safari Private Browsing: the SDK loads (so the toggle
// renders) but push can't be initialised, so the readiness callback never
// fires. Generous enough not to false-trip a slow-but-working SDK load.
const PUSH_READY_TIMEOUT_MS = 8000;

function pushDeferred(fn: Deferred) {
  window.OneSignalDeferred = window.OneSignalDeferred || [];
  window.OneSignalDeferred.push(fn);
}

export function ensureOneSignal(): void {
  if (!APP_ID) return;
  if (scriptInjected) return;
  scriptInjected = true;

  pushDeferred(async (OneSignal) => {
    try {
      await OneSignal.init({
        appId: APP_ID,
        // The OneSignal SDK refuses to run on insecure origins by default;
        // localhost dev needs this flag flipped on.
        allowLocalhostAsSecureOrigin:
          window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1",
      });
    } catch {
      // Best-effort: the SDK can throw/reject during init on browsers or
      // contexts where push isn't fully available (Safari Private Browsing,
      // some iOS web views — seen in prod as an unhandled rejection inside the
      // minified SDK). Push is non-critical, so swallow rather than let it
      // surface as a global unhandledrejection.
    }
  });

  const s = document.createElement("script");
  s.src = "https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js";
  s.async = true;
  s.defer = true;
  document.head.appendChild(s);
}

export function loginOneSignal(externalId: string): void {
  if (!APP_ID || !externalId) return;
  ensureOneSignal();
  // Swallow SDK throws/rejections — see ensureOneSignal. login can fail on
  // half-initialised SDKs (Safari Private/iOS) and would otherwise escape as a
  // global unhandledrejection.
  pushDeferred(async (OneSignal) => {
    try {
      await OneSignal.login(externalId);
    } catch {
      /* best-effort */
    }
  });
}

export function logoutOneSignal(): void {
  if (!APP_ID) return;
  ensureOneSignal();
  pushDeferred(async (OneSignal) => {
    try {
      await OneSignal.logout();
    } catch {
      /* best-effort */
    }
  });
}

/** Why push is unavailable, when it is.
 *  - `private-browsing`: Safari with no service worker — a private window (push
 *    works in a normal one). Detected up front.
 *  - `setup-incomplete`: the push SDK loaded but never finished initialising
 *    (seen on iOS Home Screen PWAs where OneSignal's SDK stalls). This is NOT
 *    private browsing — reaching this state means a service worker WAS present.
 *  - `unsupported`: the browser genuinely can't do web push. */
export type PushUnavailableReason = "private-browsing" | "setup-incomplete" | "unsupported" | null;

/** Human-facing copy for an unavailable push state: a status line plus a compact
 *  badge label. Shared across every Settings/profile surface so the wording stays
 *  consistent — and honest (we never claim "Private Browsing" for a state that
 *  isn't one). */
export function describePushUnavailable(reason: PushUnavailableReason): {
  message: string;
  badge: string;
} {
  switch (reason) {
    case "private-browsing":
      return {
        message: "Private Browsing blocks push — open Olio in a normal Safari window to enable",
        badge: "PRIVATE",
      };
    case "setup-incomplete":
      return {
        message: "Push couldn't be set up on this device — it works on desktop Safari and Chrome",
        badge: "UNAVAILABLE",
      };
    default:
      return { message: "Not available in this browser", badge: "UNSUPPORTED" };
  }
}

// True for Apple's Safari (macOS or iOS), excluding the WebKit-wrapped Chrome/
// Firefox/Edge variants. Used only to explain a missing service worker.
function isAppleSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  if (navigator.vendor === "Apple Computer, Inc.") return true;
  const ua = navigator.userAgent;
  return /safari/i.test(ua) && !/chrome|chromium|crios|fxios|android|edg|opr/i.test(ua);
}

// Browser push needs both the Notification API and a Service Worker. Safari
// disables service workers in Private Browsing windows (but supports web push
// in normal ones), so we flag that case separately to show clearer guidance.
function detectPushAvailability(): { supported: boolean; reason: PushUnavailableReason } {
  if (typeof window === "undefined") return { supported: false, reason: "unsupported" };
  if (!("Notification" in window)) return { supported: false, reason: "unsupported" };
  if (!("serviceWorker" in navigator)) {
    return { supported: false, reason: isAppleSafari() ? "private-browsing" : "unsupported" };
  }
  return { supported: true, reason: null };
}

export interface OneSignalSubscription {
  /** Browser/SDK can handle web push at all */
  supported: boolean;
  /** When unsupported, why — lets the UI distinguish a private window from a truly incapable browser */
  unavailableReason: PushUnavailableReason;
  /** SDK has finished loading and reported initial state */
  ready: boolean;
  /** OS-level permission for this origin */
  permission: NativePermission;
  /** User is opted in AND has granted permission (i.e. will actually receive pushes) */
  subscribed: boolean;
  /** Trigger browser prompt (if needed) and opt the subscription in */
  enable: () => Promise<void>;
  /** Opt the subscription out — does not revoke permission */
  disable: () => Promise<void>;
}

export function useOneSignalSubscription(): OneSignalSubscription {
  const [supported, setSupported] = useState<boolean>(() => Boolean(APP_ID));
  const [unavailableReason, setUnavailableReason] = useState<PushUnavailableReason>(null);
  const [ready, setReady] = useState(false);
  const [permission, setPermission] = useState<NativePermission>("default");
  const [subscribed, setSubscribed] = useState(false);

  useEffect(() => {
    const availability = detectPushAvailability();
    if (!APP_ID || !availability.supported) {
      setSupported(false);
      setUnavailableReason(APP_ID ? availability.reason : "unsupported");
      return;
    }
    setSupported(true);
    setUnavailableReason(null);

    let mounted = true;
    let settled = false;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    let permHandler: ((g: boolean) => void) | null = null;
    let subHandler: ((c: { previous: unknown; current: unknown }) => void) | null = null;

    ensureOneSignal();
    // Safety net: if OneSignal never reports a usable state, flip the dead
    // disabled toggle to an explanatory badge instead of leaving it stuck.
    // Reaching this point means detection already passed (Notification +
    // serviceWorker present), so this is NOT Safari Private Browsing — a private
    // window has no service worker and is caught earlier in detectPushAvailability.
    // The SDK simply loaded but never finished initialising: the failure mode
    // seen on iOS Home Screen PWAs where OneSignal's SDK stalls. Report that
    // honestly rather than guessing "private browsing".
    readyTimer = setTimeout(() => {
      if (!mounted || settled) return;
      setSupported(false);
      setUnavailableReason("setup-incomplete");
    }, PUSH_READY_TIMEOUT_MS);

    pushDeferred((OneSignal) => {
      if (!mounted) return;
      const refresh = () => {
        if (!mounted) return;
        try {
          setPermission(OneSignal.Notifications.permissionNative);
          setSubscribed(
            OneSignal.User.PushSubscription.optedIn && OneSignal.Notifications.permission,
          );
        } catch {
          // The SDK ran our callback but its state isn't usable yet (e.g. a
          // half-initialised SDK in Safari Private Browsing). Leave `ready`
          // false and let the readiness timeout surface the badge.
          return;
        }
        settled = true;
        if (readyTimer) {
          clearTimeout(readyTimer);
          readyTimer = null;
        }
        setReady(true);
      };
      refresh();
      permHandler = () => refresh();
      subHandler = () => refresh();
      OneSignal.Notifications.addEventListener("permissionChange", permHandler);
      OneSignal.User.PushSubscription.addEventListener("change", subHandler);
    });

    return () => {
      mounted = false;
      if (readyTimer) clearTimeout(readyTimer);
      const OneSignal = window.OneSignal;
      if (OneSignal && permHandler) {
        OneSignal.Notifications.removeEventListener("permissionChange", permHandler);
      }
      if (OneSignal && subHandler) {
        OneSignal.User.PushSubscription.removeEventListener("change", subHandler);
      }
    };
  }, []);

  const enable = useCallback(async () => {
    if (!APP_ID) return;
    // Safari (and Firefox) only show the permission prompt when
    // requestPermission() is called synchronously inside the user's click —
    // routing through the deferred queue adds a microtask hop that drops the
    // user-activation, so the prompt silently never appears. The toggle only
    // becomes interactive once `ready` is true, by which point the SDK is
    // loaded and initialised, so we can call it directly on window.OneSignal.
    const OneSignal = window.OneSignal;
    if (!OneSignal) return;
    // Guard the direct SDK calls: a half-initialised SDK (Safari Private /iOS)
    // can throw here — the same minified failure seen in prod as the
    // 'OneSignal.ye.Qe' unhandled rejection — and this path is NOT routed
    // through the swallowing deferred queue (it must run synchronously in the
    // click so the permission prompt isn't dropped). Without this, the throw
    // escapes the click handler as a global unhandledrejection. The toggle
    // simply stays off on failure.
    try {
      if (OneSignal.Notifications.permissionNative === "default") {
        await OneSignal.Notifications.requestPermission();
      }
      if (OneSignal.Notifications.permission) {
        await OneSignal.User.PushSubscription.optIn();
      }
    } catch {
      /* best-effort — push is non-critical */
    }
  }, []);

  const disable = useCallback(async () => {
    if (!APP_ID) return;
    await new Promise<void>((resolve) => {
      pushDeferred(async (OneSignal) => {
        try {
          await OneSignal.User.PushSubscription.optOut();
        } catch {
          // Best-effort opt-out; never let an SDK rejection escape unhandled.
        } finally {
          resolve();
        }
      });
    });
  }, []);

  return { supported, unavailableReason, ready, permission, subscribed, enable, disable };
}
