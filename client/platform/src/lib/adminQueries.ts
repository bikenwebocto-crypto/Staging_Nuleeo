import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@ui/lib/queryClient";
import { useAuth } from "@ui/lib/useAuth";
import { usePrivileges } from "@ui/lib/usePrivileges";
import type {
  AgreementStatus,
  MarketplaceLeadStatus,
  MarketplaceListing,
  MarketplaceListingStatus,
  MarketplaceListingTag,
  Partner,
  PartnerType,
  PaymentMethod,
  PlatformRoleKey,
  Role,
  SuggestionPropertyType,
  SuggestionRequestStatus,
  TenantStatus,
  TicketPriority,
  TicketStatus,
  TransactionCategory,
  TransactionType,
  UserStatus,
} from "@shared/firestore-schema";

// ─────────────────────────── Admin dashboard ───────────────────────────

export interface AdminDashboardStats {
  arr: number;
  mrr: number;
  totalRealEstateValue: number;
  activeSubscriptions: number;
  totalProperties: number; // == total units
  totalUsers: number;
  totalAgreements: number;
  totalOwners: number;
  totalTenants: number;
  dualRoleUsers: number;
  propertiesRented: number;
  propertiesAvailable: number;
}

export interface AdminLocationCount {
  name: string;
  count: number;
}

export interface AdminLocationRental {
  name: string;
  price: number;
}

export interface AdminMapMarker {
  id: string;
  lat: number;
  lng: number;
  address: string;
  tenantName: string;
  rentAmount: number;
  paymentStatus: "paid" | "pending" | "overdue";
  image: string | null;
  // Property valuation (propertyValue). 0 ⇒ unset OR masked from a
  // non-finance admin (the server zeroes it without finance.viewAll).
  value: number;
}

export interface AdminMonthlyPoint {
  month: string; // e.g. "Jan"
  revenue: number; // platform commission, euros
  volume: number; // gross rent volume, euros
}

export interface AdminDailyActivityPoint {
  day: string; // e.g. "Mon"
  value: number; // count of activity events
}

export interface AdminUnitGrowthPoint {
  month: string;
  units: number; // cumulative
}

// Time-range filter for the SuperAdminDashboard pill. The server
// scopes every widget — headlines, trend bubbles, charts, map, top
// locations, avg rental — to the selected window. "all" = Lifetime.
export type DashboardRange = "1d" | "1w" | "1m" | "1q" | "1y" | "all";

export interface AdminDashboardResponse {
  range: DashboardRange;
  stats: AdminDashboardStats;
  // For range === 'all' these keep their legacy semantic ("this
  // month" counts; arrYoY/mrrMoM/aumYoY are MoM/YoY percentages).
  // For any other range, every field is a percent change vs the
  // prior equivalent window — the client renders one label per
  // range ("vs prior 1 day", "vs prior 1 week", etc).
  trends: {
    arrYoY: number; // percent change
    mrrMoM: number;
    subscriptionsThisMonth: number;
    propertiesThisMonth: number;
    usersThisMonth: number;
    agreementsThisMonth: number;
    aumYoY: number;
  };
  topProperties: {
    cities: AdminLocationCount[];
    countries: AdminLocationCount[];
  };
  topUsers: {
    cities: AdminLocationCount[];
    countries: AdminLocationCount[];
  };
  avgRental: {
    cities: AdminLocationRental[];
    countries: AdminLocationRental[];
  };
  mapMarkers: AdminMapMarker[];
  monthlySeries: AdminMonthlyPoint[];
  weeklyActivity: AdminDailyActivityPoint[];
  unitGrowth: AdminUnitGrowthPoint[];
}

export function useAdminDashboard(range: DashboardRange = "all") {
  const { firebaseUser } = useAuth();
  const { canPlatform } = usePrivileges();
  // Opt into financial fields only when the caller can read them; server
  // 403s the query param otherwise. URL is the queryKey so each
  // (range × financial) combination caches separately. `invalidate()`
  // strips the query string and matches by prefix to refresh all
  // cached variants after a mutation.
  const params = new URLSearchParams();
  params.set("range", range);
  if (canPlatform("finance.viewAll")) params.set("financial", "1");
  const url = `/api/admin/dashboard?${params.toString()}`;
  return useQuery<AdminDashboardResponse>({
    queryKey: [url],
    enabled: !!firebaseUser,
  });
}

