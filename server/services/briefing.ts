// HTML renderer for the owner portfolio/property briefing. Returns a
// self-contained print-friendly HTML document — no external CSS, no JS
// beyond an auto-trigger of `window.print()` so the user lands directly
// in the browser's print dialog (and can Save as PDF from there).
//
// Why HTML and not server-rendered PDF: puppeteer in Firebase Functions is
// heavy (Chrome binary in the deploy bundle, slow cold starts). The browser
// already knows how to render HTML to PDF; we just hand it the HTML.

import type { DocumentRecord, Property, Tenant, Transaction } from "../../shared/firestore-schema";
import { isRealizedRent, netRealizedRentAmount } from "../../shared/realizedRent";
import { readBodyCapped } from "./fetchCapped";

export interface BriefingInput {
  ownerName: string;
  ownerEmail: string;
  // When set, we render a single-property briefing. Otherwise the briefing
  // covers the whole portfolio.
  property?: Property;
  properties?: Property[];
  tenants: Tenant[];
  transactions: Transaction[];
  // Property documents (lease PDFs, inspections, tax forms…). Only populated
  // for single-property briefings; listed on the briefing's second page.
  documents?: DocumentRecord[];
  generatedAt: string;
  // Optional inlined property photo (data URL). Inlining sidesteps CORS
  // when the client rasterizes the HTML to PDF via html2canvas — the
  // canvas would otherwise taint and refuse to export.
  propertyImageDataUrl?: string;
}

// Fetches a remote image and returns a base64 data URL, or null if anything
// goes wrong. We use it to inline the property photo into the briefing HTML
// so html2canvas can capture it without hitting a CORS error.
//
// SSRF defense in depth: re-validate the URL here even though we also
// validate at write time. An attacker who got an unsafe URL into the
// property doc before this guard landed would otherwise have a stable
// way to read internal services. With the validator both at write and
// fetch time, neither path alone can be exploited.
export async function fetchImageAsDataUrl(
  url: string,
  maxBytes = 8 * 1024 * 1024,
): Promise<string | null> {
  // Lazy-import to avoid circular dep at module-load time.
  const { isPublicHttpsUrl } = await import("./safeRedirect");
  if (!isPublicHttpsUrl(url)) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal, redirect: "error" });
    clearTimeout(timer);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "image/jpeg";
    // Only accept actual image mime types — block text/html, application/json
    // sneaking through as "image".
    if (!contentType.toLowerCase().startsWith("image/")) return null;
    const buf = await readBodyCapped(res, maxBytes);
    if (!buf) return null;
    return `data:${contentType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtMoney(cents: number, currency = "EUR"): string {
  const symbol = currency === "EUR" ? "€" : currency === "USD" ? "$" : currency;
  const value = (cents ?? 0).toLocaleString("en-GB", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return `${symbol}${value}`;
}

function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

// Money with an explicit +/- sign — used for gain and net cash-flow figures
// where the direction is the point of the number.
function fmtSignedMoney(value: number, currency = "EUR"): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${fmtMoney(Math.abs(value), currency)}`;
}

function fmtPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

// Title-cases a transaction category ("maintenance" → "Maintenance").
function titleCase(s: string): string {
  if (!s) return "—";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Human-readable file size from a byte count.
function fmtBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Short, friendly label for a document's MIME type ("application/pdf" → "PDF").
function fmtDocType(contentType: string): string {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("pdf")) return "PDF";
  if (ct.includes("wordprocessingml") || ct === "application/msword") return "DOC";
  if (ct.includes("spreadsheetml") || ct.includes("ms-excel")) return "XLS";
  if (ct.includes("presentationml") || ct.includes("powerpoint")) return "PPT";
  if (ct.startsWith("image/") || ct.startsWith("text/")) {
    return (ct.split("/")[1] || "FILE").toUpperCase();
  }
  const sub = ct.split("/")[1] || ct;
  return (sub.split(";")[0] || "FILE").toUpperCase().slice(0, 8);
}

