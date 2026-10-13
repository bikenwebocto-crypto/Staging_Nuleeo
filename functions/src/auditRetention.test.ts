import { describe, it, expect, beforeEach, vi } from "vitest";

// Minimal in-memory Firestore double supporting `.where("createdAt","<",cutoff)`
// + `.limit().get()` + batch delete — enough to drive the retention sweep.
type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = {
  userAudit: new Map(),
  impersonations: new Map(),
};

function makeQuery(col: string) {
  const filters: Array<{ field: string; op: string; value: unknown }> = [];
  let lim = Infinity;
  const q = {
    where(field: string, op: string, value: unknown) {
      filters.push({ field, op, value });
      return q;
    },
    limit(n: number) {
      lim = n;
      return q;
    },
    async get() {
      let rows = Array.from(store[col].entries()).map(([id, data]) => ({ id, data }));
      for (const f of filters) {
        rows = rows.filter((r) =>
          f.op === "<"
            ? (r.data[f.field] as string) < (f.value as string)
            : r.data[f.field] === f.value,
        );
      }
      rows = rows.slice(0, lim);
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows.map((r) => ({ id: r.id, ref: { __col: col, __id: r.id } })),
      };
    },
  };
  return q;
}

const fakeDb = {
  collection(name: string) {
    return { where: (f: string, o: string, v: unknown) => makeQuery(name).where(f, o, v) };
  },
  batch() {
    const ops: Array<{ __col: string; __id: string }> = [];
    return {
      delete(ref: { __col: string; __id: string }) {
        ops.push(ref);
      },
      async commit() {
        for (const ref of ops) store[ref.__col].delete(ref.__id);
      },
    };
  },
};

vi.mock("../../server/firebase", () => ({ db: () => fakeDb }));
vi.mock("../../server/services/log", () => ({ logInfo: () => {} }));

import { runAuditRetentionSweep, AUDIT_RETENTION_DAYS } from "./auditRetention";

const NOW = Date.parse("2026-06-21T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  store.userAudit.clear();
  store.impersonations.clear();
});

describe("runAuditRetentionSweep", () => {
  it("deletes entries older than the retention window, keeps recent ones", async () => {
    // Older than 12 months → purged.
    store.userAudit.set("ua-old", { createdAt: iso(NOW - (AUDIT_RETENTION_DAYS + 30) * DAY) });
    store.impersonations.set("imp-old", {
      createdAt: iso(NOW - (AUDIT_RETENTION_DAYS + 1) * DAY),
    });
    // Within the window → kept.
    store.userAudit.set("ua-new", { createdAt: iso(NOW - 10 * DAY) });
    store.impersonations.set("imp-new", { createdAt: iso(NOW - 100 * DAY) });

    const counts = await runAuditRetentionSweep(NOW);

    expect(counts).toEqual({ userAudit: 1, impersonations: 1 });
    expect(store.userAudit.has("ua-old")).toBe(false);
    expect(store.impersonations.has("imp-old")).toBe(false);
    expect(store.userAudit.has("ua-new")).toBe(true);
    expect(store.impersonations.has("imp-new")).toBe(true);
  });

  it("never deletes an entry with no createdAt (can't prove its age)", async () => {
    store.userAudit.set("ua-undated", { actorUid: "x" });
    const counts = await runAuditRetentionSweep(NOW);
    expect(counts.userAudit).toBe(0);
    expect(store.userAudit.has("ua-undated")).toBe(true);
  });

  it("no-ops on an empty collection set", async () => {
    const counts = await runAuditRetentionSweep(NOW);
    expect(counts).toEqual({ userAudit: 0, impersonations: 0 });
  });
});
