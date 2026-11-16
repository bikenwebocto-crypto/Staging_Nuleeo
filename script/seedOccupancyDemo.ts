// DEV/DEMO ONLY: seed past tenancies on one property so the Occupancy History
// section of the property Tenant tab (/properties/:id?tab=tenant) has data.
//
// Creates NEW tenant + agreement documents (one "expired" = completed lease and
// one "terminated" lease) on the given property. It never edits or overwrites
// existing tenants/agreements — the property's current tenant is untouched.
// All seeded docs carry `demoSeed: true` so they can be removed with --remove.
//
// Usage:
//   npx tsx script/seedOccupancyDemo.ts <propertyId>            # dry-run
//   npx tsx script/seedOccupancyDemo.ts <propertyId> --commit   # write
//   npx tsx script/seedOccupancyDemo.ts <propertyId> --remove   # delete demo docs
//
// Auth: same Admin SDK init as the server; GOOGLE_APPLICATION_CREDENTIALS /
// FIREBASE_PROJECT_ID must be set (loaded from .env).

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { db } from "../server/firebase";
import {
  COL,
  type Agreement,
  type Property,
  type Tenant,
  type Unit,
} from "../shared/firestore-schema";

const propertyId = process.argv[2];
const COMMIT = process.argv.includes("--commit");
const REMOVE = process.argv.includes("--remove");

interface DemoLease {
  name: string;
  email: string;
  rent: number;
  startDate: string;
  endDate: string;
  status: "expired" | "terminated";
  closedAt: string;
}

const DEMO_LEASES: DemoLease[] = [
  {
    name: "Demo – Sofia Marin",
    email: "demo.sofia.marin@example.com",
    rent: 1150,
    startDate: "2023-02-01",
    endDate: "2024-01-31",
    status: "expired",
    closedAt: "2024-01-31T00:00:00.000Z",
  },
  {
    name: "Demo – Lucas Berg",
    email: "demo.lucas.berg@example.com",
    rent: 1250,
    startDate: "2024-03-01",
    endDate: "2025-02-28",
    status: "terminated",
    closedAt: "2024-10-15T00:00:00.000Z",
  },
];

async function remove() {
  const [tSnap, aSnap] = await Promise.all([
    db().collection(COL.tenants).where("propertyId", "==", propertyId).get(),
    db().collection(COL.agreements).where("propertyId", "==", propertyId).get(),
  ]);
  const docs = [...tSnap.docs, ...aSnap.docs].filter((d) => d.get("demoSeed") === true);
  docs.forEach((d) => console.log(`  remove ${d.ref.path}`));
  if (COMMIT || REMOVE) {
    const batch = db().batch();
    docs.forEach((d) => batch.delete(d.ref));
    if (docs.length) await batch.commit();
  }
  console.log(`[seedOccupancyDemo] removed ${docs.length} demo docs`);
}

async function main() {
  if (!propertyId || propertyId.startsWith("--")) {
    throw new Error("Usage: npx tsx script/seedOccupancyDemo.ts <propertyId> [--commit|--remove]");
  }
  if (REMOVE) return remove();

  const propSnap = await db().collection(COL.properties).doc(propertyId).get();
  if (!propSnap.exists) throw new Error(`Property ${propertyId} not found`);
  const property = propSnap.data() as Property;

  // Reuse the unit + portfolio of an existing agreement on this property when
  // there is one, so the demo rows land in the same owner scope as real data.
  const existing = await db()
    .collection(COL.agreements)
    .where("propertyId", "==", propertyId)
    .limit(1)
    .get();
  const ref = existing.docs[0]?.data() as Agreement | undefined;
  let unitId = ref?.unitId;
  if (!unitId) {
    const units = await db()
      .collection(COL.units)
      .where("propertyId", "==", propertyId)
      .limit(1)
      .get();
    unitId = (units.docs[0]?.data() as Unit | undefined)?.id;
  }
  if (!unitId) throw new Error(`No unit found for property ${propertyId}`);

  const ownerId = ref?.ownerId ?? property.ownerId;
  const portfolioId =
    ref?.portfolioId ?? (property as Property & { portfolioId?: string }).portfolioId;
  if (!portfolioId) {
    throw new Error(
      "Property has no portfolioId — the owner agreements API would not return demo rows.",
    );
  }

  const now = new Date().toISOString();
  const batch = db().batch();
  for (const l of DEMO_LEASES) {
    const tenantId = randomUUID();
    const agreementId = randomUUID();
    const tenant: Tenant & { demoSeed: true } = {
      id: tenantId,
      name: l.name,
      email: l.email,
      unitId,
      propertyId,
      ownerId,
      portfolioId,
      rentAmount: l.rent,
      status: "expired",
      nextPayment: null,
      createdAt: now,
      endedAt: l.closedAt,
      demoSeed: true,
    };
    const agreement: Agreement & { demoSeed: true } = {
      id: agreementId,
      tenantId,
      unitId,
      propertyId,
      ownerId,
      portfolioId,
      agreementValue: l.rent * 12,
      monthlyRent: l.rent,
      deposit: l.rent * 2,
      startDate: l.startDate,
      endDate: l.endDate,
      status: l.status,
      createdAt: now,
      acceptedAt: `${l.startDate}T00:00:00.000Z`,
      ...(l.status === "terminated" ? { terminatedAt: l.closedAt } : { expiredAt: l.closedAt }),
      demoSeed: true,
    } as Agreement & { demoSeed: true };
    console.log(
      `  + ${l.status.padEnd(10)} ${l.name}  ${l.startDate} → ${l.closedAt.slice(0, 10)}`,
    );
    batch.set(db().collection(COL.tenants).doc(tenantId), tenant);
    batch.set(db().collection(COL.agreements).doc(agreementId), agreement);
  }
  if (COMMIT) await batch.commit();
  console.log(
    COMMIT
      ? "Done — open /properties/" + propertyId + "?tab=tenant"
      : "Dry-run only. Add --commit to write.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
