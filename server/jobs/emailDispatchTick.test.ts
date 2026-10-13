// Tests for the email-campaign dispatch worker, focused on M-22:
// re-check marketing opt-out at SEND-TIME.
//
// The audience snapshot only filters `notificationPrefs.marketingEmails ===
// false` when a campaign is queued. A user who unsubscribes AFTER queueing
// but BEFORE the dispatcher reaches their row must NOT receive the email.
// These tests drive a single campaign with one queued recipient through
// `runEmailDispatchTick` against an in-memory Firestore mock and assert:
//   - opted-out user  → NO Resend send, recipient marked "unsubscribed",
//     campaign.unsubscribedCount incremented.
//   - opted-in user   → Resend send fires, recipient marked "accepted".
//
// We mock only the leaf collaborators (Resend, mergeVars, unsubscribe URL)
// plus a hand-rolled Firestore that supports exactly the query/txn/batch
// surface `dispatchOneCampaign` touches — no real Firestore / Resend boot.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── In-memory Firestore ──────────────────────────────────────────────────────
//
// Documents live in a flat map keyed by their full path. The campaign doc is
// `emailCampaigns/{id}`; its recipients are `emailCampaigns/{id}/recipients/
// {uid}`; users are `users/{uid}`. Each "ref" closes over its path so reads
// and writes always hit the same backing record — which is what makes the
// send-time pref re-read observable: a test can mutate a user doc between
// "queue" and "dispatch" and the worker will see the new value.

type Doc = Record<string, unknown>;

interface Store {
  docs: Map<string, Doc>; // path -> data (only "existing" docs are present)
}

const store: Store = { docs: new Map() };

function setDoc(path: string, data: Doc): void {
  store.docs.set(path, { ...data });
}

// A query result snapshot over a set of doc paths.
function makeQuerySnapshot(paths: string[]) {
  const docs = paths.map((p) => makeDocSnapshot(p));
  return {
    empty: docs.length === 0,
    size: docs.length,
    docs,
  };
}

function makeDocSnapshot(path: string) {
  const data = store.docs.get(path);
  return {
    id: path.split("/").pop() as string,
    ref: makeDocRef(path),
    exists: data !== undefined,
    data: () => (data ? { ...data } : undefined),
  };
}

// A collection/query ref supporting chained where()/limit()/get() and doc().
// IMPORTANT: each where()/limit() returns a FRESH query object (mirroring the
// real Admin SDK, where queries are immutable). The collection ref (line 93 in
// the SUT) is reused for several independent queries within one dispatch, so a
// mutable-shared-filters mock would wrongly accumulate predicates across them.
function makeQuery(
  prefix: string,
  filters: Array<{ field: string; op: string; value: unknown }>,
  limitN: number,
) {
  return {
    where(field: string, op: string, value: unknown) {
      return makeQuery(prefix, [...filters, { field, op, value }], limitN);
    },
    limit(n: number) {
      return makeQuery(prefix, filters, n);
    },
    async get() {
      const matching: string[] = [];
      for (const [path, data] of store.docs.entries()) {
        // Only direct children of this collection (path = prefix/<id>).
        if (!path.startsWith(prefix + "/")) continue;
        const rest = path.slice(prefix.length + 1);
        if (rest.includes("/")) continue;
        const ok = filters.every((f) => {
          const v = data[f.field];
          if (f.op === "==") return v === f.value;
          if (f.op === "<") return typeof v === "string" && v < (f.value as string);
          if (f.op === "<=") return typeof v === "string" && v <= (f.value as string);
          return false;
        });
        if (ok) matching.push(path);
      }
      return makeQuerySnapshot(matching.slice(0, limitN));
    },
    doc(id: string) {
      return makeDocRef(`${prefix}/${id}`);
    },
  };
}

function makeCollectionRef(prefix: string) {
  return makeQuery(prefix, [], Infinity);
}

function makeDocRef(path: string) {
  return {
    path,
    get id() {
      return path.split("/").pop() as string;
    },
    async get() {
      return makeDocSnapshot(path);
    },
    async update(patch: Doc) {
      const cur = store.docs.get(path) ?? {};
      const next = { ...cur };
      for (const [k, v] of Object.entries(patch)) {
        if (v && typeof v === "object" && "__increment" in (v as Doc)) {
          next[k] = ((next[k] as number) ?? 0) + (v as { __increment: number }).__increment;
        } else if (v && typeof v === "object" && "__delete" in (v as Doc)) {
          delete next[k];
        } else {
          next[k] = v;
        }
      }
      store.docs.set(path, next);
    },
    collection(sub: string) {
      return makeCollectionRef(`${path}/${sub}`);
    },
  };
}

