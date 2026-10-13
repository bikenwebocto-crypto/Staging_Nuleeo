import { describe, it, expect } from "vitest";
import { isChunkLoadError, decideChunkAction } from "./lazyWithReload";

describe("isChunkLoadError", () => {
  // The exact strings observed in production (Cloud Logging client.error) for a
  // stale chunk after a deploy — these MUST be treated as reloadable.
  it.each([
    "'text/html' is not a valid JavaScript MIME type.", // Safari (our prod error)
    "Failed to fetch dynamically imported module: https://app.oliowallet.com/assets/index-abc.js",
    "error loading dynamically imported module",
    "Importing a module script failed.", // Safari alt phrasing
    "ChunkLoadError: Loading chunk 5 failed.",
  ])("classifies stale-chunk error as reloadable: %s", (msg) => {
    expect(isChunkLoadError(new Error(msg))).toBe(true);
  });

  // Real app crashes that ALSO showed up in prod — these must NOT trigger a
  // reload (they'd loop or mask a real bug); they belong to the ErrorBoundary.
  it.each([
    "undefined is not an object (evaluating 't.roles.includes')",
    "undefined is not an object (evaluating 'OneSignal.ye.Qe')",
    "Cannot read properties of undefined (reading 'map')",
    "Network request failed",
    "",
  ])("does NOT classify unrelated error as reloadable: %s", (msg) => {
    expect(isChunkLoadError(new Error(msg))).toBe(false);
  });

  it("handles non-Error values without throwing", () => {
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError("failed to fetch dynamically imported module")).toBe(true);
  });
});

describe("decideChunkAction (loop-safety)", () => {
  it("rethrows a non-chunk error so it reaches the ErrorBoundary", () => {
    expect(
      decideChunkAction({ isChunk: false, reloadInFlight: false, streak: 0, lifetime: 0 }),
    ).toBe("rethrow");
  });

  it("reloads a stale chunk on first failure", () => {
    expect(
      decideChunkAction({ isChunk: true, reloadInFlight: false, streak: 0, lifetime: 0 }),
    ).toBe("reload");
  });

  it("hangs when a reload is already in flight (sibling chunk failed same frame)", () => {
    expect(decideChunkAction({ isChunk: true, reloadInFlight: true, streak: 0, lifetime: 0 })).toBe(
      "hang",
    );
  });

  it("stops reloading once the per-streak budget is exhausted (no infinite loop)", () => {
    // streak >= MAX_STREAK_RELOADS (2) => rethrow, regardless of how slow boot was
    expect(
      decideChunkAction({ isChunk: true, reloadInFlight: false, streak: 2, lifetime: 2 }),
    ).toBe("rethrow");
  });

  it("stops reloading at the lifetime backstop even if the streak was cleared", () => {
    // streak just reset to 0 by a success, but lifetime ceiling reached => rethrow
    expect(
      decideChunkAction({ isChunk: true, reloadInFlight: false, streak: 0, lifetime: 5 }),
    ).toBe("rethrow");
  });

  it("treats an unavailable store (Infinity counts) as non-reloadable", () => {
    expect(
      decideChunkAction({
        isChunk: true,
        reloadInFlight: false,
        streak: Number.POSITIVE_INFINITY,
        lifetime: Number.POSITIVE_INFINITY,
      }),
    ).toBe("rethrow");
  });
});
