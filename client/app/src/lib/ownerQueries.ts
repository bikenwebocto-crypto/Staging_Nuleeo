import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@ui/lib/useAuth";
import { apiRequest } from "@ui/lib/queryClient";
import type {
  AccessContactType,
  Agreement,
  AgreementIndexation,
  AgreementStatus,
  AutoRenewalMode,
  CpiIndexationType,
  DevelopmentStatus,
  EnergyClass,
  LeaseType,
  MarketplaceLead,
  MarketplaceListing,
  OccupancyStatus,
  OwnerPlanKey,
  OwnershipType,
  Partner,
  PaymentFrequency,
  PortfolioAccessContact,
  PropertyType,
  PropertyUse,
  Tenant,
  TenantStatus,
  TitleDeedsStatus,
  Transaction,
  TransactionCategory,
  TransactionType,
  TxPaymentMethod,
  Unit,
} from "@shared/firestore-schema";
import { useActivePortfolio, withOwnerScope } from "@/lib/activePortfolio";

export interface OwnerProperty {
  id: string;
  ownerId: string;
  address: string;
  addressNumber?: string;
  name?: string;
  image?: string;
  lat?: number;
  lng?: number;
  propertyValue: number;
  acquisitionPrice: number;
  createdAt: string;
  propertyType?: PropertyType;
  buildingName?: string;
  floor?: string;
  sqm?: string;
  builtYear?: string;
  energyClass?: EnergyClass;
  developmentStatus?: DevelopmentStatus;
  developmentYear?: string;
  acquisitionYear?: string;
  propertyUse?: PropertyUse;
  occupancyStatus?: OccupancyStatus;
  city?: string;
  postalCode?: string;
  country?: string;
  parking?: number;
  elevator?: boolean;
  heating?: boolean;
  cooling?: boolean;
  solarPanels?: boolean;
  storageUnit?: boolean;
  ownershipType?: OwnershipType;
  companyName?: string;
  titleDeedsStatus?: TitleDeedsStatus;

  unitCount: number;
  rentAmount: number;
  // `occupied` is active-only (revenue-bearing leases). `tenancyState` adds
  // the in-between "pending" state — an invited tenant awaiting approval — so
  // the list/dashboard don't show "Add tenant" right after the owner invited
  // one. tenantName carries the active OR pending tenant's name.
  occupied: boolean;
  tenancyState: "occupied" | "pending" | "vacant";
  tenantName: string | null;
}

export interface OwnerTransaction extends Transaction {
  propertyAddress: string | null;
}

export interface OwnerAgreement {
  id: string;
  status: AgreementStatus;
  leaseType: LeaseType;
  tenantId: string;
  tenantName: string;
  tenantEmail: string;
  // The tenant's phone, sourced from their linked User account. Null when the
  // tenant hasn't registered yet or has no number on file.
  tenantPhone: string | null;
  // The tenant's linked User.id, or null until they accept their invite. Gates
  // the "Message tenant" affordance — no chattable counterpart until sign-up.
  tenantUserId: string | null;
  owner: string;
  propertyId: string;
  unitId: string;
  address: string;
  propertyImage: string | null;
  monthlyRent: number;
  deposit: number;
  agreementValue: number;
  startDate: string;
  endDate: string;
  signedAt: string | null;
  // The owner-uploaded signed/physical lease PDF. documentUrl is a fresh,
  // short-lived signed URL (null when nothing is attached); the rest is display
  // metadata.
  documentUrl: string | null;
  documentName: string | null;
  documentSize: number | null;
  documentUploadedAt: string | null;
  paymentDayOfMonth: number | null;
  noticePeriodMonths: number | null;
  // Owner-entered lease terms surfaced on the agreement document, for parity
  // with the tenant view. Mirrors TenantAgreement.
  paymentFrequency: PaymentFrequency | null;
  rentalDurationMonths: number | null;
  rentFreePeriodMonths: number | null;
  prepaidRents: number | null;
  autoRenewal: AutoRenewalMode | null;
  indexation: AgreementIndexation | null;
  termsAndConditions: string | null;
}