// ─────────────────────────── Users ───────────────────────────

// Mirrors the legacy mockUsers row shape so existing JSX (which reads
// firstName/lastName/name/joinDate/units* fields) continues to work.
export interface AdminUserRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  phone: string;
  address: string;
  photoURL: string | null;
  // Capitalized labels match what the page renders directly.
  roles: Array<"Owner" | "Tenant" | "Admin" | "Superadmin">;
  rawRoles: Role[];
  platformRole: PlatformRoleKey | null;
  status: "Active" | "Suspended" | "Invited" | "Pending";
  rawStatus: UserStatus;
  // Sourced from the Stripe Payments extension (`stripeRole` custom claim),
  // not from any Firestore field — admins manage subscriptions in Stripe.
  plan: "Free" | "Advance" | "Pro";
  joinDate: string; // YYYY-MM-DD
  joinedAt: string; // ISO
  lastLogin: string; // human-readable ("9 hours ago" / "—")
  lastLoginAt: string | null;
  // Updated by the user app's heartbeat ping (POST /api/heartbeat) while the
  // user has a visible, signed-in tab. Drives the green/grey "online" dot and
  // the Last Seen column in /admin/users.
  lastSeen: string; // human-readable ("2 minutes ago" / "—")
  lastSeenAt: string | null;
  unitsAssociated: number;
  unitsOwned: number;
  unitsRentedOut: number;
  unitsRentedIn: number;
}

