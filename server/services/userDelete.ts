import { db, bucket } from "../firebase";
import {
  COL,
  type Agreement,
  type DeletedUserTombstone,
  type DocumentRecord,
  type Property,
} from "../../shared/firestore-schema";
import { logWarn } from "./log";

export type HardDeleteBlocker =
  "properties" | "subscription" | "owner_agreement" | "tenant_agreement";

// Checked in a defined order so the route can surface the most-relevant message
// when multiple blockers apply (properties first — the user has to deal with
// those before agreements can be wound down anyway).
const BLOCKER_ORDER: HardDeleteBlocker[] = [
  "properties",
  "subscription",
  "owner_agreement",
  "tenant_agreement",
];

export async function findHardDeleteBlockers(userId: string): Promise<HardDeleteBlocker[]> {
  const [propSnap, ownerAgreementSnap, tenantTenancySnap, subSnap] = await Promise.all([
    db().collection(COL.properties).where("ownerId", "==", userId).limit(1).get(),
    // Owner side: a live lease blocks deletion. Include pending_tenant — an
    // in-flight lease the tenant may still accept must not be silently
    // orphaned (active-only let a pending lease slip through).
    db()
      .collection(COL.agreements)
      .where("ownerId", "==", userId)
      .where("status", "in", ["active", "pending_tenant"])
      .limit(1)
      .get(),
    // Tenant side: query the TENANCY by userId, NOT agreements by tenantId.
    // Agreement.tenantId is the tenancy DOC id, never the user's uid, so the
    // old agreements-where-tenantId==userId query never matched and the
    // tenant-side block was dead in production. A live tenancy (active or
    // pending) is the real signal.
    db()
      .collection(COL.tenants)
      .where("userId", "==", userId)
      .where("status", "in", ["active", "pending"])
      .limit(1)
      .get(),
    // Active/not-yet-expired Stripe subscription (the firestore-stripe-payments
    // extension mirror at customers/{uid}/subscriptions). Cancelling a sub
    // sets cancel_at_period_end but its status stays "active" until the paid
    // period ends — so this blocks deletion only while the subscription is
    // still live, and account deletion becomes available once it has expired.
    db()
      .collection("customers")
      .doc(userId)
      .collection("subscriptions")
      .where("status", "in", ["active", "trialing"])
      .limit(1)
      .get(),
  ]);

  const blockers = new Set<HardDeleteBlocker>();
  if (!propSnap.empty) blockers.add("properties");
  if (!subSnap.empty) blockers.add("subscription");
  if (!ownerAgreementSnap.empty) blockers.add("owner_agreement");
  if (!tenantTenancySnap.empty) blockers.add("tenant_agreement");

  return BLOCKER_ORDER.filter((b) => blockers.has(b));
}

export function hardDeleteBlockerMessage(blocker: HardDeleteBlocker): string {
  switch (blocker) {
    case "properties":
      return "User still has properties. Reassign or remove them before deleting.";
    case "subscription":
      return "User has an active subscription. Cancel it and wait until the current billing period expires, then the account can be deleted.";
    case "owner_agreement":
    case "tenant_agreement":
      return "User has a live agreement (active or pending) as owner or tenant. End it before deleting.";
  }
}

export interface UserCascadeResult {
  tenants: number;
  expiredAgreements: number;
  documents: number;
  paymentMethods: number;
  portfolios: number;
  portfolioAccessContacts: number;
  expertApplications: number;
  suggestionRequests: number;
  marketplaceLeads: number;
  tickets: number;
  complimentaryPlans: number;
  conversations: number;
  emailRecipients: number;
  storageObjects: number;
  // Objects under the deletee's prefixes that were SKIPPED because a doc
  // owned by someone else still references them (post-transfer survivors).
  storageObjectsSkipped: number;
}

