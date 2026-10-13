// Portfolio Access Contacts + the invitee-side consent flow + the
// "accessible portfolios" reader.
//
// Owners grant a trusted person (legacy / legal / financial) view (or
// view+edit) access to their portfolio. Doc id pattern is
// `${ownerId}_${type}` so listing is one prefixed query and upsert is a
// deterministic write. Invitee must explicitly accept before any data
// flows — pending invites surface in the invitee's notification UI and
// can be accepted or declined.

import type { Express, Request } from "express";
import { auth, db } from "../firebase";
import { requireAuth } from "../auth";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { errMsg } from "../services/errMsg";
import { logWarn } from "../services/log";
import { notifyUser } from "../services/push";
import { sendPortfolioAccessInviteEmail } from "../services/transactionalEmail";
import { ensurePortfolio, getPortfolio } from "../services/portfolioBanking";
import { resolveOwnerPlan } from "../services/commission";
import { generatePortfolioId } from "../util";
import {
  COL,
  type AccessContactType,
  type AccessPermission,
  type OwnerPlanKey,
  type PortfolioAccessContact,
  type User,
} from "../../shared/firestore-schema";

// Human-friendly name for the signed-in invitee — used in the owner-facing
// accept/decline push. Mirrors the ownerName fallback chain in the PUT handler.
function inviteeDisplayName(req: Request): string {
  return (
    [req.user?.profile?.firstName ?? "", req.user?.profile?.lastName ?? ""].join(" ").trim() ||
    req.user?.profile?.email ||
    req.user?.email ||
    "Your contact"
  );
}

const ACCESS_CONTACT_TYPES: AccessContactType[] = ["legacy", "legal", "financial"];
const ACCESS_PERMISSIONS_BY_TYPE: Record<AccessContactType, AccessPermission[]> = {
  legacy: ["view", "edit"],
  legal: ["view"],
  financial: ["view"],
};

