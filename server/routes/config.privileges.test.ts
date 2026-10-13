// H5 regression: the privileges-config PUT must not persist client-supplied
// keys verbatim into the global authZ doc. sanitizeGrants drops unknown
// privilege keys and unknown role keys, and coerces every grant value to a
// strict boolean. (The endpoint itself is additionally locked to superadmin —
// see the requireRole("superadmin") gate in config.ts.)

import { describe, it, expect } from "vitest";
import { sanitizeGrants } from "./config";
import { DEFAULT_PRIVILEGES_CONFIG } from "../../shared/firestore-schema";

const platform = DEFAULT_PRIVILEGES_CONFIG.platform;

describe("sanitizeGrants (H5 — privilege-matrix write hardening)", () => {
  it("keeps known privilege keys with known role keys", () => {
    const out = sanitizeGrants({ "users.suspend": { admin: true, manager: true } }, platform);
    expect(out["users.suspend"]).toEqual({ admin: true, manager: true });
  });

  it("DROPS unknown privilege keys (no arbitrary keys in the authZ doc)", () => {
    const out = sanitizeGrants(
      { "evil.backdoor": { admin: true }, "users.suspend": { admin: true } },
      platform,
    );
    expect(out["evil.backdoor" as never]).toBeUndefined();
    expect(out["users.suspend"]).toEqual({ admin: true });
  });

  it("DROPS unknown role keys within a known privilege", () => {
    const out = sanitizeGrants({ "users.suspend": { admin: true, hacker: true } }, platform);
    expect(out["users.suspend"]).toEqual({ admin: true });
    expect((out["users.suspend"] as Record<string, boolean>).hacker).toBeUndefined();
  });

  it("coerces non-boolean grant values to strict booleans", () => {
    const out = sanitizeGrants(
      { "users.suspend": { admin: "yes", manager: 0, support: 1 } },
      platform,
    ) as Record<string, Record<string, boolean>>;
    expect(out["users.suspend"]).toEqual({
      admin: true,
      manager: false,
      support: true,
    });
  });

  it("returns {} for non-object / null / array input", () => {
    expect(sanitizeGrants(null, platform)).toEqual({});
    expect(sanitizeGrants(undefined, platform)).toEqual({});
    expect(sanitizeGrants("nope", platform)).toEqual({});
    expect(sanitizeGrants(42, platform)).toEqual({});
  });

  it("skips a privilege whose value is not an object", () => {
    const out = sanitizeGrants({ "users.suspend": "all-on" }, platform);
    expect(out["users.suspend"]).toBeUndefined();
  });

  it("works the same way for the portfolio grants shape", () => {
    const out = sanitizeGrants(
      { "agreement.view": { financial: true, bogusRole: true }, "fake.priv": {} },
      DEFAULT_PRIVILEGES_CONFIG.portfolio,
    );
    expect(out["agreement.view"]).toEqual({ financial: true });
    expect(out["fake.priv" as never]).toBeUndefined();
  });
});
