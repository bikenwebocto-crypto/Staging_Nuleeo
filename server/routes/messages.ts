// Owner ↔ tenant direct-message endpoints. Registered from server/routes.ts
// via `registerMessageRoutes(app)`. Access control: the caller MUST be one
// of the two participants on every request.
//
// Conversation creation is owner-only (POST /api/messages/start) and keyed
// off a tenancy doc that the owner owns; the tenant's User.id is read from
// the tenancy. The doc id is deterministic — `${ownerId}_${tenantUserId}`
// — so re-calling start is idempotent.

import type { Express } from "express";
import { FieldValue, FieldPath } from "firebase-admin/firestore";
import { db } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { notifyUser } from "../services/push";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { reqStr } from "../util";
import {
  COL,
  type Conversation,
  type ConversationMessage,
  type Tenant,
  type User,
} from "../../shared/firestore-schema";

const MAX_MESSAGE_LEN = 4000;

function conversationDocId(ownerId: string, tenantUserId: string): string {
  return `${ownerId}_${tenantUserId}`;
}

// Guard the `:id` path param before it reaches Firestore `doc()`. The id is a
// deterministic `${ownerId}_${tenantUserId}` of two UID segments, so it only
// ever contains URL-safe id characters. Anything else (a `/` that Express
// percent-decoded into a path separator, an empty/oversized value) would make
// `doc()` throw SYNCHRONOUSLY — and several handlers call it outside their
// try block — surfacing as an unhandled rejection / hung request instead of a
// clean 400. Firestore doc ids cap at 1500 bytes; the charset excludes `/` so
// the value can never resolve to a sub-path. Authorization is still the real
// boundary (loadConversationForCaller below); this just fails malformed ids
// fast and loud.
function isValidConversationId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,1500}$/.test(id);
}

async function loadConversationForCaller(
  conversationId: string,
  uid: string,
): Promise<
  { ok: true; conversation: Conversation } | { ok: false; status: number; error: string }
> {
  if (!isValidConversationId(conversationId)) {
    return { ok: false, status: 400, error: "Invalid conversation id" };
  }
  const snap = await db().collection(COL.conversations).doc(conversationId).get();
  if (!snap.exists) {
    return { ok: false, status: 404, error: "Conversation not found" };
  }
  const conversation = snap.data() as Conversation;
  if (conversation.ownerId !== uid && conversation.tenantUserId !== uid) {
    return { ok: false, status: 403, error: "Not a participant" };
  }
  return { ok: true, conversation };
}