export function useAdminUsers() {
  const { firebaseUser } = useAuth();
  return useQuery<AdminUserRow[]>({
    queryKey: ["/api/admin/users"],
    enabled: !!firebaseUser,
    // Refresh every 30s so the "currently in the app" dot stays accurate as
    // users come and go. Heartbeats land in Firestore every 60s; a 30s poll
    // means the dot turns grey within ~2.5min of someone closing their tab.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

// ─────────────────────────── Units ───────────────────────────

export interface AdminUnitRow {
  id: string; // unitId
  propertyId: string;
  ownerId: string;
  ownerName: string;
  ownerEmail: string | null;
  address: string;
  unitLabel: string | null;
  tenantName: string; // "Vacant" if unoccupied
  tenantId: string | null;
  rentAmount: number;
  paymentStatus: "paid" | "pending" | "overdue";
  image: string | null;
  nextPaymentDate: string | null;
  leaseEnd: string | null;
  propertyValue: number;
  acquisitionPrice: number;
  totalCollected: number;
  lat: number | null;
  lng: number | null;
  city: string | null;
  country: string | null;
  postalCode: string | null;
  // Full property-level descriptors so the admin edit drawer can hydrate from
  // the row without a second fetch. Optional/nullable because pre-existing
  // properties may not have all of these set yet.
  propertyType?: "Apartment" | "House" | "Villa" | "Commercial" | "Plot" | null;
  buildingName?: string | null;
  floor?: string | null;
  sqm?: string | null;
  builtYear?: string | null;
  energyClass?: "A+" | "A" | "B" | "C" | "D" | "E" | "F" | "G" | null;
  parking?: number | null;
  elevator?: boolean | null;
  heating?: boolean | null;
  cooling?: boolean | null;
  solarPanels?: boolean | null;
  storageUnit?: boolean | null;
  ownershipType?: "individual" | "company" | null;
  companyName?: string | null;
  titleDeedsStatus?: "issued" | "pending" | null;
  developmentStatus?: "off_plan" | "under_construction" | "fully_developed" | null;
  propertyUse?: "hold" | "rent" | "owner_occupied" | null;
  acquisitionYear?: string | null;
  developmentYear?: string | null;
  rentPrice?: number | null;
}

export function useAdminUnits() {
  const { firebaseUser } = useAuth();
  const { canPlatform } = usePrivileges();
  const url = canPlatform("finance.viewAll") ? "/api/admin/units?financial=1" : "/api/admin/units";
  return useQuery<AdminUnitRow[]>({
    queryKey: [url],
    enabled: !!firebaseUser,
  });
}

// ─────────────────────────── Portfolios ───────────────────────────

// One row per owner — aggregates units, role contacts, rented count, and
// total value. Backed by /api/admin/portfolios which joins users + properties
// + tenants + portfolioAccessContacts server-side.
export interface AdminPortfolioRow {
  id: string;
  portfolioId: string | null;
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  portfolioName: string;
  unitsCount: number;
  // Display labels: "Owner" always, plus "Legacy Owner" / "Legal" / "Financial"
  // for each active access contact.
  roles: string[];
  rentedOut: number;
  totalValue: number;
}

export function useAdminPortfolios() {
  const { firebaseUser } = useAuth();
  const { canPlatform } = usePrivileges();
  const url = canPlatform("finance.viewAll")
    ? "/api/admin/portfolios?financial=1"
    : "/api/admin/portfolios";
  return useQuery<AdminPortfolioRow[]>({
    queryKey: [url],
    enabled: !!firebaseUser,
  });
}

// ─────────────────────────── Agreements ───────────────────────────

export interface AdminAgreementRow {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantEmail: string;
  tenantImage: string | null;
  tenantStatus: TenantStatus;
  unitId: string;
  propertyId: string;
  propertyAddress: string;
  ownerId: string;
  ownerName: string;
  rentAmount: number;
  agreementValue: number;
  status: AgreementStatus;
  startDate: string;
  endDate: string;
  expiration: string; // human-readable end date
  nextPayment: string; // human-readable
  documentUrl: string | null;
  signedAt: string | null;
}

export function useAdminAgreements() {
  const { firebaseUser } = useAuth();
  const { canPlatform } = usePrivileges();
  const url = canPlatform("finance.viewAll")
    ? "/api/admin/agreements?financial=1"
    : "/api/admin/agreements";
  return useQuery<AdminAgreementRow[]>({
    queryKey: [url],
    enabled: !!firebaseUser,
  });
}

// ─────────────────────────── Transactions ───────────────────────────

// One row per REAL Stripe money movement (the endpoint excludes offline /
// owner-recorded ledger entries): a Stripe Connect rent payment ("rent")
// or an owner subscription payment from Stripe Billing ("subscription").
export interface AdminTransactionRow {
  id: string;
  kind: "rent" | "subscription";
  name: string;
  amount: number;
  currency: string;
  type: TransactionType;
  category: TransactionCategory;
  status: "completed" | "pending" | "failed";
  timestamp: string; // ISO
  date: string; // human-readable for table display
  propertyAddress: string | null;
  ownerName: string | null;
  tenantName: string | null;
  // Platform revenue in cents: the Connect application fee for rent rows
  // (null when no fee was captured), the full amount for subscriptions.
  platformFeeCents: number | null;
  // Refund visibility for rent rows (null when none): cents returned to the
  // cardholder, and the platform application-fee refunded.
  refundedAmountCents: number | null;
  feeRefundedCents: number | null;
}

export interface AdminTransactionsResponse {
  rows: AdminTransactionRow[];
  // The newest-N caps were hit → older real Stripe rows exist beyond this
  // window. Lets the page disclose truncation instead of it reading as missing
  // data. subscriptionsCapped is effectively never true (owners-only billing).
  rentCapped: boolean;
  subscriptionsCapped: boolean;
}

// `enabled` lets the header bell skip the request for admins who lack
// finance.viewAll (the data would 403 anyway).
export function useAdminTransactions(enabled = true) {
  const { firebaseUser } = useAuth();
  return useQuery<AdminTransactionsResponse>({
    queryKey: ["/api/admin/transactions"],
    enabled: !!firebaseUser && enabled,
    // The header notification bell polls this for new money movements. Gentler
    // than the leads poll because each refetch also lists Stripe subscription
    // invoices live (a Stripe API call), and rent rows aren't second-sensitive.
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
    staleTime: 60_000,
  });
}

// ─────────────────────────── Partners ───────────────────────────

export interface AdminPartnerRow extends Partner {
  // Already matches Firestore schema; alias for clarity.
}
export type { PartnerType };

export function useAdminPartners() {
  const { firebaseUser } = useAuth();
  return useQuery<AdminPartnerRow[]>({
    queryKey: ["/api/admin/partners"],
    enabled: !!firebaseUser,
  });
}

// ─────────────────────────── Tickets / Support ───────────────────────────

export interface AdminTicketRow {
  id: string;
  subject: string;
  description: string;
  userId: string;
  userName: string;
  userEmail: string;
  userImage: string | null;
  category: "billing" | "technical" | "account" | "general" | "property";
  priority: TicketPriority;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  propertyId: string | null;
  unitId: string | null;
}

export function useAdminTickets() {
  const { firebaseUser } = useAuth();
  return useQuery<AdminTicketRow[]>({
    queryKey: ["/api/admin/tickets"],
    enabled: !!firebaseUser,
  });
}

// ─────────────────────────── Audit log ────────────────────────────
// Combined feed of admin actions across two collections:
//   - impersonations: every "View as user" an admin opened
//   - userAudit: every roles / platformRole / status change an admin
//     made to another user
// Used by the AdminAuditLogPage table. Filters serialize into the
// query string so the queryKey identifies the call shape — switching
// filters refetches.

export type AdminAuditEntryType = "impersonation" | "user-audit";

export interface AdminAuditEntry {
  id: string;
  type: AdminAuditEntryType;
  actorUid: string;
  actorEmail: string;
  targetUid: string;
  targetEmail: string;
  createdAt: string;
  // user-audit only — before/after snapshots of what changed
  beforeRoles?: string[];
  afterRoles?: string[];
  beforePlatformRole?: string | null;
  afterPlatformRole?: string | null;
  beforeStatus?: string;
  afterStatus?: string;
  // Set for self-initiated credential events (add/remove password,
  // connect/disconnect Google, request email change).
  action?: string;
}

export interface AdminAuditLogResponse {
  items: AdminAuditEntry[];
  nextCursor: string | null;
}

export interface AdminAuditLogFilters {
  type?: AdminAuditEntryType | null;
  actorUid?: string | null;
  targetUid?: string | null;
}

export function useAdminAuditLog(filters: AdminAuditLogFilters = {}) {
  const { firebaseUser } = useAuth();
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.actorUid) params.set("actorUid", filters.actorUid);
  if (filters.targetUid) params.set("targetUid", filters.targetUid);
  const qs = params.toString();
  const url = qs ? `/api/admin/audit-log?${qs}` : "/api/admin/audit-log";
  return useQuery<AdminAuditLogResponse>({
    queryKey: [url],
    enabled: !!firebaseUser,
  });
}

// ─────────────────────── Investment-suggestion leads ─────────────────────

export interface AdminSuggestionRequestRow {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userImage: string | null;
  location: string;
  budget: number | null;
  propertyType: SuggestionPropertyType;
  status: SuggestionRequestStatus;
  createdAt: string;
}

export function useAdminSuggestionRequests() {
  const { firebaseUser } = useAuth();
  return useQuery<AdminSuggestionRequestRow[]>({
    queryKey: ["/api/admin/suggestion-requests"],
    enabled: !!firebaseUser,
  });
}

export function useUpdateSuggestionRequest() {
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: SuggestionRequestStatus }) => {
      const res = await apiRequest("PATCH", `/api/admin/suggestion-requests/${id}`, { status });
      return (await res.json()) as AdminSuggestionRequestRow;
    },
    onSuccess: () => invalidate("/api/admin/suggestion-requests"),
  });
}