export interface OwnerTenant {
  id: string;
  userId: string | null;
  name: string;
  email: string;
  // Phone from the linked User account; null when the tenant hasn't registered
  // yet or has no number on file. Mirrors OwnerAgreement.tenantPhone.
  phone: string | null;
  status: TenantStatus;
  rentAmount: number;
  nextPayment: string | null;
  paymentStatus: "paid" | "pending" | "overdue" | null;
  // Unpaid rent preserved when the tenancy ended (0 when none). Surfaced so the
  // owner can see and settle a closed lease's final balance.
  outstandingBalance: number;
  propertyId: string;
  propertyAddress: string | null;
  propertyImage: string | null;
  unitId: string;
  unitLabel: string | null;
  createdAt: string;
}

export interface OwnerSummary {
  unitCount: number;
  portfolioValue: number;
  monthlyRevenue: number;
  occupancyRate: number;
  equityInvested: number;
}

export interface OwnerPropertyDetail extends OwnerProperty {
  units: Unit[];
}

// Owner-side queries are scoped by the active portfolio. When viewing self
// (the default) the URL stays `/api/owner/foo` so existing prefetch and cache
// work unchanged. When the user has switched into a portfolio they were
// granted access to, the URL becomes `/api/owner/foo?portfolioId=<doc id>`
// (preferred; stable across owner transfers) or the legacy
// `/api/owner/foo?ownerId=<their-uid>` while the doc id is still resolving —
// and react-query treats it as a separate cache entry, so switching back to
// self shows the cached self data instantly.

export function useOwnerProperties() {
  const { firebaseUser } = useAuth();
  const { activeOwnerId, activePortfolioDocId, isSelf } = useActivePortfolio();
  const url = withOwnerScope("/api/owner/properties", activeOwnerId, isSelf, activePortfolioDocId);
  return useQuery<OwnerProperty[]>({
    queryKey: [url],
    enabled: !!firebaseUser,
  });
}

export function useOwnerTransactions() {
  const { firebaseUser } = useAuth();
  const { activeOwnerId, activePortfolioDocId, isSelf } = useActivePortfolio();
  const url = withOwnerScope(
    "/api/owner/transactions",
    activeOwnerId,
    isSelf,
    activePortfolioDocId,
  );
  return useQuery<OwnerTransaction[]>({
    queryKey: [url],
    enabled: !!firebaseUser,
  });
}

// Transactions for the Insights page: a DATE window (last ~12 months) rather
// than the activity feed's 25-row cap, so the cash-flow chart and net-income
// figures reflect the whole period and reconcile with the briefing + CSV. The
// 370-day fetch covers the 12-month chart plus the widest (365-day) summary
// window; the page filters client-side for the selected 30/60/90/120/365 view.
export function useOwnerInsightsTransactions() {
  const { firebaseUser } = useAuth();
  const { activeOwnerId, activePortfolioDocId, isSelf } = useActivePortfolio();
  const url = withOwnerScope(
    "/api/owner/transactions?sinceDays=370",
    activeOwnerId,
    isSelf,
    activePortfolioDocId,
  );
  return useQuery<OwnerTransaction[]>({
    queryKey: [url],
    enabled: !!firebaseUser,
  });
}

export function useOwnerAgreements() {
  const { firebaseUser } = useAuth();
  const { activeOwnerId, activePortfolioDocId, isSelf } = useActivePortfolio();
  const url = withOwnerScope("/api/owner/agreements", activeOwnerId, isSelf, activePortfolioDocId);
  return useQuery<OwnerAgreement[]>({
    queryKey: [url],
    enabled: !!firebaseUser,
  });
}

export function useOwnerTenants() {
  const { firebaseUser } = useAuth();
  const { activeOwnerId, activePortfolioDocId, isSelf } = useActivePortfolio();
  const url = withOwnerScope("/api/owner/tenants", activeOwnerId, isSelf, activePortfolioDocId);
  return useQuery<OwnerTenant[]>({
    queryKey: [url],
    enabled: !!firebaseUser,
  });
}

export function useOwnerSummary() {
  const { firebaseUser } = useAuth();
  const { activeOwnerId, activePortfolioDocId, isSelf } = useActivePortfolio();
  const url = withOwnerScope("/api/owner/summary", activeOwnerId, isSelf, activePortfolioDocId);
  return useQuery<OwnerSummary>({
    queryKey: [url],
    enabled: !!firebaseUser,
  });
}