// Shared <style> block for both property and portfolio variants. Keeping
// one stylesheet means the two layouts stay visually coherent.
//
// IMPORTANT: every rule is scoped under `.page`, and the <style> is rendered
// *inside* the `.page` element (not in <head>). The client PDF path
// (openBriefing → html2pdf) deep-clones the `.page` node into the host app's
// document to rasterize it — anything in <head> is left behind, which is why
// an earlier version produced an unstyled, near-blank PDF. Keeping the styles
// inside `.page` means they travel with the clone; scoping them to `.page`
// keeps them from leaking onto the host app during that brief capture.
const STYLE = `
  .page, .page *, .page *::before, .page *::after { box-sizing: border-box; }
  .page {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #0A0A0A;
    line-height: 1.45;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    width: 210mm;
    min-height: 297mm;
    padding: 14mm 14mm 10mm;
    margin: 0 auto;
    background: #FFFFFF;
    display: flex;
    flex-direction: column;
  }
  .page > style { display: none; }
  .page .brandbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #6B6B6B;
    padding-bottom: 8px;
    margin-bottom: 10px;
    border-bottom: 1px solid #ECECEC;
  }
  .page .brandbar .logo {
    color: #0A0A0A;
    font-weight: 700;
    letter-spacing: 0.22em;
  }

  /* HERO — property photo banner. A real <img> (not a CSS background) so the
     photo survives html2canvas rasterization and prints regardless of the
     browser's "print backgrounds" setting. */
  .page .hero {
    position: relative;
    width: 100%;
    height: 56mm;
    border-radius: 14px;
    overflow: hidden;
    border: 1px solid #ECECEC;
    background: #F4F4F4;
  }
  .page .hero img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .page .hero .ph {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    color: #B0B0B0;
    font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase;
  }

  /* TITLE BAR — name + location on the left, type pill on the right */
  .page .titlebar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-top: 14px;
  }
  .page .titlebar h1 {
    margin: 0;
    font-size: 23px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.2;
    color: #0A0A0A;
  }
  .page .titlebar .loc {
    margin-top: 5px;
    font-size: 12.5px;
    color: #6B6B6B;
  }
  .page .tpill {
    display: inline-block;
    border: 1px solid #DADADA;
    color: #0A0A0A;
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 5px 11px;
    border-radius: 999px;
    white-space: nowrap;
    font-weight: 600;
  }

  /* FEATURE CHIPS */
  .page .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .page .chip {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    border: 1px solid #E2E2E2;
    border-radius: 999px;
    padding: 4px 9px;
    color: #333333;
  }

  /* PORTFOLIO HERO — no image, just a clean banner */
  .page .pheader {
    border-radius: 14px;
    background: #0A0A0A;
    color: #FFFFFF;
    padding: 22px 24px;
  }
  .page .pheader .pill {
    display: inline-block;
    background: rgba(255,255,255,0.12);
    border: 1px solid rgba(255,255,255,0.18);
    color: #FFFFFF;
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    padding: 4px 10px;
    border-radius: 999px;
    margin-bottom: 8px;
  }
  .page .pheader h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .page .pheader .sub {
    margin-top: 4px;
    font-size: 12px;
    opacity: 0.75;
  }

  /* STAT ROW */
  .page .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-top: 12px;
  }
  .page .stat {
    border: 1px solid #ECECEC;
    border-radius: 10px;
    padding: 12px 14px;
    background: #FFFFFF;
  }
  .page .stat .label {
    font-size: 9.5px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #8A8A8A;
  }
  .page .stat .value {
    margin-top: 4px;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: #0A0A0A;
    font-variant-numeric: tabular-nums;
  }

  /* SECTION HEADERS */
  .page .section-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #0A0A0A;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .page .section-title::before {
    content: "";
    display: inline-block;
    width: 12px;
    height: 0;
    border-top: 2px solid #0A0A0A;
  }

  /* TWO-COLUMN BODY */
  .page .grid2 {
    display: grid;
    grid-template-columns: 1.05fr 1fr;
    gap: 14px;
    margin-top: 14px;
  }
  .page .card {
    border: 1px solid #ECECEC;
    border-radius: 10px;
    padding: 14px 16px;
    background: #FFFFFF;
  }

  /* PROPERTY SUMMARY (key/value rows) */
  .page .kv { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  .page .kv td {
    padding: 6px 0;
    border-bottom: 1px dotted #ECECEC;
    vertical-align: top;
  }
  .page .kv td:first-child {
    color: #6B6B6B;
    width: 44%;
    padding-right: 8px;
  }
  .page .kv td:last-child {
    color: #0A0A0A;
    text-align: right;
    font-weight: 500;
  }
  .page .kv tr:last-child td { border-bottom: 0; }

  /* TABLES (tenants / tx / properties) */
  .page table.data {
    width: 100%;
    border-collapse: collapse;
    font-size: 10.5px;
  }
  .page table.data th {
    text-align: left;
    padding: 6px 8px;
    background: #F7F7F7;
    color: #6B6B6B;
    font-weight: 600;
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    border-bottom: 1px solid #ECECEC;
  }
  .page table.data td {
    padding: 6px 8px;
    border-bottom: 1px solid #F2F2F2;
    vertical-align: top;
  }
  .page table.data tr:last-child td { border-bottom: 0; }
  .page table.data td.num, .page table.data th.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .page .badge {
    display: inline-block;
    font-size: 9.5px;
    padding: 2px 7px;
    border-radius: 999px;
    background: #F2F2F2;
    color: #4A4A4A;
    text-transform: capitalize;
  }
  .page .badge.active { background: #E8F5EC; color: #1F7A3A; }
  .page .badge.expired { background: #FCEAEA; color: #B33A3A; }
  .page .badge.pending, .page .badge.invited { background: #FFF4E5; color: #8A5A00; }

  .page .muted { color: #8A8A8A; font-size: 11px; }
  .page .empty {
    text-align: center;
    color: #8A8A8A;
    font-size: 11px;
    padding: 18px 0;
  }

  .page .totals {
    display: flex;
    justify-content: space-between;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid #ECECEC;
    font-size: 11.5px;
  }
  .page .totals .label { color: #6B6B6B; }
  .page .totals .value { font-weight: 600; font-variant-numeric: tabular-nums; }

  /* TABLE FOOTER (totals row inside data tables) */
  .page table.data tfoot td {
    padding: 7px 8px;
    border-top: 1px solid #DADADA;
    font-weight: 600;
    color: #0A0A0A;
    background: #FAFAFA;
  }
  .page table.data tfoot td.lbl {
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #6B6B6B;
  }

  /* KPI delta + signed values */
  .page .stat .delta { margin-top: 2px; font-size: 10px; font-weight: 600; }
  .page .delta.pos, .page .value.pos { color: #1F7A3A; }
  .page .delta.neg, .page .value.neg { color: #B33A3A; }

  /* CASH-FLOW FIGURES */
  .page .figs {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
  }
  .page .fig { border: 1px solid #ECECEC; border-radius: 10px; padding: 12px 14px; }
  .page .fig .flabel {
    font-size: 9.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #8A8A8A;
  }
  .page .fig .fvalue {
    margin-top: 3px;
    font-size: 17px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: #0A0A0A;
  }

  /* MINI CATEGORY BREAKDOWN */
  .page .catlist { margin-top: 12px; }
  .page .catrow {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 10.5px;
    padding: 4px 0;
    border-bottom: 1px dotted #ECECEC;
    color: #4A4A4A;
  }
  .page .catrow:last-child { border-bottom: 0; }
  .page .catrow .cv { font-variant-numeric: tabular-nums; font-weight: 500; color: #0A0A0A; }

  /* SECTION SPACING */
  .page .section { margin-top: 16px; break-inside: auto; }

  /* Force a fresh page before this section. html2pdf's css pagebreak mode
     reads the computed break-before and pushes the element to the next
     page — used to keep tenants + recent activity off the first page. */
  .page .break-page { break-before: page; }

  /* Continuation pages re-show the header; give it the same top inset as
     page 1. The .page top padding only applies before the first page, so
     html2pdf drops the repeated header flush against the page-2 top edge
     without this. */
  .page .continued { padding-top: 14mm; }

  /* Document download links — clickable but on-brand (no loud link blue). */
  .page a { color: inherit; text-decoration: none; }
  .page .doclink {
    color: #0A0A0A;
    font-weight: 500;
    text-decoration: underline;
    text-decoration-color: #C9C9C9;
    text-underline-offset: 2px;
  }

  /* FOOTER */
  .page footer {
    margin-top: auto;
    padding-top: 10px;
    border-top: 1px solid #ECECEC;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 9.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #8A8A8A;
  }
  .page footer .logo { color: #0A0A0A; font-weight: 700; letter-spacing: 0.22em; }

  /* Page-break hints for html2pdf's multi-page (portfolio) output. */
  .page .card, .page .stat, .page .hero, .page .pheader { break-inside: avoid; }
  .page table.data tr { break-inside: avoid; }
`;

