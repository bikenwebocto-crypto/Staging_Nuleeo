// Admin user lifecycle: invite, edit, delete, send-reset, impersonate,
// grant/revoke complimentary plan. All gated to admin + superadmin;
// role-assigning + role-mutating branches check finer-grained matrix
// privileges inline.
//
// Several security-critical guards live in here that mirror each other
// across endpoints:
//   • isLastSuperadmin — refuses delete/suspend/demote operations that
//     would zero out the superadmin count.
//   • SUPERADMIN GATE — only a superadmin can promote a user to
//     superadmin, even with users.assignRoles.
//   • Force refresh-token revocation on any role / platformRole /
//     status mutation so a still-cached ID token can't keep stale
//     privileges for up to an hour.
//
// Audit log: every cross-user PATCH that flips roles, platformRole, or
// status appends a UserAuditEntry (admin actions trail).

import type { Express, RequestHandler } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { auth, db } from "../firebase";
import { requireAuth } from "../auth";
import { reqStr } from "../util";
import { errMsg } from "../services/errMsg";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { logError } from "../services/log";
import { sendPasswordResetEmail } from "../services/passwordReset";
import { sendUserInviteEmail } from "../services/transactionalEmail";
import {
  reconcileAfterPlanChange,
  reactivateAfterPlanUpgrade,
  PLAN_RANK,
} from "../services/planReconcile";
import { logWarn } from "../services/log";
import {
  deleteUserCascade,
  findHardDeleteBlockers,
  hardDeleteBlockerMessage,
} from "../services/userDelete";
import { hasPlatformPrivilege, isLastSuperadmin } from "../services/platformPrivilege";
import {
  COL,
  type ComplimentaryPlan,
  type ComplimentaryPlanType,
  type ImpersonationLog,
  type OwnerPlanKey,
  type PlatformPrivilegeKey,
  type PlatformRoleKey,
  PLATFORM_ROLES,
  type Role,
  type User,
  type UserAuditEntry,
} from "../../shared/firestore-schema";

export interface AdminUsersDeps {
  requireRole: (...roles: Role[]) => RequestHandler;
  requirePlatformPrivilege: (p: PlatformPrivilegeKey) => RequestHandler;
}