// ─────────────────────── Per-listing marketplace leads ───────────────────

export interface AdminMarketplaceLeadRow {
  id: string;
  listingId: string;
  listingTitle: string;
  listingPrice: number;
  listingLocation: string;
  userId: string;
  userName: string;
  userEmail: string;
  userImage: string | null;
  message?: string;
  status: MarketplaceLeadStatus;
  createdAt: string;
}

// `enabled` lets the header bell skip the request for admins who lack the
// gating privilege (comm.activityLog) — the data would 403 anyway.
export function useAdminMarketplaceLeads(enabled = true) {
  const { firebaseUser } = useAuth();
  return useQuery<AdminMarketplaceLeadRow[]>({
    queryKey: ["/api/admin/marketplace-leads"],
    enabled: !!firebaseUser && enabled,
    // The header notification bell reads this, so poll (the global default is
    // staleTime:Infinity + no refetch) to surface new leads without a reload.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

export function useUpdateMarketplaceLead() {
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: MarketplaceLeadStatus }) => {
      const res = await apiRequest("PATCH", `/api/admin/marketplace-leads/${id}`, { status });
      return (await res.json()) as AdminMarketplaceLeadRow;
    },
    onSuccess: () => invalidate("/api/admin/marketplace-leads"),
  });
}

// ─────────────────────────── Activity log ───────────────────────────

