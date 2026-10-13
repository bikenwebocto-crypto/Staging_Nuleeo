// Ask Olio data layer. Two-tier design to keep per-request token spend
// proportional to the question, not to portfolio size:
//
//   1. buildAskOlioSnapshot — a SMALL always-included snapshot that
//      lists the owner, totals, and a bare id/address index of every
//      property + tenant. ~300 tokens for a typical portfolio. Enough
//      to answer "how many properties do I have", "who are my tenants",
//      "what's my monthly rent" without any further fetches.
//
//   2. askOlioTools / runAskOlioTool — OpenAI function-calling tools
//      the model invokes on demand for detail questions. Pulls only
//      the slice it needs (one property, one tenant's transactions,
//      etc.) instead of dumping everything up front.
//
// Net effect: simple questions cost one cheap completion; deep
// questions cost one fetch + one completion. Both scale linearly with
// what's asked, not with portfolio size.

import { db } from "../firebase";
import { occupiedPropertyIds } from "./occupancy";
import { getPortfolio } from "./portfolioBanking";
import {
  COL,
  type Agreement,
  type Property,
  type Tenant,
  type Transaction,
  type Unit,
  type User,
} from "../../shared/firestore-schema";

// Caps protect against pathological portfolios blowing the token
// budget even in the lightweight index. Anything past these gets a
// "(… N more)" tail so the model knows the index is truncated.
const INDEX_MAX_PROPERTIES = 80;
const INDEX_MAX_TENANTS = 120;
// Detail-fetch caps. Generous enough for realistic queries, strict
// enough that a single tool call can't dump 10k tokens of transactions.
const TX_DEFAULT_LIMIT = 20;
const TX_MAX_LIMIT = 50;

// Per-role read access for the caller against the active portfolio. AskOlio
// runs on behalf of `ownerId`, but the CALLER may be a granted contact whose
// portfolio role (legal / financial / …) restricts what they may read. The
// route resolves these from the privilege matrix (authorizePortfolioRead) and
// passes them in so the snapshot can redact and the tools can refuse — a legal
// contact must not read the money ledger, a financial contact must not read
// lease terms. Self (the owner) gets all true.
export interface AskOlioAccess {
  isSelf: boolean;
  property: boolean; // property.view
  tenant: boolean; // tenant.view
  agreement: boolean; // agreement.view
  finance: boolean; // finance.viewHistory
  portfolio: boolean; // analytics.viewPortfolio (portfolio value / occupancy)
}

// Fallback used only if a caller forgets to pass access (defensive): deny the
// sensitive surfaces. Self callers always pass an all-true object.
const NO_ACCESS: AskOlioAccess = {
  isSelf: false,
  property: false,
  tenant: false,
  agreement: false,
  finance: false,
  portfolio: false,
};

// ── Owner-scope key (Phase-4 portfolio re-key) ────────────────────────
// The owner-scoped sweeps below key SOLELY off the STABLE portfolio doc id
// (stamped on every row at creation; survives an owner transfer). An owner
// with no portfolio doc has no stamped rows by construction, so a null
// resolution short-circuits to the empty result without querying — the
// Phase-2 legacy ownerId fallback leg is gone. Doc-level ownership checks
// (x.ownerId === ownerId) stay on the maintained ownerId denorm.
async function resolveOwnerPortfolioId(ownerId: string): Promise<string | null> {
  const portfolio = await getPortfolio(ownerId);
  return portfolio?.id ?? null;
}

// ── Snapshot ──────────────────────────────────────────────────────────

