// Tests for the Resend send wrapper + the usage-counter side effect.
//
// We mock firebase-admin/firestore + the firebase module to capture
// FieldValue.increment writes without booting a real Firestore. The
// global fetch is stubbed per-test so we can drive success / failure
// paths through the Resend send.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Capture every config-doc write the wrapper triggers.
const docCalls: string[] = [];
const setCalls: Array<{ docId: string; data: Record<string, unknown> }> = [];
let setShouldRejectOnce = false;

vi.mock("../firebase", () => ({
  db: () => ({
    collection: (name: string) => ({
      doc: (id: string) => {
        docCalls.push(`${name}/${id}`);
        return {
          set: async (data: Record<string, unknown>) => {
            setCalls.push({ docId: id, data });
            if (setShouldRejectOnce) {
              setShouldRejectOnce = false;
              throw new Error("simulated firestore failure");
            }
          },
        };
      },
    }),
  }),
}));

// FieldValue.increment returns a sentinel object that the Admin SDK
// would normally turn into a server-side $inc. For unit-test purposes
// we only need it to be a recognizable, comparable value.
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    increment: (n: number) => ({ __increment: n }),
  },
}));

const RESEND_MODULE = await import("./resend");
const {
  sendEmailViaResend,
  sanitizeResendTag,
  incrementResendUsage,
  dailyQuotaKey,
  monthlyQuotaKey,
  dailyQuotaDocId,
  monthlyQuotaDocId,
  RESEND_DAILY_LIMIT,
  RESEND_MONTHLY_LIMIT,
} = RESEND_MODULE;

const ORIGINAL_FETCH = global.fetch;

// The last request body handed to fetch, parsed. Lets a test assert what we
// actually POST to Resend (e.g. that tags were sanitized before the wire).
let lastRequestBody: Record<string, unknown> | null = null;

