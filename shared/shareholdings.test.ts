import { describe, expect, it } from "vitest";
import { buildNotifications, validateShareholders, type ShareholderContext } from "./shareholdings";
import { buildBusinessEdit } from "./businesses";
import type { Entity } from "./firestore-schema";

const ctx = (over: Partial<ShareholderContext> = {}): ShareholderContext => ({
  callerUid: "alice",
  entityId: "A",
  ownedEntities: [
    { id: "A", entityType: "COMPANY" },
    { id: "B", entityType: "COMPANY" },
    { id: "C", entityType: "COMPANY" },
    { id: "P", entityType: "PERSONAL" },
    { id: "Z", entityType: "COMPANY", archivedAt: "2026-01-01" },
  ],
  otherHoldings: [],
  ...over,
});
const v = (rows: unknown[], complete = false, c = ctx()) =>
  validateShareholders(rows, c, { complete });
const you = (percent: number, role?: string) => ({
  holderType: "PERSON",
  holderUserId: "alice",
  percent,
  role,
});

describe("validateShareholders — allocation", () => {
  it("accepts a partial allocation when not confirming", () => {
    const r = v([you(60)]);
    expect(r).toMatchObject({ ok: true, total: 60 });
  });

  it("requires exactly 100% to confirm", () => {
    expect(v([you(60)], true)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/must total 100/),
    });
    expect(
      v(
        [
          you(60),
          { holderType: "PERSON", holderName: "Maria", percent: 25 },
          { holderType: "ENTITY", holderEntityId: "B", percent: 15 },
        ],
        true,
      ),
    ).toMatchObject({ ok: true, total: 100 });
  });

  it("handles decimal totals exactly (33.33 + 33.33 + 33.34)", () => {
    expect(
      v(
        [
          you(33.33),
          { holderType: "PERSON", holderName: "X", percent: 33.33 },
          { holderType: "PERSON", holderName: "Y", percent: 33.34 },
        ],
        true,
      ),
    ).toMatchObject({ ok: true, total: 100 });
  });

  it("never allows more than 100%", () => {
    expect(v([you(70), { holderType: "PERSON", holderName: "X", percent: 40 }])).toMatchObject({
      ok: false,
    });
  });

  it.each([
    [[you(-5)], /negative/],
    [[you(101)], /exceed/],
    [[you(10.555)], /2 decimals/],
    [[{ holderType: "PERSON", holderName: "X", percent: 0 }], /director/],
    [[{ holderType: "ROBOT", percent: 5 }], /person or a company/],
    [[{ holderType: "PERSON", percent: 5 }], /name/],
  ])("rejects invalid row %j", (rows, msg) => {
    const r = v(rows);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });

  it("allows a non-shareholding director at 0%", () => {
    expect(v([you(0, "DIRECTOR")]).ok).toBe(true);
  });
});

describe("validateShareholders — duplicates & relationships", () => {
  it("rejects duplicate shareholders (same user, company, or name)", () => {
    expect(v([you(10), you(20)]).ok).toBe(false);
    expect(
      v([
        { holderType: "ENTITY", holderEntityId: "B", percent: 10 },
        { holderType: "ENTITY", holderEntityId: "B", percent: 10 },
      ]).ok,
    ).toBe(false);
    expect(
      v([
        { holderType: "PERSON", holderName: "Maria Ioannou", percent: 10 },
        { holderType: "PERSON", holderName: "maria ioannou", percent: 10 },
      ]).ok,
    ).toBe(false);
  });

  it("never trusts another user id from the client", () => {
    const r = v([{ holderType: "PERSON", holderUserId: "mallory", percent: 10 }]);
    expect(r).toMatchObject({ ok: false, error: "Unknown person" });
  });

  it("company holders must be the caller's own, active, non-personal companies other than itself", () => {
    expect(v([{ holderType: "ENTITY", holderEntityId: "A", percent: 10 }]).ok).toBe(false); // itself
    expect(v([{ holderType: "ENTITY", holderEntityId: "P", percent: 10 }]).ok).toBe(false); // personal
    expect(v([{ holderType: "ENTITY", holderEntityId: "Z", percent: 10 }]).ok).toBe(false); // archived
    expect(v([{ holderType: "ENTITY", holderEntityId: "bobs", percent: 10 }]).ok).toBe(false); // not owned
  });

  it("rejects circular ownership (direct and indirect)", () => {
    // A owns B → B cannot own A.
    const direct = ctx({
      otherHoldings: [{ entityId: "B", holderType: "ENTITY", holderEntityId: "A" }],
    });
    expect(
      v([{ holderType: "ENTITY", holderEntityId: "B", percent: 10 }], false, direct),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/circular/),
    });
    // A owns B, B owns C → C cannot own A.
    const indirect = ctx({
      otherHoldings: [
        { entityId: "B", holderType: "ENTITY", holderEntityId: "A" },
        { entityId: "C", holderType: "ENTITY", holderEntityId: "B" },
      ],
    });
    expect(
      v([{ holderType: "ENTITY", holderEntityId: "C", percent: 10 }], false, indirect).ok,
    ).toBe(false);
    // Unrelated chain is fine.
    expect(v([{ holderType: "ENTITY", holderEntityId: "C", percent: 10 }]).ok).toBe(true);
  });
});

const biz = (over: Partial<Entity> = {}): Entity => ({
  id: "A",
  ownerId: "alice",
  createdBy: "alice",
  name: "Acme",
  legalName: "Acme Ltd",
  entityType: "COMPANY",
  businessType: "LIMITED_COMPANY",
  country: "CY",
  registrationNumber: "HE1",
  sector: "Advisory",
  vatRegistered: true,
  vatNumber: "CY1",
  vatFilingPeriod: "QUARTERLY",
  financialYearEnd: "12-31",
  status: "SETTING_UP",
  source: "MANUAL",
  createdAt: "x",
  ...over,
});

describe("buildBusinessEdit", () => {
  it("re-validates merged details and clears VAT fields when deregistered", () => {
    const r = buildBusinessEdit(biz(), { vatRegistered: false }, ["vatRegistered"]);
    expect(r).toMatchObject({
      ok: true,
      remove: expect.arrayContaining(["vatNumber", "vatFilingPeriod"]),
    });
  });
  it("rejects an edit that breaks a required field", () => {
    expect(buildBusinessEdit(biz(), {}, ["legalName"])).toMatchObject({ ok: false });
  });
  it("renames via trading name", () => {
    const r = buildBusinessEdit(biz(), { tradingName: "Acme Co" }, ["tradingName"]);
    expect(r.ok && r.set.name).toBe("Acme Co");
  });
});

describe("buildNotifications", () => {
  it("flags incomplete allocation and pending banking", () => {
    const n = buildNotifications(
      biz({ bankingPreference: "PAYABL_ACCOUNT", bankingStatus: "NOT_STARTED" }),
      60,
      false,
    );
    expect(n.map((x) => x.id)).toEqual(["allocation", "banking"]);
    expect(n[0].body).toMatch(/remaining 40%/);
  });
});
