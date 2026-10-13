import { Building, FileSignature, FileText, Download } from "lucide-react";
import { formatDate, formatDateTime, formatCurrencyCompact, formatBytes } from "@ui/lib/format";
import type {
  AgreementIndexation,
  AgreementStatus,
  AutoRenewalMode,
  LeaseType,
  PaymentFrequency,
} from "@shared/firestore-schema";

// The minimal lease data the printable "Lease Agreement" document renders.
// Both the tenant agreements payload (TenantAgreement) and the owner agreements
// payload (OwnerAgreement) structurally satisfy this — landlord + tenant names
// live in different fields per persona, so they're passed in explicitly rather
// than read off the agreement.
export interface AgreementDocumentData {
  id: string;
  status: AgreementStatus;
  leaseType: LeaseType | string;
  address: string;
  monthlyRent: number;
  deposit: number;
  startDate: string;
  endDate: string;
  noticePeriodMonths: number | null;
  paymentDayOfMonth: number | null;
  paymentFrequency: PaymentFrequency | null;
  rentalDurationMonths: number | null;
  rentFreePeriodMonths: number | null;
  prepaidRents: number | null;
  autoRenewal: AutoRenewalMode | null;
  indexation: AgreementIndexation | null;
  termsAndConditions: string | null;
  signedAt: string | null;
  // The owner-uploaded signed/physical lease PDF, when attached. `documentUrl`
  // is a freshly-minted, short-lived signed read URL (the agreement read
  // endpoints sign it per request from the stored path); the rest is display
  // metadata. Both the owner and the lease's tenant can open it. All optional so
  // legacy payloads and the print path read cleanly.
  documentUrl?: string | null;
  documentName?: string | null;
  documentSize?: number | null;
  documentUploadedAt?: string | null;
}

// The core lease terms an owner can edit inline. All optional so a save only
// sends what changed; the server recomputes term + total value from the dates.
export interface AgreementEditValues {
  monthlyRent?: number;
  deposit?: number;
  startDate?: string;
  endDate?: string;
}

// Optional contact details rendered as sub-lines under a party's name in the
// "Parties" box (and the printed PDF). Each side is opt-in: the owner view
// passes the tenant's email + phone so the merchant sees full contact info, not
// just a name. Missing fields are simply not rendered.
export interface PartyContact {
  email?: string | null;
  phone?: string | null;
}

const formatSignedAt = formatDateTime;

export const fmtMoney = (n: number | null | undefined) =>
  typeof n === "number" ? formatCurrencyCompact(n) : "—";

export const orDash = (v: string | number | null | undefined, suffix = "") =>
  v === null || v === undefined || v === "" ? "—" : `${v}${suffix}`;

const cap = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "—");

const fmtMonths = (n: number | null | undefined) =>
  typeof n === "number" && n > 0 ? `${n} ${n === 1 ? "month" : "months"}` : "—";

const fmtAutoRenewal = (v: AutoRenewalMode | null | undefined) =>
  v === "auto"
    ? "Renews automatically"
    : v === "fixed"
      ? "Fixed-term renewal"
      : v === "none"
        ? "No auto-renewal"
        : "—";

// Render the owner's rent-increase (indexation) terms as one human line,
// e.g. "Fixed 2.5% · Yearly (after 12 months)" or "CPI (inflation) · Yearly".
const fmtIndexation = (idx: AgreementIndexation | null | undefined) => {
  if (!idx) return "—";
  let base: string;
  if (idx.type === "cpi") base = "CPI (inflation)";
  else if (typeof idx.rate === "number" && idx.rate > 0)
    base = `${idx.type === "custom" ? "Custom " : "Fixed "}${idx.rate}%`;
  else if (idx.type === "custom") base = "Custom (set manually)";
  // A fixed clause with no positive rate is a no-op the sweep skips — show
  // "None" rather than a phantom "Fixed 0%".
  else return "None";
  const bits = [base];
  if (idx.frequency) bits.push(cap(idx.frequency));
  let out = bits.join(" · ");
  if (idx.delayMonths) out += ` (after ${fmtMonths(idx.delayMonths)})`;
  return out;
};