function renderPropertyBriefing(input: BriefingInput): string {
  const p = input.property!;
  const tenants = input.tenants;
  const tx = input.transactions;
  const documents = input.documents ?? [];

  // ── Valuation & returns ────────────────────────────────────────────
  const value = p.propertyValue ?? 0;
  const acq = p.acquisitionPrice ?? 0;
  const gain = value - acq;
  const gainPct = acq > 0 ? (gain / acq) * 100 : null;

  // Rent roll from active tenancies only (consistent with the portfolio
  // briefing — pending/expired tenants aren't paying).
  const activeTenantList = tenants.filter((t) => t.status === "active");
  const monthlyRent = activeTenantList.reduce((s, t) => s + (t.rentAmount ?? 0), 0);
  const annualRent = monthlyRent * 12;
  const grossYield = value > 0 ? (annualRent / value) * 100 : null;

  // ── Year-to-date cash flow from this property's recorded transactions ─
  // Year is taken from the report's generation date so the labels stay
  // accurate regardless of when the briefing is produced.
  const realized = tx.filter((t) => t.status !== "failed");
  const reportYear = (() => {
    const d = new Date(input.generatedAt);
    return Number.isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear();
  })();
  const inReportYear = (iso: string): boolean => {
    const d = new Date(iso);
    return !Number.isNaN(d.getTime()) && d.getFullYear() === reportYear;
  };
  // Realized income only: isRealizedRent excludes unverified PENDING offline
  // rent (and failed) so the YTD figure reflects money that actually landed.
  const ytdIncome = realized
    .filter((t) => isRealizedRent(t) && inReportYear(t.timestamp ?? ""))
    // Net of any cardholder refund stamped on the row — realized income must
    // not keep counting money that was refunded.
    .reduce((s, t) => s + netRealizedRentAmount(t), 0);
  const ytdExpenses = realized
    .filter((t) => t.type === "expense" && inReportYear(t.timestamp ?? ""))
    .reduce((s, t) => s + (t.amount ?? 0), 0);

  // More activity rows now that the document paginates cleanly.
  const recentTx = [...tx].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, 12);

  // Owner-chosen name is the headline; the address drops to the location line.
  const propTitle = p.name?.trim() || p.address || "Property";

  // Prefer the inlined data URL (CORS-safe for client-side rasterization);
  // fall back to the remote URL if inlining failed; otherwise placeholder.
  const heroSrc = input.propertyImageDataUrl || p.image;
  const heroBg = heroSrc
    ? `<img src="${escapeHtml(heroSrc)}" alt="" crossorigin="anonymous" />`
    : `<div class="ph">No property photo</div>`;

  const locationLine = [
    // Only surface the address here when the name is the headline, else it
    // would just repeat the title.
    p.name?.trim() ? p.address : "",
    [p.postalCode, p.city].filter(Boolean).join(" "),
    p.country,
  ]
    .filter(Boolean)
    .join(" · ");

  // ── Section bodies ──────────────────────────────────────────────────
  // value is already formatted/escaped by the caller.
  const kvRow = (label: string, value: string): string =>
    `<tr><td>${escapeHtml(label)}</td><td>${value}</td></tr>`;

  // OVERVIEW — physical descriptors, empties dropped so the card stays tight.
  const overviewData: [string, string | undefined][] = [
    ["Type", p.propertyType ? titleCase(p.propertyType) : undefined],
    ["Size", p.sqm ? `${p.sqm} m²` : undefined],
    ["Bedrooms", p.bedrooms != null ? String(p.bedrooms) : undefined],
    ["Bathrooms", p.baths != null ? String(p.baths) : undefined],
    ["Floor", p.floor || undefined],
    ["Built", p.builtYear || undefined],
    ["Energy class", p.energyClass || undefined],
    ["Building", p.buildingName || undefined],
  ];
  const overviewKept = overviewData.filter(([, v]) => v && String(v).length > 0);
  const overviewHtml = overviewKept.length
    ? `<table class="kv"><tbody>${overviewKept
        .map(([k, v]) => kvRow(k, escapeHtml(String(v))))
        .join("")}</tbody></table>`
    : `<div class="empty">No details captured yet</div>`;

  // FINANCIALS — valuation, returns and year-to-date cash flow.
  const financialsHtml = `<table class="kv"><tbody>${[
    kvRow("Current value", fmtMoney(value)),
    kvRow("Acquisition price", fmtMoney(acq)),
    kvRow("Monthly rent", fmtMoney(monthlyRent)),
    kvRow("Gross yield", fmtPct(grossYield)),
    kvRow(`YTD income (${reportYear})`, fmtMoney(ytdIncome)),
    kvRow(`YTD expenses (${reportYear})`, fmtMoney(ytdExpenses)),
  ].join("")}</tbody></table>`;

  // OWNERSHIP — legal status (ownership type, company, title deeds).
  const ownershipHtml = `<table class="kv"><tbody>${[
    kvRow("Ownership type", p.ownershipType ? escapeHtml(titleCase(p.ownershipType)) : "—"),
    kvRow("Company", p.companyName ? escapeHtml(p.companyName) : "—"),
    kvRow("Title deeds", p.titleDeedsStatus ? escapeHtml(titleCase(p.titleDeedsStatus)) : "—"),
  ].join("")}</tbody></table>`;

  // FEATURES — amenity chips, only the ones that are set.
  const featureChips = [
    p.parking && p.parking > 0
      ? `${p.parking} parking ${p.parking === 1 ? "space" : "spaces"}`
      : null,
    p.elevator ? "Elevator" : null,
    p.heating ? "Heating" : null,
    p.cooling ? "Cooling" : null,
    p.solarPanels ? "Solar panels" : null,
    p.storageUnit ? "Storage unit" : null,
  ].filter(Boolean) as string[];
  const featuresHtml = featureChips.length
    ? `<div class="chips">${featureChips
        .map((f) => `<span class="chip">${escapeHtml(f)}</span>`)
        .join("")}</div>`
    : `<div class="empty">No amenities recorded</div>`;

  const tenantsHtml =
    tenants.length === 0
      ? `<div class="empty">No tenants on record</div>`
      : `<table class="data">
          <thead><tr><th>Tenant</th><th>Status</th><th class="num">Monthly rent</th></tr></thead>
          <tbody>
            ${tenants
              .map(
                (t) => `<tr>
                  <td>
                    <div style="font-weight:500;color:#0A0A0A;">${escapeHtml(t.name || "—")}</div>
                    <div style="color:#8A8A8A;font-size:9.5px;">${escapeHtml(t.email || "")}</div>
                  </td>
                  <td><span class="badge ${escapeHtml(t.status || "")}">${escapeHtml(t.status || "—")}</span></td>
                  <td class="num">${fmtMoney(t.rentAmount ?? 0)}</td>
                </tr>`,
              )
              .join("")}
          </tbody>
        </table>
        <div class="totals">
          <span class="label">Active rent roll</span>
          <span class="value">${fmtMoney(monthlyRent)}</span>
        </div>`;

  const txHtml =
    recentTx.length === 0
      ? `<div class="empty">No transactions on record</div>`
      : `<table class="data">
          <thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th></tr></thead>
          <tbody>
            ${recentTx
              .map(
                (t) => `<tr>
                  <td>${fmtDate(t.timestamp ?? "")}</td>
                  <td>${escapeHtml(t.name ?? "")}</td>
                  <td class="num">${fmtMoney(t.amount ?? 0, t.currency ?? "EUR")}</td>
                </tr>`,
              )
              .join("")}
          </tbody>
        </table>`;

  const documentsHtml =
    documents.length === 0
      ? `<div class="empty">No documents uploaded</div>`
      : `<table class="data">
          <thead><tr><th>Document</th><th>Type</th><th class="num">Size</th><th>Added</th></tr></thead>
          <tbody>
            ${documents
              .map(
                (d) => `<tr>
                  <td>${
                    d.downloadURL
                      ? `<a class="doclink" href="${escapeHtml(d.downloadURL)}">${escapeHtml(d.name || "—")}</a>`
                      : escapeHtml(d.name || "—")
                  }</td>
                  <td>${escapeHtml(fmtDocType(d.contentType))}</td>
                  <td class="num">${fmtBytes(d.size)}</td>
                  <td>${escapeHtml(fmtDate(d.createdAt))}</td>
                </tr>`,
              )
              .join("")}
          </tbody>
        </table>`;

  // Header block — brandbar + hero photo + title. Repeated at the top of
  // page 2 (above the tenants/activity continuation) so that page still
  // carries the property photo and name rather than starting cold.
  const headerHtml = `
    <div class="brandbar">
      <span class="logo">OLIO</span>
      <span>Property briefing · ${escapeHtml(fmtDate(input.generatedAt))}</span>
    </div>

    <div class="hero">${heroBg}</div>

    <div class="titlebar">
      <div>
        <h1>${escapeHtml(propTitle)}</h1>
        ${locationLine ? `<div class="loc">${escapeHtml(locationLine)}</div>` : ""}
      </div>
      ${p.propertyType ? `<span class="tpill">${escapeHtml(titleCase(p.propertyType))}</span>` : ""}
    </div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Property Briefing — ${escapeHtml(propTitle)} — Olio</title>
</head>
<body>
  <div class="page">
    <style>${STYLE}</style>
    ${headerHtml}

    <div class="stats">
      <div class="stat">
        <div class="label">Current value</div>
        <div class="value">${fmtMoney(value)}</div>
      </div>
      <div class="stat">
        <div class="label">Monthly rent</div>
        <div class="value">${fmtMoney(monthlyRent)}</div>
      </div>
      <div class="stat">
        <div class="label">Gross yield</div>
        <div class="value">${fmtPct(grossYield)}</div>
      </div>
      <div class="stat">
        <div class="label">Unrealised gain</div>
        <div class="value ${gain >= 0 ? "pos" : "neg"}">${fmtSignedMoney(gain)}</div>
        ${gainPct != null ? `<div class="delta ${gain >= 0 ? "pos" : "neg"}">${gain >= 0 ? "+" : ""}${gainPct.toFixed(1)}%</div>` : ""}
      </div>
    </div>

    <div class="section grid2">
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div class="card">
          <div class="section-title">Overview</div>
          ${overviewHtml}
        </div>
        <div class="card">
          <div class="section-title">Features</div>
          ${featuresHtml}
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:14px;">
        <div class="card">
          <div class="section-title">Financials</div>
          ${financialsHtml}
        </div>
        <div class="card">
          <div class="section-title">Ownership &amp; compliance</div>
          ${ownershipHtml}
        </div>
      </div>
    </div>

    <div class="break-page continued">${headerHtml}</div>

    <div class="section card">
      <div class="section-title">Tenants &amp; rent</div>
      ${tenantsHtml}
    </div>

    <div class="section card">
      <div class="section-title">Documents</div>
      ${documentsHtml}
    </div>

    <div class="section card">
      <div class="section-title">Recent activity</div>
      ${txHtml}
    </div>

    <footer>
      <span class="logo">OLIO</span>
      <span>Prepared for ${escapeHtml(input.ownerName || input.ownerEmail)} · Confidential</span>
    </footer>
  </div>

  <!-- No auto-print. The client (openBriefing in shared/lib/briefing.ts)
       rasterizes this document into a real PDF download via html2pdf,
       so we no longer want a browser-native print dialog here. -->
</body>
</html>`;
}