// Storage objects live under uid-keyed prefixes (documents/{uid}/…,
// properties/{uid}/{propertyId}/…) and the prefix never changes when a
// property/portfolio is transferred to a new owner — only the Firestore docs'
// ownerId moves. So after a transfer, blanket prefix deletion on the OLD
// owner's account would destroy lease PDFs and photos the NEW owner's live
// docs still reference. Collect what must survive:
//   • documents/{uid}/… paths referenced by a DocumentRecord that outlives
//     this cascade (ownerId !== deletee, and not tenant-linked to them);
//   • documents/{uid}/… paths referenced by a surviving agreement's
//     signedLeaseDocument (nested fields have Firestore single-field indexes,
//     so the range query needs no composite index);
//   • property photo folders properties/{uid}/{propertyId}/ where the
//     property doc still exists and belongs to someone else (checked lazily
//     per file via the returned isProtectedPropertyFile, since the propertyId
//     is parsed from each object's path).
async function collectStorageSurvivors(userId: string): Promise<{
  protectedPaths: Set<string>;
  isProtectedPropertyFile: (objectName: string) => Promise<boolean>;
}> {
  const dbi = db();
  const docPrefix = `documents/${userId}/`;
  const rangeEnd = `${docPrefix}\uf8ff`;

  const protectedPaths = new Set<string>();
  try {
    const [docsSnap, agSnap] = await Promise.all([
      dbi
        .collection(COL.documents)
        .where("storagePath", ">=", docPrefix)
        .where("storagePath", "<", rangeEnd)
        .get(),
      dbi
        .collection(COL.agreements)
        .where("signedLeaseDocument.storagePath", ">=", docPrefix)
        .where("signedLeaseDocument.storagePath", "<", rangeEnd)
        .get(),
    ]);
    docsSnap.docs.forEach((d) => {
      const rec = d.data() as DocumentRecord;
      // Docs owned by (or tenant-linked to) the deletee are deleted by this
      // cascade, so their files are NOT survivors.
      if (rec.ownerId !== userId && rec.tenantId !== userId && rec.storagePath) {
        protectedPaths.add(rec.storagePath);
      }
    });
    agSnap.docs.forEach((d) => {
      const a = d.data() as Agreement;
      const p = a.signedLeaseDocument?.storagePath;
      if (p && a.ownerId !== userId) protectedPaths.add(p);
    });
  } catch (err) {
    logWarn("user_delete.survivor-scan-failed", {
      uid: userId,
      err: String(err).slice(0, 200),
    });
  }

  // Lazy per-property survivor check, memoized — property photo paths are
  // properties/{uid}/{propertyId}/{file}; a file survives iff its property
  // doc still exists under a DIFFERENT owner.
  const propertyVerdicts = new Map<string, boolean>();
  async function isProtectedPropertyFile(objectName: string): Promise<boolean> {
    const parts = objectName.split("/");
    // [0]="properties" [1]=uid [2]=propertyId
    const propertyId = parts.length >= 4 ? parts[2] : null;
    if (!propertyId) return false;
    const cached = propertyVerdicts.get(propertyId);
    if (cached !== undefined) return cached;
    let surviving = false;
    try {
      const snap = await dbi.collection(COL.properties).doc(propertyId).get();
      surviving = snap.exists && (snap.data() as Property).ownerId !== userId;
    } catch {
      // On a failed read, err on the side of NOT deleting (worst case is an
      // orphaned byte, not a destroyed live document).
      surviving = true;
    }
    propertyVerdicts.set(propertyId, surviving);
    return surviving;
  }

  return { protectedPaths, isProtectedPropertyFile };
}

