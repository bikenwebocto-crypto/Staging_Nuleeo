// H-8 redaction test for get_property_details. The tool is reachable by any
// role with property.view, so it must REDACT financial figures from a role
// without finance.viewHistory and lease terms from a role without
// agreement.view — otherwise a legal/financial contact reconstructs here what
// list_transactions / list_agreements deny them.

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = {
  properties: new Map(),
  units: new Map(),
  tenants: new Map(),
};

beforeEach(() => {
  for (const m of Object.values(store)) m.clear();
  store.properties.set("p1", {
    id: "p1",
    ownerId: "o1",
    address: "1 Test St",
    propertyValue: 200000,
    acquisitionPrice: 150000,
  });
  store.units.set("u1", {
    id: "u1",
    propertyId: "p1",
    label: "Apt 1",
    rentAmount: 1000,
    paymentStatus: "paid",
    nextPaymentDate: "2026-07-01",
    leaseEnd: "2027-01-01",
  });
  store.tenants.set("t1", {
    id: "t1",
    ownerId: "o1",
    propertyId: "p1",
    unitId: "u1",
    status: "active",
    name: "Tess",
    email: "t@x.com",
    rentAmount: 1000,
    nextPayment: "2026-07-01",
  });
});

function snapOf(col: string, id: string) {
  const d = store[col].get(id);
  return { exists: !!d, id, data: () => d };
}
function makeRef(col: string, id: string) {
  return {
    id,
    async get() {
      return snapOf(col, id);
    },
  };
}
function makeQuery(col: string) {
  const f: Array<{ field: string; op: string; v: unknown }> = [];
  const q = {
    where(field: string, op: string, v: unknown) {
      f.push({ field, op, v });
      return q;
    },
    async get() {
      let rows = Array.from(store[col].entries()).map(([id, data]) => ({ id, data }));
      for (const { field, op, v } of f) {
        rows = rows.filter((r) =>
          op === "in" ? (v as unknown[]).includes(r.data[field]) : r.data[field] === v,
        );
      }
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows.map((r) => ({ id: r.id, data: () => r.data })),
      };
    },
  };
  return q;
}
const fakeDb = {
  collection(name: string) {
    return {
      doc: (id: string) => makeRef(name, id),
      where: (field: string, op: string, v: unknown) => makeQuery(name).where(field, op, v),
    };
  },
};
vi.mock("../firebase", () => ({ db: () => fakeDb }));

import { runAskOlioTool, type AskOlioAccess } from "./askOlioContext";

function access(over: Partial<AskOlioAccess>): AskOlioAccess {
  return {
    isSelf: false,
    property: false,
    tenant: false,
    agreement: false,
    finance: false,
    portfolio: false,
    ...over,
  };
}
async function details(a: AskOlioAccess) {
  const out = await runAskOlioTool("o1", "get_property_details", { propertyId: "p1" }, a);
  return JSON.parse(out) as Record<string, unknown> & {
    units: Array<Record<string, unknown>>;
    tenants: Array<Record<string, unknown>>;
  };
}

describe("get_property_details — H-8 per-role redaction", () => {
  it("owner/full access sees money + lease terms", async () => {
    const r = await details(
      access({ property: true, tenant: true, agreement: true, finance: true, portfolio: true }),
    );
    expect(r.monthlyRentIncome).toBe(1000);
    expect(typeof r.grossYieldPct).toBe("number");
    expect(r.units[0].rentAmount).toBe(1000);
    expect(r.units[0].leaseEnd).toBe("2027-01-01");
    expect(r.tenants[0].rentAmount).toBe(1000);
  });

  it("LEGAL (agreement but no finance) sees lease terms but NOT revenue", async () => {
    const r = await details(access({ property: true, tenant: true, agreement: true }));
    expect(r.monthlyRentIncome).toBeUndefined();
    expect(r.grossYieldPct).toBeUndefined();
    expect(r.units[0].rentAmount).toBeUndefined();
    expect(r.tenants[0].rentAmount).toBeUndefined();
    // Lease term IS allowed for a legal contact.
    expect(r.units[0].leaseEnd).toBe("2027-01-01");
  });

  it("FINANCIAL (finance but no agreement) sees revenue but NOT lease terms", async () => {
    const r = await details(access({ property: true, tenant: true, finance: true }));
    expect(r.monthlyRentIncome).toBe(1000);
    expect(r.units[0].rentAmount).toBe(1000);
    expect(r.tenants[0].rentAmount).toBe(1000);
    // Lease term is denied without agreement.view.
    expect(r.units[0].leaseEnd).toBeUndefined();
  });
});
