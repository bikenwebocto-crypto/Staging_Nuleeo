// Print-friendly HTML briefing — owner downloads a property OR
// portfolio summary as PDF (the client opens the response in a popup,
// the embedded <script> calls window.print() on load).
//
// Two modes determined by `?propertyId=…`:
//   • no propertyId → portfolio briefing, gated on briefing.portfolio
//   • propertyId    → single-property briefing, gated on briefing.property
//
// The plan-gate is inline (not the middleware) because the privilege
// key differs per branch.

import type { Express } from "express";
import { bucket, db } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { fetchImageAsDataUrl, renderBriefingHtml } from "../services/briefing";
import { authorizePortfolioRead, resolveOwnerScope } from "../services/ownerScope";
import {
  COL,
  type Agreement,
  type DocumentRecord,
  type OwnerPlanPrivilegeKey,
  type Property,
  type Tenant,
  type Transaction,
  type User,
} from "../../shared/firestore-schema";
import { prepaidRentActivityRow } from "../services/prepaidActivity";

export interface BriefingDeps {
  hasOwnerPlanPrivilege: (uid: string, privilege: OwnerPlanPrivilegeKey) => Promise<boolean>;
}

// How long the document download links in a briefing stay valid. Short-lived
// on purpose: the PDF is a shareable artifact, so we never embed the
// document's permanent storage token — only a signed URL that expires.
const BRIEFING_DOC_LINK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function registerBriefingRoutes(
  app: Express,
  { hasOwnerPlanPrivilege }: BriefingDeps,
): void {
  app.get("/api/owner/briefing", requireAuth, async (req, res) => {
    // Resolve which portfolio this briefing is for. `?ownerId=` lets a granted
    // contact pull a portfolio they have access to (authorized inside
    // resolveOwnerScope); self is the default. Everything below — the plan
    // gate and the data queries — is scoped to this resolved owner so the
    // briefing always reflects the preselected portfolio.
    const scope = await resolveOwnerScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    // The briefing bundles revenue, tenant roster and (per-property) documents
    // — financial/portfolio-analytics-class data. Gate cross-portfolio readers
    // on analytics.viewPortfolio so a "legal" contact (agreements only) can't
    // pull the owner's financials via the PDF. Self always passes.
    const authz = await authorizePortfolioRead(req.user!.uid, scope, "analytics.viewPortfolio");
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
    // ownerId keys the plan gate + the owner's USER doc (header identity);
    // the data sweeps below key off the STABLE portfolio id (Phase-2 re-key).
    const { ownerId, portfolioId } = scope;

    const propertyId =
      typeof req.query.propertyId === "string" && req.query.propertyId.trim()
        ? req.query.propertyId.trim()
        : null;

    // Plan gate: pick which owner-plan privilege applies based on
    // whether this is a property or portfolio briefing. Inline (not
    // the middleware) because we need different keys per branch. Gated on
    // the resolved owner's plan so a granted contact inherits it.
    const privilege: OwnerPlanPrivilegeKey = propertyId
      ? "briefing.property"
      : "briefing.portfolio";
    if (!(await hasOwnerPlanPrivilege(ownerId, privilege))) {
      return res.status(402).json({ error: "Upgrade required", privilege });
    }

    try {
      const userSnap = await db().collection(COL.users).doc(ownerId).get();
      const owner = userSnap.exists ? (userSnap.data() as User) : null;

      // Phase-2 re-key: the portfolio sweeps key off the stable portfolio id.
      // A null portfolio means the resolved owner has no data by construction
      // (every create path stamps portfolioId), so the briefing renders empty
      // without querying. The transactions query deliberately drops the
      // orderBy("timestamp") — portfolioId+timestamp would demand a brand-new
      // composite index, while a single equality filter rides the automatic
      // single-field index — so we sort in memory and re-apply the 200-row cap
      // after the sort.
      let allProperties: Property[] = [];
      let allTenants: Tenant[] = [];
      let allTx: Transaction[] = [];
      if (portfolioId) {
        const [propsSnap, tenantsSnap, txSnap, agSnap] = await Promise.all([
          db().collection(COL.properties).where("portfolioId", "==", portfolioId).get(),
          db().collection(COL.tenants).where("portfolioId", "==", portfolioId).get(),
          db().collection(COL.transactions).where("portfolioId", "==", portfolioId).get(),
          db().collection(COL.agreements).where("portfolioId", "==", portfolioId).get(),
        ]);
        allProperties = propsSnap.docs.map((d) => d.data() as Property);
        allTenants = tenantsSnap.docs.map((d) => d.data() as Tenant);
        // Inject the synthetic prepaid-rent rows (Agreement.prepaidRents never
        // hits the ledger) BEFORE the sort/slice, so the briefing's income
        // figure matches Insights + the CSV export — which both already include
        // them. Without this the emailed/PDF report under-reported any prepaid
        // lease's income relative to what the owner saw on screen.
        const prepaidRows = agSnap.docs
          .map((d) => prepaidRentActivityRow(d.data() as Agreement))
          .filter((t): t is Transaction => t !== null);
        allTx = [...txSnap.docs.map((d) => d.data() as Transaction), ...prepaidRows]
          .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
          .slice(0, 200);
      }

      let property: Property | undefined;
      let properties: Property[] | undefined;
      let tenants: Tenant[];
      let transactions: Transaction[];
      // Only single-property briefings list documents (on page 2).
      let documents: DocumentRecord[] | undefined;

      if (propertyId) {
        property = allProperties.find((p) => p.id === propertyId);
        if (!property) {
          return res.status(404).json({ error: "Property not found" });
        }
        tenants = allTenants.filter((t) => t.propertyId === propertyId);
        transactions = allTx.filter((t) => t.propertyId === propertyId);

        // Two equality filters (portfolioId + propertyId) — served by the
        // automatic single-field indexes, no composite needed.
        const docsSnap = await db()
          .collection(COL.documents)
          .where("portfolioId", "==", portfolioId)
          .where("propertyId", "==", propertyId)
          .get();
        const docRecords = docsSnap.docs
          .map((d) => d.data() as DocumentRecord)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

        // Swap each document's permanent storage token for a short-lived
        // (24h) v4 signed URL before it lands in the shareable PDF. Per-doc
        // best-effort: if signing fails, blank the link so the briefing
        // still lists the document, just not as a clickable download.
        const expires = Date.now() + BRIEFING_DOC_LINK_TTL_MS;
        documents = await Promise.all(
          docRecords.map(async (d) => {
            if (!d.storagePath) return { ...d, downloadURL: "" };
            try {
              const [signed] = await bucket()
                .file(d.storagePath)
                .getSignedUrl({ version: "v4", action: "read", expires });
              return { ...d, downloadURL: signed };
            } catch {
              return { ...d, downloadURL: "" };
            }
          }),
        );
      } else {
        properties = allProperties;
        tenants = allTenants;
        transactions = allTx;
      }

      // For property briefings, inline the photo as a data URL so the
      // client-side PDF rasterizer doesn't trip on CORS. Best-effort —
      // if it fails the template falls back to the remote URL / placeholder.
      const propertyImageDataUrl = property?.image
        ? ((await fetchImageAsDataUrl(property.image)) ?? undefined)
        : undefined;

      const html = renderBriefingHtml({
        ownerName:
          `${owner?.firstName ?? ""} ${owner?.lastName ?? ""}`.trim() || owner?.email || "",
        ownerEmail: owner?.email ?? "",
        property,
        properties,
        tenants,
        transactions,
        documents,
        generatedAt: new Date().toISOString(),
        propertyImageDataUrl,
      });

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to render briefing") });
    }
  });
}