// Removes every doc + storage object that's keyed off this userId, so a
// GDPR right-to-erasure (Art. 17) request can be honored properly.
// Called from the hard-delete admin endpoint AFTER `findHardDeleteBlockers`
// already confirmed the user owns no live properties / active agreements.
//
// Intentionally LEFT BEHIND:
//   - `transactions` rows where ownerId/tenantId == this user. Financial
//     history continuity (mirrors property-transfer + property-delete
//     policy). The other-side counterparty still has these as their own
//     legitimate records.
//   - `userAudit` + `impersonations`. Audit logs — required for
//     accountability of admin actions.
//
// Best-effort on storage: failures don't abort the cascade. Orphaned
// bytes are cheap; leaving signed-URL-readable PII in the bucket is the
// worse failure mode, so we try to delete and log on failure.
export async function deleteUserCascade(userId: string): Promise<UserCascadeResult> {
  const dbi = db();
  const b = bucket();

  // Resurrection guard — write FIRST, before any teardown. A hard-deleted user
  // keeps a valid Firebase ID token for up to ~1h after deletion. With no
  // backing user doc, that token would otherwise let GET /api/me re-provision a
  // fresh active profile + portfolio and re-link tenancies, silently undoing the
  // erasure (and re-notifying staff of a "new signup"). requireAuth rejects any
  // token whose uid is tombstoned here. Written first so the block holds even if
  // a later step in this cascade fails and the erasure is retried. Holds NO
  // personal data — just the uid (doc id) + timestamp.
  const tombstone: DeletedUserTombstone = { deletedAt: new Date().toISOString() };
  await dbi.collection(COL.deletedUsers).doc(userId).set(tombstone);

  // Concurrent reads to enumerate every doc keyed on this user. Each
  // query is bounded by data the user actually owns; we don't scan the
  // whole collection. Reads first so we can do all writes in batched
  // Firestore commits (500/batch limit).
  const [
    ownedTenants,
    rentedTenancies,
    ownerExpiredAgreements,
    tenantExpiredAgreements,
    ownerDocuments,
    tenantDocuments,
    paymentMethods,
    ownedPortfolios,
    portfolioAccessOwner,
    portfolioAccessContact,
    expertApplications,
    suggestionRequests,
    marketplaceLeads,
    tickets,
    complimentaryPlans,
    conversationsAsOwner,
    conversationsAsTenant,
  ] = await Promise.all([
    dbi.collection(COL.tenants).where("ownerId", "==", userId).get(),
    dbi.collection(COL.tenants).where("userId", "==", userId).get(),
    dbi.collection(COL.agreements).where("ownerId", "==", userId).get(),
    dbi.collection(COL.agreements).where("tenantId", "==", userId).get(),
    dbi.collection(COL.documents).where("ownerId", "==", userId).get(),
    dbi.collection(COL.documents).where("tenantId", "==", userId).get(),
    dbi.collection(COL.paymentMethods).where("userId", "==", userId).get(),
    // Only a portfolio whose ownerId===userId is deleted (the query guarantees
    // it), so a future ownership transfer won't wipe a portfolio when its OLD
    // owner is deleted.
    dbi.collection(COL.portfolios).where("ownerId", "==", userId).get(),
    dbi.collection(COL.portfolioAccessContacts).where("ownerId", "==", userId).get(),
    dbi.collection(COL.portfolioAccessContacts).where("contactUserId", "==", userId).get(),
    dbi.collection(COL.expertApplications).where("userId", "==", userId).get(),
    dbi.collection(COL.suggestionRequests).where("userId", "==", userId).get(),
    dbi.collection(COL.marketplaceLeads).where("userId", "==", userId).get(),
    dbi.collection(COL.tickets).where("userId", "==", userId).get(),
    dbi.collection(COL.complimentaryPlans).where("userId", "==", userId).get(),
    dbi.collection(COL.conversations).where("ownerId", "==", userId).get(),
    dbi.collection(COL.conversations).where("tenantUserId", "==", userId).get(),
  ]);

  // Storage cleanup: avatars under avatars/{uid}/ + property photos
  // under properties/{uid}/ + documents under documents/{uid}/.
  // Listing photos (listings/{uid}/) too if the user authored any.
  //
  // GUARDED: object paths are uid-keyed but ownership can move (property/
  // portfolio transfer) without relocating the objects. Files still referenced
  // by docs that survive this cascade (owned by someone else) are SKIPPED —
  // deleting them would destroy the new owner's lease PDFs / photos. Avatars
  // and listing photos are personal and never transfer.
  const { protectedPaths, isProtectedPropertyFile } = await collectStorageSurvivors(userId);
  const STORAGE_PREFIXES = [
    `avatars/${userId}/`,
    `properties/${userId}/`,
    `documents/${userId}/`,
    `listings/${userId}/`,
  ];
  let storageObjectsDeleted = 0;
  let storageObjectsSkipped = 0;
  for (const prefix of STORAGE_PREFIXES) {
    try {
      const [files] = await b.getFiles({ prefix });
      await Promise.all(
        files.map(async (f) => {
          const isDocSurvivor = protectedPaths.has(f.name);
          const isPropSurvivor =
            prefix === `properties/${userId}/` && (await isProtectedPropertyFile(f.name));
          if (isDocSurvivor || isPropSurvivor) {
            storageObjectsSkipped += 1;
            logWarn("user_delete.storage-skipped-survivor", { file: f.name });
            return;
          }
          await f
            .delete()
            .then(() => {
              storageObjectsDeleted += 1;
            })
            .catch((err) => {
              logWarn("user_delete.storage-failed", {
                file: f.name,
                err: String(err).slice(0, 200),
              });
            });
        }),
      );
    } catch (err) {
      logWarn("user_delete.getfiles-failed", {
        prefix,
        err: String(err).slice(0, 200),
      });
    }
  }

  // Cross-collection cleanup: per-recipient delivery rows under
  // emailCampaigns/{cid}/recipients/{uid}. Without this, a
  // collectionGroup("recipients").where("userId","==",deletedUid)
  // (used by the Resend webhook handler) can still return the deleted
  // user's `email` + `userId` long after the parent cascade ran.
  // collectionGroup walks every campaign's recipients subcollection in
  // a single query.
  let emailRecipientsDeleted = 0;
  try {
    const recipientsSnap = await dbi
      .collectionGroup("recipients")
      .where("userId", "==", userId)
      .get();
    for (let i = 0; i < recipientsSnap.docs.length; i += 500) {
      const slice = recipientsSnap.docs.slice(i, i + 500);
      const batch = dbi.batch();
      slice.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      emailRecipientsDeleted += slice.length;
    }
  } catch (err) {
    logWarn("user_delete.email-recipients-failed", {
      uid: userId,
      err: String(err).slice(0, 200),
    });
  }

  // Delete conversation message subcollections before deleting the parent
  // conversation docs. Without this, messages become orphaned and can be
  // enumerated via a known conversation id. CRITICAL: a parent is deleted ONLY
  // after its drain is confirmed — a conversation whose drain throws is left
  // fully intact (parent + messages), so a re-run can retry it, rather than
  // deleting the parent and stranding the subcollection (it was a non-atomic
  // two-step before, which orphaned messages on a transient drain failure).
  const allConversations = [...conversationsAsOwner.docs, ...conversationsAsTenant.docs];
  const drainedConversationRefs: FirebaseFirestore.DocumentReference[] = [];
  for (const convo of allConversations) {
    try {
      const msgsSnap = await convo.ref.collection("messages").get();
      // Batch in chunks of 500 (Firestore limit).
      for (let i = 0; i < msgsSnap.docs.length; i += 500) {
        const slice = msgsSnap.docs.slice(i, i + 500);
        const batch = dbi.batch();
        slice.forEach((m) => batch.delete(m.ref));
        await batch.commit();
      }
      drainedConversationRefs.push(convo.ref);
    } catch (err) {
      logWarn("user_delete.messages-drain-failed", {
        conversationId: convo.id,
        err: String(err).slice(0, 200),
      });
    }
  }

  // Doc deletes — chunked into batches of 500 (Firestore commit limit).
  // Conversations are handled separately (above + below) so a parent is never
  // deleted ahead of its messages.
  const allDocsToDelete = [
    ...ownedTenants.docs,
    ...rentedTenancies.docs,
    ...ownerExpiredAgreements.docs,
    ...tenantExpiredAgreements.docs,
    ...ownerDocuments.docs,
    ...tenantDocuments.docs,
    ...paymentMethods.docs,
    ...ownedPortfolios.docs,
    ...portfolioAccessOwner.docs,
    ...portfolioAccessContact.docs,
    ...expertApplications.docs,
    ...suggestionRequests.docs,
    ...marketplaceLeads.docs,
    ...tickets.docs,
    ...complimentaryPlans.docs,
  ];
  for (let i = 0; i < allDocsToDelete.length; i += 500) {
    const slice = allDocsToDelete.slice(i, i + 500);
    const batch = dbi.batch();
    slice.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  // Now the conversation parents whose messages we confirmed drained.
  for (let i = 0; i < drainedConversationRefs.length; i += 500) {
    const slice = drainedConversationRefs.slice(i, i + 500);
    const batch = dbi.batch();
    slice.forEach((ref) => batch.delete(ref));
    await batch.commit();
  }

  return {
    tenants: ownedTenants.size + rentedTenancies.size,
    expiredAgreements: ownerExpiredAgreements.size + tenantExpiredAgreements.size,
    documents: ownerDocuments.size + tenantDocuments.size,
    paymentMethods: paymentMethods.size,
    portfolios: ownedPortfolios.size,
    portfolioAccessContacts: portfolioAccessOwner.size + portfolioAccessContact.size,
    expertApplications: expertApplications.size,
    suggestionRequests: suggestionRequests.size,
    marketplaceLeads: marketplaceLeads.size,
    tickets: tickets.size,
    complimentaryPlans: complimentaryPlans.size,
    conversations: drainedConversationRefs.length,
    emailRecipients: emailRecipientsDeleted,
    storageObjects: storageObjectsDeleted,
    storageObjectsSkipped,
  };
}