// The next scheduled increase date, with how many steps have already been
// applied. Renders "—" when indexation isn't tracked (legacy/no terms).
const fmtNextIncrease = (idx: AgreementIndexation | null | undefined) => {
  if (!idx?.nextIncreaseDate) return "—";
  const applied = idx.appliedSteps ?? 0;
  return applied > 0
    ? `${formatDate(idx.nextIncreaseDate)} · ${applied} applied`
    : formatDate(idx.nextIncreaseDate);
};

export const statusLabel = (s: AgreementStatus) =>
  s === "active"
    ? "Active"
    : s === "pending_tenant"
      ? "Awaiting your approval"
      : s === "declined"
        ? "Declined"
        : s === "expired"
          ? "Expired"
          : s === "terminated"
            ? "Terminated"
            : "Draft";

export const statusClass = (s: AgreementStatus) =>
  s === "active"
    ? "text-success"
    : s === "pending_tenant"
      ? "text-warning"
      : s === "declined"
        ? "text-destructive"
        : "text-muted-foreground";

// On-screen status pill colours (container / dot / text), keyed on status so a
// declined or pending lease is no longer shown in active-green.
//
// NOTE: this pill renders ONLY inside the forced-WHITE "paper" lease card
// (bg-white dark:bg-white, below), which deliberately opts out of dark theming
// so the on-screen card matches the printed PDF. Theme-adaptive tokens would
// flip bright in dark mode and wash out on the white sheet, so these use FIXED
// print shades (light bg + dark ink) that read on white in both themes. This
// file is intentionally excluded from script/checkDesignTokens.ts for that
// reason. (statusClass above is theme-token'd — it's used on dark-aware pages.)
export const statusPill = (s: AgreementStatus) =>
  s === "active"
    ? { box: "bg-emerald-50 border-emerald-200", dot: "bg-emerald-500", txt: "text-emerald-700" }
    : s === "pending_tenant"
      ? { box: "bg-amber-50 border-amber-200", dot: "bg-amber-500", txt: "text-amber-700" }
      : s === "declined"
        ? { box: "bg-red-50 border-red-200", dot: "bg-red-500", txt: "text-red-700" }
        : {
            box: "bg-neutral-100 border-neutral-200",
            dot: "bg-neutral-400",
            txt: "text-neutral-600",
          };

