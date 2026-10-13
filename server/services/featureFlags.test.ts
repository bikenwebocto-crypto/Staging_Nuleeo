import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted state the mocked configCache + log close over.
const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  throwOnLoad: false,
  warns: [] as Array<{ event: string; fields?: unknown }>,
}));

vi.mock("./configCache", () => ({
  loadFeatureFlags: async () => {
    if (h.throwOnLoad) throw new Error("firestore unavailable");
    return { flags: h.flags };
  },
}));

vi.mock("./log", () => ({
  logWarn: (event: string, fields?: unknown) => h.warns.push({ event, fields }),
}));

import { isFeatureEnabled, requireFeature } from "./featureFlags";

beforeEach(() => {
  h.flags = {
    rentCheckout: true,
    connectOnboarding: true,
    planUpgrades: true,
    askOlio: true,
    rentIndexation: true,
  };
  h.throwOnLoad = false;
  h.warns = [];
});

describe("isFeatureEnabled", () => {
  it("is true when the flag is on", async () => {
    expect(await isFeatureEnabled("rentCheckout")).toBe(true);
  });

  it("is false only when the flag is explicitly false", async () => {
    h.flags.rentCheckout = false;
    expect(await isFeatureEnabled("rentCheckout")).toBe(false);
  });

  it("defaults to enabled when the flag key is missing", async () => {
    h.flags = {};
    expect(await isFeatureEnabled("askOlio")).toBe(true);
  });

  it("fails OPEN (enabled) if the config read throws", async () => {
    h.throwOnLoad = true;
    expect(await isFeatureEnabled("rentCheckout")).toBe(true);
  });
});

async function invokeRequireFeature(enabled: boolean) {
  h.flags.rentCheckout = enabled;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  let nexted = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await requireFeature("rentCheckout")({} as any, res as any, () => {
    nexted = true;
  });
  return { res, nexted };
}

describe("requireFeature middleware", () => {
  it("calls next() when the feature is on", async () => {
    const { res, nexted } = await invokeRequireFeature(true);
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it("503s and does NOT call next() when the feature is killed", async () => {
    const { res, nexted } = await invokeRequireFeature(false);
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: string }).error).toMatch(/unavailable/i);
    expect(h.warns.find((w) => w.event === "feature.disabled-request-blocked")).toBeTruthy();
  });
});
