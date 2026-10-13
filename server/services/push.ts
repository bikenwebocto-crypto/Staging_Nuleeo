// OneSignal Web Push client. Sends push notifications to subscribed browsers
// on app.oliowallet.com via the OneSignal REST API.
//
// Required at runtime:
//   ONESIGNAL_APP_ID        — public App ID (also exposed as VITE_ONESIGNAL_APP_ID
//                              on the client). Falls back to the hardcoded
//                              production value below if unset.
//   ONESIGNAL_REST_API_KEY  — secret REST API Key (Firebase Functions Secret in
//                              production; .env locally).
//
// Targeting: pushes are addressed by `external_id` (also called `external_user_id`
// in older docs). The client SDK calls OneSignal.login(uid) after Firebase auth
// so each subscription is tagged with the Firebase UID — that lets the server
// route notifications to a specific user without knowing the OneSignal player id.
//
// Two entry points:
//   - `sendPush()`        — raw transport, no preference checks. Use for
//                           security/diagnostic events (password reset, admin
//                           test push) that the user can't mute.
//   - `sendPushToUser()`  — prefs-aware wrapper. Reads the user's
//                           `notificationPrefs` from Firestore and skips the
//                           send when the master switch (`pushEnabled`) or
//                           the specified category is off. Use for everything
//                           else: rent reminders, message alerts, maintenance
//                           updates, etc.
//
// Docs:
//   https://documentation.onesignal.com/reference/create-notification
//   https://documentation.onesignal.com/docs/web-sdk-reference

import { db } from "../firebase";
import { COL, type NotificationPrefs, type User } from "../../shared/firestore-schema";
import { logError } from "./log";

const ONESIGNAL_API_BASE = "https://api.onesignal.com";

// Production fallback so a missing env var on the function runtime doesn't
// break sends. The App ID is public — it ships in the client bundle anyway.
const DEFAULT_APP_ID = "120b3721-97d1-46c2-a124-6e4aa8f4d737";

// The staff subdomain (platform.oliowallet.com) is a SEPARATE OneSignal app:
// browsers bind a web-push subscription to one origin per app, so staff can't
// share the user app's subscriber pool. This is its public App ID, hardcoded
// (it ships in the platform bundle) so a missing env var can't silently break
// staff alerts; override with ONESIGNAL_PLATFORM_APP_ID. Its REST key is the
// separate ONESIGNAL_PLATFORM_REST_API_KEY secret.
const DEFAULT_PLATFORM_APP_ID = "09997d0a-2388-4603-aaef-4fed165fc9a3";

// Retry/timeout budget per send. User-app sends include the daily rent crons
// (540s function budget) so they can afford a generous 15s × 3. STAFF sends
// fire inline on request/webhook paths — notably the Stripe webhook, which has
// a ~30s delivery budget before Stripe retries (and a retry would re-page every
// staffer). A tighter budget keeps the awaited fan-out well under that ceiling
// (worst case ≈ 8s + 8s = 16s, parallel across recipients) without sacrificing
// the normal sub-second path.
interface SendProfile {
  delaysMs: number[];
  timeoutMs: number;
}
const USER_SEND_PROFILE: SendProfile = { delaysMs: [0, 250, 1000], timeoutMs: 15000 };
const STAFF_SEND_PROFILE: SendProfile = { delaysMs: [0, 400], timeoutMs: 8000 };

// Olio symbol shown as the notification icon. Public asset served by the app
// site so OneSignal can fetch it. This ONLY applies to Chrome and Firefox (via
// chrome_web_icon/firefox_icon below) — for those it overrides the dashboard
// "Default Icon" so the source of truth lives in the repo.
//
// Apple platforms ignore it: macOS/iOS show the *delivering app's* icon — the
// Safari compass for a plain tab, and our manifest icon only once the site is
// installed (Safari "Add to Dock" on Sonoma / "Add to Home Screen" on iOS).
// OneSignal has no Safari icon field, so nothing in this payload can change the
// Safari banner; don't add one expecting it to.
const NOTIFICATION_ICON_URL = "https://app.oliowallet.com/icon-192.png";

export interface PushSendInput {
  // Firebase UID of the recipient — must match the value passed to
  // OneSignal.login() on the client.
  externalUserId: string;
  // Short headline shown on the notification.
  title: string;
  // Body text.
  message: string;
  // Optional URL the browser opens when the user clicks the notification.
  // Defaults to https://app.oliowallet.com/.
  url?: string;
}