export async function buildAskOlioSnapshot(
  ownerId: string,
  access: AskOlioAccess = NO_ACCESS,
): Promise<string> {
  // One pass to compute summary stats + build the bare id/address index.
  // Units must wait on properties (Unit docs lack a denormalized ownerId),
  // hence the two-phase fetch. No portfolio => no stamped rows => the
  // scoped sweeps resolve empty without querying.
  const portfolioId = await resolveOwnerPortfolioId(ownerId);
  const scoped = (col: string) =>
    portfolioId
      ? db().collection(col).where("portfolioId", "==", portfolioId).get()
      : Promise.resolve(null);
  const [userSnap, propsSnap, tenantsSnap, agreementsSnap] = await Promise.all([
    db().collection(COL.users).doc(ownerId).get(),
    scoped(COL.properties),
    scoped(COL.tenants),
    scoped(COL.agreements),
  ]);

  const owner = userSnap.exists ? (userSnap.data() as User) : null;
  const properties = propsSnap?.docs.map((d) => d.data() as Property) ?? [];
  const tenants = tenantsSnap?.docs.map((d) => d.data() as Tenant) ?? [];
  const agreements = agreementsSnap?.docs.map((d) => d.data() as Agreement) ?? [];

  const units = await fetchUnitsForProperties(properties.map((p) => p.id));

  const ownerName =
    `${owner?.firstName ?? ""} ${owner?.lastName ?? ""}`.trim() || owner?.email || "Owner";
  const ownerEmail = owner?.email ?? "";

  const portfolioValue = properties.reduce((s, p) => s + (p.propertyValue ?? 0), 0);
  // Occupancy + monthly rent derive from ACTIVE tenancies, not
  // Unit.currentTenantId (never written; owner-created properties have no Unit
  // doc, so the old unit-based calc reported €0 / 0% the moment a tenant was
  // added). Mirrors /api/owner/summary. See services/occupancy.ts.
  const activeTenancies = tenants.filter((t) => t.status === "active");
  const occupiedProps = occupiedPropertyIds(tenants);
  const monthlyRent = activeTenancies.reduce((s, t) => s + (t.rentAmount ?? 0), 0);
  const occupancy = properties.length
    ? Math.round((occupiedProps.size / properties.length) * 100)
    : 0;
  const activeTenantCount = activeTenancies.length;
  const activeAgreementCount = agreements.filter((a) => a.status === "active").length;

  const lines: string[] = [];
  lines.push("=== PORTFOLIO SNAPSHOT ===");
  lines.push(`Owner: ${ownerName}${ownerEmail ? ` (${ownerEmail})` : ""}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("Summary:");
  if (access.property) lines.push(`- Properties: ${properties.length}`);
  if (access.property) lines.push(`- Units: ${units.length}`);
  if (access.tenant) lines.push(`- Active tenants: ${activeTenantCount}`);
  if (access.agreement) lines.push(`- Active agreements: ${activeAgreementCount}`);
  // Financial / analytics lines are redacted for roles that lack the matching
  // privilege (e.g. a legal contact: no finance.viewHistory / analytics).
  if (access.portfolio) lines.push(`- Portfolio value: ${fmtMoney(portfolioValue)}`);
  if (access.finance)
    lines.push(`- Monthly rent income (active tenancies): ${fmtMoney(monthlyRent)}`);
  if (access.portfolio) lines.push(`- Occupancy: ${occupancy}%`);

  if (access.property) {
    if (properties.length === 0) {
      lines.push("");
      lines.push("Properties: none yet.");
    } else {
      lines.push("");
      lines.push(`Properties index (${properties.length}):`);
      properties.slice(0, INDEX_MAX_PROPERTIES).forEach((p) => {
        lines.push(`- [${p.id}] ${p.address}`);
      });
      if (properties.length > INDEX_MAX_PROPERTIES) {
        lines.push(
          `- (… ${properties.length - INDEX_MAX_PROPERTIES} more — use get_property_details to look any up)`,
        );
      }
    }
  }

  if (access.tenant && tenants.length > 0) {
    lines.push("");
    lines.push(`Tenants index (${tenants.length}):`);
    tenants.slice(0, INDEX_MAX_TENANTS).forEach((t) => {
      lines.push(`- [${t.id}] ${t.name} · ${t.status}`);
    });
    if (tenants.length > INDEX_MAX_TENANTS) {
      lines.push(`- (… ${tenants.length - INDEX_MAX_TENANTS} more — use get_tenant_details)`);
    }
  }

  lines.push("=== END SNAPSHOT ===");
  lines.push(
    "If the user's question needs detail not in the snapshot above (rent amounts, lease terms, transactions, property features, etc.), call the matching tool. Don't guess.",
  );
  return lines.join("\n");
}

// ── Tools ─────────────────────────────────────────────────────────────
// OpenAI tool-call definitions. Names + descriptions are what the model
// sees, so keep them concrete. Argument schemas use JSON Schema; the
// model fills them and we pass through to runAskOlioTool below.

export const askOlioTools = [
  {
    type: "function" as const,
    function: {
      name: "get_property_details",
      description:
        "Full details for one property: type, size, value, features, units in it, current tenants, and a per-property monthly rent total. Call this when the user asks about a specific property's rent, value, features, occupancy, or yields.",
      parameters: {
        type: "object",
        properties: {
          propertyId: {
            type: "string",
            description: "Property id from the snapshot index, e.g. [p_xxx]",
          },
        },
        required: ["propertyId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_tenant_details",
      description:
        "Full details for one tenant: which property/unit they occupy, rent amount, next payment date, status, plus their current agreement (lease type, term, deposit, payment day).",
      parameters: {
        type: "object",
        properties: {
          tenantId: {
            type: "string",
            description: "Tenant id from the snapshot index",
          },
        },
        required: ["tenantId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_agreements",
      description:
        "List active rental agreements with tenant name, property, monthly rent, and start/end dates. Optionally filter to one property.",
      parameters: {
        type: "object",
        properties: {
          propertyId: {
            type: "string",
            description: "Optional — restrict to one property.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_transactions",
      description:
        "Recent transactions (rent payments, expenses, etc.) ordered newest first. Use this for any question about income, expenses, payments, or financial activity.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: `Max rows to return. Default ${TX_DEFAULT_LIMIT}, capped at ${TX_MAX_LIMIT}.`,
          },
          propertyId: {
            type: "string",
            description: "Optional — restrict to one property.",
          },
          tenantId: {
            type: "string",
            description: "Optional — restrict to one tenant.",
          },
          category: {
            type: "string",
            enum: ["rent", "maintenance", "tax", "fee", "other"],
            description: "Optional — restrict to one category.",
          },
        },
      },
    },
  },
];

export type AskOlioToolName = (typeof askOlioTools)[number]["function"]["name"];

interface ToolArgs {
  propertyId?: string;
  tenantId?: string;
  limit?: number;
  category?: Transaction["category"];
}

// Each tool maps to the portfolio privilege it exposes. Enforced BEFORE the
// fetch so a granted contact can't read past their role via the model: a
// financial contact (no agreement.view) can't pull lease terms via
// list_agreements / get_tenant_details; a legal contact (no finance.viewHistory)
// can't pull the money ledger via list_transactions. The model relays the
// returned error string to the user.
const TOOL_DENIED = (priv: string) =>
  JSON.stringify({
    error: `Not permitted: your portfolio role doesn't include ${priv} for this owner.`,
  });