function renderPortfolioBriefing(input: BriefingInput): string {
  const properties = input.properties ?? [];
  const tenants = input.tenants;
  const tx = input.transactions;

  // ── Valuation & returns ────────────────────────────────────────────
  const totalValue = properties.reduce((s, p) => s + (p.propertyValue ?? 0), 0);
  const totalAcq = properties.reduce((s, p) => s + (p.acquisitionPrice ?? 0), 0);
  const gain = totalValue - totalAcq;
  const gainPct = totalAcq > 0 ? (gain / totalAcq) * 100 : null;

  // ── Rent roll & occupancy ──────────────────────────────────────────
  // Rent roll reflects contracted rent from *active* tenancies only —
  // pending/expired tenants aren't paying, so counting them would overstate
  // the income the portfolio actually produces.
  const activeTenantList = tenants.filter((t) => t.status === "active");
  const monthlyRent = activeTenantList.reduce((s, t) => s + (t.rentAmount ?? 0), 0);
  const annualRent = monthlyRent * 12;
  const grossYield = totalValue > 0 ? (annualRent / totalValue) * 100 : null;

  // Occupancy = share of properties with at least one active tenancy.
  const occupiedPropIds = new Set(activeTenantList.map((t) => t.propertyId));
  const occupiedProps = properties.filter((p) => occupiedPropIds.has(p.id)).length;
  const occupancy =
    properties.length === 0 ? "—" : `${Math.round((occupiedProps / properties.length) * 100)}%`;

  // ── Cash flow (from recorded transactions) ─────────────────────────
  // Excludes failed transactions; `realized` still drives EXPENSE totals.
  // Income, however, must additionally exclude unverified PENDING offline
  // rent — so it routes through isRealizedRent instead of a bare type gate.
  const realized = tx.filter((t) => t.status !== "failed");
  const income = realized
    .filter((t) => isRealizedRent(t))
    .reduce((s, t) => s + netRealizedRentAmount(t), 0);
  const expenses = realized
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + (t.amount ?? 0), 0);
  const net = income - expenses;

  // Expense breakdown by category, biggest first.
  const expenseByCat = new Map<string, number>();
  realized
    .filter((t) => t.type === "expense")
    .forEach((t) => {
      const k = t.category || "other";
      expenseByCat.set(k, (expenseByCat.get(k) ?? 0) + (t.amount ?? 0));
    });
  const expenseCatRows = Array.from(expenseByCat.entries())
    .sort((a, b) => b[1] - a[1])
    .map(
      ([cat, amt]) =>
        `<div class="catrow"><span>${escapeHtml(titleCase(cat))}</span><span class="cv">${fmtMoney(amt)}</span></div>`,
    )
    .join("");

  // Portfolio composition by property type, e.g. "3 Apartments · 1 Villa".
  const typeCounts = new Map<string, number>();
  properties.forEach((p) => {
    const k = p.propertyType || "Other";
    typeCounts.set(k, (typeCounts.get(k) ?? 0) + 1);
  });
  const composition = Array.from(typeCounts.entries())
    .map(([k, n]) => `${n} ${k}${n > 1 ? "s" : ""}`)
    .join(" · ");

  // Show a generous slice of activity now that the document paginates.
  const recentTx = [...tx].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, 18);

  // ── Properties table ───────────────────────────────────────────────
  const propertyRows = properties
    .map((p) => {
      const activeForProp = activeTenantList.filter((t) => t.propertyId === p.id);
      const propRent = activeForProp.reduce((s, t) => s + (t.rentAmount ?? 0), 0);
      const propYield =
        (p.propertyValue ?? 0) > 0 ? ((propRent * 12) / (p.propertyValue ?? 0)) * 100 : null;
      const name = p.name?.trim() || p.address || "—";
      const subline = p.name?.trim() && p.address ? escapeHtml(p.address) : "";
      const occ =
        activeForProp.length > 0
          ? `<span class="badge active">Occupied</span>`
          : `<span class="muted">Vacant</span>`;
      const location = [p.city, p.country].filter(Boolean).join(", ");
      return `<tr>
        <td>
          <div style="font-weight:500;color:#0A0A0A;">${escapeHtml(name)}</div>
          ${subline ? `<div style="color:#8A8A8A;font-size:9.5px;">${subline}</div>` : ""}
        </td>
        <td>${escapeHtml(p.propertyType ?? "—")}</td>
        <td>${escapeHtml(location || "—")}</td>
        <td>${occ}</td>
        <td class="num">${fmtMoney(propRent)}</td>
        <td class="num">${fmtPct(propYield)}</td>
        <td class="num">${fmtMoney(p.propertyValue ?? 0)}</td>
      </tr>`;
    })
    .join("");

  // ── Tenants table ──────────────────────────────────────────────────
  const tenantRows = tenants
    .map((t) => {
      const prop = properties.find((p) => p.id === t.propertyId);
      const propName = prop ? prop.name?.trim() || prop.address || "—" : "—";
      return `<tr>
        <td>
          <div style="font-weight:500;color:#0A0A0A;">${escapeHtml(t.name || "—")}</div>
          <div style="color:#8A8A8A;font-size:9.5px;">${escapeHtml(t.email || "")}</div>
        </td>
        <td>${escapeHtml(propName)}</td>
        <td><span class="badge ${escapeHtml(t.status || "")}">${escapeHtml(t.status || "—")}</span></td>
        <td class="num">${fmtMoney(t.rentAmount ?? 0)}</td>
        <td>${t.nextPayment ? escapeHtml(fmtDate(t.nextPayment)) : "—"}</td>
      </tr>`;
    })
    .join("");

  const txRows = recentTx
    .map(
      (t) => `<tr>
        <td>${fmtDate(t.timestamp ?? "")}</td>
        <td>${escapeHtml(t.name ?? "")}</td>
        <td>${escapeHtml(titleCase(t.category ?? ""))}</td>
        <td class="num">${t.type === "expense" ? "-" : t.type === "income" ? "+" : ""}${fmtMoney(t.amount ?? 0, t.currency ?? "EUR")}</td>
      </tr>`,
    )
    .join("");

  const generated = escapeHtml(fmtDate(input.generatedAt));
  const ownerLabel = escapeHtml(input.ownerName || input.ownerEmail);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Portfolio Briefing — Olio</title>