export function registerMessageRoutes(app: Express): void {
  // ── List conversations for the caller ─────────────────────────────────────
  // Returns whichever role the caller participates in. Owners see all their
  // tenant threads; tenants see threads with their landlord(s). Each row
  // includes the counterpart's display name so the list view doesn't have
  // to do a second round-trip per row.
  //
  // The list is also where threads get materialized: every ACTIVE tenancy
  // whose tenant has signed up gets a conversation doc, so owners always see
  // one chat per active tenant and tenants one chat per landlord — nobody
  // has to find a "start chat" button first. Creation is idempotent (the doc
  // id is deterministic per pair) and uses create() so a concurrent start/
  // send can never be clobbered back to an empty thread. Existing docs are
  // never touched, which is what keeps history permanent: a thread outlives
  // its tenancy, and an ended tenancy's chat keeps showing here.
  app.get("/api/messages/conversations", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    try {
      const [ownerSide, tenantSide, tenanciesAsOwner, tenanciesAsTenant] = await Promise.all([
        db().collection(COL.conversations).where("ownerId", "==", uid).get(),
        db().collection(COL.conversations).where("tenantUserId", "==", uid).get(),
        db()
          .collection(COL.tenants)
          .where("ownerId", "==", uid)
          .where("status", "==", "active")
          .get(),
        db()
          .collection(COL.tenants)
          .where("userId", "==", uid)
          .where("status", "==", "active")
          .get(),
      ]);
      const all: Conversation[] = [
        ...ownerSide.docs.map((d) => d.data() as Conversation),
        ...tenantSide.docs.map((d) => d.data() as Conversation),
      ];

      const have = new Set(all.map((c) => c.id));
      const tenancies = [
        ...tenanciesAsOwner.docs.map((d) => d.data() as Tenant),
        ...tenanciesAsTenant.docs.map((d) => d.data() as Tenant),
      ];
      // Most recent tenancy first so a pair with several units gets its
      // thread stamped with the latest tenancyId/propertyId.
      tenancies.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const now = new Date().toISOString();
      const toCreate = new Map<string, Conversation>();
      for (const t of tenancies) {
        // No User yet (invite not accepted) or owner renting to themselves —
        // neither makes a chattable counterpart.
        if (!t.userId || t.userId === t.ownerId) continue;
        // A malformed legacy row missing these would put `undefined` into
        // the new doc, which the SDK rejects — skip it rather than letting
        // one bad tenancy poison the batch.
        if (!t.id || !t.propertyId) continue;
        const convId = conversationDocId(t.ownerId, t.userId);
        if (have.has(convId) || toCreate.has(convId)) continue;
        toCreate.set(convId, {
          id: convId,
          ownerId: t.ownerId,
          tenantUserId: t.userId,
          tenancyId: t.id,
          propertyId: t.propertyId,
          lastMessageText: "",
          lastMessageAt: now,
          lastMessageSenderId: "",
          unreadByOwner: 0,
          unreadByTenant: 0,
          createdAt: now,
        });
      }
      if (toCreate.size > 0) {
        // create() (not set) per doc: an existing thread can never be
        // clobbered back to empty. The async wrapper matters — the SDK
        // validates document data synchronously, and a bare sync throw
        // would escape allSettled and fail the whole list.
        const created = Array.from(toCreate.values());
        const settled = await Promise.allSettled(
          created.map(async (conv) => db().collection(COL.conversations).doc(conv.id).create(conv)),
        );
        settled.forEach((result, i) => {
          if (result.status === "fulfilled") {
            all.push(created[i]);
            return;
          }
          const reason = result.reason as { code?: number; message?: string } | undefined;
          // ALREADY_EXISTS (gRPC code 6): the counterpart's poll or a manual
          // /start raced us and won — the thread is there, so keep the row;
          // the next fetch's conversation query returns the real doc.
          if (reason?.code === 6 || /already.exists/i.test(reason?.message ?? "")) {
            all.push(created[i]);
            return;
          }
          // Anything else (UNAVAILABLE, quota, …) means the doc was NOT
          // written — serving the row anyway would 404 on open/send. Drop
          // it; the next poll retries the create.
          console.error(`Failed to materialize conversation ${created[i].id}:`, result.reason);
        });
      }

      if (all.length === 0) return res.json([]);

      // Hydrate counterpart names in ONE Firestore RPC. The previous
      // Promise.all(map(doc(id).get())) fan-out was N round-trips for a
      // user with N conversations; getAll(...refs) does the same work in
      // a single batched call.
      const counterpartIds = Array.from(
        new Set(all.map((c) => (c.ownerId === uid ? c.tenantUserId : c.ownerId))),
      );
      const counterpartRefs = counterpartIds.map((id) => db().collection(COL.users).doc(id));
      const counterpartDocs = counterpartRefs.length ? await db().getAll(...counterpartRefs) : [];
      const nameByUid = new Map<string, string>();
      counterpartDocs.forEach((s) => {
        if (!s.exists) return;
        const u = s.data() as User;
        const full = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
        nameByUid.set(s.id, full || u.email || "Unknown");
      });

      const payload = all
        .map((c) => {
          const counterpartId = c.ownerId === uid ? c.tenantUserId : c.ownerId;
          return {
            ...c,
            counterpartUserId: counterpartId,
            counterpartName: nameByUid.get(counterpartId) ?? "Unknown",
            unread: c.ownerId === uid ? c.unreadByOwner : c.unreadByTenant,
          };
        })
        .sort((a, b) => {
          // Threads with messages first (newest activity on top); the
          // never-used threads materialized above trail behind, A→Z, so a
          // freshly-created empty chat can't shove a live one off the top.
          const aEmpty = !a.lastMessageSenderId;
          const bEmpty = !b.lastMessageSenderId;
          if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
          if (aEmpty) return a.counterpartName.localeCompare(b.counterpartName);
          return a.lastMessageAt < b.lastMessageAt ? 1 : -1;
        });

      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ error: errMsg(err, "Failed to load conversations") });
    }
  });

  // ── Tenant-initiated: start a conversation with their landlord ────────────
  // Auto-resolves the caller's most recent active tenancy and reuses the
  // owner-side conversation doc so we never end up with parallel threads
  // between the same two people. Used by the empty-state CTA on
  // /tenant/messages.
  app.post("/api/messages/start-with-landlord", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    try {
      const snap = await db()
        .collection(COL.tenants)
        .where("userId", "==", uid)
        .where("status", "==", "active")
        .get();
      if (snap.empty) {
        return res.status(400).json({
          error:
            "You don't have an active tenancy yet. Once your landlord adds you, you'll be able to chat here.",
        });
      }
      // Multiple active tenancies → pick the most recent. Edge case for now;
      // future: let the tenant pick which landlord to message.
      const tenancies = snap.docs
        .map((d) => d.data() as Tenant)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const tenancy = tenancies[0];

      // Legacy/drifted tenancy missing propertyId would write `undefined`,
      // which the Admin SDK rejects → opaque 500. The list materializer skips
      // such rows; mirror that here with a clean 400 instead.
      if (!tenancy.id || !tenancy.propertyId) {
        return res.status(400).json({
          error: "This tenancy is missing details needed to start a chat. Contact support.",
        });
      }

      const convId = conversationDocId(tenancy.ownerId, uid);
      const ref = db().collection(COL.conversations).doc(convId);
      const existing = await ref.get();
      if (existing.exists) {
        return res.json(existing.data());
      }

      const now = new Date().toISOString();
      const conversation: Conversation = {
        id: convId,
        ownerId: tenancy.ownerId,
        tenantUserId: uid,
        tenancyId: tenancy.id,
        propertyId: tenancy.propertyId,
        lastMessageText: "",
        lastMessageAt: now,
        lastMessageSenderId: "",
        unreadByOwner: 0,
        unreadByTenant: 0,
        createdAt: now,
      };
      // create() (not set()): if the owner's poll/materializer or a send raced
      // us and already populated this thread in the get→write gap, a bare set()
      // would clobber it back to empty (wiping the preview + a just-incremented
      // unread). ALREADY_EXISTS means the thread is there — return it untouched.
      try {
        await ref.create(conversation);
        return res.status(201).json(conversation);
      } catch (err: any) {
        if (err?.code === 6 || /already.exists/i.test(err?.message ?? "")) {
          const now2 = await ref.get();
          return res.json(now2.data());
        }
        throw err;
      }
    } catch (err: any) {
      res.status(500).json({ error: errMsg(err, "Failed to start conversation") });
    }
  });

  // ── Start (or fetch) a conversation. Owner-only. ──────────────────────────
  app.post("/api/messages/start", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const tenancyId = typeof body.tenancyId === "string" ? body.tenancyId : "";
    if (!tenancyId) return res.status(400).json({ error: "tenancyId is required" });

    try {
      const tenancySnap = await db().collection(COL.tenants).doc(tenancyId).get();
      if (!tenancySnap.exists) {
        return res.status(404).json({ error: "Tenancy not found" });
      }
      const tenancy = tenancySnap.data() as Tenant;
      if (tenancy.ownerId !== uid) {
        return res.status(403).json({ error: "Not your tenancy" });
      }
      if (!tenancy.userId) {
        return res.status(400).json({
          error:
            "Tenant hasn't signed up yet — can't start a conversation until they accept their invite.",
        });
      }
      // Legacy/drifted tenancy missing propertyId would write `undefined`,
      // which the Admin SDK rejects → opaque 500. The list materializer skips
      // such rows; mirror that here with a clean 400 instead.
      if (!tenancy.propertyId) {
        return res.status(400).json({
          error: "This tenancy is missing details needed to start a chat. Contact support.",
        });
      }

      const convId = conversationDocId(uid, tenancy.userId);
      const ref = db().collection(COL.conversations).doc(convId);
      const existing = await ref.get();
      if (existing.exists) {
        return res.json(existing.data());
      }

      const now = new Date().toISOString();
      const conversation: Conversation = {
        id: convId,
        ownerId: uid,
        tenantUserId: tenancy.userId,
        tenancyId,
        propertyId: tenancy.propertyId,
        lastMessageText: "",
        lastMessageAt: now,
        lastMessageSenderId: "",
        unreadByOwner: 0,
        unreadByTenant: 0,
        createdAt: now,
      };
      // create() (not set()): if the tenant's poll/materializer or a send raced
      // us and already populated this thread in the get→write gap, a bare set()
      // would clobber it back to empty. ALREADY_EXISTS → return the live doc.
      try {
        await ref.create(conversation);
        return res.status(201).json(conversation);
      } catch (err: any) {
        if (err?.code === 6 || /already.exists/i.test(err?.message ?? "")) {
          const live = await ref.get();
          return res.json(live.data());
        }
        throw err;
      }
    } catch (err: any) {
      res.status(500).json({ error: errMsg(err, "Failed to start conversation") });
    }
  });

  // ── List messages in a conversation ───────────────────────────────────────
  app.get("/api/messages/conversations/:id/messages", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const access = await loadConversationForCaller(reqStr(req.params.id), uid);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    // Bound the result set — a pair that exchanged thousands of
    // messages would otherwise dump them all on every page-load.
    // 500 covers the realistic "back-scroll a long history" case;
    // older messages can be fetched via the `?before=` cursor.
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    const before = typeof req.query.before === "string" ? req.query.before : null;
    try {
      // Order by createdAt with the document id as a stable tiebreaker, so two
      // messages stamped in the same millisecond can never be skipped or
      // duplicated across a page boundary. `__name__` is always available as a
      // final orderBy without a composite index. The `?before=` cursor accepts
      // either a bare `createdAt` (back-compat) or `createdAt|docId` for an
      // exact, collision-proof position.
      let q = db()
        .collection(COL.conversations)
        .doc(reqStr(req.params.id))
        .collection("messages")
        .orderBy("createdAt", "desc")
        .orderBy(FieldPath.documentId(), "desc")
        .limit(limit) as FirebaseFirestore.Query;
      if (before) {
        const [beforeAt, beforeId] = before.split("|");
        q = beforeId ? q.startAfter(beforeAt, beforeId) : q.startAfter(beforeAt);
      }
      const snap = await q.get();
      // Reverse so the response is ascending chronologically (matches
      // the historical shape the client expects to render).
      const messages = snap.docs.map((d) => d.data() as ConversationMessage).reverse();
      res.json(messages);
    } catch (err: any) {
      res.status(500).json({ error: errMsg(err, "Failed to load messages") });
    }
  });

  // ── Send a message ────────────────────────────────────────────────────────
  // Writes the message, bumps lastMessage* on the conversation, increments
  // the counterpart's unread counter, and pushes them under the `messages`
  // notification category.
  app.post("/api/messages/conversations/:id/messages", requireAuth, async (req, res) => {
    const { uid, profile } = req.user!;
    // Validate the payload and the caller's access BEFORE spending rate-limit
    // quota: an empty/oversized body or a non-participant must not burn the
    // hourly budget (otherwise a buggy client or a probe could lock a
    // legitimate user out of their own chat).
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "text is required" });
    if (text.length > MAX_MESSAGE_LEN) {
      return res.status(400).json({ error: `text exceeds ${MAX_MESSAGE_LEN} chars` });
    }

    const access = await loadConversationForCaller(reqStr(req.params.id), uid);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const conversation = access.conversation;

    // Per-user hourly cap, metered only once we know this is a valid send from
    // a real participant. Each message creates a Firestore write, bumps the
    // counterpart's unread counter, AND fires a push via OneSignal. 200/hour is
    // generous for normal chat (≈3/min sustained) but stops a spam loop from
    // burning push credits and overflowing the recipient's notification tray.
    const limit = await rateLimit(`msg-send:${uid}`, 200, 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Slow down — you're sending messages too quickly.",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    try {
      const now = new Date().toISOString();
      const convRef = db().collection(COL.conversations).doc(reqStr(req.params.id));
      const msgRef = convRef.collection("messages").doc();
      const message: ConversationMessage = {
        id: msgRef.id,
        conversationId: reqStr(req.params.id),
        senderId: uid,
        text,
        createdAt: now,
      };

      const isOwnerSender = conversation.ownerId === uid;
      const counterpartUid = isOwnerSender ? conversation.tenantUserId : conversation.ownerId;

      // Transaction (not a plain batch) so the lastMessage* preview is advanced
      // only when THIS message is actually the newest. Two near-simultaneous
      // sends can commit in either order; without the guard the later-committing
      // write — which may carry the chronologically EARLIER message — would
      // leave a stale message as the list preview / recency-sort key. We read
      // the current lastMessageAt and only overwrite when `now` is >= it. The
      // unread counter always increments (the message is unread regardless of
      // ordering); FieldValue.increment keeps concurrent bumps from colliding.
      await db().runTransaction(async (t) => {
        const convSnap = await t.get(convRef);
        const current = convSnap.exists ? (convSnap.data() as Conversation) : null;
        const advance = !current?.lastMessageAt || now >= current.lastMessageAt;
        t.set(msgRef, message);
        t.set(
          convRef,
          {
            ...(advance
              ? { lastMessageText: text, lastMessageAt: now, lastMessageSenderId: uid }
              : {}),
            ...(isOwnerSender
              ? { unreadByTenant: FieldValue.increment(1) }
              : { unreadByOwner: FieldValue.increment(1) }),
          },
          { merge: true },
        );
      });

      // Push the recipient. Trim to a one-line preview so a long message
      // doesn't blow past the OneSignal display limit. Title falls back
      // name → email → "New message" (mirrors the list's name→email→Unknown
      // chain) so a sender who hasn't set a name still shows as themselves.
      const senderName = profile
        ? `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim()
        : "";
      const title = senderName || profile?.email || "New message";
      const preview = text.length > 120 ? `${text.slice(0, 117)}…` : text;
      const appBase =
        process.env.PUBLIC_APP_URL?.replace(/\/$/, "") ?? "https://app.oliowallet.com";
      // Deep-link straight to THIS thread (?c=<id>) — same as the in-app Chat
      // buttons — so a recipient with several conversations lands on the right
      // one instead of whatever sits at the top of their inbox.
      const base = isOwnerSender ? `${appBase}/tenant/messages` : `${appBase}/owner/messages`;
      const url = `${base}?c=${encodeURIComponent(reqStr(req.params.id))}`;
      await notifyUser({
        externalUserId: counterpartUid,
        category: "messages",
        title,
        message: preview,
        url,
      });

      res.status(201).json(message);
    } catch (err: any) {
      res.status(500).json({ error: errMsg(err, "Failed to send message") });
    }
  });

  // ── Mark conversation read ────────────────────────────────────────────────
  // Zeros out the caller's unread counter. Idempotent.
  //
  // The client passes `lastSeenAt` = the createdAt of the newest message it has
  // actually rendered. We zero the counter inside a transaction, but ONLY when
  // no newer message has landed than what the caller has seen (the stored
  // lastMessageAt is <= lastSeenAt). This NARROWS the lost-update race where a
  // message arriving between the client's read and this POST would otherwise be
  // silently marked read (its unread increment clobbered by an unconditional
  // `set(0)`). It is a millisecond-granularity, value-based watermark, so a
  // residual remains: an unrendered message stamped in the EXACT same
  // millisecond as the watermark still clears (the strict `>` below treats
  // equal as seen). Closing that fully would need the message id in the
  // watermark (the compound key L-1 already uses); not worth it for a
  // self-healing badge. When something newer exists we leave the counter so the next
  // open — once the client renders that message and re-POSTs with a fresher
  // watermark — clears it correctly. Omitting lastSeenAt keeps the old
  // unconditional behavior (back-compat for any caller that doesn't send it).
  app.post("/api/messages/conversations/:id/read", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const access = await loadConversationForCaller(reqStr(req.params.id), uid);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const lastSeenAt = typeof body.lastSeenAt === "string" ? body.lastSeenAt : null;
    const isOwner = access.conversation.ownerId === uid;
    try {
      const ref = db().collection(COL.conversations).doc(reqStr(req.params.id));
      const cleared = await db().runTransaction(async (t) => {
        const snap = await t.get(ref);
        const current = snap.exists ? (snap.data() as Conversation) : null;
        // A newer message than the caller has seen exists → don't mark it read.
        if (lastSeenAt && current?.lastMessageAt && current.lastMessageAt > lastSeenAt) {
          return false;
        }
        t.set(ref, isOwner ? { unreadByOwner: 0 } : { unreadByTenant: 0 }, { merge: true });
        return true;
      });
      res.json({ ok: true, cleared });
    } catch (err: any) {
      res.status(500).json({ error: errMsg(err, "Failed to mark read") });
    }
  });
}
