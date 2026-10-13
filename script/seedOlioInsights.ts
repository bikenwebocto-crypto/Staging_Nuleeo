// Demo-data seeder for the owner "Olio Insights" analytics page. Writes a small
// but rich, realistic portfolio (4 properties, 3 active leases + 1 ended, ~12
// months of rent payments with varied punctuality, a prepaid advance, pending +
// overdue rent, and expenses across every category) for ONE owner so every
// Insights section lights up: projections, the property leaderboard, tenant
// payment scores, cash-flow trends, reconciliation and arrears.
//
// SAFE BY DESIGN:
//   • Every doc gets a stable `seed_…` id and `seedTag: "olio-insights-demo"`,
//     so re-running OVERWRITES (no duplicates) and cleanup is one query.
//   • No Firebase Auth accounts are created — only Firestore docs (tenant
//     userId stays null; emails use the reserved .example TLD).
//   • Dry-run by default; only `--commit` writes.
//
// Usage:
//   npx tsx script/seedOlioInsights.ts                       # dry-run (default owner)
//   npx tsx script/seedOlioInsights.ts --email=you@x.com     # dry-run for a specific owner
//   npx tsx script/seedOlioInsights.ts --commit              # write the seed data
//   npx tsx script/seedOlioInsights.ts --clean               # dry-run the cleanup
//   npx tsx script/seedOlioInsights.ts --clean --commit      # remove all seeded docs
//
// Auth: same Admin SDK init as the server (GOOGLE_APPLICATION_CREDENTIALS in .env).

import "dotenv/config";
import { db, auth } from "../server/firebase";
import {
  COL,
  type Agreement,
  type Property,
  type Tenant,
  type Transaction,
  type User,
} from "../shared/firestore-schema";
import { getPortfolio, ensurePortfolio } from "../server/services/portfolioBanking";

const COMMIT = process.argv.includes("--commit");
const CLEAN = process.argv.includes("--clean");
const EMAIL = (
  process.argv.find((a) => a.startsWith("--email="))?.split("=")[1] ??
  "livenowinternational@gmail.com"
).toLowerCase();
const SEED_TAG = "olio-insights-demo";
const CCY = "EUR";

type SeedDoc = { col: string; id: string; data: Record<string, unknown> };

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthsAgo = (k: number, day: number, hour = 12) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - k, day, hour, 0, 0);
};

async function resolveOwner(): Promise<{ uid: string; user: User | null }> {
  let uid: string | null = null;
  try {
    uid = (await auth().getUserByEmail(EMAIL)).uid;
  } catch {
    /* fall through to Firestore query */
  }
  if (!uid) {
    const snap = await db().collection(COL.users).where("email", "==", EMAIL).limit(1).get();
    if (!snap.empty) uid = snap.docs[0].id;
  }
  if (!uid) {
    console.error(`✗ No user found for email "${EMAIL}". Pass --email=<owner email>.`);
    process.exit(1);
  }
  const userSnap = await db().collection(COL.users).doc(uid).get();
  return { uid, user: userSnap.exists ? (userSnap.data() as User) : null };
}

