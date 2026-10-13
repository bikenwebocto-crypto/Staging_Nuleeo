import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";

// Security-rules tests for firestore.rules. These run against the Firestore
// emulator started by `firebase emulators:exec` (see the test:rules script and
// the CI "Firestore Rules" job) — NOT the main vitest suite, which has no
// emulator. The rules are deny-by-default: every real app read/write goes
// through the Express API on the Admin SDK (which bypasses rules), so the only
// client-reachable surface is the Stripe-extension docs, the public catalog,
// a handful of config docs, and owner↔tenant conversations. These tests pin
// exactly that surface and prove the catch-all denies everything else.

const PROJECT_ID = "demo-olio-rules";
const ALICE = "alice";
const BOB = "bob";
const CAROL = "carol";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(resolve(process.cwd(), "firestore.rules"), "utf8"),
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

/** Firestore handle for a signed-in user. */
const asUser = (uid: string) => testEnv.authenticatedContext(uid).firestore();
/** Firestore handle for a signed-out visitor. */
const asAnon = () => testEnv.unauthenticatedContext().firestore();

describe("Stripe extension — customers/{uid}", () => {
  it("owner can read their own customer doc; others and anon cannot", async () => {
    await assertSucceeds(getDoc(doc(asUser(ALICE), "customers/alice")));
    await assertFails(getDoc(doc(asUser(BOB), "customers/alice")));
    await assertFails(getDoc(doc(asAnon(), "customers/alice")));
  });

  it("nobody may write the customer doc itself (extension-owned)", async () => {
    await assertFails(setDoc(doc(asUser(ALICE), "customers/alice"), { x: 1 }));
  });

  it("owner can read+write their own checkout_sessions; others cannot", async () => {
    await assertSucceeds(
      setDoc(doc(asUser(ALICE), "customers/alice/checkout_sessions/s1"), { price: "p1" }),
    );
    await assertSucceeds(getDoc(doc(asUser(ALICE), "customers/alice/checkout_sessions/s1")));
    await assertFails(
      setDoc(doc(asUser(BOB), "customers/alice/checkout_sessions/s2"), { price: "p1" }),
    );
    await assertFails(getDoc(doc(asUser(BOB), "customers/alice/checkout_sessions/s1")));
    await assertFails(getDoc(doc(asAnon(), "customers/alice/checkout_sessions/s1")));
  });

  it("owner can read their own subscriptions + payments; others cannot; neither is client-writable", async () => {
    await assertSucceeds(getDoc(doc(asUser(ALICE), "customers/alice/subscriptions/sub1")));
    await assertSucceeds(getDoc(doc(asUser(ALICE), "customers/alice/payments/pay1")));
    await assertFails(getDoc(doc(asUser(BOB), "customers/alice/subscriptions/sub1")));
    await assertFails(getDoc(doc(asUser(BOB), "customers/alice/payments/pay1")));
    await assertFails(
      setDoc(doc(asUser(ALICE), "customers/alice/subscriptions/sub1"), { status: "active" }),
    );
    await assertFails(setDoc(doc(asUser(ALICE), "customers/alice/payments/pay1"), { amount: 1 }));
  });
});

describe("Public Stripe catalog — products/{id}", () => {
  it("anyone (incl. signed-out) can read products, prices and tax_rates", async () => {
    await assertSucceeds(getDoc(doc(asAnon(), "products/prod1")));
    await assertSucceeds(getDoc(doc(asAnon(), "products/prod1/prices/price1")));
    await assertSucceeds(getDoc(doc(asAnon(), "products/prod1/tax_rates/tax1")));
  });

  it("the catalog is not client-writable", async () => {
    await assertFails(setDoc(doc(asUser(ALICE), "products/prod1"), { name: "Pro" }));
    await assertFails(setDoc(doc(asUser(ALICE), "products/prod1/prices/price1"), { unit: 100 }));
    await assertFails(setDoc(doc(asUser(ALICE), "products/prod1/tax_rates/tax1"), { pct: 19 }));
  });
});