function makeDb() {
  return {
    collection(name: string) {
      return makeCollectionRef(name);
    },
    async getAll(...refs: Array<{ path: string }>) {
      return refs.map((r) => makeDocSnapshot(r.path));
    },
    async runTransaction<T>(
      fn: (tx: {
        get: (ref: { path: string }) => Promise<ReturnType<typeof makeDocSnapshot>>;
        update: (ref: { path: string }, patch: Doc) => void;
      }) => Promise<T>,
    ): Promise<T> {
      // Serial test execution: a non-isolated read/write txn is faithful enough.
      const tx = {
        get: async (ref: { path: string }) => makeDocSnapshot(ref.path),
        update: (ref: { path: string }, patch: Doc) => {
          const cur = store.docs.get(ref.path) ?? {};
          store.docs.set(ref.path, { ...cur, ...patch });
        },
      };
      return fn(tx);
    },
    batch() {
      const ops: Array<() => void> = [];
      return {
        update(ref: { path: string }, patch: Doc) {
          ops.push(() => {
            const cur = store.docs.get(ref.path) ?? {};
            const next = { ...cur };
            for (const [k, v] of Object.entries(patch)) {
              if (v && typeof v === "object" && "__delete" in (v as Doc)) delete next[k];
              else next[k] = v;
            }
            store.docs.set(ref.path, next);
          });
        },
        async commit() {
          ops.forEach((op) => op());
        },
      };
    },
  };
}

vi.mock("../firebase", () => ({
  db: () => makeDb(),
}));

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    increment: (n: number) => ({ __increment: n }),
    delete: () => ({ __delete: true }),
  },
}));

// Capture every Resend send so we can assert on count + recipients.
const sentEmails: Array<{ to: string; subject: string }> = [];
// Mutable Resend-quota headroom the worker reads before each batch.
const quota = { headroom: Infinity };
vi.mock("../services/resend", () => ({
  ResendError: class ResendError extends Error {},
  sendEmailViaResend: vi.fn(async (opts: { to: string; subject: string }) => {
    sentEmails.push({ to: opts.to, subject: opts.subject });
    return { id: "resend_msg_" + sentEmails.length };
  }),
  readResendUsage: vi.fn(async () => ({
    dailyUsed: 0,
    monthlyUsed: 0,
    dailyLimit: 100,
    monthlyLimit: 3000,
    headroom: quota.headroom,
  })),
}));

vi.mock("../services/mergeVars", () => ({
  renderTemplate: (tpl: string) => tpl,
  wrapInEmailShell: (opts: { subject: string; body: string }) => ({
    html: `<html>${opts.body}</html>`,
    text: opts.body,
  }),
}));

vi.mock("../services/unsubscribe", () => ({
  buildUnsubscribeUrl: (userId: string) => `https://app.example.com/u/${userId}`,
}));

