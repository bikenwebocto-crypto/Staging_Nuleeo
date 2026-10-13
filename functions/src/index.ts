// Firebase Functions 2nd gen entry. Exposes the Express API as a single HTTPS
// function named "api" in europe-west1. Invoked from the hosting sites via the
// /api/** rewrite rules in firebase.json.

import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { createApp } from "../../server/app";
import { auth, db } from "../../server/firebase";
import { COL, type ComplimentaryPlan } from "../../shared/firestore-schema";
import { logError, logInfo } from "../../server/services/log";
import { reconcileAfterPlanChange } from "../../server/services/planReconcile";
import { makeDispatchEmailCampaigns } from "./emailDispatch";
import { makeRentReminderSweep } from "./rentReminders";
import { makeRentIndexationSweep } from "./rentIndexation";
import { makeLeaseExpirySweep } from "./leaseExpiry";
import { makeOrphanPhotoSweep } from "./orphanPhotoSweep";
import { makeInactiveUnitsSweep } from "./sweepInactiveUnits";
import { makeAuditRetentionSweep } from "./auditRetention";

// Production secrets — created via:
//   firebase functions:secrets:set OPENAI_API_KEY --project olio-wallet
// The secret is bound to the function below and surfaces as process.env.OPENAI_API_KEY at runtime.
const openaiApiKey = defineSecret("OPENAI_API_KEY");

// Resend credentials. Set with:
//   firebase functions:secrets:set RESEND_API_KEY --project olio-wallet
//   firebase functions:secrets:set RESEND_FROM --project olio-wallet
//   firebase functions:secrets:set RESEND_WEBHOOK_SECRET --project olio-wallet
// Until API_KEY + FROM are set, /api/admin/emails/:id/send and the dispatcher
// surface a clear error; drafts and scheduling still work.
const resendApiKey = defineSecret("RESEND_API_KEY");
const resendFrom = defineSecret("RESEND_FROM");
const resendWebhookSecret = defineSecret("RESEND_WEBHOOK_SECRET");
// Signs per-recipient unsubscribe tokens. Independent of Resend secrets so it
// can be rotated without disrupting send. Generate with a long random value:
//   firebase functions:secrets:set UNSUBSCRIBE_SECRET --project olio-wallet
const unsubscribeSecret = defineSecret("UNSUBSCRIBE_SECRET");
const emailSecrets = [resendApiKey, resendFrom, resendWebhookSecret, unsubscribeSecret];

// Stripe API key — already in production. Re-declared here so it surfaces
// as process.env.STRIPE_SECRET_KEY in the function runtime.
//   firebase functions:secrets:set STRIPE_SECRET_KEY --project olio-wallet
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");

// Stripe webhook signing secret for the PLATFORM endpoint (account.updated,
// charge.refunded, customer.subscription.updated). Get the whsec_… value when
// creating the "Your account" webhook endpoint in Stripe Dashboard.
//   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project olio-wallet
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

// Stripe webhook signing secret for the CONNECT endpoint (connect:true) — the
// direct-charge events (checkout.session.completed, payment_intent.succeeded,
// charge.refunded, account.updated) that fire on owners' connected accounts.
// This is a DIFFERENT whsec_ than the platform endpoint; copy it from the
// "Connected accounts" webhook endpoint.
//   firebase functions:secrets:set STRIPE_CONNECT_WEBHOOK_SECRET --project olio-wallet
const stripeConnectWebhookSecret = defineSecret("STRIPE_CONNECT_WEBHOOK_SECRET");

const stripeSecrets = [stripeSecretKey, stripeWebhookSecret, stripeConnectWebhookSecret];

// OneSignal REST API key. Sends pushes to app.oliowallet.com browsers via
// POST https://api.onesignal.com/notifications. Set with:
//   firebase functions:secrets:set ONESIGNAL_REST_API_KEY --project olio-wallet
// The App ID is public and lives in .env (ONESIGNAL_APP_ID / VITE_ONESIGNAL_APP_ID).
const onesignalRestApiKey = defineSecret("ONESIGNAL_REST_API_KEY");
// REST key for the SEPARATE staff/platform OneSignal app (platform.oliowallet.com).
// Sends operational alerts to admins/superadmins via notifyStaff(). Set with:
//   firebase functions:secrets:set ONESIGNAL_PLATFORM_REST_API_KEY --project olio-wallet
// The staff app's App ID is public (lives in push.ts as DEFAULT_PLATFORM_APP_ID).
const onesignalPlatformRestApiKey = defineSecret("ONESIGNAL_PLATFORM_REST_API_KEY");

