// CSV transaction export. Gated on the portfolio-level
// `analytics.export` privilege evaluated for the caller's role in
// their own portfolio (always "owner"). Default privilege matrix
// grants owner + legal + financial roles; tenants are blocked.

import type { Express, RequestHandler } from "express";
import { db } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { csvCell } from "../services/csvSafety";
import { ensurePortfolio } from "../services/portfolioBanking";
import { prepaidRentActivityRow } from "../services/prepaidActivity";
import {
  COL,
  type Agreement,
  type PortfolioPrivilegeKey,
  type Property,
  type Tenant,
  type Transaction,
} from "../../shared/firestore-schema";

export interface AnalyticsDeps {
  requireSelfPortfolioPrivilege: (p: PortfolioPrivilegeKey) => RequestHandler;
}

export function registerAnalyticsRoutes(
  app: Express,
  { requireSelfPortfolioPrivilege }: AnalyticsDeps,
): void {
  app.get(
    "/api/owner/analytics/export",
    requireAuth,
    requireSelfPortfolioPrivilege("analytics.export"),
    async (req, res) => {
      const { uid } = req.user!;
      try {
        // Phase-2 portfolio re-key: the export keys off the caller's STABLE
        // portfolio id (self-scoped → ensurePortfolio, guaranteed non-null).
        // Deliberately NO orderBy("timestamp") — portfolioId+timestamp would
        // demand a brand-new composite index; the single equality filter
        // rides the automatic single-field index and we sort in memory (the
        // export reads the full ledger anyway).
        const portfolio = await ensurePortfolio(uid);
        // Prepaid rent (Agreement.prepaidRents) never lands in the ledger, so we
        // also pull the portfolio's agreements and synthesize a read-only income
        // row per prepaid lease — so the CSV reconciles with the on-screen
        // Insights charts (both read the same realized income).
        const [txSnap, agSnap] = await Promise.all([
          db().collection(COL.transactions).where("portfolioId", "==", portfolio.id).get(),
          db().collection(COL.agreements).where("portfolioId", "==", portfolio.id).get(),
        ]);
        const prepaidRows = agSnap.docs
          .map((d) => prepaidRentActivityRow(d.data() as Agreement))
          .filter((t): t is Transaction => t !== null);
        const transactions = [
          ...txSnap.docs.map((d) => d.data() as Transaction),
          ...prepaidRows,
        ].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

        const propertyIds = Array.from(
          new Set(transactions.map((t) => t.propertyId).filter((x): x is string => !!x)),
        );
        const tenantIds = Array.from(
          new Set(transactions.map((t) => t.tenantId).filter((x): x is string => !!x)),
        );
        // Batch via getAll instead of per-id .get() so an export from a
        // power-owner with hundreds of unique properties/tenants is one
        // round-trip per collection, not one per id.
        const propRefs = propertyIds.map((id) => db().collection(COL.properties).doc(id));
        const tenantRefs = tenantIds.map((id) => db().collection(COL.tenants).doc(id));
        const [propDocs, tenantDocs] = await Promise.all([
          propRefs.length ? db().getAll(...propRefs) : Promise.resolve([]),
          tenantRefs.length ? db().getAll(...tenantRefs) : Promise.resolve([]),
        ]);
        const addressById = new Map<string, string>();
        propDocs.forEach(
          (s) => s.exists && addressById.set(s.id, (s.data() as Property).address ?? ""),
        );
        const tenantEmailById = new Map<string, string>();
        tenantDocs.forEach(
          (s) => s.exists && tenantEmailById.set(s.id, (s.data() as Tenant).email ?? ""),
        );

        // csvCell handles RFC 4180 quoting + formula-injection
        // neutralization. Extracted to server/services/csvSafety.ts so
        // the trigger set is testable + documented in one place — see
        // csvSafety.test.ts.
        const header = [
          "Timestamp",
          "Type",
          "Category",
          "Status",
          "Amount",
          "Currency",
          "Property",
          "Tenant Email",
          "Payment Method",
          "Notes",
        ];
        const rows = transactions.map((t) =>
          [
            t.timestamp ?? "",
            t.type ?? "",
            t.category ?? "",
            t.status ?? "",
            (t.amount ?? 0).toFixed(2),
            t.currency ?? "",
            t.propertyId ? (addressById.get(t.propertyId) ?? "") : "",
            t.tenantId ? (tenantEmailById.get(t.tenantId) ?? "") : "",
            t.paymentMethod ?? "",
            t.notes ?? "",
          ].map(csvCell),
        );
        const csv = [header.map(csvCell), ...rows].map((r) => r.join(",")).join("\n") + "\n";

        const filename = `olio-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(csv);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to export analytics") });
      }
    },
  );
}
