// Cache-behavior tests for configCache. We mock firebase so the loaders
// can run in-process; each test resets the cache via the test-only
// reset hook so cases don't bleed into each other.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the Firestore module that configCache.ts imports.
let getCallCount = 0;
let mockDocData: Record<string, unknown> | undefined = undefined;

vi.mock("../firebase", () => ({
  db: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => {
          getCallCount += 1;
          if (mockDocData === undefined) {
            return { exists: false };
          }
          return { exists: true, data: () => mockDocData };
        },
      }),
    }),
  }),
}));

const {
  loadPrivilegesConfig,
  loadSystemConfig,
  loadPlanLabels,
  loadPlatformFeesConfig,
  invalidatePrivilegesCache,
  invalidateSystemConfigCache,
  invalidatePlanLabelsCache,
  invalidatePlatformFeesCache,
  _resetAllConfigCachesForTest,
} = await import("./configCache");

beforeEach(() => {
  _resetAllConfigCachesForTest();
  getCallCount = 0;
  mockDocData = undefined;
});

describe("configCache — privileges", () => {
  it("first call hits Firestore, second call serves from cache", async () => {
    await loadPrivilegesConfig();
    await loadPrivilegesConfig();
    await loadPrivilegesConfig();
    expect(getCallCount).toBe(1);
  });

  it("invalidate forces a re-read on next call", async () => {
    await loadPrivilegesConfig();
    expect(getCallCount).toBe(1);
    invalidatePrivilegesCache();
    await loadPrivilegesConfig();
    expect(getCallCount).toBe(2);
  });

  it("returns defaults when the doc doesn't exist", async () => {
    mockDocData = undefined;
    const result = await loadPrivilegesConfig();
    expect(result.portfolio).toBeDefined();
    expect(result.platform).toBeDefined();
    expect(result.ownerPlan).toBeDefined();
  });

  it("merges stored values OVER defaults", async () => {
    mockDocData = {
      platform: { "users.manage": { admin: true, manager: false } },
    };
    const result = await loadPrivilegesConfig();
    // Stored value wins for the keys present
    expect(result.platform["users.manage"]?.admin).toBe(true);
    expect(result.platform["users.manage"]?.manager).toBe(false);
    // Defaults preserved for everything else
    expect(result.portfolio).toBeDefined();
    expect(result.ownerPlan).toBeDefined();
  });
});

describe("configCache — systemConfig", () => {
  it("caches independently from privileges", async () => {
    await loadPrivilegesConfig();
    await loadSystemConfig();
    expect(getCallCount).toBe(2); // one each
    await loadPrivilegesConfig();
    await loadSystemConfig();
    expect(getCallCount).toBe(2); // both served from cache
  });

  it("invalidating system cache doesn't invalidate privileges cache", async () => {
    await loadPrivilegesConfig();
    await loadSystemConfig();
    invalidateSystemConfigCache();
    await loadPrivilegesConfig(); // should still be cached
    await loadSystemConfig(); // should re-fetch
    expect(getCallCount).toBe(3);
  });
});

describe("configCache — planLabels", () => {
  it("caches + invalidates", async () => {
    await loadPlanLabels();
    await loadPlanLabels();
    expect(getCallCount).toBe(1);
    invalidatePlanLabelsCache();
    await loadPlanLabels();
    expect(getCallCount).toBe(2);
  });
});

describe("configCache — platformFees", () => {
  it("caches + invalidates", async () => {
    await loadPlatformFeesConfig();
    await loadPlatformFeesConfig();
    expect(getCallCount).toBe(1);
    invalidatePlatformFeesCache();
    await loadPlatformFeesConfig();
    expect(getCallCount).toBe(2);
  });
});

describe("configCache — cross-cache isolation", () => {
  it("each invalidator only clears its own cache", async () => {
    // Populate all 4 caches.
    await loadPrivilegesConfig();
    await loadSystemConfig();
    await loadPlanLabels();
    await loadPlatformFeesConfig();
    expect(getCallCount).toBe(4);

    // Invalidate only platformFees. Other three should remain cached.
    invalidatePlatformFeesCache();
    await loadPrivilegesConfig();
    await loadSystemConfig();
    await loadPlanLabels();
    expect(getCallCount).toBe(4); // no new reads
    await loadPlatformFeesConfig();
    expect(getCallCount).toBe(5); // one new read for platformFees
  });
});
