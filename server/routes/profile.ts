// The current user's account surface — read (GET /api/me), update
// (PATCH /api/profile), self-delete (DELETE /api/me), and the avatar
// upload-URL + finalize pair. All authenticated; all scoped to req.user.

import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { auth, bucket, db, storageBucketName } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { exportUserData } from "../services/userExport";
import { sanitizeText } from "../services/unicodeSanitize";
import { logError, logWarn } from "../services/log";
import { notifyStaff } from "../services/push";
import {
  deleteUserCascade,
  findHardDeleteBlockers,
  hardDeleteBlockerMessage,
} from "../services/userDelete";
import { ALLOWED_IMAGE_MIME_TO_EXT, AVATAR_PREFIX } from "../services/storageTypes";
import { mirrorRemotePhotoToStorage } from "../services/mirrorRemotePhoto";
import { loadPortfolioBanking } from "../services/portfolioBanking";
import { generatePortfolioId, splitDisplayName } from "../util";
import {
  COL,
  NOTIFICATION_PREF_KEYS,
  TERMS_VERSION,
  type Consent,
  type NotificationPrefs,
  type User,
  type UserAuditEntry,
} from "../../shared/firestore-schema";

// Auto-link any pending tenancies an owner created against this email. Invites
// are stored lowercased (portfolio.ts lowercases tenantEmail) and Firestore
// `==` is case-sensitive, so normalize the same way. Best-effort + non-fatal:
// a failure here just means the link happens later via support, never blocks
// the caller. Runs both on first sign-in AND when a user changes their email
// to an address that was invited in the meantime (see GET /api/me below).
async function linkPendingTenancies(uid: string, email: string | undefined): Promise<void> {
  if (!email) return;
  try {
    const pendingTenancies = await db()
      .collection(COL.tenants)
      .where("email", "==", email.toLowerCase())
      .where("status", "==", "invited")
      .get();
    if (!pendingTenancies.empty) {
      const batch = db().batch();
      for (const d of pendingTenancies.docs) {
        batch.update(d.ref, { userId: uid, status: "pending" });
      }
      await batch.commit();
    }
  } catch (err) {
    logWarn("me.autolink-failed", { uid, err: String(err).slice(0, 200) });
  }
}

// Self-initiated credential-lifecycle events the user can trigger from the
// Sign-in methods dialog. Allowlisted so a forged client can't write arbitrary
// audit text.
const ACCOUNT_EVENT_ACTIONS = new Set([
  "password-added",
  "password-removed",
  "google-connected",
  "google-disconnected",
  "email-change-requested",
]);