export function registerAdminUsersRoutes(
  app: Express,
  { requireRole, requirePlatformPrivilege }: AdminUsersDeps,
): void {
  // POST /api/admin/users/invite — provision a new Firebase Auth user,
  // create their Firestore profile with the given roles, and return a
  // copy-able password-setup link the admin can share manually (we
  // don't have a transactional email provider yet). The user clicks
  // the link, sets a password, then can sign in.
  app.post(
    "/api/admin/users/invite",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("users.assignRoles"),
    async (req, res) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
        const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
        const rolesInput = Array.isArray(body.roles) ? body.roles : [];
        const roles = (rolesInput as unknown[])
          .filter((r): r is string => typeof r === "string")
          .map((r) => r.toLowerCase())
          .filter((r) => ["tenant", "owner", "admin", "superadmin"].includes(r)) as Array<
          "tenant" | "owner" | "admin" | "superadmin"
        >;

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
          return res.status(400).json({ error: "valid email is required" });
        if (roles.length === 0)
          return res.status(400).json({ error: "at least one role is required" });

        // Optional sub-role within the platform admin matrix. Only
        // meaningful when `roles` includes "admin"; ignored otherwise.
        let platformRole: PlatformRoleKey | undefined;
        if (typeof body.platformRole === "string" && body.platformRole) {
          if (!PLATFORM_ROLES.includes(body.platformRole as PlatformRoleKey))
            return res.status(400).json({ error: "invalid platformRole" });
          if (roles.includes("admin")) platformRole = body.platformRole as PlatformRoleKey;
        }

        // Check whether a Firebase Auth user already exists with this
        // email.
        try {
          await auth().getUserByEmail(email);
          // User exists — fail fast so we don't accidentally hijack an
          // account.
          return res.status(409).json({
            error:
              "A Firebase Auth account already exists with this email. Use the edit modal to update their role/status instead.",
          });
        } catch (err: unknown) {
          const e = err as { code?: string };
          if (e?.code !== "auth/user-not-found") throw err;
        }

        // Create the auth user. No password — they'll set one via the
        // link.
        const displayName = `${firstName} ${lastName}`.trim() || undefined;
        const authUser = await auth().createUser({
          email,
          emailVerified: false,
          disabled: false,
          ...(displayName ? { displayName } : {}),
        });

        // Create the Firestore profile. status: "invited" until they
        // sign in.
        const now = new Date().toISOString();
        const profile: User = {
          id: authUser.uid,
          email,
          firstName,
          lastName,
          roles,
          ...(platformRole ? { platformRole } : {}),
          status: "invited",
          joinedAt: now,
        };
        await db().collection(COL.users).doc(authUser.uid).set(profile);

        // Generate a one-time password setup link. The host of the link
        // (where the user lands to set their password) is controlled by
        // Firebase Console → Authentication → Templates → "Customize
        // action URL". We set that to https://app.oliowallet.com/auth/action
        // so the user gets our branded handler instead of Firebase's
        // default page. `url` below is the continueUrl — where our
        // handler redirects after the password is set.
        const continueUrl = "https://app.oliowallet.com/";
        const inviteLink = await auth().generatePasswordResetLink(email, {
          url: continueUrl,
          handleCodeInApp: false,
        });

        // Best-effort transactional email — the new user gets a
        // branded "Welcome to Olio Wallet" message with the password-
        // setup link instead of relying on the admin to copy/paste.
        // Resend failures are non-fatal: the admin still gets the
        // inviteLink in the response and can share it manually, and
        // we log the failure for incident review.
        const invitedByName =
          [req.user!.profile?.firstName ?? "", req.user!.profile?.lastName ?? ""]
            .join(" ")
            .trim() ||
          req.user!.email ||
          undefined;
        await sendUserInviteEmail({
          email,
          firstName,
          lastName,
          link: inviteLink,
          invitedByName,
        }).catch((err) => {
          logWarn("admin_invite.email-failed", {
            email,
            err: String(err).slice(0, 200),
          });
        });

        res.status(201).json({ user: profile, inviteLink });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to invite user") });
      }
    },
  );

  // PATCH /api/admin/users/:id — update status / roles / contact info.
  // Plan is owned by Stripe (manage subscriptions in the Stripe
  // dashboard).
  app.patch(
    "/api/admin/users/:id",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("users.manage"),
    async (req, res) => {
      try {
        const ref = db().collection(COL.users).doc(reqStr(req.params.id));
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: "User not found" });
        const body = (req.body ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        if (body.firstName !== undefined) patch.firstName = body.firstName;
        if (body.lastName !== undefined) patch.lastName = body.lastName;
        if (body.phone !== undefined) patch.phone = body.phone;
        if (body.address !== undefined) patch.address = body.address;
        if (body.status) {
          const s = String(body.status).toLowerCase();
          if (!["active", "suspended", "invited", "pending"].includes(s))
            return res.status(400).json({ error: "invalid status" });
          // Status changes that cross the "suspended" boundary
          // (suspend or reactivate) require the stricter users.suspend
          // privilege — the outer route only checks users.manage,
          // which Manager has too. Without this, Manager could
          // reactivate a suspended user from the Edit dialog and undo
          // what only Admin is supposed to be able to do.
          const currentStatus = (snap.data() as User).status;
          const crossesSuspendBoundary = s === "suspended" || currentStatus === "suspended";
          if (crossesSuspendBoundary) {
            const ok = await hasPlatformPrivilege(req.user?.profile, "users.suspend");
            if (!ok) {
              return res.status(403).json({
                error: "You don't have permission to suspend or reactivate users.",
              });
            }
          }
          patch.status = s;
        }
        if (Array.isArray(body.roles)) {
          const valid = ["tenant", "owner", "admin", "superadmin"];
          const roles = (body.roles as unknown[])
            .filter((r): r is string => typeof r === "string")
            .map((r) => r.toLowerCase())
            .filter((r) => valid.includes(r));
          if (roles.length === 0)
            return res.status(400).json({ error: "at least one valid role is required" });

          // PRIVILEGE GATE — the outer route checks `users.manage`
          // (granted to admin + manager by default), but role
          // ASSIGNMENT is a higher-trust action. Without this, a
          // Manager-platformRole user could PATCH their OWN user doc
          // with roles:["superadmin"] and bypass the entire platform-
          // role privilege matrix.
          const canAssignRoles = await hasPlatformPrivilege(req.user?.profile, "users.assignRoles");
          if (!canAssignRoles) {
            return res.status(403).json({
              error: "You don't have permission to change user roles.",
            });
          }

          // SUPERADMIN GATE — even users with `users.assignRoles`
          // cannot mint a new superadmin unless they themselves are a
          // superadmin. This blocks the privesc path where a regular
          // Admin promotes themselves (or anyone) to superadmin,
          // which bypasses every platform-privilege check including
          // the matrix itself.
          const current = snap.data() as User;
          const wasSuperadmin = current.roles?.includes("superadmin") ?? false;
          const willBeSuperadmin = roles.includes("superadmin");
          const callerIsSuperadmin = req.user?.profile?.roles?.includes("superadmin") ?? false;
          if (willBeSuperadmin && !wasSuperadmin && !callerIsSuperadmin) {
            return res.status(403).json({
              error: "Only a superadmin can promote a user to superadmin.",
            });
          }

          // Block the demote-via-PATCH path to the last-superadmin
          // lockout — same threat as DELETE, different door.
          const stillSuperadmin = willBeSuperadmin;
          if (
            wasSuperadmin &&
            !stillSuperadmin &&
            (await isLastSuperadmin(reqStr(req.params.id)))
          ) {
            return res.status(409).json({
              error:
                "Cannot remove superadmin from the last superadmin. Promote another user first.",
            });
          }
          patch.roles = roles;
        }
        if (body.platformRole !== undefined) {
          // platformRole determines which privileges the user has
          // from the matrix — assigning it is itself a high-trust
          // action. Gate on users.assignRoles to match the body.roles
          // path above.
          const canAssignRoles2 = await hasPlatformPrivilege(
            req.user?.profile,
            "users.assignRoles",
          );
          if (!canAssignRoles2) {
            return res.status(403).json({
              error: "You don't have permission to change platform roles.",
            });
          }
          if (body.platformRole === null || body.platformRole === "") {
            patch.platformRole = FieldValue.delete();
          } else if (
            typeof body.platformRole === "string" &&
            PLATFORM_ROLES.includes(body.platformRole as PlatformRoleKey)
          ) {
            patch.platformRole = body.platformRole;
          } else {
            return res.status(400).json({ error: "invalid platformRole" });
          }
        }

        // Stale-platformRole cleanup: if the final roles array contains
        // neither "admin" nor "superadmin", a platformRole on this doc
        // is dead data — drop it regardless of what the body said.
        // Prevents a future engineer from seeing `platformRole:
        // "marketing"` on a tenant-only user and getting confused.
        const currentBefore = snap.data() as User;
        const effectiveRoles = Array.isArray(patch.roles)
          ? (patch.roles as string[])
          : (currentBefore.roles ?? []);
        const stillStaff =
          effectiveRoles.includes("admin") || effectiveRoles.includes("superadmin");
        if (!stillStaff && currentBefore.platformRole !== undefined) {
          patch.platformRole = FieldValue.delete();
        }

        // Reactivation: if status is moving away from "suspended",
        // re-enable the Firebase Auth account that DELETE /users/:id
        // had disabled. Skip the round-trip when the user wasn't
        // suspended to begin with.
        const reactivating =
          patch.status !== undefined &&
          patch.status !== "suspended" &&
          currentBefore.status === "suspended";
        if (reactivating) {
          try {
            await auth().updateUser(reqStr(req.params.id), { disabled: false });
          } catch (err) {
            logError("auth.reactivate-failed", err, { uid: req.params.id });
          }
        }

        // If this PATCH removes the superadmin role, do the recount +
        // write inside a transaction. Without this, two superadmins
        // could both demote each other simultaneously — both pass
        // isLastSuperadmin (each sees the other still exists), both
        // write, → zero superadmins, platform locked out, recovery
        // only via direct Firestore console edit.
        const removingSuperadmin =
          Array.isArray(patch.roles) &&
          (currentBefore.roles?.includes("superadmin") ?? false) &&
          !(patch.roles as string[]).includes("superadmin");
        if (removingSuperadmin) {
          const raced = await db().runTransaction(async (t) => {
            const supers = await t.get(
              db().collection(COL.users).where("roles", "array-contains", "superadmin"),
            );
            const remaining = supers.docs.filter((d) => d.id !== req.params.id).length;
            if (remaining < 1) return true; // would be the last
            t.set(ref, patch, { merge: true });
            return false;
          });
          if (raced) {
            return res.status(409).json({
              error:
                "Cannot remove superadmin from the last superadmin. Promote another user first.",
            });
          }
        } else {
          await ref.set(patch, { merge: true });
        }
        const updatedSnap = await ref.get();
        const updated = updatedSnap.data() as User;

        // Force refresh-token revocation when this PATCH changed
        // roles, platformRole, or status. Firebase ID tokens are
        // signed snapshots that don't reflect Firestore-doc changes
        // until refresh (default ~1h). Without revoke, a freshly-
        // demoted admin keeps admin privileges via their cached token
        // for up to an hour; a freshly-suspended user can keep
        // hitting authenticated endpoints with their stale token
        // until expiry. Best-effort.
        const securityRelevantChange =
          patch.roles !== undefined ||
          patch.platformRole !== undefined ||
          patch.status !== undefined;
        if (securityRelevantChange) {
          try {
            await auth().revokeRefreshTokens(reqStr(req.params.id));
          } catch (err) {
            logError("auth.revoke-tokens-failed", err, {
              uid: req.params.id,
              source: "admin-user-patch",
            });
          }
        }

        // Audit log: when an admin changes another user's roles,
        // platformRole, or status, write a doc to COL.userAudit. Self-
        // edits (own contact info) skip the log because they're
        // routine. See UserAuditEntry in shared/firestore-schema for
        // the full shape.
        const actorUid = req.user!.uid;
        const isSelfEdit = actorUid === req.params.id;
        if (!isSelfEdit) {
          const rolesChanged =
            patch.roles !== undefined &&
            JSON.stringify(currentBefore.roles ?? []) !== JSON.stringify(updated.roles ?? []);
          const platformRoleChanged =
            (currentBefore.platformRole ?? null) !== (updated.platformRole ?? null);
          const statusChanged =
            patch.status !== undefined && currentBefore.status !== updated.status;

          if (rolesChanged || platformRoleChanged || statusChanged) {
            const auditRef = db().collection(COL.userAudit).doc();
            const entry: UserAuditEntry = {
              id: auditRef.id,
              actorUid,
              actorEmail: req.user!.email ?? "",
              targetUid: reqStr(req.params.id),
              targetEmail: updated.email ?? "",
              ...(rolesChanged
                ? {
                    beforeRoles: currentBefore.roles ?? [],
                    afterRoles: updated.roles ?? [],
                  }
                : {}),
              ...(platformRoleChanged
                ? {
                    beforePlatformRole: currentBefore.platformRole ?? null,
                    afterPlatformRole: updated.platformRole ?? null,
                  }
                : {}),
              ...(statusChanged
                ? {
                    beforeStatus: currentBefore.status ?? "",
                    afterStatus: updated.status ?? "",
                  }
                : {}),
              createdAt: new Date().toISOString(),
            };
            // Fire-and-forget the audit write so the user's API
            // request doesn't wait on it; log failures via logError
            // so they're at least visible during incident review.
            auditRef.set(entry).catch((err) => {
              logError("audit.write-failed", err, { source: "user-patch" });
            });
          }
        }

        res.json(updated);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to update user") });
      }
    },
  );

  // DELETE /api/admin/users/:id — soft delete (sets status to
  // "suspended" unless ?hard=true is passed AND the user has no
  // linked properties or tenancies). Hard-delete is intentionally
  // restrictive to avoid orphaning related records.
  app.delete(
    "/api/admin/users/:id",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("users.suspend"),
    async (req, res) => {
      try {
        const id = reqStr(req.params.id);
        const ref = db().collection(COL.users).doc(id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: "User not found" });

        // Refuse to suspend/delete the last superadmin — see
        // isLastSuperadmin helper for the reasoning. Soft-delete
        // (suspend) counts as removal because a suspended account
        // can't sign in.
        const targetUser = snap.data() as User;
        if (targetUser.roles?.includes("superadmin") && (await isLastSuperadmin(id))) {
          return res.status(409).json({
            error:
              "Cannot suspend or delete the last superadmin. Promote another user to superadmin first.",
          });
        }

        const hard = req.query.hard === "true";
        if (hard) {
          const blockers = await findHardDeleteBlockers(id);
          if (blockers.length > 0) {
            return res.status(409).json({ error: hardDeleteBlockerMessage(blockers[0]) });
          }
          // GDPR right-to-erasure (Art. 17). Cascade-delete every doc
          // + storage object keyed off this user before removing the
          // user doc itself. Transactions and audit logs intentionally
          // stay — see deleteUserCascade for the rationale.
          const cascade = await deleteUserCascade(id);
          // Best-effort: delete the Firebase Auth account too. If it's
          // already gone (user-not-found), keep going so the Firestore
          // row is removed.
          try {
            await auth().deleteUser(id);
          } catch (err: unknown) {
            const e = err as { code?: string };
            if (e?.code !== "auth/user-not-found") {
              logError("auth.delete-failed", err, {
                uid: id,
                source: "admin-hard-delete",
              });
            }
          }
          await ref.delete();
          return res.status(200).json({ ok: true, cascade });
        }
        const beforeStatus = targetUser.status ?? "";
        await ref.set({ status: "suspended" }, { merge: true });
        // Also disable the Firebase Auth account so the user can't
        // sign in fresh + revoke their refresh tokens so any cached
        // ID token is invalidated within ~1h (Firebase ID tokens are
        // signed snapshots that don't see the disabled bit until
        // refresh). requireAuth blocks anyone holding a still-valid
        // token via the status check on the user doc;
        // revokeRefreshTokens closes the narrower "they sit on a
        // token they minted just before suspend" window too. Both
        // best-effort — if the Auth user is already gone, log and
        // continue.
        try {
          await auth().updateUser(id, { disabled: true });
          await auth().revokeRefreshTokens(id);
        } catch (err) {
          logError("auth.disable-failed", err, {
            uid: id,
            source: "suspend",
          });
        }
        const updated = (await ref.get()).data() as User;
        // Mirror the PATCH route's audit behavior: a status change
        // driven by an admin gets a UserAuditEntry. Skip if the user
        // was somehow already suspended (no-op suspend) so we don't
        // pollute the log.
        if (beforeStatus !== "suspended") {
          const auditRef = db().collection(COL.userAudit).doc();
          const entry: UserAuditEntry = {
            id: auditRef.id,
            actorUid: req.user!.uid,
            actorEmail: req.user!.email ?? "",
            targetUid: id,
            targetEmail: updated.email ?? "",
            beforeStatus,
            afterStatus: "suspended",
            createdAt: new Date().toISOString(),
          };
          auditRef.set(entry).catch((err) => {
            logError("audit.write-failed", err, { source: "suspend" });
          });
        }
        res.json(updated);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to delete user") });
      }
    },
  );

  // POST /api/admin/users/:id/send-reset-email — admin-initiated
  // password reset. Looks up the user, then sends them the same
  // branded reset email that /api/auth/forgot-password sends — but
  // surfaces a real error if the user can't be resolved (no
  // enumeration protection here; the admin is already authenticated
  // and authorized).
  app.post(
    "/api/admin/users/:id/send-reset-email",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("users.manage"),
    async (req, res) => {
      const targetId = String(req.params.id || "").trim();
      if (!targetId) {
        return res.status(400).json({ error: "user id is required" });
      }
      try {
        const snap = await db().collection(COL.users).doc(targetId).get();
        if (!snap.exists) {
          return res.status(404).json({ error: "User not found" });
        }
        const target = snap.data() as User;
        if (!target.email) {
          return res.status(400).json({ error: "Target user has no email on file" });
        }
        await sendPasswordResetEmail(target.email);
        res.json({ ok: true, email: target.email });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to send reset email") });
      }
    },
  );

  // POST /api/admin/users/:id/impersonate — mint a Firebase custom
  // token the calling admin can use to sign into app.oliowallet.com
  // as the target user.
  //
  // Hard rules:
  //   • Target must NOT be admin/superadmin — admins can't view-as
  //     each other. This prevents an admin from quietly assuming a
  //     peer's account; if you need a peer's view, sign in as them
  //     through normal channels.
  //   • Every successful impersonation writes an audit doc to
  //     COL.impersonations before the token is returned, so the trail
  //     exists even if the client never opens the link.
  //
  // The client opens the returned redirectUrl in a NEW TAB. Because
  // app/ and platform/ are different origins, the admin's platform
  // session is untouched. The new tab signs into app/ as the target
  // user via signInWithCustomToken.
  app.post(
    "/api/admin/users/:id/impersonate",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("users.manage"),
    async (req, res) => {
      const actorUid = req.user!.uid;
      const actorEmail = req.user!.email ?? "";
      // Per-admin cap on impersonation token mints. This endpoint
      // hands back a Firebase customToken that signs the caller in
      // AS the target user; a compromised admin account that loops
      // this would mint impersonation tokens for every user one-by-
      // one. 30/hour is well above any legit support workflow but
      // caps the runaway case.
      const impersonateLimit = await rateLimit(`impersonate:${actorUid}`, 30, 60 * 60);
      if (!impersonateLimit.allowed) {
        res.set("Retry-After", String(impersonateLimit.retryAfterSeconds));
        return res.status(429).json({
          error: "Too many impersonation requests. Try again shortly.",
          retryAfterSeconds: impersonateLimit.retryAfterSeconds,
        });
      }
      const targetId = String(req.params.id || "").trim();
      if (!targetId) {
        return res.status(400).json({ error: "user id is required" });
      }
      if (targetId === actorUid) {
        return res.status(400).json({ error: "You can't impersonate yourself" });
      }

      try {
        const targetRef = db().collection(COL.users).doc(targetId);
        const targetSnap = await targetRef.get();
        if (!targetSnap.exists) {
          return res.status(404).json({ error: "User not found" });
        }
        const target = targetSnap.data() as User;

        // No peer impersonation — staff can't quietly assume another
        // staff account. Even with users.manage, the answer is no.
        if (target.roles?.includes("admin") || target.roles?.includes("superadmin")) {
          return res.status(403).json({
            error:
              "Cannot impersonate another admin or superadmin. Use their own credentials if you need their view.",
          });
        }

        // Suspended targets can't sign in anyway (Firebase rejects
        // signInWithCustomToken when the account is disabled), so
        // refuse here with a clear message instead of a cryptic
        // auth/* error in the impersonated tab.
        if (target.status === "suspended") {
          return res.status(409).json({
            error:
              "Cannot impersonate a suspended user. Reactivate them first if you need this view.",
          });
        }

        // The `impersonated` claim persists into every ID token of the
        // resulting session, so the user app can tell View-As-User apart
        // from the real user and suppress account-mutating UI (e.g. the
        // one-time role-selection prompt must not be consumed — or owner
        // mode flipped — by a browsing admin).
        const customToken = await auth().createCustomToken(targetId, { impersonated: true });

        const now = new Date().toISOString();
        const logRef = db().collection(COL.impersonations).doc();
        const logDoc: ImpersonationLog = {
          id: logRef.id,
          actorUid,
          actorEmail,
          targetUid: targetId,
          targetEmail: target.email ?? "",
          createdAt: now,
        };
        await logRef.set(logDoc);

        res.json({ customToken, targetEmail: target.email ?? "" });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to start impersonation") });
      }
    },
  );

  // ── Complimentary plan grant + revoke ─────────────────────────────
  // Grants advance / pro / business for 12 months by writing the
  // `stripeRole` custom claim (so the existing usePlan() reader picks
  // it up) and persisting an audit doc. Refuses if the user already
  // has a paid Stripe subscription — admins should manage paid subs in
  // Stripe directly. Plan keys preserve the legacy names internally:
  // advance=Growth, pro=Pro, business=Business (sales-led only; no
  // Stripe product exists).
  app.post(
    "/api/admin/users/:id/comp-plan",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("users.assignRoles"),
    async (req, res) => {
      try {
        const userId = reqStr(req.params.id);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const plan: ComplimentaryPlanType | null =
          body.plan === "pro"
            ? "pro"
            : body.plan === "advance"
              ? "advance"
              : body.plan === "business"
                ? "business"
                : null;
        if (!plan)
          return res.status(400).json({ error: "plan must be 'advance', 'pro', or 'business'" });

        const userSnap = await db().collection(COL.users).doc(userId).get();
        if (!userSnap.exists) return res.status(404).json({ error: "User not found" });

        // Comp plans are an owner-tier perk (Growth/Pro/Business map to
        // owner privileges + unit caps). A tenant-only user can't
        // actually exercise the plan, so auto-promote them to owner
        // here. Idempotent for users who already have the role.
        const userDoc = userSnap.data() as User;
        const existingRoles = Array.isArray(userDoc.roles) ? userDoc.roles : [];
        const needsOwnerRole = !existingRoles.includes("owner");
        if (needsOwnerRole) {
          await db()
            .collection(COL.users)
            .doc(userId)
            .set({ roles: [...existingRoles, "owner"] }, { merge: true });
        }

        const authUser = await auth().getUser(userId);
        // "Already has a paid subscription" must be decided by the SAME
        // source the revoke route + expiry cron use: the Stripe Payments
        // extension's `customers/{uid}/subscriptions` mirror, filtered to
        // active/trialing. The stripeRole claim is an unreliable proxy (a
        // comp grant sets it too), so inferring from it (L-12) disagreed
        // with the revoke path — a comped user looked "paid" and couldn't
        // be re-granted/upgraded, while a real subscriber whose webhook
        // hadn't landed yet looked "free".
        const subSnap = await db()
          .collection("customers")
          .doc(userId)
          .collection("subscriptions")
          .where("status", "in", ["active", "trialing"])
          .limit(1)
          .get();
        if (!subSnap.empty) {
          // The user has a real paid Stripe subscription — admins manage
          // those in the Stripe dashboard, not here.
          return res.status(409).json({
            error:
              "User already has an active Stripe subscription. Manage paid plans in the Stripe dashboard.",
          });
        }

        // Capture the owner's effective tier BEFORE we overwrite the claim, so
        // we can mirror the Stripe webhook's reconcile after the grant lands.
        const priorRole = (authUser.customClaims as { stripeRole?: unknown } | undefined)
          ?.stripeRole;
        const oldPlan: OwnerPlanKey =
          priorRole === "advance" || priorRole === "pro" || priorRole === "business"
            ? priorRole
            : "basic";

        await auth().setCustomUserClaims(userId, {
          ...(authUser.customClaims ?? {}),
          stripeRole: plan,
        });

        // If we just promoted a tenant to owner, revoke their refresh
        // tokens so the cached ID token (which still lacks owner-side
        // privileges) gets re-minted on next request. Without this they
        // could stay on the tenant portal for up to an hour despite the
        // grant landing successfully.
        if (needsOwnerRole) {
          try {
            await auth().revokeRefreshTokens(userId);
          } catch (err) {
            logError("auth.revoke-tokens-failed", err, {
              uid: userId,
              source: "comp-plan-grant",
            });
          }
        }

        const grantedAt = new Date();
        const expiresAt = new Date(grantedAt);
        expiresAt.setFullYear(expiresAt.getFullYear() + 1);
        const grantorName =
          (req.user!.profile?.firstName || "") + " " + (req.user!.profile?.lastName || "");
        const grant: ComplimentaryPlan = {
          id: userId,
          userId,
          plan: plan as ComplimentaryPlanType,
          grantedAt: grantedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          grantedByUid: req.user!.uid,
          grantedByName: grantorName.trim() || req.user!.email || "Admin",
          status: "active",
        };
        await db().collection(COL.complimentaryPlans).doc(userId).set(grant);

        // Mirror the Stripe webhook's two-sided reconcile. Gifted owners have NO
        // Stripe subscription, so customer.subscription.updated never fires for
        // them — without this, a re-grant or tier UPGRADE after a prior downgrade
        // leaves soft-deactivated properties hidden (and the 30-day sweep then
        // PURGES their documents + terminates leases even though the owner is
        // fully back on a paid tier). A comp tier DOWNGRADE (e.g. pro→advance)
        // conversely must soft-deactivate the now-over-cap excess. Best-effort:
        // the claim + grant doc are already committed, so a cleanup hiccup must
        // not fail the grant — the next sweep/edit re-trips the boundary.
        try {
          if (PLAN_RANK[plan] > PLAN_RANK[oldPlan]) {
            await reactivateAfterPlanUpgrade(userId, oldPlan, plan);
          } else if (PLAN_RANK[plan] < PLAN_RANK[oldPlan]) {
            await reconcileAfterPlanChange(userId, oldPlan, plan);
          }
        } catch (err) {
          logError("comp-plan-grant.reconcile-failed", err, {
            uid: userId,
            oldPlan,
            newPlan: plan,
          });
        }

        res.status(201).json(grant);
      } catch (err: unknown) {
        res.status(500).json({
          error: errMsg(err, "Failed to grant complimentary plan"),
        });
      }
    },
  );

  app.delete(
    "/api/admin/users/:id/comp-plan",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("users.assignRoles"),
    async (req, res) => {
      try {
        const userId = reqStr(req.params.id);
        const grantRef = db().collection(COL.complimentaryPlans).doc(userId);
        const grantSnap = await grantRef.get();
        if (!grantSnap.exists) return res.status(404).json({ error: "No active comp plan found" });
        const grant = grantSnap.data() as ComplimentaryPlan;

        const authUser = await auth().getUser(userId);
        const claims = { ...(authUser.customClaims ?? {}) } as Record<string, unknown>;

        // Don't strip the stripeRole claim if the user has since
        // bought a real Stripe subscription (the Payments extension
        // would have overwritten our comp-set role with theirs).
        // Without this check, revoking the comp grant accidentally
        // demotes a paying customer — they lose Pro privileges until
        // the next Stripe webhook fires (could be up to a month).
        // Tell-tale: the live Stripe customer doc has an active
        // subscription. We read the extension's
        // `customers/{uid}/subscriptions` mirror.
        const subSnap = await db()
          .collection("customers")
          .doc(userId)
          .collection("subscriptions")
          .where("status", "in", ["active", "trialing"])
          .limit(1)
          .get();
        const hasActivePaidSub = !subSnap.empty;
        if (!hasActivePaidSub) {
          delete claims.stripeRole;
          await auth().setCustomUserClaims(userId, claims);
          // Force ID-token refresh so the demoted user loses Pro
          // privileges within ~1h instead of inheriting the cached
          // claim. The setCustomUserClaims call alone doesn't
          // invalidate existing tokens.
          try {
            await auth().revokeRefreshTokens(userId);
          } catch (err) {
            logError("auth.revoke-tokens-failed", err, {
              uid: userId,
              source: "comp-plan-revoke",
            });
          }
          // The comp grant set the stripeRole claim, so clearing it is a real
          // downgrade to basic. Run the same cap / rent-collection cleanup the
          // Stripe webhook runs on a paid downgrade — otherwise over-cap
          // properties survive and Stripe rent keeps collecting on a plan that
          // no longer permits it. Best-effort: the claim is already cleared, so
          // a cleanup hiccup must not fail the revoke (the next sweep/edit will
          // re-trip the boundary).
          try {
            await reconcileAfterPlanChange(userId, grant.plan, "basic");
          } catch (err) {
            logError("comp-plan-revoke.reconcile-failed", err, { uid: userId });
          }
        }
        // If they DO have an active paid sub, leave the claim
        // untouched — it's now owned by Stripe, and the comp doc
        // transitions to revoked regardless so the cron won't try to
        // expire it again.

        await grantRef.set(
          { status: "revoked", revokedAt: new Date().toISOString() },
          { merge: true },
        );
        res.json({
          ok: true,
          claimPreservedByActiveSub: hasActivePaidSub,
        });
      } catch (err: unknown) {
        res.status(500).json({
          error: errMsg(err, "Failed to revoke complimentary plan"),
        });
      }
    },
  );
}
