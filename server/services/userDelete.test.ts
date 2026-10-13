import { describe, it, expect, beforeEach, vi } from "vitest";

// Per-test fixtures. The mocked db routes queries by collection name into
// these arrays so each test can set up exactly the rows it needs.
const state: {
  properties: Array<{ ownerId: string }>;
  agreements: Array<{ ownerId?: string; tenantId?: string; status: string }>;
  tenants: Array<{ userId?: string; status: string }>;
  subscriptions: Array<{ status: string }>;
} = { properties: [], agreements: [], tenants: [], subscriptions: [] };

// Snapshot helper — mirrors the bits of QuerySnapshot we use (`.empty`).
function snap(matches: unknown[]) {
  return { empty: matches.length === 0 };
}

vi.mock("../firebase", () => ({
  db: () => ({
    collection: (name: string) => buildCollection(name),
  }),
}));

// Tiny chainable query stub: `.where(...).where(...).limit(n).get()`, plus
// the `customers/{uid}/subscriptions` subcollection path the sub-blocker uses.
function buildCollection(name: string) {
  if (name === "customers") {
    return {
      doc: (_id: string) => ({
        collection: (sub: string) => query(sub === "subscriptions" ? state.subscriptions : []),
      }),
    };
  }
  const all: any[] =
    name === "properties"
      ? state.properties
      : name === "agreements"
        ? state.agreements
        : name === "tenants"
          ? state.tenants
          : [];
  return query(all);
}

function query(rows: any[]) {
  return {
    where(field: string, op: string, value: unknown) {
      if (op === "==") return query(rows.filter((r) => r[field] === value));
      if (op === "in") return query(rows.filter((r) => (value as unknown[]).includes(r[field])));
      throw new Error(`Unsupported op ${op} in mock`);
    },
    limit(_n: number) {
      return this;
    },
    async get() {
      return snap(rows);
    },
  };
}

import { findHardDeleteBlockers, hardDeleteBlockerMessage } from "./userDelete";

beforeEach(() => {
  state.properties = [];
  state.agreements = [];
  state.tenants = [];
  state.subscriptions = [];
});

describe("findHardDeleteBlockers", () => {
  it("returns no blockers when the user owns no properties and has no active agreements", async () => {
    const out = await findHardDeleteBlockers("u1");
    expect(out).toEqual([]);
  });

  it("flags 'properties' when the user owns any property", async () => {
    state.properties = [{ ownerId: "u1" }];
    const out = await findHardDeleteBlockers("u1");
    expect(out).toEqual(["properties"]);
  });

  it("flags 'owner_agreement' when the user has an active agreement as owner", async () => {
    state.agreements = [{ ownerId: "u1", status: "active" }];
    const out = await findHardDeleteBlockers("u1");
    expect(out).toEqual(["owner_agreement"]);
  });

  it("flags 'owner_agreement' for a pending_tenant lease (in-flight, must not orphan)", async () => {
    state.agreements = [{ ownerId: "u1", status: "pending_tenant" }];
    const out = await findHardDeleteBlockers("u1");
    expect(out).toEqual(["owner_agreement"]);
  });

  it("flags 'tenant_agreement' when the user has an active tenancy (by userId)", async () => {
    state.tenants = [{ userId: "u1", status: "active" }];
    const out = await findHardDeleteBlockers("u1");
    expect(out).toEqual(["tenant_agreement"]);
  });

  it("flags 'tenant_agreement' for a pending tenancy too", async () => {
    state.tenants = [{ userId: "u1", status: "pending" }];
    const out = await findHardDeleteBlockers("u1");
    expect(out).toEqual(["tenant_agreement"]);
  });

  it("does NOT flag tenant for an expired/invited tenancy", async () => {
    state.tenants = [
      { userId: "u1", status: "expired" },
      { userId: "u1", status: "invited" },
    ];
    const out = await findHardDeleteBlockers("u1");
    expect(out).toEqual([]);
  });

  it("flags 'subscription' when the user has an active subscription", async () => {
    state.subscriptions = [{ status: "active" }];
    const out = await findHardDeleteBlockers("u1");
    expect(out).toEqual(["subscription"]);
  });

  it("treats a trialing subscription as a blocker", async () => {
    state.subscriptions = [{ status: "trialing" }];
    const out = await findHardDeleteBlockers("u1");
    expect(out).toEqual(["subscription"]);
  });

  it("ignores an expired/canceled subscription (deletion allowed after expiry)", async () => {
    state.subscriptions = [{ status: "canceled" }];
    const out = await findHardDeleteBlockers("u1");
    expect(out).toEqual([]);
  });

  it("ignores non-active agreements (draft / expired / terminated)", async () => {
    state.agreements = [
      { ownerId: "u1", status: "draft" },
      { ownerId: "u1", status: "expired" },
      { tenantId: "u1", status: "terminated" },
    ];
    const out = await findHardDeleteBlockers("u1");
    expect(out).toEqual([]);
  });

  it("ignores properties, agreements, and tenancies belonging to someone else", async () => {
    state.properties = [{ ownerId: "other" }];
    state.agreements = [{ ownerId: "other", status: "active" }];
    state.tenants = [{ userId: "other", status: "active" }];
    const out = await findHardDeleteBlockers("u1");
    expect(out).toEqual([]);
  });

  it("returns blockers in stable order: properties, subscription, owner_agreement, tenant_agreement", async () => {
    state.properties = [{ ownerId: "u1" }];
    state.subscriptions = [{ status: "active" }];
    state.agreements = [{ ownerId: "u1", status: "active" }];
    state.tenants = [{ userId: "u1", status: "active" }];
    const out = await findHardDeleteBlockers("u1");
    expect(out).toEqual(["properties", "subscription", "owner_agreement", "tenant_agreement"]);
  });
});

describe("hardDeleteBlockerMessage", () => {
  it("returns a property-specific message for 'properties'", () => {
    expect(hardDeleteBlockerMessage("properties")).toContain("properties");
  });

  it("returns a subscription-specific message mentioning expiry", () => {
    const msg = hardDeleteBlockerMessage("subscription").toLowerCase();
    expect(msg).toContain("subscription");
    expect(msg).toContain("expire");
  });

  it("returns the same agreement message for owner and tenant agreements", () => {
    const owner = hardDeleteBlockerMessage("owner_agreement");
    const tenant = hardDeleteBlockerMessage("tenant_agreement");
    expect(owner).toBe(tenant);
    expect(owner.toLowerCase()).toContain("agreement");
  });
});