async function clean(uid: string) {
  const cols = [COL.transactions, COL.agreements, COL.tenants, COL.properties];
  let total = 0;
  for (const col of cols) {
    const snap = await db().collection(col).where("seedTag", "==", SEED_TAG).get();
    const docs = snap.docs.filter((d) => (d.data() as { ownerId?: string }).ownerId === uid);
    total += docs.length;
    console.log(`  ${col}: ${docs.length} seeded doc(s)`);
    if (COMMIT && docs.length) {
      for (let i = 0; i < docs.length; i += 450) {
        const batch = db().batch();
        docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    }
  }
  console.log(
    COMMIT
      ? `\n✓ Deleted ${total} seeded doc(s).`
      : `\nDry-run: would delete ${total} seeded doc(s). Re-run with --commit.`,
  );
}

function buildDocs(ownerId: string, portfolioId: string): SeedDoc[] {
  const docs: SeedDoc[] = [];
  const base = { ownerId, portfolioId, seedTag: SEED_TAG };
  const push = (col: string, id: string, data: Record<string, unknown>) =>
    docs.push({ col, id, data: { ...base, id, ...data } });

  // ── Properties (3 occupied + 1 vacant commercial) ──
  const props = [
    {
      id: "seed_prop_apt1",
      address: "12 Makariou Ave, Limassol",
      city: "Limassol",
      type: "Apartment",
      value: 320000,
      acq: 250000,
      year: "2020",
      sqm: "92",
    },
    {
      id: "seed_prop_apt2",
      address: "5 Stasinou St, Nicosia",
      city: "Nicosia",
      type: "Apartment",
      value: 210000,
      acq: 175000,
      year: "2022",
      sqm: "68",
    },
    {
      id: "seed_prop_villa",
      address: "8 Coral Bay Rd, Paphos",
      city: "Paphos",
      type: "Villa",
      value: 680000,
      acq: 540000,
      year: "2019",
      sqm: "240",
    },
    {
      id: "seed_prop_comm",
      address: "44 Anexartisias St, Limassol",
      city: "Limassol",
      type: "Commercial",
      value: 450000,
      acq: 400000,
      year: "2023",
      sqm: "150",
    },
  ];
  for (const p of props) {
    push(COL.properties, p.id, {
      address: p.address,
      city: p.city,
      country: "Cyprus",
      propertyType: p.type,
      propertyUse: "rent",
      propertyValue: p.value,
      acquisitionPrice: p.acq,
      acquisitionYear: p.year,
      sqm: p.sqm,
      energyClass: "B",
      status: "active",
      createdAt: monthsAgo(13, 1).toISOString(),
    } as Partial<Property>);
  }

  // ── Active tenants + leases ──
  // [propertyId, tenantId, agrId, name, rent, deposit, payDay, startMonthsAgo, endInDays, autoRenewal]
  const leases = [
    {
      pid: "seed_prop_apt1",
      tid: "seed_tnt_eleni",
      aid: "seed_agr_eleni",
      name: "Eleni Georgiou",
      rent: 1250,
      deposit: 2500,
      payDay: 1,
      startK: 38,
      endDays: 75,
      renew: "none",
    },
    {
      pid: "seed_prop_apt2",
      tid: "seed_tnt_andreas",
      aid: "seed_agr_andreas",
      name: "Andreas Pavlou",
      rent: 980,
      deposit: 500,
      payDay: 5,
      startK: 14,
      endDays: 540,
      renew: "auto",
    },
    {
      pid: "seed_prop_villa",
      tid: "seed_tnt_maria",
      aid: "seed_agr_maria",
      name: "Maria Christou",
      rent: 2900,
      deposit: 5800,
      payDay: 10,
      startK: 28,
      endDays: 200,
      renew: "fixed",
    },
  ];
  const now = new Date();
  const emailOf = (n: string) => `${n.toLowerCase().replace(/[^a-z]/g, ".")}@olio.example`;
  for (const l of leases) {
    const startDate = ymd(monthsAgo(l.startK, l.payDay));
    const endDate = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + l.endDays));
    // Andreas is the late payer: leave THIS month unpaid → overdue. Others paid.
    const nextDue =
      l.tid === "seed_tnt_andreas" ? ymd(monthsAgo(0, l.payDay)) : ymd(monthsAgo(-1, l.payDay));
    push(COL.tenants, l.tid, {
      userId: null,
      name: l.name,
      email: emailOf(l.name),
      unitId: l.pid, // owner-created props reuse propertyId as unitId
      propertyId: l.pid,
      rentAmount: l.rent,
      status: "active",
      nextPayment: nextDue,
      createdAt: monthsAgo(l.startK, l.payDay).toISOString(),
    } as Partial<Tenant>);
    push(COL.agreements, l.aid, {
      tenantId: l.tid,
      unitId: l.pid,
      propertyId: l.pid,
      leaseType: l.pid === "seed_prop_comm" ? "Commercial Lease" : "Residential Lease",
      agreementValue: l.rent * 12,
      monthlyRent: l.rent,
      deposit: l.deposit,
      startDate,
      endDate,
      status: "active",
      paymentDayOfMonth: l.payDay,
      paymentFrequency: "monthly",
      rentalDurationMonths: 12,
      rentFreePeriodMonths: 0,
      prepaidRents: 0,
      autoRenewal: l.renew,
      nextPaymentDate: nextDue,
      createdAt: monthsAgo(l.startK, l.payDay).toISOString(),
    } as Partial<Agreement>);
  }

  // ── Ended tenancy with an unpaid closing balance (arrears incl. closed) ──
  push(COL.tenants, "seed_tnt_former", {
    userId: null,
    name: "Costas Demetriou",
    email: "costas.demetriou@olio.example",
    unitId: "seed_prop_comm",
    propertyId: "seed_prop_comm",
    rentAmount: 0,
    status: "expired",
    nextPayment: null,
    outstandingBalance: 1400,
    endedAt: monthsAgo(2, 15).toISOString(),
    createdAt: monthsAgo(20, 1).toISOString(),
  } as Partial<Tenant>);

  // ── Rent payment history (drives tenant scores + cash flow + leaderboard) ──
  const rentRow = (
    idSuffix: string,
    pid: string,
    tid: string,
    aid: string,
    amount: number,
    dueDate: Date,
    latenessDays: number,
    method: "card" | "bank_transfer",
    status: "completed" | "pending" = "completed",
  ) => {
    const paid = new Date(
      dueDate.getFullYear(),
      dueDate.getMonth(),
      dueDate.getDate() + latenessDays,
      12,
    );
    push(COL.transactions, `seed_tx_${idSuffix}`, {
      propertyId: pid,
      unitId: pid,
      tenantId: tid,
      agreementId: aid,
      name: "Rent payment",
      amount,
      currency: CCY,
      type: "income",
      category: "rent",
      status,
      timestamp: paid.toISOString(),
      rentPeriod: ymd(dueDate),
      paymentMethod: method,
      source: status === "pending" ? "manual" : method === "card" ? "rent" : "manual",
      createdAt: paid.toISOString(),
    } as Partial<Transaction>);
  };

  // Eleni — excellent payer (mostly on time), card. 12 months incl. current.
  const eleniLate = [0, 1, 0, 2, 0, 0, 1, 0, 0, 1, 0, 0];
  for (let k = 11; k >= 0; k--)
    rentRow(
      `eleni_${k}`,
      "seed_prop_apt1",
      "seed_tnt_eleni",
      "seed_agr_eleni",
      1250,
      monthsAgo(k, 1),
      eleniLate[11 - k],
      "card",
    );

  // Andreas — chronic late, offline (low confidence). 11 months; current month UNPAID (pending → overdue).
  const andreasLate = [12, 15, 9, 20, 11, 18, 14, 22, 10, 16, 13];
  for (let k = 11; k >= 1; k--)
    rentRow(
      `andreas_${k}`,
      "seed_prop_apt2",
      "seed_tnt_andreas",
      "seed_agr_andreas",
      980,
      monthsAgo(k, 5),
      andreasLate[11 - k],
      "bank_transfer",
    );
  rentRow(
    "andreas_0_pending",
    "seed_prop_apt2",
    "seed_tnt_andreas",
    "seed_agr_andreas",
    980,
    monthsAgo(0, 5),
    12,
    "bank_transfer",
    "pending",
  );

  // Maria — good payer, card; first 2 in-window months represented by a prepaid lump (no double count).
  const mariaLate = [0, 2, 1, 0, 3, 0, 1, 4, 0, 0];
  for (let k = 9; k >= 0; k--)
    rentRow(
      `maria_${k}`,
      "seed_prop_villa",
      "seed_tnt_maria",
      "seed_agr_maria",
      2900,
      monthsAgo(k, 10),
      mariaLate[9 - k],
      "card",
    );
  push(COL.transactions, "seed_tx_maria_prepaid", {
    propertyId: "seed_prop_villa",
    unitId: "seed_prop_villa",
    tenantId: "seed_tnt_maria",
    agreementId: "seed_agr_maria",
    name: "Prepaid rent (2 months)",
    amount: 5800,
    currency: CCY,
    type: "income",
    category: "rent",
    status: "completed",
    timestamp: monthsAgo(11, 10).toISOString(),
    paymentMethod: "card",
    source: "prepaid", // no rentPeriod → excluded from scoring, shown as income-mix slice
    createdAt: monthsAgo(11, 10).toISOString(),
  } as Partial<Transaction>);

  // ── Expenses across every category, spread over the year & properties ──
  const expense = (
    idSuffix: string,
    pid: string,
    name: string,
    amount: number,
    category: Transaction["category"],
    k: number,
    day: number,
  ) =>
    push(COL.transactions, `seed_tx_${idSuffix}`, {
      propertyId: pid,
      unitId: pid,
      name,
      amount,
      currency: CCY,
      type: "expense",
      category,
      status: "completed",
      timestamp: monthsAgo(k, day).toISOString(),
      paymentMethod: "bank_transfer",
      source: "manual",
      createdAt: monthsAgo(k, day).toISOString(),
    } as Partial<Transaction>);

  expense("exp_plumb", "seed_prop_apt1", "Plumbing repair", 180, "maintenance", 3, 12);
  expense("exp_boiler", "seed_prop_villa", "Boiler service", 650, "maintenance", 5, 8);
  expense("exp_paint", "seed_prop_apt2", "Repainting", 320, "maintenance", 8, 20);
  expense("exp_ac", "seed_prop_villa", "A/C maintenance", 240, "maintenance", 1, 9);
  expense("exp_tax_villa", "seed_prop_villa", "Immovable property tax", 900, "tax", 4, 15);
  expense("exp_tax_apt1", "seed_prop_apt1", "Municipal tax", 450, "tax", 4, 15);
  expense("exp_fee_mgmt", "seed_prop_comm", "Letting agent fee", 500, "fee", 2, 3);
  expense("exp_fee_plat", "seed_prop_apt2", "Management fee", 95, "fee", 1, 1);
  expense("exp_ins", "seed_prop_villa", "Building insurance", 420, "other", 6, 6);
  expense("exp_clean", "seed_prop_apt1", "Deep cleaning", 120, "other", 2, 18);

  return docs;
}