</head>
<body>
  <div class="page">
    <style>${STYLE}</style>
    <div class="brandbar">
      <span class="logo">OLIO</span>
      <span>Portfolio briefing · ${generated}</span>
    </div>

    <div class="pheader">
      <span class="pill">Portfolio overview</span>
      <h1>${ownerLabel}</h1>
      <div class="sub">${properties.length} propert${properties.length === 1 ? "y" : "ies"} · ${tenants.length} tenant${tenants.length === 1 ? "" : "s"}${composition ? " · " + escapeHtml(composition) : ""}</div>
    </div>

    <div class="stats">
      <div class="stat">
        <div class="label">Portfolio value</div>
        <div class="value">${fmtMoney(totalValue)}</div>
      </div>
      <div class="stat">
        <div class="label">Acquisition cost</div>
        <div class="value">${fmtMoney(totalAcq)}</div>
      </div>
      <div class="stat">
        <div class="label">Unrealised gain</div>
        <div class="value ${gain >= 0 ? "pos" : "neg"}">${fmtSignedMoney(gain)}</div>
        ${gainPct != null ? `<div class="delta ${gain >= 0 ? "pos" : "neg"}">${gain >= 0 ? "+" : ""}${gainPct.toFixed(1)}%</div>` : ""}
      </div>
      <div class="stat">
        <div class="label">Gross yield</div>
        <div class="value">${fmtPct(grossYield)}</div>
      </div>
      <div class="stat">
        <div class="label">Rent roll · monthly</div>
        <div class="value">${fmtMoney(monthlyRent)}</div>
      </div>
      <div class="stat">
        <div class="label">Rent roll · annual</div>
        <div class="value">${fmtMoney(annualRent)}</div>
      </div>
      <div class="stat">
        <div class="label">Occupancy</div>
        <div class="value">${occupancy}</div>
      </div>
      <div class="stat">
        <div class="label">Active tenants</div>
        <div class="value">${activeTenantList.length}<span style="font-size:11px;color:#8A8A8A;font-weight:500;"> / ${tenants.length}</span></div>
      </div>
    </div>

    <div class="section card">
      <div class="section-title">Financial summary</div>
      <div class="figs">
        <div class="fig">
          <div class="flabel">Income recorded</div>
          <div class="fvalue pos">${fmtMoney(income)}</div>
        </div>
        <div class="fig">
          <div class="flabel">Expenses recorded</div>
          <div class="fvalue neg">${fmtMoney(expenses)}</div>
        </div>
        <div class="fig">
          <div class="flabel">Net cash flow</div>
          <div class="fvalue ${net >= 0 ? "pos" : "neg"}">${fmtSignedMoney(net)}</div>
        </div>
      </div>
      ${
        expenseCatRows
          ? `<div class="catlist">
              <div style="font-size:9.5px;letter-spacing:0.14em;text-transform:uppercase;color:#8A8A8A;margin-bottom:4px;">Expenses by category</div>
              ${expenseCatRows}
            </div>`
          : ""
      }
      <div class="muted" style="margin-top:10px;">Based on ${realized.length} recorded transaction${realized.length === 1 ? "" : "s"}.</div>
    </div>

    <div class="section card">
      <div class="section-title">Properties</div>
      ${
        propertyRows
          ? `<table class="data">
              <thead><tr>
                <th>Property</th><th>Type</th><th>Location</th><th>Status</th>
                <th class="num">Monthly rent</th><th class="num">Yield</th><th class="num">Value</th>
              </tr></thead>
              <tbody>${propertyRows}</tbody>
              <tfoot><tr>
                <td class="lbl" colspan="4">Portfolio total</td>
                <td class="num">${fmtMoney(monthlyRent)}</td>
                <td class="num">${fmtPct(grossYield)}</td>
                <td class="num">${fmtMoney(totalValue)}</td>
              </tr></tfoot>
            </table>`
          : `<div class="empty">No properties on record</div>`
      }
    </div>

    <div class="section card">
      <div class="section-title">Tenants &amp; rent roll</div>
      ${
        tenantRows
          ? `<table class="data">
              <thead><tr>
                <th>Tenant</th><th>Property</th><th>Status</th>
                <th class="num">Monthly rent</th><th>Next payment</th>
              </tr></thead>
              <tbody>${tenantRows}</tbody>
              <tfoot><tr>
                <td class="lbl" colspan="3">Active rent roll</td>
                <td class="num">${fmtMoney(monthlyRent)}</td>
                <td></td>
              </tr></tfoot>
            </table>`
          : `<div class="empty">No tenants on record</div>`
      }
    </div>

    <div class="section card">
      <div class="section-title">Recent activity</div>
      ${
        recentTx.length === 0
          ? `<div class="empty">No transactions on record</div>`
          : `<table class="data">
              <thead><tr>
                <th>Date</th><th>Description</th><th>Category</th><th class="num">Amount</th>
              </tr></thead>
              <tbody>${txRows}</tbody>
            </table>`
      }
    </div>

    <footer>
      <span class="logo">OLIO</span>
      <span>Prepared for ${ownerLabel} · ${generated} · Confidential</span>
    </footer>
  </div>

  <!-- No auto-print. The client (openBriefing in shared/lib/briefing.ts)
       rasterizes this document into a real PDF download via html2pdf,
       so we no longer want a browser-native print dialog here. -->
</body>
</html>`;
}

export function renderBriefingHtml(input: BriefingInput): string {
  return input.property ? renderPropertyBriefing(input) : renderPortfolioBriefing(input);
}
