// Add tenant — /owner/tenants_leases/new (optional ?propertyId= preselect).
// Single-page form: tenant details, vacant property/unit, lease terms, an
// optional lease-end reminder and the tenant-portal invite. Creates the
// tenancy + agreement through POST /api/owner/agreements.
import { useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { X } from "lucide-react";

import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { Field, PillInput, PillSelect, PILL_SOLID } from "@/components/owner/property/ui";
import { useActivePortfolio } from "@/lib/activePortfolio";
import { useCreateAgreement, useOwnerProperties, type OwnerProperty } from "@/lib/ownerQueries";
import { useConfirm } from "@ui/components/common/ConfirmDialog";
import { useToast } from "@ui/hooks/use-toast";
import { parseApiError } from "@ui/lib/queryClient";
import { cn } from "@ui/lib/utils";
import { TENANTS_LEASES_PATH } from "./TenantsLeasesPage";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REMIND_MONTHS = 3;

const parseMoney = (s: string) => {
  const n = Number(s.replace(/[,\s€]/g, ""));
  return s.trim() === "" || !Number.isFinite(n) ? undefined : n;
};
const groupDigits = (s: string) => {
  const digits = s.replace(/[^\d]/g, "");
  return digits ? Number(digits).toLocaleString("en-GB") : "";
};
function monthsBetween(a: string, b: string): number | undefined {
  if (!a || !b) return undefined;
  // Lease end is inclusive: 1 Nov 2026 → 31 Oct 2027 is 12 months, so measure
  // to the day after the end date.
  const s = new Date(`${a}T00:00:00`);
  const e = new Date(`${b}T00:00:00`);
  e.setDate(e.getDate() + 1);
  let m = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  if (e.getDate() < s.getDate()) m -= 1;
  return m > 0 ? m : undefined;
}
function nextDueDate(day: number, start: string): string {
  const base = new Date(Math.max(Date.now(), start ? new Date(start).getTime() : 0));
  const d = new Date(base.getFullYear(), base.getMonth(), Math.min(day, 28));
  if (d < base) d.setMonth(d.getMonth() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function monthsBefore(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 - months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

// A rentable target: not held / owner-occupied, no live or pending tenant, and
// not a building that is split into units (tenants go on the units).
function isRentable(p: OwnerProperty, all: OwnerProperty[]): boolean {
  if (p.status === "inactive") return false;
  // The server refuses a tenant on a Building shell even before units exist.
  if (p.propertyType === "Building") return false;
  if (p.propertyUse === "hold" || p.propertyUse === "owner_occupied") return false;
  if (p.tenancyState && p.tenancyState !== "vacant") return false;
  if (p.occupied) return false;
  return !all.some((u) => u.parentPropertyId === p.id);
}

export default function AddTenantPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { toast } = useToast();
  const { confirm, dialog } = useConfirm();
  const { isSelf } = useActivePortfolio();
  const { data: properties = [] } = useOwnerProperties();
  const createAgreement = useCreateAgreement();

  const options = useMemo(() => {
    const byId = new Map(properties.map((p) => [p.id, p]));
    return properties
      .filter((p) => isRentable(p, properties))
      .map((p) => {
        const parent = p.parentPropertyId ? byId.get(p.parentPropertyId) : undefined;
        const base = parent
          ? `${parent.name || parent.address} · ${p.unitLabel || p.name || "Unit"}`
          : p.name || p.address;
        return { value: p.id, label: `${base} (vacant)`, rent: p.rentAmount };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [properties]);

  const [f, setF] = useState(() => ({
    first: "",
    last: "",
    email: "",
    phone: "",
    propertyId: new URLSearchParams(search).get("propertyId") ?? "",
    start: "",
    end: "",
    rent: "",
    dueDay: "1",
    deposit: "",
    advance: "0",
    remind: true,
    invite: true,
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [needsPayout, setNeedsPayout] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => {
    setDirty(true);
    setF((prev) => ({ ...prev, [k]: v }));
  };

  const rentNum = parseMoney(f.rent) ?? 0;
  const reminderDate = f.end ? monthsBefore(f.end, REMIND_MONTHS) : "";
  const canRemind = !!reminderDate && reminderDate > new Date().toISOString().slice(0, 10);
  const firstName = f.first.trim() || "the tenant";

  const close = async () => {
    if (
      dirty &&
      !(await confirm({
        title: "Leave without saving?",
        description: "This tenant hasn't been added yet.",
        confirmLabel: "Leave",
        cancelLabel: "Keep editing",
        tone: "destructive",
      }))
    )
      return;
    navigate(TENANTS_LEASES_PATH);
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!f.first.trim()) e.first = "Required";
    if (!f.last.trim()) e.last = "Required";
    if (!EMAIL_RE.test(f.email.trim())) e.email = "Enter a valid email";
    if (!f.propertyId) e.propertyId = "Pick a property or unit";
    if (!f.start) e.start = "Required";
    if (!f.end) e.end = "Required";
    else if (f.start && !monthsBetween(f.start, f.end))
      e.end = "Must be at least a month after the start";
    if (!(rentNum > 0)) e.rent = "Enter the monthly rent";
    if ((parseMoney(f.deposit) ?? 0) < 0) e.deposit = "Can't be negative";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = async () => {
    if (!validate()) return;
    setNeedsPayout(false);
    try {
      await createAgreement.mutateAsync({
        tenantEmail: f.email.trim().toLowerCase(),
        tenantName: `${f.first.trim()} ${f.last.trim()}`,
        ...(f.phone.trim() ? { tenantPhone: f.phone.trim() } : {}),
        sendInvite: f.invite,
        ...(canRemind && f.remind ? { endReminderDate: reminderDate } : {}),
        propertyId: f.propertyId,
        rentAmount: rentNum,
        deposit: parseMoney(f.deposit) ?? 0,
        startDate: f.start,
        nextPaymentDate: nextDueDate(Number(f.dueDay), f.start),
        prepaidRents: Number(f.advance) || 0,
        rentalDurationMonths: monthsBetween(f.start, f.end),
      });
      toast({
        title: "Tenant added",
        description: f.invite
          ? `${firstName} will get an email invite to the tenant portal.`
          : "You can invite them to the tenant portal later.",
      });
      setDirty(false);
      navigate(TENANTS_LEASES_PATH);
    } catch (err) {
      if (String((err as Error)?.message ?? "").includes("no_payment_method")) {
        setNeedsPayout(true);
        return;
      }
      toast({
        title: "Couldn't add tenant",
        description: parseApiError(err, "Please try again."),
        variant: "destructive",
      });
    }
  };

  if (!isSelf) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
        <p className="font-semibold">You can only add tenants to your own portfolio.</p>
        <Link href={TENANTS_LEASES_PATH} className={PILL_SOLID}>
          Back
        </Link>
      </div>
    );
  }

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      {dialog}
      <div className="mx-auto w-full max-w-[1440px]">
        <div className="flex items-center justify-between">
          <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
            <button type="button" onClick={() => void close()} className="hover:text-foreground">
              Tenants &amp; leases
            </button>{" "}
            › <span className="text-foreground/40">Add tenant</span>
          </nav>
          <button
            type="button"
            aria-label="Close"
            onClick={() => void close()}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[#111618] text-[#F4F4F2] hover:bg-[#1C2325] focus-visible:outline-2 focus-visible:outline-[#A78C68]"
          >
            <X size={18} />
          </button>
        </div>

        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="mx-auto mt-10 flex w-full max-w-[608px] flex-col gap-6"
        >
          <header>
            <h1 className="text-2xl font-semibold text-foreground/40">Add tenant</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Add their details and lease. Invite them to the tenant portal now or later.
            </p>
          </header>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="First name" error={errors.first}>
              <PillInput
                value={f.first}
                invalid={!!errors.first}
                autoComplete="off"
                onChange={(e) => set("first", e.target.value)}
              />
            </Field>
            <Field label="Last name" error={errors.last}>
              <PillInput
                value={f.last}
                invalid={!!errors.last}
                autoComplete="off"
                onChange={(e) => set("last", e.target.value)}
              />
            </Field>
            <Field label="Email" error={errors.email}>
              <PillInput
                type="email"
                value={f.email}
                invalid={!!errors.email}
                autoComplete="off"
                onChange={(e) => set("email", e.target.value)}
              />
            </Field>
            <Field label="Phone (optional)">
              <PillInput
                type="tel"
                value={f.phone}
                autoComplete="off"
                onChange={(e) => set("phone", e.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Property or unit"
            error={errors.propertyId}
            warning={
              options.length === 0
                ? "No vacant rentable properties. Add one under Portfolio first."
                : null
            }
          >
            <PillSelect
              value={f.propertyId}
              placeholder="Select a vacant property or unit"
              options={options}
              onChange={(v) => {
                set("propertyId", v);
                const o = options.find((x) => x.value === v);
                if (o?.rent && !f.rent) set("rent", groupDigits(String(o.rent)));
              }}
            />
          </Field>

          <section className="flex flex-col gap-4">
            <p className="text-xs text-foreground/30">Lease</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Lease start" error={errors.start}>
                <PillInput
                  type="date"
                  value={f.start}
                  invalid={!!errors.start}
                  onChange={(e) => set("start", e.target.value)}
                />
              </Field>
              <Field label="Lease end" error={errors.end}>
                <PillInput
                  type="date"
                  value={f.end}
                  min={f.start || undefined}
                  invalid={!!errors.end}
                  onChange={(e) => set("end", e.target.value)}
                />
              </Field>
              <Field label="Monthly rent (€)" error={errors.rent}>
                <PillInput
                  inputMode="numeric"
                  value={f.rent}
                  invalid={!!errors.rent}
                  onChange={(e) => set("rent", groupDigits(e.target.value))}
                />
              </Field>
              <Field label="Rent due day">
                <PillSelect
                  value={f.dueDay}
                  onChange={(v) => set("dueDay", v)}
                  options={Array.from({ length: 28 }, (_, i) => ({
                    value: String(i + 1),
                    label: `${ordinal(i + 1)} of the month`,
                  }))}
                />
              </Field>
              <Field label="Deposit (€)" error={errors.deposit}>
                <PillInput
                  inputMode="numeric"
                  value={f.deposit}
                  onChange={(e) => set("deposit", groupDigits(e.target.value))}
                />
              </Field>
              <Field label="Advance payment (months)">
                <PillSelect
                  value={f.advance}
                  onChange={(v) => set("advance", v)}
                  options={[0, 1, 2, 3, 6].map((n) => ({
                    value: String(n),
                    label:
                      n === 0
                        ? "None"
                        : `${n} month${n > 1 ? "s" : ""}${rentNum ? ` · €${(n * rentNum).toLocaleString("en-GB")}` : ""}`,
                  }))}
                />
              </Field>
            </div>
          </section>

          <div className="flex flex-col gap-3">
            {canRemind ? (
              <Checkbox
                checked={f.remind}
                onChange={(v) => set("remind", v)}
                label={`Remind me ${REMIND_MONTHS} months before the lease ends (${fmtDate(reminderDate)})`}
              />
            ) : null}
            <Checkbox
              checked={f.invite}
              onChange={(v) => set("invite", v)}
              label={`Email ${firstName} an invite to the tenant portal`}
            />
            <p className="rounded-2xl bg-[#111618] px-4 py-3 text-xs leading-relaxed text-[#C9CCCE]">
              {f.invite
                ? `${firstName === "the tenant" ? "The tenant" : firstName} gets an email inviting them to Nuleeo. They create an account and see their lease, rent due dates and payment details. Until they log in, rent reminders go by email.`
                : "No invite will be sent now. You can invite them from Tenants & leases at any time; until they log in, rent reminders go by email."}
            </p>
          </div>

          {needsPayout ? (
            <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
              Add a payout method first so your tenant has somewhere to pay rent.{" "}
              <Link href="/banking" className="font-medium underline">
                Open Banking
              </Link>
            </div>
          ) : null}

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => void close()}
              className={cn(PILL_SOLID, "px-6 py-2.5")}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createAgreement.isPending}
              className="flex-1 rounded-full py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted/60 disabled:opacity-50"
            >
              {createAgreement.isPending ? "Saving…" : "Save tenant"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 text-sm text-foreground/70">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 accent-[#111618]"
      />
      {label}
    </label>
  );
}
