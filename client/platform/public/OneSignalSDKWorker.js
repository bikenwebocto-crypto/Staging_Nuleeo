// OneSignal Web Push service worker for the STAFF app. Must be served from the
// site root so the OneSignal SDK can register it on platform.oliowallet.com —
// see https://documentation.onesignal.com/docs/web-sdk-setup. The staff
// subdomain is a separate OneSignal app from app.oliowallet.com (web push binds
// one origin per app); this worker is identical, only the app id (resolved
// client-side by origin in client/shared/lib/onesignal.ts) differs.
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
