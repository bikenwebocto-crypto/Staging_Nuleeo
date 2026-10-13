// Security test for AskOlio per-role authZ (H-8). The plan gate proves a
// caller may USE AskOlio on a portfolio; it does NOT enforce the per-role
// matrix. runAskOlioTool must refuse a tool whose privilege the caller's
// portfolio role lacks — a financial contact can't pull lease terms, a legal
// contact can't pull the money ledger — BEFORE any data is fetched.
//
// The db() stub throws, so: a DENIED tool returns its denial JSON without ever
// touching the DB; an ALLOWED tool proves it passed the gate by reaching the
// throwing stub.

import { describe, it, expect, vi } from "vitest";

vi.mock("../firebase", () => ({
  db: () => {
    throw new Error("DB_SHOULD_NOT_BE_CALLED");
  },
}));

import { runAskOlioTool, type AskOlioAccess } from "./askOlioContext";

const FULL: AskOlioAccess = {
  isSelf: true,
  property: true,
  tenant: true,
  agreement: true,
  finance: true,
  portfolio: true,
};
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

describe("runAskOlioTool — per-role authZ gating (H-8)", () => {
  it("denies list_transactions without finance.viewHistory (never touches the DB)", async () => {
    const out = await runAskOlioTool("owner1", "list_transactions", {}, access({}));
    expect(JSON.parse(out).error).toMatch(/finance\.viewHistory/);
  });

  it("denies list_agreements without agreement.view (financial contact)", async () => {
    const out = await runAskOlioTool(
      "owner1",
      "list_agreements",
      {},
      access({ finance: true, tenant: true }),
    );
    expect(JSON.parse(out).error).toMatch(/agreement\.view/);
  });

  it("denies get_tenant_details when agreement.view is missing", async () => {
    const out = await runAskOlioTool(
      "owner1",
      "get_tenant_details",
      { tenantId: "t1" },
      access({ tenant: true, finance: true }),
    );
    expect(JSON.parse(out).error).toMatch(/agreement\.view/);
  });

  it("denies get_property_details without property.view", async () => {
    const out = await runAskOlioTool(
      "owner1",
      "get_property_details",
      { propertyId: "p1" },
      access({}),
    );
    expect(JSON.parse(out).error).toMatch(/property\.view/);
  });

  it("defaults to deny when no access object is passed", async () => {
    const out = await runAskOlioTool("owner1", "list_transactions", {});
    expect(JSON.parse(out).error).toMatch(/finance\.viewHistory/);
  });

  it("ALLOWS a permitted tool through to the data layer (gate passes)", async () => {
    // finance access → list_transactions proceeds past the gate and hits the
    // throwing db stub, proving it wasn't blocked.
    await expect(runAskOlioTool("owner1", "list_transactions", {}, FULL)).rejects.toThrow(
      "DB_SHOULD_NOT_BE_CALLED",
    );
  });
});