export type AdminActivityKind =
  | "user.created"
  | "user.updated"
  | "property.created"
  | "agreement.created"
  | "agreement.activated"
  | "agreement.expired"
  | "transaction.completed"
  | "transaction.pending"
  | "ticket.created"
  | "ticket.resolved"
  | "subscription.started"
  | "subscription.cancelled";

export interface AdminActivityRow {
  id: string;
  kind: AdminActivityKind;
  entity: "user" | "property" | "agreement" | "transaction" | "ticket" | "subscription";
  // Human-readable summary, ready to drop into the UI.
  title: string;
  description: string;
  timestamp: string; // ISO
  actorName: string | null; // who did it (if known)
  actorEmail: string | null;
}

export function useAdminActivity() {
  const { firebaseUser } = useAuth();
  return useQuery<AdminActivityRow[]>({
    queryKey: ["/api/admin/activity"],
    enabled: !!firebaseUser,
  });
}

// Re-export commonly used types for convenience inside admin pages.
export type { PaymentMethod };

// ─────────────────────────── Mutations ───────────────────────────
//
// Each hook wraps `apiRequest()` from the shared queryClient. On success they
// invalidate the relevant list query so the UI refetches the up-to-date row.

// Hooks that opt-in to financial fields (?financial=1) encode the flag in
// the queryKey. invalidate() must hit BOTH variants — the without-fin cache
// and the with-fin cache — so a finance admin's view refreshes after edits
// just like a non-finance admin's view.
const FINANCIAL_PATHS = new Set([
  "/api/admin/dashboard",
  "/api/admin/units",
  "/api/admin/agreements",
  "/api/admin/portfolios",
]);

function invalidate(...keys: string[]) {
  for (const key of keys) {
    queryClient.invalidateQueries({ queryKey: [key] });
    if (FINANCIAL_PATHS.has(key)) {
      queryClient.invalidateQueries({ queryKey: [`${key}?financial=1`] });
    }
  }
  // Dashboard is invalidated for every mutation since most edits
  // affect aggregates. Predicate match because the cached key
  // encodes `range` and `financial` in the URL — one query per
  // visible time-range pill — and a literal-key invalidate would
  // miss the other variants.
  queryClient.invalidateQueries({
    predicate: (q) =>
      typeof q.queryKey[0] === "string" &&
      (q.queryKey[0] as string).startsWith("/api/admin/dashboard"),
  });
}

// Partners ─────────────────────────────────────────────────────────────
export type PartnerDurationMonths = 1 | 2 | 3 | 6 | 12;
export const PARTNER_DURATION_OPTIONS: PartnerDurationMonths[] = [1, 2, 3, 6, 12];

export interface PartnerInput {
  name: string;
  type: PartnerType;
  contactName?: string;
  email?: string;
  phone?: string;
  rating?: number;
  status?: "active" | "inactive";
  durationMonths?: PartnerDurationMonths;
  location?: string;
  image?: string;
}

export function useCreatePartner() {
  return useMutation({
    mutationFn: async (input: PartnerInput) => {
      const res = await apiRequest("POST", "/api/admin/partners", input);
      return (await res.json()) as AdminPartnerRow;
    },
    onSuccess: () => invalidate("/api/admin/partners"),
  });
}

export function useUpdatePartner() {
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<PartnerInput> }) => {
      const res = await apiRequest("PATCH", `/api/admin/partners/${id}`, patch);
      return (await res.json()) as AdminPartnerRow;
    },
    onSuccess: () => invalidate("/api/admin/partners"),
  });
}

export function useRenewPartner() {
  return useMutation({
    mutationFn: async ({
      id,
      durationMonths,
    }: {
      id: string;
      durationMonths: PartnerDurationMonths;
    }) => {
      const res = await apiRequest("POST", `/api/admin/partners/${id}/renew`, { durationMonths });
      return (await res.json()) as AdminPartnerRow;
    },
    onSuccess: () => invalidate("/api/admin/partners"),
  });
}