const app = createApp();

export const api = onRequest(
  {
    region: "europe-west1",
    // Hosting rewrites to this function; origin is the hosting domain, so same-origin.
    cors: false,
    // Required when invoked via Hosting rewrites; Hosting authenticates the call.
    invoker: "public",
    // Resource + scaling tuning for the whole money/auth/PII API (was 2nd-gen
    // defaults: 256MiB / minInstances 0 / maxInstances 100 / 60s):
    //   - memory 512MiB: the bundle is Express + Stripe + OpenAI + firebase-admin;
    //     256MiB is tight and risks OOM under load.
    //   - minInstances 1: keep one instance warm so auth/checkout/webhook calls
    //     never pay cold-start latency after an idle period.
    //   - maxInstances 20: bound runaway scaling cost AND Firestore connection-
    //     pool blowup under a spike/abuse flood. Raise as the user base grows.
    //   - timeoutSeconds 60: API requests are short and nothing should hang
    //     (async rejections are forwarded to the error handler — see
    //     server/asyncErrors.ts), so keep a tight bound.
    memory: "512MiB",
    minInstances: 1,
    maxInstances: 20,
    timeoutSeconds: 60,
    secrets: [
      openaiApiKey,
      ...emailSecrets,
      ...stripeSecrets,
      onesignalRestApiKey,
      onesignalPlatformRestApiKey,
    ],
  },
  app,
);

// Email-campaign dispatcher. Polls every minute for sending/scheduled
// campaigns and fans out via the Resend API. The /send endpoint also
// kicks the dispatcher inline so the first batch goes out immediately.
export const dispatchEmailCampaigns = makeDispatchEmailCampaigns(emailSecrets);

// Daily rent-reminder push. 09:00 Athens — sweeps active agreements whose
// `nextPaymentDate` falls 3 days out (upcoming) or 1 day past (overdue),
// falling back to `paymentDayOfMonth` for legacy docs. Pushes the tenant
// under the `rentReminders` category. Gated by the owner's plan privilege.
export const rentReminderSweep = makeRentReminderSweep([onesignalRestApiKey]);

// Daily rent-indexation sweep. 02:00 Athens — walks active leases with
// indexation terms, sends an advance heads-up ~30 days before a scheduled
// increase and applies it on the effective date (compound off current rent),
// keeping the charged rent + agreement in sync. CPI leases (no feed) flag the
// owner to set rent manually. Gated by the owner's `rent.autoIndex` privilege;
// both parties' `rentIncrease` notification pref is honored.
export const rentIndexationSweep = makeRentIndexationSweep([onesignalRestApiKey]);

// Daily lease-expiry sweep. 01:00 Athens — runs before the indexation sweep so
// a lease expiring today leaves "active" before indexation would walk it. When
// a lease reaches its endDate it either auto-renews (autoRenewal auto/fixed) or
// is closed (status → "expired"): the schedule stops, the tenancy drops out of
// forward revenue/reminders/indexation, and any unpaid in-term rent is kept as
// a collectible closingBalance. Heads-up pushed ~30 days ahead. NOT plan-gated;
// notifications honor each party's prefs.
export const leaseExpirySweep = makeLeaseExpirySweep([onesignalRestApiKey]);

// Daily orphaned-photo sweep. 04:30 Athens — deletes property/listing photo
// objects in Storage that no doc references and that are older than a 48h
// grace window (cancelled/failed creates + replaced-on-edit photos). Safe by
// construction: the reference set is a superset across all image-bearing
// collections, and the grace window protects in-flight uploads.
export const orphanPhotoSweep = makeOrphanPhotoSweep();

// Daily 30-day inactive-property sweep. 05:00 Athens — for properties a plan
// downgrade soft-deactivated 30+ days ago, purges their documents (DocumentRecord
// rows + storage objects + signed-lease PDFs), terminates any still-suspended
// lease + ends the tenancy, and stamps docsPurgedAt. RETAINS the property /
// unit / tenant / agreement / transaction ledger (admin-visible; activity stays
// in both the owner's and tenant's feeds). No pushes → no secrets needed.
export const sweepInactiveUnits = makeInactiveUnitsSweep();

// Daily purge of userAudit + impersonations entries older than 12 months, per
// the Privacy Policy's "Security logs: up to 12 months" retention promise.
export const auditRetentionSweep = makeAuditRetentionSweep();