export function registerProfileRoutes(app: Express): void {
  // Returns the current user. Creates a profile doc on first sign-in,
  // and opportunistically backfills firstName/lastName/photoURL from
  // the OAuth provider on subsequent calls if those fields are still
  // blank.
  app.get("/api/me", requireAuth, async (req, res) => {
    const { uid, email, name, picture, profile } = req.user!;
    const ref = db().collection(COL.users).doc(uid);

    if (!profile) {
      const { firstName, lastName } = splitDisplayName(name);
      const now = new Date().toISOString();
      // Mirror the OAuth provider photo into our own bucket so the avatar
      // doesn't depend on a volatile third-party CDN URL. Falls back to the
      // raw provider URL if mirroring fails (CSP allows *.googleusercontent.com
      // as a safety net). See mirrorRemotePhoto.ts.
      const photoURL = picture
        ? ((await mirrorRemotePhotoToStorage(uid, picture)) ?? picture)
        : undefined;
      const created: User = {
        id: uid,
        email: email ?? "",
        firstName,
        lastName,
        ...(photoURL ? { photoURL } : {}),
        portfolioId: generatePortfolioId(),
        roles: ["tenant"],
        // Default off — new users are tenants until they flip the
        // Activate Landlord View toggle in Tenant Settings. See User
        // schema comment for full semantics.
        ownerModeEnabled: false,
        // Arm the one-time "tenant or property owner?" modal. Only ever set
        // here (first sign-in); the client clears it when answered/dismissed.
        needsRoleSelection: true,
        status: "active",
        joinedAt: now,
        lastLoginAt: now,
        // Proof-of-consent: signup is gated on the Terms/Privacy acceptance
        // checkbox, so creating the account here IS the acceptance. Record the
        // version + server timestamp + best-effort request metadata as legal
        // evidence (deleted with the user on erasure).
        consent: {
          termsVersion: TERMS_VERSION,
          acceptedAt: now,
          ...(req.ip ? { ip: req.ip } : {}),
          ...(typeof req.headers["user-agent"] === "string"
            ? { userAgent: req.headers["user-agent"].slice(0, 300) }
            : {}),
          source: "signup",
        },
      };
      // Signup fires TWO near-simultaneous first /api/me calls (Home.tsx
      // awaits one while AuthProvider's onAuthStateChanged issues another),
      // and both can pass the `!profile` check before either has written.
      // create() is atomic — it fails if the doc already exists — so exactly
      // one request writes the initial doc. The loser returns what the winner
      // wrote instead of overwriting, which would re-roll portfolioId, re-arm
      // needsRoleSelection, and double the staff notification.
      try {
        await ref.create(created);
      } catch (err: unknown) {
        const e = err as { code?: number | string; message?: string };
        const alreadyExists = e?.code === 6 || /ALREADY_EXISTS/i.test(String(e?.message ?? ""));
        if (!alreadyExists) throw err;
        const snap = await ref.get();
        return res.json(snap.data());
      }

      // Tell platform staff a new user just signed up. Best-effort (notifyStaff
      // swallows its own errors); fires once, on first-ever /api/me.
      await notifyStaff({
        title: "New Olio signup",
        message: created.email || "A new user joined Olio.",
        url: "https://platform.oliowallet.com/admin/users",
      });

      // Auto-link any pending tenancies that an owner already created
      // against this email. The agreement endpoint (POST /api/owner/
      // agreements) no longer pre-creates Firebase Auth accounts on
      // arbitrary emails — security: see comment there. Instead it
      // stores `{ email, userId: null, status: "invited" }`; this is
      // the moment we connect the dots when the real tenant signs up.
      await linkPendingTenancies(uid, email);

      return res.json(created);
    }

    // Backfill: if the user signed up with email/password (so firstName
    // was empty) and has since linked Google — or simply existed before
    // this feature shipped — pull the missing pieces from the token.
    const backfill: Record<string, unknown> = {};
    if (!profile.firstName && !profile.lastName && name) {
      const { firstName, lastName } = splitDisplayName(name);
      if (firstName) backfill.firstName = firstName;
      if (lastName) backfill.lastName = lastName;
    }
    if (!profile.photoURL && picture) {
      backfill.photoURL = (await mirrorRemotePhotoToStorage(uid, picture)) ?? picture;
    }
    if (!profile.portfolioId) backfill.portfolioId = generatePortfolioId();
    // Reconcile email: Firebase Auth is the source of truth. If the
    // user changed their address via verifyBeforeUpdateEmail, the token
    // now carries the new value while Firestore still holds the old
    // one — copy it across, and link any tenancy invited to the NEW
    // address (first-sign-in linking only saw the old one).
    if (email && profile.email !== email) {
      backfill.email = email;
      await linkPendingTenancies(uid, email);
    }
    // Promote an admin-invited account on first sign-in. The invite flow
    // (adminUsers.ts) pre-creates the profile as status:"invited" "until they
    // sign in" — but nothing ever performed that flip, so invited staff
    // lingered as "invited" forever: excluded from notifyStaff (which pushes
    // only to active staff), miscounted in active-user queries, and shown as a
    // pending invite in the admin UI. An authenticated /api/me call IS that
    // sign-in (they set a password and logged in), so complete the handshake.
    // Scoped strictly to "invited" so we never resurrect a "suspended" account.
    if (profile.status === "invited") backfill.status = "active";

    // Hydrate banking (IBAN + Stripe Connect) onto the profile for the client.
    // It physically lives on the owner's portfolio doc now (with a legacy
    // fallback for un-migrated owners); the client's BankingSection +
    // useConnectStatus still read these fields off `profile`. Empty for users
    // who never set up banking (e.g. pure tenants).
    const banking = await loadPortfolioBanking(uid);
    if (Object.keys(backfill).length > 0) {
      await ref.set(backfill, { merge: true });
      return res.json({ ...profile, ...backfill, ...banking });
    }
    return res.json({ ...profile, ...banking });
  });

  // POST /api/heartbeat — bumps lastSeenAt on the caller's user doc. The user
  // app pings this on a ~60s interval while the tab is visible and signed in,
  // so the platform admin can render a "currently in the app" green dot.
  // Rate-limited to be safe against runaway loops, but the limit is generous
  // (1 / 30s per user) so the normal cadence sails through.
  // GDPR right of access (Art. 15) + portability (Art. 20): a machine-readable
  // JSON export of everything Olio holds about the caller — scoped to their own
  // uid (see userExport.ts). Expensive (reads ~15 collections), so capped at
  // 5/day. Returned as a file download.
  app.get("/api/me/export", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const limit = await rateLimit(`data-export:${uid}`, 5, 24 * 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({ error: "Export limit reached. Try again tomorrow." });
    }
    try {
      const data = await exportUserData(uid);
      const filename = `olio-data-export-${new Date().toISOString().slice(0, 10)}.json`;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.status(200).send(JSON.stringify(data, null, 2));
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to build your data export") });
    }
  });

  // Record (re-)acceptance of the CURRENT Terms/Privacy version. The client
  // re-consent prompt calls this when a user's stored consent version is stale
  // (or absent) — writing fresh proof-of-consent (source "reconsent"). Scoped
  // to the caller; 404 if there's no profile to attach it to.
  app.post("/api/me/accept-terms", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const consent: Consent = {
      termsVersion: TERMS_VERSION,
      acceptedAt: new Date().toISOString(),
      ...(req.ip ? { ip: req.ip } : {}),
      ...(typeof req.headers["user-agent"] === "string"
        ? { userAgent: req.headers["user-agent"].slice(0, 300) }
        : {}),
      source: "reconsent",
    };
    try {
      const ref = db().collection(COL.users).doc(uid);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Profile not found" });
      await ref.set({ consent }, { merge: true });
      res.json({ ok: true, consent });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to record acceptance") });
    }
  });

  app.post("/api/heartbeat", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const limit = await rateLimit(`heartbeat:${uid}`, 1, 30);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(204).end();
    }
    try {
      await db()
        .collection(COL.users)
        .doc(uid)
        .set({ lastSeenAt: new Date().toISOString() }, { merge: true });
      res.status(204).end();
    } catch (err: unknown) {
      // Heartbeat is best-effort — never surface a 500 to the client; just
      // log and 204 so the next tick can retry.
      logWarn("heartbeat.failed", { uid, err: String(err).slice(0, 200) });
      res.status(204).end();
    }
  });

  // Profile photo upload — signed-URL gateway. See server/routes.ts
  // comment above the property + listing photo gateways for the full
  // 3-step write protocol; this one mirrors it for avatars with the
  // additional behavior of sweeping older avatars on finalize so storage
  // doesn't accumulate every previous photo on every overwrite.
  app.post("/api/profile/photo/upload-url", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    // Each call hits Cloud Storage to mint a resumable upload session.
    // 60/hour per user is well above any legit avatar-update pattern
    // but stops a tight loop from burning the GCS API quota.
    const limit = await rateLimit(`photo-url:${uid}`, 60, 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many upload attempts. Try again shortly.",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    const contentType =
      typeof (req.body as Record<string, unknown> | undefined)?.contentType === "string"
        ? ((req.body as Record<string, string>).contentType as string)
        : "";
    const ext = ALLOWED_IMAGE_MIME_TO_EXT[contentType];
    if (!ext) {
      return res.status(400).json({ error: "Unsupported image type. Use JPEG, PNG, or WebP." });
    }

    const objectPath = `${AVATAR_PREFIX}/${uid}/${Date.now()}.${ext}`;
    const file = bucket().file(objectPath);
    try {
      const [uploadUrl] = await file.createResumableUpload({
        metadata: { contentType },
        origin: (req.headers.origin as string | undefined) ?? undefined,
      });
      res.json({ uploadUrl, objectPath, contentType });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to issue upload URL") });
    }
  });

  app.post("/api/profile/photo/finalize", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const objectPath =
      typeof (req.body as Record<string, unknown> | undefined)?.objectPath === "string"
        ? ((req.body as Record<string, string>).objectPath as string)
        : "";

    // Confine each user's writes to their own avatar folder so a forged
    // objectPath can't overwrite someone else's photo or arbitrary
    // storage.
    const expectedPrefix = `${AVATAR_PREFIX}/${uid}/`;
    if (!objectPath.startsWith(expectedPrefix)) {
      return res.status(400).json({ error: "Invalid object path" });
    }

    const b = bucket();
    const file = b.file(objectPath);
    try {
      const [exists] = await file.exists();
      if (!exists) {
        return res.status(404).json({ error: "Upload not found. Try uploading again." });
      }

      // Size cap — avatar should never exceed 5 MB. Without this, an
      // attacker could PUT a 10 GB blob (GCS doesn't enforce content-
      // shape on resumable uploads), then finalize. Storage cost
      // burns + the object stays.
      const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
      const [avatarMeta] = await file.getMetadata();
      const avatarSize = Number(avatarMeta.size ?? 0);
      if (avatarSize > MAX_AVATAR_BYTES) {
        await file.delete().catch(() => undefined);
        return res.status(413).json({
          error: "Image exceeds 5 MB. Compress or pick a smaller photo.",
        });
      }

      const token = randomUUID();
      await file.setMetadata({
        metadata: { firebaseStorageDownloadTokens: token },
      });
      const photoURL = `https://firebasestorage.googleapis.com/v0/b/${storageBucketName}/o/${encodeURIComponent(
        objectPath,
      )}?alt=media&token=${token}`;

      // Delete any older avatars for this user so storage doesn't
      // accumulate every previous photo.
      const [olderFiles] = await b.getFiles({ prefix: expectedPrefix });
      await Promise.all(
        olderFiles
          .filter((f) => f.name !== objectPath)
          .map((f) => f.delete().catch(() => undefined)),
      );

      await db().collection(COL.users).doc(uid).set({ photoURL }, { merge: true });
      res.json({ photoURL });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to finalize photo") });
    }
  });

  // DELETE /api/me — self-service account deletion (GDPR Art. 17).
  // Mirrors the admin hard-delete cascade — same blocker check, same
  // deleteUserCascade, same Firebase Auth teardown. The difference: this
  // is initiated by the user themselves, so we write a userAudit entry
  // naming the caller as both actor + target.
  app.delete("/api/me", requireAuth, async (req, res) => {
    const { uid, email } = req.user!;
    const limit = await rateLimit(`self-delete:${uid}`, 5, 24 * 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many delete attempts. Try again later.",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    try {
      const blockers = await findHardDeleteBlockers(uid);
      if (blockers.length > 0) {
        return res.status(409).json({
          error: hardDeleteBlockerMessage(blockers[0]),
          blockers,
        });
      }

      // Audit entry — naming actor + target as the same uid signals
      // self-initiated. Admins reviewing the audit log can distinguish
      // self-deletes from admin-initiated hard-deletes by this match.
      const auditRef = db().collection(COL.userAudit).doc();
      const auditEntry: UserAuditEntry = {
        id: auditRef.id,
        actorUid: uid,
        actorEmail: email ?? "",
        targetUid: uid,
        targetEmail: email ?? "",
        beforeStatus: "active",
        afterStatus: "deleted",
        createdAt: new Date().toISOString(),
      };
      await auditRef.set(auditEntry);

      const cascade = await deleteUserCascade(uid);
      try {
        await auth().deleteUser(uid);
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e?.code !== "auth/user-not-found") {
          logError("auth.delete-failed", err, { uid, source: "self-delete" });
        }
      }
      await db().collection(COL.users).doc(uid).delete();

      res.json({ ok: true, cascade });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to delete account") });
    }
  });

  // Update mutable profile fields. Used by the sign-up form to attach
  // first/last/phone after Firebase Auth account creation, and by
  // Settings pages to update profile fields and notification preferences.
  app.patch("/api/profile", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Allowlist + per-field length cap. Without caps a user could
    // write multi-MB strings into their own profile doc — Firestore's
    // 1MB doc limit would eventually reject the write, but a malicious
    // near-1MB payload would bloat every read of that user.
    const allowedStringCaps: Record<string, number> = {
      firstName: 100,
      lastName: 100,
      phone: 40,
      address: 500,
      photoURL: 2000, // Firebase Storage URLs are long; 2kB headroom.
    };
    // sanitizeText (server/services/unicodeSanitize.ts) NFKC-normalizes
    // + strips control / zero-width / bidi-override chars from display
    // names so an attacker can't spoof another user's name via
    // invisible-character tricks. See unicodeSanitize.test.ts for the
    // regression set.

    const patch: Record<string, unknown> = {};
    for (const [key, cap] of Object.entries(allowedStringCaps)) {
      const v = body[key];
      if (typeof v === "string") {
        // photoURL is a URL — keep as-is (length-cap only); the others
        // are display text that gets Unicode-hygienized.
        patch[key] = key === "photoURL" ? v.slice(0, cap) : sanitizeText(v, cap);
      }
    }
    if (body.entityType === "person" || body.entityType === "company") {
      patch.entityType = body.entityType;
    }
    if (typeof body.ownerModeEnabled === "boolean") {
      patch.ownerModeEnabled = body.ownerModeEnabled;
    }
    // Clear-only: the post-signup role modal can be answered/dismissed but
    // never re-armed from the client.
    if (body.needsRoleSelection === false) {
      patch.needsRoleSelection = false;
    }
    if (body.notificationPrefs && typeof body.notificationPrefs === "object") {
      const incoming = body.notificationPrefs as Record<string, unknown>;
      const prefs: NotificationPrefs = {};
      for (const key of NOTIFICATION_PREF_KEYS) {
        if (typeof incoming[key] === "boolean") {
          (prefs as Record<string, boolean>)[key] = incoming[key] as boolean;
        }
      }
      if (Object.keys(prefs).length > 0) patch.notificationPrefs = prefs;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No updatable fields in body" });
    }
    const ref = db().collection(COL.users).doc(uid);
    await ref.set(patch, { merge: true });
    const snap = await ref.get();
    res.json(snap.data());
  });

  // POST /api/auth/account-event — best-effort audit trail for self-initiated
  // credential changes (add/remove password, connect/disconnect Google,
  // request email change). These happen entirely client-side in Firebase Auth,
  // so without this the server has no record a sign-in method changed. Writes a
  // userAudit entry naming the caller as both actor + target. Never trusted for
  // authorization — purely observability. The client calls it fire-and-forget.
  app.post("/api/auth/account-event", requireAuth, async (req, res) => {
    const { uid, email } = req.user!;
    const action =
      typeof (req.body as Record<string, unknown> | undefined)?.action === "string"
        ? ((req.body as Record<string, string>).action as string)
        : "";
    if (!ACCOUNT_EVENT_ACTIONS.has(action)) {
      return res.status(400).json({ error: "Unknown account event" });
    }
    // Generous cap — a real user makes a handful of these ever; this just stops
    // a runaway client loop from flooding the audit collection.
    const limit = await rateLimit(`account-event:${uid}`, 30, 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).end();
    }
    try {
      const auditRef = db().collection(COL.userAudit).doc();
      const entry: UserAuditEntry = {
        id: auditRef.id,
        actorUid: uid,
        actorEmail: email ?? "",
        targetUid: uid,
        targetEmail: email ?? "",
        action,
        createdAt: new Date().toISOString(),
      };
      await auditRef.set(entry);
      res.status(204).end();
    } catch (err: unknown) {
      // Observability write — never surface a failure to the user.
      logWarn("account-event.failed", { uid, action, err: String(err).slice(0, 200) });
      res.status(204).end();
    }
  });
}