export function useDeletePartner() {
  return useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/admin/partners/${id}`);
    },
    onSuccess: () => invalidate("/api/admin/partners"),
  });
}

// Marketplace listings ──────────────────────────────────────────────────
export type AdminMarketplaceRow = MarketplaceListing;
export type { MarketplaceListingStatus, MarketplaceListingTag } from "@shared/firestore-schema";

export function useAdminMarketplace() {
  const { firebaseUser } = useAuth();
  return useQuery<AdminMarketplaceRow[]>({
    queryKey: ["/api/admin/marketplace"],
    enabled: !!firebaseUser,
  });
}

export interface MarketplaceListingInput {
  title: string;
  location: string;
  price: number;
  roi?: number;
  beds?: number;
  baths?: number;
  sqm?: number;
  image?: string;
  tag?: MarketplaceListingTag;
  status?: MarketplaceListingStatus;
  externalUrl?: string;
}

export function useCreateMarketplaceListing() {
  return useMutation({
    mutationFn: async (input: MarketplaceListingInput) => {
      const res = await apiRequest("POST", "/api/admin/marketplace", input);
      return (await res.json()) as AdminMarketplaceRow;
    },
    onSuccess: () => {
      invalidate("/api/admin/marketplace");
      // Owner-facing feed shares the same Firestore source.
      invalidate("/api/marketplace");
    },
  });
}

export function useUpdateMarketplaceListing() {
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<MarketplaceListingInput> }) => {
      const res = await apiRequest("PATCH", `/api/admin/marketplace/${id}`, patch);
      return (await res.json()) as AdminMarketplaceRow;
    },
    onSuccess: () => {
      invalidate("/api/admin/marketplace");
      invalidate("/api/marketplace");
    },
  });
}

export function useDeleteMarketplaceListing() {
  return useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/admin/marketplace/${id}`);
    },
    onSuccess: () => {
      invalidate("/api/admin/marketplace");
      invalidate("/api/marketplace");
    },
  });
}

// Tickets ──────────────────────────────────────────────────────────────
export interface TicketUpdate {
  status?: TicketStatus;
  priority?: TicketPriority;
  category?: AdminTicketRow["category"];
}

export function useUpdateTicket() {
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: TicketUpdate }) => {
      const res = await apiRequest("PATCH", `/api/admin/tickets/${id}`, patch);
      return (await res.json()) as AdminTicketRow;
    },
    onSuccess: () => invalidate("/api/admin/tickets"),
  });
}

export interface TicketMessage {
  id: string;
  sender: "agent" | "user";
  authorId?: string;
  authorName?: string;
  text: string;
  createdAt: string;
}

export function useTicketMessages(ticketId: string | null | undefined) {
  const { firebaseUser } = useAuth();
  return useQuery<TicketMessage[]>({
    queryKey: ticketId
      ? [`/api/admin/tickets/${ticketId}/messages`]
      : ["/api/admin/tickets/_none/messages"],
    enabled: !!firebaseUser && !!ticketId,
  });
}

export function useReplyToTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ticketId, text }: { ticketId: string; text: string }) => {
      const res = await apiRequest("POST", `/api/admin/tickets/${ticketId}/messages`, { text });
      return (await res.json()) as TicketMessage;
    },
    onSuccess: (_msg, vars) => {
      qc.invalidateQueries({
        queryKey: [`/api/admin/tickets/${vars.ticketId}/messages`],
      });
      invalidate("/api/admin/tickets");
    },
  });
}

// Users ────────────────────────────────────────────────────────────────
export interface UserUpdate {
  firstName?: string;
  lastName?: string;
  phone?: string;
  address?: string;
  status?: "active" | "suspended" | "invited" | "pending";
  roles?: Role[];
  platformRole?: PlatformRoleKey | null;
}

export function useUpdateUser() {
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UserUpdate }) => {
      const res = await apiRequest("PATCH", `/api/admin/users/${id}`, patch);
      return (await res.json()) as AdminUserRow;
    },
    onSuccess: () => invalidate("/api/admin/users"),
  });
}

export interface InviteUserInput {
  email: string;
  firstName?: string;
  lastName?: string;
  roles: Role[];
  platformRole?: PlatformRoleKey;
}

export interface InviteUserResponse {
  user: AdminUserRow;
  inviteLink: string;
}

// Provisions a new Firebase Auth user + Firestore profile and returns a
// copy-able password-setup link the admin can share via their channel of
// choice. No email is sent server-side — there's no transactional provider
// integrated yet.
export function useInviteUser() {
  return useMutation({
    mutationFn: async (input: InviteUserInput) => {
      const res = await apiRequest("POST", "/api/admin/users/invite", input);
      return (await res.json()) as InviteUserResponse;
    },
    onSuccess: () => invalidate("/api/admin/users"),
  });
}

