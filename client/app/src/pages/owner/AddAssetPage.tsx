// Add asset — /portfolios/new. One entry point; the asset type picked in step 1
// decides the form:
//   Apartment / House / Commercial / Other → "Add property" (3 steps):
//     Type & basics → Ownership → Financials (+ optional first tenant)
//   Building → "Add building" (4 steps):
//     Type & name → Ownership → Financials (whole building) → Units
// Creates the property with POST /api/properties, writes ownership/use through
// the profile endpoints so Complete profile starts from what was entered here,
// and for a building creates its units with POST /api/properties/:id/units.
import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Building,
  Building2,
  Check,
  Home,
  MoreHorizontal,
  Plus,
  Store,
  Trash2,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import {
  Field,
  PillInput,
  PillSelect,
  Segmented,
  PILL_SOLID,
} from "@/components/owner/property/ui";
import { useCreateEntity, useEntities } from "@/lib/entities";
import { useActivePortfolio } from "@/lib/activePortfolio";
import { useCreateAgreement } from "@/lib/ownerQueries";
import { PricingModal } from "@ui/components/common/PricingModal";
import { useConfirm } from "@ui/components/common/ConfirmDialog";
import { useToast } from "@ui/hooks/use-toast";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import { cn } from "@ui/lib/utils";
import type { Project, PropertyType } from "@shared/firestore-schema";
import {
  MAX_BUILDING_UNITS,
  unitLabels,
  type ProfileOwner,
  type RentalUse,
} from "@shared/propertyProfile";

type AssetType = "Apartment" | "House" | "Commercial" | "Building" | "Other";
type UnitType = "Apartment" | "House" | "Commercial" | "Other";
const TYPES: { id: AssetType; label: string; icon: typeof Home }[] = [
  { id: "Apartment", label: "Apartment", icon: Building2 },
  { id: "House", label: "House", icon: Home },
  { id: "Commercial", label: "Commercial", icon: Store },
  { id: "Building", label: "Building", icon: Building },
  { id: "Other", label: "Other", icon: MoreHorizontal },
];
const PROPERTY_STEPS = ["Type & basics", "Ownership", "Financials"];
const BUILDING_STEPS = ["Type & name", "Ownership", "Financials", "Units"];
const UNIT_TYPE_LABEL: Record<UnitType, string> = {
  Apartment: "Apartments",
  House: "Houses",
  Commercial: "Commercial units",
  Other: "Units",
};
const COUNTRIES = ["Cyprus", "Greece", "United Kingdom", "Other"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROJECTS_KEY = "/api/projects";
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
  const s = new Date(a);
  const e = new Date(b);
  const m = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  return m > 0 ? m : undefined;
}
// Next date (from max(today, lease start)) that falls on the rent due day.
function nextDueDate(day: number, start: string): string {
  const base = new Date(Math.max(Date.now(), start ? new Date(start).getTime() : 0));
  const d = new Date(base.getFullYear(), base.getMonth(), Math.min(day, 28));
  if (d < base) d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}
// YYYY-MM-DD `months` before `iso`, clamped to the month's last day.
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

interface Shareholder {
  name: string;
  share: string;
}