export async function runAskOlioTool(
  ownerId: string,
  name: string,
  args: ToolArgs,
  access: AskOlioAccess = NO_ACCESS,
): Promise<string> {
  switch (name) {
    case "get_property_details":
      if (!access.property) return TOOL_DENIED("property.view");
      return JSON.stringify(await getPropertyDetails(ownerId, args.propertyId ?? "", access));
    case "get_tenant_details":
      // Returns the tenant AND their lease terms — require both gates so a
      // financial contact (tenant.view but no agreement.view) can't read it.
      if (!access.tenant || !access.agreement) return TOOL_DENIED("tenant.view + agreement.view");
      return JSON.stringify(await getTenantDetails(ownerId, args.tenantId ?? ""));
    case "list_agreements":
      if (!access.agreement) return TOOL_DENIED("agreement.view");
      return JSON.stringify(await listAgreements(ownerId, args.propertyId));
    case "list_transactions":
      if (!access.finance) return TOOL_DENIED("finance.viewHistory");
      return JSON.stringify(
        await listTransactions(ownerId, {
          limit: args.limit,
          propertyId: args.propertyId,
          tenantId: args.tenantId,
          category: args.category,
        }),
      );
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ── Tool implementations ──────────────────────────────────────────────

async function getPropertyDetails(
  ownerId: string,
  propertyId: string,
  access: AskOlioAccess = NO_ACCESS,
): Promise<unknown> {
  if (!propertyId) return { error: "propertyId is required" };
  const propSnap = await db().collection(COL.properties).doc(propertyId).get();
  const property = propSnap.exists ? (propSnap.data() as Property) : null;
  // Owner-scoping check — the model could in theory pass any id; refuse
  // anything that doesn't belong to the active portfolio.
  if (!property || property.ownerId !== ownerId) {
    return { error: "Property not found in this portfolio" };
  }
  const units = await fetchUnitsForProperties([propertyId]);
  const tenantSnap = await db().collection(COL.tenants).where("propertyId", "==", propertyId).get();
  const tenants = tenantSnap.docs.map((d) => d.data() as Tenant);
  // Rent + per-unit occupancy from ACTIVE tenancies on this property
  // (Unit.currentTenantId is never written; owner-created props have no Unit).
  const activeTenancies = tenants.filter((t) => t.status === "active");
  const monthlyRent = activeTenancies.reduce((s, t) => s + (t.rentAmount ?? 0), 0);
  const occupiedUnitIds = new Set(activeTenancies.map((t) => t.unitId));

  // Per-role redaction (H-8): this tool is reachable by any role with
  // property.view, but the financial figures (rent income, yield, per-unit /
  // per-tenant rent + payment dates) must be withheld from a role lacking
  // finance.viewHistory, and lease-end terms from a role lacking
  // agreement.view — otherwise a legal/financial contact reconstructs here
  // exactly what list_transactions / list_agreements deny them.
  return {
    id: property.id,
    address: property.address,
    city: property.city,
    country: property.country,
    propertyType: property.propertyType,
    bedrooms: property.bedrooms,
    baths: property.baths,
    sqm: property.sqm,
    builtYear: property.builtYear,
    energyClass: property.energyClass,
    propertyValue: property.propertyValue,
    acquisitionPrice: property.acquisitionPrice,
    ...(access.finance
      ? {
          monthlyRentIncome: monthlyRent,
          grossYieldPct:
            property.propertyValue > 0
              ? Math.round(((monthlyRent * 12) / property.propertyValue) * 1000) / 10
              : null,
        }
      : {}),
    units: units.map((u) => ({
      id: u.id,
      label: u.label,
      occupied: occupiedUnitIds.has(u.id),
      ...(access.finance
        ? {
            rentAmount: u.rentAmount,
            paymentStatus: u.paymentStatus,
            nextPaymentDate: u.nextPaymentDate,
          }
        : {}),
      ...(access.agreement ? { leaseEnd: u.leaseEnd } : {}),
    })),
    tenants: (access.tenant ? tenants : []).map((t) => ({
      id: t.id,
      name: t.name,
      email: t.email,
      status: t.status,
      ...(access.finance ? { rentAmount: t.rentAmount, nextPayment: t.nextPayment } : {}),
    })),
  };
}

async function getTenantDetails(ownerId: string, tenantId: string): Promise<unknown> {
  if (!tenantId) return { error: "tenantId is required" };
  const tenantSnap = await db().collection(COL.tenants).doc(tenantId).get();
  const tenant = tenantSnap.exists ? (tenantSnap.data() as Tenant) : null;
  if (!tenant || tenant.ownerId !== ownerId) {
    return { error: "Tenant not found in this portfolio" };
  }
  const [propSnap, agreementSnap] = await Promise.all([
    db().collection(COL.properties).doc(tenant.propertyId).get(),
    db()
      .collection(COL.agreements)
      .where("tenantId", "==", tenantId)
      .where("status", "==", "active")
      .limit(1)
      .get(),
  ]);
  const property = propSnap.exists ? (propSnap.data() as Property) : null;
  const agreement = agreementSnap.docs[0]?.data() as Agreement | undefined;

  return {
    id: tenant.id,
    name: tenant.name,
    email: tenant.email,
    status: tenant.status,
    rentAmount: tenant.rentAmount,
    nextPayment: tenant.nextPayment,
    property: property ? { id: property.id, address: property.address } : null,
    agreement: agreement
      ? {
          id: agreement.id,
          leaseType: agreement.leaseType,
          // Charged rent source — never agreementValue (the lease TOTAL =
          // rent × months), which would over-report by ~rentalDurationMonths.
          monthlyRent: agreement.monthlyRent ?? tenant.rentAmount,
          deposit: agreement.deposit,
          paymentFrequency: agreement.paymentFrequency,
          paymentDayOfMonth: agreement.paymentDayOfMonth,
          startDate: agreement.startDate,
          endDate: agreement.endDate,
          noticePeriodMonths: agreement.noticePeriodMonths,
          autoRenewal: agreement.autoRenewal,
        }
      : null,
  };
}

async function listAgreements(ownerId: string, propertyId?: string): Promise<unknown> {
  const portfolioId = await resolveOwnerPortfolioId(ownerId);
  if (!portfolioId) return [];
  const snap = await db()
    .collection(COL.agreements)
    .where("portfolioId", "==", portfolioId)
    .where("status", "==", "active")
    .get();
  let agreements = snap.docs.map((d) => d.data() as Agreement);
  if (propertyId) {
    agreements = agreements.filter((a) => a.propertyId === propertyId);
  }
  // Tenant + property name lookups for human-readable output.
  const tenantIds = Array.from(new Set(agreements.map((a) => a.tenantId)));
  const propIds = Array.from(new Set(agreements.map((a) => a.propertyId)));
  // Full tenant docs (not just names) so monthlyRent can fall back to the
  // CHARGED rent (Tenant.rentAmount), never agreementValue (the lease TOTAL).
  const [tenantById, propAddresses] = await Promise.all([
    fetchDocMap<Tenant>(COL.tenants, tenantIds),
    fetchNameMap<Property>(COL.properties, propIds, (p) => p.address),
  ]);
  return agreements.map((a) => {
    const t = tenantById.get(a.tenantId);
    return {
      id: a.id,
      tenant: t?.name ?? "(unknown)",
      property: propAddresses.get(a.propertyId) ?? "(unknown)",
      leaseType: a.leaseType,
      monthlyRent: a.monthlyRent ?? t?.rentAmount ?? null,
      startDate: a.startDate,
      endDate: a.endDate,
      paymentFrequency: a.paymentFrequency,
    };
  });
}

async function listTransactions(
  ownerId: string,
  opts: {
    limit?: number;
    propertyId?: string;
    tenantId?: string;
    category?: Transaction["category"];
  },
): Promise<unknown> {
  const limit = Math.min(opts.limit ?? TX_DEFAULT_LIMIT, TX_MAX_LIMIT);
  const portfolioId = await resolveOwnerPortfolioId(ownerId);
  if (!portfolioId) return [];
  // Phase-4 key: deliberately NO orderBy — portfolioId+timestamp would
  // demand a brand-new composite index; the single equality filter rides
  // the automatic single-field index, and we sort/slice in memory.
  const snap = await db()
    .collection(COL.transactions)
    .where("portfolioId", "==", portfolioId)
    .get();
  let txs: Transaction[] = snap.docs
    .map((d) => d.data() as Transaction)
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  if (opts.propertyId) txs = txs.filter((t) => t.propertyId === opts.propertyId);
  if (opts.tenantId) txs = txs.filter((t) => t.tenantId === opts.tenantId);
  if (opts.category) txs = txs.filter((t) => t.category === opts.category);
  return txs.slice(0, limit).map((t) => ({
    id: t.id,
    date: t.timestamp,
    name: t.name,
    type: t.type,
    category: t.category,
    amount: t.amount,
    currency: t.currency,
    status: t.status,
    propertyId: t.propertyId,
    tenantId: t.tenantId,
  }));
}

// ── Helpers ───────────────────────────────────────────────────────────

async function fetchUnitsForProperties(propertyIds: string[]): Promise<Unit[]> {
  if (propertyIds.length === 0) return [];
  const units: Unit[] = [];
  // Firestore caps `in` at 30 values per query; paginate.
  for (let i = 0; i < propertyIds.length; i += 30) {
    const chunk = propertyIds.slice(i, i + 30);
    const snap = await db().collection(COL.units).where("propertyId", "in", chunk).get();
    snap.docs.forEach((d) => units.push(d.data() as Unit));
  }
  return units;
}

async function fetchDocMap<T>(collection: string, ids: string[]): Promise<Map<string, T>> {
  const map = new Map<string, T>();
  if (ids.length === 0) return map;
  const snaps = await Promise.all(ids.map((id) => db().collection(collection).doc(id).get()));
  snaps.forEach((s, i) => {
    if (s.exists) map.set(ids[i], s.data() as T);
  });
  return map;
}

async function fetchNameMap<T>(
  collection: string,
  ids: string[],
  pick: (doc: T) => string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const snaps = await Promise.all(ids.map((id) => db().collection(collection).doc(id).get()));
  snaps.forEach((s, i) => {
    if (s.exists) map.set(ids[i], pick(s.data() as T));
  });
  return map;
}

function fmtMoney(cents: number, currency = "EUR"): string {
  const symbol = currency === "EUR" ? "€" : currency === "USD" ? "$" : currency;
  const value = (cents ?? 0).toLocaleString("en-GB", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return `${symbol}${value}`;
}
