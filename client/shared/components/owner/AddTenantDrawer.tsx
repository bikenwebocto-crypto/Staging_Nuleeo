import { useState, useEffect } from "react";
import { Home, Euro, Calendar, Clock, RefreshCw, FileText, Mail, CheckCircle2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@ui/hooks/use-toast";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import { useAuth } from "@ui/lib/useAuth";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { useUnsavedChangesGuard } from "@ui/components/common/useUnsavedChangesGuard";
import { DateField } from "@ui/components/common/DateField";

// Mirror the server's tenant-email check (server/routes/portfolio.ts) so a
// malformed address fails here — inline, before submit — instead of only on a
// server round-trip after the owner finishes the whole multi-stage flow.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface OwnerPropertyOption {
  id: string;
  address: string;
  unitCount?: number;
  occupied?: boolean;
  propertyUse?: "hold" | "rent" | "owner_occupied";
}

interface AddTenantDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  propertyAddress?: string;
}

export function AddTenantDrawer({ open, onOpenChange, propertyAddress }: AddTenantDrawerProps) {
  const { toast } = useToast();
  const { firebaseUser } = useAuth();
  const qc = useQueryClient();
  const [addStage, setAddStage] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedPropertyId, setSelectedPropertyId] = useState("");

  // Real owner properties for the dropdown. Self-portfolio only — cross-
  // portfolio tenant creation from this drawer isn't supported in v1.
  const { data: ownerProperties = [] } = useQuery<OwnerPropertyOption[]>({
    queryKey: ["/api/owner/properties"],
    enabled: !!firebaseUser && open,
  });

  // A property held for investment or owner-occupied has no tenant to assign,
  // and an already-occupied one can't take a second live tenant (the server
  // 409s on it), so keep both out of the picker — the only addable target is a
  // rented (or unset) VACANT property. Mirrors the gating on the property pages.
  const selectableProperties = ownerProperties.filter(
    (p) => p.propertyUse !== "hold" && p.propertyUse !== "owner_occupied" && !p.occupied,
  );

  const addStageMeta = [
    { id: 1, title: "Basics", hint: "Tenant & Property" },
    { id: 2, title: "Financials", hint: "Rent & Deposit" },
    { id: 3, title: "Dates", hint: "Start & Payments" },
    { id: 4, title: "Terms", hint: "Duration & Renewal" },
    { id: 5, title: "Indexation", hint: "CPI Terms" },
    { id: 6, title: "Finish", hint: "Documents & Send" },
  ] as const;

  const totalAddStages = addStageMeta.length;

  // Form State
  const [tenantEmail, setTenantEmail] = useState("");
  const [needsPayoutMethod, setNeedsPayoutMethod] = useState(false);
  const [property, setProperty] = useState(propertyAddress || "");
  const [deposit, setDeposit] = useState("");
  const [rentAmount, setRentAmount] = useState("");
  const [signatureDate, setSignatureDate] = useState("");
  const [startDate, setStartDate] = useState("");
  const [nextPaymentDate, setNextPaymentDate] = useState("");
  const [prepaidRents, setPrepaidRents] = useState("");
  const [rentFreePeriod, setRentFreePeriod] = useState("");
  const [paymentFrequency, setPaymentFrequency] = useState("monthly");
  const [rentalDuration, setRentalDuration] = useState("12");
  const [noticePeriod, setNoticePeriod] = useState("");
  const [autoRenewal, setAutoRenewal] = useState("none");
  const [cpiType, setCpiType] = useState("fixed");
  const [ownerIndexation, setOwnerIndexation] = useState("");
  const [indexationDelay, setIndexationDelay] = useState("");
  const [indexationFrequency, setIndexationFrequency] = useState("yearly");
  const [termsAndConditions, setTermsAndConditions] = useState("");

  // Treat the form as dirty once the user has typed anything that isn't
  // a default. Used to warn before drawer close so a 6-stage flow isn't
  // silently discarded.
  const isDirty =
    tenantEmail.trim().length > 0 ||
    (!propertyAddress && property.trim().length > 0) ||
    deposit.trim().length > 0 ||
    rentAmount.trim().length > 0 ||
    signatureDate.length > 0 ||
    startDate.length > 0 ||
    nextPaymentDate.length > 0 ||
    prepaidRents.trim().length > 0 ||
    rentFreePeriod.trim().length > 0 ||
    paymentFrequency !== "monthly" ||
    rentalDuration !== "12" ||
    noticePeriod.length > 0 ||
    autoRenewal !== "none" ||
    cpiType !== "fixed" ||
    ownerIndexation.trim().length > 0 ||
    indexationDelay.trim().length > 0 ||
    indexationFrequency !== "yearly" ||
    termsAndConditions.trim().length > 0;

  const { guardClose, guardDialog } = useUnsavedChangesGuard(isDirty);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      onOpenChange(true);
    } else {
      // Don't let the drawer close (X / overlay / Escape) while the create is in
      // flight — closing mid-submit drops the form and races the request.
      if (isSubmitting) return;
      guardClose(() => onOpenChange(false));
    }
  };

  useEffect(() => {
    if (open) {
      if (propertyAddress) {
        setProperty(propertyAddress);
      }
      setAddStage(1);
    } else {
      // Reset form
      setTimeout(() => setAddStage(1), 300);
      setTenantEmail("");
      setNeedsPayoutMethod(false);
      setDeposit("");
      setRentAmount("");
      setSignatureDate("");
      setStartDate("");
      setNextPaymentDate("");
      setPrepaidRents("");
      setRentFreePeriod("");
      setPaymentFrequency("monthly");
      setRentalDuration("12");
      setNoticePeriod("");
      setAutoRenewal("none");
      setCpiType("fixed");
      setOwnerIndexation("");
      setIndexationDelay("");
      setIndexationFrequency("yearly");
      setTermsAndConditions("");
      setSelectedPropertyId("");
      setIsSubmitting(false);
    }
  }, [open, propertyAddress]);

  // Preselect the property whose address matches the prop, once both the
  // dropdown data and the prop are available.
  useEffect(() => {
    if (!open || !propertyAddress || selectableProperties.length === 0) return;
    const match = selectableProperties.find((p) => p.address === propertyAddress);
    if (match) setSelectedPropertyId(match.id);
  }, [open, propertyAddress, selectableProperties]);

  const isStageValid = () => {
    if (addStage === 1) return EMAIL_RE.test(tenantEmail.trim()) && !!selectedPropertyId;
    // Rent must be a positive number — a blank/0/non-numeric value used to pass
    // this gate (non-empty check) and only fail on the final server round-trip.
    if (addStage === 2) return !!deposit.trim() && Number(deposit) >= 0 && Number(rentAmount) > 0;
    if (addStage === 3) return !!signatureDate && !!startDate && !!nextPaymentDate;
    if (addStage === 4) return true;
    if (addStage === 5) return true;
    if (addStage === 6) return true;
    return false;
  };

  const nextStage = () => {
    if (!isStageValid()) {
      toast({
        title: "Missing details",
        description: "Please complete the required fields to continue.",
      });
      return;
    }
    setAddStage((s) => Math.min(totalAddStages, s + 1));
  };

  const prevStage = () => setAddStage((s) => Math.max(1, s - 1));

  const handleSave = async () => {
    if (!selectedPropertyId) {
      toast({ title: "Pick a property", variant: "destructive" });
      return;
    }
    // Mirror the server's email check so a bad address surfaces inline before
    // we submit, rather than failing on the round-trip after a 6-stage flow.
    if (!EMAIL_RE.test(tenantEmail.trim())) {
      setAddStage(1);
      toast({
        title: "Enter a valid tenant email",
        description: "e.g. tenant@example.com",
        variant: "destructive",
      });
      return;
    }
    const rentNum = Number(rentAmount);
    const depositNum = Number(deposit);
    // Server rejects a negative deposit; guard here so we don't round-trip.
    if (Number.isFinite(depositNum) && depositNum < 0) {
      setAddStage(2);
      toast({ title: "Deposit can't be negative", variant: "destructive" });
      return;
    }
    const durationNum = Number(rentalDuration);
    const noticeNum = Number(noticePeriod);
    const prepaidNum = Number(prepaidRents);
    // Form collects rentFreePeriod as free text ("e.g. 1 month"); pull leading digits.
    const rentFreeMatch = rentFreePeriod.match(/\d+/);
    const rentFreeNum = rentFreeMatch ? Number(rentFreeMatch[0]) : NaN;
    // Treat a BLANK field as "not set" (undefined), not 0 — Number("") is 0,
    // which previously persisted a phantom "Fixed 0%" indexation clause and a
    // zero freeze period (first increase on the signing date).
    const ownerIdxNum = ownerIndexation.trim() === "" ? NaN : Number(ownerIndexation);
    const indexationDelayNum = indexationDelay.trim() === "" ? NaN : Number(indexationDelay);

    // Map the form's autoRenewal vocabulary to the schema enum.
    //   "none" → none
    //   "same" → auto (renew for the same duration)
    //   "3"/"6"/…/"36" → fixed, carrying the chosen term in fixedRenewalMonths
    //     (previously the number was dropped, so every fixed lease renewed for
    //     the full rentalDuration regardless of the owner's pick).
    let autoRenewalEnum: "none" | "auto" | "fixed" = "none";
    let fixedRenewalMonths: number | undefined;
    if (autoRenewal === "same") {
      autoRenewalEnum = "auto";
    } else if (autoRenewal !== "none") {
      autoRenewalEnum = "fixed";
      const n = Number(autoRenewal);
      if (Number.isInteger(n) && n > 0) fixedRenewalMonths = n;
    }

    // Indexation frequency only carries monthly/quarterly/yearly to the server.
    const idxFreq = (["monthly", "quarterly", "yearly"] as const).includes(
      indexationFrequency as any,
    )
      ? (indexationFrequency as "monthly" | "quarterly" | "yearly")
      : "yearly";

    const body: Record<string, unknown> = {
      tenantEmail: tenantEmail.trim().toLowerCase(),
      propertyId: selectedPropertyId,
      rentAmount: Number.isFinite(rentNum) ? rentNum : 0,
      deposit: Number.isFinite(depositNum) ? depositNum : 0,
      startDate,
      signatureDate: signatureDate || undefined,
      nextPaymentDate: nextPaymentDate || undefined,
      prepaidRents: Number.isFinite(prepaidNum) ? prepaidNum : undefined,
      rentFreePeriodMonths: Number.isFinite(rentFreeNum) ? rentFreeNum : undefined,
      paymentFrequency,
      rentalDurationMonths: Number.isFinite(durationNum) ? durationNum : undefined,
      noticePeriodMonths: Number.isFinite(noticeNum) && noticeNum > 0 ? noticeNum : undefined,
      autoRenewal: autoRenewalEnum,
      fixedRenewalMonths,
      cpiType: cpiType || undefined,
      ownerIndexation: Number.isFinite(ownerIdxNum) ? ownerIdxNum : undefined,
      indexationDelay: Number.isFinite(indexationDelayNum) ? indexationDelayNum : undefined,
      indexationFrequency: idxFreq,
      termsAndConditions: termsAndConditions.trim() || undefined,
    };

    try {
      setIsSubmitting(true);
      const res = await apiRequest("POST", "/api/owner/agreements", body);
      const data = (await res.json()) as { inviteLink: string | null };
      if (data.inviteLink) {
        try {
          await navigator.clipboard.writeText(data.inviteLink);
        } catch {}
        toast({
          title: "Agreement created",
          description: "Password-setup link copied to clipboard — share it with the tenant.",
        });
      } else {
        toast({
          title: "Agreement created",
          description:
            "The tenant already has an account; they'll see the agreement on next sign-in.",
        });
      }
      qc.invalidateQueries({ queryKey: ["/api/owner/agreements"] });
      qc.invalidateQueries({ queryKey: ["/api/owner/tenants"] });
      qc.invalidateQueries({ queryKey: ["/api/owner/properties"] });
      qc.invalidateQueries({ queryKey: ["/api/owner/summary"] });
      onOpenChange(false);
    } catch (err) {
      const msg = parseApiError(err, "Could not create agreement");
      // parseApiError surfaces the message but drops the `code` field on the
      // JSON body, which we need to branch on. Peek at the raw message and
      // parse the body after the leading "${status}: " prefix.
      let code: string | undefined;
      const raw = (err as { message?: string } | null)?.message ?? "";
      const bodyStart = raw.indexOf(": ");
      const body = bodyStart >= 0 ? raw.slice(bodyStart + 2) : raw;
      try {
        code = JSON.parse(body)?.code;
      } catch {}
      if (code === "no_payment_method") {
        // Stay in the drawer and surface an inline prompt — the form
        // state is preserved so the owner can hit Banking, add a payout,
        // and come back without re-keying everything.
        setNeedsPayoutMethod(true);
      } else {
        toast({ title: "Could not create agreement", description: msg, variant: "destructive" });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const footer = (
    <div className="flex gap-3">
      <button
        onClick={() => {
          if (addStage > 1) prevStage();
          else onOpenChange(false);
        }}
        disabled={isSubmitting}
        className="px-6 py-3 rounded-xl bg-secondary text-muted-foreground font-bold hover:bg-secondary transition disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {addStage > 1 ? "Back" : "Cancel"}
      </button>

      {addStage < totalAddStages ? (
        <button
          onClick={nextStage}
          className="flex-1 font-bold text-base py-3 rounded-xl shadow-lg transition active:scale-[0.98] bg-primary text-primary-foreground shadow-primary/30 hover:bg-primary/90"
        >
          Continue
        </button>
      ) : (
        <button
          onClick={handleSave}
          disabled={isSubmitting}
          className="flex-1 font-bold text-base py-3 rounded-xl shadow-lg transition active:scale-[0.98] bg-primary text-primary-foreground shadow-primary/30 hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isSubmitting ? "Creating…" : "Send Agreement"}
        </button>
      )}
    </div>
  );

  return (
    <>
      {guardDialog}
      <ResponsiveDrawer
        open={open}
        onOpenChange={handleOpenChange}
        title="Add Agreement"
        footer={footer}
      >
        {/* Progress Bar */}
        <div className="-mx-6 px-6 pb-4 mb-4 border-b border-border md:-mx-8 md:px-8">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-muted-foreground/70 uppercase tracking-wider">
              Step {addStage} of {totalAddStages}
            </span>
            <span className="text-xs font-bold text-primary">
              {addStageMeta[addStage - 1].title}
            </span>
          </div>
          <div className="w-full bg-secondary h-2 rounded-full overflow-hidden">
            <div
              className="bg-primary h-full rounded-full transition-all duration-500 ease-out"
              style={{ width: `${(addStage / totalAddStages) * 100}%` }}
            />
          </div>
        </div>

        <div>
          {/* STAGE 1: Basics */}
          {addStage === 1 && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground ml-1">Tenant Email</label>
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70">
                    <Mail size={18} />
                  </div>
                  <input
                    type="email"
                    value={tenantEmail}
                    onChange={(e) => setTenantEmail(e.target.value)}
                    placeholder="tenant@example.com"
                    className="w-full bg-background border border-border rounded-xl pl-11 pr-4 py-3.5 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium"
                  />
                </div>
                {tenantEmail.trim() !== "" && !EMAIL_RE.test(tenantEmail.trim()) ? (
                  <p className="text-[10px] text-destructive ml-1">
                    Enter a valid email, e.g. tenant@example.com
                  </p>
                ) : (
                  <p className="text-[10px] text-muted-foreground/70 ml-1">
                    We'll send an email with a confirmation button.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground ml-1">Property</label>
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70">
                    <Home size={18} />
                  </div>
                  <select
                    value={selectedPropertyId}
                    onChange={(e) => {
                      setSelectedPropertyId(e.target.value);
                      const match = selectableProperties.find((p) => p.id === e.target.value);
                      setProperty(match?.address ?? "");
                    }}
                    className="w-full bg-background border border-border rounded-xl pl-11 pr-4 py-3.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium appearance-none"
                  >
                    <option value="" disabled>
                      {selectableProperties.length === 0
                        ? "No rentable properties yet"
                        : "Select Property"}
                    </option>
                    {selectableProperties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.address}
                      </option>
                    ))}
                  </select>
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground/70">
                    <svg
                      width="12"
                      height="8"
                      viewBox="0 0 12 8"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M1 1.5L6 6.5L11 1.5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STAGE 2: Financials */}
          {addStage === 2 && (
            <div className="grid grid-cols-1 gap-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground ml-1">Deposit</label>
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70">
                    <Euro size={16} />
                  </div>
                  <input
                    type="number"
                    min="0"
                    value={deposit}
                    onChange={(e) => setDeposit(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-background border border-border rounded-xl pl-10 pr-3 py-3.5 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium"
                  />
                </div>
                {deposit.trim() !== "" && Number(deposit) < 0 && (
                  <p className="text-[10px] text-destructive ml-1">Deposit can't be negative.</p>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground ml-1">Rent Amount</label>
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70">
                    <Euro size={16} />
                  </div>
                  <input
                    type="number"
                    value={rentAmount}
                    onChange={(e) => setRentAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-background border border-border rounded-xl pl-10 pr-3 py-3.5 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium"
                  />
                </div>
              </div>
            </div>
          )}

          {/* STAGE 3: Dates */}
          {addStage === 3 && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="grid grid-cols-1 gap-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold text-foreground ml-1">
                    Signature Date
                  </label>
                  <div className="relative">
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70">
                      <Calendar size={16} />
                    </div>
                    <DateField
                      value={signatureDate}
                      onChange={setSignatureDate}
                      className="w-full bg-background border border-border rounded-xl pl-9 pr-3 py-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium text-sm"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold text-foreground ml-1">Start Date</label>
                  <div className="relative">
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70">
                      <Calendar size={16} />
                    </div>
                    <DateField
                      value={startDate}
                      onChange={setStartDate}
                      className="w-full bg-background border border-border rounded-xl pl-9 pr-3 py-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium text-sm"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between ml-1 mb-1">
                  <label className="text-sm font-semibold text-foreground">Next Rent Payment</label>
                  <span className="text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded-full font-bold tracking-wider uppercase">
                    via platform
                  </span>
                </div>
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70">
                    <Calendar size={18} />
                  </div>
                  <DateField
                    value={nextPaymentDate}
                    onChange={setNextPaymentDate}
                    className="w-full bg-background border border-border rounded-xl pl-11 pr-4 py-3.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground ml-1">Prepaid Rents</label>
                <input
                  type="number"
                  value={prepaidRents}
                  onChange={(e) => setPrepaidRents(e.target.value)}
                  placeholder="Number of months"
                  className="w-full bg-background border border-border rounded-xl px-4 py-3.5 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium"
                />
              </div>
            </div>
          )}

          {/* STAGE 4: Terms */}
          {addStage === 4 && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground ml-1">
                  Rent Free Period
                </label>
                <input
                  type="text"
                  value={rentFreePeriod}
                  onChange={(e) => setRentFreePeriod(e.target.value)}
                  placeholder="e.g. 1 month"
                  className="w-full bg-background border border-border rounded-xl px-4 py-3.5 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground ml-1">
                  Frequency of Payment
                </label>
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70">
                    <RefreshCw size={18} />
                  </div>
                  <select
                    value={paymentFrequency}
                    onChange={(e) => setPaymentFrequency(e.target.value)}
                    className="w-full bg-background border border-border rounded-xl pl-11 pr-4 py-3.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium appearance-none"
                  >
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground/70">
                    <svg
                      width="12"
                      height="8"
                      viewBox="0 0 12 8"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M1 1.5L6 6.5L11 1.5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground ml-1">
                  Rental Duration
                </label>
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70">
                    <Clock size={18} />
                  </div>
                  <select
                    value={rentalDuration}
                    onChange={(e) => setRentalDuration(e.target.value)}
                    className="w-full bg-background border border-border rounded-xl pl-11 pr-4 py-3.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium appearance-none"
                  >
                    <option value="3">3 Months</option>
                    <option value="6">6 Months</option>
                    <option value="9">9 Months</option>
                    <option value="12">12 Months</option>
                    <option value="18">18 Months</option>
                    <option value="24">24 Months</option>
                    <option value="36">36 Months</option>
                  </select>
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground/70">
                    <svg
                      width="12"
                      height="8"
                      viewBox="0 0 12 8"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M1 1.5L6 6.5L11 1.5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground ml-1">Notice Period</label>
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70">
                    <Clock size={18} />
                  </div>
                  <select
                    value={noticePeriod}
                    onChange={(e) => setNoticePeriod(e.target.value)}
                    className="w-full bg-background border border-border rounded-xl pl-11 pr-4 py-3.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium appearance-none"
                  >
                    <option value="">No notice period</option>
                    <option value="1">1 Month</option>
                    <option value="2">2 Months</option>
                    <option value="3">3 Months</option>
                    <option value="6">6 Months</option>
                    <option value="12">12 Months</option>
                  </select>
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground/70">
                    <svg
                      width="12"
                      height="8"
                      viewBox="0 0 12 8"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M1 1.5L6 6.5L11 1.5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground/70 ml-1">
                  Months of notice required to end the lease. Shown on the agreement.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground ml-1">
                  Auto Renewal Period
                </label>
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70">
                    <RefreshCw size={18} />
                  </div>
                  <select
                    value={autoRenewal}
                    onChange={(e) => setAutoRenewal(e.target.value)}
                    className="w-full bg-background border border-border rounded-xl pl-11 pr-4 py-3.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium appearance-none"
                  >
                    <option value="none">No auto renewal</option>
                    <option value="same">Same as rental duration</option>
                    <option value="3">3 Months</option>
                    <option value="6">6 Months</option>
                    <option value="9">9 Months</option>
                    <option value="12">12 Months</option>
                    <option value="18">18 Months</option>
                    <option value="24">24 Months</option>
                    <option value="36">36 Months</option>
                  </select>
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground/70">
                    <svg
                      width="12"
                      height="8"
                      viewBox="0 0 12 8"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M1 1.5L6 6.5L11 1.5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-foreground ml-1">
                  Terms &amp; Conditions
                </label>
                <textarea
                  value={termsAndConditions}
                  onChange={(e) => setTermsAndConditions(e.target.value)}
                  rows={5}
                  placeholder="Any clauses, house rules, or special conditions the tenant should agree to…"
                  className="w-full bg-background border border-border rounded-xl px-4 py-3.5 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium resize-none leading-relaxed"
                />
                <p className="text-[10px] text-muted-foreground/70 ml-1">
                  Shown on the tenant's agreement and downloadable PDF.
                </p>
              </div>
            </div>
          )}

          {/* STAGE 5: Indexation */}
          {addStage === 5 && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="p-4 bg-background rounded-xl border border-border space-y-4">
                <h3 className="font-bold text-foreground flex items-center gap-2">
                  <FileText size={18} /> Indexation Terms
                </h3>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    CPI Type
                  </label>
                  <select
                    value={cpiType}
                    onChange={(e) => setCpiType(e.target.value)}
                    className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary transition"
                  >
                    <option value="fixed">Fixed %</option>
                    <option value="cpi">CPI (Inflation)</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Owner Indexation
                  </label>
                  <input
                    type="text"
                    value={ownerIndexation}
                    onChange={(e) => setOwnerIndexation(e.target.value)}
                    placeholder="%"
                    className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary transition"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Indexation Delay
                  </label>
                  <input
                    type="text"
                    value={indexationDelay}
                    onChange={(e) => setIndexationDelay(e.target.value)}
                    placeholder="Months"
                    className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary transition"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Indexation Frequency
                  </label>
                  <select
                    value={indexationFrequency}
                    onChange={(e) => setIndexationFrequency(e.target.value)}
                    className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary transition"
                  >
                    <option value="yearly">Yearly</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* STAGE 6: Finish */}
          {addStage === 6 && !needsPayoutMethod && (
            <div className="space-y-6 text-center py-6 animate-in fade-in duration-300">
              <div className="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-4 animate-in zoom-in duration-300">
                <CheckCircle2 size={40} />
              </div>
              <h3 className="text-2xl font-bold text-foreground">Agreement Ready!</h3>
              <p className="text-muted-foreground max-w-sm mx-auto">
                We'll send the invite to your tenant. You can attach contracts and IDs after they
                accept — from the property's Documents tab.
              </p>
            </div>
          )}

          {addStage === 6 && needsPayoutMethod && (
            <div className="space-y-5 text-center py-6 animate-in fade-in duration-300">
              <div className="w-20 h-20 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mx-auto mb-2">
                <Euro size={36} />
              </div>
              <h3 className="text-2xl font-bold text-foreground">Add a payout method first</h3>
              <p className="text-muted-foreground max-w-sm mx-auto">
                Your tenant needs somewhere to pay rent — connect Stripe or add an IBAN under
                Banking, then come back and send the agreement.
              </p>
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  window.location.assign("/banking");
                }}
                className="px-6 py-3 rounded-xl bg-primary text-primary-foreground font-bold shadow-lg shadow-primary/30 hover:bg-primary/90 transition"
              >
                Open Banking
              </button>
            </div>
          )}
        </div>
      </ResponsiveDrawer>
    </>
  );
}