export function registerAccessRoutes(app: Express): void {
  // ── Owner side ─────────────────────────────────────────────────────

  app.get("/api/owner/access-contacts", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    try {
      // The owner's grants are scoped by the STABLE portfolio doc id. The
      // ownerId-keyed query below is a SELF-scoped, display-only completeness
      // net for this owner's own list (every prod row is stamped, so it's
      // expected dead) — it is NOT an authorization path; grant AUTHZ lookups
      // (ownerScope/portfolioPrivilege) are portfolioId-only since Phase 4.
      const portfolio = await getPortfolio(uid);
      let contacts: PortfolioAccessContact[] = [];
      if (portfolio) {
        const snaps = await db()
          .collection(COL.portfolioAccessContacts)
          .where("portfolioId", "==", portfolio.id)
          .get();
        contacts = snaps.docs.map((d) => d.data() as PortfolioAccessContact);
      }
      if (contacts.length === 0) {
        const snaps = await db()
          .collection(COL.portfolioAccessContacts)
          .where("ownerId", "==", uid)
          .get();
        contacts = snaps.docs.map((d) => d.data() as PortfolioAccessContact);
      }
      res.json(contacts);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load access contacts") });
    }
  });

  // Upsert one slot. The contact must already have an Olio account for the
  // grant to actually activate — but we MUST NOT reveal whether the email
  // maps to an account. A distinct 404 on user-not-found would be an
  // account-existence oracle (the same enumeration leak forgotPassword.ts
  // deliberately avoids). So when no Firebase Auth user matches we still seed
  // the same pending grant doc and return the same success-shaped response —
  // but with an empty contactUserId, which never matches any invitee-side
  // `contactUserId == uid` query, so the grant is inert (it can never surface
  // as an invitation or accessible portfolio) and we skip the invite
  // email/push. The caller can't tell existence from non-existence.
  // (Earlier versions auto-provisioned an account with a copy-link; we now
  // require an explicit sign-up to avoid creating accounts on people's behalf.)
  app.put("/api/owner/access-contacts/:type", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const type = req.params.type as AccessContactType;
    if (!ACCESS_CONTACT_TYPES.includes(type)) {
      return res.status(400).json({ error: "Invalid contact type" });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!name) return res.status(400).json({ error: "name is required" });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "valid email is required" });
    if (email === (req.user!.email ?? "").toLowerCase())
      return res.status(400).json({ error: "You can't assign access to your own account" });

    // This route sends an invite email + push as a side effect, so cap it per
    // owner to bound send-credit burn and stop an owner from spamming invites
    // at arbitrary addresses. 10/hour is well above any legit workflow (three
    // slots, occasional re-invite) but caps the runaway case.
    const inviteLimit = await rateLimit(`access-contact:${uid}`, 10, 60 * 60);
    if (!inviteLimit.allowed) {
      res.set("Retry-After", String(inviteLimit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many access-contact invites. Try again shortly.",
        retryAfterSeconds: inviteLimit.retryAfterSeconds,
      });
    }

    try {
      // Resolve the invitee's account, but never disclose whether one exists:
      // null means no account, which seeds an inert grant (empty contactUserId)
      // and suppresses the side-effect notifications below.
      let contactUserId = "";
      try {
        const existing = await auth().getUserByEmail(email);
        contactUserId = existing.uid;
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e?.code !== "auth/user-not-found") throw err;
        // user-not-found: fall through with the empty contactUserId.
      }
      const accountExists = contactUserId !== "";

      const docId = `${uid}_${type}`;
      const ref = db().collection(COL.portfolioAccessContacts).doc(docId);
      const prev = await ref.get();
      const now = new Date().toISOString();
      const prevData = prev.exists ? (prev.data() as PortfolioAccessContact) : null;

      // Stamp the stable portfolio id (Portfolio.id, NOT the human display
      // label) so the grant is keyed to the portfolio, which survives an
      // owner transfer. The doc id stays `${ownerId}_${type}` for now —
      // queries against the portfolio must use this FIELD.
      const portfolio = await ensurePortfolio(uid);

      // Privacy: invitee MUST accept before access is granted. Without
      // this, owner X could spam fake portfolio entries into anyone's
      // sidebar without consent — the invitee would see X's properties
      // in their app without ever opting in. We seed `status: "pending"`
      // on every new contact (or when the contactUserId changes — re-
      // invite of a different person resets the consent). Re-PUT
      // against the SAME contact preserves their prior acceptance so an
      // owner editing the contact name doesn't kick the invitee back
      // into pending state.
      const sameContactAsBefore =
        prevData?.contactUserId === contactUserId && prevData?.email === email;
      // A re-invite of someone who previously declined should reset the
      // grant to "pending" so the owner can ask again — otherwise the
      // contact would be stuck in the declined state forever.
      const wasDeclined = prevData?.status === "declined";
      const preservedStatus = sameContactAsBefore && !wasDeclined ? prevData?.status : undefined;
      const preservedAcceptedAt =
        sameContactAsBefore && !wasDeclined ? prevData?.acceptedAt : undefined;

      const contact: PortfolioAccessContact = {
        id: docId,
        ownerId: uid,
        portfolioId: portfolio.id,
        type,
        name,
        email,
        permissions: ACCESS_PERMISSIONS_BY_TYPE[type],
        status: preservedStatus ?? "pending",
        contactUserId,
        // Bump invitedAt on a fresh invite (new contact or re-invite of a
        // declined one) so the activity log timeline reflects the new ask.
        invitedAt: sameContactAsBefore && !wasDeclined ? (prevData?.invitedAt ?? now) : now,
        ...(preservedAcceptedAt ? { acceptedAt: preservedAcceptedAt } : {}),
      };
      await ref.set(contact);

      // Notify the invitee so they can accept. Skip when re-PUTting
      // an already-active grant (just a metadata edit, no consent
      // change), and skip entirely when no account exists (an inert
      // grant has no one to notify — and sending here would re-leak the
      // account-existence signal we just suppressed above). Fire push +
      // email in parallel — both best-effort. Push reaches in-session
      // users instantly; email covers anyone who isn't currently signed
      // in or hasn't enabled push.
      if (accountExists && (!sameContactAsBefore || preservedStatus === "pending" || wasDeclined)) {
        const ownerName =
          [req.user!.profile?.firstName ?? "", req.user!.profile?.lastName ?? ""]
            .join(" ")
            .trim() ||
          req.user!.profile?.email ||
          req.user!.email ||
          "An Olio user";
        await Promise.all([
          notifyUser({
            externalUserId: contactUserId,
            category: "propertyActivity",
            title: "Portfolio access invitation",
            message: `${ownerName} wants to grant you ${type} access to their portfolio. Open Olio to accept or decline.`,
            url: "https://app.oliowallet.com/portfolio-access",
          }).catch((err) => {
            // Non-fatal — the contact is still created, the invitee
            // will see the pending invite in their UI the next time
            // they sign in.
            logWarn("access_contact.notify-failed", {
              err: String(err).slice(0, 200),
            });
          }),
          sendPortfolioAccessInviteEmail({
            email,
            ownerName,
            type,
          }).catch((err) => {
            // Same rationale — pending invite is durable in Firestore
            // so the invitee finds it on their next sign-in even if
            // both notification channels fail.
            logWarn("access_contact.email-failed", {
              err: String(err).slice(0, 200),
            });
          }),
        ]);
      }

      // Return the grant WITHOUT the resolved contactUserId. That field is
      // the one place the response would otherwise differ for an existing vs
      // non-existing account (a real uid vs ""), which would re-open the
      // enumeration oracle. The owner UI doesn't need the invitee's uid; the
      // real value is persisted to Firestore above.
      const { contactUserId: _omitContactUserId, ...safeContact } = contact;
      res.json(safeContact);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to save access contact") });
    }
  });

  app.delete("/api/owner/access-contacts/:type", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const type = req.params.type as AccessContactType;
    if (!ACCESS_CONTACT_TYPES.includes(type)) {
      return res.status(400).json({ error: "Invalid contact type" });
    }
    try {
      await db().collection(COL.portfolioAccessContacts).doc(`${uid}_${type}`).delete();
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to remove access contact") });
    }
  });

  // ── Invitee side ───────────────────────────────────────────────────
  // The 3 endpoints below run as the INVITEE (the person being granted
  // access), not the owner who created the contact. Together with the
  // status="pending" default on PUT, they implement opt-in consent: a
  // grant is dormant until the invitee explicitly accepts.

  // List the invitations the caller has pending — what owners have
  // asked for legacy/legal/financial access? Used by the
  // /portfolio-access notification surface.
  app.get("/api/access-contacts/invitations", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    try {
      const snaps = await db()
        .collection(COL.portfolioAccessContacts)
        .where("contactUserId", "==", uid)
        .where("status", "==", "pending")
        .get();
      const items = snaps.docs.map((d) => d.data() as PortfolioAccessContact);
      // Hydrate the owner side so the invitee sees a human name.
      const ownerIds = Array.from(new Set(items.map((g) => g.ownerId)));
      const ownerDocs = await Promise.all(
        ownerIds.map((id) => db().collection(COL.users).doc(id).get()),
      );
      const owners = new Map<string, User>();
      ownerDocs.forEach((s) => s.exists && owners.set(s.id, s.data() as User));
      const hydrated = items.map((g) => {
        const o = owners.get(g.ownerId);
        return {
          ...g,
          ownerName: o
            ? `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim() || (o.email ?? "")
            : "An Olio user",
          ownerEmail: o?.email ?? "",
        };
      });
      res.json(hydrated);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load invitations") });
    }
  });

  // Accept a pending invitation — flips status to "active" + records
  // acceptedAt. Only the invitee can accept; ownership-of-contact is
  // enforced by checking contactUserId === caller uid.
  app.post("/api/access-contacts/invitations/:id/accept", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const id = String(req.params.id || "");
    try {
      const ref = db().collection(COL.portfolioAccessContacts).doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Invitation not found" });
      const data = snap.data() as PortfolioAccessContact;
      if (data.contactUserId !== uid) {
        // Don't leak the invitation's existence to non-invitees — 404
        // not 403 for this case (the contact id is enumerable, since
        // it's `${ownerId}_${type}`, so the existence-vs-permission
        // distinction would itself leak data).
        return res.status(404).json({ error: "Invitation not found" });
      }
      if (data.status === "active") {
        // Idempotent — already accepted is fine.
        return res.json(data);
      }
      if (data.status !== "pending") {
        return res
          .status(409)
          .json({ error: `Cannot accept invitation in status "${data.status}"` });
      }
      const acceptedAt = new Date().toISOString();
      await ref.set({ status: "active", acceptedAt }, { merge: true });
      // Tell the owner their invitee accepted — mirrors the lease accept/
      // decline push on agreement.ownerId. Best-effort: a push hiccup must
      // never undo the already-committed status change.
      await notifyUser({
        externalUserId: data.ownerId,
        category: "propertyActivity",
        title: "Access invitation accepted",
        message: `${inviteeDisplayName(req)} accepted your ${data.type} portfolio access invitation.`,
        url: "https://app.oliowallet.com/owner",
      }).catch((err) => {
        logWarn("access_contact.accept-notify-failed", { err: String(err).slice(0, 200) });
      });
      res.json({ ...data, status: "active", acceptedAt });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to accept invitation") });
    }
  });

  // Decline a pending invitation — soft-delete (flip to status="declined"
  // + record declinedAt) so the platform activity log can surface the
  // response. The invitee's pending list filters on status=="pending"
  // so the invitation still disappears from their UI. Owner re-invite
  // via PUT resets the doc back to "pending". Same 404-not-403 leak-
  // protection as accept.
  app.post("/api/access-contacts/invitations/:id/decline", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const id = String(req.params.id || "");
    try {
      const ref = db().collection(COL.portfolioAccessContacts).doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Invitation not found" });
      const data = snap.data() as PortfolioAccessContact;
      if (data.contactUserId !== uid) {
        return res.status(404).json({ error: "Invitation not found" });
      }
      if (data.status !== "pending") {
        return res
          .status(409)
          .json({ error: `Cannot decline invitation in status "${data.status}"` });
      }
      const declinedAt = new Date().toISOString();
      await ref.set({ status: "declined", declinedAt }, { merge: true });
      // Mirror of the accept path — let the owner know their invitee declined.
      await notifyUser({
        externalUserId: data.ownerId,
        category: "propertyActivity",
        title: "Access invitation declined",
        message: `${inviteeDisplayName(req)} declined your ${data.type} portfolio access invitation.`,
        url: "https://app.oliowallet.com/owner",
      }).catch((err) => {
        logWarn("access_contact.decline-notify-failed", { err: String(err).slice(0, 200) });
      });
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to decline invitation") });
    }
  });

  // Portfolios I can see — my own (always included) plus every owner
  // who has added me as a legacy / legal / financial contact AND I've
  // accepted. Drives the sidebar portfolio switcher.
  //
  // Payload note: `portfolioId` is the human display label (legacy field
  // name, e.g. "OLIO-A4F2K9"); `portfolioDocId` is the STABLE Portfolio doc
  // id — the operative `?portfolioId=` scope key the client sends on every
  // scoped request. The client-side interface mirrors this shape.
  interface AccessiblePortfolioEntry {
    ownerId: string;
    portfolioId: string;
    portfolioDocId: string | null;
    ownerName: string;
    ownerEmail: string;
    role: "self" | AccessContactType;
    permissions: AccessPermission[];
    isSelf: boolean;
    ownerPlan: OwnerPlanKey;
  }

  app.get("/api/portfolios/accessible", requireAuth, async (req, res) => {
    const { uid, profile } = req.user!;
    try {
      const grantSnaps = await db()
        .collection(COL.portfolioAccessContacts)
        .where("contactUserId", "==", uid)
        .get();
      // Only ACCEPTED contacts grant access. Pending invites surface in
      // /api/access-contacts/invitations so the invitee can review +
      // accept/decline rather than silently inheriting whatever the
      // owner asked for.
      const grants = grantSnaps.docs
        .map((d) => d.data() as PortfolioAccessContact)
        .filter((g) => g.status === "active");

      // Hydrate each grant with the owner's name + portfolioId.
      const otherOwnerIds = Array.from(new Set(grants.map((g) => g.ownerId)));
      const ownerDocs = await Promise.all(
        otherOwnerIds.map((id) => db().collection(COL.users).doc(id).get()),
      );
      const owners = new Map<string, User>();
      ownerDocs.forEach((s) => s.exists && owners.set(s.id, s.data() as User));

      const selfPortfolioId = profile?.portfolioId ?? generatePortfolioId();
      // If the caller's profile somehow lacks a portfolioId (race
      // against /api/me backfill), persist what we just generated so
      // subsequent reads are stable.
      if (!profile?.portfolioId) {
        await db()
          .collection(COL.users)
          .doc(uid)
          .set({ portfolioId: selfPortfolioId }, { merge: true });
      }
      const selfName =
        `${profile?.firstName ?? ""} ${profile?.lastName ?? ""}`.trim() || (profile?.email ?? "");
      const selfEmail = profile?.email ?? req.user!.email ?? "";

      // STABLE portfolio doc ids — the ?portfolioId= scope keys. Self is
      // ensured (idempotent get-or-create, runs after the label persist
      // above so a fresh portfolio mirrors the stored label); granted
      // entries read the grant's stamped portfolioId, falling back to a
      // lookup by owner for unstamped legacy rows. null only when a
      // granted owner has no portfolio doc at all (they have no data).
      const selfPortfolio = await ensurePortfolio(uid);
      const grantPortfolioDocIds = await Promise.all(
        grants.map(async (g) => g.portfolioId ?? (await getPortfolio(g.ownerId))?.id ?? null),
      );

      // Resolve each portfolio's owner-plan so the client can gate
      // features by the portfolio's plan, not the caller's. Self +
      // grants resolved together; resolveOwnerPlan defaults to "basic"
      // on missing claim/lookup.
      const [selfPlan, ...grantPlans] = await Promise.all([
        resolveOwnerPlan(uid),
        ...grants.map((g) => resolveOwnerPlan(g.ownerId)),
      ]);

      const items: AccessiblePortfolioEntry[] = [
        {
          ownerId: uid,
          portfolioId: selfPortfolioId,
          portfolioDocId: selfPortfolio.id,
          ownerName: selfName,
          ownerEmail: selfEmail,
          role: "self" as const,
          permissions: ["view", "edit"] as AccessPermission[],
          isSelf: true,
          ownerPlan: selfPlan,
        },
        ...grants.map((g, i) => {
          const owner = owners.get(g.ownerId);
          const ownerName = owner
            ? `${owner.firstName ?? ""} ${owner.lastName ?? ""}`.trim() || (owner.email ?? "")
            : g.ownerId;
          return {
            ownerId: g.ownerId,
            portfolioId: owner?.portfolioId ?? "",
            portfolioDocId: grantPortfolioDocIds[i],
            ownerName,
            ownerEmail: owner?.email ?? "",
            role: g.type,
            permissions: g.permissions,
            isSelf: false,
            ownerPlan: grantPlans[i],
          };
        }),
      ];
      res.json(items);
    } catch (err: unknown) {
      res.status(500).json({
        error: errMsg(err, "Failed to load accessible portfolios"),
      });
    }
  });
}
