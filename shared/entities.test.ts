import { describe, expect, it } from "vitest";
import { validateEntityInput } from "./entities";

const TODAY = "2026-11-12T10:00:00.000Z";
const v = (b: unknown) => validateEntityInput(b, TODAY, (s) => s.trim());

describe("validateEntityInput", () => {
  it("accepts a company with optional fields and defaults status to SETTING_UP", () => {
    expect(
      v({ entityType: "COMPANY", name: " Acme ", vatNumber: "CY123", incorporationDate: "2020-01-31" }),
    ).toEqual({
      ok: true,
      value: {
        entityType: "COMPANY",
        name: "Acme",
        vatNumber: "CY123",
        incorporationDate: "2020-01-31",
        status: "SETTING_UP",
      },
    });
  });

  it("defaults a personal entity's name and ACTIVE status", () => {
    expect(v({ entityType: "PERSONAL" })).toEqual({
      ok: true,
      value: { entityType: "PERSONAL", name: "Personal", status: "ACTIVE" },
    });
  });

  it.each([
    [{ entityType: "TRUST", name: "x" }, /entityType/],
    [{ entityType: "COMPANY", name: "  " }, /Name is required/],
    [{ entityType: "COMPANY", name: "x".repeat(81) }, /80/],
    [{ entityType: "COMPANY", name: "x", vatNumber: "1".repeat(21) }, /vatNumber/],
    [{ entityType: "COMPANY", name: "x", status: "DONE" }, /status/],
    [{ entityType: "COMPANY", name: "x", incorporationDate: "31/01/2020" }, /valid date/],
    [{ entityType: "COMPANY", name: "x", incorporationDate: "2027-01-01" }, /future/],
  ])("rejects %j", (body, msg) => {
    const r = v(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });
});
