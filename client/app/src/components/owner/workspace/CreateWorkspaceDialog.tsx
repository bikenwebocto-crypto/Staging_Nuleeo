import { useEffect, useState, type FormEvent } from "react";
import { Check, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@ui/components/ui/dialog";
import { cn } from "@ui/lib/utils";
import { parseApiError } from "@ui/lib/queryClient";
import { useAuth } from "@ui/lib/useAuth";
import { useToast } from "@ui/hooks/use-toast";
import { WORKSPACE_NAME_MAX, type WorkspaceType } from "@shared/firestore-schema";
import {
  WORKSPACE_TYPE_LABEL,
  defaultWorkspaceName,
  type WorkspaceListEntry,
} from "@shared/workspaces";
import { useCreateWorkspace, useWorkspace } from "@/lib/workspaces";
import { WorkspaceGlyph } from "./workspaceDisplay";

const TYPE_HINT: Record<WorkspaceType, string> = {
  real_estate: "Properties, buildings, units and tenants",
  business: "Companies, their accounts, VAT and reports",
};

const TYPES: WorkspaceType[] = ["real_estate", "business"];

// "Add a portfolio or business". Only offers the types the server says the
// caller can still create (one of each per owner).
export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (workspace: WorkspaceListEntry) => void;
}) {
  const { profile } = useAuth();
  const { canCreate, selectWorkspace } = useWorkspace();
  const create = useCreateWorkspace();
  const { toast } = useToast();

  const [type, setType] = useState<WorkspaceType | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset each time the dialog opens; preselect the first creatable type.
  useEffect(() => {
    if (!open) return;
    const first = canCreate[0] ?? null;
    setType(first);
    setName(first ? defaultWorkspaceName(first, profile?.firstName) : "");
    setNameTouched(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on open
  }, [open]);

  const pickType = (t: WorkspaceType) => {
    setType(t);
    // Keep the suggested name in step with the type until the user edits it.
    if (!nameTouched) setName(defaultWorkspaceName(t, profile?.firstName));
  };

  const trimmed = name.trim();
  const nameError =
    trimmed.length === 0
      ? "Give your workspace a name"
      : trimmed.length > WORKSPACE_NAME_MAX
        ? `Use ${WORKSPACE_NAME_MAX} characters or fewer`
        : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setNameTouched(true);
    if (!type || nameError) return;
    setError(null);
    create.mutate(
      { type, name: trimmed },
      {
        onSuccess: (ws) => {
          toast({ title: "Workspace created", description: `${ws.name} is ready.` });
          selectWorkspace(ws);
          onOpenChange(false);
          onCreated?.(ws);
        },
        onError: (err) => setError(parseApiError(err, "Couldn't create the workspace")),
      },
    );
  };

  const nothingToCreate = canCreate.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[480px] rounded-3xl border-0 bg-[#111618] p-7 text-[#F4F4F2]">
        <DialogHeader className="text-left">
          <DialogTitle className="text-xl font-semibold tracking-[-0.02em]">
            Add a portfolio or business
          </DialogTitle>
          <DialogDescription className="text-sm text-[#A3A7AB]">
            Each workspace keeps its own accounts, books and reports, so your property portfolio and
            your companies never mix.
          </DialogDescription>
        </DialogHeader>

        {nothingToCreate ? (
          <p className="rounded-2xl bg-[#1C2325] px-4 py-3 text-sm text-[#A3A7AB]">
            You already have a real estate and a business workspace.
          </p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-xs font-medium text-[#A3A7AB]">Type</legend>
              {TYPES.map((t) => {
                const available = canCreate.includes(t);
                const selected = type === t;
                return (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={!available}
                    onClick={() => pickType(t)}
                    className={cn(
                      "flex items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]",
                      selected ? "bg-[#2A3134]" : "bg-[#1C2325] hover:bg-[#232B2E]",
                      !available && "cursor-not-allowed opacity-50 hover:bg-[#1C2325]",
                    )}
                  >
                    <WorkspaceGlyph type={t} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">{WORKSPACE_TYPE_LABEL[t]}</span>
                      <span className="block text-xs text-[#A3A7AB]">
                        {available ? TYPE_HINT[t] : "You already have one"}
                      </span>
                    </span>
                    {selected && <Check size={16} className="shrink-0" aria-hidden="true" />}
                  </button>
                );
              })}
            </fieldset>

            <div className="flex flex-col gap-2">
              <label htmlFor="workspace-name" className="text-xs font-medium text-[#A3A7AB]">
                Name
              </label>
              <input
                id="workspace-name"
                value={name}
                maxLength={WORKSPACE_NAME_MAX + 10}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
                aria-invalid={nameTouched && !!nameError}
                aria-describedby={nameTouched && nameError ? "workspace-name-error" : undefined}
                className="h-11 rounded-full bg-[#1C2325] px-4 text-sm text-[#F4F4F2] placeholder:text-[#7D8287] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]"
              />
              {nameTouched && nameError && (
                <p id="workspace-name-error" className="text-xs text-[#FF7A7A]">
                  {nameError}
                </p>
              )}
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-2xl bg-[#FF7A7A]/10 px-4 py-3 text-sm text-[#FF7A7A]"
              >
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
                disabled={create.isPending || !type}
                className="flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-white text-sm font-semibold text-[#060A0B] transition hover:brightness-95 disabled:opacity-60"
              >
                {create.isPending && (
                  <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                )}
                Create workspace
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