export interface PushSendResult {
  // OneSignal notification id (uuid). Useful for follow-up status queries.
  id: string;
  // OneSignal's recipient count for this send. 0 means the target has no
  // active subscriptions — usually because the user has not yet granted
  // permission in their browser.
  recipients: number;
}

export class PushError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "PushError";
  }
}

function requireApiKey(): string {
  const v = process.env.ONESIGNAL_REST_API_KEY;
  if (!v) {
    throw new PushError(
      "Missing ONESIGNAL_REST_API_KEY. Set it via firebase functions:secrets:set ONESIGNAL_REST_API_KEY",
      500,
      "",
    );
  }
  return v;
}

function appId(): string {
  return process.env.ONESIGNAL_APP_ID || DEFAULT_APP_ID;
}

function platformAppId(): string {
  return process.env.ONESIGNAL_PLATFORM_APP_ID || DEFAULT_PLATFORM_APP_ID;
}

function requirePlatformApiKey(): string {
  const v = process.env.ONESIGNAL_PLATFORM_REST_API_KEY;
  if (!v) {
    throw new PushError(
      "Missing ONESIGNAL_PLATFORM_REST_API_KEY. Set it via firebase functions:secrets:set ONESIGNAL_PLATFORM_REST_API_KEY",
      500,
      "",
    );
  }
  return v;
}

