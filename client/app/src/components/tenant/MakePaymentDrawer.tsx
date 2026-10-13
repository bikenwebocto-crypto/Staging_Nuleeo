import { useState } from "react";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { apiRequest } from "@ui/lib/queryClient";
import { dateInputToIso } from "@ui/lib/format";
import { useQueryClient } from "@tanstack/react-query";
import {
  CreditCard,
  Landmark,
  Banknote,
  FileText,
  ChevronRight,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Check,
  Info,
} from "lucide-react";
import type { TxPaymentMethod } from "@shared/firestore-schema";
import { monthsPerPeriod, useOwnerBankDetails, type TenantRentedUnit } from "@/lib/tenantQueries";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unit: TenantRentedUnit | null;
}

type Step = "choose" | "card" | "offline" | "success";

const OFFLINE_METHODS: { value: TxPaymentMethod; label: string; icon: typeof Landmark }[] = [
  { value: "bank_transfer", label: "Bank transfer", icon: Landmark },
  { value: "cash", label: "Cash", icon: Banknote },
  { value: "check", label: "Check", icon: FileText },
  { value: "other", label: "Other", icon: FileText },
];

export function MakePaymentDrawer({ open, onOpenChange, unit }: Props) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("choose");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Offline form state
  const [amount, setAmount] = useState<string>("");
  const [method, setMethod] = useState<TxPaymentMethod | null>(null);
  const [paidAt, setPaidAt] = useState<string>(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");

  // The whole-period charge. Non-monthly leases (quarterly/yearly) bill a
  // full period per payment — the cycle clock advances a whole period — so
  // both the card checkout (computed server-side, identically) and the
  // offline drawer must charge rent × monthsPerPeriod, not a single month.
  const periods = monthsPerPeriod(unit?.paymentFrequency);
  const periodAmount = unit ? unit.rentAmount * periods : 0;

  function reset() {
    setStep("choose");
    setError(null);
    setSubmitting(false);
    setAmount("");
    setMethod(null);
    setPaidAt(new Date().toISOString().slice(0, 10));
    setNotes("");
  }

  function handleClose(next: boolean) {
    onOpenChange(next);
    if (!next) setTimeout(reset, 200);
  }

  function openOffline() {
    // Prefill the whole-period amount (rent × periods) so it matches what the
    // card path charges. Editable — the tenant may pay a different amount.
    if (unit) setAmount(String(periodAmount));
    setStep("offline");
    setError(null);
  }

  async function payWithCard() {
    if (!unit) return;
    setSubmitting(true);
    setError(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("payment", "success");
      url.searchParams.set("unit", unit.unitId);
      const cancelUrl = window.location.href;
      const res = await apiRequest("POST", "/api/tenant/payment/checkout", {
        unitId: unit.unitId,
        successUrl: url.toString(),
        cancelUrl,
      });
      const data = (await res.json()) as { url: string };
      window.location.assign(data.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start checkout");
      setSubmitting(false);
    }
  }

  async function submitOffline() {
    if (!unit || !method) return;
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) {
      setError("Enter a valid amount");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest("POST", "/api/tenant/payment/log", {
        unitId: unit.unitId,
        amount: amt,
        method,
        // The form only collects a calendar date; anchor it to the current
        // local time so the record reflects a real moment, not midnight UTC
        // (which would render as "03:00" in Cyprus). See dateInputToIso.
        paidAt: dateInputToIso(paidAt),
        notes,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/tenant/activity"] });
      setStep("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to record payment");
    } finally {
      setSubmitting(false);
    }
  }

  const titleByStep: Record<Step, string> = {
    choose: "Make a Payment",
    card: "Pay with card",
    offline: "Record offline payment",
    success: "Payment recorded",
  };

  return (
    <ResponsiveDrawer
      open={open}
      onOpenChange={handleClose}
      title={titleByStep[step]}
      subtitle={unit?.name}
      onBack={
        step === "offline" || step === "card"
          ? () => {
              setStep("choose");
              setError(null);
            }
          : undefined
      }
    >
      {step === "choose" && (
        <div className="space-y-3 py-2">
          <button
            onClick={payWithCard}
            disabled={submitting}
            className="w-full text-left p-4 rounded-2xl border border-border bg-card hover:bg-muted/40 transition flex items-center gap-3 disabled:opacity-50"
          >
            <div className="w-10 h-10 rounded-xl bg-foreground text-background flex items-center justify-center">
              {submitting ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <CreditCard size={18} />
              )}
            </div>
            <div className="flex-1">
              <div className="font-semibold text-sm text-foreground">
                Pay with card
                {unit && (
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    €{periodAmount.toLocaleString()}
                    {periods > 1 && ` (${periods} months)`}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                Stripe Checkout — auto-confirmed when paid
              </div>
            </div>
            <ChevronRight size={18} className="text-muted-foreground" />
          </button>

          <button
            onClick={openOffline}
            className="w-full text-left p-4 rounded-2xl border border-border bg-card hover:bg-muted/40 transition flex items-center gap-3"
          >
            <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-500 flex items-center justify-center">
              <Landmark size={18} />
            </div>
            <div className="flex-1">
              <div className="font-semibold text-sm text-foreground">Record offline payment</div>
              <div className="text-xs text-muted-foreground">
                Bank transfer, cash, etc. — pending until your landlord verifies
              </div>
            </div>
            <ChevronRight size={18} className="text-muted-foreground" />
          </button>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-500 text-xs">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      )}

      {step === "offline" && unit && (
        <div className="space-y-4 pb-2">
          <div>
            <label className="text-xs font-semibold text-foreground mb-1.5 block uppercase tracking-wide">
              Amount (€)
              {periods > 1 && (
                <span className="ml-1.5 font-normal normal-case tracking-normal text-muted-foreground">
                  ({periods} months)
                </span>
              )}
            </label>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={String(periodAmount)}
              className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-foreground/20"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-foreground mb-1.5 block uppercase tracking-wide">
              Method
            </label>
            <div className="grid grid-cols-2 gap-2">
              {OFFLINE_METHODS.map((m) => {
                const Icon = m.icon;
                const active = method === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setMethod(m.value)}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition ${
                      active
                        ? "border-foreground bg-foreground/5 text-foreground"
                        : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60"
                    }`}
                  >
                    <Icon size={16} />
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* When the tenant picks "Bank transfer", surface the owner's saved
              IBAN so they know where to send the money — or prompt them to ask
              the owner if none is on file. Mounts only on selection, so the
              IBAN is fetched lazily, not on every dashboard visit. */}
          {method === "bank_transfer" && <BankTransferPanel unitId={unit.unitId} />}

          <div>
            <label className="text-xs font-semibold text-foreground mb-1.5 block uppercase tracking-wide">
              Date paid
            </label>
            <input
              type="date"
              value={paidAt}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setPaidAt(e.target.value)}
              className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-foreground/20"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-foreground mb-1.5 block uppercase tracking-wide">
              Notes (optional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Reference number, anything your landlord should know"
              maxLength={500}
              rows={3}
              className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-foreground/20 resize-none"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-500 text-xs">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              This payment will show as <strong>pending</strong> until your landlord confirms it.
            </span>
          </div>

          <button
            onClick={submitOffline}
            disabled={!amount || !method || submitting}
            className="w-full bg-foreground text-background font-bold py-3.5 rounded-2xl text-sm hover:opacity-90 transition active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {submitting && <Loader2 size={16} className="animate-spin" />}
            {submitting ? "Recording…" : "Record payment"}
          </button>
        </div>
      )}

      {step === "success" && (
        <div className="py-10 flex flex-col items-center text-center">
          <div className="w-14 h-14 rounded-full bg-green-500/15 border border-green-500/30 flex items-center justify-center mb-4">
            <CheckCircle2 size={26} className="text-green-500" />
          </div>
          <h3 className="text-lg font-bold text-foreground mb-1.5">Payment recorded</h3>
          <p className="text-sm text-muted-foreground max-w-xs">
            Your landlord will verify this and mark it as completed in your activity feed.
          </p>
          <button
            onClick={() => handleClose(false)}
            className="mt-6 bg-foreground text-background font-semibold px-6 py-2.5 rounded-xl text-sm hover:opacity-90 transition"
          >
            Done
          </button>
        </div>
      )}
    </ResponsiveDrawer>
  );
}

// The owner's bank-transfer details, shown inside the offline drawer when the
// tenant selects "Bank transfer". Loads lazily (mounts only on selection) via
// the tenant-scoped /payment-details endpoint. Falls back to a prompt when the
// owner hasn't saved an IBAN yet.
function BankTransferPanel({ unitId }: { unitId: string }) {
  const { data, isLoading, isError } = useOwnerBankDetails(unitId);
  const bankDetails = data?.bankDetails ?? null;
  const [copied, setCopied] = useState<string | null>(null);

  function copy(value: string, field: string) {
    void navigator.clipboard?.writeText(value);
    setCopied(field);
    setTimeout(() => setCopied((c) => (c === field ? null : c)), 1500);
  }

  // Group the stored (space-stripped) IBAN into 4s for readability; the copy
  // button still copies the raw value so it pastes cleanly into a bank form.
  const prettyIban = bankDetails?.iban.replace(/(.{4})/g, "$1 ").trim() ?? "";

  // Same neutral "ask the owner" prompt whether no IBAN is on file or the
  // lookup failed — either way the tenant can't transfer yet, and they
  // shouldn't see a raw error here.
  const noDetails = (
    <div className="flex items-start gap-2 text-xs text-muted-foreground">
      <Info size={14} className="mt-0.5 shrink-0" />
      <span>Contact the property owner to provide the IBAN or account number.</span>
    </div>
  );

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3.5 space-y-2.5">
      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
          <Loader2 size={14} className="animate-spin" />
          Loading bank details…
        </div>
      ) : bankDetails && !isError ? (
        <>
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground uppercase tracking-wide">
            <Landmark size={13} />
            Transfer to
          </div>
          {bankDetails.holder && <BankRow label="Account holder" value={bankDetails.holder} />}
          <BankRow
            label="IBAN"
            value={prettyIban}
            copyValue={bankDetails.iban}
            field="iban"
            copied={copied}
            onCopy={copy}
          />
          {bankDetails.swift && (
            <BankRow
              label="SWIFT / BIC"
              value={bankDetails.swift}
              copyValue={bankDetails.swift}
              field="swift"
              copied={copied}
              onCopy={copy}
            />
          )}
          <p className="text-[11px] leading-snug text-muted-foreground pt-0.5">
            Send the transfer from your bank, then record it below so your landlord can confirm
            receipt.
          </p>
        </>
      ) : (
        noDetails
      )}
    </div>
  );
}

function BankRow({
  label,
  value,
  copyValue,
  field,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copyValue?: string;
  field?: string;
  copied?: string | null;
  onCopy?: (value: string, field: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-sm font-medium text-foreground break-all">{value}</div>
      </div>
      {copyValue && field && onCopy && (
        <button
          type="button"
          onClick={() => onCopy(copyValue, field)}
          aria-label={`Copy ${label}`}
          className="shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition"
        >
          {copied === field ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
        </button>
      )}
    </div>
  );
}