// Daily sweep: comp plans live for 12 months. When `expiresAt` passes we drop
// the `stripeRole` custom claim (so usePlan() falls back to Basic on next
// token refresh) and flip the audit doc's status to "expired". Without this
// the grant would last forever even though the UI promised 12 months.
export const expireComplimentaryPlans = onSchedule(
  {
    region: "europe-west1",
    schedule: "every day 03:00",
    timeZone: "Europe/Athens",
    // Expiry runs reconcileAfterPlanChange → notifyUser (tenant tenancy-ended +
    // owner portfolio-changes pushes). Those go through OneSignal's REST API,
    // which needs the key on THIS runtime — 2nd-gen secrets are injected
    // per-function, so without this binding the pushes throw "Missing
    // ONESIGNAL_REST_API_KEY" and get silently swallowed by notifyUser. Mirror
    // rentReminderSweep / rentIndexationSweep / api.
    secrets: [onesignalRestApiKey],
  },
  async () => {
    const now = new Date().toISOString();
    const snap = await db()
      .collection(COL.complimentaryPlans)
      .where("status", "==", "active")
      .where("expiresAt", "<=", now)
      .get();

    if (snap.empty) return;

    for (const doc of snap.docs) {
      const grant = doc.data() as ComplimentaryPlan;
      try {
        // Don't strip stripeRole if the user has since bought a real
        // Stripe subscription — the Payments extension would have
        // overwritten our comp claim with theirs, and yanking it would
        // demote a paying customer. Tell-tale: an active sub doc lives
        // under customers/{uid}/subscriptions.
        const subSnap = await db()
          .collection("customers")
          .doc(grant.userId)
          .collection("subscriptions")
          .where("status", "in", ["active", "trialing"])
          .limit(1)
          .get();
        if (subSnap.empty) {
          const authUser = await auth().getUser(grant.userId);
          const claims = { ...(authUser.customClaims ?? {}) } as Record<string, unknown>;
          delete claims.stripeRole;
          await auth().setCustomUserClaims(grant.userId, claims);
          // Invalidate cached ID tokens so the user doesn't keep Pro
          // privileges via a stale stripeRole claim for up to ~1h.
          try {
            await auth().revokeRefreshTokens(grant.userId);
          } catch (err) {
            logError("auth.revoke-tokens-failed", err, {
              uid: grant.userId,
              source: "comp-plan-cron-expire",
            });
          }
          // Expiry drops the comp claim → a real downgrade to basic. Run the
          // same cap / rent-collection cleanup a paid Stripe downgrade runs,
          // so over-cap properties don't survive and Stripe rent doesn't keep
          // collecting on a now-basic plan. Best-effort per user.
          try {
            await reconcileAfterPlanChange(grant.userId, grant.plan, "basic");
          } catch (err) {
            logError("comp_plan.expire-reconcile-failed", err, {
              uid: grant.userId,
            });
          }
        }
        await doc.ref.set({ status: "expired", revokedAt: now }, { merge: true });
      } catch (err) {
        // Log and skip — the next run will retry. We don't want one bad user
        // (e.g. auth account deleted) to block the rest of the batch.
        logError("comp_plan.expire-failed", err, { uid: grant.userId });
      }
    }
  },
);

// Sweeps the rateLimits collection. Each call to the limiter writes a
// doc keyed on (action, window) — at 10k users with ~20 distinct action
// prefixes that's ~200k docs over time, none of which auto-GC. Daily
// pass deletes anything whose resetAt timestamp is more than 7 days
// past (covers every window length we use — longest is 24h).
export const sweepRateLimits = onSchedule(
  {
    region: "europe-west1",
    schedule: "every day 04:00",
    timeZone: "Europe/Athens",
    timeoutSeconds: 540,
  },
  async () => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let totalDeleted = 0;
    // Paginated scan — process in 500-doc batches so we stay under the
    // commit limit and don't load the whole collection into memory.
    // Loops until a batch returns < 500 (no more old docs).
    while (true) {
      const snap = await db()
        .collection("rateLimits")
        .where("resetAt", "<", cutoff)
        .limit(500)
        .get();
      if (snap.empty) break;
      const batch = db().batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      totalDeleted += snap.size;
      if (snap.size < 500) break;
    }
    if (totalDeleted > 0) {
      logInfo("rate_limit_sweep.deleted", { deletedCount: totalDeleted });
    }
  },
);