// Low-level transport. Takes the target OneSignal app id + REST key so the same
// retry/timeout logic serves both the user app and the staff app (the staff
// subdomain is a separate OneSignal app — see sendStaffPush).
async function doSend(
  targetAppId: string,
  apiKey: string,
  input: PushSendInput,
  defaultUrl: string,
  profile: SendProfile,
): Promise<PushSendResult> {
  const body = {
    app_id: targetAppId,
    include_aliases: { external_id: [input.externalUserId] },
    target_channel: "push",
    headings: { en: input.title },
    contents: { en: input.message },
    url: input.url ?? defaultUrl,
    chrome_web_icon: NOTIFICATION_ICON_URL,
    firefox_icon: NOTIFICATION_ICON_URL,
  };

  const delaysMs = profile.delaysMs;
  let lastErr: PushError | null = null;
  for (const delay of delaysMs) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    // Node's fetch has no default timeout, so a stalled socket would hang
    // the caller indefinitely — and sendPush is awaited per-agreement
    // inside the daily rentReminderSweep cron, so one hung send would
    // stall the whole batch until the 540s function kill. Bound each
    // attempt and treat a timeout as a retryable failure.
    let resp: Response;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), profile.timeoutMs);
    try {
      resp = await fetch(`${ONESIGNAL_API_BASE}/notifications`, {
        method: "POST",
        headers: {
          Authorization: `Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      lastErr = new PushError(`OneSignal request failed: ${String(err)}`, 0, "");
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (resp.status === 200) {
      const json = (await resp.json()) as { id: string; recipients?: number };
      return { id: json.id, recipients: json.recipients ?? 0 };
    }

    const text = await resp.text();
    lastErr = new PushError(
      `OneSignal API ${resp.status}: ${text.slice(0, 500)}`,
      resp.status,
      text,
    );
    // 4xx other than 429 won't recover on retry.
    if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
      throw lastErr;
    }
  }
  throw lastErr ?? new PushError("OneSignal send failed", 0, "");
}

// Raw transport to the USER app (app.oliowallet.com). No preference checks —
// use for security/diagnostic events the user can't mute.
export async function sendPush(input: PushSendInput): Promise<PushSendResult> {
  return doSend(appId(), requireApiKey(), input, "https://app.oliowallet.com/", USER_SEND_PROFILE);
}

// Raw transport to the STAFF app (platform.oliowallet.com). Separate OneSignal
// app + REST key. Like sendPush it bypasses notificationPrefs: staff opt in via
// the browser permission + the profile push toggle, so an un-subscribed staffer
// simply resolves to zero recipients.
export async function sendStaffPush(input: PushSendInput): Promise<PushSendResult> {
  return doSend(
    platformAppId(),
    requirePlatformApiKey(),
    input,
    "https://platform.oliowallet.com/",
    STAFF_SEND_PROFILE,
  );
}

// Per-category push types. Maps 1:1 to the keys on `NotificationPrefs` that
// the user controls in Settings → Notifications. Pass a category to
// `sendPushToUser()` and the helper will skip the send if the user disabled
// that category. Keep this in lockstep with the schema.
export type PushCategory = Extract<
  keyof NotificationPrefs,
  | "rentReminders"
  | "rentPayments"
  | "propertyActivity"
  | "messages"
  | "maintenance"
  | "documents"
  | "rentIncrease"
>;

export interface SendPushToUserInput extends PushSendInput {
  // Optional category. When set, the send is suppressed if the user has
  // turned off that category in Settings → Notifications. The master
  // `pushEnabled` switch is always honored regardless of category.
  category?: PushCategory;
}

export type PushSkippedReason = "master-off" | "category-off";

export interface SendPushToUserResult extends PushSendResult {
  // Present only when the send was suppressed by the user's preferences.
  // Callers can treat this as a successful no-op (it isn't an error).
  skipped?: PushSkippedReason;
}

// Prefs-aware send. Reads `notificationPrefs` for the target user and
// suppresses delivery when the user has opted out (master or category).
// `pushEnabled` and category flags default to TRUE when missing — that
// matches the schema's opt-in-by-default contract.
export async function sendPushToUser(input: SendPushToUserInput): Promise<SendPushToUserResult> {
  const snap = await db().collection(COL.users).doc(input.externalUserId).get();
  // No Firestore profile (Auth-only account, mid-signup, etc.): fall through
  // and let `sendPush()` attempt the send. OneSignal will simply report
  // zero recipients if the device isn't subscribed.
  const prefs: NotificationPrefs = snap.exists
    ? ((snap.data() as User).notificationPrefs ?? {})
    : {};

  if (prefs.pushEnabled === false) {
    return { id: "", recipients: 0, skipped: "master-off" };
  }
  if (input.category && prefs[input.category] === false) {
    return { id: "", recipients: 0, skipped: "category-off" };
  }

  return sendPush(input);
}

// Fire-and-forget wrapper around `sendPushToUser`. Use this from request
// handlers when the push is a side-effect of the user's primary action —
// e.g. notifying the owner that a tenant logged a rent payment. A push
// failure (OneSignal hiccup, missing UID, etc.) must never break the
// originating write, so we log and swallow.
export async function notifyUser(input: SendPushToUserInput): Promise<void> {
  try {
    await sendPushToUser(input);
  } catch (err) {
    logError("push.notify-failed", err, {
      uid: input.externalUserId,
      category: input.category,
    });
  }
}

export interface NotifyStaffInput {
  title: string;
  message: string;
  // Where the staff notification deep-links. Defaults to the platform root.
  url?: string;
}

// Fan-out an OPERATIONAL alert to every platform staff member (anyone whose
// `roles` include admin or superadmin) via the staff OneSignal app — new
// support tickets, signups, platform billing failures, etc. Fire-and-forget:
// a push failure must never break the originating write. Honors only the
// master `pushEnabled` opt-out (read from the same staff docs we already
// fetch) — the per-category toggles model tenant/owner events, not staff ops,
// so they don't apply here. Staff who haven't enabled push resolve to zero
// recipients. There is no multi-recipient OneSignal call, so we send per-uid.
export async function notifyStaff(input: NotifyStaffInput): Promise<void> {
  try {
    const snap = await db()
      .collection(COL.users)
      .where("roles", "array-contains-any", ["admin", "superadmin"])
      .get();
    await Promise.all(
      snap.docs
        // Skip suspended/non-active staff (suspend doesn't strip roles or clear
        // the OneSignal subscription) and anyone who muted push.
        .filter((d) => {
          const u = d.data() as User;
          return u.status === "active" && u.notificationPrefs?.pushEnabled !== false;
        })
        .map((d) =>
          sendStaffPush({
            externalUserId: d.id,
            title: input.title,
            message: input.message,
            url: input.url,
          }).catch((err) => logError("push.notify-staff-send-failed", err, { uid: d.id })),
        ),
    );
  } catch (err) {
    logError("push.notify-staff-failed", err, {});
  }
}

// Boolean snapshot for the admin Integrations panel. Booleans only — never
// reveal secret values.
export function getPushIntegrationStatus(): {
  provider: "onesignal";
  connected: boolean;
  appId: boolean;
  restApiKey: boolean;
} {
  const restApiKey = Boolean(process.env.ONESIGNAL_REST_API_KEY);
  // The App ID always resolves (env or fallback), so this is informational —
  // it's "true" if the env var is set, but the integration still works when
  // false because of the hardcoded fallback.
  const appIdSet = Boolean(process.env.ONESIGNAL_APP_ID) || Boolean(DEFAULT_APP_ID);
  return {
    provider: "onesignal",
    connected: restApiKey && appIdSet,
    appId: appIdSet,
    restApiKey,
  };
}
