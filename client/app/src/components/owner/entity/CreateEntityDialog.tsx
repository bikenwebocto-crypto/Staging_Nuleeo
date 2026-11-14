import { useEffect, useState, type FormEvent } from "react";
import { Building2, Check, Loader2, User } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@ui/components/ui/dialog";
import { cn } from "@ui/lib/utils";
import { parseApiError } from "@ui/lib/queryClient";
import { useToast } from "@ui/hooks/use-toast";
import type { Entity, LegalEntityType } from "@shared/firestore-schema";
import { ENTITY_FIELD_MAX, ENTITY_TYPE_LABEL, validateEntityInput } from "@shared/entities";
import { useCreateEntity, useEntities } from "@/lib/entities";

type Field = "name" | "legalName" | "registrationNumber" | "vatNumber" | "sector" | "address";

const FIELDS: { key: Field; label: string; placeholder: string; companyOnly?: boolean }[] = [
  { key: "name", label: "Display name", placeholder: "Acme Holdings" },
  { key: "legalName", label: "Legal name", placeholder: "Acme Holdings Ltd", companyOnly: true },
  { key: "registrationNumber", label: "Registration number", placeholder: "HE123456", companyOnly: true },
  { key: "vatNumber", label: "VAT number", placeholder: "CY12345678X", companyOnly: true },
  { key: "sector", label: "Sector", placeholder: "Real estate", companyOnly: true },
  { key: "address", label: "Registered address", placeholder: "Street, city, country" },
];

const EMPTY: Record<Field, string> = {
  name: "",
  legalName: "",
  registrationNumber: "",
  vatNumber: "",
  sector: "",
  address: "",
};

const INPUT =
  "h-11 w-full rounded-full bg-[#1C2325] px-4 text-sm text-[#F4F4F2] placeholder:text-[#7D8287] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]";

// "Add a company" — creates an owner-scoped Entity. Usable from either
// workspace; a PERSONAL entity is only offered while the owner has none.
export function CreateEntityDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (entity: Entity) => void;
}) {
  const { data } = useEntities();
  const canCreatePersonal = data?.canCreatePersonal ?? false;
  const create = useCreateEntity();
  const { toast } = useToast();

  const [type, setType] = useState<LegalEntityType>("COMPANY");
  const [values, setValues] = useState(EMPTY);
  const [incorporationDate, setIncorporationDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setType("COMPANY");
    setValues(EMPTY);
    setIncorporationDate("");
    setError(null);
  }, [open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = {
      entityType: type,
      ...values,
      ...(type === "COMPANY" && incorporationDate ? { incorporationDate } : {}),
    };
    const checked = validateEntityInput(body, new Date().toISOString(), (s) => s.trim());
    if (!checked.ok) return setError(checked.error);
    setError(null);
    create.mutate(checked.value, {
      onSuccess: (entity) => {
        toast({ title: `${ENTITY_TYPE_LABEL[entity.entityType]} added`, description: entity.name });
        onOpenChange(false);
        onCreated?.(entity);
      },
      onError: (err) => setError(parseApiError(err, "Couldn't add the company")),
    });
  };

  const types: { t: LegalEntityType; icon: typeof Building2; hint: string; enabled: boolean }[] = [
    { t: "COMPANY", icon: Building2, hint: "A company you hold assets or trade through", enabled: true },
    {
      t: "PERSONAL",
      icon: User,
      hint: canCreatePersonal ? "Assets you own in your own name" : "You already have one",
      enabled: canCreatePersonal,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-[520px] overflow-y-auto rounded-3xl border-0 bg-[#111618] p-7 text-[#F4F4F2]">
        <DialogHeader className="text-left">
          <DialogTitle className="text-xl font-semibold tracking-[-0.02em]">Add a company</DialogTitle>
          <DialogDescription className="text-sm text-[#A3A7AB]">
            Companies belong to you, so they're available in both your real estate and business
            workspaces.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
          <fieldset className="grid grid-cols-2 gap-2">
            <legend className="mb-2 text-xs font-medium text-[#A3A7AB]">Type</legend>
            {types.map(({ t, icon: Icon, hint, enabled }) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={type === t}
                disabled={!enabled}
                onClick={() => setType(t)}
                className={cn(
                  "flex flex-col items-start gap-1 rounded-2xl px-4 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]",
                  type === t ? "bg-[#2A3134]" : "bg-[#1C2325] hover:bg-[#232B2E]",
                  !enabled && "cursor-not-allowed opacity-50",
                )}
              >
                <span className="flex w-full items-center gap-2 text-sm font-semibold">
                  <Icon size={16} aria-hidden="true" />
                  {ENTITY_TYPE_LABEL[t]}
                  {type === t && <Check size={14} className="ml-auto" aria-hidden="true" />}
                </span>
                <span className="text-xs text-[#A3A7AB]">{hint}</span>
              </button>
            ))}
          </fieldset>

          {FIELDS.filter((f) => type === "COMPANY" || !f.companyOnly).map((f) => (
            <div key={f.key} className="flex flex-col gap-2">
              <label htmlFor={`entity-${f.key}`} className="text-xs font-medium text-[#A3A7AB]">
                {f.label}
                {f.key === "name" && type === "COMPANY" ? " *" : " (optional)"}
              </label>
              <input
                id={`entity-${f.key}`}
                value={values[f.key]}
                maxLength={ENTITY_FIELD_MAX[f.key]}
                placeholder={f.key === "name" && type === "PERSONAL" ? "Personal" : f.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className={INPUT}
              />
            </div>
          ))}

          {type === "COMPANY" && (
            <div className="flex flex-col gap-2">
              <label htmlFor="entity-incorporation" className="text-xs font-medium text-[#A3A7AB]">
                Incorporation date (optional)
              </label>
              <input
                id="entity-incorporation"
                type="date"
                value={incorporationDate}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setIncorporationDate(e.target.value)}
                className={cn(INPUT, "[color-scheme:dark]")}
              />
            </div>
          )}

          {error && (
            <p role="alert" className="rounded-2xl bg-[#FF7A7A]/10 px-4 py-3 text-sm text-[#FF7A7A]">
              {error}
            </p>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="h-11 rounded-full bg-white/[0.08] px-6 text-sm font-semibold transition-colors hover:bg-white/[0.12]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={create.isPending}
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-white text-sm font-semibold text-[#060A0B] transition hover:brightness-95 disabled:opacity-60"
            >
              {create.isPending && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
              Add {ENTITY_TYPE_LABEL[type].toLowerCase()}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
