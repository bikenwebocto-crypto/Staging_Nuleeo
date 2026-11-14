// Shareholders of a business (Entity) — contract + pure validation.
//
// A Shareholding row says "HOLDER owns PERCENT of ENTITY". Holders reference
// existing records instead of duplicating them:
//   - PERSON + holderUserId  → a Nuleeo user (today: the account owner, "You")
//   - PERSON + holderName    → an outside individual with no Nuleeo account
//   - ENTITY + holderEntityId → another Entity (company) of the same owner
// Rows live in COL.shareholdings, scoped by `ownerId` (the account that owns
// the business), and are replaced as a set on save.

import type { BusinessRole } from "./businesses";
import type { Entity } from "./firestore-schema";

export type HolderType = "PERSON" | "ENTITY";

export interface Shareholding {
  id: string;
  ownerId: string; // account owner (scope); == Entity.ownerId
  entityId: string; // the business being owned
  holderType: HolderType;
  holderUserId?: string;
  holderName?: string; // outside individual (PERSON without account)
  holderEmail?: string;
  holderEntityId?: string;
  percent: number; // 0–100, max 2 decimals (0 only for a non-shareholding director)
  role?: BusinessRole; // PERSON only: director / shareholder / both
  createdAt: string;
  updatedAt: string;
}

// What the client sends when saving the shareholder table.
export interface ShareholderRowInput {
  holderType: HolderType;
  holderUserId?: string;
  holderName?: string;
  holderEmail?: string;
  holderEntityId?: string;
  percent: number;
  role?: BusinessRole;
}

export const HOLDER_NAME_MAX = 120;
export const MAX_SHAREHOLDERS = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ROLES: BusinessRole[] = ["DIRECTOR", "SHAREHOLDER", "BOTH"];

export const round2 = (n: number) => Math.round(n * 100) / 100;
export function allocationTotal(rows: { percent: number }[]): number {
  return round2(rows.reduce((s, r) => s + (Number.isFinite(r.percent) ? r.percent : 0), 0));
}

export interface ShareholderContext {
  callerUid: string;
  entityId: string; // business being edited
  // The caller's own entities (candidates for company holders).
  ownedEntities: Pick<Entity, "id" | "entityType" | "archivedAt">[];
  // All of the caller's existing ENTITY-held shareholdings (for cycle checks),
  // excluding the rows of `entityId` (those are being replaced).
  otherHoldings: Pick<Shareholding, "entityId" | "holderType" | "holderEntityId">[];
}

export type RowError = { index: number; error: string };

// Does `from` (directly or indirectly) own `target`? Edges: holder → owned.
function owns(
  from: string,
  target: string,
  edges: Map<string, string[]>,
  seen = new Set<string>(),
): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (edges.get(from) ?? []).some((next) => owns(next, target, edges, seen));
}

