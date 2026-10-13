import { useEffect, useState } from "react";
import { Printer, Pencil, MessageSquare, LogOut, Loader2 } from "lucide-react";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { Logo } from "@ui/components/Logo";
import { formatCurrencyCompact, formatDate } from "@ui/lib/format";
import { usePrivileges } from "@ui/lib/usePrivileges";

// The fields an owner can edit inline. All optional so a save only sends what
// changed; the server recomputes term + total value from the resolved dates.
export interface AgreementEditValues {
  monthlyRent?: number;
  deposit?: number;
  startDate?: string;
  endDate?: string;
}

interface AgreementModalProps {
  isOpen: boolean;
  onClose: () => void;
  agreement: any;
  // Owner-only controls. When omitted (the admin agreements view, or a granted
  // contact viewing someone else's portfolio) the modal stays a read-only
  // printable document. When provided, an action bar (Edit terms / Message
  // tenant / End tenancy) renders above the agreement and the core terms
  // become inline-editable.
  owner?: {
    onMessage: () => void;
    onEndTenancy: () => void;
    onSave: (values: AgreementEditValues) => Promise<void>;
  };
}

export function AgreementModal({ isOpen, onClose, agreement, owner }: AgreementModalProps) {
  const { canPlatform } = usePrivileges();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ monthlyRent: "", deposit: "", startDate: "", endDate: "" });

  // Whenever a different agreement opens (or the drawer reopens) drop back to
  // view mode and refill the edit fields from the latest data.
  useEffect(() => {
    setEditing(false);
    setSaving(false);
    if (agreement) {
      const rent = agreement.monthlyRent ?? agreement.rentAmount;
      const dep = agreement.deposit;
      setForm({
        monthlyRent: rent == null ? "" : String(rent),
        deposit: dep == null ? "" : String(dep),
        startDate: (agreement.startDate ?? "").slice(0, 10),
        endDate: (agreement.endDate ?? agreement.expiration ?? "").slice(0, 10),
      });
    }
  }, [agreement?.id, isOpen]);

  // Match AdminAgreementsPage policy: legal-only admins (e.g. paralegals)
  // see the agreement but the monetary fields are masked.
  const canSeeFinancials = canPlatform("finance.viewAll");
  if (!agreement) return null;

  // The modal is fed by two different API shapes — the admin agreements list
  // (`name`/`email`/`owner`/`propertyAddress`/`rentAmount`/`expiration`) and the
  // owner agreements list (`tenantName`/`tenantEmail`/`address`/`monthlyRent`/
  // `startDate`/`endDate`). Normalise both here so every field renders either way.
  const tenantName = agreement.name ?? agreement.tenantName ?? "";
  const tenantEmail = agreement.email ?? agreement.tenantEmail ?? "";
  const ownerName = agreement.owner ?? agreement.ownerName ?? "";
  const propertyAddress = agreement.propertyAddress ?? agreement.address ?? "";
  const rentValue = agreement.rentAmount ?? agreement.monthlyRent ?? 0;
  const totalValueRaw = agreement.agreementValue ?? 0;

  const monthlyRent = canSeeFinancials ? formatCurrencyCompact(rentValue) : "—";
  const totalValue = canSeeFinancials ? formatCurrencyCompact(totalValueRaw) : "—";

  // Prefer the owner shape's real lease dates; fall back to the admin shape,
  // which only carries the end date (`expiration`) and derives the start as one
  // year prior.
  const endDateRaw = agreement.endDate ?? agreement.expiration ?? null;
  const startDateRaw =
    agreement.startDate ??
    (endDateRaw
      ? (() => {
          const exp = new Date(endDateRaw);
          exp.setFullYear(exp.getFullYear() - 1);
          return exp.toISOString();
        })()
      : null);
  const startDate = startDateRaw ? formatDate(startDateRaw) : "-";
  const endDate = endDateRaw ? formatDate(endDateRaw) : "-";

  // Derive the term from the real dates when we have both, instead of assuming
  // a 12-month lease.
  const durationMonths =
    startDateRaw && endDateRaw
      ? Math.max(
          1,
          Math.round(
            (new Date(endDateRaw).getTime() - new Date(startDateRaw).getTime()) /
              (1000 * 60 * 60 * 24 * 30.44),
          ),
        )
      : 12;
  const durationLabel = `${durationMonths} month${durationMonths === 1 ? "" : "s"}`;

  // Closed leases are historical — their terms can't be edited (the server
  // enforces this too; the UI just hides the affordance).
  const status = agreement.status as string | undefined;
  const closed = status === "expired" || status === "terminated" || status === "declined";

  const rentNum = Number(form.monthlyRent);
  const depositNum = Number(form.deposit);
  const datesOk =
    !!form.startDate && !!form.endDate && Date.parse(form.endDate) > Date.parse(form.startDate);
  const canSave =
    !!form.monthlyRent &&
    Number.isFinite(rentNum) &&
    rentNum > 0 &&
    Number.isFinite(depositNum) &&
    depositNum >= 0 &&
    datesOk;

  const handleSave = async () => {
    if (!owner || !canSave) return;
    setSaving(true);
    try {
      await owner.onSave({
        monthlyRent: rentNum,
        deposit: depositNum,
        startDate: form.startDate,
        endDate: form.endDate,
      });
      setEditing(false);
    } catch {
      // The parent surfaces the error toast; stay in edit mode for retry.
    } finally {
      setSaving(false);
    }
  };

  // Footer: while editing, Save/Cancel. Otherwise the print control. Print
  // covers the download intent via "save as PDF" in the browser dialog until a
  // server-side PDF export ships.
  const footerContent = editing ? (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={() => setEditing(false)}
        disabled={saving}
        className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-secondary transition disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={handleSave}
        disabled={!canSave || saving}
        className="px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:opacity-90 transition disabled:opacity-50 inline-flex items-center gap-2"
      >
        {saving && <Loader2 size={16} className="animate-spin" />}
        {saving ? "Saving…" : "Save changes"}
      </button>
    </div>
  ) : (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={() => window.print()}
        aria-label="Print agreement"
        className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
        title="Print or save as PDF"
      >
        <Printer size={18} />
      </button>
    </div>
  );

  return (
    <ResponsiveDrawer
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={tenantName ? `Agreement — ${tenantName}` : "Agreement"}
      footer={footerContent}
      desktopMaxWidth="max-w-[800px]"
    >
      {/* Owner action bar — only present when the owner page wired up handlers.
     Hidden on print so a saved PDF shows just the agreement. */}
      {owner && !editing && (
        <div className="flex flex-wrap items-center gap-2 mb-4 print:hidden">
          {!closed && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition"
            >
              <Pencil size={16} /> Edit terms
            </button>
          )}
          <button
            type="button"
            onClick={owner.onMessage}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition"
          >
            <MessageSquare size={16} /> Message tenant
          </button>
          {status === "active" && (
            <button
              type="button"
              onClick={owner.onEndTenancy}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 transition sm:ml-auto"
            >
              <LogOut size={16} /> End tenancy
            </button>
          )}
        </div>
      )}

      {editing ? (
        /* Edit mode — compact form for the core lease terms. Replaces the A4
    document; Save/Cancel live in the footer. */
        <div className="bg-card w-full max-w-[210mm] mx-auto p-6 md:p-8 text-sm rounded-lg border border-border space-y-5">
          <div>
            <h3 className="text-base font-semibold text-foreground">Edit agreement terms</h3>
            <p className="text-xs text-muted-foreground mt-1">
              The total value and lease term update automatically from the rent and dates.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-xs font-semibold uppercase text-muted-foreground">
                Monthly rent (€)
              </span>
              <input
                type="number"
                min="0"
                inputMode="decimal"
                value={form.monthlyRent}
                onChange={(e) => setForm((f) => ({ ...f, monthlyRent: e.target.value }))}
                className="mt-1 w-full bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase text-muted-foreground">
                Deposit (€)
              </span>
              <input
                type="number"
                min="0"
                inputMode="decimal"
                value={form.deposit}
                onChange={(e) => setForm((f) => ({ ...f, deposit: e.target.value }))}
                className="mt-1 w-full bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase text-muted-foreground">
                Lease start
              </span>
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                className="mt-1 w-full bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase text-muted-foreground">
                Lease end
              </span>
              <input
                type="date"
                value={form.endDate}
                onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
                className="mt-1 w-full bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </label>
          </div>
          {!!form.startDate && !!form.endDate && !datesOk && (
            <p className="text-xs text-destructive">End date must be after the start date.</p>
          )}
        </div>
      ) : (
        <>
          {/* A4 Paper */}
          <div className="bg-card shadow-sm w-full max-w-[210mm] mx-auto p-6 md:p-12 text-sm text-foreground rounded-lg border border-border">
            <div className="flex justify-between items-start mb-12">
              <div>
                <Logo variant="wordmark" color="auto" className="h-8 w-auto mb-2" />
                <p className="text-muted-foreground">Property Management</p>
              </div>
              <div className="text-right">
                <h2 className="text-xl font-medium text-foreground mb-2">RENTAL AGREEMENT</h2>
                <div className="text-muted-foreground">
                  Ref: AGR-{agreement.id?.toString().padStart(4, "0")}
                </div>
                <div className="text-muted-foreground">Date: {startDate}</div>
              </div>
            </div>

            <div className="flex justify-between items-start mb-12">
              <div>
                <div className="font-semibold text-foreground mb-2">Tenant:</div>
                <div className="text-foreground font-medium">{tenantName || "-"}</div>
                <div className="text-muted-foreground">{tenantEmail}</div>
              </div>
              <div className="text-right">
                <div className="font-semibold text-foreground mb-2">Property Owner:</div>
                <div className="text-foreground font-medium">{ownerName || "-"}</div>
                <div className="text-muted-foreground">Managed via Olio Platform</div>
              </div>
            </div>

            <div className="mb-8 p-4 bg-muted/50 rounded-lg border border-border">
              <div className="font-semibold text-foreground mb-3">Property</div>
              <div className="text-foreground">{propertyAddress || "-"}</div>
            </div>

            <table className="w-full mb-8">
              <thead>
                <tr className="border-b-2 border-foreground">
                  <th className="py-3 text-left font-semibold text-foreground">Description</th>
                  <th className="py-3 text-right font-semibold text-foreground w-40">Details</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border">
                  <td className="py-4">
                    <div className="font-medium text-foreground">Monthly Rent</div>
                    <div className="text-muted-foreground mt-1 text-xs">
                      Payable on the 1st of each month
                    </div>
                  </td>
                  <td className="py-4 text-right font-medium">{monthlyRent}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="py-4">
                    <div className="font-medium text-foreground">Lease Start Date</div>
                  </td>
                  <td className="py-4 text-right font-medium">{startDate}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="py-4">
                    <div className="font-medium text-foreground">Lease End Date</div>
                  </td>
                  <td className="py-4 text-right font-medium">{endDate}</td>
                </tr>
              </tbody>
            </table>

            <div className="flex justify-end mb-12">
              <div className="w-64">
                <div className="flex justify-between py-2 border-b border-border">
                  <span className="text-muted-foreground">Monthly Rent</span>
                  <span className="font-medium">{monthlyRent}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-border">
                  <span className="text-muted-foreground">Duration</span>
                  <span className="font-medium">{durationLabel}</span>
                </div>
                <div className="flex justify-between py-3 border-b-2 border-foreground mt-1">
                  <span className="font-semibold text-foreground">Total Value</span>
                  <span className="font-bold text-foreground text-lg">{totalValue}</span>
                </div>
              </div>
            </div>

            <div className="mt-16 pt-8 border-t border-border text-center text-muted-foreground text-xs">
              <p>This agreement is managed through the Olio Property Management platform.</p>
              <p className="mt-1">For any inquiries, please contact support@oliowallet.com</p>
            </div>
          </div>
        </>
      )}
    </ResponsiveDrawer>
  );
}