async function main() {
  console.log(
    `\n=== seedOlioInsights ${CLEAN ? "(clean)" : ""} ${COMMIT ? "[COMMIT]" : "[dry-run]"} ===`,
  );
  console.log(`Project: ${process.env.FIREBASE_PROJECT_ID} · target owner: ${EMAIL}\n`);
  const { uid, user } = await resolveOwner();
  console.log(
    `Owner: ${user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || user.email : "(no user doc)"} · uid ${uid}`,
  );

  if (CLEAN) {
    console.log("\nCleaning seeded docs:");
    await clean(uid);
    return;
  }

  let portfolio = await getPortfolio(uid);
  if (!portfolio) {
    if (COMMIT) portfolio = await ensurePortfolio(uid);
    else console.log("(no portfolio yet — one would be created on --commit)");
  }
  const portfolioId = portfolio?.id ?? "(new)";
  console.log(
    `Portfolio: ${portfolioId}${portfolio?.portfolioId ? ` (${portfolio.portfolioId})` : ""}\n`,
  );

  const docs = buildDocs(uid, portfolioId);
  const byCol = docs.reduce<Record<string, number>>(
    (m, d) => ((m[d.col] = (m[d.col] ?? 0) + 1), m),
    {},
  );

  // Preview the headline numbers the Insights page will show.
  const propVals = [320000, 210000, 680000, 450000];
  const portfolioValue = propVals.reduce((a, b) => a + b, 0);
  const equity = [250000, 175000, 540000, 400000].reduce((a, b) => a + b, 0);
  const monthlyRevenue = 1250 + 980 + 2900;
  console.log("Will write:");
  Object.entries(byCol).forEach(([c, n]) => console.log(`  ${c}: ${n}`));
  console.log("\nResulting headline numbers:");
  console.log(`  Portfolio value     €${portfolioValue.toLocaleString()}`);
  console.log(
    `  Equity invested     €${equity.toLocaleString()}  → value growth €${(portfolioValue - equity).toLocaleString()} (+${(((portfolioValue - equity) / equity) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  Contracted rent     €${monthlyRevenue.toLocaleString()}/mo  → run-rate €${(monthlyRevenue * 12).toLocaleString()}/yr`,
  );
  console.log(`  Occupancy           75% (3 of 4 let; 1 vacant commercial)`);
  console.log(
    `  Tenant scores       Eleni ~A (on-time/card) · Maria ~B (card) · Andreas D/F (chronic late, offline, 1 overdue)`,
  );
  console.log(
    `  Arrears             €1,400 closed-lease balance + 1 overdue (Andreas, this month)`,
  );

  if (!COMMIT) {
    console.log(`\nDry-run only. Re-run with --commit to write ${docs.length} docs.`);
    return;
  }
  for (let i = 0; i < docs.length; i += 450) {
    const batch = db().batch();
    docs
      .slice(i, i + 450)
      .forEach((d) => batch.set(db().collection(d.col).doc(d.id), d.data, { merge: true }));
    await batch.commit();
  }
  console.log(
    `\n✓ Wrote ${docs.length} seeded docs for ${EMAIL}. Open app.oliowallet.com/insights to see them.`,
  );
  console.log(`  To remove later: npx tsx script/seedOlioInsights.ts --clean --commit`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