// Single-property reads aren't scoped by `?ownerId=` — the property doc
// itself carries an ownerId, and the server checks the caller is either the
// owner or a granted contact. So the cache key stays a function of `id` only.
export function useOwnerProperty(id: string | undefined) {
  const { firebaseUser } = useAuth();
  return useQuery<OwnerPropertyDetail>({
    queryKey: [`/api/properties/${id}`],
    enabled: !!firebaseUser && !!id,
  });
}

export function useOwnerPropertyTransactions(id: string | undefined) {
  const { firebaseUser } = useAuth();
  return useQuery<Transaction[]>({
    queryKey: [`/api/properties/${id}/transactions`],
    enabled: !!firebaseUser && !!id,
  });
}

export interface AccessiblePortfolio {
  ownerId: string;
  portfolioId: string;
  // The STABLE Portfolio doc id (portfolios/{id}) — the operative scope key
  // for `?portfolioId=` API params. Null when the server hasn't resolved one
  // for this owner yet; callers then fall back to the legacy `?ownerId=`.
  // Distinct from `portfolioId` above, which is a display label.
  portfolioDocId: string | null;
  ownerName: string;
  ownerEmail: string;
  role: "self" | "legacy" | "legal" | "financial";
  permissions: ("view" | "edit")[];
  isSelf: boolean;
  // Plan tier of the portfolio's owner (sourced server-side from the owner's
  // stripeRole claim). Drives feature gates for granted contacts who inherit
  // the owner's plan when acting on this portfolio.
  ownerPlan: OwnerPlanKey;
}

export function useAccessiblePortfolios() {
  const { firebaseUser } = useAuth();
  return useQuery<AccessiblePortfolio[]>({
    queryKey: ["/api/portfolios/accessible"],
    enabled: !!firebaseUser,
  });
}

export function useAccessContacts(opts?: { enabled?: boolean }) {
  const { firebaseUser } = useAuth();
  const callerEnabled = opts?.enabled ?? true;
  return useQuery<PortfolioAccessContact[], Error, PortfolioAccessContact[]>({
    queryKey: ["/api/owner/access-contacts"],
    enabled: !!firebaseUser && callerEnabled,
    // Declined invitations live in the same collection (kept for the
    // platform activity log) but should look like empty slots to the
    // owner so the normal "Add" flow re-invites cleanly.
    select: (rows) => rows.filter((c) => c.status !== "declined"),
  });
}

export function useUpsertAccessContact() {
  const qc = useQueryClient();
  return useMutation<
    PortfolioAccessContact,
    Error,
    { type: AccessContactType; name: string; email: string }
  >({
    mutationFn: async ({ type, name, email }) => {
      const res = await apiRequest("PUT", `/api/owner/access-contacts/${type}`, {
        name,
        email,
      });
      return (await res.json()) as PortfolioAccessContact;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/owner/access-contacts"] });
    },
  });
}