vi.mock("../services/log", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

// Import AFTER mocks so the SUT binds to them.
const { runEmailDispatchTick } = await import("./emailDispatchTick");

const CAMPAIGN_ID = "camp_1";

function seedCampaignWithOneRecipient(opts: {
  userId: string;
  marketingEmails?: boolean | undefined;
}): void {
  setDoc(`emailCampaigns/${CAMPAIGN_ID}`, {
    status: "sending",
    subject: "Spring promo",
    bodyText: "Hello {{first_name}}",
    audience: "owners",
    acceptedCount: 0,
    failedCount: 0,
    unsubscribedCount: 0,
  });
  setDoc(`emailCampaigns/${CAMPAIGN_ID}/recipients/${opts.userId}`, {
    userId: opts.userId,
    email: `${opts.userId}@example.com`,
    status: "queued",
  });
  const userDoc: Doc = {
    id: opts.userId,
    email: `${opts.userId}@example.com`,
    firstName: "Pat",
    lastName: "Doe",
    roles: ["owner"],
    status: "active",
  };
  if (opts.marketingEmails !== undefined) {
    userDoc.notificationPrefs = { marketingEmails: opts.marketingEmails };
  }
  setDoc(`users/${opts.userId}`, userDoc);
}

beforeEach(() => {
  store.docs.clear();
  sentEmails.length = 0;
  quota.headroom = Infinity;
});

describe("runEmailDispatchTick — send-time marketing opt-out (M-22)", () => {
  it("does NOT send and marks the recipient unsubscribed when the user opted out after queueing", async () => {
    // User was in the snapshot (recipient is "queued") but has since flipped
    // marketingEmails:false — the classic compliance gap this fix closes.
    seedCampaignWithOneRecipient({ userId: "u_opt_out", marketingEmails: false });

    await runEmailDispatchTick();

    // No email left the building.
    expect(sentEmails).toHaveLength(0);

    // Recipient is in the terminal opt-out state.
    const recipient = store.docs.get(`emailCampaigns/${CAMPAIGN_ID}/recipients/u_opt_out`);
    expect(recipient?.status).toBe("unsubscribed");

    // Campaign tallies the suppression and does not over-count acceptances.
    const campaign = store.docs.get(`emailCampaigns/${CAMPAIGN_ID}`);
    expect(campaign?.unsubscribedCount).toBe(1);
    expect(campaign?.acceptedCount).toBe(0);
    // Queue drained + nothing sending → campaign flips to "sent".
    expect(campaign?.status).toBe("sent");
  });

  it("sends normally when the user still allows marketing email", async () => {
    seedCampaignWithOneRecipient({ userId: "u_opt_in", marketingEmails: true });

    await runEmailDispatchTick();

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe("u_opt_in@example.com");

    const recipient = store.docs.get(`emailCampaigns/${CAMPAIGN_ID}/recipients/u_opt_in`);
    expect(recipient?.status).toBe("accepted");

    const campaign = store.docs.get(`emailCampaigns/${CAMPAIGN_ID}`);
    expect(campaign?.acceptedCount).toBe(1);
    expect(campaign?.unsubscribedCount).toBe(0);
    expect(campaign?.status).toBe("sent");
  });

  it("treats a missing marketingEmails pref as opted-in (default-opt-in parity with the snapshot)", async () => {
    // No notificationPrefs at all — must still receive the email, matching
    // audiences.ts which only blocks an explicit `false`.
    seedCampaignWithOneRecipient({ userId: "u_no_pref", marketingEmails: undefined });

    await runEmailDispatchTick();

    expect(sentEmails).toHaveLength(1);
    const recipient = store.docs.get(`emailCampaigns/${CAMPAIGN_ID}/recipients/u_no_pref`);
    expect(recipient?.status).toBe("accepted");
  });
});

describe("runEmailDispatchTick — Resend quota gate (H1)", () => {
  it("does NOT send and leaves the recipient queued when quota headroom is 0", async () => {
    // The Resend daily/monthly allowance is exhausted: dispatch must stop so it
    // can't blow past the ceiling and take down transactional email too.
    quota.headroom = 0;
    seedCampaignWithOneRecipient({ userId: "u_quota", marketingEmails: true });

    await runEmailDispatchTick();

    expect(sentEmails).toHaveLength(0);
    const recipient = store.docs.get(`emailCampaigns/${CAMPAIGN_ID}/recipients/u_quota`);
    // Left for a later tick once the period rolls over / the plan limit rises.
    expect(recipient?.status).toBe("queued");
    const campaign = store.docs.get(`emailCampaigns/${CAMPAIGN_ID}`);
    // Still has work to do → must NOT be flipped to "sent".
    expect(campaign?.status).toBe("sending");
    expect(campaign?.acceptedCount).toBe(0);
  });

  it("sends up to the available headroom and leaves the rest queued", async () => {
    // Headroom of 1, two queued recipients → exactly one send this batch.
    quota.headroom = 1;
    setDoc(`emailCampaigns/${CAMPAIGN_ID}`, {
      status: "sending",
      subject: "Promo",
      bodyText: "Hi",
      audience: "owners",
      acceptedCount: 0,
      failedCount: 0,
      unsubscribedCount: 0,
    });
    for (const uid of ["u_a", "u_b"]) {
      setDoc(`emailCampaigns/${CAMPAIGN_ID}/recipients/${uid}`, {
        userId: uid,
        email: `${uid}@example.com`,
        status: "queued",
      });
      setDoc(`users/${uid}`, {
        id: uid,
        email: `${uid}@example.com`,
        roles: ["owner"],
        status: "active",
      });
    }

    await runEmailDispatchTick();

    expect(sentEmails).toHaveLength(1);
    const statuses = ["u_a", "u_b"].map(
      (uid) => store.docs.get(`emailCampaigns/${CAMPAIGN_ID}/recipients/${uid}`)?.status,
    );
    // One accepted, one still queued (capped by headroom).
    expect(statuses.filter((s) => s === "accepted")).toHaveLength(1);
    expect(statuses.filter((s) => s === "queued")).toHaveLength(1);
    expect(store.docs.get(`emailCampaigns/${CAMPAIGN_ID}`)?.status).toBe("sending");
  });
});