function stubFetchOnce(response: { status: number; body: unknown }): void {
  lastRequestBody = null;
  global.fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    lastRequestBody =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    return {
      status: response.status,
      json: async () => response.body,
      text: async () =>
        typeof response.body === "string" ? response.body : JSON.stringify(response.body),
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  docCalls.length = 0;
  setCalls.length = 0;
  setShouldRejectOnce = false;
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.RESEND_FROM = "Olio <noreply@oliowallet.com>";
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("resend — quota key helpers", () => {
  it("dailyQuotaKey returns YYYY-MM-DD in UTC", () => {
    const now = new Date("2026-05-23T10:30:00Z");
    expect(dailyQuotaKey(now)).toBe("2026-05-23");
  });

  it("monthlyQuotaKey returns YYYY-MM in UTC", () => {
    const now = new Date("2026-05-23T10:30:00Z");
    expect(monthlyQuotaKey(now)).toBe("2026-05");
  });

  it("doc-id helpers prefix with emailQuota_", () => {
    expect(dailyQuotaDocId("2026-05-23")).toBe("emailQuota_2026-05-23");
    expect(monthlyQuotaDocId("2026-05")).toBe("emailQuota_2026-05");
  });

  it("limit constants match the Resend free tier", () => {
    expect(RESEND_DAILY_LIMIT).toBe(100);
    expect(RESEND_MONTHLY_LIMIT).toBe(3000);
  });
});

describe("resend — sendEmailViaResend counter side effects", () => {
  it("bumps both daily and monthly counters on a 200 send", async () => {
    stubFetchOnce({ status: 200, body: { id: "evt_test_1" } });
    const result = await sendEmailViaResend({
      to: "test@example.com",
      subject: "hello",
      html: "<p>hi</p>",
      text: "hi",
    });
    expect(result).toEqual({ id: "evt_test_1" });
    // Two writes: one daily, one monthly. We don't assert the exact
    // date key because clock movement during the test would make this
    // flaky — just that the right doc-id shape was hit.
    expect(setCalls.length).toBe(2);
    const ids = setCalls.map((c) => c.docId).sort();
    // YYYY-MM-DD has 10 chars; YYYY-MM has 7 chars; the prefix is the
    // same, so sort places monthly before daily.
    expect(ids[0]).toMatch(/^emailQuota_\d{4}-\d{2}$/);
    expect(ids[1]).toMatch(/^emailQuota_\d{4}-\d{2}-\d{2}$/);
    // Both writes used FieldValue.increment(1).
    for (const c of setCalls) {
      expect((c.data.count as { __increment: number }).__increment).toBe(1);
    }
  });

  it("still bumps counters on a 202 send (Resend's accepted code)", async () => {
    stubFetchOnce({ status: 202, body: { id: "evt_test_2" } });
    await sendEmailViaResend({
      to: "test@example.com",
      subject: "hello",
      html: "<p>hi</p>",
      text: "hi",
    });
    expect(setCalls.length).toBe(2);
  });

  it("does NOT bump counters when the Resend send fails", async () => {
    stubFetchOnce({ status: 400, body: { error: "bad request" } });
    await expect(
      sendEmailViaResend({
        to: "test@example.com",
        subject: "hello",
        html: "<p>hi</p>",
        text: "hi",
      }),
    ).rejects.toThrow();
    expect(setCalls.length).toBe(0);
  });

  it("a counter-write failure does NOT bubble up as a send failure", async () => {
    // First write throws (sync from our mock); the wrapper must
    // swallow + log so the caller still gets the {id} back.
    setShouldRejectOnce = true;
    stubFetchOnce({ status: 200, body: { id: "evt_test_3" } });
    const result = await sendEmailViaResend({
      to: "test@example.com",
      subject: "hello",
      html: "<p>hi</p>",
      text: "hi",
    });
    expect(result).toEqual({ id: "evt_test_3" });
  });
});

describe("resend — tag sanitization", () => {
  it("sanitizeResendTag replaces disallowed characters with underscores", () => {
    // The exact bug that 422'd every filter-segmented campaign.
    expect(sanitizeResendTag("filter:owners")).toBe("filter_owners");
    expect(sanitizeResendTag("audience name")).toBe("audience_name");
    expect(sanitizeResendTag("with/slash")).toBe("with_slash");
    expect(sanitizeResendTag("café ☕")).toBe("caf_");
  });

  it("sanitizeResendTag leaves already-valid tags untouched", () => {
    // Letters, numbers, underscores, dashes — including a campaign UUID.
    expect(sanitizeResendTag("campaign_id")).toBe("campaign_id");
    expect(sanitizeResendTag("password-reset")).toBe("password-reset");
    expect(sanitizeResendTag("40be2e0b-dc11-49e7-8013-d430c87f7775")).toBe(
      "40be2e0b-dc11-49e7-8013-d430c87f7775",
    );
  });

  it("sanitizeResendTag falls back to 'unknown' only for a truly empty result", () => {
    // Resend rejects an empty tag value; never emit one. A run of disallowed
    // chars collapses to a single "_" (itself allowed), so only the empty
    // string hits the fallback.
    expect(sanitizeResendTag("")).toBe("unknown");
    expect(sanitizeResendTag(":::")).toBe("_");
  });

  it("sanitizeResendTag clamps to 256 chars", () => {
    expect(sanitizeResendTag("a".repeat(500)).length).toBe(256);
  });

  it("sendEmailViaResend sanitizes tags before POSTing — no more 422 on a colon", async () => {
    stubFetchOnce({ status: 200, body: { id: "evt_tag_1" } });
    await sendEmailViaResend({
      to: "test@example.com",
      subject: "hello",
      html: "<p>hi</p>",
      text: "hi",
      tags: [
        { name: "campaign_id", value: "abc-123" },
        { name: "audience", value: "filter:owners" },
      ],
    });
    expect(lastRequestBody?.tags).toEqual([
      { name: "campaign_id", value: "abc-123" },
      { name: "audience", value: "filter_owners" },
    ]);
  });
});

describe("resend — incrementResendUsage direct call", () => {
  it("writes one daily + one monthly doc with FieldValue.increment(1)", () => {
    const now = new Date("2026-05-23T10:30:00Z");
    incrementResendUsage(now);
    // synchronous mock — no microtask wait required.
    const ids = setCalls.map((c) => c.docId).sort();
    expect(ids).toEqual(["emailQuota_2026-05", "emailQuota_2026-05-23"]);
    for (const c of setCalls) {
      expect((c.data.count as { __increment: number }).__increment).toBe(1);
    }
  });
});