// Open a print-ready window rendering the lease as a styled A5 card and trigger
// the browser's print dialog (the "Download PDF" / "save as PDF" path). Mirrors
// the on-screen AgreementDocument exactly so the printed copy matches.
export function openAgreementPdf(
  agreement: AgreementDocumentData,
  opts: {
    landlordName: string;
    tenantName: string;
    landlordContact?: PartyContact;
    tenantContact?: PartyContact;
    onPopupBlocked?: () => void;
  },
) {
  const { landlordName, tenantName, landlordContact, tenantContact } = opts;
  const esc = (v: unknown) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  // One label/value cell in the Lease Terms grid; `full` spans both columns.
  const term = (k: string, v: string, full = false) =>
    `<div class="term${full ? " full" : ""}"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
  // Contact sub-lines under a party's name (email, then phone). Drops a value
  // that's identical to the displayed name — e.g. an invited tenant whose name
  // is still their email — so it isn't shown twice. Empty when no details.
  const contactLines = (name: string, c: PartyContact | undefined) =>
    [c?.email, c?.phone]
      .filter((v): v is string => !!v && v !== name)
      .map((v) => `<div class="contact">${esc(v)}</div>`)
      .join("");

  // Status pill colour, mirroring the on-screen card (green = active, amber = pending, …).
  const pillClass =
    (
      {
        active: "pill--active",
        pending_tenant: "pill--pending",
        declined: "pill--declined",
        expired: "pill--neutral",
        terminated: "pill--neutral",
        draft: "pill--neutral",
      } as Record<string, string>
    )[agreement.status] ?? "pill--neutral";

  // Inline lucide icons (Building, FileSignature) — can't use React components in the print window.
  const buildingIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/></svg>`;
  const signIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 19.5v.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7.5L20 8.5v3"/><path d="M8 18h1"/><path d="M18.4 9.6a2 2 0 0 1 3 3L17 17l-4 1 1-4Z"/></svg>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8" />
<title>Lease Agreement — ${esc(agreement.address)}</title>
<style>
 *{box-sizing:border-box;margin:0;padding:0}
 html,body{background:#f4f4f5;color:#171717;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
 body{padding:32px 16px}
 .card{max-width:595px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.14)}
 .accent{height:6px;background:linear-gradient(90deg,#171717,#404040,#171717)}
 .pad{padding:28px}
 .header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:28px}
 .title{font-size:18px;font-weight:700;letter-spacing:-.015em;color:#171717}
 .ref{font-size:11px;color:#a3a3a3;margin-top:3px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.02em}
 .pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;white-space:nowrap;flex:0 0 auto}
 .pill .dot{width:6px;height:6px;border-radius:999px}
 .pill .txt{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em}
 .pill--active{background:#ecfdf5;border:1px solid #a7f3d0}
 .pill--active .dot{background:#10b981}.pill--active .txt{color:#047857}
 .pill--pending{background:#fffbeb;border:1px solid #fde68a}
 .pill--pending .dot{background:#f59e0b}.pill--pending .txt{color:#b45309}
 .pill--declined{background:#fef2f2;border:1px solid #fecaca}
 .pill--declined .dot{background:#ef4444}.pill--declined .txt{color:#b91c1c}
 .pill--neutral{background:#f5f5f5;border:1px solid #e5e5e5}
 .pill--neutral .dot{background:#a3a3a3}.pill--neutral .txt{color:#525252}
 .box{background:#fafafa;border-radius:12px;padding:16px;margin-bottom:24px}
 .parties{display:grid;grid-template-columns:1fr 1fr;gap:16px}
 .lbl{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:#a3a3a3;margin-bottom:4px}
 .val{font-size:14px;font-weight:600;color:#171717}
 .contact{font-size:11px;color:#737373;margin-top:2px;word-break:break-word}
 .prop{display:flex;align-items:center;gap:12px}
 .prop .ic{width:40px;height:40px;border-radius:8px;background:#e5e5e5;color:#737373;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
 .prop .addr{font-size:14px;font-weight:600;color:#171717}
 .prop .sub{font-size:12px;color:#737373;margin-top:1px}
 .section-h{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#a3a3a3;margin-bottom:12px}
 .terms{display:grid;grid-template-columns:1fr 1fr;column-gap:24px;row-gap:12px;margin-bottom:24px}
 .term{display:flex;justify-content:space-between;align-items:baseline;gap:10px;border-bottom:1px solid #f5f5f5;padding-bottom:8px;font-size:14px}
 .term.full{grid-column:1 / -1}
 .term .k{color:#737373}
 .term .v{font-weight:600;color:#171717;text-align:right}
 .tc{font-size:13px;line-height:1.65;color:#404040;white-space:pre-wrap;margin-bottom:24px}
 .sign{margin-top:4px;padding-top:16px;border-top:1px solid #e5e5e5;display:flex;align-items:center;gap:12px}
 .sign .ic{width:36px;height:36px;border-radius:8px;background:#f5f5f5;color:#a3a3a3;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
 .sign .t1{font-size:14px;font-weight:500;color:#404040}
 .sign .t2{font-size:11px;color:#a3a3a3;margin-top:1px}
 .foot{max-width:595px;margin:16px auto 0;text-align:center;font-size:10px;color:#a3a3a3;line-height:1.5}
 @page{margin:14mm}
 @media print{html,body{background:#fff}body{padding:0}.card{box-shadow:none;border:1px solid #ededed}}
</style></head>
<body>
 <div class="card">
  <div class="accent"></div>
  <div class="pad">
   <div class="header">
    <div>
     <div class="title">Lease Agreement</div>
     <div class="ref">Ref: OL-${esc(agreement.id.slice(0, 8).toUpperCase())}</div>
    </div>
    <div class="pill ${pillClass}"><span class="dot"></span><span class="txt">${esc(statusLabel(agreement.status))}</span></div>
   </div>

   <div class="box parties">
    <div><div class="lbl">Landlord</div><div class="val">${esc(landlordName || "—")}</div>${contactLines(landlordName, landlordContact)}</div>
    <div><div class="lbl">Tenant</div><div class="val">${esc(tenantName || "—")}</div>${contactLines(tenantName, tenantContact)}</div>
   </div>

   <div class="box prop">
    <div class="ic">${buildingIcon}</div>
    <div><div class="addr">${esc(agreement.address)}</div><div class="sub">${esc(agreement.leaseType)}</div></div>
   </div>

   <div class="section-h">Lease Terms</div>
   <div class="terms">
    ${term("Monthly Rent", fmtMoney(agreement.monthlyRent))}
    ${term("Deposit", fmtMoney(agreement.deposit))}
    ${term("Start Date", formatDate(agreement.startDate))}
    ${term("End Date", formatDate(agreement.endDate))}
    ${term("Notice Period", orDash(agreement.noticePeriodMonths, agreement.noticePeriodMonths ? " Months" : ""))}
    ${term("Payment Day", orDash(agreement.paymentDayOfMonth, agreement.paymentDayOfMonth ? "th of Month" : ""))}
    ${term("Payment Frequency", cap(agreement.paymentFrequency))}
    ${term("Rental Duration", fmtMonths(agreement.rentalDurationMonths))}
    ${term("Rent-Free Period", fmtMonths(agreement.rentFreePeriodMonths))}
    ${term("Prepaid Rents", fmtMonths(agreement.prepaidRents))}
    ${term("Auto-Renewal", fmtAutoRenewal(agreement.autoRenewal), true)}
    ${term("Rent Increase", fmtIndexation(agreement.indexation), true)}
    ${agreement.indexation?.nextIncreaseDate ? term("Next Increase", fmtNextIncrease(agreement.indexation), true) : ""}
   </div>
   ${
     agreement.termsAndConditions
       ? `
   <div class="section-h">Terms &amp; Conditions</div>
   <div class="tc">${esc(agreement.termsAndConditions)}</div>`
       : ""
   }

   <div class="sign">
    <div class="ic">${signIcon}</div>
    <div>
     ${
       agreement.signedAt
         ? `<div class="t1">Signed electronically</div><div class="t2">${esc(formatSignedAt(agreement.signedAt))}</div>`
         : `<div class="t1">Not yet signed</div><div class="t2">Approve this agreement to sign it electronically</div>`
     }
    </div>
   </div>
  </div>
 </div>
 <div class="foot">Olio Wallet · oliowallet.com · Generated from your lease record. Use your browser's print dialog to save as PDF.</div>
 <script>window.onload=function(){setTimeout(function(){window.print()},250)}</script>
</body></html>`;

  const w = window.open("", "_blank");
  if (!w) {
    opts.onPopupBlocked?.();
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

// The on-screen "Lease Agreement" document — a styled A5 card shown in the
// agreement detail drawer for both tenants and owners. Landlord + tenant names
// are passed in since they live in different fields per persona.
export function AgreementDocument({
  agreement,
  landlordName,
  tenantName,
  landlordContact,
  tenantContact,
}: {
  agreement: AgreementDocumentData;
  landlordName: string;
  tenantName: string;
  landlordContact?: PartyContact;
  tenantContact?: PartyContact;
}) {
  // Email then phone, dropping anything not on file and any value identical to
  // the displayed name (so an invited tenant's email isn't shown twice).
  const contactLines = (name: string, c: PartyContact | undefined) =>
    [c?.email, c?.phone].filter((v): v is string => !!v && v !== name);
  return (
    <div
      className="bg-white dark:bg-white rounded-xl shadow-lg mx-auto overflow-hidden"
      style={{ maxWidth: "595px" }}
    >
      {/* Top accent bar */}
      <div className="h-1.5 bg-gradient-to-r from-neutral-900 via-neutral-700 to-neutral-900" />

      <div className="p-7 flex flex-col text-neutral-900">
        {/* Header */}
        <div className="flex items-start justify-between mb-7">
          <div>
            <h1 className="text-lg font-bold tracking-tight text-neutral-900">Lease Agreement</h1>
            <p className="text-[11px] text-neutral-400 mt-0.5 font-mono">
              Ref: OL-{agreement.id.slice(0, 8).toUpperCase()}
            </p>
          </div>
          {(() => {
            const p = statusPill(agreement.status);
            return (
              <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border ${p.box}`}>
                <div className={`w-1.5 h-1.5 rounded-full ${p.dot}`} />
                <span className={`text-[10px] font-semibold uppercase tracking-wider ${p.txt}`}>
                  {statusLabel(agreement.status)}
                </span>
              </div>
            );
          })()}
        </div>

        {/* Parties */}
        <div className="grid grid-cols-2 gap-4 mb-6 p-4 bg-neutral-50 rounded-xl">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 mb-1">
              Landlord
            </p>
            <p className="text-sm font-semibold text-neutral-900">{landlordName || "—"}</p>
            {contactLines(landlordName, landlordContact).map((line) => (
              <p key={line} className="text-[11px] text-neutral-500 mt-0.5 break-words">
                {line}
              </p>
            ))}
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 mb-1">
              Tenant
            </p>
            <p className="text-sm font-semibold text-neutral-900">{tenantName || "—"}</p>
            {contactLines(tenantName, tenantContact).map((line) => (
              <p key={line} className="text-[11px] text-neutral-500 mt-0.5 break-words">
                {line}
              </p>
            ))}
          </div>
        </div>

        {/* Property */}
        <div className="flex items-center gap-3 mb-6 p-4 bg-neutral-50 rounded-xl">
          <div className="w-10 h-10 rounded-lg bg-neutral-200 flex items-center justify-center flex-shrink-0">
            <Building size={18} className="text-neutral-500" />
          </div>
          <div>
            <p className="text-sm font-semibold text-neutral-900">{agreement.address}</p>
            <p className="text-xs text-neutral-500">{agreement.leaseType}</p>
          </div>
        </div>

        {/* Terms */}
        <div className="mb-6">
          <h2 className="text-[10px] font-bold uppercase text-neutral-400 mb-3 tracking-wider">
            Lease Terms
          </h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div className="flex justify-between border-b border-neutral-100 pb-2">
              <span className="text-neutral-500">Monthly Rent</span>
              <span className="font-semibold">{fmtMoney(agreement.monthlyRent)}</span>
            </div>
            <div className="flex justify-between border-b border-neutral-100 pb-2">
              <span className="text-neutral-500">Deposit</span>
              <span className="font-semibold">{fmtMoney(agreement.deposit)}</span>
            </div>
            <div className="flex justify-between border-b border-neutral-100 pb-2">
              <span className="text-neutral-500">Start Date</span>
              <span className="font-semibold">{formatDate(agreement.startDate)}</span>
            </div>
            <div className="flex justify-between border-b border-neutral-100 pb-2">
              <span className="text-neutral-500">End Date</span>
              <span className="font-semibold">{formatDate(agreement.endDate)}</span>
            </div>
            <div className="flex justify-between border-b border-neutral-100 pb-2">
              <span className="text-neutral-500">Notice Period</span>
              <span className="font-semibold">
                {orDash(
                  agreement.noticePeriodMonths,
                  agreement.noticePeriodMonths ? " Months" : "",
                )}
              </span>
            </div>
            <div className="flex justify-between border-b border-neutral-100 pb-2">
              <span className="text-neutral-500">Payment Day</span>
              <span className="font-semibold">
                {orDash(
                  agreement.paymentDayOfMonth,
                  agreement.paymentDayOfMonth ? "th of Month" : "",
                )}
              </span>
            </div>
            <div className="flex justify-between border-b border-neutral-100 pb-2">
              <span className="text-neutral-500">Payment Frequency</span>
              <span className="font-semibold">{cap(agreement.paymentFrequency)}</span>
            </div>
            <div className="flex justify-between border-b border-neutral-100 pb-2">
              <span className="text-neutral-500">Rental Duration</span>
              <span className="font-semibold">{fmtMonths(agreement.rentalDurationMonths)}</span>
            </div>
            <div className="flex justify-between border-b border-neutral-100 pb-2">
              <span className="text-neutral-500">Rent-Free Period</span>
              <span className="font-semibold">{fmtMonths(agreement.rentFreePeriodMonths)}</span>
            </div>
            <div className="flex justify-between border-b border-neutral-100 pb-2">
              <span className="text-neutral-500">Prepaid Rents</span>
              <span className="font-semibold">{fmtMonths(agreement.prepaidRents)}</span>
            </div>
            <div className="flex justify-between border-b border-neutral-100 pb-2 col-span-2">
              <span className="text-neutral-500">Auto-Renewal</span>
              <span className="font-semibold">{fmtAutoRenewal(agreement.autoRenewal)}</span>
            </div>
            <div className="flex justify-between border-b border-neutral-100 pb-2 col-span-2">
              <span className="text-neutral-500">Rent Increase</span>
              <span className="font-semibold text-right">
                {fmtIndexation(agreement.indexation)}
              </span>
            </div>
            {agreement.indexation?.nextIncreaseDate && (
              <div className="flex justify-between border-b border-neutral-100 pb-2 col-span-2">
                <span className="text-neutral-500">Next Increase</span>
                <span className="font-semibold text-right">
                  {fmtNextIncrease(agreement.indexation)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Terms & Conditions (free text) */}
        {agreement.termsAndConditions && (
          <div className="mb-6">
            <h2 className="text-[10px] font-bold uppercase text-neutral-400 mb-3 tracking-wider">
              Terms &amp; Conditions
            </h2>
            <p className="text-[13px] leading-relaxed text-neutral-700 whitespace-pre-wrap">
              {agreement.termsAndConditions}
            </p>
          </div>
        )}

        {/* Signature */}
        <div className="mt-2 pt-4 border-t border-neutral-200 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-neutral-100 flex items-center justify-center flex-shrink-0">
            <FileSignature size={16} className="text-neutral-400" />
          </div>
          <div>
            {agreement.signedAt ? (
              <>
                <p className="text-sm font-medium text-neutral-700">Signed electronically</p>
                <p className="text-[11px] text-neutral-400">{formatSignedAt(agreement.signedAt)}</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-neutral-700">Not yet signed</p>
                <p className="text-[11px] text-neutral-400">
                  Approve this agreement to sign it electronically
                </p>
              </>
            )}
          </div>
        </div>

        {/* Signed lease document — the owner-uploaded physical PDF. Shown to
            both personas (owner + tenant) whenever a copy is attached. Presence
            is keyed on the metadata (name/uploadedAt), which exists whenever the
            lease has an attachment; the href is a short-lived signed URL minted
            server-side (opening it in a new tab lets the browser's PDF viewer
            display or download it). If that URL is momentarily unavailable (a
            transient signing blip), we still show the file but as a non-clickable
            row with a retry hint rather than hiding it or rendering a dead link. */}
        {(() => {
          const hasDoc =
            !!agreement.documentUrl || !!agreement.documentName || !!agreement.documentUploadedAt;
          if (!hasDoc) return null;
          const meta =
            [
              agreement.documentSize ? formatBytes(agreement.documentSize) : null,
              agreement.documentUploadedAt
                ? `Uploaded ${formatDate(agreement.documentUploadedAt)}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || "PDF";
          const inner = (
            <>
              <div className="w-10 h-10 rounded-lg bg-neutral-100 flex items-center justify-center text-neutral-500 flex-shrink-0">
                <FileText size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-neutral-900 truncate">
                  {agreement.documentName || "Signed lease.pdf"}
                </p>
                <p className="text-[11px] text-neutral-500">
                  {agreement.documentUrl ? meta : `${meta} · link temporarily unavailable`}
                </p>
              </div>
              <span className="p-2 rounded-lg text-neutral-400 group-hover:text-neutral-900 transition flex-shrink-0">
                <Download size={16} />
              </span>
            </>
          );
          return (
            <div className="mt-5 pt-4 border-t border-neutral-200">
              <h2 className="text-[10px] font-bold uppercase text-neutral-400 mb-3 tracking-wider">
                Signed Lease Document
              </h2>
              {agreement.documentUrl ? (
                <a
                  href={agreement.documentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-3 rounded-xl border border-neutral-200 hover:bg-neutral-50 transition group"
                >
                  {inner}
                </a>
              ) : (
                <div className="flex items-center gap-3 p-3 rounded-xl border border-neutral-200 opacity-70">
                  {inner}
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