// Soft delete by default (sets status to "suspended"). Pass { hard: true } to
// attempt a permanent delete — fails with 409 if the user has linked records.
export function useDeleteUser() {
  return useMutation({
    mutationFn: async ({ id, hard }: { id: string; hard?: boolean }) => {
      const url = hard ? `/api/admin/users/${id}?hard=true` : `/api/admin/users/${id}`;
      await apiRequest("DELETE", url);
    },
    onSuccess: () => invalidate("/api/admin/users"),
  });
}

// Units ────────────────────────────────────────────────────────────────
// The backend route also forwards property-level fields (address,
// propertyValue, acquisitionPrice, image, city, country) to the parent
// property document — so this mutation accepts both flat.
export interface UnitUpdate {
  label?: string;
  rentAmount?: number;
  paymentStatus?: "paid" | "pending" | "overdue";
  nextPaymentDate?: string;
  leaseEnd?: string;
  // property-level fields:
  address?: string;
  propertyValue?: number;
  acquisitionPrice?: number;
  image?: string;
  city?: string;
  country?: string;
  postalCode?: string;
  lat?: number;
  lng?: number;
  propertyType?: "Apartment" | "House" | "Villa" | "Commercial" | "Plot";
  buildingName?: string;
  floor?: string;
  sqm?: string;
  builtYear?: string;
  energyClass?: "A+" | "A" | "B" | "C" | "D" | "E" | "F" | "G";
  parking?: number;
  elevator?: boolean;
  heating?: boolean;
  cooling?: boolean;
  solarPanels?: boolean;
  storageUnit?: boolean;
  ownershipType?: "individual" | "company";
  companyName?: string;
  titleDeedsStatus?: "issued" | "pending";
  developmentStatus?: "off_plan" | "under_construction" | "fully_developed";
  propertyUse?: "hold" | "rent" | "owner_occupied";
  acquisitionYear?: string;
  developmentYear?: string;
  rentPrice?: number;
}

export function useUpdateUnit() {
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UnitUpdate }) => {
      const res = await apiRequest("PATCH", `/api/admin/units/${id}`, patch);
      return (await res.json()) as { unit: unknown; property: unknown };
    },
    onSuccess: () => invalidate("/api/admin/units"),
  });
}

// Admin variant of property/unit creation — accepts an ownerId so we can
// register a unit on behalf of a user. Wraps both writes (Property + Unit)
// in a single endpoint so the unit list refreshes in one round-trip.
export interface CreateUnitInput {
  ownerId: string;
  address: string;
  propertyType?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  sqm?: string;
  bedrooms?: number;
  baths?: number;
  builtYear?: string;
  energyClass?: string;
  image?: string;
  propertyValue?: number;
  acquisitionPrice?: number;
  rentAmount?: number;
  label?: string;
  lat?: number;
  lng?: number;
  // Superadmin-only: bypass the owner's plan unit cap (server re-checks the
  // caller is actually a superadmin before honoring it).
  overrideCap?: boolean;
}

export function useCreateUnit() {
  return useMutation({
    mutationFn: async (input: CreateUnitInput) => {
      const res = await apiRequest("POST", "/api/admin/units", input);
      return (await res.json()) as { property: unknown; unit: unknown };
    },
    onSuccess: () => invalidate("/api/admin/units"),
  });
}

// Complimentary plan grants ─────────────────────────────────────────────
// Internal keys preserve the legacy names; UI labels them as Growth/Pro/
// Business. "business" is sales-led only — no Stripe product is required.
export type ComplimentaryPlanType = "advance" | "pro" | "business";

export interface GrantCompPlanInput {
  userId: string;
  plan: ComplimentaryPlanType;
}

export function useGrantCompPlan() {
  return useMutation({
    mutationFn: async ({ userId, plan }: GrantCompPlanInput) => {
      const res = await apiRequest("POST", `/api/admin/users/${userId}/comp-plan`, { plan });
      return await res.json();
    },
    onSuccess: () => invalidate("/api/admin/users"),
  });
}

export function useRevokeCompPlan() {
  return useMutation({
    mutationFn: async (userId: string) => {
      await apiRequest("DELETE", `/api/admin/users/${userId}/comp-plan`);
    },
    onSuccess: () => invalidate("/api/admin/users"),
  });
}
