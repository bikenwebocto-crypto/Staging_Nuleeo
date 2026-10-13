import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory Firestore stand-in. The real Firestore runs transactions
// optimistically, so a unit test that exercises the get → set/update
// flow inside a single closure is sufficient to verify the limiter's
// semantics. True concurrency is covered by the live Firestore emulator
// in integration tests; this suite owns the deterministic logic.
type Doc = { count: number; resetAt: number } | null;
const store = new Map<string, Doc>();

vi.mock("../firebase", () => ({
  db: () => ({
    collection: (_col: string) => ({
      doc: (id: string) => {
        const ref = { _id: id } as { _id: string };
        return ref as never;
      },
    }),
    runTransaction: async (fn: (t: never) => unknown) => {
      // Buffer writes so they only apply after the closure returns —
      // mirrors the at-commit semantics of a real Firestore transaction.
      const ops: Array<() => void> = [];
      const txnLike = {
        get: async (r: { _id: string }) => {
          const data = store.get(r._id);
          return { exists: data != null, data: () => data };
        },
        set: (r: { _id: string }, v: Doc) => {
          ops.push(() => store.set(r._id, v));
        },
        update: (r: { _id: string }, v: Partial<NonNullable<Doc>>) => {
          ops.push(() => {
            const cur = store.get(r._id);
            if (cur) store.set(r._id, { ...cur, ...v });
          });
        },
      };
      const result = await fn(txnLike as never);
      for (const op of ops) op();
      return result;
    },
  }),
}));

// Import AFTER the mock is registered.
const { checkAndIncrement } = await import("./rateLimit");

beforeEach(() => {
  store.clear();
  vi.useRealTimers();
});

describe("checkAndIncrement", () => {
  it("allows the first call and decrements remaining", async () => {
    const r = await checkAndIncrement("k1", 3, 60);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
    expect(r.retryAfterSeconds).toBe(0);
  });

  it("blocks once the limit is hit and returns retryAfter seconds", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await checkAndIncrement("k2", 3, 60);
      expect(r.allowed).toBe(true);
    }
    const blocked = await checkAndIncrement("k2", 3, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("resets the window after the expiry passes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    for (let i = 0; i < 3; i++) await checkAndIncrement("k3", 3, 60);
    expect((await checkAndIncrement("k3", 3, 60)).allowed).toBe(false);

    // Advance past the 60s window.
    vi.setSystemTime(new Date("2026-01-01T00:01:30Z"));
    const after = await checkAndIncrement("k3", 3, 60);
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(2);
  });

  it("scopes counters per key", async () => {
    for (let i = 0; i < 3; i++) await checkAndIncrement("alice", 3, 60);
    // Alice is blocked, Bob is still fresh.
    expect((await checkAndIncrement("alice", 3, 60)).allowed).toBe(false);
    expect((await checkAndIncrement("bob", 3, 60)).allowed).toBe(true);
  });

  it("sanitizes keys containing slashes / dots / hashes", async () => {
    // Slashes/dots would break Firestore doc paths if not sanitized; verify
    // a request still goes through and counts correctly.
    const r = await checkAndIncrement("user/test.email@example.com#1", 2, 60);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1);
  });
});
