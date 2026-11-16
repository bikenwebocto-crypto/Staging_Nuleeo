// "Complete profile" wizard — /properties/:id/profile?step=1..6
//
// Each step owns a local draft. Save & continue PATCHes that one section
// (/api/properties/:id/profile/:section — the server validates, stores and
// recalculates profileCompletion); Skip moves on with no API call. Closing
// with unsaved changes asks first. Step 6 uploads save immediately.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useRoute, useSearch } from "wouter";
import { Check, Plus, Sparkles, Trash2, Upload, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import {
  useOwnerProperty,
  useOwnerTenants,
  useOwnerAgreements,
  type OwnerPropertyDetail,
} from "@/lib/ownerQueries";
import { useActivePortfolio } from "@/lib/activePortfolio";
import { useEntities } from "@/lib/entities";
import {
  Field,
  PillInput,
  PillSelect,
  Segmented,
  PILL_SOLID,
  formatDay,
  money,
  moneyFull,
  pct,
} from "@/components/owner/property/ui";
import { AddTenantDrawer } from "@ui/components/owner/AddTenantDrawer";
import { useConfirm } from "@ui/components/common/ConfirmDialog";
import { useToast } from "@ui/hooks/use-toast";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import { uploadPropertyDocument } from "@ui/lib/uploadPropertyDocument";
import { cn } from "@ui/lib/utils";
import {
  PROFILE_DOC_LABELS,
  PROFILE_DOC_TYPES,
  PROFILE_SECTIONS,
  PROFILE_SECTION_LABELS,
  ownerShareTotal,
  resolveRentalUse,
  type ProfileDocType,
  type ProfileOwner,
  type ProfileSection,
  type ProfileUtility,
  type RentalUse,
} from "@shared/propertyProfile";

const STEP_TITLES: Record<ProfileSection, string> = {
  details: "Property details",
  ownership: "Ownership",
  financing: "Financing",
  use: "Use",
  costs: "Running costs",
  documents: "Documents",
};
const UNLOCKS: Record<ProfileSection, string> = {
  details: "Better valuation estimates and yield per m²",
  ownership: "Each owner's share of income and value",
  financing: "Real cash flow after the mortgage, loan-to-value and equity",
  use: "The right rent tracking, reminders and reports for how the property is used",
  costs: "Expense forecast and payment reminders",
  documents: "Everything in one place for your accountant, bank or a buyer",
};
const FLOORS = ["Ground", ...Array.from({ length: 30 }, (_, i) => ordinal(i + 1)), "Penthouse"];
const ENERGY = ["A+", "A", "B", "C", "D", "E", "F", "G"];
const BANKS = [
  "Bank of Cyprus",
  "Hellenic Bank",
  "Eurobank Cyprus",
  "Alpha Bank Cyprus",
  "AstroBank",
  "Ancoria Bank",
  "Housing Finance Corporation",
];
const UPLOAD_TYPES = ["application/pdf", "image/jpeg", "image/png"];
const UPLOAD_MAX = 10 * 1024 * 1024;
const FILE_ERROR = "Use a PDF, JPG or PNG under 10 MB.";

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
const numOrUndef = (s: string) => (s.trim() === "" ? undefined : Number(s));
const todayIso = () => new Date().toISOString().slice(0, 10);

// ── Shared step chrome ─────────────────────────────────────────────────

interface StepProps {
  property: OwnerPropertyDetail;
  onDirty: (dirty: boolean) => void;
  // Registers the submit handler the footer's Save button calls. Returns the
  // body to PATCH, or null when client validation failed.
  registerSubmit: (fn: () => Record<string, unknown> | null) => void;
}

export default function PropertyProfileWizard() {
  const [, params] = useRoute("/properties/:id/profile");
  const id = params?.id;
  const search = useSearch();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const { isSelf } = useActivePortfolio();
  const { data: property, isLoading } = useOwnerProperty(id);

  const steps = property?.profileSteps ?? {};
  const requested = Number(new URLSearchParams(search).get("step"));
  const firstIncomplete = Math.max(
    0,
    PROFILE_SECTIONS.findIndex((s) => !steps[s]),
  );
  const index = requested >= 1 && requested <= 6 ? requested - 1 : property ? firstIncomplete : 0;
  const section = PROFILE_SECTIONS[index];

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const submitRef = useRef<() => Record<string, unknown> | null>(() => null);

  useEffect(() => setDirty(false), [index]);

  // Warn on tab close / reload with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const propertyUrl = `/properties/${id}`;
  const name = property?.name?.trim() || property?.address || "Property";
  const goStep = (i: number) => navigate(`/properties/${id}/profile?step=${i + 1}`);

  const leaveGuard = async () => {
    if (!dirty) return true;
    return confirm({
      title: "Leave without saving?",
      description: "Changes on this step will be lost.",
      confirmLabel: "Leave",
      cancelLabel: "Keep editing",
      tone: "destructive",
    });
  };

  const exit = async (toastProgress: boolean) => {
    if (!(await leaveGuard())) return;
    await qc.invalidateQueries({ queryKey: [`/api/properties/${id}`] });
    const fresh = qc.getQueryData<OwnerPropertyDetail>([`/api/properties/${id}`]);
    const pctDone = fresh?.profileCompletion ?? property?.profileCompletion ?? 0;
    if (toastProgress) {
      toast(
        pctDone >= 100
          ? { title: "✓ Profile complete", description: `${name} is fully set up.` }
          : { title: "Progress saved", description: `Profile ${pctDone}% complete.` },
      );
    }
    navigate(propertyUrl);
  };

  const save = async () => {
    const body = submitRef.current();
    if (!body || !property) return;
    setSaving(true);
    try {
      const res = await apiRequest("PATCH", `/api/properties/${id}/profile/${section}`, body);
      const updated = (await res.json()) as OwnerPropertyDetail;
      qc.setQueryData<OwnerPropertyDetail>([`/api/properties/${id}`], (old) =>
        old ? { ...old, ...updated } : old,
      );
      void qc.invalidateQueries({ queryKey: ["/api/owner/properties"] });
      setDirty(false);
      toast({
        title: "Saved",
        description: `${PROFILE_SECTION_LABELS[section]} added to ${name}.`,
      });
      if (index < 5) goStep(index + 1);
    } catch (err) {
      const msg = parseApiError(err, "");
      toast({
        title: "Couldn't save",
        description: msg || "Check your connection and try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <div className="mx-auto h-96 max-w-[640px] animate-pulse rounded-[24px] bg-muted" />
      </div>
    );
  }
  if (!property || !isSelf) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
        <p className="font-semibold">
          {property ? "This property is read-only for you." : "Property not found"}
        </p>
        <Link href={property ? propertyUrl : "/portfolios"} className={PILL_SOLID}>
          Back
        </Link>
      </div>
    );
  }

  const stepProps: StepProps = {
    property,
    onDirty: setDirty,
    registerSubmit: (fn) => {
      submitRef.current = fn;
    },
  };

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      {dialog}
      <div className="mx-auto w-full max-w-[1440px]">
        <div className="flex items-center justify-between">
          <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
            <button
              type="button"
              onClick={() => void exit(false)}
              className="hover:text-foreground"
            >
              {name}
            </button>{" "}
            › <span className="text-foreground/60">Complete profile</span>
          </nav>
          <button
            type="button"
            aria-label="Close"
            onClick={() => void exit(true)}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[#111618] text-[#F4F4F2] hover:bg-[#1C2325] focus-visible:outline-2 focus-visible:outline-[#A78C68]"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mx-auto mt-8 w-full max-w-[608px]">
          <h1 className="text-2xl font-semibold text-foreground/80">Complete profile · {name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every step is optional. Use Nuleeo with no details and add them whenever you like.
          </p>

          {/* Stepper */}
          <ol className="mt-6 grid grid-cols-6 gap-1 text-center">
            {PROFILE_SECTIONS.map((s, i) => {
              const done = !!steps[s];
              const current = i === index;
              const clickable = done || current;
              return (
                <li key={s}>
                  <button
                    type="button"
                    disabled={!clickable}
                    onClick={async () => {
                      if (i !== index && (await leaveGuard())) goStep(i);
                    }}
                    aria-current={current ? "step" : undefined}
                    className="flex w-full flex-col items-center gap-1 rounded-lg py-1 disabled:cursor-default"
                  >
                    <span
                      className={cn("text-sm", current ? "font-semibold" : "text-muted-foreground")}
                    >
                      {done && !current ? <Check size={14} aria-label="Done" /> : i + 1}
                    </span>
                    <span
                      className={cn(
                        "text-[11px] leading-tight",
                        current ? "text-foreground/50" : "text-muted-foreground",
                      )}
                    >
                      {PROFILE_SECTION_LABELS[s]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          <p className="mt-8 text-xs text-muted-foreground">Step {index + 1} of 6</p>
          <h2 className="text-xl font-semibold text-foreground/70">{STEP_TITLES[section]}</h2>
          <p className="mt-3 flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
            <Sparkles size={14} aria-hidden="true" /> Unlocks: {UNLOCKS[section]}
          </p>

          <div className="mt-5" key={section}>
            {section === "details" ? <DetailsStep {...stepProps} /> : null}
            {section === "ownership" ? <OwnershipStep {...stepProps} /> : null}
            {section === "financing" ? <FinancingStep {...stepProps} confirm={confirm} /> : null}
            {section === "use" ? <UseStep {...stepProps} /> : null}
            {section === "costs" ? <CostsStep {...stepProps} /> : null}
            {section === "documents" ? <DocumentsStep property={property} /> : null}
          </div>

          {/* Footer */}
          <div className="mt-8 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={async () => {
                if (index === 0) return void exit(false);
                if (await leaveGuard()) goStep(index - 1);
              }}
              className={PILL_SOLID}
            >
              {index === 0 ? "Cancel" : "Back"}
            </button>
            {section === "documents" ? (
              <button
                type="button"
                onClick={() => void exit(true)}
                className="px-4 py-2 font-medium"
              >
                Finish
              </button>
            ) : (
              <button
                type="button"
                disabled={saving}
                onClick={() => void save()}
                className="px-4 py-2 font-medium disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save & continue"}
              </button>
            )}
          </div>
          <div className="mt-4 text-center">
            {section === "documents" ? (
              <button
                type="button"
                onClick={() => void exit(true)}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Finish later
              </button>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  if (await leaveGuard()) goStep(index + 1);
                }}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Skip for now
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Small hook: a draft object + dirty flag pushed to the parent.
function useDraft<T>(initial: T, onDirty: (d: boolean) => void) {
  const [draft, setDraft] = useState<T>(initial);
  const set = <K extends keyof T>(k: K, v: T[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    onDirty(true);
  };
  return [draft, set, setDraft] as const;
}

// ── Step 1 · Details ───────────────────────────────────────────────────

function DetailsStep({ property, onDirty, registerSubmit }: StepProps) {
  const d = property.profile?.details;
  const [f, set] = useDraft(
    {
      sqm: property.sqm ?? "",
      veranda: d?.verandaSqm != null ? String(d.verandaSqm) : "",
      bedrooms: property.bedrooms != null ? String(property.bedrooms) : "",
      bathrooms: property.baths != null ? String(property.baths) : "",
      floor: property.floor ?? "",
      yearBuilt: property.builtYear ?? "",
      parking: property.parking != null ? property.parking > 0 : undefined,
      storage: property.storageUnit,
      furnished: d?.furnished,
      energyClass: property.energyClass ?? "",
      energyExpiry: d?.energyExpiry ?? "",
      deedRef: d?.titleDeedReference ?? "",
      deedPending: property.titleDeedsStatus === "pending",
    },
    onDirty,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const thisYear = new Date().getFullYear();

  registerSubmit(() => {
    const e: Record<string, string> = {};
    const sqm = numOrUndef(f.sqm);
    if (sqm !== undefined && (!(sqm > 0) || sqm > 10000))
      e.sqm = "Enter a size between 1 and 10,000 m².";
    const ver = numOrUndef(f.veranda);
    if (ver !== undefined && !(ver >= 0)) e.veranda = "Can't be negative.";
    for (const k of ["bedrooms", "bathrooms"] as const) {
      const n = numOrUndef(f[k]);
      if (n !== undefined && (!Number.isInteger(n) || n < 0 || n > 50)) e[k] = "Enter 0–50.";
    }
    const y = numOrUndef(f.yearBuilt);
    if (y !== undefined) {
      if (y > thisYear) e.yearBuilt = "Year built can't be in the future.";
      else if (!Number.isInteger(y) || y < 1800) e.yearBuilt = "Enter a year from 1800.";
    }
    if (!f.deedPending && !f.deedRef.trim())
      e.deedRef = "Add the title deed reference, or mark it as not issued yet.";
    setErrors(e);
    if (Object.keys(e).length) return null;
    return {
      sqm,
      verandaSqm: ver,
      bedrooms: numOrUndef(f.bedrooms),
      bathrooms: numOrUndef(f.bathrooms),
      floor: f.floor || undefined,
      yearBuilt: y,
      parking: f.parking,
      storage: f.storage,
      furnished: f.furnished,
      energyClass: f.energyClass || undefined,
      energyExpiry: f.energyExpiry || undefined,
      titleDeedStatus: f.deedPending ? "pending" : "issued",
      titleDeedReference: f.deedPending ? undefined : f.deedRef.trim(),
    };
  });

  const yesNo = [
    { value: "yes" as const, label: "Yes" },
    { value: "no" as const, label: "No" },
  ];
  const yn = (b: boolean | undefined) => (b === undefined ? undefined : b ? "yes" : "no");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Internal size" error={errors.sqm}>
          <PillInput
            inputMode="decimal"
            suffix="m²"
            value={f.sqm}
            invalid={!!errors.sqm}
            onChange={(e) => set("sqm", e.target.value)}
          />
        </Field>
        <Field label="Covered veranda" error={errors.veranda}>
          <PillInput
            inputMode="decimal"
            suffix="m²"
            value={f.veranda}
            invalid={!!errors.veranda}
            onChange={(e) => set("veranda", e.target.value)}
          />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Bedrooms" error={errors.bedrooms}>
          <PillInput
            inputMode="numeric"
            value={f.bedrooms}
            invalid={!!errors.bedrooms}
            onChange={(e) => set("bedrooms", e.target.value)}
          />
        </Field>
        <Field label="Bathrooms" error={errors.bathrooms}>
          <PillInput
            inputMode="numeric"
            value={f.bathrooms}
            invalid={!!errors.bathrooms}
            onChange={(e) => set("bathrooms", e.target.value)}
          />
        </Field>
        <Field label="Floor">
          <PillSelect
            value={f.floor}
            onChange={(v) => set("floor", v)}
            placeholder="Select"
            options={FLOORS.map((x) => ({ value: x, label: x }))}
          />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Year built" error={errors.yearBuilt}>
          <PillInput
            inputMode="numeric"
            value={f.yearBuilt}
            invalid={!!errors.yearBuilt}
            onChange={(e) => set("yearBuilt", e.target.value)}
          />
        </Field>
        <Field label="Parking">
          <Segmented
            label="Parking"
            value={yn(f.parking)}
            options={yesNo}
            onChange={(v) => set("parking", v === "yes")}
          />
        </Field>
        <Field label="Storage">
          <Segmented
            label="Storage"
            value={yn(f.storage)}
            options={yesNo}
            onChange={(v) => set("storage", v === "yes")}
          />
        </Field>
      </div>
      <Field label="Furnished">
        <Segmented
          label="Furnished"
          value={f.furnished}
          onChange={(v) => set("furnished", v)}
          options={[
            { value: "furnished", label: "Furnished" },
            { value: "part", label: "Part-furnished" },
            { value: "unfurnished", label: "Unfurnished" },
          ]}
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Energy certificate rating">
          <PillSelect
            value={f.energyClass}
            onChange={(v) => set("energyClass", v)}
            placeholder="Select"
            options={ENERGY.map((x) => ({ value: x, label: x }))}
          />
        </Field>
        <Field
          label="Certificate expiry"
          warning={
            f.energyExpiry && f.energyExpiry < todayIso() ? "This certificate has expired." : null
          }
        >
          <PillInput
            type="date"
            value={f.energyExpiry}
            onChange={(e) => set("energyExpiry", e.target.value)}
          />
        </Field>
      </div>
      <Field label="Title deed / land registry reference" error={errors.deedRef}>
        <PillInput
          value={f.deedPending ? "" : f.deedRef}
          disabled={f.deedPending}
          invalid={!!errors.deedRef}
          placeholder={f.deedPending ? "Not issued yet" : "e.g. 0/12345 · Limassol"}
          onChange={(e) => set("deedRef", e.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={f.deedPending}
          onChange={(e) => set("deedPending", e.target.checked)}
          className="h-4 w-4 accent-[#111618]"
        />
        Title deed not issued yet
      </label>
    </div>
  );
}

// ── Step 2 · Ownership ────────────────────────────────────────────────

function OwnershipStep({ property, onDirty, registerSubmit }: StepProps) {
  const { data: entityData } = useEntities();
  const entities = entityData?.entities ?? [];
  const initialOwners: ProfileOwner[] =
    property.profile?.ownership?.owners ??
    (property.ownershipType === "company" && property.companyName
      ? [
          {
            type: "company",
            name: property.companyName,
            entityId: property.entityId,
            sharePct: 100,
          },
        ]
      : []);
  const [f, set] = useDraft(
    { owners: initialOwners, deed: property.titleDeedsStatus as "issued" | "pending" | undefined },
    onDirty,
  );
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    type: "company" as "company" | "individual",
    entityId: "",
    name: "",
    share: "",
  });
  const [error, setError] = useState<string | null>(null);
  const total = ownerShareTotal(f.owners);

  registerSubmit(() => {
    if (f.owners.length && total !== 100) {
      setError(`Owner shares add up to ${total}%. They need to total 100%.`);
      return null;
    }
    setError(null);
    return { owners: f.owners, titleDeedStatus: f.deed };
  });

  const addOwner = () => {
    const share = Number(draft.share);
    const entity = entities.find((e) => e.id === draft.entityId);
    const name = entity?.name ?? draft.name.trim();
    if (!name || !(share >= 0.01 && share <= 100)) {
      setError("Each owner needs a name and a share between 0.01% and 100%.");
      return;
    }
    set("owners", [
      ...f.owners,
      { type: draft.type, name, sharePct: share, ...(entity ? { entityId: entity.id } : {}) },
    ]);
    setDraft({ type: "company", entityId: "", name: "", share: "" });
    setAdding(false);
    setError(null);
  };

  return (
    <div className="space-y-4">
      <Field label="Owners" error={error}>
        <div className="space-y-2">
          {f.owners.map((o, i) => (
            <div
              key={`${o.name}-${i}`}
              className="flex items-center justify-between rounded-2xl bg-[#111618] px-4 py-3 text-[#F4F4F2]"
            >
              <div>
                <p className="text-sm font-semibold">{o.name}</p>
                <p className="text-xs text-[#A3A7AB]">
                  {o.type === "company" ? "Company" : "Individual"} · {o.sharePct}%
                </p>
              </div>
              <button
                type="button"
                aria-label={`Remove ${o.name}`}
                onClick={() =>
                  set(
                    "owners",
                    f.owners.filter((_, j) => j !== i),
                  )
                }
                className="rounded-full p-2 text-[#A3A7AB] hover:bg-[#1C2325]"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </Field>

      {adding ? (
        <div className="space-y-3 rounded-2xl border border-border p-4">
          <Segmented
            label="Owner type"
            value={draft.type}
            onChange={(v) => setDraft({ ...draft, type: v, entityId: "" })}
            options={[
              { value: "company", label: "Company" },
              { value: "individual", label: "Individual" },
            ]}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px]">
            {draft.type === "company" && entities.length > 0 ? (
              <Field label="Entity">
                <PillSelect
                  value={draft.entityId}
                  onChange={(v) => setDraft({ ...draft, entityId: v })}
                  placeholder="New company…"
                  options={entities.map((e) => ({ value: e.id, label: e.name }))}
                />
              </Field>
            ) : null}
            {!draft.entityId ? (
              <Field label="Name">
                <PillInput
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </Field>
            ) : null}
            <Field label="Share">
              <PillInput
                inputMode="decimal"
                suffix="%"
                value={draft.share}
                placeholder={String(Math.max(0, 100 - total))}
                onChange={(e) => setDraft({ ...draft, share: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={addOwner} className={PILL_SOLID}>
              Add
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="px-3 text-sm text-muted-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={cn(PILL_SOLID, "w-full")}>
          <Plus size={16} /> Add owner
        </button>
      )}

      <Field label="Title deed status">
        <Segmented
          label="Title deed status"
          value={f.deed}
          onChange={(v) => set("deed", v)}
          options={[
            { value: "issued", label: "Issued" },
            { value: "pending", label: "Pending" },
          ]}
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        In Cyprus, many properties are still waiting for their title deed. Pending deeds are tracked
        so you get notified when they're issued.
      </p>
    </div>
  );
}

// ── Step 3 · Financing ────────────────────────────────────────────────

function FinancingStep({
  property,
  onDirty,
  registerSubmit,
  confirm,
}: StepProps & { confirm: ReturnType<typeof useConfirm>["confirm"] }) {
  const fin = property.profile?.financing;
  const [f, set, setAll] = useDraft(
    {
      hasLoan: fin?.hasLoan,
      lender: fin?.lender && !BANKS.includes(fin.lender) ? "other" : (fin?.lender ?? ""),
      otherLender: fin?.lender && !BANKS.includes(fin.lender) ? fin.lender : "",
      balance: fin?.balance != null ? String(fin.balance) : "",
      ratePct: fin?.ratePct != null ? String(fin.ratePct) : "",
      rateType: fin?.rateType,
      monthlyPayment: fin?.monthlyPayment != null ? String(fin.monthlyPayment) : "",
      endDate: fin?.endDate ?? "",
    },
    onDirty,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const value = property.propertyValue ?? 0;
  const balance = numOrUndef(f.balance);

  registerSubmit(() => {
    if (f.hasLoan === undefined) {
      setErrors({ hasLoan: "Choose Yes or No, or skip this step." });
      return null;
    }
    if (!f.hasLoan) return { hasLoan: false };
    const e: Record<string, string> = {};
    const lender = f.lender === "other" ? f.otherLender.trim() : f.lender;
    if (!lender) e.lender = "Choose a lender.";
    if (balance !== undefined && !(balance > 0)) e.balance = "Must be more than 0.";
    const rate = numOrUndef(f.ratePct);
    if (rate !== undefined && !(rate >= 0 && rate <= 25)) e.ratePct = "Enter 0–25%.";
    const pay = numOrUndef(f.monthlyPayment);
    if (pay !== undefined && !(pay > 0)) e.monthlyPayment = "Must be more than 0.";
    if (f.endDate && f.endDate < todayIso().slice(0, 7)) e.endDate = "Must be in the future.";
    setErrors(e);
    if (Object.keys(e).length) return null;
    return {
      hasLoan: true,
      lender,
      balance,
      ratePct: rate,
      rateType: f.rateType,
      monthlyPayment: pay,
      endDate: f.endDate || undefined,
    };
  });

  const chooseNo = async () => {
    const hasValues = f.lender || f.balance || f.ratePct || f.monthlyPayment || f.endDate;
    if (f.hasLoan && hasValues) {
      const ok = await confirm({
        title: "Remove the loan details?",
        description: "This also removes the LTV and cash flow figures.",
        confirmLabel: "Remove",
        tone: "destructive",
      });
      if (!ok) return;
    }
    setAll({
      hasLoan: false,
      lender: "",
      otherLender: "",
      balance: "",
      ratePct: "",
      rateType: undefined,
      monthlyPayment: "",
      endDate: "",
    });
    onDirty(true);
  };

  return (
    <div className="space-y-4">
      <Field label="Is there a loan on this property?" error={errors.hasLoan}>
        <Segmented
          label="Loan on property"
          value={f.hasLoan === undefined ? undefined : f.hasLoan ? "yes" : "no"}
          onChange={(v) => (v === "yes" ? set("hasLoan", true) : void chooseNo())}
          options={[
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ]}
        />
      </Field>
      {f.hasLoan ? (
        <>
          <Field label="Lender" error={errors.lender}>
            <PillSelect
              value={f.lender}
              onChange={(v) => set("lender", v)}
              placeholder="Select a bank"
              options={[
                ...BANKS.map((b) => ({ value: b, label: b })),
                { value: "other", label: "Other" },
              ]}
            />
          </Field>
          {f.lender === "other" ? (
            <Field label="Lender name">
              <PillInput
                value={f.otherLender}
                onChange={(e) => set("otherLender", e.target.value)}
              />
            </Field>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Outstanding balance"
              error={errors.balance}
              warning={
                balance && value > 0 && balance > value
                  ? "The loan is higher than the property value. Please double-check."
                  : null
              }
            >
              <PillInput
                inputMode="decimal"
                suffix="€"
                value={f.balance}
                onChange={(e) => set("balance", e.target.value)}
              />
            </Field>
            <Field label="Interest rate" error={errors.ratePct}>
              <PillInput
                inputMode="decimal"
                suffix="%"
                value={f.ratePct}
                onChange={(e) => set("ratePct", e.target.value)}
              />
            </Field>
          </div>
          <Field label="Rate type">
            <Segmented
              label="Rate type"
              value={f.rateType}
              onChange={(v) => set("rateType", v)}
              options={[
                { value: "fixed", label: "Fixed" },
                { value: "variable", label: "Variable" },
              ]}
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Monthly payment" error={errors.monthlyPayment}>
              <PillInput
                inputMode="decimal"
                suffix="€"
                value={f.monthlyPayment}
                onChange={(e) => set("monthlyPayment", e.target.value)}
              />
            </Field>
            <Field label="End date" error={errors.endDate}>
              <PillInput
                type="month"
                value={f.endDate}
                onChange={(e) => set("endDate", e.target.value)}
              />
            </Field>
          </div>
          {value > 0 && balance && balance > 0 ? (
            <div className="flex items-center justify-between rounded-2xl bg-[#111618] px-4 py-3 text-[#F4F4F2]">
              <div>
                <p className="text-sm font-semibold">
                  Loan-to-value {pct((balance / value) * 100, 0)} · equity{" "}
                  {moneyFull(value - balance)}
                </p>
                <p className="text-xs text-[#A3A7AB]">
                  Calculated from the {money(value)} valuation
                </p>
              </div>
              <span className="text-xs text-[#73C2CD]">Preview</span>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ── Step 4 · Use ──────────────────────────────────────────────────────

function UseStep({ property, onDirty, registerSubmit }: StepProps) {
  const [use, setUse] = useState<RentalUse | undefined>(resolveRentalUse(property));
  const [blocked, setBlocked] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const { data: tenants = [] } = useOwnerTenants();
  const { data: agreements = [] } = useOwnerAgreements();
  const propertyTenants = tenants.filter(
    (t) => t.propertyId === property.id && ["active", "pending", "invited"].includes(t.status),
  );
  const active = propertyTenants.find((t) => t.status === "active");
  const activeAgreement = active && agreements.find((a) => a.tenantId === active.id);

  registerSubmit(() => {
    if (!use) {
      setBlocked("Choose how the property is used, or skip this step.");
      return null;
    }
    return { use };
  });

  const choose = (v: RentalUse) => {
    if (v !== "long_term" && active) {
      setBlocked(
        `This property has an active lease with ${active.name} until ${formatDay(activeAgreement?.endDate)}. End or move the lease first.`,
      );
      return;
    }
    setBlocked(null);
    setUse(v);
    onDirty(true);
  };

  const options: { value: RentalUse; title: string; sub: string }[] = [
    { value: "long_term", title: "Long-term rental", sub: "Lease of 6 months or more" },
    {
      value: "short_term",
      title: "Short-term rental",
      sub: "Holiday lets, e.g. Airbnb · no tenant needed",
    },
    { value: "not_rented", title: "Not rented", sub: "Private use by you or your family" },
  ];

  return (
    <div className="space-y-3">
      <AddTenantDrawer
        open={addOpen}
        onOpenChange={setAddOpen}
        propertyAddress={property.address}
      />
      <div role="radiogroup" aria-label="Use" className="space-y-3">
        {options.map((o) => {
          const on = use === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => choose(o.value)}
              className={cn(
                "flex w-full items-center gap-4 rounded-2xl px-4 py-4 text-left text-[#F4F4F2] transition focus-visible:outline-2 focus-visible:outline-[#A78C68]",
                on ? "bg-[#2A3134]" : "bg-[#111618] hover:bg-[#1C2325]",
              )}
            >
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2",
                  on ? "border-white bg-white" : "border-[#7D8287]",
                )}
              />
              <span>
                <span className="block text-sm font-semibold">{o.title}</span>
                <span className="block text-xs text-[#A3A7AB]">{o.sub}</span>
              </span>
            </button>
          );
        })}
      </div>
      {blocked ? (
        <p
          role="alert"
          className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200"
        >
          {blocked}
        </p>
      ) : null}
      {use === "long_term" ? (
        <>
          <p className="pt-2 text-xs text-muted-foreground">Tenant</p>
          {propertyTenants.map((t) => {
            const a = agreements.find((x) => x.tenantId === t.id);
            return (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-2xl bg-[#111618] px-4 py-3 text-[#F4F4F2]"
              >
                <div>
                  <p className="text-sm font-semibold">{t.name}</p>
                  <p className="text-xs text-[#A3A7AB]">
                    {t.status === "active"
                      ? `Lease until ${formatDay(a?.endDate)} · ${moneyFull(a?.monthlyRent ?? t.rentAmount)} / month`
                      : "Invitation pending"}
                  </p>
                </div>
                <Link href="/owner/agreements" className="text-sm">
                  Manage
                </Link>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className={cn(PILL_SOLID, "w-full")}
          >
            <Plus size={16} /> Add a tenant
          </button>
        </>
      ) : null}
    </div>
  );
}

// ── Step 5 · Running costs ────────────────────────────────────────────

function CostsStep({ property, onDirty, registerSubmit }: StepProps) {
  const c = property.profile?.costs;
  const s = (n: number | undefined) => (n != null ? String(n) : "");
  const [f, set] = useDraft(
    {
      tax: s(c?.propertyTaxYearly),
      municipal: s(c?.municipalYearly),
      common: s(c?.commonMonthly),
      provider: c?.insurance?.provider ?? "",
      premium: s(c?.insurance?.premiumYearly),
      renewal: c?.insurance?.renewalDate ?? "",
      utilities: c?.utilities ?? ([] as ProfileUtility[]),
    },
    onDirty,
  );
  const [adding, setAdding] = useState(false);
  const [u, setU] = useState({ provider: "", last4: "", paidBy: "owner" as "owner" | "tenant" });
  const [error, setError] = useState<string | null>(null);

  registerSubmit(() => {
    const vals = [f.tax, f.municipal, f.common, f.premium].map(numOrUndef);
    if (vals.some((v) => v !== undefined && !(v >= 0))) {
      setError("Amounts can't be negative.");
      return null;
    }
    setError(null);
    return {
      propertyTaxYearly: vals[0],
      municipalYearly: vals[1],
      commonMonthly: vals[2],
      insurance: {
        provider: f.provider.trim() || undefined,
        premiumYearly: vals[3],
        renewalDate: f.renewal || undefined,
      },
      utilities: f.utilities,
    };
  });

  const addUtility = () => {
    if (!u.provider.trim() || !/^\d{4}$/.test(u.last4)) {
      setError("Enter the provider and only the last 4 digits of the account.");
      return;
    }
    set("utilities", [
      ...f.utilities,
      { provider: u.provider.trim(), accountLast4: u.last4, paidBy: u.paidBy, status: "linked" },
    ]);
    setU({ provider: "", last4: "", paidBy: "owner" });
    setAdding(false);
    setError(null);
  };

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Property tax (yearly)">
          <PillInput
            inputMode="decimal"
            suffix="€"
            value={f.tax}
            onChange={(e) => set("tax", e.target.value)}
          />
        </Field>
        <Field label="Municipal fees (yearly)">
          <PillInput
            inputMode="decimal"
            suffix="€"
            value={f.municipal}
            onChange={(e) => set("municipal", e.target.value)}
          />
        </Field>
      </div>
      <Field label="Common charges (monthly)">
        <PillInput
          inputMode="decimal"
          suffix="€"
          value={f.common}
          onChange={(e) => set("common", e.target.value)}
        />
      </Field>
      <p className="text-xs text-muted-foreground">Insurance</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Provider">
          <PillInput value={f.provider} onChange={(e) => set("provider", e.target.value)} />
        </Field>
        <Field label="Premium (yearly)">
          <PillInput
            inputMode="decimal"
            suffix="€"
            value={f.premium}
            onChange={(e) => set("premium", e.target.value)}
          />
        </Field>
        <Field
          label="Renewal date"
          warning={f.renewal && f.renewal < todayIso() ? "This renewal date has passed." : null}
        >
          <PillInput
            type="date"
            value={f.renewal}
            onChange={(e) => set("renewal", e.target.value)}
          />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">Utility accounts</p>
      {f.utilities.map((x, i) => (
        <div
          key={`${x.provider}-${i}`}
          className="flex items-center justify-between rounded-2xl bg-[#111618] px-4 py-3 text-[#F4F4F2]"
        >
          <div>
            <p className="text-sm font-semibold">{x.provider}</p>
            <p className="text-xs text-[#A3A7AB]">
              Account •••• {x.accountLast4}
              {x.paidBy === "tenant" ? " · paid by tenant" : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[#7BD88F]">Linked</span>
            <button
              type="button"
              aria-label={`Remove ${x.provider}`}
              onClick={() =>
                set(
                  "utilities",
                  f.utilities.filter((_, j) => j !== i),
                )
              }
              className="rounded-full p-2 text-[#A3A7AB] hover:bg-[#1C2325]"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}
      {adding ? (
        <div className="space-y-3 rounded-2xl border border-border p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Provider">
              <PillInput
                value={u.provider}
                placeholder="e.g. EAC electricity"
                onChange={(e) => setU({ ...u, provider: e.target.value })}
              />
            </Field>
            <Field label="Last 4 digits">
              <PillInput
                inputMode="numeric"
                maxLength={4}
                value={u.last4}
                onChange={(e) =>
                  setU({ ...u, last4: e.target.value.replace(/\D/g, "").slice(0, 4) })
                }
              />
            </Field>
          </div>
          <Segmented
            label="Paid by"
            value={u.paidBy}
            onChange={(v) => setU({ ...u, paidBy: v })}
            options={[
              { value: "owner", label: "Paid by owner" },
              { value: "tenant", label: "Paid by tenant" },
            ]}
          />
          <div className="flex gap-2">
            <button type="button" onClick={addUtility} className={PILL_SOLID}>
              Add
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="px-3 text-sm text-muted-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={cn(PILL_SOLID, "w-full")}>
          <Plus size={16} /> Link utility account
        </button>
      )}
    </div>
  );
}

// ── Step 6 · Documents ────────────────────────────────────────────────

function guessDocType(fileName: string): ProfileDocType | null {
  const n = fileName.toLowerCase();
  if (/deed|title/.test(n)) return "title_deed";
  if (/contract|purchase|sale/.test(n)) return "purchase_contract";
  if (/energy|epc/.test(n)) return "energy_certificate";
  if (/insur|policy/.test(n)) return "insurance_policy";
  if (/permit/.test(n)) return "building_permit";
  if (/floor|plan/.test(n)) return "floor_plan";
  return null;
}

function DocumentsStep({ property }: { property: OwnerPropertyDetail }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const docs = property.profile?.documents ?? {};
  const [busy, setBusy] = useState<ProfileDocType | null>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [pendingType, setPendingType] = useState<ProfileDocType | "">("");
  const [dragOver, setDragOver] = useState(false);
  const inputs = useRef<Partial<Record<ProfileDocType, HTMLInputElement | null>>>({});
  const dropInput = useRef<HTMLInputElement>(null);
  const expiry = property.profile?.details?.energyExpiry;

  const upload = async (file: File, docType: ProfileDocType) => {
    if (!UPLOAD_TYPES.includes(file.type) || file.size > UPLOAD_MAX) {
      toast({ title: FILE_ERROR, variant: "destructive" });
      return;
    }
    setBusy(docType);
    try {
      const doc = await uploadPropertyDocument(file, property.id);
      const res = await apiRequest("PATCH", `/api/properties/${property.id}/profile/documents`, {
        docType,
        documentId: doc.id,
      });
      const updated = await res.json();
      qc.setQueryData<OwnerPropertyDetail>([`/api/properties/${property.id}`], (old) =>
        old ? { ...old, ...updated } : old,
      );
      void qc.invalidateQueries({ queryKey: [`/api/owner/documents?propertyId=${property.id}`] });
      toast({ title: `${PROFILE_DOC_LABELS[docType]} uploaded.` });
    } catch (err) {
      toast({
        title: "Couldn't save",
        description: parseApiError(err, "Check your connection and try again."),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const takeDropped = (file: File | undefined) => {
    if (!file) return;
    const guess = guessDocType(file.name);
    if (guess) void upload(file, guess);
    else {
      setPending(file);
      setPendingType("");
    }
  };

  const rows = useMemo(() => PROFILE_DOC_TYPES, []);
  const sub = (t: ProfileDocType): ReactNode => {
    const slot = docs[t];
    if (t === "energy_certificate" && expiry) return `Expires ${formatDay(expiry)}`;
    return slot ? `Uploaded ${formatDay(slot.uploadedAt)}` : "Not uploaded yet";
  };

  return (
    <div className="space-y-3">
      {rows.map((t) => (
        <div
          key={t}
          className="flex items-center justify-between rounded-2xl bg-[#111618] px-4 py-3 text-[#F4F4F2]"
        >
          <div>
            <p className="text-sm font-semibold">{PROFILE_DOC_LABELS[t]}</p>
            <p className="text-xs text-[#A3A7AB]">{sub(t)}</p>
          </div>
          <input
            ref={(el) => {
              inputs.current[t] = el;
            }}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file, t);
            }}
          />
          {docs[t] ? (
            <button
              type="button"
              onClick={() => inputs.current[t]?.click()}
              className="text-sm text-[#7BD88F]"
              title="Replace"
            >
              ✓ Uploaded
            </button>
          ) : (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => inputs.current[t]?.click()}
              className="rounded-full px-3 py-1.5 text-sm hover:bg-[#1C2325] disabled:opacity-50"
            >
              {busy === t ? "Uploading…" : "Upload"}
            </button>
          )}
        </div>
      ))}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          takeDropped(e.dataTransfer.files?.[0]);
        }}
        className={cn(
          "rounded-2xl border-2 border-dashed px-4 py-6 text-center text-sm transition",
          dragOver ? "border-foreground/40 bg-muted/40" : "border-transparent",
        )}
      >
        <input
          ref={dropInput}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          className="hidden"
          onChange={(e) => {
            takeDropped(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => dropInput.current?.click()}
          className="text-foreground/50 hover:text-foreground"
        >
          <Upload size={14} className="mr-1 inline" aria-hidden="true" /> Drop files here or browse
        </button>
        <p className="mt-1 text-xs text-muted-foreground">
          PDF, JPG or PNG · we'll file each one in the right place
        </p>
        {pending ? (
          <div className="mx-auto mt-4 flex max-w-sm items-center gap-2">
            <PillSelect
              value={pendingType}
              onChange={(v) => setPendingType(v as ProfileDocType)}
              placeholder={`What is ${pending.name}?`}
              options={PROFILE_DOC_TYPES.map((t) => ({ value: t, label: PROFILE_DOC_LABELS[t] }))}
            />
            <button
              type="button"
              disabled={!pendingType}
              onClick={() => {
                if (pendingType) void upload(pending, pendingType);
                setPending(null);
              }}
              className={PILL_SOLID}
            >
              Upload
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