// Validates and normalizes the full shareholder table for one business.
// `complete` = the user is confirming allocation is final → total must be 100.
export function validateShareholders(
  raw: unknown,
  ctx: ShareholderContext,
  opts: { complete: boolean; clean?: (s: string, max: number) => string },
):
  | { ok: true; rows: ShareholderRowInput[]; total: number }
  | { ok: false; error: string; rowErrors: RowError[] } {
  const clean = opts.clean ?? ((s: string) => s);
  if (!Array.isArray(raw))
    return { ok: false, error: "shareholders must be a list", rowErrors: [] };
  if (raw.length > MAX_SHAREHOLDERS) {
    return { ok: false, error: `At most ${MAX_SHAREHOLDERS} shareholders`, rowErrors: [] };
  }
  const rowErrors: RowError[] = [];
  const rows: ShareholderRowInput[] = [];
  const seen = new Set<string>();
  const owned = new Map(ctx.ownedEntities.map((e) => [e.id, e]));

  // Ownership graph without this business's current rows.
  const edges = new Map<string, string[]>();
  for (const h of ctx.otherHoldings) {
    if (h.holderType !== "ENTITY" || !h.holderEntityId || h.entityId === ctx.entityId) continue;
    edges.set(h.holderEntityId, [...(edges.get(h.holderEntityId) ?? []), h.entityId]);
  }

  raw.forEach((r0, index) => {
    const r = (r0 ?? {}) as Record<string, unknown>;
    const fail = (error: string) => rowErrors.push({ index, error });
    const percent = typeof r.percent === "number" ? r.percent : Number.NaN;
    const role = ROLES.includes(r.role as BusinessRole) ? (r.role as BusinessRole) : undefined;

    if (!Number.isFinite(percent)) return fail("Enter a percentage");
    if (percent < 0) return fail("Percentage can't be negative");
    if (percent > 100) return fail("Percentage can't exceed 100");
    if (Math.abs(round2(percent) - percent) > 1e-9) return fail("Use at most 2 decimals");

    if (r.holderType === "ENTITY") {
      const id = typeof r.holderEntityId === "string" ? r.holderEntityId : "";
      const e = owned.get(id);
      if (!e) return fail("Choose one of your companies");
      if (e.entityType !== "COMPANY") return fail("Only companies can hold shares as an entity");
      if (id === ctx.entityId) return fail("A company can't own itself");
      if (e.archivedAt) return fail("That company is archived");
      // Adding id → entityId closes a loop if entityId already owns id.
      if (owns(ctx.entityId, id, edges)) return fail("That would create a circular ownership");
      if (percent <= 0) return fail("A company shareholder needs a percentage above 0");
      const key = `E:${id}`;
      if (seen.has(key)) return fail("This shareholder is already listed");
      seen.add(key);
      rows.push({ holderType: "ENTITY", holderEntityId: id, percent });
      return;
    }

    if (r.holderType === "PERSON") {
      const userId = typeof r.holderUserId === "string" ? r.holderUserId : "";
      // Only the caller can be referenced by account today — never an
      // arbitrary uid from the client.
      if (userId && userId !== ctx.callerUid) return fail("Unknown person");
      const name =
        typeof r.holderName === "string" ? clean(r.holderName, HOLDER_NAME_MAX + 1).trim() : "";
      const email = typeof r.holderEmail === "string" ? r.holderEmail.trim().toLowerCase() : "";
      if (!userId && !name) return fail("Enter the shareholder's name");
      if (name.length > HOLDER_NAME_MAX)
        return fail(`Name must be ${HOLDER_NAME_MAX} characters or fewer`);
      if (email && (!EMAIL_RE.test(email) || email.length > 254))
        return fail("Enter a valid email");
      if (percent === 0 && role !== "DIRECTOR") {
        return fail("Only a director can hold 0%");
      }
      const key = userId
        ? `U:${userId}`
        : email
          ? `M:${email}`
          : `N:${name.toLocaleLowerCase("en")}`;
      if (seen.has(key)) return fail("This shareholder is already listed");
      seen.add(key);
      rows.push({
        holderType: "PERSON",
        ...(userId ? { holderUserId: userId } : { holderName: name }),
        ...(email && !userId ? { holderEmail: email } : {}),
        percent,
        ...(role ? { role } : {}),
      });
      return;
    }
    fail("Choose a person or a company");
  });

  if (rowErrors.length) return { ok: false, error: rowErrors[0].error, rowErrors };
  const total = allocationTotal(rows);
  if (total > 100)
    return { ok: false, error: `Allocated ${total}% — the total can't exceed 100%`, rowErrors: [] };
  if (opts.complete && total !== 100) {
    return {
      ok: false,
      error: `Allocated ${total}% — it must total 100% to confirm`,
      rowErrors: [],
    };
  }
  return { ok: true, rows, total };
}

// ── Detail page view model ─────────────────────────────────────────────
export interface ShareholderView extends ShareholderRowInput {
  id: string;
  label: string; // display name
  isYou: boolean;
}

export interface BusinessNotification {
  id: string;
  tone: "warning" | "info";
  title: string;
  body: string;
  action: { label: string; target: "shareholders" | "edit" | "banking" };
}

export interface BusinessKpis {
  // null until the ledger exists — UI shows "—".
  revenue30d: number | null;
  expenses30d: number | null;
  profitMarginPct: number | null;
  needsAttention: number;
}

export interface InvoiceSummary {
  // null until invoicing exists — UI shows "—".
  unpaid: { amount: number; count: number } | null;
  overdue: { amount: number; count: number } | null;
  paidThisMonth: number | null;
  creationAvailable: boolean;
}

export interface BusinessDetailResponse {
  business: Entity;
  shareholders: ShareholderView[];
  allocation: { total: number; complete: boolean };
  notifications: BusinessNotification[];
  kpis: BusinessKpis;
  invoices: InvoiceSummary;
  // Companies of the owner that can be picked as company shareholders.
  companyOptions: { id: string; name: string }[];
}

export function buildNotifications(
  b: Entity,
  allocationTotalPct: number,
  complete: boolean,
): BusinessNotification[] {
  const out: BusinessNotification[] = [];
  if (!complete) {
    out.push({
      id: "allocation",
      tone: "warning",
      title: "Ownership not fully allocated",
      body:
        allocationTotalPct === 0
          ? "Add the shareholders of this business."
          : `${allocationTotalPct}% allocated. Allocate the remaining ${round2(100 - allocationTotalPct)}% and confirm.`,
      action: { label: "Manage shareholders", target: "shareholders" },
    });
  }
  if (b.vatRegistered && !b.vatNumber) {
    out.push({
      id: "vat",
      tone: "warning",
      title: "VAT number missing",
      body: "This business is VAT registered but has no VAT number.",
      action: { label: "Edit details", target: "edit" },
    });
  }
  if (!b.businessType || !b.country || typeof b.vatRegistered !== "boolean") {
    out.push({
      id: "details",
      tone: "info",
      title: "Complete business details",
      body: "Some details (type, country or VAT) are missing.",
      action: { label: "Edit details", target: "edit" },
    });
  }
  if (
    b.bankingPreference &&
    b.bankingPreference !== "NONE" &&
    (b.bankingStatus ?? "NOT_STARTED") === "NOT_STARTED"
  ) {
    out.push({
      id: "banking",
      tone: "info",
      title: "Banking not set up yet",
      body: "Your banking preference is saved. Nothing has been sent to a provider.",
      action: { label: "View banking", target: "banking" },
    });
  }
  return out;
}
