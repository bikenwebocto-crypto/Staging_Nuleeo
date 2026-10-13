import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = { id: string; data: Record<string, unknown> };
const store: Record<string, Row[]> = {};
const convoMessages: Record<string, Row[]> = {}; // conversationId -> messages

function snapDocs(rows: Row[]) {
  return {
    docs: rows.map((r) => ({
      id: r.id,
      data: () => r.data,
      ref: {
        collection: (sub: string) => ({
          get: async () => snapDocs(sub === "messages" ? (convoMessages[r.id] ?? []) : []),
        }),
      },
    })),
  };
}

function makeQuery(col: string) {
  let field = "";
  let op = "==";
  let value: unknown;
  const q = {
    where(f: string, o: string, v: unknown) {
      field = f;
      op = o;
      value = v;
      return q;
    },
    get: async () =>
      snapDocs(
        (store[col] ?? []).filter((r) =>
          op === "in" ? (value as unknown[]).includes(r.data[field]) : r.data[field] === value,
        ),
      ),
  };
  return q;
}

vi.mock("../firebase", () => ({
  db: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const row = (store[name] ?? []).find((r) => r.id === id);
          return { exists: !!row, id, data: () => row?.data };
        },
      }),
      where: (f: string, op: string, v: unknown) => makeQuery(name).where(f, op, v),
    }),
    // Collection-group reads (email recipients) resolve against the store keyed
    // by the subcollection name, e.g. store.recipients.
    collectionGroup: (name: string) => ({
      where: (f: string, op: string, v: unknown) => makeQuery(name).where(f, op, v),
    }),
  }),
}));

import { exportUserData } from "./userExport";

const ids = (arr: unknown[]) => arr.map((r) => (r as { id: string }).id).sort();

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  for (const k of Object.keys(convoMessages)) delete convoMessages[k];
});

describe("exportUserData", () => {
  it("gathers the caller's own data and never another user's", async () => {
    store.users = [{ id: "u1", data: { id: "u1", email: "u1@e.com" } }];
    store.tenants = [
      { id: "ten-1", data: { userId: "u1", unitId: "x" } }, // the user's tenancy (as tenant)
      { id: "t-owned", data: { ownerId: "u1" } },
      { id: "t-other", data: { userId: "other" } },
    ];
    // Tenant-side agreements/transactions key on the TENANCY doc id, not the uid.
    store.agreements = [
      { id: "ag-owner", data: { ownerId: "u1" } },
      { id: "ag-tenant", data: { tenantId: "ten-1" } },
      { id: "ag-other", data: { tenantId: "ten-other" } },
    ];
    store.transactions = [
      { id: "tx1", data: { ownerId: "u1", amount: 100 } },
      { id: "tx2", data: { tenantId: "ten-1", amount: 50 } },
      { id: "tx-other", data: { tenantId: "ten-other" } },
    ];
    store.conversations = [{ id: "c1", data: { ownerId: "u1", tenantUserId: "x" } }];
    convoMessages.c1 = [{ id: "m1", data: { text: "hi" } }];
    // Parity-with-delete additions: saved cards, owner properties, and the
    // per-campaign email-recipient rows.
    store.paymentMethods = [
      {
        id: "pm1",
        data: { userId: "u1", brand: "visa", last4: "4242", stripePaymentMethodId: "pm_secret" },
      },
      { id: "pm-other", data: { userId: "other", brand: "amex", last4: "0005" } },
    ];
    store.properties = [
      { id: "prop1", data: { ownerId: "u1", address: "1 Main" } },
      { id: "prop-other", data: { ownerId: "other" } },
    ];
    store.recipients = [
      { id: "r1", data: { userId: "u1", campaignId: "camp1", status: "delivered" } },
      { id: "r-other", data: { userId: "other" } },
    ];

    const out = await exportUserData("u1");

    expect(out.userId).toBe("u1");
    expect(out.profile).toMatchObject({ id: "u1", email: "u1@e.com" });
    expect(ids(out.tenanciesAsTenant)).toEqual(["ten-1"]);
    expect(ids(out.tenanciesAsOwner)).toEqual(["t-owned"]);
    expect(ids(out.agreementsAsOwner)).toEqual(["ag-owner"]);
    // Tenant-side lease resolved via the tenancy-doc-id indirection, not by uid.
    expect(ids(out.agreementsAsTenant)).toEqual(["ag-tenant"]);
    expect(ids(out.transactions)).toEqual(["tx1", "tx2"]);
    // Saved cards exported, with the internal Stripe token stripped.
    expect(ids(out.paymentMethods)).toEqual(["pm1"]);
    expect((out.paymentMethods[0] as Record<string, unknown>).last4).toBe("4242");
    expect(
      (out.paymentMethods[0] as Record<string, unknown>).stripePaymentMethodId,
    ).toBeUndefined();
    expect(ids(out.properties)).toEqual(["prop1"]);
    expect(ids(out.emailRecipients)).toEqual(["r1"]);

    const c0 = out.conversations[0] as { id: string; messages: unknown[] };
    expect(c0.id).toBe("c1");
    expect(ids(c0.messages)).toEqual(["m1"]);

    // No other user's data — nor the internal card token — leaks into the export.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("t-other");
    expect(serialized).not.toContain("ag-other");
    expect(serialized).not.toContain("tx-other");
    expect(serialized).not.toContain("pm-other");
    expect(serialized).not.toContain("prop-other");
    expect(serialized).not.toContain("r-other");
    expect(serialized).not.toContain("pm_secret");
    expect(typeof out.exportedAt).toBe("string");
  });

  it("returns a null profile + empty arrays for a user with no data", async () => {
    const out = await exportUserData("ghost");
    expect(out.profile).toBeNull();
    expect(out.tenanciesAsTenant).toEqual([]);
    expect(out.transactions).toEqual([]);
    expect(out.conversations).toEqual([]);
  });
});