describe("Config docs — mixed public/authed read, never client-writable", () => {
  it("public-read config docs are readable by signed-out visitors", async () => {
    for (const id of ["compliance", "social", "system", "planLabels"]) {
      await assertSucceeds(getDoc(doc(asAnon(), `config/${id}`)));
    }
  });

  it("authed-only config docs require sign-in", async () => {
    // privileges + banners: signed-in OK, anon denied.
    await assertSucceeds(getDoc(doc(asUser(ALICE), "config/privileges")));
    await assertSucceeds(getDoc(doc(asUser(ALICE), "config/banners")));
    await assertFails(getDoc(doc(asAnon(), "config/privileges")));
    await assertFails(getDoc(doc(asAnon(), "config/banners")));
  });

  it("no config doc is client-writable (writes go through the Express API)", async () => {
    for (const id of ["privileges", "compliance", "social", "banners", "system", "planLabels"]) {
      await assertFails(setDoc(doc(asUser(ALICE), `config/${id}`), { tampered: true }));
      await assertFails(setDoc(doc(asAnon(), `config/${id}`), { tampered: true }));
    }
  });

  it("an unlisted config doc falls through to the deny-all catch-all", async () => {
    await assertFails(getDoc(doc(asUser(ALICE), "config/secretFlags")));
    await assertFails(getDoc(doc(asAnon(), "config/secretFlags")));
  });
});

describe("Owner ↔ tenant conversations", () => {
  // conv1 is between owner ALICE and tenant BOB; CAROL is a third party.
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "conversations/conv1"), { ownerId: ALICE, tenantUserId: BOB });
      await setDoc(doc(db, "conversations/conv1/messages/m1"), { text: "hello", from: ALICE });
    });
  });

  it("only the two participants can read the conversation doc", async () => {
    await assertSucceeds(getDoc(doc(asUser(ALICE), "conversations/conv1")));
    await assertSucceeds(getDoc(doc(asUser(BOB), "conversations/conv1")));
    await assertFails(getDoc(doc(asUser(CAROL), "conversations/conv1")));
    await assertFails(getDoc(doc(asAnon(), "conversations/conv1")));
  });

  it("only the two participants can read messages (authorized via the parent doc)", async () => {
    await assertSucceeds(getDoc(doc(asUser(ALICE), "conversations/conv1/messages/m1")));
    await assertSucceeds(getDoc(doc(asUser(BOB), "conversations/conv1/messages/m1")));
    await assertFails(getDoc(doc(asUser(CAROL), "conversations/conv1/messages/m1")));
    await assertFails(getDoc(doc(asAnon(), "conversations/conv1/messages/m1")));
  });

  it("messages under a non-existent conversation are denied (parent get() fails closed)", async () => {
    // ghost has no parent conversation doc, so the messages rule's get() of the
    // parent returns null and the read is denied — even for an otherwise-valid user.
    await assertFails(getDoc(doc(asUser(ALICE), "conversations/ghost/messages/m1")));
  });

  it("conversations and messages are never client-writable", async () => {
    await assertFails(
      setDoc(doc(asUser(ALICE), "conversations/conv1"), { ownerId: ALICE, tenantUserId: BOB }),
    );
    await assertFails(
      setDoc(doc(asUser(ALICE), "conversations/conv1/messages/m2"), { text: "spoof" }),
    );
    // A user can't conjure a conversation that names themselves to gain access.
    await assertFails(
      setDoc(doc(asUser(CAROL), "conversations/conv2"), { ownerId: CAROL, tenantUserId: CAROL }),
    );
  });
});

describe("Deny-by-default catch-all", () => {
  it("core app collections are entirely server-only (no client read or write)", async () => {
    for (const path of ["users/alice", "properties/p1", "tenancies/t1", "agreements/a1"]) {
      await assertFails(getDoc(doc(asUser(ALICE), path)));
      await assertFails(setDoc(doc(asUser(ALICE), path), { x: 1 }));
      await assertFails(getDoc(doc(asAnon(), path)));
    }
  });
});