export function useDeleteAccessContact() {
  const qc = useQueryClient();
  return useMutation<void, Error, AccessContactType>({
    mutationFn: async (type) => {
      await apiRequest("DELETE", `/api/owner/access-contacts/${type}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/owner/access-contacts"] });
    },
  });
}

// Invitations the caller has RECEIVED — other owners asking to grant them
// legacy/legal/financial access. Server hydrates with the owner's name/email
// so the invitee sees a human in the UI instead of a uid.
export type PendingInvitation = PortfolioAccessContact & {
  ownerName: string;
  ownerEmail: string;
};

export function usePendingInvitations() {
  const { firebaseUser } = useAuth();
  return useQuery<PendingInvitation[]>({
    queryKey: ["/api/access-contacts/invitations"],
    enabled: !!firebaseUser,
    // Also feeds the header notification bell — keep it fresh (poll + refresh
    // on focus) so a new portfolio-access invite appears without a reload.
    // Mirrors useTenantAgreements().
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

export function useAcceptInvitation() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      await apiRequest("POST", `/api/access-contacts/invitations/${id}/accept`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/access-contacts/invitations"] });
      qc.invalidateQueries({ queryKey: ["/api/portfolios/accessible"] });
    },
  });
}

export function useDeclineInvitation() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      await apiRequest("POST", `/api/access-contacts/invitations/${id}/decline`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/access-contacts/invitations"] });
    },
  });
}

// Offline rent payments a tenant logged that still need THIS owner's
// confirmation. Feeds the header notification bell (next to lease approvals
// and portfolio invites) and the Activity page's inline confirm button, so —
// like usePendingInvitations — it polls and refreshes on focus rather than
// using the app-wide fetch-once default, so a payment a tenant just logged
// appears within ~a minute without a reload.
export interface PendingRentPayment {
  id: string;
  amount: number;
  currency: string;
  paymentMethod: TxPaymentMethod | null;
  timestamp: string;
  propertyId: string | null;
  propertyAddress: string | null;
  tenantId: string | null;
  tenantName: string;
  proofUrl: string | null;
  notes: string | null;
}

export function usePendingRentPayments() {
  const { firebaseUser } = useAuth();
  return useQuery<PendingRentPayment[]>({
    queryKey: ["/api/owner/payments/pending"],
    enabled: !!firebaseUser,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

// Owner confirms an offline rent payment actually arrived. Server flips the
// transaction to "completed", books the income and advances the rent cycle —
// so the pending list, the activity feed, the tenants list and the portfolio
// summary all change. The owner-scoped keys are invalidated by their self
// (bare-path) form, which is what's mounted when an owner confirms their own
// payment (verify is owner-self only, so the cross-portfolio scoped variants
// can't be the active confirm context).
export function useVerifyRentPayment() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      await apiRequest("POST", `/api/owner/payment/verify/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/owner/payments/pending"] });
      qc.invalidateQueries({ queryKey: ["/api/owner/transactions"] });
      qc.invalidateQueries({ queryKey: ["/api/owner/tenants"] });
      qc.invalidateQueries({ queryKey: ["/api/owner/summary"] });
    },
  });
}

// Owner marks an ended tenancy's outstanding closing balance as settled (paid
// directly / off-platform). Books realized rent income and clears the arrear.
export function useSettleTenantBalance() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (tenancyId) => {
      await apiRequest("POST", `/api/owner/tenants/${tenancyId}/settle-balance`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/owner/tenants"] });
      qc.invalidateQueries({ queryKey: ["/api/owner/transactions"] });
      qc.invalidateQueries({ queryKey: ["/api/owner/summary"] });
    },
  });
}

// Owner marks a tenant-reported maintenance issue as resolved. Server flips
// the mirrored transaction "pending" → "resolved", closes the backing ticket
// and notifies the tenant — so the activity feed (dashboard widget + Activity
// page) re-renders with a "Resolved" badge. Owner-self only server-side
// (tx.ownerId === caller), so — like verify — the bare-path owner-transactions
// key is the one mounted when an owner resolves their own report.
export function useResolveRepair() {
  const qc = useQueryClient();
  return useMutation<Transaction, Error, string>({
    mutationFn: async (id) => {
      const res = await apiRequest("POST", `/api/owner/maintenance/resolve/${id}`);
      return (await res.json()) as Transaction;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/owner/transactions"] });
    },
  });
}

// Correct a manual activity the owner recorded, within the 24h edit window.
// Owner-self only server-side (PATCH rejects non-owners, non-manual rows, and
// anything past the window). Touches the same caches as recording one: the
// activity feed, the portfolio summary, and the affected property's
// transaction list (PropertyDetailsPage). When the entry moved to a different
// property, both the old and new property lists are refreshed.
export interface UpdateOwnerTransactionInput {
  id: string;
  propertyId?: string;
  name?: string;
  amount?: number;
  type?: TransactionType;
  category?: TransactionCategory;
  timestamp?: string;
  notes?: string;
  // The property the entry was on before this edit. Client-only — used to
  // invalidate that property's cache when the owner reassigns the entry.
  prevPropertyId?: string;
}

export function useUpdateOwnerTransaction() {
  const qc = useQueryClient();
  const { activeOwnerId, activePortfolioDocId, isSelf } = useActivePortfolio();
  return useMutation<Transaction, Error, UpdateOwnerTransactionInput>({
    mutationFn: async ({ id, prevPropertyId: _prev, ...changes }) => {
      const res = await apiRequest("PATCH", `/api/owner/transactions/${id}`, changes);
      return (await res.json()) as Transaction;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/transactions", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/summary", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
      // De-dupe the (up to two) affected property ids without iterating a Set
      // — the shared tsconfig target predates downlevel Set iteration.
      const propertyIds = [vars.propertyId, vars.prevPropertyId].filter(
        (v, i, arr): v is string => !!v && arr.indexOf(v) === i,
      );
      propertyIds.forEach((pid) => {
        qc.invalidateQueries({ queryKey: [`/api/properties/${pid}/transactions`] });
      });
    },
  });
}

