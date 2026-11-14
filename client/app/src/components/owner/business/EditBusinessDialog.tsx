import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@ui/components/ui/dialog";
import { parseApiError } from "@ui/lib/queryClient";
import { useToast } from "@ui/hooks/use-toast";
import type { Entity } from "@shared/firestore-schema";
import {
  BUSINESS_COUNTRIES,
  BUSINESS_FIELD_MAX,
  BUSINESS_SECTORS,
  BUSINESS_TYPES,
  BUSINESS_TYPE_LABEL,
  VAT_FILING_PERIODS,
  VAT_FILING_PERIOD_LABEL,
  entityToWizardData,
  validateWizardStep,
  type BusinessWizardData,
  type FieldErrors,
} from "@shared/businesses";
import { useUpdateBusiness } from "@/lib/businesses";

const INPUT =
  "h-11 w-full rounded-2xl bg-[#1C2325] px-4 text-sm text-[#F4F4F2] placeholder:text-[#7D8287] [color-scheme:dark] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function F({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-[#A3A7AB]">
        {label}
      </label>
      {children}
      {error && <p className="text-xs text-[#FF7A7A]">{error}</p>}
    </div>
  );
}

// Edit business details. Same rules as wizard steps 1–2 (shared validation),
// re-checked server-side on PATCH.
export function EditBusinessDialog({
  business,
  open,
  onOpenChange,
}: {
  business: Entity;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const update = useUpdateBusiness(business.id);
  const { toast } = useToast();
  const [d, setD] = useState<BusinessWizardData>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setD(entityToWizardData(business));
    setErrors({});
    setError(null);
  }, [open, business]);

  const set = <K extends keyof BusinessWizardData>(k: K, v: BusinessWizardData[K]) => {
    setD((p) => ({ ...p, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };
  const [m = "", day = ""] = (d.financialYearEnd ?? "").split("-");
  const setYe = (mm: string, dd: string) => {
    if (!mm) return set("financialYearEnd", undefined);
    const max = DAYS[Number(mm) - 1];
    set("financialYearEnd", `${mm}-${dd && Number(dd) <= max ? dd : String(max).padStart(2, "0")}`);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs = { ...validateWizardStep(1, d), ...validateWizardStep(2, d) };
    if (Object.keys(errs).length) return setErrors(errs);
    setError(null);
    // Send every editable field so cleared optionals are cleared server-side.
    update.mutate(
      {
        businessType: d.businessType,
        legalName: d.legalName ?? "",
        tradingName: d.tradingName ?? "",
        country: d.country,
        registrationNumber: d.registrationNumber ?? "",
        sector: d.sector,
        vatRegistered: d.vatRegistered,
        vatNumber: d.vatNumber ?? "",
        vatFilingPeriod: d.vatFilingPeriod,
        financialYearEnd: d.financialYearEnd,
        accountantEmail: d.accountantEmail ?? "",
      },
      {
        onSuccess: () => {
          toast({ title: "Business updated" });
          onOpenChange(false);
        },
        onError: (err) => setError(parseApiError(err, "Couldn't save changes")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-[560px] overflow-y-auto rounded-3xl border-0 bg-[#111618] p-7 text-[#F4F4F2]">
        <DialogHeader className="text-left">
          <DialogTitle className="text-xl font-semibold">Edit business details</DialogTitle>
          <DialogDescription className="text-sm text-[#A3A7AB]">
            Changes apply everywhere this business appears.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <F id="eb-type" label="Business type" error={errors.businessType}>
            <select
              id="eb-type"
              className={INPUT}
              value={d.businessType ?? ""}
              onChange={(e) =>
                set(
                  "businessType",
                  (e.target.value || undefined) as BusinessWizardData["businessType"],
                )
              }
            >
              <option value="">Choose…</option>
              {BUSINESS_TYPES.map((t) => (
                <option key={t} value={t}>
                  {BUSINESS_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </F>
          <F id="eb-country" label="Country" error={errors.country}>
            <select
              id="eb-country"
              className={INPUT}
              value={d.country ?? ""}
              onChange={(e) => set("country", e.target.value || undefined)}
            >
              <option value="">Choose…</option>
              {BUSINESS_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </F>
          <F id="eb-legal" label="Legal name" error={errors.legalName}>
            <input
              id="eb-legal"
              className={INPUT}
              maxLength={BUSINESS_FIELD_MAX.legalName}
              value={d.legalName ?? ""}
              onChange={(e) => set("legalName", e.target.value)}
            />
          </F>
          <F id="eb-trading" label="Trading name (optional)" error={errors.tradingName}>
            <input
              id="eb-trading"
              className={INPUT}
              maxLength={BUSINESS_FIELD_MAX.tradingName}
              value={d.tradingName ?? ""}
              onChange={(e) => set("tradingName", e.target.value)}
            />
          </F>
          <F
            id="eb-reg"
            label={`Registration number${d.businessType === "SELF_EMPLOYED" ? " (optional)" : ""}`}
            error={errors.registrationNumber}
          >
            <input
              id="eb-reg"
              className={INPUT}
              maxLength={BUSINESS_FIELD_MAX.registrationNumber}
              value={d.registrationNumber ?? ""}
              onChange={(e) => set("registrationNumber", e.target.value)}
            />
          </F>
          <F id="eb-sector" label="Sector" error={errors.sector}>
            <select
              id="eb-sector"
              className={INPUT}
              value={d.sector ?? ""}
              onChange={(e) =>
                set("sector", (e.target.value || undefined) as BusinessWizardData["sector"])
              }
            >
              <option value="">Choose…</option>
              {BUSINESS_SECTORS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </F>
          <F id="eb-vat" label="VAT registered" error={errors.vatRegistered}>
            <select
              id="eb-vat"
              className={INPUT}
              value={d.vatRegistered == null ? "" : d.vatRegistered ? "yes" : "no"}
              onChange={(e) =>
                set("vatRegistered", e.target.value === "" ? undefined : e.target.value === "yes")
              }
            >
              <option value="">Choose…</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </F>
          <F id="eb-ye" label="Financial year end" error={errors.financialYearEnd}>
            <div className="grid grid-cols-2 gap-2">
              <select
                id="eb-ye"
                aria-label="Month"
                className={INPUT}
                value={m}
                onChange={(e) => setYe(e.target.value, day)}
              >
                <option value="">Month</option>
                {MONTHS.map((x, i) => (
                  <option key={x} value={String(i + 1).padStart(2, "0")}>
                    {x}
                  </option>
                ))}
              </select>
              <select
                aria-label="Day"
                className={INPUT}
                value={day}
                disabled={!m}
                onChange={(e) => setYe(m, e.target.value)}
              >
                {Array.from({ length: m ? DAYS[Number(m) - 1] : 31 }, (_, i) => (
                  <option key={i} value={String(i + 1).padStart(2, "0")}>
                    {i + 1}
                  </option>
                ))}
              </select>
            </div>
          </F>
          {d.vatRegistered && (
            <>
              <F id="eb-vatno" label="VAT number" error={errors.vatNumber}>
                <input
                  id="eb-vatno"
                  className={INPUT}
                  maxLength={BUSINESS_FIELD_MAX.vatNumber}
                  value={d.vatNumber ?? ""}
                  onChange={(e) => set("vatNumber", e.target.value)}
                />
              </F>
              <F id="eb-period" label="Filing period" error={errors.vatFilingPeriod}>
                <select
                  id="eb-period"
                  className={INPUT}
                  value={d.vatFilingPeriod ?? ""}
                  onChange={(e) =>
                    set(
                      "vatFilingPeriod",
                      (e.target.value || undefined) as BusinessWizardData["vatFilingPeriod"],
                    )
                  }
                >
                  <option value="">Choose…</option>
                  {VAT_FILING_PERIODS.map((p) => (
                    <option key={p} value={p}>
                      {VAT_FILING_PERIOD_LABEL[p]}
                    </option>
                  ))}
                </select>
              </F>
            </>
          )}
          <div className="sm:col-span-2">
            <F id="eb-acc" label="Accountant email (optional)" error={errors.accountantEmail}>
              <input
                id="eb-acc"
                type="email"
                className={INPUT}
                maxLength={BUSINESS_FIELD_MAX.accountantEmail}
                value={d.accountantEmail ?? ""}
                onChange={(e) => set("accountantEmail", e.target.value)}
              />
            </F>
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-2xl bg-[#FF7A7A]/10 px-4 py-3 text-sm text-[#FF7A7A] sm:col-span-2"
            >
              {error}
            </p>
          )}
          <div className="flex gap-3 sm:col-span-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="h-11 rounded-full bg-white/[0.08] px-6 text-sm font-semibold hover:bg-white/[0.12]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={update.isPending}
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-white text-sm font-semibold text-[#060A0B] hover:brightness-95 disabled:opacity-60"
            >
              {update.isPending && (
                <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              )}
              Save changes
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
