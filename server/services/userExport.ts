import { db } from "../firebase";
import { COL, SUBCOL_EMAIL_RECIPIENTS } from "../../shared/firestore-schema";

// Builds a machine-readable export of everything Olio holds about one user —
// GDPR right of access (Art. 15) + portability (Art. 20). READ-ONLY.
//
// The query set mirrors deleteUserCascade (server/services/userDelete.ts) so
// "what we can export" stays in parity with "what we delete" — including saved
// payment methods, owner properties, and the per-campaign email-recipient rows
// the cascade also erases — plus the user's transactions (financial records we
// retain past erasure) and their chat messages. Every query is scoped to the
// caller — by uid, or (for tenant-side leases/transactions) by the caller's OWN
// tenancy doc ids — so it can only ever return the requesting user's own data,
// never another user's.
export interface UserDataExport {
  exportedAt: string;
  userId: string;
  profile: Record<string, unknown> | null;
  tenanciesAsTenant: unknown[];
  tenanciesAsOwner: unknown[];
  agreementsAsOwner: unknown[];
  agreementsAsTenant: unknown[];
  transactions: unknown[];
  paymentMethods: unknown[];
  properties: unknown[];
  portfolios: unknown[];
  portfolioAccessContacts: unknown[];
  documents: unknown[];
  emailRecipients: unknown[];
  conversations: unknown[];
  tickets: unknown[];
  expertApplications: unknown[];
  suggestionRequests: unknown[];
  marketplaceLeads: unknown[];
  complimentaryPlans: unknown[];
}

function rows(snap: FirebaseFirestore.QuerySnapshot): unknown[] {
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as object) }));
}

export async function exportUserData(userId: string): Promise<UserDataExport> {
  const dbi = db();

  // Tenant-side agreements + transactions key on the TENANCY doc id
  // (Agreement.tenantId === Transaction.tenantId === Tenant.id — see
  // rentCycle.ts), NOT the user uid, so they must be looked up via the user's
  // own tenancy docs. (documents.tenantId IS the uid, so that stays uid-keyed.)
  // `in` caps at 30, so chunk.
  const byTenancyIds = async (col: string, tenancyIds: string[]): Promise<unknown[]> => {
    const out: unknown[] = [];
    for (let i = 0; i < tenancyIds.length; i += 30) {
      const chunk = tenancyIds.slice(i, i + 30);
      if (chunk.length === 0) continue;
      const snap = await dbi.collection(col).where("tenantId", "in", chunk).get();
      out.push(...rows(snap));
    }
    return out;
  };

  const [
    profileSnap,
    rentedTenancies,
    ownedTenants,
    ownerAgreements,
    ownerTransactions,
    paymentMethodsSnap,
    ownedProperties,
    ownedPortfolios,
    paccOwner,
    paccContact,
    ownerDocuments,
    tenantDocuments,
    emailRecipientsSnap,
    convosOwner,
    convosTenant,
    tickets,
    expertApplications,
    suggestionRequests,
    marketplaceLeads,
    complimentaryPlans,
  ] = await Promise.all([
    dbi.collection(COL.users).doc(userId).get(),
    dbi.collection(COL.tenants).where("userId", "==", userId).get(),
    dbi.collection(COL.tenants).where("ownerId", "==", userId).get(),
    dbi.collection(COL.agreements).where("ownerId", "==", userId).get(),
    dbi.collection(COL.transactions).where("ownerId", "==", userId).get(),
    dbi.collection(COL.paymentMethods).where("userId", "==", userId).get(),
    dbi.collection(COL.properties).where("ownerId", "==", userId).get(),
    dbi.collection(COL.portfolios).where("ownerId", "==", userId).get(),
    dbi.collection(COL.portfolioAccessContacts).where("ownerId", "==", userId).get(),
    dbi.collection(COL.portfolioAccessContacts).where("contactUserId", "==", userId).get(),
    dbi.collection(COL.documents).where("ownerId", "==", userId).get(),
    dbi.collection(COL.documents).where("tenantId", "==", userId).get(),
    // Per-campaign delivery/engagement rows the user appears in (the same
    // collectionGroup the deletion cascade erases). Backed by the
    // recipients.userId COLLECTION_GROUP index.
    dbi.collectionGroup(SUBCOL_EMAIL_RECIPIENTS).where("userId", "==", userId).get(),
    dbi.collection(COL.conversations).where("ownerId", "==", userId).get(),
    dbi.collection(COL.conversations).where("tenantUserId", "==", userId).get(),
    dbi.collection(COL.tickets).where("userId", "==", userId).get(),
    dbi.collection(COL.expertApplications).where("userId", "==", userId).get(),
    dbi.collection(COL.suggestionRequests).where("userId", "==", userId).get(),
    dbi.collection(COL.marketplaceLeads).where("userId", "==", userId).get(),
    dbi.collection(COL.complimentaryPlans).where("userId", "==", userId).get(),
  ]);

  // Saved cards: include the user's own card metadata (brand/last4/expiry) but
  // strip the internal Stripe payment-method token from their copy.
  const paymentMethods = paymentMethodsSnap.docs.map((d) => {
    const data: Record<string, unknown> = { id: d.id, ...(d.data() as object) };
    delete data.stripePaymentMethodId;
    return data;
  });

  // The user's own tenancies (as tenant) → their doc ids → the leases + rent
  // transactions keyed on them. Without this, a tenant's lease + rent history
  // would be silently omitted from the export.
  const myTenancyIds = rentedTenancies.docs.map((d) => d.id);
  const [agreementsAsTenant, tenantTransactions] = await Promise.all([
    byTenancyIds(COL.agreements, myTenancyIds),
    byTenancyIds(COL.transactions, myTenancyIds),
  ]);

  // Chat history: drain the messages subcollection of each conversation the
  // user is a party to. Conversations outlive tenancies, so this is their full
  // thread history with each counterpart.
  const convoDocs = [...convosOwner.docs, ...convosTenant.docs];
  const conversations = await Promise.all(
    convoDocs.map(async (c) => {
      const msgs = await c.ref.collection("messages").get();
      return { id: c.id, ...(c.data() as object), messages: rows(msgs) };
    }),
  );

  return {
    exportedAt: new Date().toISOString(),
    userId,
    profile: profileSnap.exists ? { id: profileSnap.id, ...(profileSnap.data() as object) } : null,
    tenanciesAsTenant: rows(rentedTenancies),
    tenanciesAsOwner: rows(ownedTenants),
    agreementsAsOwner: rows(ownerAgreements),
    agreementsAsTenant,
    transactions: [...rows(ownerTransactions), ...tenantTransactions],
    paymentMethods,
    properties: rows(ownedProperties),
    portfolios: rows(ownedPortfolios),
    portfolioAccessContacts: [...rows(paccOwner), ...rows(paccContact)],
    documents: [...rows(ownerDocuments), ...rows(tenantDocuments)],
    emailRecipients: rows(emailRecipientsSnap),
    conversations,
    tickets: rows(tickets),
    expertApplications: rows(expertApplications),
    suggestionRequests: rows(suggestionRequests),
    marketplaceLeads: rows(marketplaceLeads),
    complimentaryPlans: rows(complimentaryPlans),
  };
}