// Create a Tenant + draft Agreement on an owner-controlled property. The
// server picks the first vacant unit, provisions a Firebase Auth account for
// the tenant (or links to an existing one), and returns a password-setup
// link the owner can share manually — same copy-link pattern as admin user
// invites since there's no transactional email provider live yet.
export interface CreateAgreementInput {
  tenantEmail: string;
  propertyId: string;
  rentAmount: number;
  deposit: number;
  startDate: string;
  signatureDate?: string;
  nextPaymentDate?: string;
  prepaidRents?: number;
  rentFreePeriodMonths?: number;
  paymentFrequency?: PaymentFrequency;
  rentalDurationMonths?: number;
  noticePeriodMonths?: number;
  autoRenewal?: AutoRenewalMode;
  cpiType?: CpiIndexationType;
  ownerIndexation?: number;
  indexationDelay?: number;
  indexationFrequency?: PaymentFrequency;
}

export interface CreateAgreementResponse {
  tenant: Tenant;
  agreement: Agreement;
  inviteLink: string | null;
}

export function useCreateAgreement() {
  const qc = useQueryClient();
  const { activeOwnerId, activePortfolioDocId, isSelf } = useActivePortfolio();
  return useMutation<CreateAgreementResponse, Error, CreateAgreementInput>({
    mutationFn: async (input) => {
      const url = withOwnerScope(
        "/api/owner/agreements",
        activeOwnerId,
        isSelf,
        activePortfolioDocId,
      );
      const res = await apiRequest("POST", url, input);
      return (await res.json()) as CreateAgreementResponse;
    },
    onSuccess: () => {
      // Owner-side: agreements/tenants/properties/summary all change.
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/agreements", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/tenants", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/properties", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/summary", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
    },
  });
}

// Edit the core terms (rent, deposit, dates) of an existing agreement.
// Owner-self only server-side — granted contacts can read but not mutate.
// Touches the same caches as creation since rent/dates feed revenue +
// occupancy, which are derived from the active tenancy.
export interface UpdateAgreementInput {
  id: string;
  monthlyRent?: number;
  deposit?: number;
  startDate?: string;
  endDate?: string;
}

export function useUpdateAgreement() {
  const qc = useQueryClient();
  const { activeOwnerId, activePortfolioDocId, isSelf } = useActivePortfolio();
  return useMutation<Agreement, Error, UpdateAgreementInput>({
    mutationFn: async ({ id, ...changes }) => {
      const res = await apiRequest("PATCH", `/api/owner/agreements/${id}`, changes);
      return (await res.json()) as Agreement;
    },
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/agreements", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/tenants", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/properties", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/summary", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
    },
  });
}

// Active partners (brokers, contractors, legal, etc.). Curated by admins;
// read by any signed-in user on the Network page.
export function usePartners() {
  const { firebaseUser } = useAuth();
  return useQuery<Partner[]>({
    queryKey: ["/api/partners"],
    enabled: !!firebaseUser,
  });
}

// Active marketplace listings (properties for sale). Admin-curated; read by
// any signed-in user on the Marketplace page.
export function useMarketplaceListings() {
  const { firebaseUser } = useAuth();
  return useQuery<MarketplaceListing[]>({
    queryKey: ["/api/marketplace"],
    enabled: !!firebaseUser,
  });
}

// Single listing lookup for the detail page. Pulled from the cached list
// when present (no extra fetch on warm cache); falls back to refetching
// the full list on deep links.
export function useMarketplaceListing(id: string | undefined) {
  const listings = useMarketplaceListings();
  const listing = listings.data?.find((l) => l.id === id);
  // Re-expose isError + refetch so the detail page can distinguish a failed
  // fetch ("couldn't load — retry") from a genuine miss ("listing not found").
  return {
    listing,
    isLoading: listings.isLoading,
    isError: listings.isError,
    refetch: listings.refetch,
  };
}

export function useCreateMarketplaceLead() {
  return useMutation<MarketplaceLead, Error, { listingId: string; message?: string }>({
    mutationFn: async ({ listingId, message }) => {
      const res = await apiRequest("POST", "/api/owner/marketplace-leads", {
        listingId,
        message,
      });
      return (await res.json()) as MarketplaceLead;
    },
  });
}
