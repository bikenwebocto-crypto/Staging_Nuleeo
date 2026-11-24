import { useState } from "react";
import { Plus } from "lucide-react";
import { useCreateEntity, useEntities } from "@/lib/entities";
import { useToast } from "@ui/hooks/use-toast";
import { parseApiError } from "@ui/lib/queryClient";

// Picks one of the owner's COMPANY entities, or creates a new one inline.
// Properties link to companies by entityId only — never a free-text name.
export function CompanyEntityPicker({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (entityId: string) => void;
  error?: string | null;
}) {
  const { data } = useEntities();
  const createEntity = useCreateEntity();
  const { toast } = useToast();
  const [newName, setNewName] = useState<string | null>(null);
  const companies = (data?.entities ?? []).filter(
    (e) => e.entityType === "COMPANY" && !e.archivedAt,
  );

  const create = async () => {
    const name = newName?.trim();
    if (!name) return;
    try {
      const entity = await createEntity.mutateAsync({ entityType: "COMPANY", name });
      onChange(entity.id);
      setNewName(null);
    } catch (err) {
      toast({
        title: "Couldn't create the company",
        description: parseApiError(err, ""),
        variant: "destructive",
      });
    }
  };

  const inputCls =
    "w-full bg-background border-none rounded-xl px-4 py-2.5 text-foreground font-medium placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 transition";

  return (
    <div className="space-y-2">
      <label className="text-xs font-semibold text-muted-foreground ml-1">Company</label>
      <select
        data-testid="select-company-entity"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputCls}
      >
        <option value="">Select a company</option>
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {newName === null ? (
        <button
          type="button"
          onClick={() => setNewName("")}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          <Plus size={14} className="mr-1 inline" aria-hidden="true" /> Create new company
        </button>
      ) : (
        <div className="flex gap-2">
          <input
            data-testid="input-new-company-name"
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Nuleeo Holdings Ltd"
            className={inputCls}
          />
          <button
            type="button"
            disabled={createEntity.isPending || !newName.trim()}
            onClick={() => void create()}
            className="rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {createEntity.isPending ? "Creating…" : "Create"}
          </button>
          <button
            type="button"
            onClick={() => setNewName(null)}
            className="px-2 text-sm text-muted-foreground"
          >
            Cancel
          </button>
        </div>
      )}
      {error ? <p className="text-xs text-destructive ml-1">{error}</p> : null}
    </div>
  );
}
