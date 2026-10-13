// Tests the orphaned-object sweep, focused on the DOCUMENT_PREFIX coverage:
// property documents (documents collection) and signed-lease PDFs
// (Agreement.signedLeaseDocument) must be treated as referenced and kept,
// while an unreferenced object older than the grace window is deleted and a
// young one is left for a later run.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const store: Record<string, Row[]> = {};
let deleted: string[] = [];
let bucketFiles: Array<{ name: string; metadata: { timeCreated: string } }> = [];

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  deleted = [];
  bucketFiles = [];
});

vi.mock("../../server/firebase", () => ({
  db: () => ({
    collection: (name: string) => ({
      async get() {
        const rows = store[name] ?? [];
        return {
          forEach(cb: (d: { data: () => Row }) => void) {
            rows.forEach((data) => cb({ data: () => data }));
          },
        };
      },
    }),
  }),
  bucket: () => ({
    async getFiles({ prefix }: { prefix: string }) {
      const files = bucketFiles
        .filter((f) => f.name.startsWith(prefix))
        .map((f) => ({
          name: f.name,
          metadata: f.metadata,
          async delete() {
            deleted.push(f.name);
          },
        }));
      return [files];
    },
  }),
}));

vi.mock("../../server/services/log", () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

const { runOrphanPhotoSweep } = await import("./orphanPhotoSweep");

const OLD = "2020-01-01T00:00:00.000Z"; // well past the 48h grace
const young = () => new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago

describe("orphan sweep — documents prefix", () => {
  it("keeps referenced documents + signed-lease PDFs, deletes only old unreferenced objects", async () => {
    // Referenced by a DocumentRecord and an Agreement's signed lease.
    store.documents = [{ storagePath: "documents/u1/p1/keep-doc.pdf" }];
    store.agreements = [
      { signedLeaseDocument: { storagePath: "documents/u1/p1/agreements/a1/lease.pdf" } },
    ];

    bucketFiles = [
      { name: "documents/u1/p1/keep-doc.pdf", metadata: { timeCreated: OLD } }, // referenced → keep
      { name: "documents/u1/p1/agreements/a1/lease.pdf", metadata: { timeCreated: OLD } }, // referenced → keep
      { name: "documents/u1/p1/orphan.pdf", metadata: { timeCreated: OLD } }, // unref + old → DELETE
      { name: "documents/u1/p1/fresh-orphan.pdf", metadata: { timeCreated: young() } }, // unref + young → keep
    ];

    await runOrphanPhotoSweep();

    expect(deleted).toEqual(["documents/u1/p1/orphan.pdf"]);
  });

  it("never deletes a referenced document even when it is old", async () => {
    store.documents = [{ storagePath: "documents/u1/p1/contract.pdf" }];
    bucketFiles = [{ name: "documents/u1/p1/contract.pdf", metadata: { timeCreated: OLD } }];

    await runOrphanPhotoSweep();

    expect(deleted).toEqual([]);
  });
});