export default function AddAssetPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const { isSelf } = useActivePortfolio();
  const { data: entityData } = useEntities();
  const createEntity = useCreateEntity();
  const createAgreement = useCreateAgreement();
  const companies = (entityData?.entities ?? []).filter((e) => e.entityType === "COMPANY");
  const { data: projectData } = useQuery<{ projects: Project[] }>({
    queryKey: [PROJECTS_KEY],
    enabled: isSelf,
  });
  const projects = projectData?.projects ?? [];
  const createProject = useMutation({
    mutationFn: async (projectName: string) =>
      (await (await apiRequest("POST", PROJECTS_KEY, { name: projectName })).json()) as Project,
    onSuccess: () => qc.invalidateQueries({ queryKey: [PROJECTS_KEY] }),
  });

  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string; units: number } | null>(null);
  const [touched, setTouched] = useState(false);

  // Step 1
  const [type, setType] = useState<AssetType>("Apartment");
  const [name, setName] = useState("");
  const [beds, setBeds] = useState<"1" | "2" | "3" | undefined>();
  const [otherType, setOtherType] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("Cyprus");
  const [projectId, setProjectId] = useState("");
  const [newProject, setNewProject] = useState<string | null>(null);
  // Step 2
  const [ownedBy, setOwnedBy] = useState<"personal" | "company">("personal");
  const [entityId, setEntityId] = useState("");
  const [newSpv, setNewSpv] = useState<string | null>(null);
  const [mainShare, setMainShare] = useState("100");
  const [others, setOthers] = useState<Shareholder[]>([]);
  // Step 3
  const [purchase, setPurchase] = useState("");
  const [market, setMarket] = useState("");
  const [use, setUse] = useState<RentalUse>("long_term");
  const [withTenant, setWithTenant] = useState(true);
  const [t, setT] = useState({
    name: "",
    email: "",
    phone: "",
    rent: "",
    start: "",
    end: "",
    deposit: "",
    dueDay: "1",
    advance: "0",
    remind: true,
    invite: true,
  });
  // Step 4 (building only)
  const [unitCount, setUnitCount] = useState("10");
  const [firstUnit, setFirstUnit] = useState("A1");
  const [unitType, setUnitType] = useState<UnitType>("Apartment");
  const [unitsToRent, setUnitsToRent] = useState<"yes" | "no">("yes");

  const isBuilding = type === "Building";
  const STEPS = isBuilding ? BUILDING_STEPS : PROPERTY_STEPS;
  const lastStep = STEPS.length - 1;
  const noun = isBuilding ? "building" : "property";
  const title = isBuilding ? "Add building" : "Add property";

  const dirty = (fn: () => void) => {
    fn();
    setTouched(true);
  };

  const company = companies.find((c) => c.id === entityId);
  const mainName = ownedBy === "company" ? (company?.name ?? "Company") : "You";
  const shares = [
    { name: mainName, pct: Number(mainShare) || 0 },
    ...others.map((o) => ({ name: o.name || "Shareholder", pct: Number(o.share) || 0 })),
  ];
  const total = Math.round(shares.reduce((s, x) => s + x.pct, 0) * 100) / 100;

  const unitsNum = Number(unitCount);
  const unitsValid = Number.isInteger(unitsNum) && unitsNum >= 1 && unitsNum <= MAX_BUILDING_UNITS;
  const preview = unitsValid ? unitLabels(firstUnit, unitsNum) : [];

  // Lease-end reminder: only offered when the reminder date is still ahead.
  const reminderDate = t.end ? monthsBefore(t.end, REMIND_MONTHS) : "";
  const today = new Date().toISOString().slice(0, 10);
  const canRemind = !!reminderDate && reminderDate > today;

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (step === 0) {
      if (!name.trim()) e.name = `Give the ${noun} a name.`;
      if (!city.trim()) e.city = "Enter the city.";
      if (isBuilding && !address.trim()) e.address = "Enter the street address.";
      if (type === "Other" && !otherType.trim()) e.otherType = "Tell us what it is.";
    }
    if (step === 1) {
      if (ownedBy === "company" && !entityId) e.company = "Choose a company or create a new SPV.";
      if (others.some((o) => !o.name.trim())) e.others = "Each shareholder needs a name.";
      if (total !== 100) e.total = `Owner shares add up to ${total}%. They need to total 100%.`;
    }
    if (step === 2) {
      for (const [k, v] of [
        ["purchase", purchase],
        ["market", market],
      ] as const)
        if (v && (parseMoney(v) ?? -1) < 0) e[k] = "Enter a valid amount.";
      if (!isBuilding && use === "long_term" && withTenant) {
        if (!t.name.trim()) e.tenantName = "Enter the tenant's name.";
        if (!EMAIL_RE.test(t.email.trim())) e.email = "Enter a valid email address.";
        if (!((parseMoney(t.rent) ?? 0) > 0)) e.rent = "Enter the monthly rent.";
        if (!t.start) e.start = "Enter the lease start.";
        if (t.end && t.start && t.end <= t.start) e.end = "Lease end must be after the start.";
      }
    }
    if (step === 3 && isBuilding) {
      if (!unitsValid) e.units = `Enter a number from 1 to ${MAX_BUILDING_UNITS}.`;
      if (!firstUnit.trim()) e.firstUnit = "Name the first unit, e.g. A1.";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const close = async () => {
    if (
      touched &&
      !created &&
      !(await confirm({
        title: "Leave without saving?",
        description: `This ${noun} hasn't been added yet.`,
        confirmLabel: "Leave",
        cancelLabel: "Keep editing",
        tone: "destructive",
      }))
    )
      return;
    navigate("/portfolios");
  };

  const addSpv = async () => {
    const spvName = newSpv?.trim();
    if (!spvName) return;
    try {
      const entity = await createEntity.mutateAsync({ entityType: "COMPANY", name: spvName });
      setEntityId(entity.id);
      setNewSpv(null);
    } catch (err) {
      toast({
        title: "Couldn't create the company",
        description: parseApiError(err, ""),
        variant: "destructive",
      });
    }
  };

  const addProject = async () => {
    const projectName = newProject?.trim();
    if (!projectName) return;
    try {
      const project = await createProject.mutateAsync(projectName);
      setProjectId(project.id);
      setNewProject(null);
    } catch (err) {
      toast({
        title: "Couldn't create the project",
        description: parseApiError(err, ""),
        variant: "destructive",
      });
    }
  };

  const isUpgradeError = (err: unknown) => {
    const msg = err instanceof Error ? err.message : "";
    return msg.startsWith("402") || /upgrade required/i.test(msg);
  };

  const submit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    let propertyId: string | undefined;
    try {
      const propertyType: PropertyType = type;
      const res = await apiRequest("POST", "/api/properties", {
        name: name.trim(),
        propertyType,
        ...(type === "Other" ? { propertyTypeOther: otherType.trim() } : {}),
        ...(type === "Apartment" && beds ? { bedrooms: Number(beds) } : {}),
        // The property form has no street field; send "City, Country" so
        // `address` (required by the API) is always populated.
        address: address.trim() || [city.trim(), country].filter(Boolean).join(", "),
        ...(projectId ? { projectId } : {}),
        city: city.trim(),
        country,
        ownershipType: ownedBy === "company" ? "company" : "individual",
        ...(ownedBy === "company" && company ? { entityId: company.id } : {}),
        acquisitionPrice: parseMoney(purchase) ?? 0,
        propertyValue: parseMoney(market) ?? 0,
        ...(isBuilding ? {} : { propertyUse: use === "not_rented" ? "owner_occupied" : "rent" }),
      });
      propertyId = ((await res.json()) as { id?: string }).id;
    } catch (err) {
      setSubmitting(false);
      if (isUpgradeError(err)) {
        setPricingOpen(true);
        return;
      }
      toast({
        title: `Couldn't add the ${noun}`,
        description: parseApiError(err, "Check your connection and try again."),
        variant: "destructive",
      });
      return;
    }
    if (!propertyId) {
      setSubmitting(false);
      return;
    }

    // Follow-ups: the property exists now, so a failure here is reported but
    // doesn't block — the owner can finish it in Complete profile.
    const failures: string[] = [];
    const owners: ProfileOwner[] = [
      {
        type: ownedBy === "company" ? "company" : "individual",
        name: ownedBy === "company" ? (company?.name ?? "Company") : "Personal",
        sharePct: Number(mainShare),
        ...(company ? { entityId: company.id } : {}),
      },
      ...others.map((o) => ({
        type: "individual" as const,
        name: o.name.trim(),
        sharePct: Number(o.share),
      })),
    ];
    try {
      await apiRequest("PATCH", `/api/properties/${propertyId}/profile/ownership`, { owners });
    } catch {
      failures.push("ownership");
    }

    let unitsCreated = 0;
    if (isBuilding) {
      try {
        const res = await apiRequest("POST", `/api/properties/${propertyId}/units`, {
          count: unitsNum,
          firstLabel: firstUnit.trim(),
          unitType,
          toRent: unitsToRent === "yes",
        });
        unitsCreated = ((await res.json()) as { units?: unknown[] }).units?.length ?? 0;
      } catch (err) {
        failures.push("units");
        if (isUpgradeError(err)) setPricingOpen(true);
        toast({
          title: "Building added, units not created",
          description: parseApiError(err, "Add the units from the building page."),
          variant: "destructive",
        });
      }
    } else {
      try {
        await apiRequest("PATCH", `/api/properties/${propertyId}/profile/use`, { use });
      } catch {
        failures.push("use");
      }
      if (use === "long_term" && withTenant) {
        const rent = parseMoney(t.rent) ?? 0;
        try {
          await createAgreement.mutateAsync({
            tenantEmail: t.email.trim(),
            tenantName: t.name.trim(),
            ...(t.phone.trim() ? { tenantPhone: t.phone.trim() } : {}),
            sendInvite: t.invite,
            ...(canRemind && t.remind ? { endReminderDate: reminderDate } : {}),
            propertyId,
            rentAmount: rent,
            deposit: parseMoney(t.deposit) ?? 0,
            startDate: t.start,
            nextPaymentDate: nextDueDate(Number(t.dueDay), t.start),
            prepaidRents: Number(t.advance) || 0,
            rentalDurationMonths: monthsBetween(t.start, t.end),
          });
        } catch (err) {
          failures.push("tenant");
          toast({
            title: "Tenant not added",
            description: parseApiError(err, "You can add them from Tenants."),
            variant: "destructive",
          });
        }
      }
    }
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["/api/owner/properties"] }),
      qc.invalidateQueries({ queryKey: ["/api/owner/summary"] }),
    ]);
    if (failures.length && !failures.includes("tenant") && !failures.includes("units"))
      toast({
        title: `${isBuilding ? "Building" : "Property"} added`,
        description: "Some details didn't save. Finish them in Complete profile.",
      });
    setSubmitting(false);
    setCreated({ id: propertyId, name: name.trim(), units: unitsCreated });
  };

  if (!isSelf) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
        <p className="font-semibold">You can only add assets to your own portfolio.</p>
        <Link href="/portfolios" className={PILL_SOLID}>
          Back
        </Link>
      </div>
    );
  }

  const rentNum = parseMoney(t.rent) ?? 0;
  const DARK_INPUT = "bg-[#1C2325]";
  const optional = isBuilding ? "" : ", optional";

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      {dialog}
      <PricingModal open={pricingOpen} onOpenChange={setPricingOpen} />
      <div className="mx-auto w-full max-w-[1440px]">
        <div className="flex items-center justify-between">
          <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
            <button type="button" onClick={() => void close()} className="hover:text-foreground">
              Portfolio
            </button>{" "}
            › <span className="text-foreground/60">{title}</span>
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

        <div className="mx-auto mt-8 w-full max-w-[608px]">
          <h1 className="text-2xl font-semibold text-foreground/80">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a type, then step through its onboarding
          </p>

          <ol className={cn("mt-8 grid text-center", isBuilding ? "grid-cols-4" : "grid-cols-3")}>
            {STEPS.map((s, i) => {
              const done = created ? true : i < step;
              return (
                <li key={s} aria-current={i === step && !created ? "step" : undefined}>
                  <span className="block text-sm">
                    {done ? <Check size={14} className="mx-auto" aria-label="Done" /> : i + 1}
                  </span>
                  <span
                    className={cn(
                      "text-[11px]",
                      i === step && !created ? "text-foreground/40" : "text-muted-foreground",
                    )}
                  >
                    {s}
                  </span>
                </li>
              );
            })}
          </ol>

          {created ? (
            <div className="mt-14 flex flex-col items-center text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
                <Check size={28} />
              </span>
              <h2 className="mt-4 text-xl font-semibold text-foreground/70">
                {isBuilding
                  ? created.units
                    ? "Building & units added"
                    : "Building added"
                  : "Property added"}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {isBuilding && created.units
                  ? `${created.name} and its ${created.units} units are now in your portfolio.`
                  : `${created.name} is now in your portfolio.`}
              </p>
              <Link href={`/properties/${created.id}`} className="mt-12 font-medium">
                Open asset
              </Link>
            </div>
          ) : (
            <>
              <p className="mt-8 text-xs text-muted-foreground">
                Step {step + 1} of {STEPS.length}
              </p>
              <h2 className="text-xl font-semibold text-foreground/70">{STEPS[step]}</h2>

              {step === 0 ? (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    {type === "Other"
                      ? "Other selected. Tell us what it is, e.g. land, parking or storage."
                      : isBuilding
                        ? "Building selected. Name and address."
                        : "Property selected. Enter the essentials."}
                  </p>
                  <div
                    role="radiogroup"
                    aria-label="Asset type"
                    className="grid grid-cols-3 gap-3 sm:grid-cols-5"
                  >
                    {TYPES.map(({ id, label, icon: Icon }) => (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={type === id}
                        onClick={() => dirty(() => setType(id))}
                        className={cn(
                          "flex aspect-[7/6] flex-col items-center justify-center gap-2 rounded-2xl text-sm text-[#F4F4F2] transition focus-visible:outline-2 focus-visible:outline-[#A78C68]",
                          type === id ? "bg-[#2A3134]" : "bg-[#111618] hover:bg-[#1C2325]",
                        )}
                      >
                        <Icon size={20} aria-hidden="true" />
                        {label}
                      </button>
                    ))}
                  </div>
                  <Field label={isBuilding ? "Building name" : "Property name"} error={errors.name}>
                    <PillInput
                      value={name}
                      invalid={!!errors.name}
                      onChange={(e) => dirty(() => setName(e.target.value))}
                    />
                  </Field>
                  {type === "Apartment" ? (
                    <Field label="Apartment type">
                      <Segmented
                        label="Apartment type"
                        value={beds}
                        onChange={(v) => dirty(() => setBeds(v))}
                        options={[
                          { value: "1", label: "1 bed" },
                          { value: "2", label: "2 bed" },
                          { value: "3", label: "3 bed" },
                        ]}
                      />
                    </Field>
                  ) : null}
                  {type === "Other" ? (
                    <Field label="What type of property?" error={errors.otherType}>
                      <PillInput
                        value={otherType}
                        placeholder="e.g. Parking space"
                        invalid={!!errors.otherType}
                        onChange={(e) => dirty(() => setOtherType(e.target.value))}
                      />
                    </Field>
                  ) : null}
                  {isBuilding ? (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="Address" error={errors.address}>
                        <PillInput
                          value={address}
                          invalid={!!errors.address}
                          onChange={(e) => dirty(() => setAddress(e.target.value))}
                        />
                      </Field>
                      <Field label="City" error={errors.city}>
                        <PillInput
                          value={city}
                          invalid={!!errors.city}
                          onChange={(e) => dirty(() => setCity(e.target.value))}
                        />
                      </Field>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="City" error={errors.city}>
                        <PillInput
                          value={city}
                          invalid={!!errors.city}
                          onChange={(e) => dirty(() => setCity(e.target.value))}
                        />
                      </Field>
                      <Field label="Country">
                        <PillSelect
                          value={country}
                          onChange={(v) => dirty(() => setCountry(v))}
                          options={COUNTRIES.map((c) => ({ value: c, label: c }))}
                        />
                      </Field>
                    </div>
                  )}
                  {isBuilding ? (
                    <Field label="Country">
                      <PillSelect
                        value={country}
                        onChange={(v) => dirty(() => setCountry(v))}
                        options={COUNTRIES.map((c) => ({ value: c, label: c }))}
                      />
                    </Field>
                  ) : null}
                  <Field label="Project (optional)">
                    <PillSelect
                      value={projectId}
                      onChange={(v) => dirty(() => setProjectId(v))}
                      options={[
                        { value: "", label: "Not part of a project" },
                        ...projects.map((p) => ({ value: p.id, label: p.name })),
                      ]}
                    />
                  </Field>
                  {newProject === null ? (
                    <button
                      type="button"
                      onClick={() => setNewProject("")}
                      className="text-sm text-muted-foreground hover:text-foreground"
                    >
                      <Plus size={14} className="mr-1 inline" aria-hidden="true" /> Create new
                      project
                    </button>
                  ) : (
                    <div className="flex gap-2">
                      <PillInput
                        className="flex-1"
                        placeholder="Project name, e.g. Limassol Seafront"
                        value={newProject}
                        onChange={(e) => setNewProject(e.target.value)}
                      />
                      <button
                        type="button"
                        disabled={createProject.isPending || !newProject.trim()}
                        onClick={() => void addProject()}
                        className={PILL_SOLID}
                      >
                        {createProject.isPending ? "Creating…" : "Create"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewProject(null)}
                        className="px-2 text-sm text-muted-foreground"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              ) : null}

              {step === 1 ? (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">Who owns this {noun}?</p>
                  <Field label="Owned by">
                    <Segmented
                      label="Owned by"
                      value={ownedBy}
                      onChange={(v) => dirty(() => setOwnedBy(v))}
                      options={[
                        { value: "personal", label: "Personal" },
                        { value: "company", label: "Company (SPV)" },
                      ]}
                    />
                  </Field>
                  {ownedBy === "company" ? (
                    <>
                      <Field label="Company" error={errors.company}>
                        <PillSelect
                          value={entityId}
                          onChange={(v) => dirty(() => setEntityId(v))}
                          placeholder="Select a company"
                          options={companies.map((c) => ({ value: c.id, label: c.name }))}
                        />
                      </Field>
                      {newSpv === null ? (
                        <button
                          type="button"
                          onClick={() => setNewSpv("")}
                          className="text-sm text-muted-foreground hover:text-foreground"
                        >
                          <Plus size={14} className="mr-1 inline" aria-hidden="true" /> Create new
                          SPV
                        </button>
                      ) : (
                        <div className="flex gap-2">
                          <PillInput
                            className="flex-1"
                            placeholder="Company name"
                            value={newSpv}
                            onChange={(e) => setNewSpv(e.target.value)}
                          />
                          <button
                            type="button"
                            disabled={createEntity.isPending || !newSpv.trim()}
                            onClick={() => void addSpv()}
                            className={PILL_SOLID}
                          >
                            {createEntity.isPending ? "Creating…" : "Create"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setNewSpv(null)}
                            className="px-2 text-sm text-muted-foreground"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </>
                  ) : null}
                  <Field label="Ownership %">
                    <PillInput
                      inputMode="decimal"
                      suffix="%"
                      value={mainShare}
                      onChange={(e) => dirty(() => setMainShare(e.target.value))}
                    />
                  </Field>

                  {others.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">Other shareholders</p>
                      {others.map((o, i) => (
                        <div key={i} className="grid grid-cols-[1fr_120px_auto] items-end gap-2">
                          <Field label="Shareholder">
                            <PillInput
                              value={o.name}
                              onChange={(e) =>
                                dirty(() =>
                                  setOthers(
                                    others.map((x, j) =>
                                      j === i ? { ...x, name: e.target.value } : x,
                                    ),
                                  ),
                                )
                              }
                            />
                          </Field>
                          <Field label="Share %">
                            <PillInput
                              inputMode="decimal"
                              suffix="%"
                              value={o.share}
                              onChange={(e) =>
                                dirty(() =>
                                  setOthers(
                                    others.map((x, j) =>
                                      j === i ? { ...x, share: e.target.value } : x,
                                    ),
                                  ),
                                )
                              }
                            />
                          </Field>
                          <button
                            type="button"
                            aria-label="Remove shareholder"
                            onClick={() => dirty(() => setOthers(others.filter((_, j) => j !== i)))}
                            className="mb-1 rounded-full p-2 text-muted-foreground hover:bg-muted/60"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                      {errors.others ? (
                        <p className="text-xs text-red-600 dark:text-red-400">{errors.others}</p>
                      ) : null}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={() =>
                      dirty(() =>
                        setOthers([
                          ...others,
                          { name: "", share: String(Math.max(0, 100 - total)) },
                        ]),
                      )
                    }
                    className="text-sm text-muted-foreground hover:text-foreground"
                  >
                    <Plus size={14} className="mr-1 inline" aria-hidden="true" />
                    {others.length ? "Add another shareholder" : "Add a shareholder"}
                  </button>

                  {others.length > 0 || total !== 100 ? (
                    <div className="rounded-2xl bg-[#111618] px-4 py-3 text-[#F4F4F2]">
                      <div className="flex items-center justify-between text-sm">
                        <span>Total</span>
                        <span className={total === 100 ? "text-[#7BD88F]" : "text-[#F5B65C]"}>
                          {total === 100 ? "✓ 100% allocated" : `${total}% allocated`}
                        </span>
                      </div>
                      <div className="mt-2 flex h-1.5 gap-1 overflow-hidden rounded-full bg-[#1C2325]">
                        {shares.map((s, i) => (
                          <span
                            key={i}
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.min(100, s.pct)}%`,
                              backgroundColor: i === 0 ? "#F4F4F2" : "#73C2CD",
                            }}
                          />
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-[#A3A7AB]">
                        {shares.map((s) => `${s.name} ${s.pct}%`).join(" · ")}
                      </p>
                    </div>
                  ) : null}
                  {errors.total ? (
                    <p className="text-xs text-red-600 dark:text-red-400">{errors.total}</p>
                  ) : null}
                </div>
              ) : null}

              {step === 2 ? (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    {isBuilding
                      ? "Purchase cost and current market value."
                      : "Purchase cost, market value and how it is used."}
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label={`Purchase cost (€${optional})`} error={errors.purchase}>
                      <PillInput
                        inputMode="numeric"
                        value={purchase}
                        onChange={(e) => dirty(() => setPurchase(groupDigits(e.target.value)))}
                      />
                    </Field>
                    <Field label={`Market value (€${optional})`} error={errors.market}>
                      <PillInput
                        inputMode="numeric"
                        value={market}
                        onChange={(e) => dirty(() => setMarket(groupDigits(e.target.value)))}
                      />
                    </Field>
                  </div>
                  {isBuilding ? null : (
                    <>
                      <Field label="How is it used?">
                        <Segmented
                          label="How is it used?"
                          value={use}
                          onChange={(v) => dirty(() => setUse(v))}
                          options={[
                            { value: "long_term", label: "Long-term rental" },
                            { value: "short_term", label: "Short-term rental" },
                            { value: "not_rented", label: "Not rented" },
                          ]}
                        />
                      </Field>
                      <p className="-mt-2 text-xs text-muted-foreground">
                        {use === "long_term"
                          ? "Adding a tenant is optional. You can add or invite them later from Tenants."
                          : use === "short_term"
                            ? "No tenant needed. Income from Airbnb or Booking.com shows up as transactions."
                            : "Private use by you or your family. No rent is tracked."}
                      </p>

                      {use === "long_term" && withTenant ? (
                        <section className="space-y-3 rounded-[24px] bg-[#111618] p-4 text-[#F4F4F2]">
                          <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold">Add tenant (optional)</h3>
                            <button
                              type="button"
                              onClick={() => setWithTenant(false)}
                              className="text-xs text-[#A3A7AB] underline"
                            >
                              Skip, add the tenant later
                            </button>
                          </div>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 [&_span.text-muted-foreground]:text-[#A3A7AB]">
                            <Field label="Tenant name" error={errors.tenantName}>
                              <PillInput
                                className={DARK_INPUT}
                                value={t.name}
                                onChange={(e) => dirty(() => setT({ ...t, name: e.target.value }))}
                              />
                            </Field>
                            <Field label="Monthly rent (€)" error={errors.rent}>
                              <PillInput
                                className={DARK_INPUT}
                                inputMode="numeric"
                                value={t.rent}
                                onChange={(e) =>
                                  dirty(() => setT({ ...t, rent: groupDigits(e.target.value) }))
                                }
                              />
                            </Field>
                            <Field label="Tenant email" error={errors.email}>
                              <PillInput
                                className={DARK_INPUT}
                                type="email"
                                value={t.email}
                                onChange={(e) => dirty(() => setT({ ...t, email: e.target.value }))}
                              />
                            </Field>
                            <Field label="Phone (optional)">
                              <PillInput
                                className={DARK_INPUT}
                                type="tel"
                                value={t.phone}
                                onChange={(e) => dirty(() => setT({ ...t, phone: e.target.value }))}
                              />
                            </Field>
                            <Field label="Lease start" error={errors.start}>
                              <PillInput
                                className={DARK_INPUT}
                                type="date"
                                value={t.start}
                                onChange={(e) => dirty(() => setT({ ...t, start: e.target.value }))}
                              />
                            </Field>
                            <Field label="Lease end" error={errors.end}>
                              <PillInput
                                className={DARK_INPUT}
                                type="date"
                                value={t.end}
                                onChange={(e) => dirty(() => setT({ ...t, end: e.target.value }))}
                              />
                            </Field>
                            <Field label="Deposit (€)">
                              <PillInput
                                className={DARK_INPUT}
                                inputMode="numeric"
                                value={t.deposit}
                                onChange={(e) =>
                                  dirty(() => setT({ ...t, deposit: groupDigits(e.target.value) }))
                                }
                              />
                            </Field>
                            <Field label="Rent due day">
                              <PillSelect
                                value={t.dueDay}
                                onChange={(v) => dirty(() => setT({ ...t, dueDay: v }))}
                                options={Array.from({ length: 28 }, (_, i) => ({
                                  value: String(i + 1),
                                  label: `${ordinal(i + 1)} of the month`,
                                }))}
                              />
                            </Field>
                            <Field label="Advance payment (months)">
                              <PillSelect
                                value={t.advance}
                                onChange={(v) => dirty(() => setT({ ...t, advance: v }))}
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
                          {canRemind ? (
                            <Checkbox
                              checked={t.remind}
                              onChange={(v) => dirty(() => setT({ ...t, remind: v }))}
                              label={`Remind me ${REMIND_MONTHS} months before the lease ends (${fmtDate(reminderDate)})`}
                            />
                          ) : null}
                          <Checkbox
                            checked={t.invite}
                            onChange={(v) => dirty(() => setT({ ...t, invite: v }))}
                            label="Email the tenant an invite to the tenant portal"
                          />
                          <p className="text-xs text-[#A3A7AB]">
                            The tenant creates an account from the invite email and sees the lease
                            in the tenant portal. You can also invite them later from Tenants.
                          </p>
                        </section>
                      ) : use === "long_term" ? (
                        <button
                          type="button"
                          onClick={() => setWithTenant(true)}
                          className={cn(PILL_SOLID, "w-full")}
                        >
                          <Plus size={16} /> Add a tenant now
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}

              {step === 3 && isBuilding ? (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Add the first unit and we'll create the rest.
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Units" error={errors.units}>
                      <PillInput
                        inputMode="numeric"
                        value={unitCount}
                        invalid={!!errors.units}
                        onChange={(e) =>
                          dirty(() =>
                            setUnitCount(e.target.value.replace(/[^\d]/g, "").slice(0, 3)),
                          )
                        }
                      />
                    </Field>
                    <Field label="First unit" error={errors.firstUnit}>
                      <PillInput
                        value={firstUnit}
                        invalid={!!errors.firstUnit}
                        onChange={(e) => dirty(() => setFirstUnit(e.target.value.slice(0, 20)))}
                      />
                    </Field>
                    <Field label="Default type">
                      <PillSelect
                        value={unitType}
                        onChange={(v) => dirty(() => setUnitType(v as UnitType))}
                        options={(["Apartment", "House", "Commercial", "Other"] as const).map(
                          (u) => ({ value: u, label: u }),
                        )}
                      />
                    </Field>
                    <Field label="To rent?">
                      <Segmented
                        label="To rent?"
                        value={unitsToRent}
                        onChange={(v) => dirty(() => setUnitsToRent(v))}
                        options={[
                          { value: "yes", label: "Yes" },
                          { value: "no", label: "No" },
                        ]}
                      />
                    </Field>
                  </div>
                  {preview.length ? (
                    <div className="rounded-2xl bg-[#111618] px-4 py-3 text-[#F4F4F2]">
                      <div className="flex items-center justify-between text-sm">
                        <span>Preview · {preview.length} units</span>
                        <span className="text-xs text-[#A3A7AB]">
                          {UNIT_TYPE_LABEL[unitType]} ·{" "}
                          {unitsToRent === "yes" ? "To rent" : "Not for rent"}
                        </span>
                      </div>
                      <ul className="mt-2 flex max-h-40 flex-wrap gap-x-6 gap-y-2 overflow-y-auto px-3 py-1 text-sm">
                        {preview.map((l) => (
                          <li key={l}>{l}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-8 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => (step === 0 ? void close() : setStep(step - 1))}
                  className={PILL_SOLID}
                >
                  {step === 0 ? "Cancel" : "Back"}
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    if (step < lastStep) {
                      if (validate()) setStep(step + 1);
                    } else void submit();
                  }}
                  className="px-4 py-2 font-medium disabled:opacity-50"
                >
                  {step < lastStep ? "Continue" : submitting ? "Adding…" : title}
                </button>
              </div>
            </>
          )}
        </div>
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
    <label className="flex cursor-pointer items-center gap-3 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 accent-[#F4F4F2]"
      />
      {label}
    </label>
  );
}

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
