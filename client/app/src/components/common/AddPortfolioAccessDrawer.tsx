import { useEffect, useState } from "react";
import { Shield, Scale, CreditCard, Check, ChevronRight } from "lucide-react";
import { useAccessContacts, useUpsertAccessContact } from "@/lib/ownerQueries";
import type { AccessContactType } from "@shared/firestore-schema";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { parseApiError } from "@ui/lib/queryClient";

type ContactTypeMeta = {
  id: AccessContactType;
  label: string;
  description: string;
  icon: typeof Shield;
  permissions: string;
  color: string;
  bg: string;
};

export const PORTFOLIO_ACCESS_CONTACT_TYPES: ContactTypeMeta[] = [
  {
    id: "legacy",
    label: "Legacy Contact",
    description: "Designated contact for inheritance purposes.",
    icon: Shield,
    permissions: "VIEW ONLY",
    color: "text-white",
    bg: "bg-purple-500/40",
  },
  {
    id: "legal",
    label: "Legal Contact",
    description: "Lawyer or legal representative.",
    icon: Scale,
    permissions: "VIEW & EDIT",
    color: "text-white",
    bg: "bg-blue-500/40",
  },
  {
    id: "financial",
    label: "Financial Contact",
    description: "Accountant or financial advisor.",
    icon: CreditCard,
    permissions: "VIEW ONLY",
    color: "text-white",
    bg: "bg-emerald-500/40",
  },
];

type Step = "closed" | "pickType" | "form";

// Mounted globally by AppLayout so the + → Add Portfolio User menu can open the
// drawer in place, without first navigating to /portfolio-access. Listens for:
//   - `open-portfolio-access-add` (no detail) → start at pick-type
//   - `open-portfolio-access-edit` (detail: {type, name, email}) → start at form
export function AddPortfolioAccessDrawer() {
  const [step, setStep] = useState<Step>("closed");
  const [activeType, setActiveType] = useState<AccessContactType | null>(null);
  const [form, setForm] = useState({ name: "", email: "" });
  const [saveError, setSaveError] = useState<string | null>(null);

  // Only fetch contacts while the drawer is open — avoids a network round-trip
  // on every page mount across the app.
  const accessContactsQuery = useAccessContacts({ enabled: step !== "closed" });
  const accessContacts = accessContactsQuery.data ?? [];
  const upsertAccessContact = useUpsertAccessContact();

  const assignedTypes = new Set(accessContacts.map((c) => c.type));
  const availableTypes = PORTFOLIO_ACCESS_CONTACT_TYPES.filter((t) => !assignedTypes.has(t.id));
  const activeMeta = activeType
    ? PORTFOLIO_ACCESS_CONTACT_TYPES.find((t) => t.id === activeType)
    : null;

  const close = () => {
    setStep("closed");
    setActiveType(null);
    setForm({ name: "", email: "" });
    setSaveError(null);
  };

  useEffect(() => {
    const onAdd = () => {
      setSaveError(null);
      setActiveType(null);
      setForm({ name: "", email: "" });
      setStep("pickType");
    };
    const onEdit = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        { type: AccessContactType; name: string; email: string } | undefined;
      if (!detail) return;
      setActiveType(detail.type);
      setForm({ name: detail.name, email: detail.email });
      setSaveError(null);
      setStep("form");
    };
    window.addEventListener("open-portfolio-access-add", onAdd);
    window.addEventListener("open-portfolio-access-edit", onEdit);
    return () => {
      window.removeEventListener("open-portfolio-access-add", onAdd);
      window.removeEventListener("open-portfolio-access-edit", onEdit);
    };
  }, []);

  const pickType = (type: AccessContactType) => {
    setActiveType(type);
    setForm({ name: "", email: "" });
    setSaveError(null);
    setStep("form");
  };

  const save = async () => {
    if (!activeType) return;
    setSaveError(null);
    try {
      await upsertAccessContact.mutateAsync({
        type: activeType,
        name: form.name.trim(),
        email: form.email.trim(),
      });
      close();
    } catch (err) {
      setSaveError(parseApiError(err, "Failed to save contact"));
    }
  };

  return (
    <>
      <ResponsiveDrawer
        open={step === "pickType"}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title="Add Access"
        subtitle="Choose the type of contact you want to grant access to."
      >
        <div className="space-y-3">
          {availableTypes.map((type) => (
            <button
              key={type.id}
              onClick={() => pickType(type.id)}
              className="w-full text-left p-4 rounded-2xl border border-border bg-background hover:border-primary/40 hover:bg-card transition flex items-center gap-3"
            >
              <div
                className={`w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 ${type.bg}`}
              >
                <type.icon size={20} className={type.color} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-bold text-foreground text-[15px] leading-tight">
                  {type.label}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">{type.description}</div>
                <div className="text-[10px] font-bold uppercase text-muted-foreground mt-1.5 tracking-wide">
                  {type.permissions}
                </div>
              </div>
              <ChevronRight size={18} className="text-muted-foreground flex-shrink-0" />
            </button>
          ))}
          {availableTypes.length === 0 && !accessContactsQuery.isLoading && (
            <p className="text-sm text-muted-foreground text-center py-6">
              All contact types are already assigned.
            </p>
          )}
        </div>
      </ResponsiveDrawer>

      <ResponsiveDrawer
        open={step === "form" && !!activeMeta}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={activeMeta ? `Assign ${activeMeta.label}` : "Assign Contact"}
        onBack={() => setStep("pickType")}
        footer={
          <button
            onClick={save}
            disabled={!form.name || !form.email || upsertAccessContact.isPending}
            className="w-full bg-primary text-primary-foreground font-bold py-3.5 rounded-xl shadow-lg shadow-foreground/10 active:scale-[0.98] transition hover:opacity-90 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Check size={20} /> {upsertAccessContact.isPending ? "Saving..." : "Save Contact"}
          </button>
        }
      >
        {activeMeta && (
          <div className="space-y-4">
            <div className="bg-blue-500/10 p-4 rounded-2xl border border-blue-500/20 flex gap-3">
              <Shield className="text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" size={20} />
              <div className="text-sm text-blue-700 dark:text-blue-300 leading-relaxed">
                You are granting <strong>{activeMeta.permissions}</strong> access to your portfolio.
                The contact must already have an Olio account — if they don't, ask them to sign up
                first.
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-muted-foreground uppercase ml-1 tracking-wide">
                Contact Name
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. John Smith"
                className="w-full bg-background border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium text-[15px]"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-muted-foreground uppercase ml-1 tracking-wide">
                Email Address
              </label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="john@example.com"
                className="w-full bg-background border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium text-[15px]"
              />
            </div>
            {saveError && <p className="text-xs text-destructive ml-1">{saveError}</p>}
          </div>
        )}
      </ResponsiveDrawer>
    </>
  );
}
